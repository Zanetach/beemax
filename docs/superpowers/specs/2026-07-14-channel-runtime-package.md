# Channel Runtime Package and Real Channel Instance Contract

## Problem Statement

Thruvera already has two messaging Adapters and a registry, but the platform-neutral Channel Runtime, the Interaction Gateway, Feishu, Telegram, and Feishu presentation are published from one package. Production factories largely ignore each Channel Instance's own settings and instead read Profile-level Feishu or Telegram singletons, so the apparent multi-instance seam does not reliably provide independent accounts. Adding or removing a platform also changes the generic Gateway dependency graph and tests can remain green without crossing the documented Channel Runtime Contract.

## Solution

Make Channel Runtime a deep platform-neutral module, make Feishu and Telegram independently buildable Adapter modules, and compose them only in the CLI application root. Each enabled Channel Instance must be normalized and validated by its Adapter using that instance's Credential Ref and settings. The Interaction Gateway consumes normalized messages and presentation capabilities without importing platform SDKs or enumerating platforms. A contract harness crosses the real external seam from fake Adapter ingress through Gateway dispatch and delivery.

## User Stories

1. As a Profile administrator, I want two Feishu Channel Instances to use different credentials and settings, so that one Profile can operate independent bots without configuration bleed.
2. As a Profile administrator, I want two Telegram Channel Instances to remain independent, so that reconnecting or pausing one does not alter the other.
3. As an operator, I want an invalid Channel Instance to fail before connection, so that configuration mistakes cannot silently select a Profile-level fallback.
4. As an operator, I want Credential Secrets to remain outside persisted settings, so that package separation does not weaken credential handling.
5. As an integrator, I want to add a messaging Adapter without modifying Core or the Interaction Gateway, so that platform growth does not create hard-coded branches.
6. As an integrator, I want one stable Channel Runtime interface for lifecycle, ingress, observation, delivery, media, typing, and supported presentation capabilities, so that platform differences stay inside Adapters.
7. As an integrator, I want optional platform capabilities to degrade inside the Adapter or presenter, so that generic Gateway logic does not know Feishu CardKit or another provider's limits.
8. As a maintainer, I want the Channel Runtime package to build without Feishu or Telegram SDKs, so that generic changes have a small dependency and supply-chain surface.
9. As a maintainer, I want deleting the Feishu Adapter package to leave Channel Runtime, Gateway, and Telegram buildable, so that package structure matches the real seam.
10. As a maintainer, I want deleting Telegram to leave Channel Runtime, Gateway, and Feishu buildable, so that platform release cycles are independent.
11. As a Gateway developer, I want normalized ingress to retain Channel Instance, Conversation, Thread, Actor, media, trust, and cleanup semantics, so that package movement cannot change Agent behavior.
12. As a Gateway developer, I want delivery to resolve a concrete Channel Instance whenever a platform is ambiguous, so that outbound results never choose an arbitrary bot.
13. As a Gateway developer, I want Profile Binding and ingress capacity to remain in the Interaction Gateway, so that a transport Adapter cannot choose Profile or bypass admission.
14. As a Runtime developer, I want the Channel Runtime to own no Task, Memory, Policy, Effect, Verification, or Pi state, so that there remains one intelligent execution chain.
15. As a user, I want Task, Effect, Verification, cancellation, recovery, and Memory behavior to remain equivalent across CLI, Feishu, Telegram, and future channels, so that transport choice changes presentation only.
16. As a user, I want rich cards where supported and faithful text fallback elsewhere, so that a missing native presentation capability never loses the answer.
17. As a security reviewer, I want raw platform payloads and media cleanup to remain bounded to the active Interaction, so that Adapter separation does not create new persistence paths.
18. As a release reviewer, I want platform Adapter conformance and end-to-end Channel Runtime contract gates, so that a direct Core test cannot falsely prove channel equivalence.
19. As an Ubuntu operator, I want every new package included in install, build, typecheck, and release workflows, so that the source layout matches the deployed artifact.
20. As an existing user, I want legacy single-instance Profile configuration to migrate compatibly, so that upgrading does not discard current Feishu or Telegram connectivity.

## Implementation Decisions

