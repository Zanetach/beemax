# BeeMax Agent

BeeMax coordinates durable work for a personal Agent across conversations, channels, automation, and delegated workers.

## Language

**Task**:
A durable outcome the Agent has accepted responsibility for delivering.
_Avoid_: Job, todo, agent run

**Task Run**:
One execution attempt for a Task; retries create additional Task Runs without duplicating the Task.
_Avoid_: Task, session, turn

**Schedule**:
A rule that creates Tasks at a future time or recurring cadence; it is not itself a Task.
_Avoid_: Scheduled task, cron job

**Delegation**:
A parent Task assigning a bounded child Task to a Sub-Agent while retaining responsibility for the outcome.
_Avoid_: Spawn, background chat

**Turn**:
One user-to-Agent interaction inside a conversation; a Turn may create, inspect, or advance Tasks.
_Avoid_: Task, run
