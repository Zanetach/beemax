# Thruvera Agent

Thruvera coordinates durable work for a personal Agent across conversations, channels, automation, and delegated workers.

## Language

**Task**:
A durable outcome the Agent has accepted responsibility for delivering.
_Avoid_: Job, todo, agent run

**Task Run**:
One execution attempt for a Task. Steering, model fallback, and Capability reroute remain inside the active Task Run; a Verification-rejected Corrective Attempt creates a new Task Run without duplicating the Task or Objective.
_Avoid_: Task, session, turn

**Task Ledger**:
The durable, owner-scoped record of Tasks and their Task Runs across conversations and restarts.
_Avoid_: Chat history, memory, process list

**Task Plan**:
A directed acyclic graph of Tasks whose dependency edges determine which work is ready to run in parallel.
_Avoid_: Prompt outline, checklist, execution log

**Task Plan Outcome**:
The durable aggregate lifecycle and quality summary of a Task Plan, derived from all Tasks in that Plan.
_Avoid_: Task Graph result, UI summary, final answer

**Task Plan Completion Notice**:
A durable owner-directed announcement that a background Task Plan reached a Terminal Outcome and its details are available; it is not the outcome itself and contains no Task result payload.
_Avoid_: Task result, chat reply, delivery attempt

**Terminal Outcome**:
The first persisted succeeded, failed, or cancelled state of a Task Plan, Task, or Task Run; later executors may observe it but cannot replace it, while an explicit safe Retry or Verification Retry may create a new controlled outcome.
_Avoid_: Latest status, worker report, retry state

**Task Dependency**:
A requirement that one Task succeed before another Task becomes ready.
_Avoid_: Ordering hint, parent Task

**Dependency Failure**:
A Task failure caused by a required upstream Task reaching a failed or cancelled outcome before the dependent Task could run.
_Avoid_: Task Run failure, blocked queue, cancellation

**Acceptance Criteria**:
Observable conditions that a Task result must satisfy before the Task can be accepted as complete.
_Avoid_: Prompt, implementation steps, subjective quality

**Verification**:
An independent evaluation of a Task result against its Acceptance Criteria and available evidence; it is unavailable when that evaluation cannot complete, which is distinct from rejecting the result.
_Avoid_: Execution, self-report, model confidence

**Candidate Outcome**:
Task execution output retained in `candidateResult` after a Pi or Task Run settles; the durable Task and Objective remain active, and the candidate cannot satisfy dependencies or become an accepted result until Verification succeeds.
_Avoid_: Final answer, successful result, evidence

**Business Completion**:
The accepted durable outcome of a Task or Objective after Verification; it is distinct from Pi, Turn, Tool, or Task Run settlement.
_Avoid_: Agent stop, run success, candidate outcome, delivery attempt

**Verification Retry**:
A repeated evaluation of a retained Candidate Outcome after Verification was unavailable; it does not execute the Task again.
_Avoid_: Task retry, Corrective Attempt, model replay

**Verification Backoff**:
The durable wait before an unavailable Verification may be attempted again; it delays evaluation of the retained Candidate Outcome and never authorizes Task execution.
_Avoid_: Task timeout, execution retry delay, Corrective Attempt

**Corrective Attempt**:
A new Task Run that revises a rejected result using Verification feedback while preserving the identity and responsibility of the original Task.
_Avoid_: Recovery retry, model continuation, silent rewrite

**Quality Status**:
The observable Verification state of a Task result and the number of Corrective Attempts required to reach it; it is not a subjective score.
_Avoid_: Quality score, model confidence, Task status

**Profile Task Scheduler**:
The Profile-wide admission controller that shares delegated execution capacity across conversations and Task Plans.
_Avoid_: Task queue, Sub-Agent manager, Task Plan runner

**Execution Lease**:
A time-bounded claim that a live executor is still responsible for a Task Run; expiry means the run was interrupted, not that its outcome is known.
_Avoid_: Task timeout, lock, deadline

**Execution Envelope**:
The immutable identity and trusted references carried by one Pi execution attempt, including its trigger, Objective, Task Run, Access Scope, budget, deadline, and recovery or verification mode.
_Avoid_: Prompt context, Task record, customer business schema, Credential Secret

**Execution Sandbox**:
A constrained execution environment for selected built-in file and command Capabilities; it does not enlarge Access Scope and does not imply that MCP, Browser, Channel, Profile, or tenant activity is isolated.
_Avoid_: Profile isolation, local process, tenant boundary

