# BeeMax L4 Outcome-Driven Memory and Learning System

Label: `ready-for-agent`

## Problem Statement

BeeMax already persists conversation evidence, typed Claims, Episodes, Corrections,
Conflicts, Exceptions, Convention Candidates, Workflow Candidates, managed Skill
versions, Task state, Verification outcomes, and execution receipts. These pieces
provide a strong governed-memory foundation, but they do not yet operate as one
closed learning system.

From the user's perspective, BeeMax must not merely remember more text. It must
become better at completing real work: retain trustworthy preferences and facts,
reuse successful procedures, avoid repeating failures, adapt when sources and
Tools change, recover from interruption, and make fewer requests for routine user
operation. A failed report renderer must not discredit correct research knowledge;
an outdated source must not poison an otherwise useful Skill; and one accidental
success must not silently become an organization-wide rule.

The missing capability is an evidence-driven loop that correlates recalled Memory,
selected Capabilities, Skill versions, Tool receipts, independent Verification,
and downstream outcomes. Without that correlation, automatic promotion and
automatic downgrade are threshold guesses rather than learning. Without a single
deep interface, extraction, recall, consolidation, Skill evolution, and maintenance
will also spread across the Runtime and create a second implicit Agent system.

L4 means a production memory system that can autonomously extract, govern,
retrieve, evaluate, correct, decay, and operationalize experience. It does not mean
changing foundation-model weights, granting itself new authority, or guaranteeing
that every possible task can be completed without credentials, Tools, or evidence.

## Solution

BeeMax will add one native `Memory Learning Kernel` behind the existing Profile
Runtime. It exposes four conceptual operations:

- `prepare`: build an evidence-backed, progressively disclosed Context Pack for a
  Situation and Work Contract;
- `observe`: append bounded source evidence and candidate-learning signals;
- `settle`: correlate an independently verified outcome with the Memory,
  Capability, Skill, Tool, and source contributions used to produce it;
- `maintain`: consolidate, revalidate, project, decay, and schedule safe learning
  work for one trusted scope.

The four operations are the single highest-level test seam. The Kernel hides model
extraction, deterministic admission, conflict handling, hybrid retrieval,
contextual assessment, outcome attribution, projection generation, and Skill
lifecycle coordination. It does not execute the user's Objective and does not own
Task, Effect, Policy, Credential, or Delivery state.

The system has five distinct layers:

```text
Evidence Journal
    -> Semantic Authority
        -> Contextual Assessment
            -> Derived Knowledge Projections
                -> Procedural Memory and managed Skills

Durable Objective / Task / Checkpoint / Effect / Verification state remains a
separate execution authority and supplies outcomes back to the learning loop.
```

The learning cycle is:

```text
Observe -> Extract -> Stage -> Verify -> Promote -> Retrieve -> Apply
        -> Settle -> Attribute -> Reinforce / Correct / Suppress -> Consolidate
```

Normal low-risk learning proceeds without user operation. A new permission,
Credential, irreversible external action, organization-wide rule, or formal Policy
still requires existing trusted authority. If that authority is absent, the item
remains a Candidate and the current Objective continues through another safe route
where possible.

## User Stories