- Introduce one platform-neutral Channel Runtime package containing normalized ingress types, the Platform Adapter interface, Adapter Registry, Channel Host lifecycle, and transport-neutral group admission and response-governor behavior.
- Keep the Interaction Gateway as the owner of Profile Binding, ingress capacity, dispatch into the shared Profile Runtime, governed delivery, Profile health projection, deduplication, and Interaction presentation orchestration.
- Move Feishu implementation, settings validation, retry, smoke checks, platform SDK dependency, and platform-specific presentation artifacts into a Feishu Adapter package.
- Move Telegram implementation and settings validation into a Telegram Adapter package with no dependency on Feishu.
- Platform Adapter packages depend on Channel Runtime; Channel Runtime never depends on Gateway or a platform package; Gateway depends on Channel Runtime but never on a platform SDK.
- The application composition root explicitly installs available Adapter registrations. Registration is the only place that knows the set of shipped platforms.
- A Channel Instance is the configuration authority. Adapter creation must consume the instance's settings and Credential Ref; Profile-level platform blocks are legacy input projections only and cannot override explicit instance values.
- Legacy configuration is normalized once into Channel Instance declarations before runtime composition. There is no dual runtime truth.
- Platform settings are opaque to Gateway after Adapter-owned validation. Unknown fields, invalid enums, missing Credential Refs, and settings that cannot be resolved fail closed with the instance id in the error.
- Credential Refs remain opaque in persisted configuration. Secret resolution occurs only in the trusted application composition and the secret value is passed directly to the Adapter factory without entering messages, logs, or status snapshots.
- Channel Host status and errors remain content-free and identify Profile, Channel Instance, Adapter id, lifecycle state, attempts, and bounded failure reason.
- Rich presentation must be expressed through a channel-neutral presentation intent or an Adapter-owned presenter. Generic Gateway code must not construct Feishu CardKit payloads or encode Feishu rate limits.
- Text delivery is the mandatory fallback. Media, cards, edits, typing, and interactive actions are declared capabilities rather than an unordered collection of optional assumptions.
- Existing Session identity, Responsibility Identity, Profile Binding priority, Group Admission, Active Conversation Lane, Governed Delivery, durable Outbox, and Channel Instance migration semantics remain unchanged.
- Package movement is a replacement, not a compatibility layer: production imports migrate to the owning package and the generic Gateway barrel stops re-exporting platform implementations.
- The package graph and architecture evaluator must reject platform SDK imports from Channel Runtime or Gateway, reverse dependencies from Channel Runtime into Gateway/platform packages, and platform implementation exports from the generic Gateway package.

## Testing Decisions

- The primary test surface is the Channel Runtime external interface: a conforming fake Adapter emits normalized ingress, connects through Channel Host and Gateway dispatch, and captures delivery.
- Contract tests assert concrete Channel Instance routing, Profile Binding fail-closed behavior, ingress capacity, cancellation, Runtime execution, delivery, and cleanup through the same seam used by production Adapters.
- Run the same Adapter conformance suite for Feishu and Telegram factories: settings validation, Credential Ref requirements, normalized identity, bounded media, lifecycle, send result, and disconnect cleanup.
- Add a two-instance test for each shipped platform proving distinct settings/credentials and independent lifecycle state.
- Add package-graph architecture assertions proving Channel Runtime and Gateway contain no platform SDK imports or platform implementation exports.
- Preserve current Gateway, Profile Runtime equivalence, security, migration, reliability, resource, and Docker Sandbox gates.
- Tests assert observable behavior and package ownership through public interfaces; they do not import private implementation files or snapshot source layout alone.
- The full build, typecheck, test, architecture, acceptance, and Ubuntu release workflows include all new packages.

## Out of Scope

- Choosing whether DingTalk, WeCom, Slack, Discord, WhatsApp, or a WeChat ecosystem Adapter ships first.
- Implementing unofficial personal-WeChat protocols.
- Shared Channel Relay and cross-Profile Delegation.
- A Web administration console.
- A second Agent loop, Task store, Memory store, or platform-specific Profile Runtime.
- Automatically generating enterprise Policy or customer business rules.

## Further Notes

This slice establishes the package and runtime seam required by future platforms; it does not claim that every platform has been implemented. The default deployment remains one Profile process with multiple independently supervised Channel Instances. Package isolation is not tenant isolation, and Channel Runtime is not an Execution Sandbox.

## Implementation Status

- Implemented `@thruvera/channel-runtime`, `@thruvera/channel-feishu`, and `@thruvera/channel-telegram` as independently buildable packages.
- Made explicit Channel Instance settings and Credential Refs authoritative, including independent same-platform instances.
- Moved Feishu CardKit rendering, state, throttling, degradation, and interactive binding behind `InteractionPresenter`; Gateway now supplies only a platform-neutral text fallback.
- Added package-graph architecture gates and a real `ChannelHost → Dispatcher → Runtime → Delivery` contract test covering concrete instance routing and cancellation.
- Added a shared Feishu/Telegram registration/lifecycle conformance harness and isolated deletion scenarios that physically omit either platform package before building Channel Runtime, Gateway, and the remaining Adapter.
- Post-review closure on 2026-07-14 removed long-lived Channel Secrets from ordinary config and Adapter settings, aligned Telegram group Activation/observation with the common contract, and passed full build, typecheck, the 796-test suite, architecture schema v5, and both deletion-build scenarios.
