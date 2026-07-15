import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryStore } from "@beemax/memory";
import { createAccessScopeRef, createExecutionEnvelope, createSituation, FileExecutionTraceStore } from "@beemax/core";
import { buildSubagentSystemPrompt, createTaskVerifier, createVerifiedObjectiveMemoryPublisher, executeObjectiveDelivery, executePlannedTask, verificationAgentTools } from "../dist/gateway.js";

test("Sub-Agents must discover admitted capabilities and fail explicitly instead of weakening the Task contract", () => {
	const prompt = buildSubagentSystemPrompt();
	assert.match(prompt, /capability_discover/);
	assert.match(prompt, /Never replace the requested outcome, evidence standard, quality level, or mandatory constraint with a weaker substitute/);
	assert.match(prompt, /exact blocker and attempted remedies/);
});

test("verification agents receive only the required local read capabilities in addition to shared read-only tools", () => {
	const tools = verificationAgentTools(["mcp_read"]);
	assert.ok(tools.includes("read"));
	assert.ok(tools.includes("capability_discover"));
	assert.ok(tools.includes("skill_read"));
	assert.ok(tools.includes("task_checkpoint_save"));
	assert.ok(tools.includes("mcp_read"));
	assert.ok(!tools.includes("write"));
	assert.ok(!tools.includes("bash"));
});

test("recovered Pi execution receives durable Situation without exposing Access Scope provenance", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-planned-runtime-trace-"));
	const executionTrace = new FileExecutionTraceStore(join(root, "execution-trace.jsonl"));
	let prompt = "";
	let envelope;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const factory = async (_source, _profile, receivedEnvelope) => {
		envelope = receivedEnvelope;
		return {
		agent, subscribe: () => () => undefined,
		prompt: async (text) => { prompt = text; agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; },
		abort: async () => undefined, dispose: () => undefined,
	}; };
	const accessScopeRef = createAccessScopeRef({ id: "scope:cloud-whale", authority: { kind: "enterprise_system", reference: "iam:cloud-whale" }, issuedAt: 1 });
	const graphEnvelope = createExecutionEnvelope({ executionId: "execution:run-situation", trigger: { kind: "recovery", id: "task-situation" }, objectiveId: "objective-situation", taskId: "task-situation", taskRunId: "run-situation", accessScopeRef, budget: { maxCorrectiveAttempts: 2 }, mode: "recovery" });
	await executePlannedTask(factory, {
		id: "task-situation", parentId: "objective-situation", ownerKey: "cli:local:local", kind: "delegated", title: "校准", status: "running", createdAt: 1,
		situation: createSituation({ summary: "云鲸信标需要完成折光校准", goals: ["完成校准"], constraints: ["保持航道开放"], confidence: 0.9 }),
		accessScopeRef,
	}, { platform: "cli", chatId: "local", chatType: "dm", userId: "local" }, undefined, 1_000, { executionEnvelope: graphEnvelope, taskRunId: "run-situation", attempt: 1, executionMode: "recovery", maxCorrectiveAttempts: 2, dependencies: [], saveCheckpoint: () => true }, executionTrace);
	assert.match(prompt, /云鲸信标/);
	assert.match(prompt, /保持航道开放/);
	assert.doesNotMatch(prompt, /scope:cloud-whale/);
	assert.doesNotMatch(prompt, /iam:cloud-whale/);
	assert.deepEqual(envelope, {
		executionId: "execution:run-situation",
		trigger: { kind: "recovery", id: "task-situation" },
		objectiveId: "objective-situation", taskId: "task-situation", taskRunId: "run-situation",
		accessScopeRef: createAccessScopeRef({ id: "scope:cloud-whale", authority: { kind: "enterprise_system", reference: "iam:cloud-whale" }, issuedAt: 1 }),
		budget: { maxCorrectiveAttempts: 2, deadlineAt: envelope.budget.deadlineAt }, mode: "recovery",
	});
	assert.ok(Object.isFrozen(envelope));
	assert.deepEqual(executionTrace.trace({ executionId: "execution:run-situation", accessScopeId: "scope:cloud-whale" }).events.map((event) => event.type), ["execution.started", "execution.settled"]);
	rmSync(root, { recursive: true, force: true });
});

