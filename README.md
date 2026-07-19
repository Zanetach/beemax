# BeeMax Agent

> A durable personal and organizational Agent runtime built on Pi, with scoped Memory, governed execution, recoverable Tasks, progressive Skills, and multi-channel delivery.

[![Release](https://img.shields.io/github/v/release/Zanetach/beemax?display_name=tag)](https://github.com/Zanetach/beemax/releases/latest)
[![CI](https://github.com/Zanetach/beemax/actions/workflows/ci.yml/badge.svg)](https://github.com/Zanetach/beemax/actions/workflows/ci.yml)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-339933?logo=node.js&logoColor=white)
![Platform](https://img.shields.io/badge/platform-Ubuntu%20%7C%20macOS-4c566a)

![BeeMax Agent turns scoped context and durable memory into governed, verified execution](docs/assets/beemax-agent-runtime.png)

BeeMax is one Agent product with one Core-owned Pi execution loop. It can chat locally, connect to Feishu/Lark and Telegram through one Profile Gateway, preserve long-running responsibility across restarts, and understand images through native vision or OCR.

Every surface operates under Profile-scoped policy.

It does not encode customer-specific objects such as orders, tickets, or contracts. Unknown business vocabulary enters through Work Context, evidence, configured capabilities, and enterprise policy instead of a fixed business ontology.

## The execution flow

```text
Natural-language Turn
        ↓
One Pi model understands the requested outcome
        ├─ simple → answer directly
        └─ complex → adapt the plan while executing
                         ↓
              progressively load Tools / Skills
                         ↓
              model ↔ Tool loop with recovery
                         ↓
              model completion + system guards
                         ↓
                    text and files

Durable Trigger or explicit Objective lifecycle
        ↓
admitted Work Contract → Objective / Task Ledger
        ↓
the same Pi loop → checkpoint → independent Verification → delivery
```

Pi owns task understanding, adaptive execution, model interaction, tools, session events, and live compaction. BeeMax Core adds product semantics around Pi: progressive capability disclosure, scope, sandbox and approval policy, durable responsibility where requested, Effect authority, recovery, verification, and delivery. Work Contracts govern durable/background responsibility; they are not a mandatory pre-model classification pass for ordinary interactive work.

## Quick start

### 1. Install BeeMax

Linux and macOS require Node.js 22.19 or newer, `curl`, `tar`, `npm`, and either `sha256sum` or `shasum`.

Install the latest published BeeMax release:

```bash
curl -fsSL https://raw.githubusercontent.com/Zanetach/beemax/main/scripts/bootstrap-install.sh | bash
```

The bootstrap installer resolves GitHub's latest stable Release, then downloads its checksum-verified archive containing BeeMax and the vendored Pi source. Application files go to `~/.beemax/app`; the command is installed to `~/.local/bin`.

To validate unreleased source or contribute to BeeMax, install from a checkout instead:

```bash
git clone https://github.com/Zanetach/beemax.git
cd beemax
./scripts/install.sh
```

On Ubuntu and macOS, installation also discovers or installs Tesseract OCR. Ubuntu installation additionally provisions Noto CJK fonts so Chinese HTML/PDF reports retain visible, extractable text. Set `BEEMAX_INSTALL_MEDIA_DEPS=0` only when the host image manages these dependencies separately.

### 2. Create a Profile

```bash
beemax setup --profile personal
```

The wizard configures the Profile identity, model, credentials, workspace, Skills, and local readiness. Secrets are prompted securely and stored outside YAML.

### 3. Start chatting

```bash
beemax chat --profile personal
```

Local chat uses the same Profile, Memory, Skills, Pi runtime, governance, and durable work graph as a channel Gateway.

### 4. Connect messaging channels when needed

```bash
beemax gateway setup --profile personal
beemax gateway run --profile personal
```

The setup flow configures the channel allowlist, probes credentials and bot identity, and prints the Feishu publishing checklist. WebSocket long connection is the default; webhook mode is available for public HTTPS deployments.

Telegram can run beside Feishu in the same Profile Gateway:

```bash
beemax channel add telegram --profile personal
beemax channel test telegram --profile personal
beemax channel list --profile personal
```

## What ships in 1.5

| Area | Implemented surface |
| --- | --- |
| Agent runtime | One Core-owned model-first Pi runtime for CLI and Gateway, with adaptive planning for complex turns and a Contract-governed lane for durable Tasks, recovery, automation, and proactive execution |
| Work Context | Situation model for facts, goals, constraints, uncertainty, conflicts, possible actions, and provenance |
| Memory | SQLite/FTS5 recall, scope isolation, evidence lineage, correction, conflict, candidates, conventions, and verified Episodes |
| Durable work | Objectives, DAG Task Plans, Task Runs, leases, Checkpoints, Candidate Results, Verification, correction, cancellation, and recovery |
| Effects | One authority for mutating Tool Effects, idempotency, provider receipts, unknown outcomes, reconciliation, and compensation |
| Initiative | Evidence-gated observation and read-only investigation with duplicate and interruption controls |
| Context | Model-aware budgets, bounded Tool results, Pi compaction, Task Preservation Envelopes, and restart-safe recovery context |
| Channels | Independent Channel Runtime and Adapter packages, deterministic multi-instance Bindings, shared group Conversations, bounded contextual activation, Feishu/Lark streaming cards, Telegram text/media, governed delivery, and Profile lifecycle isolation |
| Images | Native model vision, auxiliary configured vision models, local Tesseract OCR, and optional GPT Image generation |
| Capabilities | Progressive Skills, Web research, MCP, WeKnora retrieval, Feishu meetings, files, schedules, reminders, and bounded Sub-Agents |
| Operations | Doctor, Profile backup, explicit Channel/Session ownership migration, hardened Docker execution, Ubuntu resource gates, Linux systemd, macOS LaunchAgent, logs, traces, Effect inspection, and verified updates |

## Architecture

```text
┌───────────────────────────────────────────────────────────┐
│ Product / Profile                                         │
│ identity · model · policy · Skills · capability grants    │
├───────────────────────────────────────────────────────────┤
│ BeeMax Core                                               │
│ Pi runs · context · Memory · Tasks · Effects · governance │
│ Checkpoints · Verification · recovery · Initiative        │
├───────────────────────────────────────────────────────────┤
│ Capability adapters                                      │
│ Web · MCP · WeKnora · Feishu VC · images · files          │
├───────────────────────────────────────────────────────────┤
│ Gateway / ChannelHost                                    │
│ registry · connection · auth · routing · presentation    │
│ Feishu/Lark · Telegram · future channel adapters         │
├───────────────────────────────────────────────────────────┤
│ Operations                                                │
│ install · Profiles · services · backup · doctor · logs    │
└───────────────────────────────────────────────────────────┘
```

`@beemax/core` is the only Agent Runtime boundary. Gateway owns channel transport and enterprise control-plane concerns, but does not select models, assemble prompts, recall Memory, or decide Agent work.

Capability packages consume Pi primitives through Core. The CLI presentation layer may use `pi-tui`, but it does not own Agent execution. See the [Core/Gateway ownership contract](docs/architecture/core-gateway-boundaries.md).

## Profiles and configuration

Each Profile is an isolated Agent Home under `~/.beemax/profiles/<name>/`.

| Path | Purpose |
| --- | --- |
| `config.yaml` | Profile model, runtime, channel, context, and capability settings |
| `.env` | Provider and channel secrets, stored with owner-only permissions |
| `SOUL.md` | Long-lived identity, style, and default behavioral boundaries |
| `USER.md` | Stable user preferences and working context |
| `MEMORY.md` | Reviewed durable-memory snapshot |
| `workspace/` | Isolated default workspace and project instructions |
| `skills/` | Profile-scoped progressive Skills |
| `data/` | SQLite authority, Pi sessions, traces, caches, and delivery state |

Common Profile operations:

```bash
beemax profile create work
beemax profile list
beemax profile show work
beemax profile use work
beemax profile backup work ./backups
beemax doctor --profile work
```

Set `BEEMAX_HOME` to relocate all Profile Homes. Legacy repository-local Profiles remain readable and can be copied non-destructively with `beemax profile migrate <name>`.

### Models

Setup reads providers and model capabilities from Pi's built-in registry. A Profile can hold multiple configured models and switch per conversation.

Custom endpoints support OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages protocols. Declare the real context window and maximum output when capability metadata is unavailable.

```yaml
model:
  provider: custom
  model: company-model
  baseUrl: https://models.example.com/v1
  customProtocol: openai-responses
  contextWindow: 128000
  maxTokens: 8192
```

Keep API keys in the Profile `.env`, or enter them through `beemax setup`. BeeMax rejects model and credential secrets passed in command-line arguments.

### Toolsets

Profiles use the `standard` Toolset by default. Set `agent.toolset: safe` for a lower-trust channel.

The safe Toolset keeps read/search, Memory inspection, task status, schedules, Skill inspection, and read-only MCP tools. It excludes shell, file writes, Memory mutation, image generation, scheduling mutation, and mutating MCP tools.

Capability selection is progressive. An admitted exact Tool/MCP/Skill name, alias, or trigger phrase uses a deterministic metadata fast path; description-word overlap is recall only and never grants execution authority. Configured Profile text models resolve the remaining requirements with bounded semantic cognition. BeeMax may fail over between configured semantic models. Only Provider unavailability or the auxiliary preflight deadline may repair through the same exact local metadata; malformed, empty, incomplete, or below-threshold semantic output fails closed and is never replaced by weaker lexical routing. When no Profile text model is configured, lexical recall remains available but still passes Policy and Tool-Spec admission. A valid semantic “no match” remains empty and never forces an unrelated Skill. Optional Profile preferences optimize equivalent candidates but do not grant execution authority:

```yaml
agent:
  capabilityPreferences:
    web_search: 0.4
    skill:source-review: 0.8
  capabilityCognition:
    maxModelAttempts: 3
    maxTokens: 2048
    timeoutMs: 12000
```

Preference values range from `-1` to `1`. Capability cognition retries distinct Provider models without a cumulative token or cost ceiling; a timed-out model is not retried inside a smaller slice of the same deadline, while a fast structural response may receive one bounded repair. `maxModelAttempts` accepts `1`–`5`. The compact `maxTokens` value is only the output size requested for one bounded JSON decision, not an Agent Turn or Objective budget. `timeoutMs` bounds only this optional preflight lane; it never times out or abandons the Objective. Individual stalled network requests still fail visibly so another Provider or exact deterministic discovery route can continue the unchanged Objective. Neither setting authorizes description-overlap fallback or lexical degradation after malformed or empty semantic responses. Policy, Profile scope, Provider health, Effects, and the turn-scoped Tool Spec still decide whether a selected capability can execute.

Missing Provider acquisition is disabled by default. Operators may pre-authorize exact Provider adapters per Profile; the mutating `capability_acquire` Tool still requires runtime approval, installation uses a pinned adapter in the Profile's private directory, and BeeMax resumes the unchanged Objective only after a health probe returns evidence:

```yaml
capabilityProviders:
  installation:
    enabled: true
    allowedProviders: [exa-mcporter]
```

The equivalent environment settings are `BEEMAX_PROVIDER_INSTALLATION_ENABLED=true` and `BEEMAX_PROVIDER_INSTALLATION_ALLOW=exa-mcporter`. BeeMax currently ships a pinned Exa/mcporter adapter for restoring `web_search`; arbitrary package names or model-authored shell commands are never accepted. The adapter installs a fixed mcporter dependency closure from BeeMax's SHA-256-verified `package-lock`, disables package lifecycle scripts, runs with a minimal Profile-scoped environment, and publishes through an atomic cross-process lock plus rename. Its manifest content-addresses the executable, configuration, and complete dependency tree; integrity is rechecked before health probes and searches. Interrupted or ambiguous installs leave a durable quarantine; the next acquisition first reconciles the isolated staging state, then retries without overlapping the previous installer. Missing configuration, denied authority, unhealthy installation, and unknown outcomes fail closed instead of producing an evergreen substitute.

Every Capability decision receives a content-free cognition ID that correlates model usage, fallback telemetry, the execution trace, and the eventual verified, rejected, failed, cancelled, or unverified task outcome. Calibration reports keep lexical, frozen-semantic, and live-Provider results separate and measure Top-1, Top-K, required-capability recall, unnecessary activation, no-match precision, completion, latency, tokens, and cost. Versioned threshold trials cannot be promoted when authorization, false-positive, recall, or completion metrics regress.

Before a release, refresh the credentialed semantic-routing and outcome evidence with `npm run eval:capability-ranking:live -- --profile <profile> --write evals/baselines/capability-ranking-live.json`. This includes a separate live-Pi lane: the configured model receives the turn-scoped Tool Spec, chooses Tools itself, and must satisfy independent Acceptance Criteria. Every Pi-originated Tool call is bound to the exact internal assistant Turn, Provider response, Tool name, and canonical argument identity that produced it. Provider response IDs and Tool arguments never enter the durable Trace as raw content: only SHA-256 identity projections are retained. A Tool-bearing Turn without a reported Provider response identity is blocked before execution; a Tool-free Turn may honestly record the identity as `unavailable`. The deterministic routing harness remains infrastructure evidence, not proof that a model completed the task. Live-Pi token, latency, and model-Turn budgets fail closed; Provider cost remains explicitly `unpriced` when the configured catalog supplies no price rather than being presented as free. The release verifier independently recomputes rankings, correlated task outcomes, model-driven Tool receipts, usage, costs, and threshold promotion decisions; it rejects missing, failed, expired, fallback-backed, implementation-mismatched, incorrectly ordered, causally detached, or over-budget evidence.

## Memory and durable work

BeeMax separates chat history from durable organizational evidence.

- Conversation candidates stay pending until reviewed or promoted.
- Explicit, low-risk personal preferences may additionally be admitted by the governed L4 extractor when `adaptive_learning` is enabled; broader organizational knowledge still requires type-specific authority.
- Claims retain source evidence, validity, visibility, scope, correction, and conflict lineage.
- Verified Objective outcomes may publish idempotent Situation-backed Episodes.
- Recall is constrained by Profile, owner, conversation, thread, access scope, and business-object evidence when available.
- Unknown customer vocabulary remains open semantics; it is not mapped into a fixed order, ticket, or contract schema.

Useful Memory commands:

```bash
beemax memory status --profile personal
beemax memory candidates --profile personal
beemax memory claims --profile personal
beemax memory explain <memory-id> --profile personal
beemax memory promote <candidate-id> --profile personal --yes
beemax memory reject <candidate-id> --profile personal --yes
```

Responsible work becomes an Objective with durable Tasks. Safe work may resume after a crash only when recovery policy, idempotency identity, execution scope, and unresolved Effect state all permit it.

In chat, inspect work without asking the model to reconstruct it:

```text
/status
/tasks plans
/tasks show <plan-id>
/tasks verify <plan-id>
/tasks retry <plan-id>
/tasks cancel <plan-id>
```

Verification unavailable retries Verification against the retained Candidate Result; it does not replay Task execution. Explicit rejection may start one bounded Corrective Attempt only when safe-retry authority is complete.

## Governed actions and Effects

Every action is evaluated independently from its target, risk, reversibility, enterprise policy, current Effect state, approval, and execution grant.

Mutating tools require approval unless a trusted, scoped policy permits the specific action. High-risk or irreversible work cannot become autonomous merely because a broad policy says “allow.”

External mutation follows a durable lifecycle:

```text
planned → executing → committed | failed | unknown
```

A committed mutation is never replayed. An `unknown` outcome blocks retry until an operator observes the external system and reconciles it.

```bash
beemax effect list --status unknown --profile personal
beemax effect reconcile <effect-id> --status committed \
  --operation <observed-operation> --external-ref <reference> \
  --profile personal
beemax effect reconcile <effect-id> --status failed --profile personal
```

Runtime recovery procedures are documented in the [fault recovery runbook](docs/operations/fault-recovery.md).

## Context management

BeeMax has one context pipeline and one compactor.

Core assembles bounded Situation, scoped Memory evidence, capability context, and durable Task state. Pi owns the live session, threshold/overflow detection, summaries, and manual compaction.

```yaml
context:
  maxTurnChars: 12000
  maxToolResultTokens: 12000
  compaction:
    enabled: true
    # reserveTokens: 19200
    # keepRecentTokens: 20480
```

Defaults scale from the active model's context window. `/usage` shows effective budgets, and `/compact` requests compaction while the session is idle.

After compaction, BeeMax checks durable responsibility identities. Missing Tasks are restored from the authoritative Task Ledger and persisted into Pi's session transcript rather than guessed from the summary.

## Initiative and automation

BeeMax can observe durable Triggers and propose or execute bounded proactive work. Autonomy is separated into evidence-gated levels instead of one global switch.

```bash
beemax autonomy status --profile personal
beemax autonomy promote situation_context --profile personal --yes
beemax autonomy stop read_only_investigation \
  --evidence-ref incident:2026-07-14 --profile personal --yes
beemax autonomy rollback initiative_observation \
  --evidence-ref review:2026-07-14 --profile personal --yes
```

Promotion requires measured quality, safety, expected value, duplication, and interruption evidence. Enterprise deny always wins; enterprise allow cannot bypass failed evidence.

Schedules, reminders, and Heartbeat are durable and Profile-scoped. Heartbeat is single-flight, defers while the Agent is busy, respects active hours, and suppresses `HEARTBEAT_OK`.

```text
schedule_create   schedule_get      schedule_list
schedule_update   schedule_pause    schedule_resume
schedule_run_now  schedule_delete   schedule_runs
schedule_status
```

Unattended scheduled Agent runs use bounded, isolated execution. Each due time materializes one durable Schedule Occurrence linked to the Pi-created Objective and Task Run. Renewable fenced claims prevent stale instances from settling the same occurrence; finite retry and explicit misfire policy prevent unbounded catch-up.

Pi execution and channel delivery settle independently. A verified result is persisted before entering the Delivery Outbox, so a Feishu or Telegram outage retries only delivery and never replays completed Agent or Tool work. ChannelHost keeps supervising offline adapters while the Profile Runtime, scheduler, and durable work remain available.

## Images and OCR

Inbound images pass through one Profile-scoped media-understanding seam.

1. The active model receives the original image when it supports image input.
2. Other configured image-capable models can act as auxiliary vision adapters.
3. Tesseract provides local OCR fallback on Ubuntu and macOS.
4. If no adapter can inspect the image, BeeMax fails explicitly.

```yaml
mediaUnderstanding:
  auxiliaryVisionEnabled: true
  localOcr:
    enabled: true
    # command: /usr/bin/tesseract
    # languages: eng+chi_sim
    timeoutMs: 30000
```

Media output enters Pi as untrusted evidence with digest, provenance, confidence, warnings, and timing. Raw image bytes are not copied into receipts, telemetry, Task Ledger, or Memory.

## Skills, MCP, Web, and knowledge

BeeMax installs bundled Profile Skills and discovers eligible Pi Skills progressively. Only Skill metadata enters the initial prompt; the full body loads after a task matches it.

```bash
beemax skills list --profile personal
beemax skills sync --profile personal
beemax skills install pi-web-access --profile personal
```

MCP supports stdio and Streamable HTTP servers. Use `${ENV_VAR}` references for secrets. Tools without an explicit read-only annotation are governed as mutations.

```bash
beemax mcp status --profile personal
```

Web research supports provider-backed search plus SSRF-guarded extraction. WeKnora integration exposes only explicitly configured knowledge spaces through the read-only `knowledge_retrieve` tool.

```yaml
knowledge:
  enabled: true
  provider: weknora
  baseUrl: http://127.0.0.1:8080
  spaces:
    - id: company
      name: Company Knowledge
      knowledgeBaseId: kb-xxxxxxxx
```

Store `BEEMAX_WEKNORA_API_KEY` in the Profile `.env`.

## Messaging Gateway

One Profile Gateway hosts all enabled channel adapters while using exactly one shared Profile Runtime. `AdapterRegistry` creates transports, `ChannelHost` isolates lifecycle failures, and `GatewayDeliveryPort` routes outbound artifacts by platform. Channel adapters normalize identity, messages and media; they do not own Tasks, Memory, Policy, Effects, Verification, recovery, or a second Pi loop.

Non-secret declarations live under `gateway.channels[]`; each entry has an adapter ID, instance ID, enabled state, `credentialRef`, and adapter settings. Built-in channel Secrets remain in the owner-only Profile `.env` and are resolved at the trusted Adapter/diagnostic boundary by `profile-env:<adapter>`. They do not enter YAML, ordinary `BeeMaxConfig`, logs, Memory, or model context; rotating the Profile Secret source does not require rebuilding the ordinary configuration object.

```yaml
gateway:
  channels:
    - id: feishu-main
      adapter: feishu
      enabled: true
      credentialRef: profile-env:feishu
      settings: {}
    - id: telegram-main
      adapter: telegram
      enabled: true
      credentialRef: profile-env:telegram
      settings:
        allowedUsers: ["123456789"]
        allowedChats: []
        allowAllUsers: false
        activation:
          mode: explicit
          respondTo: [mention, reply, command]
```

Run `beemax channel list --profile personal` to inspect declarations, `beemax doctor --profile personal` to validate enabled adapters, and the standard Gateway lifecycle commands to run them together.

## Feishu and Lark

BeeMax supports self-built Feishu/Lark applications through WebSocket long connection or encrypted webhook delivery.

Required Feishu capabilities include Bot, direct-message receive, group `@mention` receive, and send-as-bot. Subscribe to `im.message.receive_v1` and publish the app before testing.

Access is deny-by-default. Configure authorized user IDs with `FEISHU_ALLOWED_USERS`; optionally restrict chats with `FEISHU_ALLOWED_CHATS`.

Unknown private-message users receive a bounded pairing code instead of reaching the Agent:

```bash
beemax pairing list --profile personal
beemax pairing approve feishu ABCD2345 --profile personal
beemax pairing revoke feishu ou_xxx --profile personal
```

Each turn renders one streaming interactive card with answer, progress, governed approval actions, bounded tool activity, and usage metadata. Only one Gateway process may own a Profile at a time.

Feishu meeting tools cover meeting queries, reservations, participants, host control, and recording lifecycle. Private user resources still require a future Feishu User OAuth layer.

## Telegram

BeeMax uses the Telegram Bot API with bounded long polling, deny-by-default user/chat allowlists, text reply and edit support, typing indicators, native image/file delivery, and bounded temporary downloads for inbound photos, documents, audio, and voice messages. Group activation uses the same transport-neutral contract as Feishu: verified mention/reply/command signals, bounded contextual follow-ups inside the same Telegram Thread, and an optional observe-only path that never becomes an Agent turn. Channels without interactive cards automatically degrade to final text while retaining the same governed Core execution.

Create a bot with BotFather, then run `beemax channel add telegram --profile personal`. The token is prompted securely or read from `TELEGRAM_BOT_TOKEN`; authorized numeric user IDs may be supplied through the prompt or `TELEGRAM_ALLOWED_USERS`.

## Deployment and operations

### Ubuntu

The first measured production resource class is Ubuntu 24.04 x64 with Node.js 22, at least 2 logical CPUs, and 6 GiB host RAM. Its systemd limits, operational high-water marks, and reproducible queue/concurrency/SQLite/RSS gate are documented in [Ubuntu resource high-water](docs/operations/ubuntu-resource-high-water.md).

Docker is BeeMax's first production Execution Sandbox for built-in command and workspace tools. Trusted local execution is not a sandbox. Configuration, enforced limits, cancellation cleanup, capability scope, and the real-Docker release gate are documented in [Docker Execution Sandbox](docs/operations/docker-execution-sandbox.md).

Run the Gateway in the foreground for the first end-to-end test:

```bash
beemax gateway run --profile personal
```

Then install a user-level systemd service:

```bash
beemax gateway install --profile personal
beemax gateway start --profile personal
beemax gateway status --profile personal
beemax gateway logs --profile personal
```

For a headless user service that must start before login, enable lingering once:

```bash
sudo loginctl enable-linger "$USER"
```

A machine-wide service is available through `beemax service install --system`; run the Agent as a dedicated non-root account and set `BEEMAX_SERVICE_USER`.

### macOS

The same lifecycle commands install and control one LaunchAgent per Profile. On WSL or containers without a supervisor, keep the Gateway in the foreground or use the host's process manager.

### Health and diagnostics

```bash
beemax doctor --profile personal
beemax status --deep --profile personal
beemax gateway health --profile personal
beemax gateway logs --profile personal --tail 200
beemax trace show <execution-id> --profile personal
```

## Security model

- Feishu/Lark and Telegram access default to deny.
- Profile secrets are isolated from YAML and protected with owner-only permissions.
- The Credential Vault stores encrypted external credentials behind scoped references.
- Shell and file tools remain inside the configured workspace and block known destructive commands and credential paths.
- Mutation receipts exclude credential material.
- MCP and external tools cannot self-certify a mutation with proof-shaped model output.
- Task, Effect, delivery, Trigger, and compensation claims use leases and stale-holder fencing.
- Queues, traces, cards, Tool output, context, and background concurrency are bounded.
- High-risk autonomy remains unavailable without explicit human authority.

See [autonomy rollout](docs/operations/autonomy-rollout.md), [performance and cost](docs/operations/performance-and-cost.md), and the [P0–P10 acceptance record](docs/operations/p0-p10-acceptance.md).

Legacy Actor-scoped group transcripts are never guessed or merged. Administrators can explicitly assign one transcript to the canonical shared Conversation with `beemax migration session plan/apply`, retain every legacy file, and use digest-guarded rollback. See [Session Ownership Migration](docs/operations/session-ownership-migration.md).

## CLI reference

| Command | Purpose |
| --- | --- |
| `beemax setup` | Configure a Profile, model, identity, Skills, and optional channel |
| `beemax chat` | Start the adaptive local terminal Agent |
| `beemax gateway` | Configure, run, install, inspect, and control channel Gateways |
| `beemax binding` | Validate, explain, atomically activate, or disable deterministic Channel-to-Profile routes |
| `beemax profile` | Create, select, migrate, back up, inspect, and delete Profiles |
| `beemax migration channel-instance` | Plan, apply, audit, and safely roll back explicit legacy route ownership |
| `beemax model` | Show or change the Profile model |
| `beemax memory` | Inspect, explain, compile, promote, reject, or forget Memory evidence |
| `beemax autonomy` | Inspect and control evidence-gated autonomy levels |
| `beemax credentials` | Manage the encrypted Profile Credential Vault |
| `beemax effect` | Inspect and reconcile unresolved Tool Effects |
| `beemax trace` | Inspect a content-free execution trace |
| `beemax doctor` | Validate runtime and integration readiness |
| `beemax update` | Install the latest verified release while preserving Profiles |

Run `beemax --help` for the complete command surface. Inside chat, use `/help` for session, model, compaction, Task, retry, cancellation, and display controls.

## Troubleshooting

### The bot receives no messages

Run `beemax gateway health --profile <name>`. Confirm the app is published, WebSocket long connection is enabled, `im.message.receive_v1` is subscribed, and the sender is allowed or paired.

### A Task did not resume after restart

Inspect `/tasks show <plan-id>`, `beemax effect list --status unknown`, and the execution trace. Unsafe or non-idempotent Tasks intentionally fail closed instead of replaying.

### A text-only model cannot read an image

Run `beemax doctor`. Configure an image-capable model, enable auxiliary vision, or ensure Tesseract and the required language data are installed.

### Context is near its limit

Use `/usage` to inspect effective budgets and `/compact` while idle. Active durable Tasks survive compaction through the Task Preservation Envelope.

### MCP is unavailable

Run `beemax mcp status --profile <name>`. Verify the server command or URL, required environment variables, startup deadline, and Profile Toolset.

## Development and verification

```bash
npm ci
npm run build
npm run typecheck
npm test
```

The full release gate adds unknown-business evaluation, committed performance profiles, heap/RSS bounds, fault evidence, architecture boundaries, and migration rehearsal:

```bash
npm run verify:release
npm run test:reliability
```

Create and verify the archive for the exact package version:

```bash
VERSION="v$(node -p "require('./package.json').version")"
bash scripts/create-release-archive.sh "$VERSION"
bash scripts/verify-release-archive.sh "$VERSION"
```

Tag, root package, every BeeMax workspace, internal dependency, and Changelog release section must match. The archive verifier checks checksum portability, source layout, isolated installation, rebuild, Profile reload, and packaged Skills.

## Repository layout

```text
apps/cli/                         CLI, Profile composition, setup, services
packages/core/                    Agent semantics and the sole Pi runtime seam
packages/memory/                  SQLite/FTS5 Memory and durable authorities
packages/channel-runtime/         Platform-neutral channel contracts and lifecycle
packages/channel-feishu/          Feishu transport and rich presentation Adapter
packages/channel-telegram/        Telegram transport Adapter
packages/gateway/                 Channel-neutral interaction orchestration and governance
packages/automation/              Schedule persistence and time calculation
packages/knowledge/               WeKnora capability adapter
packages/mcp-capability/          MCP client capability
packages/feishu-capability/       Feishu meeting capability
pi/                               Vendored Pi source and workspace packages
config/                           Configuration examples
evals/                            Runtime and performance evaluation corpus
scripts/                          Install, release, evaluation, and migration tools
docs/                             Architecture, ADRs, operations, PRD, and research
```

## Documentation

- [Unified Agent Runtime PRD](docs/prd/beemax-pi-unified-agent-runtime.md)
- [Core and Gateway boundaries](docs/architecture/core-gateway-boundaries.md)
- [Channel-neutral runtime contract](docs/architecture/channel-runtime-contract.md)
- [Fault recovery runbook](docs/operations/fault-recovery.md)
- [Autonomy rollout](docs/operations/autonomy-rollout.md)
- [Performance and cost](docs/operations/performance-and-cost.md)
- [P0–P10 acceptance](docs/operations/p0-p10-acceptance.md)
- [Changelog](CHANGELOG.md)

## Current boundaries

The current BeeMax release candidate intentionally does not include a fixed customer business ontology, a second Agent Loop, high-risk fully autonomous execution, large multi-Agent organizations, or arbitrary model-authored production Skill mutation. It does include an `adaptive_learning`-gated managed-Skill lane: only immutable, integrity-sealed versions with accepted trial identities and promotion authority can enter a bounded canary, and verified operational evidence may promote or roll that pointer back without rewriting historical versions.

Planned extension points include additional registry adapters such as Slack, Discord, DingTalk, and WeCom; Feishu User OAuth for private resources; externally backed work queues for larger horizontal deployments; and deeper enterprise policy integrations.

---

**中文简介：** 当前 BeeMax 候选版本是一个基于 Pi 的持久化智能体运行时。它通过同一个 Profile Gateway 接入飞书/Lark、Telegram 与未来渠道，通过 Situation/Work Context 理解未知业务语义，以作用域 Memory 保存证据。

Task Ledger、Effect、Checkpoint 和 Verification 共同承担可恢复责任，企业策略与审批负责约束执行边界。
