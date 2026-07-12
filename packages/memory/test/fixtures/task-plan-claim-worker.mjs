import { appendFileSync } from "node:fs";
import { MemoryStore } from "../../dist/index.js";
import { TaskRecoveryRunner } from "@beemax/core";

const request = JSON.parse(process.argv[2] ?? "null");
if (!request?.databasePath || !request?.mode || !request?.executionLog) throw new Error("claim worker request is required");

const store = new MemoryStore(request.databasePath);
let executions = 0;
const runner = new TaskRecoveryRunner(store, async (task) => {
	executions++;
	appendFileSync(request.executionLog, `${JSON.stringify({ pid: process.pid, taskId: task.id })}\n`);
	if (request.mode === "crash-during-execution") process.exit(17);
	return { output: `completed-by-${process.pid}` };
});

try {
	const summary = await runner.run({ maxConcurrent: request.maxConcurrent ?? 4 });
	process.stdout.write(`${JSON.stringify({ pid: process.pid, executions, summary })}\n`);
} finally {
	store.close();
}
