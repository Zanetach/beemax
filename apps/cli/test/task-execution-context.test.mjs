import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryStore } from "@beemax/memory";
import { createAccessScopeRef, createExecutionEnvelope, createSituation, FileExecutionTraceStore } from "@beemax/core";
import { buildMainAgentSystemPrompt, buildSubagentSystemPrompt, createTaskVerifier, createVerifiedObjectiveMemoryPublisher, executeObjectiveDelivery, executePlannedTask, verificationAgentTools, verificationAgentToolsForTask } from "../dist/gateway.js";
import { createExecutionRoleTools } from "../dist/agent-factory.js";
import { createSuccessfulVerificationReceipt, normalizeVerifierEvidenceRefs } from "../dist/verification-protocol.js";

test("Sub-Agents must discover admitted capabilities and fail explicitly instead of weakening the Task contract", () => {
	const prompt = buildSubagentSystemPrompt();
	assert.match(prompt, /capability_discover/);
	assert.match(prompt, /Never replace the requested outcome, evidence standard, quality level, or mandatory constraint with a weaker substitute/);
	assert.match(prompt, /exact blocker and attempted remedies/);
});

test("main Agent preserves a minimal material citation set for independent verification", () => {
	const prompt = buildMainAgentSystemPrompt("Profile prompt");
	assert.match(prompt, /smallest sufficient set of material citations/i);
	assert.match(prompt, /every cited external URL/i);
});

test("verification agents receive a minimal semantic Tool Spec instead of every read-only capability", () => {
	const tools = verificationAgentTools([
		{ name: "fixture_status", description: "Read the fixture system status", aliases: ["status Tool"] },
		{ name: "unrelated_calendar", description: "Read calendar availability" },
	], "Verify the fixture system status with the status Tool");
	assert.ok(tools.includes("read"));
	assert.ok(tools.includes("verification_submit"));
	assert.ok(tools.includes("fixture_status"));
	assert.ok(!tools.includes("unrelated_calendar"));
	assert.ok(!tools.includes("capability_discover"));
	assert.ok(!tools.includes("task_checkpoint_save"));
	assert.ok(!tools.includes("grep"));
	assert.ok(!tools.includes("find"));
	assert.ok(!tools.includes("ls"));
	assert.ok(!tools.includes("skill_read"));
	assert.ok(!tools.includes("write"));
	assert.ok(!tools.includes("bash"));
});

test("verification Tool Spec re-admits an observed successful read Tool without lowering semantic thresholds", () => {
	const tools = verificationAgentTools([
		{ name: "mcp_fixture_status", description: "Read deterministic system status" },
		{ name: "mcp_unrelated_calendar", description: "Read calendar availability" },
	], "验证夹具状态", ["mcp_fixture_status"]);
	assert.ok(tools.includes("mcp_fixture_status"));
	assert.ok(!tools.includes("mcp_unrelated_calendar"));
});

test("verification Tool Spec keeps the observed web Provider and exact-source extractor without exposing competing search routes", () => {
	const tools = verificationAgentTools([], "Independently verify current public sources", ["agent_reach_search"], true);
	assert.deepEqual(tools, ["verification_submit", "read", "agent_reach_search", "web_extract"]);
	assert.equal(tools.includes("web_search"), false);
});

test("verification Tool Spec exposes exact-source extraction for external evidence from any Provider", () => {
	assert.deepEqual(verificationAgentTools([{ name: "mcp_public_source", description: "Read public evidence" }], "Verify the cited source", ["mcp_public_source"], true), ["verification_submit", "read", "mcp_public_source", "web_extract"]);
});

test("Task-aware verification Tool routing consistently exposes exact-source extraction", () => {
	assert.deepEqual(
		verificationAgentToolsForTask([], { title: "研究当前公开趋势", description: "核验来源", acceptanceCriteria: "保留可验证来源" }, ["agent_reach_search"]),
		["verification_submit", "read", "agent_reach_search", "web_extract"],
	);
});

