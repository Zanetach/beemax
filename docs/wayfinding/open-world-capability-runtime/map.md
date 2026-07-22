# Build the Thruvera Open-World Autonomous Capability Runtime

Label: `wayfinder:map`

## Destination

Thruvera can take an outcome-oriented request from any supported channel, let the main model understand and adapt ordinary interactive work, progressively discover and load only the Tools and Skills needed, recover from missing capabilities without weakening the goal, and deliver guarded text or files. Durable/background responsibility is compiled into a complete Work Contract and independently verified. The destination is a versioned architecture specification, implementation sequence, and real end-to-end release gate—not a claim that every external system can be used without credentials or authority.

## Notes

- This effort carries execution into the map: every unblocked AFK ticket may be implemented without waiting for user participation.
- Use primary-source design evidence and current Thruvera code. Reference patterns from other systems, but never import their Agent runtime, product identity, prompts, or unrestricted installers.
- Preserve Thruvera's sole Pi execution loop, model-first interactive lane, source-bound durable Work Contract, Profile/Access Scope, Tool Spec authority, Effect journal, Task recovery, independent Verification, and release external-Agent boundary.
- “No user operation” means the runtime proceeds autonomously for read-only and pre-authorized reversible work. Missing credentials, absent legal authority, irreversible high-risk actions, and materially ambiguous user intent remain honest blockers; the runtime must not manufacture consent or secrets.
- Every implementation ticket requires focused tests and must keep deterministic, live-Provider, live-Pi, and real end-to-end evidence separate.

## Decisions so far

- [Open-world Capability and Outcome contracts](tickets/01-open-world-contracts.md): compile every source-bound Work Contract criterion into one immutable outcome node, reuse existing canonical Capability/Provider/Effect authorities, and require explicit Artifact and Evidence references without granting execution authority.
- [Unattended authority, credential, and risk boundaries](tickets/02-unattended-authority.md): allow only current standing Profile authority for low-risk read-only or proven-reversible work, or an exact scoped Execution Grant for stronger actions; fail closed on ambiguity, credentials, scope, legal authority, policy, Effects, Emergency Stop, expiry, or revocation.
- [Plan from the admitted Work Contract rather than raw prompt heuristics](tickets/03-contract-driven-planning.md): independently compile reviewed outcome graphs after Work Contract admission, derive execution shape and Verification from admitted contracts, persist Profile-authenticated admission receipts, and revalidate them before restored semantic planning.
- [Make ordinary interactive execution model-first](tickets/13-model-first-interactive-loop.md): send ordinary natural-language work directly to the main Pi model, retain adaptive planning and progressive Tool/Skill loading, and reserve Work Contracts plus durable Objective persistence for Automation and explicit Objective lifecycle work.

## Frontier

- [Add progressive Tool search, describe, activate, and call](tickets/04-progressive-tool-disclosure.md)
- [Add composable progressive Skill indexes, bundles, and lifecycles](tickets/05-progressive-skill-composition.md)
- [Define typed artifact contracts and modality verifiers](tickets/09-artifact-verification.md)

## Blocked tickets

- [Build the autonomous Capability Gap Resolver](tickets/06-capability-gap-resolver.md) — blocked by progressive Tool and Skill protocols.
- [Generalize the trusted Provider catalog and acquisition pipeline](tickets/07-provider-catalog.md) — blocked by the Capability Gap Resolver and unattended authority boundaries.
- [Add sandboxed declarative workflow composition](tickets/08-workflow-composition.md) — blocked by the Capability Gap Resolver and Provider catalog.
- [Make Verification goal-complete and correction-aware](tickets/10-goal-verification.md) — blocked by contract-driven planning and artifact verification.
- [Build the evidence-gated learning and curation loop](tickets/11-learning-loop.md) — blocked by the Capability Gap Resolver and goal Verification.
- [Establish the all-scenario benchmark and release gates](tickets/12-open-world-evals.md) — blocked by every runtime protocol above.

## Not yet specified

- Provider ecosystem packaging after the generic provider manifest and installer contract are decided.
- Domain Skill packs and artifact verifiers beyond the first representative text, web, data, image, HTML, PDF, spreadsheet, presentation, communication, scheduling, code, browser, and enterprise-record scenarios.
- Cross-device computer-use providers after typed observation/action receipts and unattended risk boundaries are fixed.
- Marketplace discovery and reputation after immutable provenance, signature, quarantine, and promotion policy are fixed.

## Out of scope

- Embedding or invoking an external general-purpose Agent runtime inside Thruvera.
- Copying another project's prompts, brand identity, unrestricted package installer, or user-home layout.
- Bypassing credentials, standing authority or execution grants, enterprise policy, Access Scope, network isolation, or side-effect reconciliation to avoid asking for user input.
- Preinstalling one Tool for every imaginable product. Open-world coverage comes from contracts, discovery, composition, trusted acquisition, and verification.
- Reporting “all scenarios supported” from synthetic Tool receipts or a finite routing corpus.
