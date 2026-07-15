# Tickets: BeeMax Pi-native Organizational Agent Runtime

Build BeeMax from its current durable Agent foundation into a Pi-native organizational runtime with trusted Situation understanding, one execution path, verified outcomes, organizational memory, and progressively governed initiative. Source direction: the unified Agent Runtime PRD and the intelligence-first organizational agent design.

Work the **frontier**: any ticket whose blockers are all done. Do not bypass blocking edges. Preserve the current P6/P7 durable Task, recovery, checkpoint, and verification behavior while replacing shallow or duplicate paths.

## Unify the BeeMax Pi-native Runtime specification

**What to build:** A single authoritative product and architecture specification that reconciles the original runtime PRD with the organizational-intelligence direction and defines Pi as BeeMax's sole intelligent execution kernel.

**Blocked by:** None — can start immediately.

- [x] Define the product axiom, Pi/BeeMax responsibilities, one Objective-to-Pi execution path, and the five state authorities.
- [x] Reconcile Situation, Access Scope, Task, Verification, Memory, Initiative, and legacy Work Context terminology.
- [x] Record compatibility, migration, rollout, rollback, and explicitly deferred capabilities.

## Establish behavioral baselines and an unknown-business evaluation corpus

**What to build:** A reproducible evaluation corpus and baseline that measures current reliability, understanding, capability selection, cost, and recovery without assuming customer, order, ticket, or project domains.

**Blocked by:** Unify the BeeMax Pi-native Runtime specification.

- [x] Cover random enterprise vocabulary, corrections, conflicts, long-running work, crashes, and side effects.
- [x] Record current Situation accuracy, scope isolation, Capability Top-5, verified completion, latency, token, Tool, and Sub-Agent baselines.
- [x] Make evaluation results repeatable and suitable for release gates.

## Expand trusted Access Scope and open Situation representations

**What to build:** Add a trust-aware representation in which open business meaning belongs to Situation and only verified adapters can produce Access Scope references, while legacy data remains readable.

**Blocked by:** Unify the BeeMax Pi-native Runtime specification.

- [x] Preserve source, evidence, confidence, and trust class for inferred and verified information.
- [x] Prevent text and model output from becoming trusted authorization references.
- [x] Keep the change additive so existing callers remain green during migration.

## Migrate interaction and Memory recall to trusted scope plus semantic Situation

**What to build:** End-to-end interactive recall where Access Scope enforces isolation and Situation controls relevance, with correction changing meaning but never silently changing authorization.

**Blocked by:** Expand trusted Access Scope and open Situation representations.

- [x] User text cannot expand or replace Access Scope.
- [x] Unknown enterprise terms can still select relevant Memory.
- [x] Existing cross-scope isolation acceptance remains green.

## Migrate Objective and Task durable context

**What to build:** Durable Objectives and Tasks retain Situation and trusted scope references across continuation, correction, restart, and recovery without requiring fixed subject/object slots.

**Blocked by:** Expand trusted Access Scope and open Situation representations.

- [x] New work records preserve semantic and authorization provenance separately.
- [x] Legacy work records remain readable and recoverable.
- [x] Correction and continuation do not duplicate or misbind Objectives.

## Contract legacy business-context dependencies

**What to build:** Remove legacy businessContext and subject/object from the core execution and authorization contract after all callers and stored records have migrated.

**Blocked by:** Migrate interaction and Memory recall to trusted scope plus semantic Situation; Migrate Objective and Task durable context.

- [x] Legacy fields remain migration evidence only.
- [x] Core behavior passes randomized unknown-domain tests without fixed entity slots.
- [x] No hard authorization filter can be driven by inferred business meaning.

## Deepen Profile Runtime composition

**What to build:** One deep Profile Runtime module owns common Memory, Pi, Capability, Task, Effect, recovery, verification, credential, and shutdown wiring; channels supply only their real variations.

**Blocked by:** Unify the BeeMax Pi-native Runtime specification.

- [x] CLI and Feishu use the same runtime graph and lifecycle contract.
- [x] Adding a shared runtime dependency requires one composition change.
- [x] Partial startup failure and disposal ordering are contract-tested.

## Carry an Execution Envelope through the Pi lifecycle

**What to build:** Every Pi run has durable execution identity and trigger, Objective, Task Run, trusted scope, and budget references available throughout prompt, Turn, Tool, steering, compaction, abort, and settlement events.

**Blocked by:** Deepen Profile Runtime composition; Expand trusted Access Scope and open Situation representations.

- [x] Execution identity is structured rather than inferred from closures or prompt text.
- [x] Existing interactive and delegated Pi behavior remains compatible.
- [x] The envelope contains no fixed customer ontology or Secret material.

## Establish unified execution tracing and metrics

**What to build:** Trace a work item across Objective, Task Run, Pi Run, model turns, Tool calls, Effects, checkpoints, verification, and delivery with cost and latency metrics.

**Blocked by:** Carry an Execution Envelope through the Pi lifecycle.

- [x] Operators can diagnose one execution without correlating unrelated logs manually.
- [x] Metrics exclude credential material and respect Access Scope.
- [x] Evaluation can consume the same trace contract.

