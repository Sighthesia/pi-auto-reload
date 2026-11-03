/**
 * Ask-User Notify Extension
 *
 * Notifies the user the moment `ask_user_question` (package
 * `@juicesharp/rpiv-ask-user-question`) blocks on a human answer — the gap the
 * upstream package leaves: it only writes one terminal BEL.
 *
 * Routing:
 *   1. Inside Herdr — emit `herdr:blocked`, the event Herdr's own Pi integration
 *      (`~/.pi/agent/extensions/herdr-agent-state.ts`) listens on. Herdr then
 *      raises its toast (system delivery), sound and pane/agent badge. This is
 *      the bridge requested in juicesharp/rpiv-mono#165.
 *   2. Otherwise — a freedesktop notification via `notify-send` (Linux desktops
 *      with a notification daemon), plus an OSC notification to the terminal for
 *      emulators that draw their own (Warp/Ghostty/WezTerm OSC 777, kitty OSC 99).
 *
 * Event contract source (rpiv-mono, package rpiv-ask-user-question):
 * https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-ask-user-question/events.ts
 *
 * Debug: `/notify-test` fires a sample notification through the active route.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROMPT_EVENT = "rpiv:ask-user:prompt";
const BLOCKED_EVENT = "rpiv:ask-user:blocked";
const HERDR_EVENT = "herdr:blocked";

/** How long a `/notify-test` Herdr badge stays raised before it is cleared. */
const PREVIEW_RELEASE_MS = 1500;

const APP_NAME = "Pi";
const TITLE = "Pi 需要你的确认";
const MAX_BODY = 120;
/** How long a questionnaire may wait for its prompt payload before falling back to a generic toast. */
const PAYLOAD_GRACE_MS = 300;

type AskUserOption = { label?: string; description?: string; hasPreview?: boolean };
type AskUserQuestion = { question?: string; header?: string; multiSelect?: boolean; options?: AskUserOption[] };
type PromptPayload = { toolCallId?: string; questions?: AskUserQuestion[] };
type BlockedPayload = { active?: boolean; toolCallId?: string };

type Rendered = { title: string; body: string };

const GENERIC: Rendered = { title: TITLE, body: "问卷需要你的回答" };

