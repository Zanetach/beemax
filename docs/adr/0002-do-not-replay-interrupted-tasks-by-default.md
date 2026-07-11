# Do not replay interrupted Tasks by default

An expired Execution Lease proves only that its executor disappeared, not whether external effects occurred. BeeMax therefore fails interrupted Tasks by default and permits automatic retry only when the Task explicitly declares a safe-retry Recovery Policy and a stable Idempotency Key; this favors duplicate-effect safety over optimistic completion after restart.
