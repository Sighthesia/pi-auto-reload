# @sighthesia/pi-auto-reload

[![npm](https://img.shields.io/npm/v/@sighthesia/pi-auto-reload.svg)](https://www.npmjs.com/package/@sighthesia/pi-auto-reload)
[![license](https://img.shields.io/npm/l/@sighthesia/pi-auto-reload.svg)](LICENSE)

Lazy reload pi after editing a skill, a prompt template, a keybinding or an extension.

## Install

```sh
pi install npm:@sighthesia/pi-auto-reload
```

Restart your Pi session. It starts enabled and silent; edit anything under
`~/.pi/agent/skills/` and send a message to see it reload.

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
message is persisted, /auto-reload apply runs ctx.reload()
      ↓
new runtime re-sends your message, expanded against the fresh resources
```

The `input` event fires after extension commands are checked and **before** skill
and prompt-template expansion. That is the whole point: a stale skill can never be
used, because the reload happens in the gap before expansion, and there is no timer
to race.

Typing `/` covers the other half of the problem — seeing a newly created skill in
the menu at all.

You still get the reload — you just never wait for one, and never lose a message to
one.

## Commands

| Command | What it does |
| --- | --- |
| `/auto-reload` | Toggle the extension on or off, and say so: `auto-reload on`, `auto-reload on — reload pending (skills)`, or `auto-reload off`. |

The toggle is remembered in `<agent-dir>/auto-reload.state.json`, so it survives a
reload and a Pi restart. While off, watchers stay armed but only remember what
changed: turning it back on reports those kinds as pending instead of silently
dropping them.

There is no `/auto-reload on|off` and no status view — one command, one job. There
is also no footer line: the extension stays quiet until it actually reloads.

## Typing `/` reloads

Pi builds the slash menu from a snapshot, and only `/reload` rebuilds it. So a
skill you just created is invisible in the menu until something reloads. Typing
`/` at the start of an empty line now does that: if resources are dirty and the
agent is idle, the reload is dispatched and the menu opens on the next keystroke
with the fresh list.

The cost is that the `/` itself shows no menu (the request that triggers the
reload returns nothing); `/s` right after it lists the reloaded skills. If the
agent is busy, nothing reloads and the menu behaves normally.

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

- `<agent-dir>/auto-reload.state.json` holds only the on/off toggle written by
  `/auto-reload`. It is managed for you; delete it to start enabled again.
- The file is read at every session start, so a change takes effect after the next
  reload or Pi restart. There is no live reload of this file.
- Malformed JSON, a non-object root, or a wrongly typed key falls back to the
  defaults. Malformed JSON and unreadable files also produce a warning; wrongly
  typed keys are dropped silently.
- `themes` is deliberately not an `ignore` value. Pi already hot-reloads the active
  user theme, so this extension never watches it in the first place.

## What is watched

The watch list is derived from what Pi actually loaded, not guessed:

| Source | Reload kind |
| --- | --- |
| `<agent-dir>/extensions/`, `skills/`, `prompts/` (recursive) | `extensions` / `skills` / `templates` |
| every directory named in settings `skills`, `prompts`, `extensions` (recursive) | matching kind |
| the directory of every resource Pi reports in `pi.getCommands()` — package skills and prompts, project-local files, git packages | matching kind |
| `<agent-dir>/keybindings.json` | `keybindings` |
| `<cwd>/<config-dir>/keybindings.json` | `keybindings` |
| every entry in `watch` | `extensions` |

`<agent-dir>` is `~/.pi/agent` unless `PI_CODING_AGENT_DIR` overrides it.

**Why the derived list matters.** Resources do not have to live under
`<agent-dir>`. A `skills` entry in `settings.json` can point anywhere (this repo's
author points it at `~/.agents/skills`), and packages — npm, git or local paths like
`../../0_Files/...` — load from their own directories. Watching only the three
default locations silently misses all of that. Settings arrays contribute their
roots (so a brand-new skill counts before Pi has ever loaded it), and
`pi.getCommands()` contributes one directory per loaded resource. Nested targets are
pruned so one edit cannot mark the same kind twice, and the home directory or `/`
is never watched wholesale.

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
  back into the editor with a warning, and the stash is retired at the same time so
  it can never be replayed later. Giving the text back without retiring it is what
  used to make a later reload resend an already-handled message.
- **A stash older than 60 s** is treated as abandoned: it is retired instead of
  replayed, so a reload chain that ended long ago cannot resurrect a message.
- **Another extension writes a session entry first**: the stash is located by id and
  its consumed marker, never by "is it the last entry". Extensions that append their
  own entries from `session_start` (subagent wakes, todo state) used to make the
  replay silently skip and the message vanish.
- **Runtime still busy after the reload**: the replay waits for `isIdle()` for up to
  10 s, because a `sendUserMessage` issued while busy is dropped without an error.
- **The send does not start a run**: each dispatch is confirmed by watching for the
  session to leave idle, retried up to 3 times, and only then handed back to the
  editor with a warning. The consumed marker is written only after a confirmed send,
  so an unconfirmed one stays replayable rather than being lost.
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
