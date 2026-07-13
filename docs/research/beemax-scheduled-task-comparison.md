# BeeMax Scheduled Tasks: Codex, Hermes Agent, and OpenClaw Comparison

Research date: 2026-07-14. External claims below use first-party product documentation or official repositories.

## Executive conclusion

BeeMax already has a real durable scheduled-task subsystem, not a prompt-only reminder feature. It persists one-shot, interval, and cron schedules in SQLite; supports IANA timezones; fences concurrent workers with renewable leases; records bounded run history; retries failures; runs scheduled Agent work through the shared Profile Runtime; and delivers results through the channel-neutral Delivery Port.

Its strongest differentiator is semantic integration: a responsible scheduled Agent occurrence becomes the same durable Objective / Task Run / Checkpoint / Verification lifecycle used by interactive Pi work. The follow-up implementation now gives each nominal due time a durable Occurrence, binds Pi identity before execution settles, delivers only accepted Verification outcomes, retains bounded one-shot/misfire/dead-letter evidence, bounds retry attempts, exposes skip/run-once misfire policy, separates verified execution from durable delivery retry, preserves cadence after manual runs, and adds get/update/run-now/status management. Remaining breadth gaps are per-job delivery/failure destinations, bounded catch-up, model/Skill/workdir policy, and governed non-LLM actions.

## BeeMax current implementation

- `AutomationStore` persists jobs, delivery ownership, next-run time, retry state, claims, and run history in the Profile SQLite database: [`packages/automation/src/store.ts`](../../packages/automation/src/store.ts).
- Schedule forms are one-shot `at`, fixed `every`, and five/six-field `cron`; cron calculation accepts an IANA timezone.
- `AutomationScheduler` polls no slower than 30 seconds, admits up to four concurrent runs, renews 15-minute leases every minute, aborts on lease loss, and performs bounded shutdown: [`packages/core/src/automation-runtime.ts`](../../packages/core/src/automation-runtime.ts).
- Chat tools support create/get/list/update/pause/resume/run-now/delete/history/status, with approval policy on mutations: [`packages/core/src/automation-tools.ts`](../../packages/core/src/automation-tools.ts).
- Reminder and Agent outcomes enter a durable Delivery Outbox; Agent runs use a ten-minute Execution Envelope and the shared Profile Runtime: [`apps/cli/src/gateway.ts`](../../apps/cli/src/gateway.ts).
- Scheduled Agent runs use a restricted read-only toolset and enter durable Pi Objective, Task Run, Checkpoint, and Verification semantics: [`packages/core/src/agent-runtime.ts`](../../packages/core/src/agent-runtime.ts), [`packages/core/test/autonomous-planning.test.mjs`](../../packages/core/test/autonomous-planning.test.mjs).
- Linux systemd and macOS LaunchAgent support keep the Gateway and scheduler resident across login/reboot deployment patterns: [`apps/cli/src/service-manager.ts`](../../apps/cli/src/service-manager.ts).

## Product comparison

| Dimension | BeeMax 1.1 | Codex Automations | Hermes Agent | OpenClaw |
|---|---|---|---|---|
| Durable local store | SQLite WAL | Product-managed; local implementation details are not public | `jobs.json` plus tick lock | Stored jobs plus per-job JSONL run logs |
| Schedule forms | at, interval, cron, timezone | Recurring schedules/triggers exposed through product UX | one-shot, interval, cron, ISO | at, interval, cron, timezone |
| Agent context | Shared scoped Profile Runtime; isolated automation thread | Can return to the same conversation context | Fresh session by default | Main-session event or isolated Agent turn |
| Execution reliability | Claim token, renewable lease, fenced completion, retry history | Public product docs do not specify lease/fencing internals | File tick lock prevents duplicate tick batches | Gateway scheduler, concurrency limit, run status/history |
| Durable work semantics | Objective + Task Run + Checkpoint + Verification | Review-oriented returned result | Fresh Agent result and delivery | Background run/session result and delivery |
| Management surface | create/get/list/update/pause/resume/run-now/delete/runs/status in chat | Chat/product automation UX | create/edit/pause/resume/run/remove/status via tool, slash command and CLI | create/get/show/edit/enable/disable/run/wait/runs/remove via CLI/API |
| Per-job controls | Prompt, kind, schedule, timezone, origin route | Prompt, schedule, thread context | Skills, profile, workdir, model/provider, toolsets, script/precheck, repeat, delivery | Agent/model, session target, context mode, delivery, command argv/cwd/env, timeouts, failure destination |
| Non-LLM scheduled work | Direct reminder delivery only | Not documented | Script-only `no_agent` mode | Command jobs |
| Resident service | systemd / LaunchAgent | Local automations work best while the app and laptop are running | Gateway user/system service | Gateway service |

## Primary-source observations

OpenAI documents Codex Automations as scheduled or triggered recurring work that can return to the same conversation and surface a result for review. It also notes that local automations work best while the laptop is awake and ChatGPT Codex is running. The public material is product-level and does not document scheduler leasing, misfire, or retry internals. [OpenAI Academy: Codex Automations](https://openai.com/academy/codex-automations/)

Hermes exposes one unified `cronjob` tool and matching slash/CLI operations. It supports fresh sessions, attached Skills, explicit delivery, work directories, profile/model/toolset overrides, pre-check scripts, script-only jobs, manual runs, and a Gateway tick protected by a file lock. [Hermes scheduled tasks](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/cron.md), [Hermes scheduler source](https://github.com/NousResearch/hermes-agent/blob/main/cron/scheduler.py)

OpenClaw supports main-session or isolated jobs, explicit delivery and failure destinations, manual run/wait, bounded run logs, isolated-session retention, per-job Agent/model selection, lightweight context, and deterministic command jobs with argv/cwd/env/stdin/output limits. [OpenClaw scheduled tasks](https://docs.openclaw.ai/automation/cron-jobs), [OpenClaw cron CLI](https://docs.openclaw.ai/cli/cron), [OpenClaw configuration reference](https://github.com/openclaw/openclaw/blob/main/docs/gateway/configuration-reference.md)

## Recommended BeeMax direction

Do not replace `AutomationStore` or create a second Agent loop. Preserve the existing `Schedule -> Trigger -> Profile Runtime -> durable Objective/Task -> Verification -> Delivery` path.

The next practical increment should add, in order:

1. Explicit delivery target and failure-notification target, resolved through ChannelHost.
2. Bounded catch-up in addition to the implemented `skip` and `run_once` misfire policies.
3. Per-job timeout, model class, Skill references, capability policy, working directory, and concurrency key.
4. Deterministic command/webhook jobs that do not invoke an LLM, still governed by Tool Effect and Receipt policy.
5. Expanded operator metrics and dead-letter control beyond the implemented status snapshot.
6. Internally split the `AutomationStore` facade into migration, occurrence and delivery repositories when those areas next change; retain one public store and one database.

This borrows Hermes/OpenClaw's management strengths while keeping BeeMax's stronger SQLite fencing and Pi/Task/Verification integration.
