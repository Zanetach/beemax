import { appendFileSync } from "node:fs";
import { MemoryStore } from "../../dist/index.js";
import { TaskGraph, TaskRecoveryRunner } from "@thruvera/core";

const request = JSON.parse(process.argv[2] ?? "null");
if (!request?.databasePath || !request?.mode || !request?.executionLog) throw new Error("claim worker request is required");
const scenarios = {
	"recover": {},
	"crash-during-execution": { exitCode: 17 },
	"crash-after-checkpoint": { checkpoint: "phase=checkpointed", exitCode: 18 },
	"crash-after-heartbeats": { delayMs: 250, directGraph: true, exitCode: 19 },
	"crash-after-terminal-task-write": { crashAfterTaskWrite: true, exitCode: 20 },
};
const scenario = scenarios[request.mode];
if (!scenario) throw new Error(`unknown claim worker mode: ${request.mode}`);

const store = new MemoryStore(request.databasePath);
let executions = 0;
const execute = async (task, _signal, context) => {
	executions++;
	appendFileSync(request.executionLog, `${JSON.stringify({ pid: process.pid, taskId: task.id, checkpoint: context?.checkpoint })}\n`);
	if (scenario.checkpoint && !context?.saveCheckpoint(scenario.checkpoint)) process.exit(3);
	if (scenario.delayMs) await new Promise((resolve) => setTimeout(resolve, scenario.delayMs));
	if (scenario.exitCode && !scenario.crashAfterTaskWrite) process.exit(scenario.exitCode);
	return { output: `completed-by-${process.pid}` };
};

try {
	if (scenario.crashAfterTaskWrite) {
		const transition = store.transition.bind(store);
		store.transition = (id, change) => {
			const changed = transition(id, change);
			if (changed && change.status === "succeeded") process.exit(scenario.exitCode);
			return changed;
		};
	}
	const summary = scenario.directGraph
		? await new TaskGraph(store).run([request.ownerKey], request.planId, execute, { leaseMs: 1_000, leaseHeartbeatMs: 25 })
		: await new TaskRecoveryRunner(store, execute).run({ maxConcurrent: request.maxConcurrent ?? 4 });
	process.stdout.write(`${JSON.stringify({ pid: process.pid, executions, summary })}\n`);
} finally {
	store.close();
}
