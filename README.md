# @sighthesia/pi-auto-reload

[![npm](https://img.shields.io/npm/v/@sighthesia/pi-auto-reload.svg)](https://www.npmjs.com/package/@sighthesia/pi-auto-reload)
[![license](https://img.shields.io/npm/l/@sighthesia/pi-auto-reload.svg)](LICENSE)

A [Pi](https://github.com/earendil-works/pi) extension that reloads your resources
**on your next message**, right before they are used — never on a timer, never
while the agent is running.

## Install

```sh
pi install npm:@sighthesia/pi-auto-reload
```

Restart your Pi session. Verify with `/auto-reload`.

Other install sources:

```sh
pi install git:github.com/Sighthesia/pi-extensions      # straight from this repo
pi -e npm:@sighthesia/pi-auto-reload                    # try once, no settings change
```

Remove it with `pi remove npm:@sighthesia/pi-auto-reload`.

## The problem

Pi has no file watcher. After editing a skill, a prompt template, a keybinding or
an extension, you have to remember `/reload`. Forget it, and the agent keeps
working against the stale version — the worst case being a skill you just rewrote
that still behaves like the old one.

A timer cannot automate that either: `/reload` is not allowed mid-run, and it
throws away extension state, so firing one while you are typing wastes work and can
swallow what you were about to send.

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
used, because the reload happens in the gap before expansion, and there is no timer
to race.

You still get the reload — you just never wait for one, and never lose a message to
one.

## Commands

| Command | What it does |
| --- | --- |
| `/auto-reload` | Show status: enabled/disabled, whether the agent is idle, pending resource kinds, config file in use, ignored kinds, and every watched path. |
| `/auto-reload on` | Enable the extension. |
| `/auto-reload off` | Disable it. Pending changes are dropped and watchers go quiet until you turn it back on. |

The footer shows `reload pending · skills` while resources are dirty and
`reloading…` during the swap. Nothing is shown when idle and clean.

## Configuration

Optional. Create `<agent-dir>/auto-reload.json` — `~/.pi/agent/auto-reload.json` by
default, or under `PI_CODING_AGENT_DIR` when that is set.

```json
{
  "watch": ["notes-skills", "/home/me/shared/prompts"],
  "ignore": ["keybindings"],
  "quiet": false
}
```

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `watch` | `string[]` | `[]` | Extra directories to watch, absolute or relative to the agent dir. A change in any of them counts as an `extensions` change. |
| `ignore` | `string[]` | `[]` | Resource kinds to stop watching. Valid values: `extensions`, `skills`, `templates`, `keybindings`. |
| `quiet` | `boolean` | `false` | Suppress the notice shown when a reload starts. Warnings about lost messages are never suppressed. |

Notes:

- The file is read at every session start, so a change takes effect after the next
  reload or Pi restart. There is no live reload of this file.
- Malformed JSON, a non-object root, or a wrongly typed key falls back to the
  defaults. Malformed JSON and unreadable files also produce a warning; wrongly
  typed keys are dropped silently.
- `themes` is deliberately not an `ignore` value. Pi already hot-reloads the active
  user theme, so this extension never watches it in the first place.

## What is watched

| Path | Reload kind |
| --- | --- |
| `<agent-dir>/extensions/` (recursive) | `extensions` |
| `<agent-dir>/skills/` (recursive) | `skills` |
| `<agent-dir>/prompts/` (recursive) | `templates` |
| `<agent-dir>/keybindings.json` | `keybindings` |
| `<cwd>/<config-dir>/keybindings.json` | `keybindings` |
| every entry in `watch` | `extensions` |

`<agent-dir>` is `~/.pi/agent` unless `PI_CODING_AGENT_DIR` overrides it.

**Themes are excluded on purpose.** Pi already hot-reloads the active user theme
from `<agent-dir>/themes/<name>.json`, so a watcher-triggered reload there would
only discard your session for nothing.

Ignored: dot-prefixed files, `node_modules/`, `__pycache__/`, and
`*.log|tmp|swp|swo|bak|old|orig|rej|~`. Editor swap files and `pnpm install` churn
therefore do not trigger anything. A resource directory literally named `dist` or
`build` is *not* ignored — only dependency directories are.

## Why it never reloads mid-run

- Interception requires `ctx.isIdle()`.
- Messages carrying `streamingBehavior` (steer/follow-up during a run) pass through
  untouched.
- Outside TUI mode (`-p`, JSON) no watchers are created at all.
- The reload command itself re-checks `isIdle()` before calling `ctx.reload()`.
- A change that lands while the agent works only marks resources dirty. Nothing is
  reloaded until you send something new.

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

## Differences from `pi-auto-reload`

There is an unrelated npm package called `pi-auto-reload` (by subaud-tools). Both
reload a session, but they watch different things:

| | `pi-auto-reload` | this package |
| --- | --- | --- |
| Triggers on | installed npm packages changing on disk, `settings.json`'s package list, channel server upgrades | your hand-edited resource files |
| When | polls every 15 s, reloads as soon as idle | on your next message, before skill/template expansion |
| Timer | yes | no |

They can be installed together; the command names do not collide.

## Requirements

- Pi 1.5.0 or newer.
- Node 20+ on Linux, for `fs.watch` with `recursive: true`.

## Notes

- Editing the extension itself triggers a reload on your next message. That is
  expected.
- The message is stored as a custom session entry while the reload is in flight,
  because a reload replaces the runtime and in-memory state does not survive it.

## Development

This repository *is* the package: `package.json`, `extensions/`, README, CHANGELOG
and LICENSE sit at the root, so `pi install git:github.com/Sighthesia/pi-extensions`
installs straight from here and npm packs the same tree.

```sh
pi -e .            # load the working copy, no settings change
npm pack --dry-run # check what would be published
npm publish --access public
```

## License

MIT