## Unify Pi Tool Effects and Task Receipts under one authority

**What to build:** Pi Tool lifecycle writes one authoritative Effect state machine and Tasks consume durable references or projections from it rather than a separately authored receipt truth.

**Blocked by:** Carry an Execution Envelope through the Pi lifecycle.

- [x] Mutations automatically bind to the current Task Run.
- [x] Committed Effects never replay; unknown Effects require reconciliation.
- [x] Pi abort, Tool timeout, process crash, projection damage, and credential-redaction cases are covered.

## Make checkpoints native to Pi Turns and Task Runs

**What to build:** Meaningful Pi progress produces structured durable checkpoints containing completed work, committed Effects, evidence, unresolved issues, and the next safe recovery step.

**Blocked by:** Carry an Execution Envelope through the Pi lifecycle; Unify Pi Tool Effects and Task Receipts under one authority.

- [x] Recovery does not depend solely on a model voluntarily calling a checkpoint Tool.
- [x] Compaction preserves the durable responsibility represented by the checkpoint.
- [x] Restarted execution can continue without repeating committed work.

## Make Verification decide Objective completion

**What to build:** A settled Pi run produces a candidate outcome; only accepted Verification completes the durable responsibility, while rejection corrects and unavailability waits or escalates.

**Blocked by:** Unify Pi Tool Effects and Task Receipts under one authority; Make checkpoints native to Pi Turns and Task Runs.

- [x] Agent settlement and business completion have distinct states.
- [x] Unverified results cannot satisfy dependent Tasks.
- [x] Corrective execution has a bounded, durable lifecycle.

## Unify interactive and planned Task execution

**What to build:** Direct, delegated, and DAG work use the same Objective, Pi, Effect, checkpoint, and Verification lifecycle, with durability determined by responsibility rather than planning mode.

**Blocked by:** Make Verification decide Objective completion.

- [x] Steering, correction, model fallback, and Capability reroute do not duplicate work.
- [x] TaskGraph does not become a second Agent Loop.
- [x] Existing P7 recovery acceptance remains green through the unified interface.

## Unify Automation and Recovery execution

**What to build:** Automation and recovered work create or resume durable responsibility and execute through the same Pi lifecycle instead of bypassing Situation, Context, Effect, or Verification.

**Blocked by:** Unify interactive and planned Task execution.

- [x] Schedules remain triggers rather than Tasks.
- [x] Recovery resumes from checkpoints and Effect state.
- [x] Interactive, automation, and recovery runs have equivalent lifecycle semantics.

## Complete the eval-backed Capability Runtime

**What to build:** Tool, Skill, and MCP inventory, ranking, activation, versioning, and reroute behavior sit behind one deep Capability interface and meet the real unknown-business Top-5 gate.

**Blocked by:** Establish behavioral baselines and an unknown-business evaluation corpus; Carry an Execution Envelope through the Pi lifecycle.

- [x] Pi active tools remain the current execution authority.
- [x] Lexical and semantic implementations return the same result shape and explanation.
- [x] Reroute cannot replay a mutation or bypass Policy.

## Add an Enterprise Policy provider

**What to build:** Enterprises can provide versioned allow, deny, approval, constraint, and missing-evidence decisions without encoding their business rules into Core.

**Blocked by:** Expand trusted Access Scope and open Situation representations; Unify Pi Tool Effects and Task Receipts under one authority.

- [x] Decisions retain publisher, version, effective scope, time, and audit evidence.
- [x] Existing approval behavior has a compatible migration path.
- [x] Model output and learned conventions cannot publish formal Policy.

## Establish Action Governance

**What to build:** Each proposed action receives one governed decision based on trusted scope, Enterprise Policy, risk, reversibility, evidence, Execution Grant, Effect type, and measured reliability.

**Blocked by:** Add an Enterprise Policy provider; Establish behavioral baselines and an unknown-business evaluation corpus.

- [x] Governance is per action rather than a single global autonomy switch.
- [x] Unknown high-risk actions fail safely without blocking low-risk investigation.
- [x] Decisions are explainable, auditable, and testable through one interface.

## Publish verified work as Organization Memory Episodes

**What to build:** Every meaningful verified Objective outcome becomes an idempotent, evidence-backed Episode that can be recalled in later unknown-domain Situations.

**Blocked by:** Contract legacy business-context dependencies; Make Verification decide Objective completion.

- [x] Generic work without a predefined business entity still forms an Episode.
- [x] Reprocessing the same outcome does not duplicate the Episode.
- [x] Candidate, verified, conflicted, and superseded knowledge remain distinguishable.

## Present Memory persistence through deep interfaces

**What to build:** Keep one SQLite authority while callers learn focused Organization Memory, Task Ledger, Recovery Queue, and Completion Outbox interfaces rather than the full MemoryStore implementation.

**Blocked by:** Publish verified work as Organization Memory Episodes.

- [x] No second Memory authority is introduced.
- [x] Existing migrations and transaction guarantees remain local to the implementation.
- [x] Callers and tests use the same focused interfaces.

## Preserve Correction, Conflict, and Exception chains

**What to build:** Users and verified sources can supersede prior understanding, expose unresolved conflicts, and record exceptions without silently rewriting general organizational knowledge.

