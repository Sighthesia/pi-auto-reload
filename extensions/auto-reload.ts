/**
 * Auto-Reload Extension
 *
 * Reloads Pi's runtime lazily: a change never triggers a reload by itself. The
 * reload happens right before the next thing that would use the changed
 * resource — the user's next message, including `/skill:…` and prompt-template
 * invocations — and that message is then replayed on the new runtime.
 *
 * Why the `input` hook: `input` fires after extension commands are checked and
 * before skill/prompt-template expansion (`docs/extensions.md` "Input Events"),
 * so intercepting there reloads before a stale skill, template, keybinding or
 * extension can be used, without any timer or race.
 *
 * Flow (agent idle, resources dirty, user types `/`):
 *   1. An autocomplete provider notices the lone `/` at the start of the line and
 *      dispatches the reload. Pi builds the slash menu from a snapshot taken in
 *      `setupAutocompleteProvider()`, so only a reload can make a newly created
 *      skill appear there; `getSuggestions` is the only hook that sees typing.
 *      That request answers empty — the menu opens on the next keystroke against
 *      the reloaded runtime.
 *
 * Flow (agent idle, resources dirty, user sends a message):
 *   1. `input` returns `{ action: "handled" }`, so the agent never starts on the
 *      stale runtime (verified: the prompt response reports `handled`).
 *   2. The message is persisted as a custom session entry (JSON-safe) — reload
 *      replaces the runtime, so in-memory state cannot carry it across.
 *   3. The same `/auto-reload` command, invoked with the internal `apply`
 *      argument, dispatches `ctx.reload()` (commands are the only context
 *      allowed to call it).
 *   4. The new runtime's `session_start` (reason "reload") finds the entry, waits
 *      until the session is idle (a `sendUserMessage` issued while busy is dropped
 *      silently), then re-sends the message — expanded against the reloaded
 *      skills/templates.
 *
 * The agent is never reloaded mid-run: a change that lands while it works only
 * marks resources dirty; interception needs an idle agent by definition, since
 * `input` for a new prompt only arrives when idle (`streamingBehavior` is unset).
 *
 * Watched resources (what `/reload` refreshes):
 *   extensions/   -> "extensions"      skills/  -> "skills"
 *   prompts/      -> "templates"       keybindings.json -> "keybindings"
 * Themes are excluded: Pi hot-reloads the active user theme by itself.
 *
 * Commands:
 *   /auto-reload          toggle on/off (persisted, so a reload keeps it)
 *   /auto-reload apply    internal: run the reload the toggle command exists for
 *
 * There is no footer status line: the extension is silent until it reloads, and
 * a reload is announced only when it actually happens.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

const TOGGLE_COMMAND = "auto-reload";
/** Argument that turns the toggle command into the reload dispatcher. */
const APPLY_ARG = "apply";
/** Custom session entry carrying the intercepted message across the reload. */
const PENDING_ENTRY = "pi.auto-reload-pending";
/** Written once a pending entry is either replayed or handed back, so it never repeats. */
const CONSUMED_ENTRY = "pi.auto-reload-consumed";
/** A replay right after a reload must wait for the old run to settle; poll at this step. */
const REPLAY_POLL_MS = 100;
/** Give up waiting for the session to go idle after this long. */
const REPLAY_WAIT_MS = 10_000;
/** How long a dispatched replay gets to actually start a run. */
const REPLAY_CONFIRM_MS = 2_000;
/** Attempts before the text goes back to the editor. */
const REPLAY_ATTEMPTS = 3;
/** Delay before re-creating watchers whose root was replaced. */
const REARM_DELAY_MS = 1000;

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");

type ResourceKind = "extensions" | "skills" | "templates" | "keybindings";

/**
 * Always watched, whether or not Pi reports anything from them: these are the
 * default discovery locations, and a *new* file appearing there has no command
 * yet to reveal it.
 */
const DEFAULT_DIRS: { dir: string; kind: ResourceKind }[] = [
	{ dir: path.join(AGENT_DIR, "extensions"), kind: "extensions" },
	{ dir: path.join(AGENT_DIR, "skills"), kind: "skills" },
	{ dir: path.join(AGENT_DIR, "prompts"), kind: "templates" },
];