1. As a user, I want BeeMax to remember my stable preferences, so that I do not have to repeat formatting, language, and delivery expectations.
2. As a user, I want BeeMax to distinguish a preference from a factual claim, so that stylistic choices do not become false business facts.
3. As a user, I want BeeMax to preserve the source of every important remembered fact, so that I can understand why it believes something.
4. As a user, I want BeeMax to know when remembered information has expired, so that current tasks do not reuse stale prices, policies, or system state.
5. As a user, I want corrections to replace or narrow prior understanding everywhere it is used, so that I do not need to correct the same mistake repeatedly.
6. As a user, I want conflicting evidence to remain visible, so that BeeMax investigates uncertainty instead of silently choosing a convenient answer.
7. As a user, I want BeeMax to forget selected information on request, so that removed evidence and all derived views can be deleted consistently.
8. As a user, I want BeeMax to remember successful work across sessions and restarts, so that a new conversation does not reset its practical experience.
9. As a user, I want BeeMax to resume an unfinished Objective from durable state, so that conversation summaries never become the only recovery mechanism.
10. As a user, I want BeeMax to load only relevant Memory and Skills, so that irrelevant history does not reduce answer quality.
11. As a user, I want the current request to remain complete even when supporting context is compacted, so that Memory cannot weaken my instructions.
12. As a user, I want BeeMax to learn from independently accepted outcomes, so that confident self-reporting is not mistaken for success.
13. As a user, I want BeeMax to identify which part of a failed workflow caused the failure, so that correct knowledge is not downgraded with the broken component.
14. As a user, I want BeeMax to try a safe alternative when a Tool or Skill fails, so that routine recovery does not require my participation.
15. As a user, I want BeeMax to retain failure lessons, so that it does not repeat a known invalid route.
16. As a user, I want a repaired Memory or Skill to be revalidated and restored, so that automatic downgrade is reversible rather than permanent deletion.
17. As a user, I want volatile facts to be refreshed during current-data tasks, so that old observations are never presented as current truth.
18. As a user, I want BeeMax to generate high-quality HTML and PDF reports using previously verified procedures, so that repeated work becomes faster and more stable.
19. As a user, I want every delivered Artifact to remain bound to source and Verification receipts, so that learning is based on observable output.
20. As a user, I want BeeMax to know what it is uncertain about, so that it can gather missing evidence before making a material claim.
21. As a user, I want BeeMax to create safe investigation work when evidence is missing, so that it learns actively instead of waiting for another failure.
22. As a project member, I want project Memory isolated from unrelated projects, so that relevant precedent is reusable without data leakage.
23. As a team member, I want repeated verified practices to become team Convention Candidates, so that useful experience can be shared deliberately.
24. As a team member, I want personal experience to remain private by default, so that scope expansion never happens merely because a model found it useful.
25. As an organization owner, I want organization knowledge to require authoritative evidence, so that repeated behavior does not automatically become official Policy.
26. As an organization owner, I want organization learning to preserve exceptions, so that a common practice is not applied to cases where it is known to fail.
27. As an organization owner, I want derived handbooks and summaries to be rebuildable, so that a bad summary cannot overwrite authoritative records.
28. As an organization owner, I want the system to explain why a Convention or Skill was promoted, suppressed, restored, or replaced, so that learning remains auditable.
29. As a security administrator, I want scope filtering to happen before ranking and limiting, so that inaccessible records cannot leak or hide accessible results.
30. As a security administrator, I want retrieved content treated as non-executable evidence, so that stored prompt injection cannot become Runtime instruction.
31. As a security administrator, I want Credentials rejected at every Memory and Skill write boundary, so that autonomous learning cannot persist secrets.
32. As a security administrator, I want learned behavior to remain inside existing Tool Governance, so that a Skill cannot create authority it was never granted.
33. As an operator, I want learning jobs to be idempotent, leased, and restartable, so that crashes do not duplicate promotions or corrupt projections.
34. As an operator, I want automatic learning rollout controlled per Profile, so that observation, retrieval contribution, promotion, and Skill canary can be introduced safely.
35. As an operator, I want learning and execution evidence reported separately from deterministic fixtures, so that simulated success is not presented as production stability.
36. As an operator, I want Memory-On and Memory-Off results compared on the same real tasks, models, Tools, and source snapshots, so that improvement claims are causal enough to trust.
37. As an operator, I want negative transfer measured, so that aggregate success cannot hide tasks made worse by Memory.
38. As an operator, I want latency and resource use observed without becoming an Objective-level abandonment rule, so that quality and completion remain primary.
39. As a developer, I want one Memory Learning Kernel interface, so that learning behavior can evolve without coupling the Agent loop to storage internals.
40. As a developer, I want lexical, semantic, extraction, and Verification providers behind narrow adapters with at least two real implementations where a seam is introduced, so that extension points are justified by actual variability.
41. As a developer, I want existing Claims, Episodes, Conventions, Workflows, Tasks, and Skills migrated additively, so that current Profiles remain readable and recoverable.
42. As a developer, I want outcome attribution to fail unknown rather than invent a cause, so that incomplete telemetry cannot punish an unrelated Memory or Skill.

