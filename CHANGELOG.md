# Changelog

## 0.1.0-preview.5

- Rebuilt the product boundary around `@beemax/core` as the sole Agent Runtime.
- Separated Gateway enterprise control-plane transport from MCP, Feishu meeting,
  Web, Memory, Automation, Skills and image capabilities.
- Added profile-scoped inbound idempotency, architecture-boundary tests, and
  clean single-archive build verification.

## 0.1.0-preview.4

- Switched the Pi submodule to the maintained BeeMax fork so release archives can be reproduced by GitHub Actions.

## 0.1.0-preview.3

- Added a single verified release archive containing BeeMax and Pi; the one-command installer no longer requires Git or clones submodules.

## 0.1.0-preview.2

- Added a Hermes-style one-command bootstrap installer with version selection, source-install compatibility, and Profile-preserving uninstall support.

## 0.1.0-preview.1

- Added installable BeeMax CLI with Agent profile, model, Feishu channel, doctor, and systemd lifecycle commands.
- Added Feishu streaming Gateway, persistent Pi sessions, FTS5 memory, Skills, MCP, web research, meetings, automation, Heartbeat, and optional GPT Image 2 delivery.
- Added bounded read-only Sub-Agents with `task_spawn`, `task_status`, `task_wait`, `task_cancel`, and cascading `/stop`.
- Added deny-by-default access, mutating-tool approval, workspace/credential boundaries, and non-root service defaults.
- Added isolated Profile Homes under `~/.beemax/profiles`, `SOUL.md` identity, active Profile selection, and non-destructive migration from legacy repository-local Profiles.
- Added unified `beemax setup` and `beemax gateway setup` flows with Feishu permissions guidance, live credential/bot probing, and readiness diagnostics.
- Added Hermes-style Gateway lifecycle subcommands and per-Feishu-App Profile locks to prevent duplicate consumers.
- Added hardened Feishu webhook handling, safe/standard toolsets, bundled progressive Skills, curated profile memory, candidate review commands, MCP resources/prompts, and MCP diagnostics.
- Fixed model-secret handling so API keys are accepted only from the environment or masked interactive prompt, never CLI arguments.
- Fixed memory recall so only curated memories enter the model context; pending conversation candidates require explicit promotion.
- Fixed Profile backups to create and verify a consistent SQLite snapshot while the Gateway is running.
- Fixed MCP startup with per-server initialization deadlines and optional-server degradation.
