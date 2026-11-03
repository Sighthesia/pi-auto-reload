# Changelog

All notable changes to `@sighthesia/pi-attention` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0]

### Added

- **`ask-user-notify`** — notifies you when `ask_user_question` blocks on an
  answer. Emits `herdr:blocked` inside Herdr (system toast, sound and pane badge
  via Herdr's own Pi integration), and falls back to `notify-send` plus OSC 777 /
  OSC 99 elsewhere. Order-independent handling of `rpiv:ask-user:prompt` and
  `rpiv:ask-user:blocked`, one notification per `toolCallId`, and cleanup on
  `agent_settled` / `session_shutdown` so a declined questionnaire cannot leave a
  pane stuck on blocked. `/notify-test` for a manual check.
- **`auto-reload`** — reloads Pi's resources lazily on your next message instead of
  on a timer. An `input` hook intercepts before skill and prompt-template
  expansion, persists the message as a session entry, runs `ctx.reload()` from a
  command handler, and re-sends the message on the new runtime. Never reloads
  while the agent runs: interception requires an idle session, rejects messages
  carrying `streamingBehavior`, and is inert outside TUI mode. Watches
  `extensions/`, `skills/`, `prompts/` and `keybindings.json`; themes are excluded
  because Pi hot-reloads them itself. `/auto-reload` reports status and toggles.