test("planned Pi execution consumes Effect projections from the authority", async () => {
	let prompt = "";
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const factory = async () => ({
		agent, subscribe: () => () => undefined,
		prompt: async (text) => { prompt = text; agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; },
		abort: async () => undefined, dispose: () => undefined,
	});
	await executePlannedTask(factory, {
		id: "task-1", ownerKey: "cli:local:local", kind: "delegated", title: "Check delivery", status: "running", createdAt: 1,
		businessContext: { subject: { type: "customer", id: "A" }, object: { type: "order", id: "PO-1" } },
	}, { platform: "cli", chatId: "local", chatType: "dm", userId: "local" }, undefined, 1_000, { taskRunId: "run-legacy", attempt: 2, executionMode: "normal", maxCorrectiveAttempts: 1, dependencies: [], checkpoint: "halfway", saveCheckpoint: () => true }, undefined, {
		taskProjection: ({ ownerKey, taskId }) => ownerKey === "cli:local:local" && taskId === "task-1" ? [{ id: "effect-1", taskRunId: "run-first", tool: "feishu_send", operation: "send delivery notice", status: "committed", externalRef: "message-42", occurredAt: 2 }] : [],
	});
	assert.doesNotMatch(prompt, /<beemax-work-context>/);
	assert.doesNotMatch(prompt, /customer|PO-1|businessContext/);
	assert.match(prompt, /<durable-checkpoint>/);
	assert.match(prompt, /<authoritative-effects>/);
	assert.match(prompt, /"status":"committed"/);
	assert.match(prompt, /message-42/);
});

test("planned Pi execution returns structured evidence, artifacts, and unresolved issues", async () => {
	let prompt = "";
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const factory = async () => ({
		agent, subscribe: () => () => undefined,
		prompt: async (text) => {
			prompt = text;
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: '<beemax-task-result>{"output":"Delivery is Friday","evidence":"ERP checked","artifacts":[{"type":"url","uri":"https://example.test/PO-1","label":"Order"}],"unresolvedIssues":["Warehouse sign-off pending"]}</beemax-task-result>' }], usage: { input: 1, output: 1 } }];
		},
		abort: async () => undefined, dispose: () => undefined,
	});
	const result = await executePlannedTask(factory, {
		id: "task-structured", ownerKey: "cli:local:local", kind: "delegated", title: "Check delivery", status: "running", createdAt: 1,
	}, { platform: "cli", chatId: "local", chatType: "dm", userId: "local" }, undefined, 1_000);
	assert.match(prompt, /<beemax-task-result>/);
	assert.deepEqual(result, {
		output: "Delivery is Friday", evidence: "ERP checked",
		artifacts: [{ type: "url", uri: "https://example.test/PO-1", label: "Order" }],
		unresolvedIssues: ["Warehouse sign-off pending"],
	});
});

test("planned Pi execution checkpoints meaningful turn progress without a checkpoint Tool call", async () => {
	let listener;
	const saved = [];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const factory = async () => ({
		agent, subscribe: (next) => { listener = next; return () => undefined; },
		prompt: async () => {
			listener({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: {}, isError: false });
			listener({ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] });
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }];
		},
		abort: async () => undefined, dispose: () => undefined,
	});
	await executePlannedTask(factory, {
		id: "task-native-checkpoint", ownerKey: "cli:local:local", kind: "delegated", title: "Inspect", status: "running", createdAt: 1,
	}, { platform: "cli", chatId: "local", chatType: "dm", userId: "local" }, undefined, 1_000, {
		taskRunId: "run-native-checkpoint", attempt: 1, executionMode: "normal", maxCorrectiveAttempts: 0, dependencies: [],
		saveCheckpoint: (checkpoint) => { saved.push(checkpoint); return true; },
	}, undefined, { taskProjection: () => [] });
	assert.equal(saved.length, 1);
	assert.equal(saved[0].source, "pi_turn");
	assert.equal(saved[0].taskRunId, "run-native-checkpoint");
	assert.deepEqual(saved[0].completed, ["read:read-1"]);
});

