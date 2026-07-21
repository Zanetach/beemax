# Make ordinary interactive execution model-first

Label: `wayfinder:resolved`

## Question

How should BeeMax accept a natural-language task, let the main Pi model understand and adapt it, progressively load Tools and Skills, recover inside the model–Tool loop, and deliver text or files without forcing every complex turn through a separate durable Work Contract cognition pass?

## Implemented

`BeeMaxAgentRuntime` now defaults interactive turns to `model_first`. A new request with no explicit durable binding reaches the main Pi model directly whether it is simple, unfamiliar, research-oriented, multi-step, or artifact-producing. `AutonomousPlanningPolicy` still supplies a bounded execution posture and exposes planning Tools when the task warrants them; Pi performs the actual Tool calls and can continue after Capability discovery, Provider recovery, Skill activation, read rerouting, model fallback, output-limit recovery, or Verification correction.

Progressive Tool Spec plans remain immutable per transition. Capability discovery may activate only installed and policy-eligible Tools; selected Skills still require immutable version evidence plus their complete read/activate/route/resource/complete lifecycle. Tool calls remain bound to the exact Provider response and argument digest. Sandbox, Access Scope, Enterprise Policy, Effect authority, unknown-mutation reconciliation, Artifact verification, execution tracing, caller cancellation, and explicit deadlines remain enforced; Tool calls do not enter an interactive approval round trip.

Complexity alone no longer creates a durable Objective. The Contract lane remains mandatory for a fresh Automation Trigger, an explicitly bound Objective, and continuation/correction/cancellation that actually targets an active Objective. Those paths retain authenticated Contract admission, durable Task Runs, checkpoints, independent Candidate Verification, correction, recovery, and delivery settlement. `contract_first` exists only as an explicit migration/testing compatibility option; CLI and Gateway composition explicitly select `model_first`.

An unrelated request no longer inherits the only active Objective merely because one exists in the same responsibility scope. Turn-local rewriting language such as “把这段改成……” is likewise handled by the main model unless the request is bound to an active durable Objective.

Implementation: `packages/core/src/agent-runtime.ts`, `apps/cli/src/cli.ts`, and `apps/cli/src/gateway.ts`.

Public behavior: `packages/core/test/model-first-turn.test.mjs` covers model-first admission and the adaptive model–Tool loop; `apps/cli/test/artifact-composition.test.mjs` separately creates and independently verifies real HTML/PDF files with the local Chrome Provider. Durable control remains covered by `packages/core/test/contract-driven-planning.test.mjs`. Provider-backed behavior is covered by the real-model Adaptive Turn Admission gate and the 16-case live Pi model-first Capability gate, whose independent guard requires the full read/activate/route/resource/complete Skill lifecycle.

## Resolution boundary

This changes task admission and persistence, not execution authority. A turn-local model answer is still only `answered`; it cannot claim durable `accepted` business completion. Background work and explicit Objectives continue to require the durable Contract and independent Verification path.