**Blocked by:** Publish verified work as Organization Memory Episodes.

- [x] Every correction and conflict remains traceable to evidence.
- [x] Exceptions do not become universal conventions.
- [x] Forget, revoke, and scope-isolation behavior remains correct.

## Consolidate Convention Candidates from Episodes

**What to build:** Repeated evidence can produce a reviewable Convention Candidate with time span, confidence, exceptions, and supporting Episodes, but never an automatically effective Enterprise Policy.

**Blocked by:** Preserve Correction, Conflict, and Exception chains; Present Memory persistence through deep interfaces.

- [x] Consolidation runs asynchronously and idempotently.
- [x] Contradictory evidence lowers or blocks promotion.
- [x] Candidates can be confirmed, rejected, superseded, and rolled back.

## Add a model-backed Situation Builder with deterministic fallback

**What to build:** Build open, evidence-backed Situation understanding from input, active work, Memory, Tool or enterprise events, and trusted scope while preserving a bounded deterministic fallback.

**Blocked by:** Establish behavioral baselines and an unknown-business evaluation corpus; Contract legacy business-context dependencies; Publish verified work as Organization Memory Episodes.

- [x] Output separates facts, goals, constraints, conflicts, unknowns, candidate actions, provenance, and confidence.
- [x] Model inference cannot mint authorization facts.
- [x] Unknown-domain evaluations improve without regressing the deterministic fallback.

## Recall organizational knowledge through Situation

**What to build:** Situation-driven recall combines trusted scope, semantic relevance, recency, evidence quality, precedent, correction, conflict, and convention into a bounded context contribution for Pi.

**Blocked by:** Add a model-backed Situation Builder with deterministic fallback; Preserve Correction, Conflict, and Exception chains.

- [x] Recall precision, correction retention, conflict visibility, and latency have release gates.
- [x] Context budgets preserve current work while releasing low-value Memory.
- [x] Retrieved content remains evidence rather than executable instruction.

## Run Initiative in observe-only mode

**What to build:** Heartbeat becomes one trigger adapter for an Initiative module that builds Situation, deduplicates against active Objectives, and records proposed action, value, risk, scope, and rationale without external mutation.

**Blocked by:** Unify Automation and Recovery execution; Add a model-backed Situation Builder with deterministic fallback; Recall organizational knowledge through Situation.

- [x] No meaningful action produces no notification or work.
- [x] Repeated triggers and restarts do not duplicate Objectives.
- [x] Observation records support precision, value, and interruption evaluation.

## Add Task-transition and enterprise-event Initiative triggers

**What to build:** Dependency changes, commitments, and enterprise events enter the same Initiative interface as heartbeat and messages, proving that triggers vary while work admission stays unified.

**Blocked by:** Run Initiative in observe-only mode.

- [x] A second real trigger adapter uses the same dedupe and decision behavior.
- [x] Missing delivery routes delay notification rather than losing responsibility.
- [x] Multi-instance claims prevent duplicate Initiative decisions.

## Allow proactive read-only investigation

**What to build:** High-value, sufficiently confident Initiative decisions may create recoverable read-only investigation Objectives through the unified Pi execution path.

**Blocked by:** Add Task-transition and enterprise-event Initiative triggers; Establish Action Governance.

- [x] Read-only work has budgets, checkpoints, Verification, and quiet behavior when no result matters.
- [x] Active Objectives are updated rather than duplicated.
- [x] Precision, adoption, interruption, and cost gates control rollout.

## Allow reversible low-risk proactive actions

**What to build:** Enterprise-authorized, reversible, low-risk mutations can execute proactively with Effect identity, verification, rollback, pause, and audit controls.

**Blocked by:** Allow proactive read-only investigation; Unify Pi Tool Effects and Task Receipts under one authority; Consolidate Convention Candidates from Episodes; Establish Action Governance.

- [x] Every action is covered by a current Policy decision and trusted scope.
- [x] Rollback and emergency stop are exercised before rollout.
- [x] High-risk or irreversible actions remain human decisions.

## Derive Workflow Candidates from verified conventions

**What to build:** Stable conventions can produce reviewable Workflow Candidates describing conditions, exceptions, inputs, outcomes, and Verification without changing production behavior.

**Blocked by:** Consolidate Convention Candidates from Episodes.

- [x] Workflow candidates link back to supporting and contradictory Episodes.
- [x] The generated workflow remains instruction-only and contains no Secret.
- [x] Humans can edit, reject, supersede, and archive candidates.

## Trial Workflow Candidates as isolated Skill Candidates

**What to build:** A Workflow Candidate can enter the existing Skill candidate lifecycle for static checks, isolated real trials, independent Verification, consecutive-success promotion, gray rollout, and rollback.

**Blocked by:** Derive Workflow Candidates from verified conventions; Complete the eval-backed Capability Runtime.

- [x] Failed trials never update an active Skill.
- [x] Promotion requires configured evidence and authority.
- [x] Skill versions and rollback remain observable and durable.

## Exercise reliability and failure recovery