**Host Execution Adapter**:
The explicit trusted-mode Adapter that runs selected built-in file and command Capabilities with the Thruvera process user's host authority; it is never an Execution Sandbox.
_Avoid_: Local Sandbox, restricted host, safe mode

**Execution Trace**:
A content-free diagnostic projection that correlates one Execution Envelope with model turns, Tool calls, Effects, checkpoints, Verification, delivery, cost, and latency; it never authorizes work or replaces their durable authorities.
_Avoid_: Transcript, Task Ledger, Effect authority, audit policy, business event

**Effect Authority**:
The sole durable state machine for a mutating Tool attempt. It binds the Effect to its Execution Envelope and Task Run, prevents committed replay, requires reconciliation for unknown outcomes, and emits safe read-only projections for Tasks and operators.
_Avoid_: Model-authored receipt, Task field, Tool log, Execution Trace

**Task Checkpoint**:
A bounded durable recovery snapshot for one Task Run, recording completed progress, committed Effect references, evidence references, unresolved issues, and the next safe step so work can continue without replaying completed actions.
_Avoid_: Chat summary, model scratchpad, Task result, transcript

**Task Plan Execution Claim**:
A time-bounded, holder-fenced right to recover one Task Plan so concurrent Agent instances do not schedule the same Plan at once.
_Avoid_: Task lock, Plan ownership, scheduler slot

**Recovery Policy**:
The explicit rule deciding whether an interrupted Task may be retried automatically; automatic retry requires both a safe-retry policy and an Idempotency Key.
_Avoid_: Retry count, error handling

**Idempotency Key**:
A stable identity proving repeated execution represents the same intended effect rather than a new Task.
_Avoid_: Task ID, Run ID, request ID

**Interruption**:
Loss of a live executor before a Task Run reaches a terminal outcome; reconciliation converts it to a safe retry or a failed Task.
_Avoid_: Failure, cancellation, timeout

**Schedule**:
A rule that emits a Trigger at a future time or recurring cadence; the Trigger may cause delivery, admit durable responsibility, or produce no work, but the Schedule is never itself a Task.
_Avoid_: Scheduled task, cron job

**Delegation**:
A parent Task assigning a bounded child Task to a Sub-Agent while retaining responsibility for the outcome.
_Avoid_: Spawn, background chat

**Turn**:
One user-to-Agent interaction inside a conversation; a Turn may create, inspect, or advance Tasks.
_Avoid_: Task, run

**Profile**:
An independently configured Agent identity and state authority containing its own Memory, Sessions, durable work, credentials, capabilities, automation, and channel configuration. A Profile namespace does not by itself imply a process, Sandbox, or hostile-tenant security boundary.
_Avoid_: Customer business type, chat session, guaranteed tenant Sandbox

**Channel Instance**:
A stable configured connection to one concrete platform account or bot identity. Multiple Channel Instances may use the same platform adapter, and delivery must select the instance whenever the platform alone is ambiguous.
_Avoid_: Platform, Profile, Capability credential

**Conversation**:
A shared communication space identified by Channel Instance, platform conversation, and optional Thread. A group Conversation never includes the current Actor in its identity; a direct Conversation includes its peer so private sessions remain separate.
_Avoid_: Actor, Task owner, Profile

**Session Ownership Migration**:
An explicit, reversible assignment of one legacy Actor-scoped group transcript to the canonical shared Conversation Session. It never guesses, merges, or deletes unselected legacy transcripts; the old files remain archived until a separately governed retention action exists.
_Avoid_: Automatic transcript merge, Session fallback, Memory migration, retention cleanup

**Actor**:
The authenticated person, bot, or system that produced an Interaction. Actor identity governs personal responsibility and private Memory but does not partition a shared group Conversation.
_Avoid_: Conversation, display name, Profile

**Activation Policy**:
The transport-neutral admission rule that decides whether a group Interaction may be considered for response or observation from verified signals such as mention, reply, command, role, and allowlist state. It never performs business reasoning or grants Tool authority.
_Avoid_: Prompt instruction, Enterprise Policy, Situation decision

**Active Conversation Lane**:
A bounded, expiring group Conversation/Thread state created only by a verified Activation signal. It permits natural contextual follow-ups in that same lane without repeated mentions, but never crosses Threads, grants authority, or becomes durable Memory.
_Avoid_: Session ownership, Access Scope, permanent group state

