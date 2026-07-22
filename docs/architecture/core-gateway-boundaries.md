# Thruvera Agent Architecture: Core and Gateway Boundaries

## Status

Implemented architectural direction. This document is the ownership contract
for all new code and for the remaining migration away from transitional code.

## Decision

Thruvera is one Agent product. `@thruvera/core` owns Agent semantics; Gateway owns
transport semantics. The current Pi code is an implementation dependency of
Thruvera Core, not a product-level architectural layer.

Running in the same operating-system process does not transfer ownership. A
Gateway may call Core, but it must not decide whether an Agent delegates work,
generates media, recalls memory, or mutates state.

## Layer model

```text
┌──────────────────────────────────────────────────────────────┐
│ Product / Profile                                             │
│ SOUL · policy · model selection · skills · capability grants  │
├──────────────────────────────────────────────────────────────┤
│ Thruvera Core                                                   │
│ Agent runs · sessions · context · tools · tasks · media jobs  │
│ memory · automation · cancellation · policy enforcement       │
├──────────────────────────────────────────────────────────────┤
│ Capability Adapters                                           │
│ MCP · web · files · image provider · calendar · storage       │
├──────────────────────────────────────────────────────────────┤
│ Gateway                                                       │
│ enterprise channel/control plane · ingress auth · normalize · │
│ tenant/profile/session routing · idempotency · rate limiting  │
│ stream/deliver · media upload/download · health/metrics       │
├──────────────────────────────────────────────────────────────┤
│ Operations                                                    │
│ install · service manager · profiles · backup · doctor · logs │
└──────────────────────────────────────────────────────────────┘
```

## Ownership contract

| Concern | Owner | Gateway may do | Gateway must not do |
| --- | --- | --- | --- |
| Agent loop, model retry, compaction | Core | start a run and render events | select a model, mutate prompt, retry tools |
| Session and context | Core | map tenant/channel identity to a stable session key; enforce ordering/idempotency | assemble prompt, decide recall, own session policy |
| Sub-Agent | Core | deliver progress/result events | own task queue, decide toolset, execute or cancel children |
| Image/media generation | Core + capability adapter | download inbound media; upload/deliver acknowledged output media | decide to generate, hold provider credentials, run provider job |
| Skills and MCP | Core + capability adapter | expose availability status | inject instructions or decide tool authorization |
| Memory and automation | Core | route inbound trigger; deliver outbound result | select recalled facts, run cron policy, mutate memory |
| Feishu / other channels | Gateway | authenticate, tenant/profile routing, deduplicate, rate-limit, stream, reconnect, delivery retry and audit | contain agent reasoning or persistent task semantics |
| systemd, install, backup, doctor | Operations | start/observe processes | participate in one Agent turn |

## Required interfaces

Core depends on ports, never on Feishu or a concrete channel SDK.

```ts
interface AgentRuntimePort<Source> {
  run(input: AgentRunInput<Source>, events?: AgentRunEventSink): Promise<AgentRunResult>;
  cancel(source: Source): Promise<boolean>;
  handleControl(input: AgentControlInput<Source>): Promise<AgentControlResult | undefined>;
  setModel(source: Source, model: Model<Api>): Promise<boolean>;
  isBusy(): boolean;
  dispose(): void;
}

interface DeliveryPort {
  publish(event: AgentEvent): Promise<void>;
  sendText(target: DeliveryTarget, text: string): Promise<void>;
  sendMedia(target: DeliveryTarget, media: MediaArtifact): Promise<void>;
}

interface MediaOutboxPort {
  enqueueMedia(owner: ThruveraRuntimeSource, media: MediaArtifact): Promise<void>;
}

interface CapabilityPort {
  name: string;
  health(): Promise<CapabilityHealth>;
  toolsFor(scope: CapabilityScope): ToolDefinition[];
}
```

`AgentRuntimePort` owns session routing, cancellation, product-control handling,
model state changes, tool execution and run state transitions. A Gateway passes
an inbound message to this port but does not parse a model command or select a
model. Core's task manager owns child-task lineage. `DeliveryPort`
is an output port supplied by the Gateway.
Capabilities implement work behind a stable Core-owned interface. Media
providers persist artifacts through Core's neutral `MediaOutboxPort`; Gateway
workers claim those jobs and use `DeliveryPort` for channel upload and delivery
acknowledgement.

## Reference alignment

Hermes places model selection, prompt construction, tools, retries,
compression, persistence and `delegate_task` in its platform-agnostic
`AIAgent`; its messaging gateway is an entry and callback adapter. OpenClaw's
Gateway is a long-running channel/control-plane process, while subagents are
child Agent runs and channel media is transport plus capability work. Thruvera
adopts the same ownership distinction without copying either project verbatim.