**What to build:** A release-grade fault suite proves the unified Runtime under Pi crash, Tool timeout, process exit, restart, multi-instance claims, unknown Effects, unavailable Verification, delivery failure, compaction, steering, and correction.

**Blocked by:** Unify Automation and Recovery execution; Establish unified execution tracing and metrics; Unify Pi Tool Effects and Task Receipts under one authority.

- [x] Committed mutations are never duplicated.
- [x] Safe work resumes or fails explicitly according to recovery policy.
- [x] Every fault has observable state and an operator recovery path.

## Validate performance and execution cost

**What to build:** Define and enforce production-machine latency, context, token, Tool, Sub-Agent, recall, Situation, Initiative, cache, concurrency, and backpressure budgets.

**Blocked by:** Complete the eval-backed Capability Runtime; Recall organizational knowledge through Situation; Run Initiative in observe-only mode.

- [x] P50 and P95 budgets are measured on declared machine profiles.
- [x] Fast, deep, and background paths have separate budgets.
- [x] Cost regressions block release even when task quality improves.

## Validate cross-channel Runtime equivalence

**What to build:** CLI, Feishu, and future channels demonstrate identical Task, Effect, Memory, Policy, Verification, cancellation, and recovery semantics while varying only presentation and delivery behavior.

**Blocked by:** Deepen Profile Runtime composition; Unify Automation and Recovery execution; Exercise reliability and failure recovery.

- [x] Channel switching does not lose active responsibility.
- [x] Contract tests cover common runtime behavior once.
- [x] Channel adapters cannot bypass Governance or Effect recording.

## Complete the original P0-P10 acceptance program

**What to build:** Close every quantitative and architectural gate in the original runtime PRD, resolve or formally defer every TBD, and document migration, rollback, and production machine baselines.

**Blocked by:** Validate performance and execution cost; Validate cross-channel Runtime equivalence; Complete the eval-backed Capability Runtime; Add an Enterprise Policy provider; Unify Pi Tool Effects and Task Receipts under one authority.

- [x] All acceptance metrics have reproducible evidence.
- [x] Architecture duplication gates pass.
- [x] Data migration and rollback are rehearsed.

## Roll out organizational intelligence by autonomy level

**What to build:** Release Situation, Episodes, Initiative, read-only work, and reversible actions in separately controlled levels with explicit evaluation gates, pause, rollback, and enterprise overrides.

**Blocked by:** Complete the original P0-P10 acceptance program; Allow proactive read-only investigation; Validate performance and execution cost.

- [x] Each autonomy level can be enabled and stopped independently.
- [x] Promotion depends on measured quality, safety, value, and interruption thresholds.
- [x] High-risk autonomy remains out of scope without a new approved effort.

## Not yet specified

These remain in scope for the long-term destination but need production Episodes, evaluations, or real demand before they can be ticketed precisely:

- Temporal organizational world modeling and causal simulation.
- Commitment networks and richer responsibility inference.
- Agent self-model and economic value/cost optimization.
- Larger multi-Agent organizational structures on the shared Task and Effect authorities.
- Privacy-preserving cross-deployment learning.
- Policy recommendation candidates that always require authorized publication.

## Out of scope

- A second Memory authority.
- A second Agent Loop beside Pi.
- Fixed customer, order, ticket, or project ontology in Core.
- Replacing Task Ledger with the experimental Pi orchestrator; it may later be an execution adapter.
- Direct automatic publication of Enterprise Policy or production Skills.
- Broad Pi rewrites without a demonstrated missing lifecycle seam.
- High-risk or irreversible autonomous action in this effort.

# Tickets: Codex/Hermes parity and verified Agent completion

Bring BeeMax to Hermes Agent feature parity and Codex-level Tool routing, then exceed both in durable enterprise execution, evidence-bound completion, Profile isolation, and capability acquisition. These tickets remediate gaps found after the original Pi-native runtime program; prior completion marks are retained as historical implementation evidence, not proof that these stricter gates already pass.

Work the **frontier**: any ticket whose blockers are all done. Do not bypass blocking edges, silently degrade the user's Objective, introduce a second Agent Loop beside Pi, or encode customer business vocabulary in Core.

## Current execution frontier

The active chain is intentionally narrow. Finish one evidence-backed vertical slice before opening the next:

1. Close production semantic Capability routing and its live evidence gate.
2. Enforce the same Skill lifecycle for prefetched and runtime-discovered Skills.
3. Acquire a missing Tool or MCP Provider and resume the unchanged Objective.
4. Dispatch every model Tool Call through one strict Router.
5. Execute independent reads in parallel without replaying mutations.
6. Verify every Contract acceptance criterion from durable receipts.
7. Carry the same guarantees through realtime research, recovery, delivery, context compression, Memory, schedules, Gateway channels, auxiliary vision, and bounded delegation.
8. Prove Ubuntu stability, fault/resource bounds, Hermes parity, and Codex Tool-routing parity before release.

This ordering is the implementation plan, not a fixed business workflow. Core reasons over versioned Contracts, Capability descriptors, evidence, Effects, scopes, and Policy; enterprise-specific nouns and rules remain supplied by Skills, Providers, configuration, and organizational Memory.

## Establish the differential Agent benchmark