## Implementation Decisions

### 1. Canonical domain model

- `Evidence` is an immutable or content-addressed observation retained while its
  authority record exists. Messages, Tool receipts, source receipts, Artifact
  receipts, Verification receipts, corrections, and feedback can supply Evidence.
- `Claim` is an explainable statement whose authority state is governed by scope,
  provenance, validity, stability, confidence, conflict, and correction links.
- `Episode` is one Situation, Action, Outcome, and Evidence bundle. It is
  experience, not a fact and not a Task checkpoint.
- `Convention` is a reviewed, correctable pattern supported by multiple Episodes.
  It is organizational understanding, not Policy or permission.
- `Workflow Candidate` is a declarative, instruction-only procedure derived from
  confirmed Conventions and verified Episodes.
- `Managed Skill` is an immutable, verified procedural version with a separate
  active projection, canary status, outcome history, and rollback path.
- `Projection` is a rebuildable human- or model-readable view such as a user
  summary, project handbook, organization playbook, or Skill index. A Projection
  is never an authority.
- `Situation Fingerprint` is a bounded, non-authorizing description of the task
  family, modalities, freshness needs, risk, output forms, and relevant open
  vocabulary used to assess applicability. It does not contain Access Scope.
- `Contribution Receipt` binds one recalled authority record, Projection,
  Capability, Skill version, Tool receipt, or source receipt to one execution and,
  where possible, one atomic outcome criterion.
- `Assessment` is a derived operational projection of applicability, utility,
  freshness, and risk for an authority record or managed Skill in a Situation.
  Assessment never changes truth, scope, Policy, or permission.
- `Learning Settlement` is the idempotent correlation of an execution trace,
  independent Verification result, Contribution Receipts, and attribution result.

Execution concepts remain separate. Objective, Work Contract, Task, Task Run,
Checkpoint, Effect, Artifact, Verification, and Delivery are current work state,
not cognitive Memory.

### 2. One deep Runtime seam

The Memory Learning Kernel is the only new public Core seam. Existing callers use
it as follows:

- conversation and planning context call `prepare`;
- trusted ingress, Tool finalization, Artifact settlement, feedback, and verified
  outcome publication call `observe`;
- independent Objective or Task Verification calls `settle`;
- the existing Profile scheduling mechanism calls `maintain`.

The Kernel accepts trusted dependencies and returns results. It does not read
process-global configuration, infer Access Scope from text, own an Agent loop, or
write Task state. Existing narrow Memory, execution-trace, Capability, Skill,
Verification, and scheduling ports remain adapters behind it.

### 3. Single persistence authority

Each Profile continues to own one SQLite Memory authority and one connection
authority. The implementation may be split into focused modules, but it must not
introduce a second long-term Memory database, vector database as a separate source
of truth, Task queue, scheduler, or Policy state machine.

Existing tables and records remain valid. New data is additive and content-free
where possible. A semantic index may be rebuilt from authoritative rows and is
therefore an adapter and projection, not a second authority.

### 4. Additive storage projections

The authority will add durable concepts equivalent to:

- learning settlements keyed by execution and Verification identity;
- contribution receipts keyed by execution, outcome criterion, component kind,
  component identity, and immutable version or digest;
- contextual assessments keyed by component identity, version, and Situation
  Fingerprint;
- source assessments keyed by source identity and domain of use;
- managed Skill outcome observations and current operational health;
- versioned derived projections with source watermark and content digest;
- consolidation and maintenance watermarks with lease/fencing metadata.

Raw customer content is not copied into content-free diagnostic projections.
Existing Claim Evidence and Episode content remain in their current scoped
authority. All migrations are forward-additive, transactionally backed up, and
openable by the previous read paths until the corresponding rollout is enabled.

### 5. Two-phase extraction and admission

Model-backed extraction is asynchronous and bounded. It reads a defined set of
retained Evidence and proposes a candidate bundle containing zero or more Claims,
Episodes, Corrections, Exceptions, Convention signals, Workflow signals, source
observations, capability gaps, and failure shields.

The extractor cannot write active authority records. A deterministic admission
implementation then verifies:

