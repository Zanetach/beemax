# BeeMax L4 Memory Learning Architecture

Status: implementation-ready design

Owner: BeeMax Runtime

Related product specification: [BeeMax L4 Outcome-Driven Memory and Learning System](../superpowers/specs/2026-07-18-beemax-l4-memory-learning-system.md)

Release certification: [L4 Memory Learning Rollout and Certification](../operations/l4-memory-learning-rollout-and-certification.md)

Decisions: [single authority](../adr/0008-use-one-profile-semantic-memory-authority.md), [truth versus utility](../adr/0009-separate-semantic-truth-from-operational-utility.md), [verified settlement](../adr/0010-settle-learning-only-from-correlated-independent-verification.md)

## 1. Purpose

This document is the implementation contract for BeeMax L4 Memory. It turns the
product specification into concrete Module boundaries, Interfaces, storage
records, algorithms, state machines, transaction rules, recovery behavior, and
delivery slices.

The design has one governing outcome: verified experience should make later work
more likely to succeed without allowing remembered content to expand authority,
overwrite truth, leak across scope, or create a second Agent loop.

This is a design baseline, not a claim that L4 has already shipped. The current
Runtime remains usable while the slices in section 20 are introduced additively.

## 2. Architectural invariants

The following invariants are release-blocking:

1. One Profile has one semantic Memory authority. Claims, Episodes, Candidates,
   assessments, projections, contribution receipts, and learning settlements are
   stored through the same Profile-bound SQLite authority.
2. Durable Objective, Task, Task Run, Effect, Checkpoint, Verification, approval,
   and delivery state remain execution authorities. Memory observes their signed
   outcomes but never owns or rewrites them.
3. Semantic truth and operational utility are separate. A correct Claim can be
   temporarily unhelpful; a useful route can contain stale facts. Outcome failure
   cannot directly change Claim confidence, validity, correction, or provenance.
4. Learning settles only from independently verified, correlated outcomes.
   Unavailable Verification, cancellation, authorization denial, and ambiguous
   attribution result in `unknown`, not a guessed failure.
5. Trusted Access Scope is filtered before candidate ranking and limiting. A
   relevance model never sees or returns inaccessible candidates.
6. Current user input, accepted Work Contract, active Task preservation, trusted
   runtime facts, corrections, and conflicts never compete with optional Memory
   for context budget.
7. Stored evidence is non-executable. Only a promoted, signed managed Skill can
   become executable procedure, and it remains subject to current Tool and Effect
   governance.
8. Every Memory contribution that can influence execution has an immutable,
   content-free Contribution Receipt committed before the Context Pack is returned.
9. Model calls occur outside SQLite write transactions. A leased operation may
   commit only if its claim token, input digest, authority watermark, and dependent
   revisions remain current.
10. All automated transitions are idempotent, fenced, auditable, reversible where
    possible, and controlled by the existing Profile rollout authority.
11. Learning may create a normal durable Objective when external investigation is
    required. It does not create another Task queue, scheduler, router, Policy
    engine, Skill loader, or general-purpose Agent Runtime.
12. Token use, cost, total turns, and elapsed Objective lifetime are observations,
    not silent terminal conditions. Per-call size and integrity bounds remain
    mandatory.

## 3. Current foundation and target seams

The design deliberately deepens existing Modules instead of replacing them.

| Existing Module or seam | Current responsibility | L4 use |
| --- | --- | --- |
| `MemoryStore` in `@beemax/memory` | Profile-bound SQLite, Claims, Episodes, Candidates, evidence, Task persistence | Implements the L4 authority Adapter and additive tables |
| `memoryPersistencePorts()` | Projects one store into narrow persistence ports | Exposes the new authority port without constructing another store |
| `ConversationContext` | Records a Turn and builds ranked context | Delegates optional Memory preparation to `MemoryLearningKernel.prepare` |
| `ExecutionEnvelope` | Trusted execution and scope identity | Supplies the immutable identity for every Context Pack and settlement |
| `ExecutionTraceSink` | Content-limited execution receipts | Fans out normalized learning observations to the Kernel Adapter |
| criterion Verification and `TaskGraph` | Independent accepted/rejected/unavailable outcomes | Creates transactionally correlated learning signals |
| verified Objective publisher | Publishes verified Episode after delivery | Atomically publishes Episode plus a learning signal |
| managed Skill lifecycle | Quarantine, independent trials, signed immutable versions, rollback | Adds health assessment, deterministic canary selection, and automatic rollback |
| Profile task scheduler | Fair in-process Profile work scheduling | Runs bounded `maintain` work; no new scheduler is introduced |
| Profile autonomy rollout | Feature-specific authority and emergency stop | Adds the `adaptive_learning` level and preserves existing governance |

`@beemax/core` must not import `@beemax/memory`. Core owns the public Interface and
the storage-independent Implementation; `@beemax/memory` implements the SQLite
Adapter; the application composition root wires both. This keeps dependency
direction unchanged.

## 4. The deep Module

`MemoryLearningKernel` is a deep Module: its Interface is four operations while
its Implementation hides extraction, admission, retrieval, contribution tracking,
attribution, assessment, projection, maintenance, and Skill health coordination.

```text
Agent Runtime / Objective Runtime / Profile Scheduler
                         |
                         v
             MemoryLearningKernel Interface
          prepare | observe | settle | maintain
                         |
            DefaultMemoryLearningKernel
          /              |                 \
         v               v                  v
MemoryLearningAuthority  LearningExtractor  ManagedSkillLearning
      Adapter                 Adapter              Adapter
         |                    |   |                 |
         v                    v   v                 v
one Profile SQLite     deterministic/model     signed version store
semantic authority       Implementations       + in-memory test store
```