## Dependency rules

1. `packages/core` may depend on runtime implementation packages and neutral
   port types; it must not import `packages/gateway` or a channel SDK.
2. `packages/gateway` is the enterprise control plane. It may own channel
   credentials, tenant/profile/session routing, ordering, idempotency, rate
   limiting, reconnect, delivery retry, audit and health; it must not define
   Agent task, model, prompt, memory, media-job or tool policy.
3. Channel adapters may not access profile secrets except credentials required
   for their own channel connection.
4. Capability adapters may not deliver directly to Feishu. They may persist a
   typed artifact through Core's neutral `MediaOutboxPort`; only Gateway workers
   upload it through `DeliveryPort`.
5. Operations may inspect runtime health but may not execute Agent tools.
6. Pi is the execution substrate behind `@thruvera/core`. Capability packages,
   Gateway and non-TUI application code consume Pi Agent/AI/Tool types only
   through Core. The CLI presenter may depend directly on `pi-tui`, but it may
   not own Agent execution.
7. Before adding an Agent primitive, perform a Pi Capability Check: inspect Pi's
   Agent, session, Tool, Skill, Provider, Images and event registries; reuse an
   existing extension point when present, extend Pi for a generally reusable
   primitive, and add Thruvera code only for product governance or durable state.

## Migration plan

1. **Completed:** establish `@thruvera/core` as the runtime seam; move session
   creation, model/auth, resource loading, skill filtering, security hooks and
   session identity/locking/lifecycle.
2. **Completed:** move `SubagentManager` and task tools to Core. Child runs
   use the same `ThruveraAgentRuntime` path as interactive turns; concrete image
   provider OAuth/HTTP code lives in a separate capability package.
3. **Completed:** move curated-memory context and candidate capture to Core;
   migrate scheduler orchestration, Pi execution and heartbeat policy to Core.
   Automation retains time calculation plus the atomic SQLite state machine for
   configured Schedule, Occurrence, lease, retry and Delivery transitions; it
   never decides Agent capability, Verification or business policy.
4. **Completed:** introduce `ThruveraAgentRuntime` as the one run entry point.
   It owns turn timeout, streaming subscription, context capture and resource
   reload; CLI, sub-agents and Gateway all use this path. Dispatcher accepts
   the `AgentRuntimePort` rather than composing sessions itself.
5. **Completed:** formalize Core's typed `DeliveryPort`; Gateway implements it
   for channel text and media. Generated media enters a durable SQLite outbox;
   Gateway delivery confirms it or retries with bounded exponential backoff.
6. **Completed:** extract Memory, Automation, Web, Skills, MCP and Feishu
   meeting capabilities from Gateway. The Agent composition factory now lives
   in the CLI application layer; Gateway retains only channel SDK transport
   and control-plane responsibilities.
7. **Completed:** add architecture-boundary tests that prevent Core from
   importing Gateway/channel SDKs and prevent Gateway from re-absorbing Agent
   capability composition.
8. **Completed:** enforce Pi as a Core-private execution substrate for
   capabilities and Gateway; allow only the CLI presenter to consume Pi TUI.
9. **Completed:** durable Task Plan Execution Claims now fence concurrent
   recovery across Agent instances, and a Core recovery service continuously
   reconciles expired Task Runs without overlapping recovery cycles. The same
   service automatically retries unavailable Verification with durable bounded
   backoff while retaining Candidate Results and never replaying execution. An
   explicit rejection may schedule a feedback-aware Corrective Attempt only for
   safe, idempotent, scoped Tasks and only within the durable correction budget.
   Settled background outcomes create result-free Completion Notices in a durable,
   holder-fenced Outbox; CLI and Gateway delivery workers acknowledge or retry them
   without coupling Core to a channel SDK. Tag
   releases require build, typecheck, tests, production dependency audit,
   archive checksum/layout validation and an isolated installation smoke test.
   An external queue adapter remains optional future work for horizontally
   scaled enterprise deployments.

## Acceptance criteria

- A second channel can be added without changing Agent, task, memory or media
  job policy.
- A local CLI run and a Feishu run invoke the same `AgentRuntime.run` path.
- Sub-Agent cancellation works when the originating channel is disconnected.
- An image job can complete even if delivery is retried later.
- Core tests run with a fake `DeliveryPort` and no Feishu SDK.
- Gateway tests run with a fake `AgentRuntime` and no model provider.
