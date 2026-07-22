# Intelligence-First Organizational Agent Design

## Status

Historical design input. Its approved direction has been merged into the canonical
[`Thruvera Pi-native 组织智能 Runtime PRD`](../../prd/thruvera-pi-unified-agent-runtime.md).
When this document and the canonical PRD differ, the canonical PRD governs.

## Product axiom

Thruvera fixes execution integrity, not customer business ontology. Customer work may contain industries, entities, relationships, conventions, exceptions, and authority structures that Thruvera cannot enumerate in advance. The Agent therefore interprets business meaning dynamically from language, history, tools, and enterprise knowledge. Runtime code must not define customer concepts such as order, project, ticket, contract, or workflow stage.

The product relationship is:

```text
The user supplies direction, values, corrections, and consequential decisions.
The Agent owns understanding, planning, execution, verification, and follow-through.
```

## Goals

1. Start usefully with little or no enterprise rule configuration.
2. Understand unfamiliar business situations without adding Runtime type branches.
3. Learn organizational cases, conventions, exceptions, authority, and corrections over time.
4. Discover useful work and maintain durable responsibility instead of waiting for every instruction.
5. Resolve uncertainty through evidence, tools, reversible trials, and the right stakeholder before asking the current user.
6. Ask only when a material ambiguity cannot be resolved autonomously.
7. Preserve the existing durable Task, Effect Receipt, Checkpoint, recovery, and Verification guarantees.

## Non-goals

1. Defining an industry ontology or universal business process model.
2. Requiring an enterprise to configure all policies before first use.
3. Treating one approval, correction, or observed action as a permanent company rule.
4. Letting model confidence grant data access or forge authoritative facts.
5. Adding a second Agent Loop, Memory Store, Task Queue, Scheduler, or Policy state machine.

## Design principles

### Intelligence owns semantics

The model constructs an open situation representation from the current conversation, relevant episodes, durable responsibilities, enterprise knowledge, and tool observations. This representation is evidence-carrying but not constrained to a fixed list of business entity types, roles, or relationships.

### Runtime owns integrity

Existing deterministic components continue to enforce identity isolation, Credential secrecy, execution budgets, Task lifecycle, Effect idempotency, Checkpoint persistence, and Verification. These constraints protect system integrity; they do not encode enterprise business meaning.

### Evidence before questions

When uncertain, the Agent searches Memory, reads authoritative knowledge, queries tools, examines similar cases, identifies likely authorities, and prepares a reversible trial. It asks one focused question only when unresolved uncertainty could materially change the outcome.

### Learning is gradual and correctable

Observed behavior becomes an episode. Repeated patterns may become a candidate convention. A candidate never silently becomes an enforced enterprise policy. Corrections and counterexamples remain attached to the understanding that they challenge.

### Initiative is durable responsibility

Proactivity is not unsolicited chat. A useful situation creates or updates a durable Objective. The Task Ledger, rather than the model transcript, owns follow-through, recovery, and completion.

## Target architecture

```text
Messages / Events / Tools / Enterprise Knowledge
                    |
                    v
             Situation Builder
                    |
          +---------+----------+
          |                    |
          v                    v
 Organization Memory     Active Task Ledger
          |                    |
          +---------+----------+
                    v
             Initiative Loop
                    |
        create / update / ignore Objective
                    |
                    v
       Planner -> Pi Loop -> Tool Effects
                    |
          Receipt + Checkpoint
                    |
                    v
               Verification
                    |
          Outcome + feedback + episode
                    |
                    +----> Organization Memory
```

This extends the current Runtime. It does not introduce a parallel executor or persistence authority.

## Components

### 1. Organization Memory

The existing MemoryStore remains the source of truth. Its cognitive records become extensible rather than industry-specific.

Required concepts:

- `episode`: what happened in one situation, including outcome and evidence;
- `understanding`: a current, correctable interpretation;
- `preference`: a user or group tendency;
- `convention_candidate`: a repeated pattern that may be organizational practice;
- `convention`: a reviewed or authoritative practice;
- `exception`: a counterexample with its applicable context;
- `authority_hint`: evidence that a person or system is relevant to a class of decisions;
- `goal`: a durable desired outcome;
- `correction`: evidence that supersedes or narrows an earlier understanding.

These are cognitive record types, not customer business types. Customer-specific vocabulary stays in content, evidence, open tags, and embeddings.

Every durable record carries provenance, observed time, confidence, stability, validity, visibility, correction links, and optional authoritative references. Recall combines hard access scope with lexical or semantic relevance, recency, evidence quality, current goal relevance, and precedent similarity.

### 2. Situation Builder

The current TurnUnderstanding fast path becomes a fallback. A model-backed Situation Builder produces a structured but open envelope:

```ts
interface Situation {
  summary: string;
  goals: string[];
  constraints: string[];
  uncertainties: string[];
  relevantMemoryIds: string[];
  relevantTaskIds: string[];
  observations: Array<{ statement: string; source: string; confidence: number }>;
  possibleActions: Array<{ description: string; expectedOutcome: string; reversible: boolean | "unknown" }>;
  confidence: number;
}
```

