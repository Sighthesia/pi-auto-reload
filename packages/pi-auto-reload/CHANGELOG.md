# Changelog

All notable changes to `@sighthesia/pi-auto-reload` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0]

### Added

- **Reload on your next message, before skill and prompt-template expansion.** An
  `input` hook intercepts the message while the agent is idle, persists it as a
  session entry, runs `ctx.reload()` from a command handler, and re-sends the
  message on the new runtime. A stale skill or template can never be used, and
  there is no timer to race.
- **Never reloads mid-run.** Interception requires an idle session, rejects
  messages carrying `streamingBehavior`, and creates no watchers outside TUI mode.
  A change arriving during a run only marks resources dirty.
- **Watches `extensions/`, `skills/`, `prompts/` and `keybindings.json`.** Themes
  are excluded because Pi hot-reloads the active user theme itself.
- **`/auto-reload`** reports status and toggles the extension; the footer shows
  `reload pending · <kinds>` and `reloading…`.

### Fixed before the first release

- A pending replay poller is invalidated by a generation counter, so `/new`,
  `/resume` or `/quit` inside its wait window cannot make it touch a replaced
  runtime.
- A reload that never lands returns the stashed text to the editor with a warning
  instead of losing the message; a still-busy runtime does the same after 10 s.
- The reload command guards `isIdle()`, so invoking it during a run cannot leave
  the extension stuck in a reloading state.
- A watcher whose root directory is replaced re-arms itself instead of going
  permanently blind while the footer still looks healthy.
- Resource filtering no longer drops dot-prefixed resource roots or directories
  named `dist`/`build`; the project keybindings path uses Pi's config directory
  name instead of a hardcoded `.pi`.