**Group Response Governor**:
A deterministic, bounded per-Conversation-lane control that applies configured quiet hours and reply-window budgets after Activation but before a group response enters Agent work. Emergency commands bypass the reply budget; the governor never interprets customer business meaning or grants authority.
_Avoid_: Enterprise Policy, semantic response judgment, Agent prompt rule

**Ambient Group Observation**:
An opt-in projection of a non-activated group text message into a bounded Initiative Observation candidate inside the same Profile, Channel Instance, Conversation, and Thread scope. It bypasses the Agent message path and cannot create an Objective, invoke Pi, call a Tool, or deliver a message.
_Avoid_: Passive Agent turn, chat transcript ingestion, permanent Memory, hidden execution

**Ambient Observation Evaluator**:
A Core-owned, asynchronous cognition port that decides retain, defer, or ignore from generic relevance, credibility, expected-value, and confidence evidence. Its Pi-backed implementation uses tool-free model completion rather than an Agent session; invalid or unavailable inference defers safely and cannot invent Access Scope, business authority, or customer-specific rules.
_Avoid_: Intent router, fixed business ontology, Agent Loop, Tool execution

**Ambient Evaluation Defer**:
A fail-closed, non-retention decision for unactivated group content whose value cannot currently be established. It is observable but deliberately does not persist unapproved raw chatter or promise replay; capacity is bounded separately so model outages cannot create an unbounded intake queue.
_Avoid_: Durable Task defer, hidden raw transcript retention, accepted Observation

**Governed Delivery**:
A transport-neutral outbound boundary that applies proactive group quiet hours and per-Conversation frequency budgets from trusted Conversation Type. Interactive and control Delivery bypass proactive governance; a denied durable Delivery is rescheduled without replaying Pi or consuming its ordinary failure budget.
_Avoid_: Channel send retry, prompt policy, business-value judgment, guessed chat type

**Profile Binding**:
A deterministic, model-independent route from Channel Instance, optional account, Conversation, and Thread to exactly one Profile. Thread outranks Conversation, Conversation outranks account, and account outranks the Channel Instance default; same-level ambiguity fails closed.
_Avoid_: Prompt routing, Adapter-selected Profile, array-order fallback

**Gateway Ingress Capacity**:
The Profile-wide high-water boundary that limits active inbound Interactions globally and per Conversation before Runtime work is allocated. Rejection is observable and emergency stop remains admissible.
_Avoid_: systemd MemoryMax, Task Scheduler capacity, unbounded Adapter queue

**Situation**:
The Agent's current, evidence-backed interpretation of what is happening, why it matters, and what remains uncertain; it is open-ended and may change when new evidence arrives.
_Avoid_: Fixed business schema, Access Scope, prompt classification

**Situation Builder**:
The asynchronous cognition boundary that prefers normalized model inference, separates facts, goals, constraints, conflicts, unknowns, actions, confidence, and provenance, then falls back to deterministic Turn Understanding when inference is unavailable or invalid. Model output cannot create Access Scope or trusted evidence references.
_Avoid_: Intent router, authorization resolver, second Agent Loop

**Organization Knowledge Recall**:
A bounded Situation-driven projection that ranks scoped Episodes, Claims, Correction chains, Conflicts, Exceptions, and Conventions by relevance, evidence, recency, precedent, and state, then gives Pi explicitly non-executable evidence.
_Avoid_: Second Memory Store, prompt injection channel, authorization lookup, flat chat recall

**Organization Memory**:
The correctable, evidence-backed understanding accumulated from episodes, outcomes, conventions, exceptions, authority, goals, and feedback across work.
_Avoid_: Chat history, Task Ledger, fixed business ontology

**Memory Persistence Ports**:
Focused Organization Memory, Conversation Memory, Task Ledger, Recovery Queue, Completion Outbox, and Initiative Observation capability views over one Profile SQLite authority; the views do not own or duplicate state.
_Avoid_: Second Memory Store, repository wrapper with its own state, full MemoryStore dependency in runtime callers

**Episode**:
A retained, Objective-idempotent account of one meaningful Situation, the action taken, its outcome, and supporting evidence. Candidate, verified, conflicted, and superseded states remain explicit.
_Avoid_: Transcript, Task Run, permanent rule

**Correction**:
Evidence-backed replacement of an active or conflicted Claim that supersedes the prior understanding without erasing its history.
_Avoid_: Silent edit, new unrelated fact, forget

**Conflict**:
An unresolved, evidence-backed relationship between incompatible Claims in the same scope; both Claims and both provenance chains remain visible until corrected or revoked.
_Avoid_: Rank tie, automatic winner, duplicate Claim