The Interface is the primary test surface. Internal SQL, prompt wording, vector
provider details, and consolidation batching are private Implementation choices.

### 4.1 Public Interface

The exact TypeScript shapes may be split across files, but their semantics are
fixed by this contract:

```ts
export interface MemoryLearningKernel {
  prepare(input: PrepareMemoryInput): Promise<ContextPack>;
  observe(input: MemoryObservation): ObservationReceipt;
  settle(input: SettleLearningInput): Promise<LearningSettlement>;
  maintain(input: MaintainMemoryInput): Promise<MaintenanceResult>;
}
```

All methods accept complete values and return results. No caller receives a
mutable database handle, model client, ranking callback, or Skill directory.

### 4.2 `prepare`

```ts
export interface PrepareMemoryInput {
  envelope: ExecutionEnvelopeRef;
  situation: Situation;
  workContract?: WorkContractRef;
  query: string;
  queryDigest: string;
  requiredItems: readonly RequiredContextItem[];
  maxOptionalChars: number;
  policyVersion: string;
}

export interface ContextPack {
  packId: string;
  executionId: string;
  authorityWatermark: number;
  situationFingerprint: SituationFingerprint;
  requiredItems: readonly ContextContribution[];
  optionalItems: readonly ContextContribution[];
  receipts: readonly ContributionReceipt[];
  safePrefix: string;
  omitted: Readonly<Record<ContextOmissionReason, number>>;
  createdAt: number;
}
```

`prepare` applies trusted scope gates, retrieves candidates, ranks already scoped
IDs, resolves budget priority, renders evidence as non-executable data, and commits
the Context Pack and receipts before returning. The caller appends the current
request outside `maxOptionalChars`.

If optional receipt persistence fails, optional Memory is omitted. Required
runtime facts and Task preservation still return, with a degraded receipt. No
untracked optional Memory may affect execution.

### 4.3 `observe`

```ts
export type MemoryObservation =
  | ConversationEvidenceObservation
  | SourceEvidenceObservation
  | UserFeedbackObservation
  | CorrectionObservation
  | ExecutionLearningObservation
  | SkillLifecycleObservation;

export interface ObservationReceipt {
  observationId: string;
  accepted: boolean;
  reasonCode: ObservationReasonCode;
  evidenceDigest?: string;
  learningSignalId?: string;
  recordedAt: number;
}
```

`observe` is synchronous and locally bounded so it can be used from the existing
trace sink. It validates Profile identity, trusted scope, evidence identity,
content limits, Credential rejection, and deduplication; then appends evidence or
a normalized signal. It does not call a model, promote a Candidate, or block a
Tool call on maintenance work.

### 4.4 `settle`

```ts
export interface SettleLearningInput {
  envelope: ExecutionEnvelopeRef;
  subject: LearningSubjectRef;
  verificationRevision: number;
  verificationDigest: string;
  criteria: readonly CriterionOutcome[];
  deliveryReceiptRefs: readonly string[];
  artifactReceiptRefs: readonly string[];
  policyVersion: string;
}

export interface LearningSettlement {
  settlementId: string;
  status: "settled" | "duplicate" | "deferred" | "rejected";
  outcome: "accepted" | "rejected" | "unavailable" | "cancelled" | "mixed";
  attributionStatus: "supported" | "partial" | "unknown";
  appliedAssessmentEvents: readonly string[];
  proposedTransitions: readonly LearningTransitionRef[];
  reasonCodes: readonly string[];
  settledAt?: number;
}
```

`settle` binds independent criterion outcomes to stored Contribution Receipts,
Capability receipts, Tool receipts, Skill lifecycle receipts, artifacts, and the
content-limited execution trace. It is idempotent on subject, Verification
revision, and policy version. A later Verification revision produces a new
settlement and supersedes the prior assessment events rather than editing history.

### 4.5 `maintain`

```ts
export interface MaintainMemoryInput {
  profileId: string;
  trigger: "scheduled" | "signal" | "manual" | "recovery";
  maxItems: number;
  maxModelCalls: number;
  leaseMs: number;
  now: number;
}

export interface MaintenanceResult {
  claimed: number;
  completed: number;
  deferred: number;
  failed: number;
  transitions: readonly LearningTransitionRef[];
  createdObjectiveIds: readonly string[];
  nextWatermarks: Readonly<Record<string, number>>;
}
```

`maxItems`, `maxModelCalls`, and `leaseMs` bound one maintenance invocation for
fairness and crash recovery; they do not limit a user Objective. Deferred work
remains durable and is resumed by the existing scheduler.

### 4.6 Error semantics

Expected operational conditions are returned as typed results and reason codes:

- `degraded` means safe fallback completed the caller's immediate need;
- `deferred` means durable work remains eligible and scheduled;
- `unknown` means evidence is insufficient and no utility penalty was applied;
- `rejected` means the input violated identity, scope, schema, integrity, or safety
  admission and will not be retried unchanged;
- thrown errors are reserved for broken programmer invariants or unavailable
  required authority at composition time.

No attempt count converts a valid user or maintenance outcome into silent
abandonment. Repeated transient failure increases backoff, emits an alert, and
retains durable eligibility. Invalid or unsafe input is quarantined with an
explanation rather than retried forever.

