# Changelog

All notable changes to `@sighthesia/pi-auto-reload` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0]

### Added

- **Typing `/` at the start of an empty line reloads when resources are dirty**, so
  a skill you just created appears in the slash menu on the next keystroke. Pi
  builds that menu from a snapshot only `/reload` rebuilds; the reload is dispatched
  from an autocomplete provider, and the `/` request itself returns no items. Guarded
  by the same rules as everything else: idle agent, dirty resources, not already
  reloading.

## [1.2.0]

### Changed

- **`/auto-reload` is now a single toggle.** The old `on`/`off` arguments and the
  status view are gone: one invocation flips the extension and reports the new
  state, including any kinds left pending. The state is persisted to
  `<agent-dir>/auto-reload.state.json`, so it survives a reload and a restart
  instead of resetting to enabled each session.
- **No footer status line.** `reload pending · <kinds>` and `reloading…` are no
  longer painted; the extension is silent until a reload actually happens.
- While disabled, changes are remembered rather than dropped, so re-enabling
  reports them as pending instead of silently ignoring the edits.

### Removed

- **`/auto-reload-apply` is no longer a separate command.** The reload dispatcher
  is now `/auto-reload apply`, an internal argument of the same command, so the
  package registers exactly one slash command.

## [1.1.0]

### Added

- **Optional config file at `<agent-dir>/auto-reload.json`.** `watch` adds extra
  directories to watch, `ignore` drops resource kinds, and `quiet` suppresses the
  reload notice. Malformed JSON warns and falls back to the defaults; wrongly typed
  keys are dropped silently.
- `/auto-reload` now reports the config file in use, the ignored kinds, and the
  paths actually being watched, including any added by `watch`.

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