test("the internal verdict Tool exists only in verification execution sessions", () => {
	assert.deepEqual(createExecutionRoleTools().map((tool) => tool.name), []);
	assert.deepEqual(createExecutionRoleTools({ mode: "normal" }).map((tool) => tool.name), []);
	assert.deepEqual(createExecutionRoleTools({ mode: "verification", verificationProtocol: "skill_candidate_v1" }).map((tool) => tool.name), []);
	assert.deepEqual(createExecutionRoleTools({ mode: "verification", verificationProtocol: "task_candidate_v1" }).map((tool) => tool.name), ["verification_submit"]);
});

test("verification evidence references resolve exact Tool names to concrete call receipts", () => {
	const receipts = new Map([
		["read-1", { callId: "read-1", toolName: "read", reference: "execution:e:tool-call:read-1", argumentsSha256: "sha256:a", resultSha256: "sha256:b" }],
		["read-2", { callId: "read-2", toolName: "read", reference: "execution:e:tool-call:read-2", argumentsSha256: "sha256:c", resultSha256: "sha256:d" }],
		["search-1", { callId: "search-1", toolName: "web_search", reference: "execution:e:tool-call:search-1", argumentsSha256: "sha256:e", resultSha256: "sha256:f" }],
	]);
	assert.deepEqual(normalizeVerifierEvidenceRefs("tool-call:read-1", receipts), ["tool-call:read-1"]);
	assert.deepEqual(normalizeVerifierEvidenceRefs("tool:web_search", receipts), ["tool-call:search-1"]);
	assert.deepEqual(normalizeVerifierEvidenceRefs("tool:read", receipts), ["tool-call:read-1", "tool-call:read-2"]);
	assert.deepEqual(normalizeVerifierEvidenceRefs("read:draft.md", receipts), []);
	assert.deepEqual(normalizeVerifierEvidenceRefs("candidate", receipts), []);
});

test("verification receipts preserve content-free argument and result identities and reject empty control results", () => {
	const receipt = createSuccessfulVerificationReceipt({ executionId: "verify:1", callId: "read:1", toolName: "read", args: { path: "draft.md" }, result: { content: [{ type: "text", text: "draft" }], details: { path: "draft.md" } } });
	assert.equal(receipt.reference, "execution:verify:1:tool-call:read:1");
	assert.match(receipt.argumentsSha256, /^sha256:[a-f0-9]{64}$/);
	assert.match(receipt.resultSha256, /^sha256:[a-f0-9]{64}$/);
	assert.equal(createSuccessfulVerificationReceipt({ executionId: "verify:1", callId: "empty", toolName: "read", args: {}, result: {} }), undefined);
	assert.equal(createSuccessfulVerificationReceipt({ executionId: "verify:1", callId: "submit", toolName: "verification_submit", args: {}, result: { details: { verdict: true } } }), undefined);
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
	let emit = () => undefined;
	let activeTools = ["verification_submit", "capability_discover", "read", "skill_read", "web_search", "agent_reach_search", "web_extract", "write"];
	let toolsDuringPrompt = [];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const factory = async (_source, _profile, receivedEnvelope) => {
		envelope = receivedEnvelope;
		return {
			agent, subscribe: (listener) => { emit = listener; return () => undefined; },
			getActiveToolNames: () => [...activeTools],
			getAllTools: () => activeTools.map((name) => ({ name })),
			setActiveToolsByName: (names) => { activeTools = [...names]; },
			prompt: async (text) => {
				prompt = text; toolsDuringPrompt = [...activeTools];
				emit({ type: "tool_execution_start", toolCallId: "read-situation", toolName: "read", args: { path: "result.txt" } });
				emit({ type: "tool_execution_end", toolCallId: "read-situation", toolName: "read", args: { path: "result.txt" }, isError: false, result: { content: [{ type: "text", text: "Friday" }], details: {} } });
				const args = { status: "accepted", reason: "All observable criteria passed", assertions: [{ criterionId: "C1", evidence: "Observed Friday", evidenceRefs: ["tool:read"] }] };
				emit({ type: "tool_execution_start", toolCallId: "verdict-situation", toolName: "verification_submit", args });
				emit({ type: "tool_execution_end", toolCallId: "verdict-situation", toolName: "verification_submit", args, isError: false, result: { content: [], details: {} } });
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "Verification submitted." }], usage: { input: 1, output: 1 } }];
			},
		abort: async () => undefined, dispose: () => undefined,
	}; };
	const verify = createTaskVerifier(factory, 1_000);
	const result = await verify({
		id: "task-verify", ownerKey: "cli:local:local", kind: "delegated", title: "当前目标是 Verify delivery", description: "仅操作当前隔离评测目录。", status: "running", createdAt: 1,
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
	assert.equal(envelope.verificationProtocol, "task_candidate_v1");
	assert.equal(envelope.budget.maxToolCalls, 6);
	assert.equal(envelope.budget.maxTokens, 20_000);
	assert.deepEqual(toolsDuringPrompt, ["verification_submit", "read", "web_search", "agent_reach_search", "web_extract"]);
});

