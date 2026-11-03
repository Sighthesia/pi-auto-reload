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
 *   3. `/auto-reload-apply` dispatches `ctx.reload()` (commands are the only
 *      context allowed to call it).
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
 *   /auto-reload          status + on/off toggle
 *   /auto-reload on|off   explicit
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "auto-reload";
const RELOAD_COMMAND = "auto-reload-apply";
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
	let enabled = true;
	let ctx: ExtensionContext | undefined;
	let watchers: fs.FSWatcher[] = [];

	/** Resource kinds changed since the last reload. */
	const dirty = new Set<ResourceKind>();
	/** A reload was dispatched and has not replaced this runtime yet. */
	let reloading = false;
	/** Bumped on every session start and shutdown; invalidates in-flight replay pollers. */
	let generation = 0;

	function paint(): void {
		if (!ctx?.hasUI) return;
		if (!enabled) {
			ctx.ui.setStatus(STATUS_KEY, "auto-reload off");
			return;
		}
		if (reloading) {
			ctx.ui.setStatus(STATUS_KEY, "reloading…");
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, dirty.size > 0 ? `reload pending · ${[...dirty].join(",")}` : undefined);
	}

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
		for (const { dir, kind } of WATCHED_DIRS) {
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
		for (const { file, kind } of WATCHED_FILES) {
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
		if (!enabled) return;
		if (dirty.has(kind)) return;
		dirty.add(kind);
		paint();
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
		startWatchers();
		paint();

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
			paint();
		}
		if (!pi.getCommands?.().some((command) => command.name === RELOAD_COMMAND)) {
			return { action: "continue" as const };
		}

		const pending: StashedInput = {
			text: event.text,
			...(event.images?.length ? { images: event.images } : {}),
			kinds: [...dirty],
			at: Date.now(),
		};
		ctx.ui.notify?.(`auto-reload: reloading (${pending.kinds.join(", ")}) before sending`, "info");
		// Reload replaces this runtime, so the message must survive outside memory.
		pi.appendEntry(PENDING_ENTRY, pending);
		reloading = true;
		paint();
		try {
			pi.sendUserMessage(`/${RELOAD_COMMAND}`, { expandPromptTemplates: true });
		} catch {
			reloading = false;
			paint();
			return { action: "continue" as const };
		}
		// Handled: the agent must not start on the stale runtime. The replay in
		// `session_start` delivers the same input to the reloaded one.
		return { action: "handled" as const };
	});

	pi.registerCommand(RELOAD_COMMAND, {
		description: "Apply a pending auto-reload (internal)",
		handler: async (_args, commandCtx) => {
			ctx = commandCtx;
			// The command is public, so guard it: reloading under a running agent is
			// unsupported and would leave `reloading` stuck.
			if (!commandCtx.isIdle()) {
				commandCtx.ui.notify?.("auto-reload: agent is running — reload skipped", "warning");
				return;
			}
			reloading = true;
			paint();
			// Terminal for this handler: the runtime is replaced underneath it.
			await commandCtx.reload();
			return;
		},
	});

	pi.registerCommand("auto-reload", {
		description: "Auto-reload status, or /auto-reload on|off",
		handler: async (args, commandCtx) => {
			ctx = commandCtx;
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				enabled = arg === "on";
				if (!enabled) {
					dirty.clear();
					reloading = false;
				}
				paint();
				commandCtx.ui.notify(`auto-reload ${enabled ? "enabled" : "disabled"}`, "info");
				return;
			}
			const watched = [
				...WATCHED_DIRS.map((entry) => `${entry.dir}${fs.existsSync(entry.dir) ? "" : " (missing)"}`),
				...WATCHED_FILES.filter((entry) => fs.existsSync(entry.file)).map((entry) => entry.file),
			];
			commandCtx.ui.notify(
				[
					`auto-reload: ${enabled ? "enabled" : "disabled"}`,
					`idle now: ${commandCtx.isIdle() ? "yes" : "no"}`,
					`pending: ${dirty.size > 0 ? [...dirty].join(", ") : "none"}`,
					"reloads on your next message (before skill/template expansion)",
					...watched.map((line) => `  ${line}`),
				].join("\n"),
				"info",
			);
		},
	});
}