**Exception**:
A scoped, evidence-backed departure from an otherwise applicable understanding. It remains a distinct cognitive type and is never itself a universal Convention.
_Avoid_: Enterprise Policy, global rule, workflow branch

**Claim Revocation**:
An evidence-backed withdrawal that removes a Claim from effective recall while retaining its archived explanation chain.
_Avoid_: Forget, correction, deletion

**Claim Forget**:
An owner-scoped deletion of a Claim and its dependent evidence, distinct from an auditable revocation.
_Avoid_: Revocation, archival, supersession

**Convention Candidate**:
A scoped, asynchronously inferred organizational pattern supported by at least two verified Episodes, with its time span, confidence, contradictions, exceptions, and review lifecycle retained. It is not yet authoritative or enforceable; later contradictory Episodes block confirmation or roll back a previously confirmed candidate.
_Avoid_: Enterprise Policy, approval grant, permanent rule

**Workflow Candidate**:
A reviewable, instruction-only description of conditions, exceptions, inputs, ordered guidance, expected outcomes, and Verification derived from confirmed Conventions with complete Episode lineage. It has no execution or Policy authority and remains editable, rejectable, supersedable, and archivable by people.
_Avoid_: Active workflow, Skill, Enterprise Policy, executable automation

**Skill Candidate**:
An instruction-only, inactive Skill version isolated for static checks, distinct real trials, and independent Verification. Workflow-derived candidates remain bound to the exact reviewed Workflow revision and content identity until promotion.
_Avoid_: Active Skill, Workflow Candidate, executable plugin, trial result

**Skill Version**:
An immutable, integrity-sealed snapshot of managed Skill instructions and promotion provenance within one Profile. Activation and rollback create observable lifecycle events without rewriting prior versions.
_Avoid_: Skill Candidate, mutable file backup, Git commit, global rollout

**Enterprise Policy**:
An authoritative organizational constraint or decision source that governs an action without defining the customer's entire business model. Legacy directives that require interactive approval fail closed because Thruvera does not provide a Tool approval workflow.
_Avoid_: Model guess, Convention Candidate, built-in industry workflow

**Enterprise Policy Decision**:
A versioned action directive stamped by a trusted enterprise publisher with effective scope, effective time, and audit evidence; its disposition is allow, deny, require approval, constrain, or missing evidence. `require approval` is retained as an input compatibility disposition and resolves to deny.
_Avoid_: Model recommendation, learned convention, Tool metadata, global autonomy switch

**Action Governance Decision**:
The explainable per-action result that combines Tool risk, side effect, reversibility, Enterprise Policy, Effect state, measured reliability, and Execution Grant immediately before Pi Tool enforcement.
_Avoid_: Global autonomy level, Enterprise Policy publication, model confidence

**Autonomy Rollout Level**:
A Profile-scoped, evidence-gated release boundary for one generic organizational-intelligence capability: Situation context, Episode publication, adaptive learning, Initiative observation, read-only investigation, or reversible action. Adaptive learning governs deterministic low-risk admission, operational assessment, and managed-Skill canary behavior; it does not grant execution authority. A rollout level controls whether an already governed capability may run; it does not describe a customer's workflow or replace per-action Governance.
_Avoid_: Customer business stage, global intelligence mode, Enterprise Policy, action risk score

**Execution Grant**:
A bounded active-task authority allowing named capabilities admitted for the active Task; it never overrides Enterprise deny, Core hard blocks, or unresolved Effect state.
_Avoid_: Session-wide permission, Tool availability, Access Scope

**Standing Profile Authority**:
A time-bounded, evidence-backed Profile grant for named Capabilities and Access Scopes that may run unattended while current; it is limited to low-risk read-only or proven-reversible work and never authorizes high-risk or irreversible actions.
_Avoid_: Global autonomy switch, permanent authority, inferred consent, Execution Grant

**Unattended Execution Admission**:
The pure preflight decision that combines resolved intent, credential availability references, legal authority, trusted Access Scope, Enterprise Policy, Effect state, reliability, Emergency Stop, and either Standing Profile Authority or an exact Execution Grant before zero-touch work may proceed. Tool invocation still rechecks normal Governance and Effect authority.
_Avoid_: Tool execution, authority bypass, Credential Secret, global full-autonomy mode

**Compensation**:
An authorized inverse action that uses a committed Effect's trusted receipt to restore an acceptable state and produces its own Effect and Verification evidence.
_Avoid_: Deleting history, changing the original Effect to failed, assumed rollback