test("independent verification rejects free-text verdicts instead of parsing model-authored envelopes", async () => {
	for (const answer of ["ACCEPT: unable to verify", '<beemax-verdict>{"status":"accepted","reason":"first","assertions":[]}</beemax-verdict><beemax-verdict>{"status":"accepted","reason":"second","assertions":[]}</beemax-verdict>', '<beemax-verdict>{"status":"unavailable","reason":"source provider offline"}</beemax-verdict>']) {
		let activeTools = ["verification_submit", "capability_discover", "read", "web_search", "agent_reach_search", "web_extract"];
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

test("independent verification accepts one schema-valid verdict Tool receipt without parsing free-form model text", async () => {
	let emit = () => undefined;
	let activeTools = ["verification_submit", "read"];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const factory = async () => ({
		agent,
		subscribe: (listener) => { emit = listener; return () => undefined; },
		getActiveToolNames: () => [...activeTools],
		getAllTools: () => activeTools.map((name) => ({ name })),
		setActiveToolsByName: (names) => { activeTools = [...names]; },
		prompt: async () => {
			emit({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "draft.md" } });
			emit({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", args: { path: "draft.md" }, isError: false, result: { content: [{ type: "text", text: "draft" }], details: {} } });
			const args = { status: "accepted", reason: "The requested draft exists", assertions: [{ criterionId: "C1", evidence: "draft.md was observed", evidenceRefs: ["tool:read"] }] };
			emit({ type: "tool_execution_start", toolCallId: "verdict-1", toolName: "verification_submit", args });
			emit({ type: "tool_execution_end", toolCallId: "verdict-1", toolName: "verification_submit", args, isError: false, result: { content: [{ type: "text", text: "Verdict recorded" }], details: {} } });
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "I submitted the verdict." }], usage: { input: 1, output: 1 } }];
		},
		abort: async () => undefined,
		dispose: () => undefined,
	});
	const verify = createTaskVerifier(factory, 1_000, undefined, ["verification_submit", "read"]);
	const result = await verify({ id: "task", ownerKey: "owner", kind: "delegated", title: "Verify draft", acceptanceCriteria: "draft exists", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } }, { output: "draft.md" });
	assert.equal(result.accepted, true);
	assert.match(result.evidence, /tool-call:read-1/);
});