## 5. Internal Interfaces and justified Adapters

Only seams with real variability receive Adapters.

### 5.1 `MemoryLearningAuthorityPort`

This is the narrow Core Interface implemented by the SQLite Adapter in
`@beemax/memory`. It groups transactional use cases, not individual SQL tables:

- append and deduplicate Evidence and observations;
- retrieve an already authorized candidate set;
- atomically commit a Context Pack and Contribution Receipts;
- enqueue, lease, fence, complete, and reconcile learning signals;
- read correlation bundles for settlement;
- append settlement, attribution, and assessment events atomically;
- publish or invalidate immutable projections and swap their current pointer;
- read and compare assessment revisions;
- apply correction, forgetting, and dependent invalidation;
- read/write maintenance watermarks;
- store managed Skill lineage and health references.

The production SQLite Adapter and an in-memory contract-test Adapter are two real
Implementations. The in-memory Implementation is test-only and cannot be selected
by production composition.

### 5.2 `LearningExtractorPort`

Two real Implementations exist:

- deterministic extraction for explicit corrections, preference declarations,
  known receipts, structured Tool results, and frozen tests;
- model-backed bounded extraction for open-ended evidence.

Both return proposals with source spans or evidence references. Admission remains
deterministic and inside the Kernel; a model cannot write authority directly.

### 5.3 `CandidateRankerPort`

Two production behaviors justify this seam:

- deterministic multilingual lexical ranking, including CJK character grams;
- optional semantic or model reranking over an already scoped, bounded candidate
  ID set.

The reranker cannot introduce IDs, alter scope, suppress required corrections, or
turn content into instruction. Invalid or unavailable semantic ranking falls back
to the deterministic score.

### 5.4 `AttributionPort`

Two Implementations exist:

- deterministic correlation and rule attribution;
- model-assisted attribution over only the correlated component IDs and
  content-limited evidence bundle.

The deterministic validator owns the cause taxonomy and decides whether a model
proposal is supportable. Unsupported output becomes `unknown`.

### 5.5 `ManagedSkillLearningPort`

Production uses the existing signed immutable Skill version store; tests use an
in-memory signed store. The Interface accepts candidate content and activation
decisions, then returns signed receipts. SQLite never claims activation until the
receipt has been verified and committed.

There is no generic provider registry for single-use helpers such as clock,
digests, normalization, or threshold lookup. Those remain constructor
dependencies or private functions until real variability exists.

### 5.6 Planned code ownership

The exact file split may follow repository conventions, but package ownership is
fixed:

| Package | Planned responsibility |
| --- | --- |
| `@beemax/core` | public contracts, default storage-independent Kernel Implementation, Situation fingerprint, retrieval composition, attribution validator, assessment policy, projection validator, trace Adapter, managed Skill selection policy |
| `@beemax/memory` | numbered migrations, `SqliteMemoryLearningAuthority` Adapter, scoped queries, atomic use cases, leases/fences, reconciliation scans, backup/restore verification |
| `apps/cli` | composition root, real extractor/ranker/attributor/Skill Implementations, scheduler registration, rollout wiring, verified Objective publisher replacement |
| existing Skill Runtime | exact selected-version loading and signed lifecycle receipts |
| existing Objective/Task Runtime | terminal outcomes, independent Verification references, normal Learning Objective execution |

Core must remain buildable and testable without SQLite. Memory must not construct a
model client or call a Tool. Application composition must fail fast if the Kernel
is enabled without a Profile-matched authority Adapter, trusted rollout authority,
or signed Skill Implementation.

## 6. Composition and call sites

The application root creates exactly one `MemoryStore` for a Profile, projects its
existing ports plus `memoryLearningAuthority`, builds the internal Adapters, then
constructs one `DefaultMemoryLearningKernel`.

### 6.1 Agent Turn

1. Agent Runtime creates the trusted `ExecutionEnvelope`.
2. Situation Builder and Work Contract produce the bounded intent inputs.
3. `ConversationContext` calls `kernel.prepare`.
4. The Context Pack safe prefix is inserted as non-executable evidence.
5. The full current request is appended outside the optional Memory budget.
6. Runtime executes the normal model/Tool loop.
7. A fan-out `ExecutionTraceSink` writes the diagnostic trace and sends normalized,
   content-free observations to `kernel.observe`.

### 6.2 Task and Objective settlement

Accepted Task settlement appends a learning signal in the same SQLite transaction
as `TaskRun + Task` success. Rejected, unavailable, cancelled, and superseded
results are observed through the trace Adapter and recovered by ledger
reconciliation if the process stops before observation.

Verified Objective publication becomes one authority operation that atomically
upserts the Episode and enqueues a learning signal. It replaces the current
composition that only calls `upsertEpisode`.

The Profile scheduler later calls `settle` or `maintain`. The user-facing delivery
does not wait for projection generation or Skill learning.

### 6.3 Maintenance that requires external work

Internal work such as extraction, admission, assessment, projection, expiry, and
index rebuild stays inside `maintain`. Current web evidence, Tool execution, or
external verification requires a normal durable Objective with a Work Contract,
Policy evaluation, Effect handling, Verification, and delivery rules. Its result
returns through the same settlement path.

## 7. Authority model

### 7.1 One Memory, multiple representations

“One Memory” means one semantic authority per Profile, not one table or one blob.
The authority may contain normalized records, append-only events, search indices,
immutable projections, and procedural artifacts with signed references.

The following are authoritative semantic records:

- Evidence identity and provenance;
- active/corrected/conflicted/revoked Claims;
- verified/conflicted/superseded Episodes;
- Convention and Workflow Candidates with transition evidence;
- Contribution Receipts and Learning Settlements;
- append-only operational assessment events;
- projection manifests and current pointers;
- managed Skill lineage, selection, and health references.

FTS tables, vector indices, caches, compiled long-term snapshots, summaries, and
handbooks are rebuildable. They must never be the only copy of evidence or truth.

Signed Skill files are immutable procedural artifacts, not a second semantic
Memory. SQLite holds their digest, lineage, status, assessment, and signed receipt;
the filesystem holds the exact loadable content.

### 7.2 Three independent state planes

| Plane | Examples | May change it |
| --- | --- | --- |
| semantic truth | Claim validity, correction, conflict, evidence, Episode status | source evidence, trusted correction, explicit authority, expiry rules |
| operational utility | contextual success estimate, cautious/suppressed state, Skill health | correlated independent outcomes and revalidation |
| execution responsibility | Objective, Task, Effect, Checkpoint, approval, delivery | existing execution state machines only |

Cross-plane changes occur only through explicit events. A Tool failure can lower
the Tool route assessment but cannot revoke the factual Claim it was rendering.

## 8. Persistent data model

All new records live in the current Profile SQLite database and use additive,
numbered migrations. Timestamps are integer Unix milliseconds. Digests use the
repository's canonical cryptographic digest format. JSON fields are canonicalized
before hashing.

Every scope-bearing table stores normalized `profile_id`, `platform`, `chat_id`,
`user_id`, `thread_id`, `project_id`, `organization_id`, and `visibility` where
applicable. A `scope_key` is a stable identity/index key, never authorization.

### 8.1 New tables

#### `memory_context_packs`

| Column group | Required content |
| --- | --- |
| identity | `pack_id` primary key, `execution_id`, optional Objective/Task/Run IDs |
| scope | normalized trusted scope columns and `scope_key` |
| inputs | `situation_fingerprint`, bounded fingerprint JSON, `query_digest`, `work_contract_digest`, `policy_version` |
| fencing | `authority_watermark`, `status`, `revision` |
| accounting | required/optional character counts, included/omitted counts by reason |
| lifecycle | `created_at`, `invalidated_at`, `invalidation_reason` |

Unique `(profile_id, execution_id, query_digest, policy_version, revision)` makes
retries idempotent. No raw query or rendered context is stored here.

#### `memory_contribution_receipts`

| Column group | Required content |
| --- | --- |
| identity | `receipt_id`, `pack_id`, `execution_id`, `receipt_digest` |
| component | `component_kind`, `component_id`, immutable `component_version`, `component_digest` |
| use | `phase`, `role`, rank, final score, applicability state, optional criterion/requirement binding |
| provenance | evidence/trace reference IDs, ranker version, policy version |
| lifecycle | `created_at`, `invalidated_at`, reason |

`component_kind` is one of `claim`, `episode`, `convention`, `workflow`,
`projection`, `source`, `capability`, `tool`, `skill`, or `artifact`. A unique
receipt digest prevents duplicate influence accounting.

#### `memory_learning_signals`

This is a transactional outbox and bounded work registry, not a Task queue.

| Column group | Required content |
| --- | --- |
| identity | `signal_id`, source kind/id/revision/digest, Profile |
| work | signal type, priority, status, attempt count, next eligible time |
| lease | holder, token, leased/expiry times |
| fence | input digest, authority watermark, policy version |
| result | completion digest, reason code, created/updated/completed times |

Unique `(profile_id, source_kind, source_id, source_revision, signal_type)` gives
exactly-once logical processing with at-least-once execution.

#### `memory_learning_settlements`

Stores one immutable result per subject Verification revision and policy version:
subject identity, outcome, criterion digest, correlation digest, attribution
status, superseded settlement ID, timestamps, and reason codes. The record stores
references and digests rather than customer artifact content.

#### `memory_attributions`

Each row binds one settlement criterion to one correlated component version, cause
code, contribution strength, positive/failure weight, supporting receipt IDs,
attributor version, validator result, and confidence band. Rejected model proposals
remain audit rows with zero assessment weight.

#### `memory_assessments`

One materialized assessment per `(component kind, component ID, component version,
situation fingerprint or GLOBAL)`: Beta counts, accepted/failure weights,
consecutive outcomes, posterior mean, state, risk tier, revision, last outcome,
and transition timestamp. This table is an operational projection, not truth.

#### `memory_assessment_events`

Append-only deltas linking settlement, attribution, old/new revision, success and
failure weights, prior and resulting state, threshold policy version, reason code,
and creation time. Superseded settlement compensation is expressed as inverse
events; history is not edited.

#### `memory_projections`

Immutable projection versions with projection kind, scope, version, status,
content digest, optional safe content payload, generator/model/policy version,
input watermark/digest, current/superseded times, and validation result. Current is
selected through a separate unique pointer per `(scope, projection kind)`.

#### `memory_projection_inputs`

Links a projection version to every authoritative input kind, ID, immutable
version/digest, assertion IDs, and role. Correction, forgetting, expiry, or scope
change can therefore invalidate all dependent projections deterministically.

#### `memory_maintenance_watermarks`

Tracks Profile and job kind, last processed sequence, last successful time, lease
fence, failure count, and last reason code. It enables bounded restartable scans.

### 8.2 Existing table changes