- Profile and exact conversation/business scope;
- referenced Evidence identity and retention;
- Credential and prompt-injection isolation;
- duplicate and correction relationships;
- time validity and required refresh behavior;
- conflict and exception links;
- promotion authority appropriate to record kind and risk.

Invalid output is rejected without weakening the current Objective. Provider
unavailability leaves the watermark retryable and does not fabricate an empty
successful extraction.

### 6. Authority state and operational state are separate

Truth and usefulness must never share one score or state transition.

Claims retain authority states such as Candidate, Active, Conflicted, Superseded,
Rejected, and Archived. Conventions retain Candidate, Confirmed, Rejected,
Superseded, and Rolled Back. Evidence and explicit corrections control these
states.

Separately, an Assessment determines whether an otherwise valid record is
eligible, cautious, or suppressed for a particular Situation. A fact can remain
true but be inapplicable; a Skill can remain a verified immutable version but be
temporarily unhealthy; an unavailable verifier must not make a source false.

### 7. Contextual confidence

Recall and routing use separate bounded dimensions rather than a single global
confidence number:

- truth confidence;
- freshness and validity;
- Situation applicability;
- observed downstream utility;
- evidence diversity and source quality;
- conflict and exception state;
- risk if the record is wrong;
- operational health for procedural components.

Assessments are specific to a Situation Fingerprint. Success in one task family
cannot automatically raise confidence in an unrelated domain.

### 8. Progressive Context Pack construction

The current user request, Work Contract, active Objective state, applicable Policy
constraints, corrections, and material conflicts are always preserved before
optional enrichment.

Enrichment proceeds progressively:

1. stable Profile preferences and a compact current summary;
2. top scoped Claims, Episodes, Corrections, Conflicts, and Exceptions;
3. relevant Convention or Workflow summaries;
4. selected Skill metadata followed by its explicitly routed module and declared
   resources;
5. raw Evidence only when a decision, conflict, or Verification step needs it.

Hard Access Scope and visibility filtering happens before candidate ranking,
semantic search, or limiting. Lexical retrieval remains mandatory, including a
Chinese/no-space fallback. Semantic retrieval is an optional ranking adapter over
the same legal candidate set. Retrieved material is escaped and marked as
non-executable evidence.

Per-read size and count bounds protect integrity and model context quality. They
are not cumulative Objective token, cost, turn, or wall-clock completion ceilings.
Long work continues through checkpoints and later turns instead of silently timing
out or abandoning the accepted Objective.

### 9. Contribution receipts and outcome attribution

Every Context Pack records the immutable identities and digests of contributed
Claims, Episodes, Projections, Conventions, Workflow Candidates, and Skill
versions. Capability and Tool paths already produce receipts and execution events;
the settlement joins these identities to atomic Work Contract outcomes and
independent Verification.

Attribution uses two layers:

- deterministic correlation establishes what was actually recalled, selected,
  called, completed, verified, or unavailable;
- a bounded model may propose causal responsibility only among correlated
  components, with cited trace evidence.

The authority accepts supported attribution, narrows it to the smallest component,
or records `unknown`. It must distinguish at least source staleness, retrieval
miss, planning error, Capability mismatch, provider unavailability, Tool execution
failure, Skill inapplicability, Skill execution deviation, Artifact invalidity,
Verification unavailable, authorization block, and unknown cause.

No Memory or Skill is penalized when Verification is unavailable, authority is
missing, the execution was cancelled, or causal evidence is ambiguous.

### 10. Reinforcement, downgrade, and recovery

Accepted outcomes reinforce only correlated components in matching Situations.
Rejected outcomes can reduce operational utility only when attribution is
supported. Explicit user correction immediately affects the relevant authority
chain but does not silently generalize to broader scopes.

Automatic downgrade changes operational eligibility, not historical Evidence. It
uses minimum sample sizes, evidence diversity, risk-weighted thresholds,
hysteresis, and separate recovery thresholds. One failure can immediately
suppress a high-risk component when direct evidence proves it unsafe; ordinary
components require repeated or severe attributed failures.