test("independent verification does not let a fresh correction Session judge prior content-free receipts", async () => {
	let emit = () => undefined;
	let activeTools = ["verification_submit", "read"];
	let prompts = 0;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const factory = async () => ({
		agent,
		subscribe: (listener) => { emit = listener; return () => undefined; },
		getActiveToolNames: () => [...activeTools], getAllTools: () => ["verification_submit", "read"].map((name) => ({ name })), setActiveToolsByName: (names) => { activeTools = [...names]; },
		prompt: async () => {
			prompts++;
			if (prompts === 1) {
				emit({ type: "tool_execution_start", toolCallId: "read-correction", toolName: "read", args: { path: "draft.md" } });
				emit({ type: "tool_execution_end", toolCallId: "read-correction", toolName: "read", isError: false, result: { content: [{ type: "text", text: "draft" }], details: {} } });
			}
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }];
		},
		abort: async () => undefined, dispose: () => undefined,
	});
	await assert.rejects(
		() => createTaskVerifier(factory, 1_000, undefined, ["verification_submit", "read"])({ id: "task", ownerKey: "owner", kind: "delegated", title: "Verify draft", acceptanceCriteria: "draft exists", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } }, { output: "draft.md" }),
		/fresh Session cannot safely judge/,
	);
	assert.equal(prompts, 1);
});

test("independent verification gets one bounded evidence correction when its first Turn calls no Tool", async () => {
	let emit = () => undefined;
	let activeTools = ["verification_submit", "read"];
	let prompts = 0;
	const sessionSources = [];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const factory = async (_sessionId, source) => {
		sessionSources.push(source);
		return ({
		agent, subscribe: (listener) => { emit = listener; return () => undefined; },
		getActiveToolNames: () => [...activeTools], getAllTools: () => ["verification_submit", "read"].map((name) => ({ name })), setActiveToolsByName: (names) => { activeTools = [...names]; },
		prompt: async () => {
			prompts++;
			if (prompts === 2) {
				emit({ type: "tool_execution_start", toolCallId: "read-after-correction", toolName: "read", args: { path: "draft.md" } });
				emit({ type: "tool_execution_end", toolCallId: "read-after-correction", toolName: "read", isError: false, result: { content: [{ type: "text", text: "draft" }], details: {} } });
				const args = { status: "accepted", reason: "The corrected check observed the draft", assertions: [{ criterionId: "C1", evidence: "draft observed", evidenceRefs: ["tool:read"] }] };
				emit({ type: "tool_execution_start", toolCallId: "verdict-after-correction", toolName: "verification_submit", args });
				emit({ type: "tool_execution_end", toolCallId: "verdict-after-correction", toolName: "verification_submit", args, isError: false, result: { content: [{ type: "text", text: "recorded" }], details: {} } });
			}
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }];
		}, abort: async () => undefined, dispose: () => undefined,
		});
	};
	const result = await createTaskVerifier(factory, 1_000, undefined, ["verification_submit", "read"])({ id: "task", ownerKey: "owner", kind: "delegated", title: "Verify draft", acceptanceCriteria: "draft exists", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } }, { output: "draft.md" });
	assert.equal(prompts, 2);
	assert.equal(sessionSources.length, 2);
	assert.notEqual(sessionSources[0].threadId, sessionSources[1].threadId);
	assert.equal(result.accepted, true);
	assert.match(result.evidence, /:submit:tool-call:read-after-correction/);
});

test("independent verification refuses to carry search-only receipts into a fresh correction Session", async () => {
	let emit = () => undefined;
	let activeTools = ["verification_submit", "web_search", "web_extract"];
	let prompts = 0;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const factory = async () => ({
		agent, subscribe: (listener) => { emit = listener; return () => undefined; },
		getActiveToolNames: () => [...activeTools], getAllTools: () => ["verification_submit", "web_search", "web_extract"].map((name) => ({ name })), setActiveToolsByName: (names) => { activeTools = [...names]; },
		prompt: async () => {
			prompts++;
			if (prompts === 1) {
				emit({ type: "tool_execution_start", toolCallId: "search-only", toolName: "web_search", args: { query: "fact" } });
				emit({ type: "tool_execution_end", toolCallId: "search-only", toolName: "web_search", isError: false, result: { content: [{ type: "text", text: "https://source.example/report" }] } });
			}
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }];
		}, abort: async () => undefined, dispose: () => undefined,
	});
	await assert.rejects(
		() => createTaskVerifier(factory, 1_000, undefined, activeTools)(
			{ id: "task", ownerKey: "owner", kind: "delegated", title: "Verify current source", acceptanceCriteria: "source is current", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } },
			{ output: "Finding https://source.example/report" },
		),
		/fresh Session cannot safely judge/,
	);
	assert.equal(prompts, 1);
});