test("verified Objective outcomes become generic idempotent Situation-backed Memory Episodes", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-verified-outcome-memory-"));
	const memory = new MemoryStore(join(root, "memory.db"));
	try {
		const publish = createVerifiedObjectiveMemoryPublisher(memory);
		publish({
			objectiveId: "objective-1", title: "Order delivery", result: "Delivery is Friday", evidence: "ERP checked",
			executionScope: { platform: "feishu", chatId: "sales", chatType: "group", userId: "seller" },
			situation: createSituation({ summary: "浮光引擎交付已完成", goals: ["确认交付"], confidence: 1 }),
		});
		publish({
			objectiveId: "objective-1", title: "Order delivery", result: "Delivery is Friday", evidence: "ERP checked",
			executionScope: { platform: "feishu", chatId: "sales", chatType: "group", userId: "seller" },
			situation: createSituation({ summary: "浮光引擎交付已完成", goals: ["确认交付"], confidence: 1 }),
		});
		const scope = { platform: "feishu", chatId: "sales", userId: "seller" };
		assert.match(memory.recallEpisodes("Friday", scope)[0].outcome, /Delivery is Friday/);
		assert.equal(memory.listEpisodes(scope).length, 1);
	} finally { memory.close(); rmSync(root, { recursive: true, force: true }); }
});

test("verified Objective outcomes containing credentials are never published from any field", () => {
	for (const unsafe of [
		{ title: "OPENAI_API_KEY=sk-title-secret", result: "safe", evidence: "safe" },
		{ title: "safe", result: "safe", evidence: "Authorization: Bearer evidence-secret" },
	]) {
		let writes = 0;
		createVerifiedObjectiveMemoryPublisher({ upsertEpisode: () => { writes++; return {}; } })({
			objectiveId: "objective-secret", ...unsafe,
			executionScope: { platform: "feishu", chatId: "sales", chatType: "group", userId: "seller" },
			situation: createSituation({ summary: "安全发布验证", confidence: 1 }),
		});
		assert.equal(writes, 0);
	}
});

test("Objective delivery receives Situation Work Context", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-objective-delivery-trace-"));
	const executionTrace = new FileExecutionTraceStore(join(root, "execution-trace.jsonl"));
	let prompt = "";
	let deliveryEnvelope;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const factory = async (_source, _profile, envelope) => {
		deliveryEnvelope = envelope;
		return {
		agent, subscribe: () => () => undefined,
		prompt: async (text) => { prompt = text; agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "delivered" }], usage: { input: 1, output: 1 } }]; },
		abort: async () => undefined, dispose: () => undefined,
	}; };
	await executeObjectiveDelivery(factory, { planId: "plan-1", objective: {
		id: "objective-1", ownerKey: "cli:local:local", kind: "objective", title: "Deliver order", status: "running", createdAt: 1,
		executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" },
		situation: createSituation({ summary: "晨雾航标需要完成交付", constraints: ["保留航道"], confidence: 0.9 }),
	}, tasks: [{
		id: "task-1", ownerKey: "cli:local:local", kind: "delegated", title: "Research", status: "succeeded", createdAt: 1, result: "Friday",
		artifacts: [{ type: "file", uri: "/tmp/delivery-report.pdf", label: "Delivery report" }], unresolvedIssues: ["Warehouse sign-off pending"],
	}] }, undefined, 1_000, executionTrace);
	assert.match(prompt, /<beemax-work-context>/);
	assert.match(prompt, /晨雾航标/);
	assert.match(prompt, /delivery-report\.pdf/);
	assert.match(prompt, /Warehouse sign-off pending/);
	const trace = executionTrace.trace({ executionId: deliveryEnvelope.executionId });
	assert.equal(trace.deliveries, 1);
	assert.equal(trace.deliveryStatus, "succeeded");
	assert.deepEqual(trace.events.map((event) => event.type), ["delivery.started", "execution.started", "execution.settled", "delivery.settled"]);
	rmSync(root, { recursive: true, force: true });
});

