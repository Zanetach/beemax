# Define unattended authority, credential, and risk boundaries

Label: `wayfinder:resolved`

## Question

Which actions may BeeMax execute unattended under standing Profile authority, which require a scoped execution grant, and which must remain blocked because credentials, legal authority, irreversible risk, or material intent are absent? Define the decision inputs, durable evidence, expiry, revocation, and failure behavior without introducing a global “full autonomy” bypass.

## Resolution

Implemented a pure `UnattendedExecutionAdmission` preflight. A current Standing Profile Authority may cover an exact Capability and trusted Access Scope only when Tool policy is low-risk, approval-free, and either read-only or proven reversible with reliable execution. High-risk, medium-risk, approval-required, irreversible, unknown-reversibility, or degraded mutation work requires an exact scoped Execution Grant.

Both authority forms are Profile-bound, Capability-allowlisted, optionally Access-Scope-bound, evidence-backed, issued, expiring, and revocable. Materially ambiguous intent, missing legal authority, unavailable/expired/revoked Credential Refs, untrusted scope data, Enterprise deny or missing evidence, unresolved Effects, Emergency Stop, and stale or mismatched grants fail closed with exact reason codes. The decision does not invoke a Tool and cannot bypass the ordinary Tool Runtime, Enterprise Policy, Action Governance, Effect, or Verification checks.

Implementation: `packages/core/src/unattended-execution-admission.ts`. Public behavior: `packages/core/test/unattended-execution-admission.test.mjs`.