**What to build:** A reproducible harness runs the same short, long, realtime, Skill, Tool, MCP, file, image, Gateway, failure, and recovery tasks against BeeMax and pinned Codex/Hermes baselines.

**Blocked by:** None — can start immediately.

- [x] Pin models, versions, machine profiles, network conditions, fixtures, seeds, capture configuration contracts, and scoring rules.
- [x] Record end-to-end success, Tool selection and arguments, latency, tokens, receipt-bound evidence, side effects, recovery, and user interventions.
- [x] Make native capture fail closed on corpus, fixture, adapter, configuration, environment, source-validation, and candidate/baseline identity drift.

## Reconcile the current parity working tree

**What to build:** Preserve valid Capability, Provider, evaluation, and CI work while separating or removing temporary semantic rules so the next slices start from a green, reviewable baseline.

**Blocked by:** Establish the differential Agent benchmark.

- [x] Preserve user-owned output artifacts and unrelated changes.
- [x] Split mixed changes into independently testable concerns and keep TypeScript, unit, integration, and packaging checks green.
- [x] Remove production behavior that maps concrete business phrases directly to lifecycle or delivery decisions.

## Stabilize direct and durable completion under the corpus

**What to build:** BeeMax completes short, constrained, Tool-backed, and durable tasks repeatedly without semantic-wrapper bias, unnecessary Objective promotion, unbounded capability exploration, or verifier-format flakiness.

**Blocked by:** Reconcile the current parity working tree.

- [x] Prove short conversation and bilingual negation cases succeed repeatedly on fresh Profiles, keep user constraints, and stay on the direct path unless the Work Contract requires durable responsibility.
- [ ] Bound model turns, Tool discovery, repeated failed reads, output tokens, no-progress time, and corrective attempts by execution mode while preserving Effect reconciliation and explicit Blockers.
- [ ] Replace incidental prompt-word decisions with validated Contract signals, and retain regression coverage for contextual “current”, explanatory intent, unique verifier envelopes, fake-IP DNS, and multi-path configuration capture.
- [x] Budget only newly processed/generated model tokens and cache writes; retain cache-read usage in Trace without charging the execution budget twice.
- [x] Give Verification a minimal semantic Tool Spec and re-admit successful read-only execution Tools as routing hints while requiring a fresh independent receipt.
- [ ] Make direct Pi routing reliably execute required Provider, MCP, Effect, Delivery, Schedule, structured, and parallel-read capabilities before Candidate Verification.
- [ ] Carry successful Tool identities from planned and recovered Task Runs into the same independent Verification routing contract.

## Produce native macOS and Ubuntu parity evidence

**What to build:** Pinned BeeMax, Codex, and Hermes runs complete the same final corpus on macOS arm64 and Ubuntu 24.04 x64, producing source-backed differential reports that can be audited as release evidence.

**Blocked by:** Stabilize direct and durable completion under the corpus.

- [ ] Rerun every baseline after any corpus, prompt boundary, adapter, fixture, or scoring change; never compare artifacts with mismatched provenance.
- [ ] Run unattended on both declared operating systems with real product CLIs, exact versions, isolated per-case state, and no silent retry or downgrade; classify runner infrastructure failures separately.
- [ ] Preserve reports, checksums, traces or trace digests, environment identity, and the per-dimension comparison gate in versioned CI or release artifacts.

## Interpret one Turn as a model-backed Work Contract

**What to build:** For one direct task, Pi retains the immutable Raw Request and proposes a structured Work Contract containing the Objective, constraints, prohibitions, acceptance criteria, Capability requirements, uncertainties, and source spans.

**Blocked by:** Reconcile the current parity working tree.

- [x] Use a strict versioned schema and keep model inference separate from trusted Access Scope and Policy.
- [x] Produce the Contract without a separate business-intent loop or fixed customer vocabulary.
- [ ] Exercise Chinese, English, mixed-language, paraphrase, and unknown-enterprise inputs end to end.

## Validate Work Contracts before execution

**What to build:** A Contract proposal becomes executable only after deterministic validation of provenance, contradictions, unsupported additions, Objective linkage, and verifiability.

**Blocked by:** Interpret one Turn as a model-backed Work Contract.

- [x] Reject fabricated source spans, unsupported requirements, and internally contradictory clauses.
- [x] Preserve uncertainty instead of guessing and route governed actions through existing Policy authority.
- [x] Keep validation free of business action dictionaries and customer-specific workflow rules.

## Carry continuation, correction, cancellation, and query through Work Contracts

**What to build:** Natural multi-turn requests continue, amend, cancel, or inspect the correct durable Objective without phrase-specific production parsing.

**Blocked by:** Validate Work Contracts before execution.

- [ ] Cover negation, double negation, reversals, pronouns, omitted subjects, and cross-language corrections.
- [ ] Preserve the original Objective and revision chain without duplicate or misbound work.
- [ ] Contract the legacy regex understanding path after all callers migrate and regression tests are red-capable.

## Build a dynamic Tool Spec Plan for each Pi Turn

**What to build:** Profile scope, Work Contract, active Skill, Policy, provider health, platform, and execution state produce a bounded model-visible Tool plan with direct, deferred, and hidden exposure.