Add only nullable/defaulted columns and indices where possible:

- Task/Task Run and verified Objective settlement paths gain an atomic learning
  signal insert;
- managed Skill records gain stable/canary pointers, risk tier, and assessment
  reference without changing immutable version contents;
- current Claim/Episode/Convention/Workflow records gain explicit immutable
  version/digest references where missing;
- Profile autonomy rollout accepts `adaptive_learning`;
- `memory_schema_migrations` records numbered L4 migrations, checksums, applied
  time, and application version.

### 8.3 Retention defaults

Profile policy may shorten or extend these periods, subject to legal policy:

| Record | Default |
| --- | --- |
| active semantic authority and supporting evidence | existing authority retention; retained while active unless privacy policy requires deletion |
| Context Packs and content-free Contribution Receipts | 90 days |
| settlements, attributions, assessment events | 365 days |
| projections | current plus three prior versions, maximum 180 days |
| learning signal operational rows | compact completed payload after 30 days; retain settlement reference |
| managed signed Skill versions | until explicit governed purge |

Privacy deletion overrides retention. Forgetting deletes or tombstones the selected
authority, invalidates receipts and dependent projections in the same transaction,
and schedules index deletion. An assessment derived solely from forgotten inputs
is removed; mixed assessments receive inverse events for attributable weights.

### 8.4 Internal record state machines

#### Learning signal

```text
pending -> leased -> completed
   ^         |
   |         +-> deferred -> pending at next_eligible_at
   +---------+   lease expiry or fence rejection

pending/leased -> quarantined only for immutable invalid or unsafe input
```

Transient provider, model, SQLite-busy, or Verification failure is `deferred`, not
quarantined. A lease token uniquely fences one attempt. `completed` stores the
result digest; the full semantic result lives in its authority table.

#### Settlement

```text
signal pending -> deferred (missing terminal evidence)
               -> settled (supported, partial, or unknown attribution)
               -> rejected (identity/integrity violation)

later Verification revision -> new settlement -> supersedes prior settlement
```

Supersession adds compensating assessment events for the prior settlement before
applying the new one in the same transaction.

#### Projection

```text
candidate -> validated -> current -> superseded
     |           |          |
     +-----------+----------+-> invalidated
```

Only one validated version is current per scope and projection kind. Candidate
content is never returned by `prepare`. Invalidated and superseded versions remain
explainable until retention removes them.

#### Managed Skill

```text
proposal -> quarantined candidate -> independent trials -> canary -> stable
                  |                       |             |
                  +-> rejected/retired <--+-------------+
                                          |
                                          +-> suppressed -> revalidated canary
```

`quarantined candidate` here means executable isolation, not an invalid learning
signal. Stable pointer changes require a signed immutable version receipt and
rollout authority. Retired versions are never selected but remain auditable.

## 9. Situation fingerprint

Operational utility must generalize without encoding identity or secrets.

```ts
export interface SituationFingerprint {
  version: 1;
  digest: string;
  taskFamily: string;
  inputModalities: readonly string[];
  outputArtifacts: readonly string[];
  freshnessClass: "static" | "recent" | "live";
  riskTier: "low" | "medium" | "high";
  languages: readonly string[];
  openFeatures: readonly string[];
}
```

Normalization uses a bounded controlled vocabulary plus bounded open features for
unknown domain terms. It excludes Profile, customer, user, conversation, project,
organization, path, URL query, Credential, and raw content identifiers. Versioned
fingerprints can coexist; maintenance may rebuild assessments but never silently
reinterpret an old digest.

## 10. Context preparation and retrieval

### 10.1 Hard gates

Candidate retrieval applies these checks in order:

1. Profile database identity;
2. trusted Access Scope and visibility;
3. semantic state and valid time;
4. correction, supersession, revocation, and forgetting state;
5. source freshness requirements from the Work Contract;
6. operational suppression and risk compatibility;
7. candidate generation;
8. ranking and budget selection.

The query planner must not fetch inaccessible rows into an application-level list
for later filtering. SQL scope predicates are part of every source query.

### 10.2 Candidate generation

The bounded union contains:

- FTS5 lexical hits;
- multilingual token and CJK character-gram hits;
- exact identifier and bounded substring hits;
- graph expansion from correction, conflict, evidence, exception, workflow, and
  projection input relationships;
- active projection hits;
- required prior Task/Objective references.

Each generator has a limit, but corrections, conflicts, exceptions, and required
references use reserved slots so weak precedent cannot crowd them out.

### 10.3 Ranking

The initial deterministic score is:

```text
0.45 relevance
+ 0.15 semantic authority confidence
+ 0.10 evidence quality and independent-source diversity
+ 0.10 freshness fit
+ 0.10 contextual operational utility
+ 0.10 recency
```

All components are normalized to `[0, 1]` and recorded in the receipt. `cautious`
components receive a `0.65` multiplier; a permitted but imperfect risk match
receives `0.50`; `suppressed` is excluded. The optional ranker can reorder only the
already scoped candidate IDs. Deterministic fallback always remains available.

### 10.4 Context budget order

1. full current request, outside optional budget;
2. accepted Work Contract and Task preservation;
3. trusted runtime facts;
4. corrections, active conflicts, exceptions, and freshness warnings;
5. criterion-bound and explicitly required Memory;
6. projections and precedent by score;
7. optional conversational continuity.

Rendered Memory is enclosed in escaped, non-executable evidence blocks. Prompt-like
text inside evidence is data. If a projection cannot be safely rendered, the
Kernel falls back to its authoritative inputs or omits it.

