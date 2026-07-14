# Changelog

## Unreleased — 1.2.0 release candidate

## 1.2.0

> Reserved release section for version consistency checks. These changes remain an engineering release candidate until the GitHub tag and archive are published.

- Added durable Schedule Occurrences with stable due-time identity, renewable fenced claims, bounded retry budgets, explicit skip/run-once misfire policy, and retained one-shot audit history.
- Separated verified Pi execution settlement from channel delivery through a durable Delivery Outbox, so channel outages retry delivery without replaying the Agent, Task, or Tool work.
- Linked Schedule Occurrences to their Pi-created Objective and Task Run, and added `schedule_get`, `schedule_update`, `schedule_run_now`, and `schedule_status` management tools.
- Kept the Profile Runtime and scheduler alive when every configured channel is temporarily offline; ChannelHost continues supervised reconnect while completed results remain queued for delivery.
- Deliver scheduled Agent results only after the durable Objective reaches accepted Verification; rejected or unavailable candidates remain recoverable work.
- Preserve stable Occurrence/Objective lineage across retries, fence expired delivery workers, bound dead letters and skipped history, and keep recurring cadence unchanged after `run now`.
- Added deterministic multi-instance Profile Bindings, group Conversation/Actor separation, bounded contextual activation and observation, governed proactive delivery, ingress backpressure, and Profile Host lifecycle isolation.
- Added explicit, fenced migrations for legacy Channel Instance and shared-session ownership, including integrity manifests, rollback protection, and operator diagnostics.
- Split the platform-neutral Channel Runtime, Feishu Adapter, and Telegram Adapter into independent packages; rich presentation now stays behind the Adapter-owned `InteractionPresenter` seam with declared capability fallbacks.
- Removed long-lived Feishu and Telegram plaintext credentials from ordinary `BeeMaxConfig` and Adapter settings; Channel Instance `credentialRef` values are consumed through a callback-only trusted boundary and observe rotations without rebuilding the config object.
- Aligned Telegram groups with the transport-neutral Activation contract: verified mention/reply/command signals, bounded same-Thread contextual follow-ups, and observe-only delivery that cannot enter the Agent message path.
- Added a hardened Docker Execution Sandbox with CPU, memory, PID, filesystem, network, capability, output, timeout, cancellation, and workspace-access controls while retaining explicit trusted-host execution.
- Added Ubuntu 24.04 resource high-water gates for RSS, SQLite size, queues, concurrency, systemd limits, and Docker isolation, plus release security evidence for Profile and Memory separation and exactly-once Effects.
- Added release evidence for independent Profile failure/capacity boundaries, Session migration crash continuation, a shared Feishu/Telegram factory conformance harness, and real builds with either platform Adapter package absent.
- Hardened clean builds and release archives so stale generated modules cannot mask failures; isolated archive smoke now creates and reloads a Profile and verifies packaged Skills without inheriting host BeeMax state.

## 1.1.0

- Replaced the Feishu-shaped Gateway startup path with a registry-only
  `ChannelHost` that attaches multiple transport adapters to one shared Profile
  Runtime, isolates channel connection failures, and supports pause/resume and
  channel-neutral delivery routing.
- Added `gateway.channels[]` declarations with opaque `credentialRef` values,
  owner-only Profile secret resolution, legacy Feishu configuration migration,
  per-adapter Doctor checks, and channel lifecycle CLI commands.
- Added a production Telegram Bot API adapter with bounded long polling,
  deny-by-default user/chat access, text reply/edit and typing support, native
  image/file delivery, and bounded temporary downloads for inbound images,
  documents, audio, and voice.
- Added capability degradation for channels without interactive cards: the same
  governed Pi execution produces a final text response without creating a
  channel-specific Agent loop.
- Preserved Core ownership of Tasks, Memory, Policy, Effects, Verification,
  recovery, automation, and Initiative while allowing one Gateway process to
  host Feishu/Lark and Telegram together.

## 1.0.0

- Unified interactive, durable-task, recovery, Initiative, Tool Effect,
  Checkpoint, Verification, and delivery execution around one Core-owned Pi
  Agent Runtime without fixing customer business objects or workflows.
- Added Profile-scoped Work Context, evidence-backed organizational Memory,
  durable Task Ledger recovery, governed external Effects and receipts, and
  bounded correction and proactive execution.
- Added auxiliary image understanding with provider routing and an automatic
  local Tesseract fallback, including Ubuntu dependency installation.
- Hardened long-running Gateway operation with single-flight background work,
  awaited shutdown, bounded execution-trace indexes, bounded streaming cards,
  scoped Effect projections, and release-time heap/RSS regression checks.
- Added reproducible Ubuntu release archives, isolated installation checks,
  security audit, performance, recovery, fault-evidence, architecture,
  migration, and full-suite release gates.

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

> Current source layout vendors Pi directly in `pi/`; the independent Pi repository remains available for subtree synchronization.

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