**Blocked by:** Validate Work Contracts before execution.

- [x] Keep large catalogs out of the initial context and expose only valid immutable Tool identifiers and schemas.
- [x] Make newly activated Tools visible on the next Pi sampling request without restarting the Agent Loop.
- [x] Prevent hidden, unhealthy, unconfigured, or unauthorized Tools from becoming executable.

## Route Capability requirements semantically

**What to build:** Tool, MCP, and Skill candidates share one explainable Capability selection shape while Pi remains the final task-level selector.

**Blocked by:** Build a dynamic Tool Spec Plan for each Pi Turn.

- [x] Use configured Profile models for production semantic ranking across Tool, MCP, and Skill candidates; preserve a valid semantic no-match and use bounded lexical recall only when semantic Providers are unavailable.
- [x] Rank immutable, versioned candidates by meaning, input/output modality, freshness, evidence, effect, health, cost, latency, and Profile preference without allowing preference or model output to grant authority.
- [x] Fail closed on invented identities, malformed scores, duplicate candidates, excluded or unhealthy capabilities, cancellation, timeout, oversized inventories, and Provider errors without leaking credentials or resetting the total deadline.
- [x] Commit a source-bound live-model evidence artifact that proves every calibration case used the semantic path; fail release verification on fallback, stale source digests, weak collisions, cross-language errors, or negative-case false positives.

## Calibrate Capability ranking against real task outcomes

**What to build:** BeeMax continuously tunes Capability selection from reproducible task outcomes rather than hand-authored business phrases, while preserving deterministic safety and authority boundaries.

**Blocked by:** Route Capability requirements semantically.

- [x] Measure Top-1, Top-K, required-capability recall, unnecessary activation, no-match precision, latency, token cost, and downstream task completion on frozen multilingual and unknown-enterprise corpora.
- [x] Separate offline lexical, frozen semantic, and real-Provider results so one path cannot hide regressions in another.
- [ ] Version thresholds and ranking changes with before/after evidence, and reject a calibration that improves aggregate ranking while worsening authorization, false-positive, or completion gates.
- [ ] Preserve the prior ranking implementation's calibration artifact, not only alternate thresholds on one implementation, before promoting a new ranking version.
- [x] Bind every Skill completion to one immutable Skill identity so multi-Skill outcomes cannot be projected from a shared lifecycle Tool receipt.
- [x] Make live evidence reject duplicate or unknown receipts and bind Tool execution to the Tool Spec plan and event order that exposed it.
- [x] Mark Provider cost evidence incomplete when a failed attempt has no measured usage; do not promote cost claims from a lower-bound total.
- [x] Strengthen the authority probe and report verifier with explicit schema, mode, corpus, threshold, scope, cognition, and unauthorized-candidate identity checks.
- [x] Add a separate live-Pi outcome lane where the configured model reads the Tool Spec, chooses Tools, and satisfies independent Acceptance Criteria; keep the deterministic routing harness as infrastructure evidence rather than treating it as model task-completion proof.
- [x] Bind each Pi-originated Tool call to its exact assistant Turn and Provider response identity in the durable Execution Trace; do not infer model causality from event order alone.
- [ ] Sign live evaluation artifacts in trusted CI and verify run provenance, freshness, model identity, trace digest, and Provider request evidence before release; repository JSON self-consistency is not cryptographic attestation.
- [ ] Require authoritative model pricing or Provider cost attestation before enabling a release cost-regression gate; keep unknown pricing explicitly `unpriced` and never reinterpret it as zero-cost execution.
- [ ] Replace positional Capability ranker factory arguments with one named configuration object shared by CLI, Gateway, and evaluation entrypoints.

## Enforce one Skill lifecycle for prefetched and discovered Skills

**What to build:** Explicitly selected, prefetched, and runtime-discovered Skills use the same version-locked discover, admit, activate, route, resource-read, execute, and complete lifecycle.

**Blocked by:** Calibrate Capability ranking against real task outcomes.

- [x] Require the lifecycle only for explicit or calibrated high-confidence selection.
- [x] Merge runtime discovery receipts into the lifecycle gate and enable only declared route Tools.
- [x] Report missing modules, invalid resources, failed routes, and incomplete execution without silently substituting another Skill.

## Acquire missing Tool and MCP Providers without degrading the Objective

**What to build:** When an installed capability cannot satisfy the Contract, BeeMax searches configured and installable Providers, obtains authority, installs safely, verifies health, and resumes the original Objective.

**Blocked by:** Calibrate Capability ranking against real task outcomes.

- [x] Resolve installed, configured, healthy candidates before considering installation.
- [x] Require evidence-backed installation authority and return exact missing configuration or health blockers.
- [x] Never replace realtime, publication, real-data, or full-scope requirements with a weaker result without user authorization.

## Dispatch model Tool Calls through one strict Router

**What to build:** One deep Tool Router validates identity, arguments, scope, Policy, approval, timeout, cancellation, execution, redaction, output bounds, events, and receipts for Native, MCP, Skill, and Provider-backed calls.

**Blocked by:** Build a dynamic Tool Spec Plan for each Pi Turn; Acquire missing Tool and MCP Providers without degrading the Objective.