## 11. Observation, extraction, and admission

Observation writes immutable evidence identity before extraction. Extraction is a
proposal pipeline:

```text
Evidence -> deterministic/model proposal -> schema validation -> Credential and
injection checks -> scope validation -> type admission -> dedup/conflict analysis
-> Candidate or authoritative transition -> audit event
```

Rules:

- explicit user correction can create a correction proposal immediately but still
  preserves both source records and lineage;
- observed behavior is not automatically a stable preference;
- repeated behavior is not formal organization Policy;
- time-sensitive statements require observed/valid times and freshness class;
- every assertion references source evidence; spanless model assertions are
  rejected;
- duplicate extraction is idempotent on evidence digest, extractor version, and
  normalized proposal digest;
- conflicting evidence creates or updates conflict state rather than selecting the
  most convenient assertion;
- a Candidate reaches semantic authority only through its type-specific admission
  rules and rollout authority.

## 12. Outcome correlation and attribution

### 12.1 Correlation bundle

For one subject and Verification revision, settlement reads:

- criterion definitions and accepted/rejected/unavailable status;
- Context Pack and Contribution Receipts;
- Capability routing and reroute receipts;
- exact Tool calls and settlements;
- exact managed Skill version/lifecycle receipts;
- artifact manifests, source receipts, and Verification receipts;
- content-limited trace events;
- delivery status where the criterion requires delivery.

Every identity must match the `ExecutionEnvelope`, Objective/Task lineage, Profile,
and revision. A mismatch rejects settlement rather than widening correlation.

### 12.2 Cause taxonomy

The closed first-version taxonomy is:

- `source_stale`
- `retrieval_miss`
- `planning_error`
- `capability_mismatch`
- `provider_unavailable`
- `tool_execution`
- `skill_inapplicable`
- `skill_deviation`
- `artifact_invalid`
- `verification_unavailable`
- `authorization_blocked`
- `cancelled`
- `unknown`

New cause codes require a schema/version change and validator tests.

### 12.3 Attribution algorithm

1. Correlate immutable IDs and remove non-matching components.
2. Determine outcome eligibility. `unavailable`, `cancelled`, authorization block,
   and missing independent Verification cannot change operational utility.
3. Apply deterministic causal rules, such as a Tool settlement error directly
   followed by route failure, or artifact Verification naming an invalid manifest.
4. If ambiguity remains, provide only the correlated IDs, cause taxonomy, and
   bounded evidence references to the model-assisted attributor.
5. Validate temporal order, criterion relevance, source/Tool/Skill type, and
   evidence support. Reject incompatible or invented causes.
6. Emit supported, partial, or unknown attribution with weights.

Contribution strength is conservative:

| Evidence of use | Maximum positive weight |
| --- | ---: |
| merely exposed in optional Context | 0.10 |
| explicitly bound to a requirement or criterion | 0.50 |
| cited in accepted artifact or supported by verifier evidence | 1.00 |
| exact Tool or Skill receipt causally used | 1.00 |

Failure weight is zero unless a supported causal attribution names that component.
One rejected criterion may attribute multiple causes, but their total failure
weight is capped at `1.0` unless the verifier defines independent failures.

## 13. Contextual assessment and automatic downgrade

### 13.1 Posterior

Each component version starts with `Beta(2, 2)`. Accepted and attributed failure
weights update the materialized posterior. A fingerprint-specific assessment is
blended with the global assessment:

```text
specific_weight = specific_observation_weight / (specific_observation_weight + 5)
utility = specific_weight * specific_mean
        + (1 - specific_weight) * global_mean
```

This assessment affects retrieval/routing only. It does not change semantic
confidence or formal authority.

### 13.2 State machine

```text
eligible --evidence of risk--> cautious --strong repeated evidence--> suppressed
   ^                              |                                  |
   |                              v                                  v
   +------ revalidated -------- cautious <----- revalidated --------+
```

Initial thresholds:

| Transition | Low/medium risk | High risk |
| --- | --- | --- |
| eligible -> cautious | at least 3 attributed outcomes and mean below risk floor, or 2 consecutive attributed failures | one independently verified severe failure, otherwise medium rule |
| cautious -> suppressed | at least 5 attributed outcomes and mean below `0.45`, or 3 consecutive attributed failures | one safety failure or 2 attributed failures |
| suppressed -> cautious | 2 independent revalidation successes | 3 independent revalidation successes |
| cautious -> eligible | 3 consecutive accepted outcomes and mean at least `0.70` | 3 independent accepted outcomes and mean at least `0.90` |

Risk success floors are `0.60` low, `0.75` medium, and `0.90` high. Thresholds are
versioned Profile policy. Hysteresis is mandatory. A state transition is proposed,
audited, rollout-checked, then atomically applied by revision compare-and-swap.

### 13.3 Revalidation

Suppression is reversible. Maintenance may use existing fresh verified outcomes,
run sandbox counterfactual tests against frozen evidence, or create a normal
read-only Learning Objective. External effects are never replayed for a
counterfactual. A repaired version receives a new immutable version identity; it
does not inherit unqualified success from its predecessor.

## 14. Derived projections

Initial projection kinds are:

- `user_preferences`
- `project_summary`
- `project_handbook`
- `organization_playbook`
- `recent_outcomes`
- `failure_shields`
- `skill_capability_index`