const WATCHED_FILES: { file: string; kind: ResourceKind }[] = [
	// User-level keybindings live at `<agent-dir>/keybindings.json`; the project-level
	// file is under the config directory name Pi was built with, not a hardcoded `.pi`.
	{ file: path.join(AGENT_DIR, "keybindings.json"), kind: "keybindings" },
	{ file: path.join(process.cwd(), CONFIG_DIR_NAME, "keybindings.json"), kind: "keybindings" },
];

const IGNORED_EXT = /\.(log|tmp|swp|swx|swo|bak|old|orig|rej|~)$/i;

/** A directory to watch and the resource kind a change there implies. */
type WatchTarget = { dir: string; kind: ResourceKind };

function expandHome(entry: string): string {
	if (entry === "~") return os.homedir();
	if (entry.startsWith("~/")) return path.join(os.homedir(), entry.slice(2));
	return entry;
}

/**
 * Resolve one `settings.json` resource entry to a directory.
 *
 * Entries may be globs (`prompts/*.md`), may carry `+`/`-`/`!` inclusion markers,
 * and may be files. Anything that cannot be pinned to a directory returns
 * undefined rather than guessing.
 */
function resolveResourceDir(entry: string): string | undefined {
	const trimmed = entry.trim();
	// `-x` disables a resource and `!x` excludes a glob match; neither is a root.
	if (!trimmed || trimmed.startsWith("-") || trimmed.startsWith("!")) return undefined;
	const withoutMarker = trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
	if (/^(builtin|npm|git|https?):/.test(withoutMarker)) return undefined;
	// Cut at the first glob metacharacter, then treat the remainder as the root.
	const globIndex = withoutMarker.search(/[*?[{]/);
	const literal = globIndex === -1 ? withoutMarker : withoutMarker.slice(0, globIndex);
	if (!literal) return undefined;
	const absolute = path.isAbsolute(literal) ? literal : path.resolve(AGENT_DIR, expandHome(literal));
	const trimmedSlash = absolute.replace(/[/\\]+$/, "") || absolute;
	try {
		if (fs.statSync(trimmedSlash).isDirectory()) return trimmedSlash;
	} catch {
		// Missing path: still watch it if it names a directory, so creating it later counts.
		return globIndex !== -1 ? trimmedSlash : undefined;
	}
	// It exists and is a file (for example `skills/foo/SKILL.md`).
	return path.dirname(trimmedSlash);
}

/**
 * Work out what to watch from what Pi actually loaded.
 *
 * Hard-coded `<agent-dir>/{extensions,skills,prompts}` is not enough: resources
 * also come from `settings.json` arrays (`skills`, `prompts`, `extensions`),
 * from packages, and from project-local directories. All of those end up in
 * `pi.getCommands()`, whose `sourceInfo.path` is the on-disk file — so the
 * loaded set is the authoritative answer, and the settings arrays add the roots
 * that contain files Pi has not reported yet (a brand-new skill has no command).
 */
function deriveWatchTargets(pi: ExtensionAPI): WatchTarget[] {
	const targets: WatchTarget[] = DEFAULT_DIRS.map((entry) => ({ ...entry }));

	// Roots declared in settings, so a newly created resource under them counts even
	// before Pi has ever loaded it.
	try {
		const settings = pi.getSettings() as Record<string, unknown>;
		const kinds: [ResourceKind, unknown][] = [
			["skills", settings.skills],
			["templates", settings.prompts],
			["extensions", settings.extensions],
		];
		for (const [kind, value] of kinds) {
			if (!Array.isArray(value)) continue;
			for (const entry of value) {
				if (typeof entry !== "string") continue;
				const dir = resolveResourceDir(entry);
				if (dir) targets.push({ dir, kind });
			}
		}
	} catch {
		// Settings are best effort; the defaults and the loaded set still apply.
	}

	// Every loaded resource's own directory: covers packages, project-local files and
	// anything else Pi found, without this extension having to model package layout.
	try {
		for (const command of pi.getCommands?.() ?? []) {
			const file = command.sourceInfo?.path;
			if (!file || !path.isAbsolute(file)) continue;
			const kind: ResourceKind | undefined =
				command.source === "skill" ? "skills" : command.source === "prompt" ? "templates" : command.source === "extension" ? "extensions" : undefined;
			if (kind) targets.push({ dir: path.dirname(file), kind });
		}
	} catch {
		// Same: the defaults remain.
	}

	return targets;
}

/**
 * Drop targets that are already covered by a parent target, so one edit does not
 * mark the same resource twice, and so a nested watch cannot outlive its parent.
 */
function pruneNested(targets: WatchTarget[]): WatchTarget[] {
	const unique = new Map<string, WatchTarget>();
	for (const target of targets) {
		const key = path.resolve(target.dir);
		if (!unique.has(key)) unique.set(key, { ...target, dir: key });
	}
	const sorted = [...unique.values()].sort((a, b) => a.dir.length - b.dir.length);
	const kept: WatchTarget[] = [];
	for (const target of sorted) {
		// Never watch the filesystem root or the home directory wholesale.
		if (target.dir === "/" || target.dir === os.homedir()) continue;
		if (kept.some((parent) => target.dir.startsWith(`${parent.dir}${path.sep}`))) continue;
		kept.push(target);
	}
	return kept;
}

/**
 * Optional config file: `<agent-dir>/auto-reload.json`.
 *
 * Every key is optional and a malformed file falls back to the defaults with a
 * warning rather than breaking the session. Read once per session start, so
 * editing it takes effect on the next reload.
 */
type Config = {
	/** Extra directories to watch, absolute or relative to the agent dir. */
	watch?: string[];
	/** Resource kinds to ignore, e.g. ["keybindings"]. */
	ignore?: ResourceKind[];
	/** Skip the confirmation notice on every reload. */
	quiet?: boolean;
};

const CONFIG_FILE = path.join(AGENT_DIR, "auto-reload.json");
const RESOURCE_KINDS: ResourceKind[] = ["extensions", "skills", "templates", "keybindings"];

/**
 * Toggle state, kept apart from `auto-reload.json` so the extension never
 * rewrites a file the user authored. A reload re-evaluates this module, so the
 * state has to live outside memory to survive one.
 */
const STATE_FILE = path.join(AGENT_DIR, "auto-reload.state.json");

function loadEnabled(): boolean {
	try {
		if (!fs.existsSync(STATE_FILE)) return true;
		const raw: unknown = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
		if (raw && typeof raw === "object" && typeof (raw as { enabled?: unknown }).enabled === "boolean") {
			return (raw as { enabled: boolean }).enabled;
		}
	} catch {
		// An unreadable state file must not silently disable the extension.
	}
	return true;
}

function saveEnabled(value: boolean): void {
	try {
		fs.mkdirSync(AGENT_DIR, { recursive: true });
		fs.writeFileSync(STATE_FILE, `${JSON.stringify({ enabled: value }, null, 2)}\n`);
	} catch {
		// Best effort: the toggle still holds for the current runtime.
	}
}

function loadConfig(warn: (message: string) => void): Config {
	try {
		if (!fs.existsSync(CONFIG_FILE)) return {};
		const raw: unknown = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			warn(`${CONFIG_FILE} must contain a JSON object — using defaults`);
			return {};
		}
		const source = raw as Record<string, unknown>;
		const config: Config = {};
		if (Array.isArray(source.watch)) {
			config.watch = source.watch.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
		}
		if (Array.isArray(source.ignore)) {
			config.ignore = source.ignore.filter(
				(entry): entry is ResourceKind => typeof entry === "string" && RESOURCE_KINDS.includes(entry as ResourceKind),
			);
		}
		if (typeof source.quiet === "boolean") config.quiet = source.quiet;
		return config;
	} catch (error) {
		warn(`${CONFIG_FILE} could not be read (${(error as Error).message}) — using defaults`);
		return {};
	}
}

function ignored(relative: string): boolean {
	if (!relative) return false;
	const segments = relative.split("/").filter(Boolean);
	const base = segments[segments.length - 1] ?? "";
	// Only the last segment decides dot-ness and extension: a dot-prefixed resource
	// root is supported by Pi (packages.md), so `skills/.shared/x.md` must count.
	if (IGNORED_EXT.test(base)) return true;
	if (base.startsWith(".")) return true;
	// Dependency/build churn only, and never a user resource named `dist`/`build`.
	return segments.some((segment) => segment === "node_modules" || segment === "__pycache__");
}

type StashedInput = {
	/** Stable id referenced by the matching consumed entry. */
	id: string;
	text: string;
	images?: { type: "image"; data: string; mimeType: string }[];
	kinds: string[];
	at: number;
};

export default function (pi: ExtensionAPI) {
	let enabled = loadEnabled();
	let ctx: ExtensionContext | undefined;
	let watchers: fs.FSWatcher[] = [];
	let config: Config = {};

	/** Resource kinds changed since the last reload. */
	const dirty = new Set<ResourceKind>();
	/** Changes seen while disabled; they must not be lost by re-enabling. */
	const missed = new Set<ResourceKind>();
	/** A reload was dispatched and has not replaced this runtime yet. */
	let reloading = false;
	/** Bumped on every session start and shutdown; invalidates in-flight replay pollers. */
	let generation = 0;

	function stopWatchers(): void {
		for (const watcher of watchers) {
			try {
				watcher.close();
			} catch {
				// Already closed.
			}
		}
		watchers = [];
	}

	function startWatchers(): void {
		stopWatchers();
		const skip = new Set(config.ignore ?? []);
		const watchedDirs = deriveWatchTargets(pi).filter((entry) => !skip.has(entry.kind));
		// Extra roots from config: watched as `extensions`, the broadest kind, so a
		// change there still forces a reload.
		for (const entry of config.watch ?? []) {
			const dir = path.isAbsolute(entry) ? entry : path.join(AGENT_DIR, entry);
			watchedDirs.push({ dir, kind: "extensions" });
		}
		const watchedFiles = WATCHED_FILES.filter((entry) => !skip.has(entry.kind));
		for (const { dir, kind } of pruneNested(watchedDirs)) {
			if (!fs.existsSync(dir)) continue;
			try {
				// Recursive inotify works on Linux (Node >= 20), macOS and Windows.
				const watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
					if (ignored(filename ? String(filename) : "")) return;
					markDirty(kind);
				});
				watcher.on("error", () => {
					// A recursive inotify watch dies when its root is replaced. Re-arm instead
					// of going permanently blind while the footer still looks healthy.
					ctx?.ui.notify?.(`auto-reload: re-arming watcher for ${dir}`, "warning");
					try {
						watcher.close();
					} catch {
						// Already closed.
					}
					const timer = setTimeout(() => startWatchers(), REARM_DELAY_MS);
					timer.unref?.();
				});
				watchers.push(watcher);
			} catch {
				ctx?.ui.notify?.(`auto-reload: cannot watch ${dir}`, "warning");
			}
		}
		for (const { file, kind } of watchedFiles) {
			// Watch the parent so the watch survives atomic replaces and works
			// before the file exists.
			const dir = path.dirname(file);
			if (!fs.existsSync(dir)) continue;
			try {
				const watcher = fs.watch(dir, (_event, filename) => {
					if (filename && path.basename(file) === String(filename)) markDirty(kind);
				});
				watcher.on("error", () => undefined);
				watchers.push(watcher);
			} catch {
				// Keybindings are optional; skip silently.
			}
		}
	}

	/** Records the change only. A reload needs an idle agent and a reason to use it. */
	function markDirty(kind: ResourceKind): void {
		if (!enabled) {
			// Remembered, not dropped: turning the extension back on must still
			// reload the resources that changed while it was off.
			missed.add(kind);
			return;
		}
		dirty.add(kind);
	}

	/**
	 * Find the message stashed before the reload, if it is still owed.
	 *
	 * Why not "the newest entry": other extensions append their own custom entries
	 * from their `session_start` handlers (pi-subagents wakes, todo state). Those
	 * run in the same emit as ours, so whether the pending entry is still last is a
	 * race — an earlier version keyed on that and silently dropped the user's
	 * message whenever another extension wrote first. Instead, walk back to the
	 * newest pending entry and consider it owed unless a consumed entry for its id
	 * exists anywhere in the session.
	 */
	function readPending(sessionCtx: ExtensionContext): StashedInput | undefined {
		try {
			const entries = sessionCtx.sessionManager.getEntries();
			const consumed = new Set<string>();
			for (const entry of entries) {
				if (entry.type !== "custom" || entry.customType !== CONSUMED_ENTRY) continue;
				const id = (entry.data as { id?: unknown } | undefined)?.id;
				if (typeof id === "string") consumed.add(id);
			}
			for (let index = entries.length - 1; index >= 0; index -= 1) {
				const entry = entries[index];
				if (!entry || entry.type !== "custom" || entry.customType !== PENDING_ENTRY) continue;
				const data = entry.data as StashedInput | undefined;
				if (!data || typeof data.text !== "string") continue;
				if (typeof data.id === "string" && consumed.has(data.id)) return undefined;
				return data;
			}
			return undefined;
		} catch {
			return undefined;
		}
	}

	function replay(pending: StashedInput): void {
		// One message: text (slash command included) plus any images.
		const content = [
			...(pending.text.trim() ? [{ type: "text" as const, text: pending.text }] : []),
			...(pending.images ?? []),
		];
		if (content.length === 0) return;
		// Expansion now runs against the reloaded skills and templates.
		pi.sendUserMessage(content.length === 1 && content[0].type === "text" ? pending.text : content, {
			expandPromptTemplates: true,
		});
	}

	/**
	 * Replay after a reload, confirming the message actually started.
	 *
	 * Two separate hazards, both silent:
	 *
	 * 1. Right after a reload the runtime may still be busy, and `sendUserMessage`
	 *    issued while busy is dropped without an error (`prompt` throws, but the
	 *    extension API does not return that promise, so it surfaces as a swallowed
	 *    rejection). So wait for `isIdle()` first.
	 * 2. `isIdle()` can flip between the check and the send, and a send can be
	 *    dropped for other reasons. A fire-and-forget send therefore cannot be
	 *    trusted: after sending, confirm the run actually started, retry a bounded
	 *    number of times, and only then declare failure.
	 *
	 * The consumed entry is written only once the message is confirmed, so a send
	 * that never landed leaves the stash replayable instead of being lost.
	 *
	 * The generation guard is what makes this safe: a reload can be followed by
	 * `/new`, `/resume` or `/quit` inside the wait window, and touching the captured
	 * `pi` or `sessionCtx` then throws (a replaced runtime's session-bound objects
	 * are stale). `session_shutdown` bumps the generation.
	 */
	function replayWhenIdle(sessionCtx: ExtensionContext, pending: StashedInput): void {
		const myGeneration = generation;
		let waited = 0;
		let attempts = 0;
		let sentAt: number | undefined;

		const alive = () => myGeneration === generation && sessionCtx.hasUI;

		const handBack = (reason: string) => {
			try {
				pi.appendEntry(CONSUMED_ENTRY, { id: pending.id, at: Date.now(), kinds: pending.kinds });
				sessionCtx.ui.notify?.(`auto-reload: ${reason} — your message was not sent: ${pending.text.slice(0, 60)}`, "warning");
				// Put it where the user can resend it instead of pretending it went out.
				sessionCtx.ui.setEditorText?.(pending.text);
			} catch {
				// Runtime went away; nothing to recover into.
			}
		};

		const done = () => {
			try {
				pi.appendEntry(CONSUMED_ENTRY, { id: pending.id, at: Date.now(), kinds: pending.kinds });
			} catch {
				// Runtime went away after a successful send; the entry is not replayable
				// anyway because the reload chain ended.
			}
		};

		const tick = () => {
			if (!alive()) return;

			// Confirming a send: a started run takes the session out of idle.
			if (sentAt !== undefined) {
				if (!sessionCtx.isIdle()) {
					done();
					return;
				}
				if (Date.now() - sentAt < REPLAY_CONFIRM_MS) {
					schedule(REPLAY_POLL_MS);
					return;
				}
				// The send did not take. Retry while we still have budget.
				sentAt = undefined;
				if (attempts >= REPLAY_ATTEMPTS || waited >= REPLAY_WAIT_MS) {
					handBack("could not restart the agent");
					return;
				}
			}

			if (!sessionCtx.isIdle()) {
				if (waited >= REPLAY_WAIT_MS) {
					handBack("runtime stayed busy");
					return;
				}
				waited += REPLAY_POLL_MS;
				schedule(REPLAY_POLL_MS);
				return;
			}

			try {
				attempts += 1;
				sentAt = Date.now();
				replay(pending);
			} catch {
				sentAt = undefined;
				handBack("replay failed");
				return;
			}
			schedule(REPLAY_POLL_MS);
		};

		const schedule = (delay: number) => {
			const timer = setTimeout(tick, delay);
			timer.unref?.();
		};

		// The reload's own settle handlers run after this one, so start on the next tick.
		schedule(REPLAY_POLL_MS);
	}

	pi.on("session_start", async (event, sessionCtx) => {
		ctx = sessionCtx;
		generation += 1;
		reloading = false;
		if (!sessionCtx.hasUI) {
			// Print/JSON modes are one-shot: nothing to rewire, and no UI to reload into.
			stopWatchers();
			return;
		}
		config = loadConfig((message) => sessionCtx.ui.notify?.(`auto-reload: ${message}`, "warning"));
		startWatchers();
		installSlashTrigger(sessionCtx);

		if (event.reason !== "reload") {
			// A pending entry outside the reload path means the last replay never
			// happened (stale runtime, aborted turn). Say so rather than dropping it.
			const stale = readPending(sessionCtx);
			if (stale) {
				sessionCtx.ui.notify?.(
					`auto-reload: an earlier message was never sent: ${stale.text.slice(0, 60)}`,
					"warning",
				);
				sessionCtx.ui.setEditorText?.(stale.text);
			}
			return;
		}
		// A reload replaced the runtime: this extension's `dirty` set is gone with
		// it, and the intercepted message (if any) is waiting in the session.
		const pending = readPending(sessionCtx);
		if (!pending) return;
		ctx.ui.notify?.(`auto-reload: reloaded (${pending.kinds.join(", ")}) — resending your message`, "info");
		replayWhenIdle(sessionCtx, pending);
	});

	/**
	 * Makes typing `/` reload the runtime, so the slash menu that opens on the
	 * next keystroke already lists newly created skills, templates and commands.
	 *
	 * Why this is an autocomplete provider and not something cleaner: Pi builds the
	 * slash menu from a snapshot taken in `setupAutocompleteProvider()`, and only
	 * `/reload` rebuilds it (see `handleReloadCommand`). `getSuggestions` is the
	 * one hook that observes typing, and it cannot rewrite that snapshot — it can
	 * only return items. So the reload is dispatched from here and *this* request
	 * answers empty; the provider installed by the reloaded runtime serves the
	 * second keystroke with fresh resources.
	 *
	 * Guards, because a reload discards session state: the user must actually have
	 * just typed `/` at the start of the line, resources must be dirty, the agent
	 * must be idle, and nothing may already be in flight.
	 */
	function installSlashTrigger(sessionCtx: ExtensionContext): void {
		sessionCtx.ui.addAutocompleteProvider?.((current) => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const line = lines[cursorLine] ?? "";
				const beforeCursor = line.slice(0, cursorCol);
				const atSlash = cursorLine === 0 && beforeCursor === "/";
				if (atSlash && enabled && dirty.size > 0 && !reloading && sessionCtx.isIdle()) {
					dispatchReload();
					return { prefix: "/", items: [] };
				}
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		}));
	}

	/**
	 * Dispatch the internal reload command. No message is stashed: the slash menu
	 * is not a prompt, and Pi restores the editor text across a reload.
	 */
	function dispatchReload(): void {
		if (!pi.getCommands?.().some((command) => command.name === TOGGLE_COMMAND)) return;
		reloading = true;
		try {
			pi.sendUserMessage(`/${TOGGLE_COMMAND} ${APPLY_ARG}`, { expandPromptTemplates: true });
		} catch {
			reloading = false;
		}
	}

	pi.on("session_shutdown", async () => {
		// Invalidate any in-flight replay poller before the runtime goes away.
		generation += 1;
		stopWatchers();
	});

	/**
	 * The hook: runs on the next message, after extension commands are checked and
	 * before `/skill:…` and `/template` expansion.
	 */
	pi.on("input", async (event, inputCtx) => {
		ctx = inputCtx;
		if (!enabled || dirty.size === 0) return { action: "continue" as const };
		if (!inputCtx.hasUI || !inputCtx.isIdle()) return { action: "continue" as const };
		// Queued/steering text belongs to a run in flight; the agent must not be
		// reloaded under it. It is re-queued untouched.
		if (event.streamingBehavior) return { action: "continue" as const };
		// We are still in the runtime that asked for a reload: the dispatch did not
		// land (dropped message, collapsed turn). Recover the stashed text instead of
		// silently overwriting it with this one.
		if (reloading) {
			reloading = false;
			const orphan = readPending(inputCtx);
			if (orphan) {
				inputCtx.ui.notify?.(
					`auto-reload: the previous message was never sent: ${orphan.text.slice(0, 60)}`,
					"warning",
				);
				inputCtx.ui.setEditorText?.(orphan.text);
			}
		}
		if (!pi.getCommands?.().some((command) => command.name === TOGGLE_COMMAND)) {
			return { action: "continue" as const };
		}

		const pending: StashedInput = {
			id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
			text: event.text,
			...(event.images?.length ? { images: event.images } : {}),
			kinds: [...dirty],
			at: Date.now(),
		};
		if (!config.quiet) {
			ctx.ui.notify?.(`auto-reload: reloading (${pending.kinds.join(", ")}) before sending`, "info");
		}
		// Reload replaces this runtime, so the message must survive outside memory.
		pi.appendEntry(PENDING_ENTRY, pending);
		reloading = true;
		try {
			pi.sendUserMessage(`/${TOGGLE_COMMAND} ${APPLY_ARG}`, { expandPromptTemplates: true });
		} catch {
			reloading = false;
			return { action: "continue" as const };
		}
		// Handled: the agent must not start on the stale runtime. The replay in
		// `session_start` delivers the same input to the reloaded one.
		return { action: "handled" as const };
	});

	pi.registerCommand(TOGGLE_COMMAND, {
		description: "Toggle auto-reload on or off",
		handler: async (args, commandCtx) => {
			ctx = commandCtx;
			if (args.trim().toLowerCase() !== APPLY_ARG) {
				enabled = !enabled;
				saveEnabled(enabled);
				if (enabled) {
					// Changes from the disabled period are still applicable; make them
					// pending so the toggle does not silently swallow them.
					for (const kind of missed) dirty.add(kind);
				}
				missed.clear();
				if (!enabled) {
					// Not yet applied: carry the pending kinds over so re-enabling does not
					// lose a change that was never reloaded.
					for (const kind of dirty) missed.add(kind);
					dirty.clear();
				}
				const next = enabled
					? dirty.size > 0
						? `on — reload pending (${[...dirty].join(", ")})`
						: "on"
					: "off";
				commandCtx.ui.notify(`auto-reload ${next}`, "info");
				return;
			}
			// Reload under a running agent is unsupported and would leave `reloading`
			// stuck, so the internal dispatch re-checks idleness.
			if (!commandCtx.isIdle()) {
				commandCtx.ui.notify?.("auto-reload: agent is running — reload skipped", "warning");
				return;
			}
			reloading = true;
			// Terminal for this handler: the runtime is replaced underneath it.
			await commandCtx.reload();
			return;
		},
	});
}