A suppressed Skill route falls back to another healthy Capability or the last
stable verified Skill version. A suppressed Memory is omitted from ordinary
context but remains available to explain, investigate, and revalidate. Successful
independent revalidation can restore eligibility. Every transition records its
reason, evidence references, prior state, new state, and timestamp.

### 11. Promotion policy

The model never directly promotes active Memory, organization knowledge, managed
Skills, Policy, Grants, Providers, or executable code.

Low-risk personal preferences and stable facts may promote automatically when an
explicit user statement or sufficient independent evidence satisfies configured
policy. Volatile facts require validity and refresh metadata. Project or
organization promotion requires broader-scope authority and cannot be inferred
from repeated private behavior. Formal Policy and permission are never produced
from Memory.

Promotion thresholds are risk-tiered. Existing minimum independent Skill trials
remain a floor, not proof that two successes are sufficient for every Skill.

### 12. Derived knowledge projections

The Kernel produces versioned, content-addressed, rebuildable projections such as:

- user working preferences;
- current project memory summary;
- project handbook;
- organization playbook;
- recent verified outcome summaries;
- known failure shields;
- Skill and Capability index.

Each Projection records its scope, source watermark, authority inputs, generator
version, content digest, and creation time. A stale, corrupted, or invalid
Projection is discarded and rebuilt. A user edit is ingested as correction or
candidate Evidence; it does not mutate authority invisibly.

### 13. Procedural learning and Skill self-growth

The existing Episode to Convention Candidate to confirmed Convention to Workflow
Candidate to quarantined Skill Candidate chain remains canonical.

L4 adds automatic proposal after repeated verified outcomes, representative
scenario generation, evidence-diversity checks, regression replay, Situation-bound
canary routing, continuous health assessment, automatic probation, and safe
rollback to a prior immutable version.

Learned Skills remain declarative and instruction-only unless a separately
installed Tool provides governed execution. They cannot contain Credentials,
embedded installers, undeclared files, undeclared Tools, Policy, or authority.
Every Tool call still passes normal Tool Governance and Effect handling.

### 14. Active learning and capability gaps

When the Kernel identifies a material uncertainty, stale source, unverified Skill,
or missing Capability, it may emit a bounded Learning Goal. If satisfying that
goal requires external work, the existing Objective and Task system owns the
investigation. The Kernel does not create a hidden execution loop.

Read-only and pre-authorized reversible investigation can proceed unattended.
Missing Credentials, absent legal authority, irreversible action, or materially
ambiguous intent remains an honest blocker. A missing Tool may trigger governed
discovery or acquisition, but Memory cannot invent a Tool result or bypass its
installation and health checks.

### 15. Three learning cadences

- The fast loop runs inside an Objective and performs fallback, evidence gathering,
  local correction, and checkpointed recovery without changing durable learning
  authority.
- The settlement loop runs after independent Verification and creates the Episode,
  Learning Settlement, Contribution attribution, and candidate updates.
- The maintenance loop runs from the existing Profile scheduler after watermark
  changes and periodically for consolidation, revalidation, projection rebuild,
  decay, Skill regression, and archive review.

Maintenance is idempotent, leased, fenced, restartable, and scoped. It must not add
a new general Task queue or scheduler. Work that needs Tools becomes a normal
durable Objective.

### 16. Source reliability is domain-specific

Source assessment is learned only from observable agreement, freshness,
corrections, and Verification in a bounded domain of use. A source that performs
well for one market or document type does not receive global authority. Source
assessment is a ranking signal and cannot override an explicit authoritative
source required by the Work Contract.

### 17. Security, privacy, and poisoning controls

- Access Scope is supplied only by trusted composition and never appears inside a
  model-generated Situation Fingerprint.
- Scope filtering precedes rank and limit for every retrieval implementation.
- Candidate extraction treats all source content as untrusted data.
- Stored instruction-like content is non-executable unless it is an independently
  promoted managed Skill loaded through the Skill Runtime.
- Credential material is rejected or redacted before Evidence, Candidate,
  Projection, trace, and Skill persistence.
- Personal-to-project and project-to-organization scope changes require explicit
  trusted authority and retain source lineage.