**Proven Reversibility**:
Evidence that a mutation Capability has a registered Compensation, sufficient trusted receipt data, and a successful bounded rollback exercise for the current rollout.
_Avoid_: `reversible=true` alone, best-effort undo, model promise

**Emergency Stop**:
A durable authority that denies new proactive mutations and interrupts uncommitted proactive execution within its scope; committed Effects still require Compensation.
_Avoid_: Process kill, notification mute, automatic undo

**Capability**:
A versioned Tool, MCP operation, or Skill affordance that can be ranked and proposed to Pi for the current Situation; it is inventory metadata, not permission or execution authority.
_Avoid_: Tool execution, Enterprise Policy, fixed business route

**Open-World Contract**:
A domain-neutral, immutable graph compiled from an admitted Work Contract that binds every atomic Acceptance Criterion exactly once to its Capability, Artifact, and Evidence requirements. It contains requirements and references only and cannot grant Tool, Provider, Credential, Access Scope, Effect, or Delivery authority.
_Avoid_: Work Contract replacement, business ontology, Tool inventory, execution permission

**Artifact**:
A concrete, externally observable result of work whose content and media type can be identified independently of the Task Run that produced it.
_Avoid_: Model claim, Tool text output, file path alone, delivery attempt

**Artifact Manifest**:
A bounded, content-addressed snapshot binding an Artifact's locator, media type, byte length, digest, producer identity, and source references at one point in time; it is evidence metadata, not proof that the Artifact satisfies its Acceptance Criteria.
_Avoid_: Mutable file record, Task result, Verification receipt, delivery receipt

**Artifact Verification Receipt**:
An independent verifier's bounded observation of one exact Artifact Manifest across required dimensions such as existence, integrity, semantics, rendering, consistency, freshness, or delivery. A rejected or unavailable dimension cannot be represented as accepted.
_Avoid_: Producer self-report, Artifact Manifest, model confidence, Tool success

**Contract-Driven Planning**:
The durable-lane post-admission decision that derives direct, delegated, or DAG execution; bounded concurrency and resource budgets; correction allowance; and Verification depth from an admitted Work Contract or Open-World Contract. It governs Automation and explicit Objective lifecycle work, not ordinary turn-local model cognition. Only an explicit acyclic outcome dependency graph proves durable parallel work; action and delivery Effects remain inside the parent Agent authority boundary.
_Avoid_: Raw-prompt keyword routing, model-selected authority, unproven parallelism, execution permission

**Adaptive Turn Admission**:
The control-plane decision that sends ordinary interactive natural-language work to the Model-First Turn Lane and reserves semantic Work Contract admission for Automation, explicitly bound Objectives, and continuation/correction/cancellation of an active durable Objective. Complexity, unfamiliar vocabulary, research, artifact creation, or a request for multiple steps do not by themselves grant persistence or force a separate cognition pass.
_Avoid_: Intent router, complexity-as-persistence, global fast mode, model-selected authority, semantic Contract replacement

**Model-First Turn Lane**:
The turn-local Pi path selected by Adaptive Turn Admission for ordinary interactive work. The main model receives the natural-language task, answers simple requests directly, adapts a plan for complex requests, progressively loads Capabilities, and continues the model–Tool loop after recoverable failures. It skips separate Work Contract cognition while retaining context assembly, Tool Spec policy, Sandbox boundaries, Access Scope, Enterprise Policy, Effect authority, execution tracing, Artifact verifiers, and Provider-result handling. Complexity alone cannot create durable responsibility.
_Avoid_: Unverified business completion, unrestricted Tool mode, implicit durable Objective, pre-model semantic gate

**Capability Selection**:
A bounded, explainable ranking of versioned Capabilities for a query plus the Pi Tool names proposed for turn-scoped activation.
_Avoid_: Tool call, action execution, Capability Router loop

**Pi Active Tools**:
The current turn-scoped Tool inventory exposed by Pi and the sole execution authority after Capability Selection; selection never executes a Tool itself.
_Avoid_: Capability candidates, Skill catalog, authorization grant

**Access Scope**:
The trusted identity and authorization boundary within which information and capabilities may be used; it does not describe the meaning of the customer's business.
_Avoid_: Situation, business ontology, model confidence

**Initiative**:
The Agent recognizing meaningful work, relating it to a goal, and accepting durable responsibility without requiring the user to prescribe each execution step.
_Avoid_: Unsolicited notification, heartbeat message, speculative action