A projection is immutable and rebuildable. Generation uses a fenced input set and
watermark. Every generated assertion must cite authoritative input IDs; a
deterministic validator checks scope, current revisions, validity, suppression,
Credential leakage, instruction-like content, and content digest before publishing
the current pointer atomically.

If generation fails, the previous current version remains usable only when all of
its inputs are still valid and allowed. Otherwise there is no current projection,
and retrieval falls back to authoritative records. A user edit is recorded as new
evidence or correction, never as an in-place projection mutation.

## 15. Procedural learning and managed Skill canary

### 15.1 Proposal

Repeated verified Workflow Episodes may propose a managed Skill Candidate:

- low-risk read-only procedure: at least 3 verified Episodes across at least 2
  Objectives with compatible situations;
- side-effecting or high-risk procedure: may be proposed automatically but
  requires existing enterprise authority for activation;
- generated content remains quarantined and cannot be loaded by the active Runtime.

Promotion requires at least 3 distinct accepted verifier scenarios, no rejection
since the Candidate version, green regression tests, complete Tool declarations,
and signed immutable version creation. The existing two-trial requirement remains
an absolute lower bound but is not sufficient for automatic L4 promotion.

### 15.2 Exact version selection

Managed Skills gain a stable pointer and optional canary pointer. Selection is
deterministic:

```text
bucket = hash(profile_id, skill_name, execution_id, canary_policy_version) % 100
selected = canary when eligible && bucket < canary_percentage; otherwise stable
```

The selection receipt records the exact digest. `SkillRuntime` loads that immutable
version and fences all lifecycle receipts to it. Unmanaged project Skills continue
through the existing filesystem content Adapter and do not become managed solely
because they were loaded.

### 15.3 Canary and rollback

Initial read-only canary is 10% of eligible executions. Promotion to stable requires
at least 10 accepted uses, posterior mean at least `0.90`, no safety failure, and
no regression-gate failure. A verified safety failure immediately suppresses the
canary and restores the prior stable pointer. Ordinary failures follow the
assessment hysteresis.

Filesystem and SQLite cannot share a transaction. The safe order is:

1. write and fsync immutable signed version;
2. verify returned signed receipt and digest;
3. atomically record version and pointer transition in SQLite;
4. reconcile filesystem pointer and SQLite pointer during maintenance;
5. fail closed to the last mutually verified stable version on mismatch.

## 16. Transactions, leases, and crash recovery

### 16.1 Required atomic boundaries

- Evidence insert plus dedup identity;
- Context Pack plus all Contribution Receipts before return;
- accepted Task/Task Run settlement plus learning signal;
- verified Episode publication plus learning signal;
- settlement, attributions, assessment events, and assessment revision updates;
- correction/forgetting plus dependent projection/receipt invalidation and signal;
- projection version publish plus current-pointer swap;
- rollout-approved assessment state transition plus audit event.

### 16.2 Model-call protocol

1. short transaction claims a signal with holder, random token, lease expiry,
   input digest, authority watermark, and dependent revisions;
2. transaction commits;
3. model or external calculation runs;
4. short transaction verifies token, lease/fence, input digest, revisions, and
   rollout state;
5. valid output is admitted and signal completed atomically; stale output is
   discarded and the signal is deferred with a reason code.

SQLite uses WAL and a bounded busy timeout. A crashed lease may be reclaimed after
expiry. The reclaiming worker must repeat the fence check before committing.

### 16.3 Reconciliation

Maintenance periodically compares:

- terminal Task/Task Run and Objective revisions against learning signals;
- completed Verification receipts against settlements;
- current semantic revisions against projection inputs;
- managed Skill signed receipts against SQLite pointers;
- completed signal sequences against job watermarks.

Reconciliation inserts missing idempotent work; it never invents a terminal
outcome or treats absence as failure.

## 17. Security and governance

`adaptive_learning` is added to the existing Profile rollout controller. It
depends on `situation_context` and `episode_publication` and gates automated
assessment influence, Candidate promotion, suppression/restoration, projection
publication, and managed Skill canary/rollback.

Existing gates remain independent:

- `read_only_investigation` controls external Learning Objectives;
- `reversible_action` controls their external effects;
- Tool governance, approvals, Credentials, Enterprise Policy, and Core hard blocks
  remain authoritative for every learned route;
- emergency stop prevents new learning influence and transitions but keeps
  evidence capture, inspection, rollback, and unrelated Objective execution.

Credential detection occurs at observation, extraction, projection, trace, and
Skill boundaries. Content classified as secret is rejected from semantic Memory;
the existing Credential Vault remains the only secret authority.

## 18. Observability and explanation

Every automated decision exposes content-free explanation records:

- Context Pack: included component IDs/versions, score factors, omission counts,
  policy/ranker version, and invalidation state;
- settlement: subject/Verification revision, correlated receipts, outcome,
  supported and rejected attributions;
- assessment: prior, delta, posterior, threshold, old/new state, and evidence IDs;
- projection: generator version, input digest/watermark, validation result, and
  current pointer transition;
- Skill: proposal lineage, trial receipts, selection bucket, exact version,
  assessment, promotion/suppression/rollback reason.

Metrics use bounded labels. Profile, query, raw source, artifact text, and open
Situation features do not become metric labels. Diagnostic trace is not authority;
the SQLite receipts and signed execution/Verification records are.

## 19. Failure behavior