- Forgetting removes or tombstones authority according to retention policy and
  invalidates every dependent Projection and assessment.
- Organization-wide learning cannot publish Enterprise Policy, grant Tool access,
  or change an active Objective.

### 18. Rollout

Rollout reuses the existing Profile rollout and governance mechanisms rather than
adding a global intelligent/conservative mode. The sequence is:

1. settlement observation with no context or routing influence;
2. shadow extraction and attribution;
3. shadow Context Pack comparison;
4. eligible personal/project recall contribution;
5. automatic low-risk candidate promotion;
6. Skill candidate generation and read-only canary;
7. automatic operational downgrade and rollback;
8. broader organization learning only where authority and metrics permit it.

Emergency stop disables new learning influence while preserving Evidence and the
ability to inspect or roll back. It does not delete history or interrupt an
unrelated accepted Objective.

### 19. Delivery sequence

The implementation is divided into dependency-ordered slices:

1. Freeze the current deterministic and real-run Memory baseline and version the
   L4 evaluation corpus.
2. Add Learning Settlement, Contribution Receipt, contextual Assessment, and
   projection contracts with additive migrations and authority tests.
3. Implement the Kernel seam in observe-only mode and correlate current execution,
   Capability, Skill, Artifact, and Verification receipts.
4. Add asynchronous candidate extraction and deterministic admission.
5. Upgrade recall to contextual hybrid ranking and progressive Context Packs.
6. Add derived knowledge consolidation and rebuildable projections.
7. Add criterion-level attribution, reinforcement, automatic suppression,
   revalidation, and recovery.
8. Add automatic Workflow and Skill proposal, canary, health monitoring, and
   rollback orchestration around the existing Skill lifecycle.
9. Add safe Learning Goals through the existing durable Objective path.
10. Run shadow rollout, paired real-task certification, staged Profile rollout,
    and final release-boundary verification.

No later slice may be enabled before the prior slice has produced durable evidence
and passed its regression gate.

## Testing Decisions

### Primary test seam

Tests target the four public Memory Learning Kernel behaviors and the existing
production runtime paths that call them. They assert returned Context Packs,
durable authority transitions, receipts, verified outcomes, recovery, and visible
delivery behavior. Tests do not assert private SQL statements, prompt wording, or
internal model chain-of-thought.

Existing Memory recall, correction/conflict, Convention consolidation, Workflow
candidate, Skill learning, execution trace, Task recovery, Artifact Verification,
architecture boundary, and release-boundary suites are prior art and remain green.

### Deterministic contract tests

- exact Profile, conversation, project, organization, and visibility isolation;
- filtering before rank and limit, including inaccessible high-rank distractors;
- English, Chinese spaced text, and Chinese continuous-text retrieval;
- extraction admission, idempotency, deduplication, and invalid evidence identity;
- Claim correction, conflict, expiry, revocation, forgetting, and Projection
  invalidation;
- accepted, rejected, unavailable, cancelled, and unknown-attribution settlements;
- criterion-level contribution correlation;
- automatic suppression hysteresis, recovery thresholds, and false-demotion
  protection;
- source-domain isolation;
- Skill candidate quarantine, canary, immutable versions, probation, rollback, and
  active-version fencing;
- crash and lease-expiry recovery during extraction, settlement, consolidation,
  projection publish, and Skill transition;
- Credential, prompt-injection, scope-escalation, Policy-forgery, and poisoned
  Projection rejection.

### Simulated-fault tests

Inject source drift, Tool unavailability, provider failure, malformed model output,
stale Projection, corrupted semantic index, duplicate delivery, unknown Effect,
Verification outage, process kill, concurrent settlement, and partial migration.
The expected behavior is local attribution, retry or safe fallback, no duplicate
promotion, no authority expansion, and no unrelated Memory downgrade.

### Real-model and real-Tool tests

Run a versioned recurring-work corpus with the same real model versions, Work
Contracts, Tool inventory, authority, source snapshot or time window, and verifier
for paired Memory-Off and Memory-On trials. Include at minimum:

- time-sensitive research with source-backed HTML and PDF;
- structured data analysis and spreadsheet delivery;
- code investigation and verified change;
- browser work;
- multimodal input;
- project and organization recall;
- correction, conflict, expiry, and forgetting;
- repeated workflow learning;
- missing-Capability recovery;
- transient failure and restart;
- negative cases where Memory and Skills must not activate.

Deterministic, simulated-fault, live-provider, live-main-model, and real end-to-end
results remain separate. A mock, fixture, or routing-only result cannot count as a
real task success.

### Initial release gates

- cross-scope or cross-Profile retrieval: exactly zero;
- active Claim and promoted Skill provenance coverage: 100%;
- correction and forgetting propagation to dependent Context Packs and
  Projections: 100%;
- critical organization fact false promotion: zero;
- general promoted-memory precision: at least 98%;
- scoped Recall@5: at least 90%, with zero forbidden retrieval;
- labeled causal-attribution accuracy: at least 90%, while unsupported cases remain
  `unknown` rather than guessed;
- automatic downgrade precision: at least 95%, with false downgrade at or below
  2%;
- accepted managed-Skill route completion: at least 95%, with zero candidate
  contamination of active behavior;
- crash/restart exactly-once settlement, promotion, rollback, and Projection
  publication: 100% in the fault corpus;
- Memory-On improves accepted completion by at least 10 percentage points on the
  recurring-work corpus without regressing any safety gate;
- negative transfer is at or below 2% of paired cases;
- user interventions per repeated accepted Objective decrease by at least 30%;
- stability claims require at least five independent current-version repetitions
  per representative task family across at least two real model providers and
  separate time windows.

These are release targets, not current results. Statistical reports include sample
counts and confidence intervals; a single accepted run is evidence of capability,
not proof of stability.

### Performance evidence

Measure Context construction, retrieval latency, model and Tool turns, recovery
attempts, end-to-end duration, and report-class P95. The representative research
report target remains five minutes where external providers are healthy. Resource
metrics are diagnostic and optimization inputs, not cumulative Objective
abandonment conditions.

## Out of Scope

- foundation-model fine-tuning or autonomous weight updates;
- embedding or invoking another general-purpose Agent runtime inside BeeMax;
- a second Agent loop, Memory authority, Task queue, scheduler, Capability router,
  Policy engine, or Skill loader;
- model-authored executable code or unrestricted package installation as learning;
- automatic Credential discovery, permission escalation, Policy publication, or
  irreversible external action;
- automatic cross-tenant or cross-organization knowledge sharing;
- treating a derived summary, vector index, model confidence, or repeated behavior
  as formal authority;
- claiming universal task completion from a finite benchmark;
- making token usage, cost, total turns, or elapsed Objective lifetime a silent
  terminal failure condition.

## Further Notes

The implementation contract is
[`docs/architecture/l4-memory-learning-architecture.md`](../../architecture/l4-memory-learning-architecture.md).
The migration, rollout, real-test protocol, metric definitions, and release gates
are fixed by
[`docs/operations/l4-memory-learning-rollout-and-certification.md`](../../operations/l4-memory-learning-rollout-and-certification.md).
The authority decisions are recorded in ADRs
[`0008`](../../adr/0008-use-one-profile-semantic-memory-authority.md),
[`0009`](../../adr/0009-separate-semantic-truth-from-operational-utility.md), and
[`0010`](../../adr/0010-settle-learning-only-from-correlated-independent-verification.md).

The current BeeMax implementation is an L3-quality foundation with several L4
building blocks already present: typed and scoped Claims, provenance, correction
and conflict chains, verified Episodes, Convention rollback, Workflow lineage,
progressive Skill loading, Skill candidate quarantine, independent trials,
immutable versions, rollback, Artifact Verification, Execution Trace, and durable
Task recovery.

The work in this specification is primarily integration and feedback closure. The
largest missing capabilities are automatic bounded extraction, contribution
receipts, criterion-level outcome attribution, contextual assessment, derived
knowledge projections, automatic operational downgrade and restoration, and
continuous Skill canary health.

BeeMax remains the sole product identity and Runtime. Research inputs may influence
architecture decisions, but no external Agent identity, prompt, package tree,
runtime dependency, home-directory convention, or execution path enters the
production package.