test("independent verification receives the Task Situation", async () => {
	let prompt = "";
	let envelope;
	let activeTools = ["capability_discover", "read", "skill_read", "web_search", "agent_reach_search", "web_extract", "write"];
	let toolsDuringPrompt = [];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const factory = async (_source, _profile, receivedEnvelope) => {
		envelope = receivedEnvelope;
		return {
			agent, subscribe: () => () => undefined,
			getActiveToolNames: () => [...activeTools],
			getAllTools: () => activeTools.map((name) => ({ name })),
			setActiveToolsByName: (names) => { activeTools = [...names]; },
			prompt: async (text) => { prompt = text; toolsDuringPrompt = [...activeTools]; agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: '```json\n{"status":"accepted","reason":"All observable criteria passed","assertions":[{"criterionId":"C1","evidence":"Candidate value is Friday","evidenceRefs":["candidate"]}]}\n```' }], usage: { input: 1, output: 1 } }]; },
		abort: async () => undefined, dispose: () => undefined,
	}; };
	const verify = createTaskVerifier(factory, 1_000);
	const result = await verify({
		id: "task-verify", ownerKey: "cli:local:local", kind: "delegated", title: "Verify delivery", description: "仅操作当前隔离评测目录。", status: "running", createdAt: 1,
		executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" },
		situation: createSituation({ summary: "棱镜节点需要独立验证", goals: ["确认结果"], confidence: 0.9 }),
		acceptanceCriteria: "Matches the order",
	}, { output: "Friday" }, undefined, { taskRunId: "run-verify" });
	assert.equal(result.accepted, true);
	assert.match(prompt, /<beemax-work-context>/);
	assert.match(prompt, /棱镜节点/);
	assert.equal(envelope.mode, "verification");
	assert.equal(envelope.taskId, "task-verify");
	assert.equal(envelope.taskRunId, "run-verify");
	assert.equal(envelope.trigger.kind, "verification");
	assert.deepEqual(toolsDuringPrompt, ["capability_discover", "read", "web_search", "agent_reach_search", "web_extract"]);
});

test("independent verification treats invalid or unavailable verdicts as unavailable instead of acceptance", async () => {
	for (const answer of ["ACCEPT: unable to verify", '<beemax-verdict>{"status":"unavailable","reason":"source provider offline"}</beemax-verdict>']) {
		let activeTools = ["capability_discover", "read", "web_search", "agent_reach_search", "web_extract"];
		const agent = { state: { model: { id: "test" }, messages: [] } };
		const factory = async () => ({
			agent, subscribe: () => () => undefined,
			getActiveToolNames: () => [...activeTools], getAllTools: () => activeTools.map((name) => ({ name })), setActiveToolsByName: (names) => { activeTools = [...names]; },
			prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: answer }], usage: { input: 1, output: 1 } }]; },
			abort: async () => undefined, dispose: () => undefined,
		});
		const verify = createTaskVerifier(factory, 1_000);
		await assert.rejects(() => verify({ id: "task", ownerKey: "owner", kind: "delegated", title: "Verify", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } }, { output: "candidate" }), /Verification unavailable/);
	}
});

test("independent verification cannot accept an external URL without fetching it", async () => {
	let activeTools = ["capability_discover", "read", "web_search", "agent_reach_search", "web_extract"];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const factory = async () => ({
		agent, subscribe: () => () => undefined,
		getActiveToolNames: () => [...activeTools], getAllTools: () => activeTools.map((name) => ({ name })), setActiveToolsByName: (names) => { activeTools = [...names]; },
		prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: '<beemax-verdict>{"status":"accepted","reason":"looks plausible","assertions":[{"criterionId":"C1","evidence":"claimed URL","evidenceRefs":["candidate"]}]}</beemax-verdict>' }], usage: { input: 1, output: 1 } }]; },
		abort: async () => undefined, dispose: () => undefined,
	});
	const verify = createTaskVerifier(factory, 1_000);
	await assert.rejects(() => verify({ id: "task", ownerKey: "owner", kind: "delegated", title: "Verify URL", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } }, { output: "Source: https://example.com/fact" }), /not every cited external source URL was independently fetched/);
});