**Initiative Observation**:
An evidence-backed, scope-bound record of a proposed action, expected value, risk, rationale, intended verification, dedupe identity, and feedback. Observation itself never grants execution authority. In observe-only mode it never creates an Objective, invokes Pi or Tools, or emits a notification.

**Proactive Investigation**:
The bounded Phase-2 admission of a high-value, sufficiently confident Initiative Observation into a recoverable read-only Objective. Every admitted capability must have `sideEffect=none` and pass Action Governance. The Objective then uses the same Pi Task Run, Checkpoint, Verification, and recovery lifecycle as other durable work; a non-material result stays quiet.
_Avoid_: Objective, execution grant, notification, hidden enterprise rule

**Proactive Reversible Action**:
The bounded Phase-3 admission of one low-risk mutation under a current Enterprise Policy Decision, trusted Access Scope, durable Emergency Stop revision, and current Compensation exercise. Forward and inverse actions use separate Policy decisions, Pi capability allowlists, Effects, receipts, and Verification; the original Effect is never rewritten.
_Avoid_: Global autonomy switch, `reversible=true` without a drill, inferred customer rule, direct Tool call outside Pi

**Initiative Trigger Inbox**:
The durable, multi-instance-fenced admission queue shared by Task-transition and enterprise-event adapters. A Trigger remains queued, processing, completed, awaiting a delivery route, or ready for notification without becoming an Objective or a second Agent loop.
_Avoid_: Event bus, Task Ledger, notification transport, heartbeat implementation

**Organizational Apprenticeship**:
The Agent's ongoing learning from observation, episodes, corrections, authoritative sources, and outcomes while it performs useful work.
_Avoid_: One-time onboarding, silent policy creation, passive logging

**Unknown-Business Evaluation Corpus**:
A seeded, reproducible set of situations, corrections, conflicts, long-running work, interruptions, and effects expressed with unfamiliar organizational vocabulary so Runtime quality is measured without assuming a customer's business ontology.
_Avoid_: Customer workflow template, demo prompts, industry ontology

**Behavioral Baseline**:
A versioned observation of Runtime quality, reliability, cost, and latency on a declared Evaluation Corpus and machine profile; it is evidence for regression decisions, not a permanent product rule.
_Avoid_: Acceptance Criteria, benchmark claim without evidence, universal SLA

**Acceptance Evidence Program**:
The machine-checked P0–P10 map from each architectural or quantitative requirement to a reproducible command and versioned evidence artifact, including explicit deferral reasons and exit criteria where production evidence does not yet exist.
_Avoid_: Checklist assertion, synthetic production claim, undocumented waiver

**Migration Rollback Rehearsal**:
An isolated exercise using production migration, backup, integrity-check, and persistence interfaces to prove legacy responsibility survives migration and a declared backup restores exactly its pre-backup state.
_Avoid_: Unit-only migration test, destructive production experiment, dual-write rollback

**Responsibility Identity**:
The durable owner of Objectives, Tasks, Plans, Sub-Agents, Effects, cancellation, and recovery. It may cross channels only through a trusted cross-application identity supplied by an adapter or identity provider; Session and Memory scopes remain separate.
_Avoid_: Display name, message-text identity, Session ID, automatic permission expansion

**Channel Runtime Contract**:
The rule that a channel may adapt ingress, media, presentation, and delivery but must use the shared Profile Runtime for Task, Effect, Governance, Verification, cancellation, recovery, and Pi execution. Channels never own or render a Tool approval workflow.
_Avoid_: Channel-specific Agent loop, channel Task store, ungoverned Tool factory

**Channel Runtime**:
The platform-neutral lifecycle and message contract through which Channel Instances connect to the Interaction Gateway; it owns no Profile Memory, Task, Effect, Governance, Verification, or Pi state.
_Avoid_: Messaging platform Adapter, Interaction Gateway, Agent Runtime

**Credential Secret**:
Sensitive authentication material that a trusted capability may use for an owner but must not return to the Agent, memory, transcript, or ordinary Tool result.
_Avoid_: Password memory, secret text, account fact

**Credential Ref**:
An owner-scoped opaque identifier that lets memory and Tasks refer to a Credential Secret without containing it.
_Avoid_: Password, token, vault path

**Credential Vault**:
The Profile-local protected store that owns Credential Secrets and injects them only into trusted capability operations while recording content-free access events.
_Avoid_: MEMORY.md, environment dump, password file