test("independent verification rejects a second structured verdict attempt even when the Tool rejects it", async () => {
	let emit = () => undefined;
	let activeTools = ["verification_submit", "read"];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const factory = async () => ({
		agent, subscribe: (listener) => { emit = listener; return () => undefined; },
		getActiveToolNames: () => [...activeTools], getAllTools: () => activeTools.map((name) => ({ name })), setActiveToolsByName: (names) => { activeTools = [...names]; },
		prompt: async () => {
			emit({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "draft.md" } });
			emit({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", isError: false, result: {} });
			const args = { status: "accepted", reason: "observed", assertions: [{ criterionId: "C1", evidence: "observed", evidenceRefs: ["tool:read"] }] };
			emit({ type: "tool_execution_start", toolCallId: "verdict-1", toolName: "verification_submit", args });
			emit({ type: "tool_execution_end", toolCallId: "verdict-1", toolName: "verification_submit", isError: false, result: {} });
			emit({ type: "tool_execution_start", toolCallId: "verdict-2", toolName: "verification_submit", args });
			emit({ type: "tool_execution_end", toolCallId: "verdict-2", toolName: "verification_submit", isError: true, result: {} });
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }];
		},
		abort: async () => undefined, dispose: () => undefined,
	});
	const verify = createTaskVerifier(factory, 1_000, undefined, ["verification_submit", "read"]);
	await assert.rejects(() => verify({ id: "task", ownerKey: "owner", kind: "delegated", title: "Verify", acceptanceCriteria: "draft exists", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } }, { output: "draft.md" }), /exactly one successful structured verdict/);
});

test("independent verification cannot accept an external URL without fetching it", async () => {
	let emit = () => undefined;
	let activeTools = ["verification_submit", "capability_discover", "read", "web_search", "agent_reach_search", "web_extract"];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const factory = async () => ({
		agent, subscribe: (listener) => { emit = listener; return () => undefined; },
		getActiveToolNames: () => [...activeTools], getAllTools: () => activeTools.map((name) => ({ name })), setActiveToolsByName: (names) => { activeTools = [...names]; },
		prompt: async () => {
			emit({ type: "tool_execution_start", toolCallId: "search-1", toolName: "web_search", args: { query: "fact" } });
			emit({ type: "tool_execution_end", toolCallId: "search-1", toolName: "web_search", args: { query: "fact" }, isError: false, result: { content: [{ type: "text", text: "search result" }], details: {} } });
			const args = { status: "accepted", reason: "looks plausible", assertions: [{ criterionId: "C1", evidence: "claimed URL", evidenceRefs: ["tool:web_search"] }] };
			emit({ type: "tool_execution_start", toolCallId: "verdict-1", toolName: "verification_submit", args });
			emit({ type: "tool_execution_end", toolCallId: "verdict-1", toolName: "verification_submit", args, isError: false, result: {} });
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "submitted" }], usage: { input: 1, output: 1 } }];
		},
		abort: async () => undefined, dispose: () => undefined,
	});
	const verify = createTaskVerifier(factory, 1_000);
	await assert.rejects(() => verify({ id: "task", ownerKey: "owner", kind: "delegated", title: "Verify URL", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } }, { output: "Source: https://example.com/fact" }), /not every cited external source URL was independently fetched/);
});