| Failure | Required behavior |
| --- | --- |
| SQLite unavailable during optional `prepare` | omit optional Memory; preserve current request and required context; report degraded receipt |
| lexical index corrupt | use bounded table/relationship fallback; schedule rebuild |
| semantic ranker unavailable or malformed | deterministic ranking |
| extractor malformed | reject proposal, retain Evidence, retry under policy |
| attributor uncertain | `unknown`, zero failure weight |
| verifier unavailable | defer settlement; do not penalize |
| model call exceeds per-call integrity bound | defer that signal; user Objective continues |
| projection invalid/stale | authoritative inputs or omission; never stale-current by default |
| canary Skill failure | stable version fallback; supported failure updates only canary assessment |
| signed Skill/SQLite pointer mismatch | fail closed to last mutually verified stable version and reconcile |
| process crash after external model call | lease/fence discards stale commit or safely retries |
| privacy deletion | authority deletion/tombstone plus dependent invalidation before future recall |
| emergency stop | freeze new influence/transitions, preserve inspection and rollback |

## 20. Dependency-ordered implementation slices

Each slice is independently releasable behind rollout and has its own Definition
of Done.

### Slice 0 — baseline and corpus

- freeze current deterministic, simulated-fault, and live-run reports;
- version task families, Work Contracts, source windows, model/Tool versions, and
  verifiers;
- label current metrics as baseline rather than L4 results.

Done when the same manifest can reproduce a Memory-Off run and the report rejects
fixtures presented as real evidence.

### Slice 1 — contracts and migrations

- add public four-method Interface and value types in Core;
- add SQLite authority Adapter, tables, indices, migrations, backup/restore checks;
- add in-memory contract-test Adapter.

Done when Interface contract, scope, idempotency, migration, and rollback tests pass
without changing execution behavior.

### Slice 2 — observe-only correlation

- fan out normalized trace observations;
- atomically enqueue Task and Objective learning signals;
- persist Context Pack and Contribution Receipts without using assessments.

Done when every eligible real execution can be reconstructed by immutable IDs and
crash reconciliation is exact.

### Slice 3 — bounded extraction

- implement deterministic and model-backed proposal Adapters;
- deterministic admission, conflicts, correction, secret rejection, and Candidate
  quarantine;
- run in shadow mode.

Done when promotion precision, provenance, correction, forgetting, and poisoning
gates pass.

### Slice 4 — progressive prepare

- scoped hybrid candidate generation and ranking;
- Context Pack budget and safe rendering;
- `ConversationContext` delegates optional Memory to Kernel.

Done when Recall@5, scope, CJK, current-request preservation, and paired shadow
quality gates pass.

### Slice 5 — projections

- immutable projection and input lineage;
- consolidation, current-pointer publication, invalidation, and rebuild;
- authoritative fallback.

Done when crash, stale-input, correction, forgetting, and poisoned-projection
tests pass.

### Slice 6 — settlement and contextual utility

- criterion correlation, deterministic/model-assisted attribution;
- append-only assessment events and posterior materialization;
- observe-only transition proposals, then rollout-controlled influence.

Done when labeled attribution and false-downgrade gates pass and semantic truth is
unchanged by outcome-only tests.

### Slice 7 — automatic suppression and restoration

- risk thresholds, hysteresis, CAS transitions, revalidation, emergency stop;
- local source/Tool/Skill failure attribution.

Done when fault isolation, rollback, recovery, and high-risk gates pass.

### Slice 8 — managed Skill evolution

- automatic proposal, stronger trial policy, stable/canary selection, health,
  promotion, suppression, rollback, and filesystem reconciliation;
- exact immutable-version receipts in Runtime.

Done when Candidate contamination is zero and real accepted Skill-route completion
meets the certification gate.

### Slice 9 — active Learning Objectives

- turn high-value missing evidence/capability into normal durable Objectives;
- enforce current authority, approval, Effect, Verification, and delivery paths;
- prohibit hidden side-effect replay.

Done when investigation improves evidence without bypassing any governance boundary.

### Slice 10 — L4 release

- staged Profile rollout and soak;
- paired live-provider certification;
- migration/restore rehearsal and operator runbook;
- publish evidence with sample counts and confidence intervals.

Done only when every release gate in the certification document passes. Near-pass,
simulated success, or one successful run is not L4 completion.

## 21. Interface-level test matrix

The four-method Interface is the primary surface:

| Behavior | `prepare` | `observe` | `settle` | `maintain` |
| --- | ---: | ---: | ---: | ---: |
| exact scope and Profile isolation | yes | yes | yes | yes |
| idempotent retry | yes | yes | yes | yes |
| Credential and injection rejection | render | write | correlation | projection/Skill |
| correction/forget propagation | yes | source | inverse/supersede | rebuild |
| crash/lease recovery | commit | local append | atomic event | claim/fence |
| unavailable/unknown handling | degrade | reason | zero penalty | defer |
| deterministic fallback | rank | validation | attribution | extraction/projection |
| explanation and provenance | receipts | receipt | attributions | transitions |

Private SQL statement order and model prompt wording are deliberately not public
test contracts. Migration checks, storage invariants, and query scope predicates
still receive focused Adapter integration tests.

## 22. Final design decisions

There are no unresolved architecture choices required before implementation.
Thresholds, retention, canary percentage, and score weights are versioned initial
policies, not hard-coded eternal constants; changing them requires measured release
evidence and policy-version traceability.

The design intentionally accepts the complexity of a normalized authority,
append-only audit events, and fenced asynchronous work. That complexity stays
inside one deep Module. Callers receive four coherent operations and cannot couple
the Agent loop to learning internals.