This schema describes the Agent's cognition without prescribing the customer's domain. Trusted integration references may be attached as evidence; the model may not invent access scope.

### 3. Initiative Loop

The existing HeartbeatRunner becomes one trigger source among messages, scheduled jobs, Task changes, failures, and enterprise events. A Situation is evaluated for meaningful action:

- ignore as noise;
- enrich an existing Objective;
- prepare a reversible draft or investigation;
- create a new durable Objective;
- request one consequential decision.

Initiative output must include its evidence, relationship to a user or organizational goal, expected value, and intended verification. Deduplication uses active Objectives and recent episodes so repeated heartbeats do not create duplicate work.

### 4. Adaptive Autonomy

Autonomy is a metacognitive decision, not a customer rule table. The Agent considers available evidence, uncertainty, expected impact, reversibility, precedent consistency, and ability to verify.

Preferred escalation order:

```text
recall precedent
-> query authoritative source
-> inspect current state
-> prepare reversible trial
-> locate a better authority
-> ask one focused question
```

The existing ToolPolicyRegistry remains a conservative execution boundary and budget source. A future enterprise Policy Provider may contribute authoritative decisions, but absence of such a provider does not prevent useful low-impact work.

### 5. Organizational apprenticeship

Shadow learning and active work run together. Each meaningful action produces an episode. Periodic consolidation looks for repeated patterns and exceptions. Consolidation may create candidate conventions or authority hints, never silent grants or denials.

The Agent should surface a candidate only when confirmation would unlock meaningful future autonomy. Rejected candidates remain negative evidence so they are not repeatedly proposed.

## End-to-end data flow

1. A message, event, Task transition, or heartbeat arrives.
2. The Situation Builder recalls relevant confirmed memory, candidate evidence, conflicts, active Objectives, and recent outcomes.
3. It creates an evidence-backed Situation.
4. The Initiative Loop decides whether there is useful work and deduplicates against the Task Ledger.
5. Useful work creates or updates a durable Objective with acceptance criteria and execution scope.
6. Existing planning and Pi execution run the Objective.
7. Every external mutation records or reconciles an Effect Receipt.
8. Checkpoints preserve progress across interruption.
9. Verification determines whether the outcome satisfies the Objective.
10. The result becomes an episode; verified facts, corrections, exceptions, and candidate conventions update Organization Memory.
11. The user is notified only for a useful result, a consequential decision, or a genuinely blocked Objective.

## Failure and uncertainty handling

- Missing business understanding does not cause cross-scope retrieval. The Agent continues with conversation-safe evidence or obtains a trusted reference.
- Conflicting memory is presented as uncertainty and investigated; it is never silently resolved by rank.
- Low-confidence initiative begins with read-only investigation or a reversible draft.
- A failed reversible trial records an episode and does not become a convention.
- An uncertain external mutation is reconciled from its Effect Receipt before retry.
- A process crash resumes from the Task Ledger and Checkpoint, not from inferred transcript state.
- If no meaningful action exists, the proactive loop remains silent.

## Compatibility and migration

1. Existing `subject/object` fields remain readable during migration but are treated as legacy evidence references, not the target business ontology.
2. Existing Claim, Candidate, Evidence, Task, and Receipt records remain valid.
3. New cognitive record types are introduced additively; no destructive rewrite is required.
4. Existing deterministic TurnUnderstanding and AutonomousPlanningPolicy remain fallback and budget layers.
5. HeartbeatRunner remains the initial timer trigger while Initiative Loop logic moves into Core.
6. The MemoryStore and Task Ledger remain the only durable writers for their respective state.

## Testing and evaluation

### Reliability gates

- Existing build and full test suite remain green.
- No regression in P6 cross-scope recall or P7 recovery acceptance.
- No duplicate Objective or Effect from repeated events or restart.

### Intelligence evaluation

Create a versioned corpus of unfamiliar enterprise situations with no domain-specific Runtime code. Measure:

- task completion rate;
- user interventions per completed Objective;
- repeated-question rate;
- precedent retrieval precision;
- useful initiative acceptance rate;
- duplicate or irrelevant initiative rate;
- correction retention;
- unauthorized retrieval and action rate;
- successful continuation across sessions and restart.

Initial target gates are at least 60% accepted proactive initiatives, at least 30% fewer user interventions on repeated work, zero cross-tenant retrieval, and no increase in unsafe Effect replay.

## Delivery slices

1. Organization Memory records and evaluation corpus.
2. Model-backed Situation Builder with deterministic fallback.
3. Initiative Loop operating in observe-only mode.
4. Reversible autonomous investigations and drafts.
5. Durable proactive Objectives and follow-through.
6. Convention consolidation and authority hints.
7. Optional enterprise Policy Provider integration.

Each slice extends existing seams and must pass architecture de-duplication review before implementation.
