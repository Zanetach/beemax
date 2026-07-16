# Define the open-world Capability and Outcome contracts

Label: `wayfinder:resolved`

## Question

What minimal, domain-agnostic contracts must represent atomic outcome requirements, Capability candidates, provider implementations, observations, effects, artifacts, evidence, and verification so unknown future tasks can be admitted and completed without adding business-specific concepts to Core?

## Resolution

Implemented `beemax.open-world-contract.v1` as an immutable graph compiled only from a model-origin Work Contract Build Result carrying valid independent semantic-adjudication evidence. Deterministic compatibility contracts cannot enter this graph, including when they declare no Capability Requirement. Every Acceptance Criterion and Capability Requirement must be bound exactly once; every declared Artifact and Evidence requirement must be referenced by an outcome. The graph uses domain-neutral operations, MIME media types, verification dimensions, and evidence kinds.

Existing Capability Descriptor/Candidate, Provider Descriptor/Resolution, Effect Authority, Artifact receipt, Task Criterion Verification, and Delivery receipt types remain their canonical authorities. The new graph carries only requirements and opaque references; it cannot install a Provider, expose a Credential Secret, grant Tool authority, settle an Effect, attest evidence, verify an outcome, or authorize delivery.

Implementation: `packages/core/src/open-world-contract.ts`. Public behavior: `packages/core/test/open-world-contract.test.mjs`.
