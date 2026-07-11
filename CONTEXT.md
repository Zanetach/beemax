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

**Task Dependency**:
A requirement that one Task succeed before another Task becomes ready.
_Avoid_: Ordering hint, parent Task

**Profile Task Scheduler**:
The Profile-wide admission controller that shares delegated execution capacity across conversations and Task Plans.
_Avoid_: Task queue, Sub-Agent manager, Task Plan runner

**Schedule**:
A rule that creates Tasks at a future time or recurring cadence; it is not itself a Task.
_Avoid_: Scheduled task, cron job

**Delegation**:
A parent Task assigning a bounded child Task to a Sub-Agent while retaining responsibility for the outcome.
_Avoid_: Spawn, background chat

**Turn**:
One user-to-Agent interaction inside a conversation; a Turn may create, inspect, or advance Tasks.
_Avoid_: Task, run
