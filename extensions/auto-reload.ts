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
/** Written right after a replay so a stale pending entry is never replayed twice. */
const CONSUMED_ENTRY = "pi.auto-reload-consumed";
/** A replay right after a reload must wait for the old run to settle; poll at this step. */
const REPLAY_POLL_MS = 100;
/** Give up waiting after this long and hand the text back to the editor. */
const REPLAY_WAIT_MS = 10_000;
/** Delay before re-creating watchers whose root was replaced. */
const REARM_DELAY_MS = 1000;

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");

type ResourceKind = "extensions" | "skills" | "templates" | "keybindings";

const WATCHED_DIRS: { dir: string; kind: ResourceKind }[] = [
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
		const watchedDirs = WATCHED_DIRS.filter((entry) => !skip.has(entry.kind));
		const watchedFiles = WATCHED_FILES.filter((entry) => !skip.has(entry.kind));
		// Extra roots from config: watched as `extensions`, the broadest kind, so a
		// change there still forces a reload.
		for (const entry of config.watch ?? []) {
			const dir = path.isAbsolute(entry) ? entry : path.join(AGENT_DIR, entry);
			if (!watchedDirs.some((existing) => existing.dir === dir)) {
				watchedDirs.push({ dir, kind: "extensions" });
			}
		}
		for (const { dir, kind } of watchedDirs) {
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

	function readPending(sessionCtx: ExtensionContext): StashedInput | undefined {
		try {
			const entries = sessionCtx.sessionManager.getEntries();
			const last = entries[entries.length - 1];
			// Only the newest entry counts: anything appended after it means this
			// entry was already consumed, or a later action supersedes it.
			if (!last || last.type !== "custom" || last.customType !== PENDING_ENTRY) return undefined;
			const data = last.data as StashedInput | undefined;
			if (!data || typeof data.text !== "string") return undefined;
			return data;
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
	 * Replay after a reload.
	 *
	 * `sendUserMessage` is dropped when the session is busy. Right after a reload
	 * the old run may still be settling, so wait for `isIdle()` — bounded, because a
	 * stuck run must not swallow the message forever.
	 *
	 * The generation guard is what makes this safe: a reload can be followed by
	 * `/new`, `/resume` or `/quit` inside the wait window, and touching the captured
	 * `pi` or `sessionCtx` then throws (a replaced runtime's session-bound objects
	 * are stale). `session_shutdown` bumps the generation, so the poller stops
	 * before it can write into the next session.
	 */
	function replayWhenIdle(sessionCtx: ExtensionContext, pending: StashedInput): void {
		const myGeneration = generation;
		let waited = 0;
		const tick = () => {
			if (myGeneration !== generation) return;
			if (!sessionCtx.hasUI) return;
			const timedOut = waited >= REPLAY_WAIT_MS;
			if (!sessionCtx.isIdle() && !timedOut) {
				waited += REPLAY_POLL_MS;
				const timer = setTimeout(tick, REPLAY_POLL_MS);
				timer.unref?.();
				return;
			}
			try {
				pi.appendEntry(CONSUMED_ENTRY, { at: Date.now(), kinds: pending.kinds });
				if (timedOut) {
					// Still busy: sending now would be dropped silently. Keep the text where
					// the user can reach it instead of pretending it went out.
					sessionCtx.ui.notify?.(
						`auto-reload: runtime stayed busy — your message was not sent: ${pending.text.slice(0, 60)}`,
						"warning",
					);
					sessionCtx.ui.setEditorText?.(pending.text);
					return;
				}
				replay(pending);
			} catch {
				// The runtime was replaced mid-tick; nothing left to do.
			}
		};
		// The reload's own settle handler runs after this one, so start on the next tick.
		const timer = setTimeout(tick, REPLAY_POLL_MS);
		timer.unref?.();
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
