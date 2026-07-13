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
