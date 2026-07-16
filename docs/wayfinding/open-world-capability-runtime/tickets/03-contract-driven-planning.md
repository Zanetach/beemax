# Plan from the admitted Work Contract rather than raw prompt heuristics

Label: `wayfinder:in-progress`

## Question

How should BeeMax derive direct, delegated, and DAG execution; budgets; parallelism; correction allowance; and verification depth from the admitted atomic Work Contract outcomes, uncertainties, evidence requirements, and artifact types instead of deciding only from raw-prompt regex signals before semantic admission?

## Implemented

`AutonomousPlanningPolicy` now accepts either a Work Contract or an Open-World Contract. A model-origin Work Contract reaches the real Agent Runtime planning boundary only after independent semantic adjudication and validation; deterministic compatibility paths retain the legacy prompt policy without being represented as semantic contract planning.

For a Work Contract, planning derives outcome and Capability coverage, bounded effort, correction allowance, and criterion-level Verification from its admitted clauses. For an Open-World Contract, it additionally derives research demand, Artifact/Evidence-driven Verification depth, and maximum parallel width from an explicit acyclic outcome dependency graph. Raw words such as “parallel” cannot create a DAG when the admitted contract contains only one atomic outcome. `act` and `deliver` operations remain direct because Sub-Agents do not receive parent Effect authority.

Planning events now expose the semantic basis, verification depth, contract identity, and requirement counts without copying business content into telemetry. Outcome dependencies are immutable, reference-validated, and cycle-checked in `beemax.open-world-contract.v1`.

Implementation: `packages/core/src/autonomous-planning.ts`, `packages/core/src/agent-runtime.ts`, and `packages/core/src/open-world-contract.ts`. Public behavior: `packages/core/test/contract-driven-planning.test.mjs`.

## Remaining before resolution

The default Agent Runtime still receives only the admitted Work Contract from `PiWorkContractBuilder`. A separately reviewed model compiler must produce the richer Open-World Contract during admission before Artifact/Evidence-derived verification depth and explicit outcome-graph DAG selection are active end to end. That compiler must share the cognition budget, preserve exact Work Contract bindings, and fail closed on invalid or incomplete graph output.
