# Changelog

## 0.1.0-preview.15

- Added selectable Custom endpoint protocols: OpenAI Chat Completions, OpenAI
  Responses, and Anthropic Messages.

## 0.1.0-preview.14

- Added macOS LaunchAgent Gateway lifecycle support, including per-Profile
  background services and Gateway log retrieval.

## 0.1.0-preview.13

- Fixed local chat to render the final Agent answer when a provider does not
  emit streaming message-update events.

## 0.1.0-preview.12

- Fixed Custom OpenAI-compatible endpoints so Profile model IDs and Base URLs
  create a Pi OpenAI-completions runtime and use `CUSTOM_API_KEY`.

## 0.1.0-preview.11

- Fixed interactive provider selection so numeric menu choices resolve to the
  corresponding Pi provider ID before credentials are stored.

## 0.1.0-preview.10

- Added Hermes-style Profile-owned Gateway configuration, isolated default
  workspaces, Profile-first provider credentials, and a shared local/Gateway
  runtime policy.
- Added Profile-level multi-provider model switching and dynamic new-session
  model resolution.
- Added `beemax update`, which verifies and atomically installs the latest
  release (including Preview releases) archive without changing Profile data.
- Added an optional hardened Docker execution backend with explicit workspace
  access and Doctor validation.

## 0.1.0-preview.8

- Added a Profile-aware model provider catalog for Anthropic, OpenAI,
  OpenRouter, Gemini, DeepSeek, Ollama, and custom OpenAI-compatible endpoints.
- `beemax model list` and `beemax setup` now share provider defaults and
  custom-endpoint Base URL handling.

## 0.1.0-preview.7

- Added a generated hybrid SOUL template: OpenClaw-style default identity and
  workspace context, with Hermes-style Profile isolation, bounded loading, and
  safe fallback for missing or obvious prompt-injected SOUL content.
- Updated setup so it preserves the generated identity unless the user supplies
  a custom SOUL explicitly.

## 0.1.0-preview.6

- Restored profile-configured Agent session bounds at the Runtime composition
  root and removed obsolete Dispatcher lifecycle fields.
- Made the durable media outbox a Core-owned port, with Gateway-only channel
  delivery and acknowledgement.
- Updated the single-package installer for `sha256sum` Linux compatibility and
  documented all installation prerequisites.

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