- [x] Reject invented identifiers and repair or return actionable errors for malformed names and arguments without bypassing schema checks.
- [x] Persist oversized or binary output as bounded Artifacts and preserve only safe summaries and references in model context.
- [x] Produce a traceable Route and Tool Receipt for every attempted dispatch.

## Execute independent Tools in parallel and reroute safely

**What to build:** Pi may run independent read-only calls concurrently, while dependencies, shared resources, mutations, and unknown Effects are serialized or reconciled before retry or reroute.

**Blocked by:** Dispatch model Tool Calls through one strict Router.

- [x] Derive concurrency from declared dependencies and Effect metadata rather than prompt keywords.
- [x] Reroute failed read-only work to equivalent healthy Providers without changing the Contract.
- [x] Prevent blind replay of external writes and prove zero duplicate mutation under timeout and crash injection.

## Verify every acceptance criterion against durable receipts

**What to build:** Candidate Outcomes complete an Objective only when every required Contract criterion is independently accepted against real Source, Artifact, Effect, Test, or Delivery receipts.

**Blocked by:** Validate Work Contracts before execution; Dispatch model Tool Calls through one strict Router.

- [x] Bind every verifier assertion to a criterion identifier and an existing successful evidence reference.
- [x] Reject model-authored prose, bare URLs, and unrelated receipts as completion evidence.
- [x] Keep rejected and unavailable criteria durable for corrective execution or Verification Retry.

## Complete realtime research without silent fallback

**What to build:** A current-data request discovers and calls a live external capability, retains source evidence, and either delivers a verified result or an exact Blocker.

**Blocked by:** Acquire missing Tool and MCP Providers without degrading the Objective; Verify every acceptance criterion against durable receipts.

- [x] Derive freshness and source requirements from the Work Contract rather than a hardcoded weather, price, or news vocabulary.
- [x] Prove no current external claim can pass without a successful source receipt.
- [x] Exercise configured, unconfigured, offline, timeout, and alternate-provider paths without evergreen substitution.

## Recover and verify both Direct and Plan Objectives

**What to build:** Interrupted direct and planned work resumes or re-verifies from durable state without starvation, duplicate execution, or lost responsibility.

**Blocked by:** Verify every acceptance criterion against durable receipts.

- [x] Keep direct candidates visible when Plan IDs are excluded by treating null Plan identity correctly.
- [x] Preserve leases, checkpoints, Effects, candidate outcomes, and bounded corrective attempts across restart.
- [x] Prove multi-instance claims cannot execute or verify the same responsibility concurrently.

## Deliver every verified Objective through one Completion Outbox

**What to build:** Direct and planned Objectives that complete interactively or in the background reach the correct owner, Channel Instance, Conversation, and Thread through one durable delivery path.

**Blocked by:** Recover and verify both Direct and Plan Objectives.

- [ ] Enqueue completion exactly once for every accepted Objective regardless of execution mode.
- [ ] Retry transient channel failure without replaying Pi or external Effects and retain a Delivery Receipt.
- [ ] Keep the Objective nonterminal when required delivery remains unverified or permanently blocked.

## Preserve Contracts and responsibility through context compression

**What to build:** Long sessions compact model context while retaining the Raw Request, active Contract, unresolved criteria, trusted scope, checkpoints, Effect state, and artifact references.

**Blocked by:** Validate Work Contracts before execution; Verify every acceptance criterion against durable receipts.

- [ ] Store large Tool results outside prompt history and support bounded on-demand rereading.
- [ ] Prove multilingual constraints, corrections, and prohibitions survive repeated compaction.
- [ ] Enforce model-specific budgets and demonstrate bounded process memory during long runs.

## Recall and publish only scope-correct verified Memory

**What to build:** Pi receives relevant evidence from Actor, Conversation, Group, Profile, and Organization scopes, while only verified or explicitly confirmed outcomes can become reliable organizational knowledge.

**Blocked by:** Deliver every verified Objective through one Completion Outbox; Preserve Contracts and responsibility through context compression.

- [ ] Preserve correction, conflict, exception, revocation, provenance, confidence, and expiry semantics.
- [ ] Prevent inferred business meaning, Tool output, or retrieved content from granting authority or becoming executable instruction.
- [ ] Prove zero recall or write leakage across Profile, enterprise, private conversation, group, and thread scopes.

## Run scheduled and proactive work through the unified durable lifecycle

**What to build:** One-time, recurring, Cron, recovery, and authorized Initiative triggers create or resume responsibility through the same Contract, Pi, Effect, Verification, Outbox, and Memory path.

**Blocked by:** Deliver every verified Objective through one Completion Outbox; Recall and publish only scope-correct verified Memory.

- [ ] Recheck Policy, credentials, provider health, budget, and dedupe identity at execution time.
- [ ] Support pause, resume, cancel, failure recovery, quiet completion, and correct channel delivery.
- [ ] Keep schedules and Initiative observations as triggers rather than second Agent Loops or implicit Tasks.

## Isolate Gateway channels and Profile runtimes end to end

**What to build:** Feishu proves a transport-neutral Gateway and Channel Runtime contract that other platforms can implement without bypassing Profile binding, activation, Governance, Effects, Memory, or delivery.

