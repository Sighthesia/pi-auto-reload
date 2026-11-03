# @sighthesia/pi-auto-reload

A [Pi](https://github.com/earendil-works/pi) extension that reloads your resources
**on your next message**, right before they are used — not on a timer, and never
while the agent is running.

```sh
pi install npm:@sighthesia/pi-auto-reload
```

Restart your Pi session.

## The problem

Pi has no file watcher. After editing a skill, a prompt template, a keybinding or
an extension, you have to remember `/reload`. Forget it, and the agent keeps
working against the stale version — the worst case being a skill you just rewrote
that still behaves like the old one.

`/reload` cannot be automated with a timer either: it is not allowed mid-run, and
a reload throws away extension state, so firing one while you are typing wastes
work and can swallow what you were about to send.

## What this does

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

The `input` event fires after extension commands are checked and **before** skill
and prompt-template expansion. That is the whole point: a stale skill can never be
used, because the reload happens in the gap before expansion, and there is no
timer to race.

## Why it never reloads mid-run

- Interception requires `ctx.isIdle()`.
- Messages carrying `streamingBehavior` (steer/follow-up during a run) pass through
  untouched.
- Outside TUI mode (`-p`, JSON) no watchers are created at all.
- The reload command itself re-checks `isIdle()` before calling `ctx.reload()`.
- A change that lands while the agent works only marks resources dirty. Nothing is
  reloaded until you send something new.

## Commands

```sh
/auto-reload          # status: enabled/disabled, idle state, pending resources, watched paths
/auto-reload off      # disable
/auto-reload on
```

The footer shows `reload pending · skills` while resources are dirty and
`reloading…` during the swap. Nothing is shown when idle and clean.

## What is watched

| Path | Reload kind |
| --- | --- |
| `<agent-dir>/extensions/` (recursive) | `extensions` |
| `<agent-dir>/skills/` (recursive) | `skills` |
| `<agent-dir>/prompts/` (recursive) | `templates` |
| `<agent-dir>/keybindings.json` | `keybindings` |
| `<cwd>/<config-dir>/keybindings.json` | `keybindings` |

`<agent-dir>` is `~/.pi/agent` unless `PI_CODING_AGENT_DIR` overrides it.

**Themes are excluded on purpose.** Pi already hot-reloads the active user theme
from `<agent-dir>/themes/<name>.json`, so a watcher-triggered reload there would
only discard your session for nothing.

Ignored: dot-prefixed files, `node_modules/`, `__pycache__/`, and
`*.log|tmp|swp|swo|bak|old|orig|rej|~`. Editor swap files and `pnpm install` churn
therefore do not trigger anything. A resource directory literally named `dist` or
`build` is *not* ignored — only dependency directories are.

## Failure behavior

- **Reload never lands** (message dropped, turn collapsed): the stashed text goes
  back into the editor with a warning. Your message is not lost silently.
- **Runtime still busy after the reload**: the replay polls `isIdle()` for up to
  10 s, because a `sendUserMessage` issued while busy is dropped without an error.
  Past the deadline it hands the text back to the editor instead of pretending it
  was sent.
- **Watcher root replaced** (`rm -rf extensions && mkdir extensions`): the watcher
  re-arms itself after 1 s rather than going permanently blind.
- **`/new`, `/resume`, `/quit` during a pending replay**: a generation counter
  stops the poller from touching the replaced runtime.

## Requirements

- Pi 1.5.0 or newer.
- Node 20+ on Linux, for `fs.watch` with `recursive: true`.

## Notes

- Editing the extension itself triggers a reload on your next message. That is
  expected.
- The message is stored as a custom session entry while the reload is in flight,
  because a reload replaces the runtime and in-memory state does not survive it.

## License

MIT
