# BeeMax Agent Architecture: Core and Gateway Boundaries

## Status

Implemented architectural direction. This document is the ownership contract
for all new code and for the remaining migration away from transitional code.

## Decision

BeeMax is one Agent product. `@beemax/core` owns Agent semantics; Gateway owns
transport semantics. The current Pi code is an implementation dependency of
BeeMax Core, not a product-level architectural layer.

Running in the same operating-system process does not transfer ownership. A
Gateway may call Core, but it must not decide whether an Agent delegates work,
generates media, recalls memory, or mutates state.

## Layer model

```text
┌──────────────────────────────────────────────────────────────┐
│ Product / Profile                                             │
│ SOUL · policy · model selection · skills · capability grants  │
├──────────────────────────────────────────────────────────────┤
│ BeeMax Core                                                   │
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
| Image/media generation | Core + capability adapter | download inbound media; upload/deliver output media | decide to generate, hold provider credentials, run provider job |
| Skills and MCP | Core + capability adapter | expose availability status | inject instructions or decide tool authorization |
| Memory and automation | Core | route inbound trigger; deliver outbound result | select recalled facts, run cron policy, mutate memory |
| Feishu / other channels | Gateway | authenticate, tenant/profile routing, deduplicate, rate-limit, stream, reconnect, delivery retry and audit | contain agent reasoning or persistent task semantics |
| systemd, install, backup, doctor | Operations | start/observe processes | participate in one Agent turn |

## Required interfaces

Core depends on ports, never on Feishu or a concrete channel SDK.

```ts
interface AgentRuntime {
  run(input: AgentInput, events: RunEventSink): Promise<RunResult>;
  cancel(runId: string): Promise<void>;
  spawnTask(parentRunId: string, request: TaskRequest): Promise<TaskHandle>;
  getTask(taskId: string): Promise<TaskSnapshot>;
}

interface DeliveryPort {
  publish(event: AgentEvent): Promise<void>;
  sendText(target: DeliveryTarget, text: string): Promise<void>;
  sendMedia(target: DeliveryTarget, media: MediaArtifact): Promise<void>;
}

interface CapabilityPort {
  name: string;
  health(): Promise<CapabilityHealth>;
  toolsFor(scope: CapabilityScope): ToolDefinition[];
}
```

`AgentRuntime` owns run IDs, cancellation, task lineage, tool execution and
state transitions. `DeliveryPort` is an output port supplied by the Gateway.
Capabilities implement work behind a stable Core-owned interface.

## Reference alignment

Hermes places model selection, prompt construction, tools, retries,
compression, persistence and `delegate_task` in its platform-agnostic
`AIAgent`; its messaging gateway is an entry and callback adapter. OpenClaw's
Gateway is a long-running channel/control-plane process, while subagents are
child Agent runs and channel media is transport plus capability work. BeeMax
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
4. Capability adapters may not deliver directly to Feishu; they return typed
   results to Core, which emits events through `DeliveryPort`.
5. Operations may inspect runtime health but may not execute Agent tools.

## Migration plan

1. **Completed:** establish `@beemax/core` as the runtime seam; move session
   creation, model/auth, resource loading, skill filtering, security hooks and
   session identity/locking/lifecycle.
2. **Completed:** move `SubagentManager`, task tools and image-job policy from
   Gateway to Core. Feishu upload/send is injected as a delivery callback.
3. **Completed:** move curated-memory context and candidate capture to Core;
   migrate scheduler and heartbeat policy to Core while Automation retains its
   SQLite store and time calculation capability.
4. **Completed:** introduce `BeeMaxAgentRuntime` as the one run entry point.
   It owns turn timeout, streaming subscription, context capture and resource
   reload; Dispatcher only maps ingress and presents events as channel cards.
5. **Completed:** formalize Core's typed `DeliveryPort`; Gateway implements it
   for channel text and media. Image jobs, heartbeats and scheduled delivery
   no longer retain direct Feishu callbacks.
6. **Completed:** extract Memory, Automation, Web, Skills, MCP and Feishu
   meeting capabilities from Gateway. The Agent composition factory now lives
   in the CLI application layer; Gateway retains only channel SDK transport
   and control-plane responsibilities.
7. **Completed:** add architecture-boundary tests that prevent Core from
   importing Gateway/channel SDKs and prevent Gateway from re-absorbing Agent
   capability composition.
8. **Next:** perform a release audit/package verification and add durable
   idempotency/queue adapters for multi-instance enterprise deployments.

## Acceptance criteria

- A second channel can be added without changing Agent, task, memory or media
  job policy.
- A local CLI run and a Feishu run invoke the same `AgentRuntime.run` path.
- Sub-Agent cancellation works when the originating channel is disconnected.
- An image job can complete even if delivery is retried later.
- Core tests run with a fake `DeliveryPort` and no Feishu SDK.
- Gateway tests run with a fake `AgentRuntime` and no model provider.
