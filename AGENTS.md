# AGENTS.md

This repository is a single Pi extension package, published to npm as
`@sighthesia/pi-auto-reload`. There is no build step and no test suite: the `.ts`
file is shipped as-is and Pi loads it through jiti.

The one behavioural rule that outranks everything else: **the extension must never
reload Pi while the agent is running.** Every guard in `extensions/auto-reload.ts`
exists for that, and any change that weakens one is a release blocker.

## Verifying a change

There is nothing to compile, so verification is loading the extension and watching
what it does. Run these before calling a change done.

```sh
pi -ne -e . --no-session -p "reply with just: ok"   # loads the working copy, no other extensions
npm pack --dry-run                                   # only these five files go to npm
```

`pi -ne -e .` must print `ok`. `npm pack --dry-run` must list exactly
`CHANGELOG.md`, `LICENSE`, `README.md`, `package.json`, `extensions/auto-reload.ts`
— a stray file means `files` in `package.json` or a stray directory.

For behaviour, the only honest test is a real session: edit a file under
`~/.pi/agent/skills/`, then send a message and confirm the reload happened *before*
the message was answered, and that the message still went out. Unit-style mocks are
possible (the extension factory takes `pi` as an argument) but they drift from Pi's
real event order; treat a mock pass as a smoke check, not as proof.

Manual checks worth repeating when touching the reload path:

| Change touches | Check |
| --- | --- |
| `input` hook, replay, or `session_start` | `/new` immediately after a reload — no extension error, and the message is not written into the new session |
| watchers | `rm -rf ~/.pi/agent/skills && mkdir ~/.pi/agent/skills` — the watcher re-arms and later edits still trigger |
| config loading | malformed `auto-reload.json` — a warning, defaults still active, session usable |
| the failure paths | a reload that never lands must return the text to the editor, never drop it silently |

## Facts about Pi that the code depends on

These were established by reading Pi 1.5.0's docs and source, and several are
non-obvious. Re-verify rather than assume if Pi's version moves.

- `input` fires after extension commands are checked and **before** `/skill:` and
  prompt-template expansion. That gap is the only reason a stale skill cannot be
  used. `docs/extensions.md` "Input Events".
- Returning `{ action: "handled" }` from `input` stops the agent; an RPC prompt then
  reports `disposition: "handled"`.
- `ctx.reload()` exists only on `ExtensionCommandContext` (command handlers). Event
  handlers and tools cannot call it, and Pi cannot reload mid-run.
- `sendUserMessage` issued while the session is busy is **dropped without an
  error** — not queued. Anything that sends must wait for `isIdle()`.
- A reload replaces the runtime; captured `pi` and session-bound `ctx` objects are
  stale afterwards and throw if used. In-memory state does not survive, which is why
  the intercepted message travels as a custom session entry.
- `appendEntry` writes land at the end of `getEntries()`, and `session_start` fires
  with `reason: "reload"` after the swap.

## Conventions

- **Language**: code, comments, commit messages, README and CHANGELOG are English.
- **Comments** explain why, not what, and cite the Pi behaviour the code depends on
  when the code would otherwise look arbitrary. The file's header block carries the
  flow diagram; keep it accurate or delete it.
- **Commits** are Conventional Commits, one topic each, imperative subject.
- **Version and doc changes travel together**: bump `version` in `package.json`, add
  a CHANGELOG entry under a `## [x.y.z]` heading, and update README if the user-
  facing surface changed. npm users only see the CHANGELOG after a version bump, so
  an unreleased feature with no version bump is invisible to them.
- **The README is the package page**: it is the repo root README and the npm
  description at once, so it must stand alone for someone who has never seen this
  repo.
- **No dependencies.** `peerDependencies` lists only host packages Pi provides. A
  runtime dependency would have to be installed by users and is almost certainly the
  wrong trade for a single-file extension.

## Publishing

```sh
npm publish --access public
```

Publishing requires a 2FA code or a granular token with `Bypass 2FA`; the account is
on `auth-and-writes`. After publishing, npm reports "being processed" and the
package is 404 for a minute or two — that is normal, not a failed publish. Confirm
with `npm view @sighthesia/pi-auto-reload version`.

Never publish a version that has not passed `pi -ne -e .` and `npm pack --dry-run`.

## Layout

```text
package.json            # name, files, pi.extensions manifest
extensions/auto-reload.ts  # the entire extension
README.md               # repo page and npm page (same file)
CHANGELOG.md            # version headings Pi shows to users after an update
LICENSE
```

Adding a second extension means adding its path to `pi.extensions` and to `files`.
A second *package* would need a real monorepo layout — the flattening decision is
only correct while there is exactly one.
