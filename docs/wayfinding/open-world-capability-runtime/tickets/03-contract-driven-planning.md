# Plan from the admitted Work Contract rather than raw prompt heuristics

Label: `wayfinder:resolved`

## Question

How should BeeMax derive direct, delegated, and DAG execution; budgets; parallelism; correction allowance; and verification depth from the admitted atomic Work Contract outcomes, uncertainties, evidence requirements, and artifact types instead of deciding only from raw-prompt regex signals before semantic admission?

## Implemented

`AutonomousPlanningPolicy` now accepts either a runtime-admitted model Work Contract handoff or a factory-admitted Open-World Contract. Bare Work Contracts, copied adjudication-result objects, schema-only Open-World objects, and structural clones are rejected at the public planning boundary. A model-origin Work Contract reaches the real Agent Runtime planning boundary only after independent semantic adjudication and validation; deterministic compatibility paths retain the legacy prompt policy without being represented as semantic contract planning. The same admission-to-planning handoff is active for interactive Turns and fresh Automation Triggers.

For a Work Contract, planning derives outcome and Capability coverage, bounded effort, correction allowance, and criterion-level Verification from its admitted clauses. For an Open-World Contract, it additionally derives research demand, Artifact/Evidence-driven Verification depth, and maximum parallel width from an explicit acyclic outcome dependency graph. Raw words such as “parallel” cannot create a DAG when the admitted contract contains only one atomic outcome. `act` and `deliver` operations remain direct because Sub-Agents do not receive parent Effect authority.

The admitted `executionMode` is an authority ceiling: `direct` cannot be escalated to delegation, and `delegate` cannot be escalated to a DAG. An admitted prohibition against delegation, or a parent-only execution constraint, also forces direct execution. The derived correction allowance is copied into the Objective's Execution Envelope and therefore bounds the actual Verification correction loop.

Planning events now expose the semantic basis, verification depth, a SHA-256 projection of contract identity, and requirement counts without copying business content into telemetry. Outcome dependencies are immutable, reference-validated, and cycle-checked in `beemax.open-world-contract.v1`.

The default CLI and Gateway composition now install `PiOpenWorldContractCompiler`. It uses a primary model proposal and a separate reviewer, reserves both cognition lanes before Provider execution, shares the enclosing Execution Envelope token budget with Work Contract cognition, preserves criterion/Capability bindings by Core-issued index, and fails closed unless the reviewed graph passes the Open-World factory invariants.

Model admissions are projected into a bounded durable receipt containing the Work Contract digest, semantic adjudication evidence, cognition charge, signed validity window, complete Objective identity/revision-chain digest, and—when present—the reviewed Open-World graph snapshot and digest. The receipt is authenticated with a Profile-domain-separated HMAC key held outside Task storage; creation and restoration remain Core-internal, so public callers cannot mint a process-local planning brand. `MemoryStore` migrates and persists the receipt with the Objective, clears stale authority when an older correction writer omits a replacement receipt, and converges concurrent additive migrations.

A restarted Runtime verifies the HMAC before trusting digests or time fields, then revalidates the exact latest semantic Work Contract, the original Objective Contract and every ordered correction, TTL, strict bounded receipt shapes, adjudication evidence, graph references, and factory invariants before minting fresh process-local planning brands. Coordinated content rehashing, graph rehashing, expiry extension, cross-Profile replay, and earlier-revision rewriting all stop before Pi. Recognized pre-authentication v1 receipts are retired during migration rather than trusted or upgraded; their Objectives remain on the no-receipt compatibility path. Legacy Objectives without receipts are not represented as restored semantic planning, and a production Runtime without its Profile integrity authority fails closed before persisting model-admitted work.

Implementation: `packages/core/src/autonomous-planning.ts`, `packages/core/src/agent-runtime.ts`, `packages/core/src/open-world-contract.ts`, `packages/core/src/open-world-contract-compiler.ts`, `packages/core/src/contract-admission-receipt.ts`, and `packages/memory/src/store.ts`.

Public behavior: `packages/core/test/contract-driven-planning.test.mjs`, `packages/core/test/open-world-contract-compiler.test.mjs`, `packages/core/test/contract-admission-receipt.test.mjs`, and `packages/memory/test/store.test.mjs`.

## Resolution boundary

This resolves contract-derived planning and durable re-admission. It does not by itself prove that a particular business task can acquire every required Tool or produce and independently render-verify every requested Artifact. Those obligations remain in the progressive Tool/Skill, Capability Gap Resolver, Provider catalog, Artifact Verification, goal Verification, and real end-to-end evaluation tickets.