function clamp(text: string, max = MAX_BODY): string {
	// Strip control characters first: question text is model-authored, and a raw
	// BEL or ESC would truncate or hijack the OSC sequence written to the terminal.
	const flat = text
		// eslint-disable-next-line no-control-regex
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One toast per questionnaire: the first question's header, then its text and the question count. */
function render(payload: PromptPayload | undefined): Rendered | undefined {
	const questions = payload?.questions ?? [];
	const first = questions[0];
	if (!first) return undefined;

	const header = first.header?.trim();
	const question = first.question?.trim();
	const parts = [header && question && header !== question ? clamp(question, 80) : ""];
	if (questions.length > 1) parts.push(`共 ${questions.length} 问`);
	else if (first.options?.length) parts.push(`${first.options.length} 个选项`);

	return { title: TITLE, body: clamp(parts.filter(Boolean).join(" · ")) || header || question || GENERIC.body };
}

/** OSC 777 — Warp, Ghostty, WezTerm, rxvt-unicode; OSC 99 — kitty. */
function writeOsc(target: Rendered): void {
	try {
		if (!process.stdout.isTTY) return;
		if (process.env.KITTY_WINDOW_ID) {
			process.stdout.write(`\x1b]99;i=ask-user:d=0;${target.title}\x1b\\`);
			process.stdout.write(`\x1b]99;i=ask-user:p=body;${target.body}\x1b\\`);
		} else {
			process.stdout.write(`\x1b]777;notify;${target.title};${target.body}\x07`);
		}
	} catch {
		// Terminal attention is best effort.
	}
}

/**
 * Herdr's own Pi integration requires `HERDR_PANE_ID` on top of these two
 * (`herdr-agent-state.ts` `enabled()`). Checking the same triple matters: if we
 * claim Herdr handles the notification while it is inert, nothing is shown at all.
 */
function herdrEnabled(): boolean {
	return (
		process.env.HERDR_ENV === "1" &&
		!!process.env.HERDR_SOCKET_PATH &&
		!!process.env.HERDR_PANE_ID
	);
}

export default function (pi: ExtensionAPI) {
	/** toolCallId -> rendered toast; a prompt can land before or after its blocked event. */
	const pending = new Map<string, Rendered | undefined>();
	/** Questionnaires that already produced a notification. */
	const notified = new Set<string>();
	const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** Herdr counts `active: true` events, so the first one pair with exactly one `active: false`. */
	let herdrBlocked = false;

	function dispatch(target: Rendered): void {
		if (herdrEnabled()) {
			// Herdr owns the presentation (system toast + sound + badge); writing our
			// own would duplicate it. Its blocked state is a counter, so announce once
			// per blocked stretch and clear it in `release`.
			if (!herdrBlocked) {
				herdrBlocked = true;
				pi.events.emit(HERDR_EVENT, { active: true, label: target.body || target.title });
			}
			return;
		}
		writeOsc(target);
		void notifyDesktop(target);
	}

	/**
	 * A local notification that must not touch Herdr's blocked counter.
	 *
	 * `/notify-test` used to go through `dispatch()`, which raised `active: true`
	 * with no questionnaire to ever pair it: the pane stayed blocked until the next
	 * settled run.
	 */
	function preview(target: Rendered): void {
		writeOsc(target);
		void notifyDesktop(target);
		if (herdrEnabled()) {
			pi.events.emit(HERDR_EVENT, { active: true, label: target.body || target.title });
			// Herdr counts blocked stretches, so pair it immediately.
			setTimeout(() => pi.events.emit(HERDR_EVENT, { active: false }), PREVIEW_RELEASE_MS);
		}
	}

	async function notifyDesktop(target: Rendered): Promise<void> {
		try {
			await pi.exec(
				"notify-send",
				[
					"--app-name",
					APP_NAME,
					"--urgency",
					"critical",
					"--hint",
					"string:sound-name:message-new-instant",
					"--category",
					"im.received",
					target.title,
					target.body,
				],
				{ timeout: 3000 },
			);
		} catch {
			// No notify-send / no daemon: the OSC and Herdr routes still stand.
		}
	}

	function clearGrace(key: string): void {
		const timer = graceTimers.get(key);
		if (timer) {
			clearTimeout(timer);
			graceTimers.delete(key);
		}
	}

	/** Notify for `key` once; `undefined` means "wait for the prompt payload". */
	function notifyOnce(key: string): void {
		if (notified.has(key)) return;
		notified.add(key);
		dispatch(pending.get(key) ?? GENERIC);
	}

	function release(): void {
		for (const key of graceTimers.keys()) clearGrace(key);
		pending.clear();
		notified.clear();
		if (herdrBlocked) {
			herdrBlocked = false;
			pi.events.emit(HERDR_EVENT, { active: false });
		}
	}

	pi.events.on(PROMPT_EVENT, (data) => {
		const payload = data as PromptPayload | undefined;
		const key = payload?.toolCallId ?? "anonymous";
		pending.set(key, render(payload));
		// The prompt usually precedes `blocked`; when it lands late, upgrade a
		// fallback that has not been shown yet.
		if (graceTimers.has(key)) {
			clearGrace(key);
			notifyOnce(key);
		}
	});

	pi.events.on(BLOCKED_EVENT, (data) => {
		const payload = data as BlockedPayload | undefined;
		const key = payload?.toolCallId ?? "anonymous";

		if (!payload?.active) {
			clearGrace(key);
			notified.delete(key);
			pending.delete(key);
			// `pending` must be part of the emptiness test: another questionnaire may
			// have its prompt but no `blocked` yet, and clearing it would downgrade
			// its toast to the generic line.
			if (notified.size === 0 && graceTimers.size === 0 && pending.size === 0) release();
			return;
		}

		if (notified.has(key) || graceTimers.has(key)) return;
		if (pending.has(key)) {
			notifyOnce(key);
			return;
		}
		const timer = setTimeout(() => {
			graceTimers.delete(key);
			notifyOnce(key);
		}, PAYLOAD_GRACE_MS);
		timer.unref?.();
		graceTimers.set(key, timer);
	});

	// Safety net: a questionnaire that never emits `active: false` (aborted turn,
	// stale module) must not leave the pane stuck on `blocked`.
	pi.on("agent_settled", async () => release());
	pi.on("session_shutdown", async () => release());

	pi.registerCommand("notify-test", {
		description: "Test the ask_user_question notification route",
		handler: async (_args, commandCtx) => {
			preview({ title: TITLE, body: "通知链路测试 · 问卷弹出时会走同一路径" });
			commandCtx.ui.notify(`通知已发送（${herdrEnabled() ? "herdr:blocked" : "OSC + notify-send"}）`, "info");
		},
	});
}
