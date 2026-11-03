# @sighthesia/pi-attention

Two [Pi](https://github.com/earendil-works/pi) extensions for the moments when the
agent is **not** the thing you are watching.

- **`ask-user-notify`** — tells you the instant `ask_user_question` blocks on an
  answer, through Herdr, your desktop notification daemon, or the terminal itself.
- **`auto-reload`** — reloads Pi's resources on your **next message**, right before
  `/skill:` and prompt templates expand, instead of on a timer.

```sh
pi install npm:@sighthesia/pi-attention
```

Restart your Pi session.

---

## ask-user-notify

`@juicesharp/rpiv-ask-user-question` writes a single terminal BEL when a
questionnaire opens. If you are in another app, that is easy to miss. This
extension subscribes to the package's stable event contract
([`events.ts`](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-ask-user-question/events.ts))
and routes a real notification:

| Environment | Route |
| --- | --- |
| Inside [Herdr](https://herdr.dev) | Emits `herdr:blocked`, which Herdr's own Pi integration turns into a system toast, a sound, and a blocked badge on the pane. This is the bridge requested in [rpiv-mono#165](https://github.com/juicesharp/rpiv-mono/issues/165). |
| Linux desktop | `notify-send` with `--urgency critical` and `sound-name:message-new-instant`. |
| Any terminal | OSC 777 (Warp, Ghostty, WezTerm) or OSC 99 (kitty) alongside the above. |

The toast carries the questionnaire's own text — the first question's header, its
question, the option count, or `共 N 问` when there are several — so you know what
is being asked without switching back.

Details worth knowing:

- Order-independent. `rpiv:ask-user:prompt` and `rpiv:ask-user:blocked` may arrive
  in either order; a `blocked` that beats its prompt waits up to 300 ms and then
  falls back to a generic line rather than staying silent.
- One notification per questionnaire, keyed by `toolCallId`.
- Herdr's blocked state is a counter, so exactly one `active: true` is paired with
  one `active: false` per blocked stretch — concurrent questionnaires merge.
- `agent_settled` and `session_shutdown` clear the state, so an Esc-aborted
  questionnaire cannot leave a pane stuck on blocked.

`/notify-test` fires a sample notification through whichever route is active.

## auto-reload

Pi has no file watcher. `/reload` exists, and `ctx.reload()` is callable from
command handlers only. This extension watches your resource directories and
reloads **lazily**: a change never triggers a reload by itself.

```
you edit a skill
      ↓  (only marks it dirty — no reload, no timer)
you send your next message
      ↓
input hook intercepts, before /skill: and template expansion
      ↓
message is persisted, /auto-reload-apply runs ctx.reload()
      ↓
new runtime re-sends your message, expanded against the fresh resources
```

Why the `input` hook: it fires after extension commands are checked and **before**
skill and prompt-template expansion, so a stale skill can never be used, and there
is no timer to race.

The agent is never reloaded mid-run. Interception requires `ctx.isIdle()`, rejects
any message carrying `streamingBehavior`, and does nothing outside TUI mode.

Watched: `extensions/`, `skills/`, `prompts/` (recursive) and `keybindings.json`.
Themes are excluded on purpose — Pi already hot-reloads the active user theme.

```sh
/auto-reload          # status, watched paths, pending resources
/auto-reload off      # disable
/auto-reload on
```

Footer status shows `reload pending · skills` while resources are dirty and
`reloading…` during the swap. Nothing is shown when idle and clean.

Behavior notes:

- Dot-directories, `node_modules/`, `dist/`, `build/` and `*.log|tmp|swp|bak|~`
  are ignored, so `pnpm install` and editor swap files do not trigger anything.
- If the runtime is still busy after a reload, the replay polls `isIdle()` for up
  to 10 s. A `sendUserMessage` issued while busy is dropped silently, which is why
  the wait exists. Past the deadline it tells you to resend rather than swallow
  your message.
- The intercepted message is stored as a custom session entry, because a reload
  replaces the runtime and in-memory state does not survive it.

## Requirements

- Pi 1.5.0 or newer.
- `ask-user-notify` needs `@juicesharp/rpiv-ask-user-question` for the events it
  listens to, and does nothing if that package is absent.
- `auto-reload` uses `fs.watch` with `recursive: true`, which needs Node 20+ on
  Linux.

## License

MIT
