# BeeMax Agent

BeeMax coordinates durable work for a personal Agent across conversations, channels, automation, and delegated workers.

## Language

**Task**:
A durable outcome the Agent has accepted responsibility for delivering.
_Avoid_: Job, todo, agent run

**Task Run**:
One execution attempt for a Task; retries create additional Task Runs without duplicating the Task.
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

**Terminal Outcome**:
The first persisted succeeded, failed, or cancelled state of a Task Plan, Task, or Task Run; later executors may observe it but cannot replace it.
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

**Candidate Result**:
Task execution output retained for Verification; it cannot satisfy dependencies or become an accepted outcome until Verification succeeds.
_Avoid_: Final answer, successful result, evidence

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
A rule that creates Tasks at a future time or recurring cadence; it is not itself a Task.
_Avoid_: Scheduled task, cron job

**Delegation**:
A parent Task assigning a bounded child Task to a Sub-Agent while retaining responsibility for the outcome.
_Avoid_: Spawn, background chat

**Turn**:
One user-to-Agent interaction inside a conversation; a Turn may create, inspect, or advance Tasks.
_Avoid_: Task, run
