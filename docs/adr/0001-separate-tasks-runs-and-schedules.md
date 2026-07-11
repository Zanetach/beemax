# Separate Tasks, Task Runs, and Schedules

BeeMax models an accepted outcome as a durable Task, each execution attempt as a Task Run, and automation configuration as a Schedule that creates Tasks. We rejected treating Automation Jobs and Sub-Agent processes as interchangeable tasks because that loses retry history, makes recurring work ambiguous, and couples durable responsibility to one execution mechanism.