**Blocked by:** Deliver every verified Objective through one Completion Outbox; Recall and publish only scope-correct verified Memory.

- [ ] Cover direct chat, group mention, contextual follow-up, thread, whitelist, quiet hours, duplicate ingress, and background delivery.
- [ ] Isolate Profile model, credentials, Skills, Tools, Memory, Tasks, capacity, shutdown, and failure propagation.
- [ ] Demonstrate one Profile or Channel failure cannot corrupt or block unrelated Profiles.

## Route images, documents, and OCR through auxiliary capabilities

**What to build:** A chat image or document is routed to the primary multimodal model, an auxiliary vision Provider, OCR, or a higher-quality fallback according to capability, confidence, Policy, cost, and evidence requirements.

**Blocked by:** Acquire missing Tool and MCP Providers without degrading the Objective.

- [ ] Support images, screenshots, scanned documents, PDFs, and attachment provenance through the Gateway.
- [ ] Install and health-check Tesseract on supported Ubuntu installation paths while allowing configurable vision Providers.
- [ ] Escalate low-confidence OCR without pretending recognition succeeded and retain input/output Artifact references.

## Delegate complex work without creating a second Agent Loop

**What to build:** Pi chooses direct, durable Plan, or bounded Sub-Agent execution from the Contract, with shared Task, Capability, Effect, Verification, and recovery authorities.

**Blocked by:** Execute independent Tools in parallel and reroute safely; Recover and verify both Direct and Plan Objectives.

- [ ] Keep short tasks on the fast path and decompose only demonstrably independent or long-running work.
- [ ] Restrict child scope, Tools, budgets, deadlines, and Memory and return evidence-backed child outcomes.
- [ ] Prove child failure, cancellation, timeout, or crash cannot complete or corrupt the parent responsibility.

## Install and operate BeeMax reproducibly on Ubuntu

**What to build:** A clean supported Ubuntu host can install dependencies, configure a Profile, start BeeMax under production supervision, run a smoke task, and upgrade or roll back safely.

**Blocked by:** Run scheduled and proactive work through the unified durable lifecycle; Isolate Gateway channels and Profile runtimes end to end; Route images, documents, and OCR through auxiliary capabilities.

- [ ] Automate supported Node, native dependencies, OCR, data directories, credentials, health checks, and diagnostics.
- [ ] Use Docker as the default production execution sandbox and document trusted host execution separately.
- [ ] Verify cold install, restart, backup, migration, upgrade, rollback, and uninstall behavior in CI.

## Exercise the production fault and resource matrix

**What to build:** Fault injection and soak tests prove safe behavior under model errors, Provider timeout, MCP crash, network loss, Gateway reconnect, process exit, SQLite contention, compaction, low memory, and sustained concurrency.

**Blocked by:** Install and operate BeeMax reproducibly on Ubuntu; Delegate complex work without creating a second Agent Loop.

- [ ] Demonstrate bounded queues, context, Tool output, process memory, handles, child processes, and backpressure.
- [ ] Prove committed Effects never duplicate and every incomplete responsibility remains observable and recoverable.
- [ ] Publish P50/P95 latency, throughput, cost, recovery, and memory profiles for declared deployment sizes.

## Pass the Hermes Agent parity gate

**What to build:** A pinned Hermes baseline and BeeMax run the same model and tasks across conversation, Skills, Tools, Providers, Memory, context, files, vision, scheduling, Gateway, recovery, and operator experience.

**Blocked by:** Exercise the production fault and resource matrix; Isolate Gateway channels and Profile runtimes end to end.

- [ ] Close or explicitly document every feature, success-rate, latency, cost, stability, and usability gap.
- [ ] Require BeeMax to be no worse on each declared parity dimension rather than hiding regressions in an aggregate score.
- [ ] Preserve reproducible traces and evidence for every claimed advantage.

## Pass the Codex Tool routing gate

**What to build:** A pinned Codex baseline and BeeMax use the same model, tools, schemas, permissions, and tasks to compare dynamic visibility, discovery, selection, arguments, parallelism, recovery, context use, and final completion.

**Blocked by:** Exercise the production fault and resource matrix; Complete realtime research without silent fallback.

- [ ] Meet calibrated gates for required-Tool recall, unnecessary calls, argument validity, task success, latency, and token cost.
- [ ] Prove zero unauthorized downgrade, Profile bypass, unsupported completion, and duplicate external mutation.
- [ ] Keep a second best-native-configuration benchmark separate from the same-model Runtime comparison.

## Release only after parity and verified-completion gates pass

**What to build:** Produce a formal BeeMax release only when all release blockers, Ubuntu checks, migration drills, parity reports, security isolation, and completion evidence are green.

**Blocked by:** Pass the Hermes Agent parity gate; Pass the Codex Tool routing gate.

- [ ] Resolve every P0/P1 or record an explicitly approved deferral that does not invalidate parity claims.
- [ ] Publish versioned artifacts, checksums, changelog, architecture and operator documentation, migration guidance, and rollback steps.
- [ ] Verify the Git tag, GitHub release, installation artifact, clean-host smoke test, and post-release health checks agree.