test("independent verification cannot accept current research from search receipts alone", async () => {
	let emit = () => undefined;
	const activeTools = ["verification_submit", "web_search", "web_extract"];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const factory = async () => ({
		agent, subscribe: (listener) => { emit = listener; return () => undefined; },
		getActiveToolNames: () => [...activeTools], getAllTools: () => activeTools.map((name) => ({ name })), setActiveToolsByName: () => undefined,
		prompt: async () => {
			emit({ type: "tool_execution_start", toolCallId: "search-only", toolName: "web_search", args: { query: "current trend" } });
			emit({ type: "tool_execution_end", toolCallId: "search-only", toolName: "web_search", isError: false, result: { content: [{ type: "text", text: "current source summary" }] } });
			const args = { status: "accepted", reason: "search returned a summary", assertions: [{ criterionId: "C1", evidence: "summary", evidenceRefs: ["tool:web_search"] }] };
			emit({ type: "tool_execution_start", toolCallId: "verdict-search", toolName: "verification_submit", args });
			emit({ type: "tool_execution_end", toolCallId: "verdict-search", toolName: "verification_submit", isError: false, result: {} });
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "submitted" }], usage: { input: 1, output: 1 } }];
		}, abort: async () => undefined, dispose: () => undefined,
	});
	const verify = createTaskVerifier(factory, 1_000, undefined, activeTools);
	await assert.rejects(
		() => verify({ id: "task", ownerKey: "owner", kind: "delegated", title: "Verify current public research", acceptanceCriteria: "current sources are independently verified", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } }, { output: "A current trend summary without preserved URLs" }),
		/exact-source extraction receipt/,
	);
});

test("independent verification derives enough Tool budget to fetch every cited source", async () => {
	let emit = () => undefined;
	let envelope;
	const urls = Array.from({ length: 7 }, (_, index) => `https://source-${index + 1}.example/report`);
	let activeTools = ["verification_submit", "web_search", "web_extract"];
	let toolsDuringPrompt = [];
	let verificationPrompt = "";
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const factory = async (_source, _profile, receivedEnvelope) => {
		envelope = receivedEnvelope;
		return {
			agent, subscribe: (listener) => { emit = listener; return () => undefined; },
			getActiveToolNames: () => [...activeTools], getAllTools: () => activeTools.map((name) => ({ name })), setActiveToolsByName: (names) => { activeTools = [...names]; },
			prompt: async (text) => {
				verificationPrompt = text;
				toolsDuringPrompt = [...activeTools];
				for (const [index, url] of urls.entries()) {
					const callId = `extract-${index + 1}`;
					emit({ type: "tool_execution_start", toolCallId: callId, toolName: "web_extract", args: { url } });
					emit({ type: "tool_execution_end", toolCallId: callId, toolName: "web_extract", isError: false, result: { content: [{ type: "text", text: `source ${index + 1}` }] } });
				}
				const args = { status: "accepted", reason: "all cited sources fetched", assertions: [{ criterionId: "C1", evidence: "sources fetched", evidenceRefs: ["tool:web_extract"] }] };
				emit({ type: "tool_execution_start", toolCallId: "verdict-all", toolName: "verification_submit", args });
				emit({ type: "tool_execution_end", toolCallId: "verdict-all", toolName: "verification_submit", isError: false, result: {} });
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "submitted" }], usage: { input: 1, output: 1 } }];
			}, abort: async () => undefined, dispose: () => undefined,
		};
	};
	const verify = createTaskVerifier(factory, 1_000, undefined, activeTools);
	const result = await verify(
		{ id: "task", ownerKey: "owner", kind: "delegated", title: "Verify current public research", acceptanceCriteria: "all cited sources are independently verified", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } },
		{ output: `${"context ".repeat(3_000)}\n${urls.map((url) => `Source: ${url}`).join("\n")}` },
	);
	assert.equal(result.accepted, true);
	assert.equal(envelope.budget.maxToolCalls, 11);
	assert.equal(envelope.budget.maxTokens, 34_000);
	assert.equal(toolsDuringPrompt.includes("web_search"), false);
	assert.match(verificationPrompt, /required-exact-source-urls/);
	assert.match(verificationPrompt, /source-7\.example/);
});
