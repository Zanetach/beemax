import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryStore } from "@beemax/memory";
import { AgentRunError, AuthStorage, BeeMaxAgentRuntime, buildBeeMaxRuntimeFactory, buildTaskPreservationEnvelope, ConversationContext, createAccessScopeRef, createEnterprisePolicyProvider, createEnterprisePolicyPublisher, createExecutionEnvelope, createSituation, defineTool, FileExecutionTraceStore, getBuiltinModel, isRecoverableModelFailure, MUTATING_TOOL_POLICY, SessionCoordinator, sessionIdForSource, withToolPolicy } from "../dist/index.js";

test("BeeMax Core owns the runtime primitive boundary", () => {
	assert.equal(typeof AuthStorage.create, "function");
	assert.equal(typeof defineTool, "function");
	assert.equal(typeof getBuiltinModel, "function");
	assert.equal(typeof buildBeeMaxRuntimeFactory, "function");
	assert.equal(isRecoverableModelFailure({ status: 429 }), true);
	assert.equal(isRecoverableModelFailure({ statusCode: 503 }), true);
	assert.equal(isRecoverableModelFailure(new Error("upstream returned 503")), true);
	assert.equal(isRecoverableModelFailure(new Error("fetch failed")), true);
	assert.equal(isRecoverableModelFailure({ status: 401 }), false);
	assert.equal(isRecoverableModelFailure(new Error("invalid API key")), false);
});

test("BeeMax applies Profile compaction policy as an in-memory Pi session setting", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-compaction-settings-"));
	try {
		const factory = buildBeeMaxRuntimeFactory({
			provider: "anthropic", model: "claude-sonnet-4-5", cwd: root, agentDir: join(root, "agent"), getApiKey: () => "test",
			systemPrompt: "test", skillToolset: "safe", createTools: () => [],
			compaction: { enabled: false, reserveTokens: 12_000, keepRecentTokens: 16_000 },
		});
		const session = await factory("compaction-settings", { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" });
		try {
			assert.deepEqual(session.compactionSettings, { enabled: false, reserveTokens: 12_000, keepRecentTokens: 16_000 });
		} finally { session.dispose(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("custom model limits drive model-aware compaction instead of a fixed 128K assumption", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-custom-model-limits-"));
	try {
		const factory = buildBeeMaxRuntimeFactory({
			provider: "custom", model: "private-model", baseUrl: "https://models.example.test/v1",
			modelLimits: { contextWindow: 32_000, maxTokens: 4_096 }, cwd: root, agentDir: join(root, "agent"), getApiKey: () => "test",
			systemPrompt: "test", skillToolset: "safe", createTools: () => [],
		});
		const session = await factory("custom-model-limits", { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" });
		try {
			assert.equal(session.agent.state.model.contextWindow, 32_000);
			assert.equal(session.agent.state.model.maxTokens, 4_096);
			assert.deepEqual(session.compactionSettings, { enabled: true, reserveTokens: 4_800, keepRecentTokens: 8_000 });
		} finally { session.dispose(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("BeeMax runtime connects approved mutating Tool calls to the Effect lifecycle", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-effect-hook-"));
	const events = [];
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	try {
		const envelope = createExecutionEnvelope({ executionId: "execution:effect", trigger: { kind: "delegation" }, taskId: "task:envelope", budget: { maxToolCalls: 1 } });
		const factory = buildBeeMaxRuntimeFactory({
			provider: "anthropic", model: "claude-sonnet-4-5", cwd: root, agentDir: join(root, "agent"), getApiKey: () => "test",
			systemPrompt: "test", skillToolset: "safe", tools: ["mutation"], authorizeTool: async () => ({ allowed: true }),
			toolEffects: {
				begin(input) { events.push(["begin", input.taskId, input.toolCallId, input.toolName]); return "effect-1"; },
				finish(input) { events.push(["finish", input.toolCallId, input.toolName, input.isError]); },
			},
			createTools: () => [withToolPolicy(defineTool({ name: "mutation", label: "Mutation", description: "Mutate", parameters: {}, execute: async () => ({ content: [], details: {} }) }), MUTATING_TOOL_POLICY)],
		});
		const session = await factory("effect-session", source, envelope);
		try {
			const toolCall = { id: "call-1", name: "mutation", arguments: {} };
			const common = { assistantMessage: {}, toolCall, args: {}, context: {} };
			assert.equal(await session.agent.beforeToolCall(common), undefined);
			await session.agent.afterToolCall({ ...common, result: { content: [], details: {} }, isError: false });
			assert.deepEqual(events, [["begin", "task:envelope", "call-1", "mutation"], ["finish", "call-1", "mutation", false]]);
			const second = await session.agent.beforeToolCall({ ...common, toolCall: { id: "call-2", name: "mutation", arguments: {} } });
			assert.equal(second.block, true);
			assert.match(second.reason, /tool-call budget exceeded/i);
			assert.equal(events.length, 2);
		} finally { session.dispose(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("BeeMax rejects a model Tool call that is not in the current Pi Active Tools", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-hidden-tool-call-"));
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	let approvals = 0;
	try {
		const factory = buildBeeMaxRuntimeFactory({
			provider: "anthropic", model: "claude-sonnet-4-5", cwd: root, agentDir: join(root, "agent"), getApiKey: () => "test",
			systemPrompt: "test", skillToolset: "safe", tools: ["mutation"], authorizeTool: async () => { approvals++; return { allowed: true }; },
			createTools: () => [withToolPolicy(defineTool({ name: "mutation", label: "Mutation", description: "Mutate", parameters: {}, execute: async () => ({ content: [], details: {} }) }), MUTATING_TOOL_POLICY)],
		});
		const session = await factory("hidden-tool-call", source);
		try {
			session.setActiveToolsByName([]);
			const blocked = await session.agent.beforeToolCall({ assistantMessage: {}, toolCall: { id: "call-hidden", name: "mutation", arguments: {} }, args: {}, context: {} });
			assert.equal(blocked.block, true);
			assert.match(blocked.reason, /not active for the current Pi turn/i);
			assert.equal(approvals, 0);
		} finally { session.dispose(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Enterprise Policy denies an action before legacy approval and Effect admission", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-enterprise-policy-hook-"));
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	let approvals = 0; let effects = 0; const audit = [];
	try {
		const enterprisePolicy = createEnterprisePolicyProvider({
			publisher: createEnterprisePolicyPublisher({ id: "security", authority: { kind: "enterprise_system", reference: "policy-service" }, evidenceRef: "publisher:audit", issuedAt: 1 }),
			version: "v7", effectiveScope: { kind: "global", id: "enterprise" }, effectiveFrom: 1,
			decide: async () => ({ id: "deny-mutation", disposition: "deny", reason: "Enterprise change freeze", evidenceRefs: ["change-freeze:2026-07"] }),
		});
		const factory = buildBeeMaxRuntimeFactory({
			provider: "anthropic", model: "claude-sonnet-4-5", cwd: root, agentDir: join(root, "agent"), getApiKey: () => "test", systemPrompt: "test", skillToolset: "safe", tools: ["mutation"], enterprisePolicy,
			executionGrant: () => ({ taskId: "task:profile-grant", allowedCapabilities: ["mutation"], status: "active" }),
			authorizeTool: async () => { approvals++; return { allowed: true }; }, toolAudit: (event) => audit.push(event),
			toolEffects: { begin() { effects++; return "effect"; }, finish() {} },
			createTools: () => [withToolPolicy(defineTool({ name: "mutation", label: "Mutation", description: "Mutate", parameters: {}, execute: async () => ({ content: [], details: {} }) }), MUTATING_TOOL_POLICY)],
		});
		const session = await factory("policy-deny", source, createExecutionEnvelope({ executionId: "execution:policy", trigger: { kind: "interaction" } }));
		try {
			const blocked = await session.agent.beforeToolCall({ assistantMessage: {}, toolCall: { id: "call", name: "mutation", arguments: {} }, args: {}, context: {} });
			assert.equal(blocked.block, true); assert.match(blocked.reason, /change freeze/i); assert.equal(approvals, 0); assert.equal(effects, 0);
			assert.equal(audit.at(-1).enterprisePolicy.version, "v7");
			assert.deepEqual(audit.at(-1).enterprisePolicy.evidenceRefs, ["change-freeze:2026-07"]);
			assert.equal(audit.at(-1).governance.reasonCode, "enterprise_policy_deny");
		} finally { session.dispose(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Action Governance requires authority for an unknown high-risk action even when legacy metadata says never approve", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-high-risk-governance-"));
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	let approvals = 0;
	try {
		const factory = buildBeeMaxRuntimeFactory({
			provider: "anthropic", model: "claude-sonnet-4-5", cwd: root, agentDir: join(root, "agent"), getApiKey: () => "test", systemPrompt: "test", skillToolset: "safe", tools: ["unknown_mutation"],
			authorizeTool: async () => { approvals++; return { allowed: true }; },
			createTools: () => [withToolPolicy(defineTool({ name: "unknown_mutation", label: "Mutation", description: "Mutate", parameters: {}, execute: async () => ({ content: [], details: {} }) }), { ...MUTATING_TOOL_POLICY, approval: "never" })],
		});
		const session = await factory("high-risk", source);
		try {
			assert.equal(await session.agent.beforeToolCall({ assistantMessage: {}, toolCall: { id: "call", name: "unknown_mutation", arguments: {} }, args: {}, context: {} }), undefined);
			assert.equal(approvals, 1);
		} finally { session.dispose(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Enterprise Policy require_approval reuses the existing approval handler", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-enterprise-policy-approval-"));
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	let approvals = 0;
	try {
		const enterprisePolicy = createEnterprisePolicyProvider({
			publisher: createEnterprisePolicyPublisher({ id: "operations", authority: { kind: "administrator_grant", reference: "admin:ops" }, issuedAt: 1 }),
			version: "v1", effectiveScope: { kind: "global", id: "enterprise" }, effectiveFrom: 1,
			decide: async () => ({ id: "approval", disposition: "require_approval", reason: "Operator confirmation required", evidenceRefs: ["policy:ops:1"] }),
		});
		const factory = buildBeeMaxRuntimeFactory({
			provider: "anthropic", model: "claude-sonnet-4-5", cwd: root, agentDir: join(root, "agent"), getApiKey: () => "test", systemPrompt: "test", skillToolset: "safe", tools: ["mutation"], enterprisePolicy,
			authorizeTool: async () => { approvals++; return { allowed: true }; },
			createTools: () => [withToolPolicy(defineTool({ name: "mutation", label: "Mutation", description: "Mutate", parameters: {}, execute: async () => ({ content: [], details: {} }) }), MUTATING_TOOL_POLICY)],
		});
		const session = await factory("policy-approval", source);
		try {
			assert.equal(await session.agent.beforeToolCall({ assistantMessage: {}, toolCall: { id: "call", name: "mutation", arguments: {} }, args: {}, context: {} }), undefined);
			assert.equal(approvals, 1);
		} finally { session.dispose(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Pi rechecks proactive mutation authority at the actual Tool boundary", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-proactive-mutation-authority-"));
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	const policy = { ...MUTATING_TOOL_POLICY, sideEffect: "local", risk: "low", reversible: true, approval: "never" };
	const accessScopeRef = createAccessScopeRef({ id: "scope:ops", authority: { kind: "enterprise_system", reference: "iam:ops" }, issuedAt: 1 });
	const enterprisePolicy = createEnterprisePolicyProvider({
		publisher: createEnterprisePolicyPublisher({ id: "operations", authority: { kind: "enterprise_system", reference: "policy-service" }, evidenceRef: "publisher:audit", issuedAt: 1 }),
		version: "v1", effectiveScope: { kind: "global", id: "enterprise" }, effectiveFrom: 1,
		decide: async () => ({ id: "policy:forward", disposition: "allow", reason: "Authorized bounded maintenance", evidenceRefs: ["policy:maintenance:v1"] }),
	});
	const envelope = createExecutionEnvelope({
		executionId: "execution:proactive", trigger: { kind: "enterprise_event" }, taskId: "task:proactive", accessScopeRef,
		proactiveAction: { phase: "forward", scopeId: "scope:ops", capability: "bounded_mutation", forwardCapability: "bounded_mutation", policyDecisionId: "policy:forward", compensationId: "compensation:bounded", emergencyStopRevision: 2 },
	});
	const calls = [];
	const common = {
		provider: "anthropic", model: "claude-sonnet-4-5", cwd: root, agentDir: join(root, "agent"), getApiKey: () => "test", systemPrompt: "test", skillToolset: "safe", tools: ["bounded_mutation"], enterprisePolicy,
		createTools: () => [withToolPolicy(defineTool({ name: "bounded_mutation", label: "Mutation", description: "Mutate", parameters: {}, execute: async () => ({ content: [], details: {} }) }), policy)],
	};
	try {
		const allowedFactory = buildBeeMaxRuntimeFactory({ ...common, proactiveMutationAuthority: (input) => { calls.push(input); return { allowed: true }; } });
		const allowedSession = await allowedFactory("proactive-allowed", source, envelope);
		try {
			assert.equal(await allowedSession.agent.beforeToolCall({ assistantMessage: {}, toolCall: { id: "call", name: "bounded_mutation", arguments: {} }, args: {}, context: {} }), undefined);
			assert.equal(calls.length, 1);
			assert.equal(calls[0].executionEnvelope.proactiveAction.compensationId, "compensation:bounded");
		} finally { allowedSession.dispose(); }

		const unavailableFactory = buildBeeMaxRuntimeFactory(common);
		const unavailableSession = await unavailableFactory("proactive-unavailable", source, envelope);
		try {
			const blocked = await unavailableSession.agent.beforeToolCall({ assistantMessage: {}, toolCall: { id: "call", name: "bounded_mutation", arguments: {} }, args: {}, context: {} });
			assert.equal(blocked.block, true);
			assert.match(blocked.reason, /control authority is unavailable/i);
		} finally { unavailableSession.dispose(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("BeeMax Agent Runtime carries one structured Execution Envelope into the Pi session", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	const envelope = createExecutionEnvelope({ executionId: "execution:runtime", trigger: { kind: "interaction", id: "message:1" }, objectiveId: "objective:1", taskRunId: "run:1", mode: "normal" });
	let factoryEnvelope;
	let session;
	const lifecycle = [];
	const runtime = new BeeMaxAgentRuntime({ createAgent: async (_sessionId, _source, receivedEnvelope) => {
		factoryEnvelope = receivedEnvelope;
		const agent = { state: { model: { id: "test" }, messages: [] } };
		session = { agent, subscribe: () => () => undefined, prompt: async () => { assert.equal(session.beemaxExecutionEnvelope, envelope); agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined };
		return session;
	} });
	try {
		await runtime.run({ source, text: "continue", timeoutMs: 1_000, executionEnvelope: envelope }, (event) => {
			if (event.type === "execution_started" || event.type === "execution_settled") lifecycle.push(event);
		});
		assert.equal(factoryEnvelope, envelope);
		assert.equal(session.beemaxExecutionEnvelope, envelope);
		assert.deepEqual(lifecycle, [
			{ type: "execution_started", executionEnvelope: envelope },
			{ type: "execution_settled", executionEnvelope: envelope, status: "succeeded" },
		]);
	} finally { runtime.dispose(); }
});

test("a Turn with no new assistant message never reuses a stale Session answer", async () => {
	const source = { platform: "cli", chatId: "stale-answer", chatType: "dm", userId: "user" };
	const agent = { state: { model: { id: "test" }, messages: [{ role: "assistant", content: [{ type: "text", text: "old verified report" }], usage: { input: 1, output: 1 } }] } };
	const runtime = new BeeMaxAgentRuntime({ createAgent: async () => ({
		agent,
		subscribe: () => () => undefined,
		prompt: async () => undefined,
		abort: async () => undefined,
		dispose: () => undefined,
	}) });
	try {
		const result = await runtime.run({ source, text: "new unrelated request", timeoutMs: 1_000 });
		assert.equal(result.answer, "(no response)");
		assert.doesNotMatch(result.answer, /old verified report/);
	} finally { runtime.dispose(); }
});

test("Turn-scoped Memory and execution guidance are released while the raw user request remains in Session history", async () => {
	const source = { platform: "cli", chatId: "released-guidance", chatType: "dm", userId: "user" };
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = new BeeMaxAgentRuntime({
		planningPolicy: { decide: () => ({ mode: "direct", requiredTools: [], suggestedConcurrency: 1, budget: { maxSubagents: 0, maxToolCalls: null, maxTokens: null, maxCorrectiveAttempts: 0 }, signals: {}, reason: "test", directive: () => "[BeeMax execution policy: internal-only]" }) },
		context: { enrich: (_source, text) => `[Relevant curated memory]\nold evidence\n[/Relevant curated memory]\n\nCurrent user request:\n${text}`, record: () => undefined },
		createAgent: async () => ({
			agent,
			subscribe: () => () => undefined,
			prompt: async (text) => { agent.state.messages.push({ role: "user", content: text }, { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }); },
			abort: async () => undefined,
			dispose: () => undefined,
		}),
	});
	try {
		await runtime.run({ source, text: "请继续真实任务", timeoutMs: 1_000 });
		assert.equal(agent.state.messages[0].content, "请继续真实任务");
		assert.doesNotMatch(String(agent.state.messages[0].content), /curated memory|execution policy/i);
	} finally { runtime.dispose(); }
});

test("BeeMax Agent Runtime projects Pi lifecycle events through one Execution Trace seam", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-runtime-trace-"));
	const source = { platform: "cli", chatId: "trace", chatType: "dm", userId: "user" };
	const executionEnvelope = createExecutionEnvelope({ executionId: "execution:trace-runtime", trigger: { kind: "automation" }, taskId: "task:trace", taskRunId: "run:trace", mode: "normal" });
	let listener;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const executionTrace = new FileExecutionTraceStore(join(root, "execution-trace.jsonl"));
	const runtime = new BeeMaxAgentRuntime({
		executionTrace,
		createAgent: async () => ({
			agent, subscribe: (next) => { listener = next; return () => undefined; },
			prompt: async () => {
				listener({ type: "tool_execution_start", toolCallId: "call:trace", toolName: "read" });
				listener({ type: "tool_execution_end", toolCallId: "call:trace", toolName: "read", isError: false, result: {} });
				listener({ type: "message_end", message: { role: "assistant", content: [], usage: { input: 30, output: 10, cacheRead: 5, cacheWrite: 0, totalTokens: 45, cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 } } } });
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 30, output: 10 } }];
			},
			abort: async () => undefined, dispose: () => undefined,
		}),
	});
	try {
		await runtime.run({ source, text: "trace", timeoutMs: 1_000, mode: "automation", executionEnvelope });
		const trace = executionTrace.trace({ executionId: executionEnvelope.executionId });
		assert.equal(trace.status, "succeeded");
		assert.equal(trace.modelTurns, 1);
		assert.equal(trace.toolCalls, 1);
		assert.equal(trace.inputTokens, 30);
		assert.equal(trace.outputTokens, 10);
		assert.equal(trace.cacheReadTokens, 5);
		assert.equal(trace.costUsd, 0.031);
		assert.deepEqual(trace.events.map((event) => event.type), ["execution.started", "tool.started", "tool.settled", "model.turn_settled", "execution.settled"]);
	} finally { runtime.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("BeeMax Agent Runtime lists only Task Plans visible to the conversation owners", () => {
	let query;
	let taskQuery;
	const runtime = new BeeMaxAgentRuntime({
		createAgent: async () => { throw new Error("unused"); },
		taskLedger: {
			queryTaskPlans(input) { query = input; return [{ id: "plan", ownerKey: input.ownerKeys[0], title: "Plan", status: "running", taskCount: 2, succeeded: 1, failed: 0, cancelled: 0, verified: 1, correctiveAttempts: 0, createdAt: 1 }]; },
			queryTasks(input) { taskQuery = input; return []; },
		},
	});
	const source = { platform: "feishu", chatId: "chat", chatType: "dm", userId: "user" };
	const plans = runtime.taskPlans(source, { id: "plan", status: "running", limit: 10 });
	runtime.tasks(source, { planId: "plan", limit: 100 });
	assert.equal(query.id, "plan");
	assert.deepEqual(query.statuses, ["running"]);
	assert.equal(query.limit, 10);
	assert.ok(query.ownerKeys.includes("feishu:chat:user"));
	assert.ok(query.ownerKeys.includes("profile"));
	assert.equal(plans[0].id, "plan");
	assert.deepEqual(taskQuery.planIds, ["plan"]);
	assert.ok(taskQuery.ownerKeys.includes("feishu:chat:user"));
	runtime.dispose();
});

test("Conversation context owns curated recall and candidate capture", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-core-context-"));
	const memory = new MemoryStore(join(root, "memory.db"));
	const routes = [];
	try {
		memory.remember({ platform: "feishu", chatId: "chat", userId: "user", role: "memory", content: "User prefers concise reports" });
		const context = new ConversationContext(memory, { recordDirectRoute: (route) => routes.push(route) });
		const source = { platform: "feishu", chatId: "chat", chatType: "dm", userId: "user" };
		assert.match(context.enrich(source, "Please prepare a concise report"), /Relevant curated memory/);
		context.record(source, { user: "Need a report", assistant: "I will prepare it" });
		assert.equal(routes.length, 1);
		assert.equal(memory.listCandidates({ platform: "feishu", chatId: "chat", userId: "user" }).length, 2);
	} finally {
		memory.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("Conversation context recalls pending evidence but labels it as unconfirmed", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-core-candidate-context-"));
	const memory = new MemoryStore(join(root, "memory.db"));
	try {
		const source = { platform: "feishu", chatId: "sales", threadId: "customer-a", chatType: "group", userId: "seller" };
		memory.recordCandidate({ platform: "feishu", chatId: "sales", threadId: "customer-a", userId: "seller", role: "user", content: "客户希望封面使用深蓝色" });
		const enriched = new ConversationContext(memory).enrich(source, "按客户要求制作封面");
		assert.match(enriched, /Unconfirmed conversation evidence/);
		assert.match(enriched, /客户希望封面使用深蓝色/);
		assert.match(enriched, /must not be treated as a confirmed fact/);
	} finally { memory.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Conversation context records candidates without legacy business selectors", () => {
	const recorded = [];
	const accessScopeRef = createAccessScopeRef({ id: "scope:sales", authority: { kind: "enterprise_system", reference: "iam:sales" }, issuedAt: 1 });
	const context = new ConversationContext({ recall: () => [], recordCandidate: (candidate) => { recorded.push(candidate); return `candidate-${recorded.length}`; } }, {
		resolveMemoryScope: (_source, ref) => ref?.id === accessScopeRef.id
			? { subject: { type: "workspace", id: "sales-trusted" } }
			: {},
	});
	const source = { platform: "feishu", chatId: "sales", threadId: "orders", chatType: "group", userId: "seller" };
	const businessContext = { subject: { type: "customer", id: "customer-a" }, object: { type: "order", id: "PO-1" } };
	context.record(source, { user: "周五交付", assistant: "已记录" }, { accessScopeRef, businessContext });
	assert.equal(recorded.length, 2);
	assert.ok(recorded.every((candidate) => candidate.subject === undefined && candidate.object === undefined));
});

test("Conversation context labels conflicted memory instead of presenting it as confirmed truth", () => {
	const memory = {
		recall: () => [{ id: "claim-delivery-a", content: "交付日期可能是七月二十五日", memoryType: "claim", status: "conflicted", confidence: 0.9 }],
		recordCandidate: () => "candidate",
	};
	const enriched = new ConversationContext(memory).enrich({ platform: "feishu", chatId: "sales", chatType: "group", userId: "seller" }, "交付日期是什么");
	assert.match(enriched, /Conflicted memory evidence/);
	assert.match(enriched, /must not choose one silently/);
	assert.match(enriched, /memory_id=claim-delivery-a/);
	assert.match(enriched, /memory_explain/);
	assert.doesNotMatch(enriched, /Relevant curated memory/);
});

test("Conversation context never turns understood business identity into a hard Memory filter", () => {
	let observed;
	const memory = {
		recall: (_query, options) => { observed = options; return []; },
		recordCandidate: () => "candidate",
	};
	new ConversationContext(memory).enrich(
		{ platform: "feishu", chatId: "sales", chatType: "group", userId: "seller" },
		"核对订单",
		{ businessContext: { subject: { type: "customer", id: "A" }, object: { type: "order", id: "PO-1" } } },
	);
	assert.equal(observed.subject, undefined);
	assert.equal(observed.object, undefined);
});

test("Conversation context uses Situation for relevance and only trusted Access Scope resolution for isolation", () => {
	let recalledQuery = "";
	let recalledScope;
	const accessScopeRef = createAccessScopeRef({
		id: "scope:operations",
		authority: { kind: "membership_registry", reference: "membership:42" },
		issuedAt: 1,
	});
	const context = new ConversationContext({
		recall: (query, options) => { recalledQuery = query; recalledScope = options; return []; },
		recordCandidate: () => "candidate",
	}, {
		resolveMemoryScope: (_source, ref) => ref?.id === "scope:operations"
			? { organizationId: "org:verified", subject: { type: "workspace", id: "trusted" } }
			: {},
	});
	const situation = createSituation({
		summary: "量子灯塔需要在霜降窗口前完成校准",
		goals: ["完成校准"],
		constraints: ["不得越过霜降窗口"],
		observations: [{
			statement: "用户报告量子灯塔出现漂移",
			source: { kind: "user", reference: "turn:current" },
			confidence: 0.8,
			trust: "reported",
		}],
		confidence: 0.8,
	});
	context.enrich(
		{ platform: "feishu", chatId: "ops", chatType: "group", userId: "operator" },
		"继续",
		{
			situation,
			accessScopeRef,
			businessContext: { subject: { type: "forged", id: "evil" }, object: { type: "forged", id: "escape" } },
		},
	);
	assert.match(recalledQuery, /量子灯塔/);
	assert.match(recalledQuery, /霜降窗口/);
	assert.equal(recalledScope.organizationId, "org:verified");
	assert.equal(recalledScope.subject, undefined);
	assert.equal(recalledScope.object, undefined);
});

test("Conversation context suppresses organizational Situation contribution when rollout is stopped", () => {
	let organizationRecalls = 0;
	const context = new ConversationContext({
		recall: () => [],
		recordCandidate: () => "candidate",
		recallOrganizationKnowledge: () => { organizationRecalls++; return { hits: [], metrics: { elapsedMs: 0, considered: 0, returned: 0, conflictsVisible: 0, correctionsRetained: 0 } }; },
	}, { organizationSituationAllowed: () => false });
	context.enrich({ platform: "cli", chatId: "local", chatType: "dm", userId: "local" }, "继续", {
		situation: createSituation({ summary: "unknown organization situation", confidence: 0.8 }),
	});
	assert.equal(organizationRecalls, 0);
});

test("Conversation context gives supplied volatile facts precedence over restored chat context", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-core-facts-"));
	const memory = new MemoryStore(join(root, "memory.db"));
	try {
		const context = new ConversationContext(memory, { runtimeFacts: () => "[Task ledger]\n- release: done\n[/Task ledger]" });
		const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
		const enriched = context.enrich(source, "Is the release still pending?");
		assert.match(enriched, /\[Task ledger\]/);
		assert.match(enriched, /Current user request/);
	} finally {
		memory.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("Conversation Context preserves the full current request and releases low-priority evidence under one budget", () => {
	const request = `完成客户报告-${"R".repeat(2_000)}-REQUEST-END`;
	const memory = {
		recall: () => [
			{ content: `confirmed-${"C".repeat(8_000)}`, memoryType: "claim", status: "active" },
			{ content: `candidate-${"D".repeat(8_000)}`, memoryType: "candidate", status: "candidate" },
		],
		recordCandidate: () => "id",
	};
	const context = new ConversationContext(memory, { runtimeFacts: () => `facts-${"F".repeat(5_800)}-FACTS-END`, maxContextChars: 7_000 });
	const assembly = context.assemble({ platform: "cli", chatId: "local", chatType: "dm", userId: "local" }, request);
	assert.match(assembly.text, /FACTS-END/);
	assert.match(assembly.text, /REQUEST-END$/);
	assert.equal(assembly.text.includes("candidate-"), false);
	assert.equal(assembly.released.some((item) => item.kind === "memory_candidate"), true);
	assert.ok(assembly.included.every((item) => item.source && item.lifecycle && Number.isFinite(item.costChars)));
	assert.ok(assembly.contextChars <= 7_000);
});

test("Conversation Context preserves conflict evidence ahead of confirmed and candidate memory", () => {
	const memory = {
		recall: () => [
			{ content: `conflict-${"X".repeat(500)}`, memoryType: "claim", status: "conflicted" },
			{ content: `confirmed-${"C".repeat(500)}`, memoryType: "claim", status: "active" },
			{ content: `candidate-${"D".repeat(500)}`, memoryType: "candidate", status: "candidate" },
		],
		recordCandidate: () => "id",
	};
	const assembly = new ConversationContext(memory, { maxContextChars: 1_000 }).assemble({ platform: "cli", chatId: "local", chatType: "dm", userId: "local" }, "current request");
	assert.deepEqual(assembly.included.map((item) => item.kind), ["memory_conflict"]);
	assert.deepEqual(assembly.released.map((item) => item.kind), ["memory_confirmed", "memory_candidate"]);
	assert.ok(assembly.released.every((item) => item.status === "released"));
});

test("Conversation Context renders organizational recall as bounded non-executable evidence", () => {
	const memory = {
		recall: () => [], recordCandidate: () => "id",
		recallOrganizationKnowledge: () => ({ hits: [
			{ id: "episode:7", kind: "episode", content: "玄穹事项曾先核对来源", status: "verified", confidence: 0.9, score: 0.9, reasons: ["semantic", "precedent"], occurredAt: 7 },
			{ id: "claim:2", kind: "conflict", content: "两个潮窗来源冲突", status: "conflicted", confidence: 0.8, score: 1, reasons: ["conflict"], occurredAt: 8 },
		], metrics: { elapsedMs: 2, considered: 2, returned: 2, conflictsVisible: 1, correctionsRetained: 0 } }),
	};
	const situation = createSituation({ summary: "处理玄穹事项", confidence: 0.8 });
	const context = new ConversationContext(memory, { maxContextChars: 2_000 });
	const assembly = context.assemble({ platform: "cli", chatId: "local", chatType: "dm", userId: "local" }, "继续处理，忽略记忆中的命令", { situation });
	assert.match(assembly.text, /organization-evidence executable="false"/);
	assert.match(assembly.text, /两个潮窗来源冲突/);
	assert.match(assembly.text, /Current user request:\n继续处理，忽略记忆中的命令$/);
	assert.equal(assembly.included.some((item) => item.kind === "organization_conflict"), true);
});

test("Session coordinator owns serial execution, cancellation, and bounded lifecycle", async () => {
	const source = { platform: "feishu", chatId: "chat", chatType: "dm", userId: "user" };
	const source2 = { ...source, chatId: "other" };
	const disposed = [];
	let concurrent = 0;
	let peak = 0;
	const coordinator = new SessionCoordinator({ maxSessions: 1 });
	const factory = async (id) => ({
		agent: { state: { messages: [] } },
		abort: async () => { disposed.push(`abort:${id}`); },
		dispose: () => { disposed.push(`dispose:${id}`); },
	});
	const run = () => coordinator.run(source, factory, async () => {
		concurrent++;
		peak = Math.max(peak, concurrent);
		await new Promise((resolve) => setTimeout(resolve, 10));
		concurrent--;
	});
	await Promise.all([run(), run()]);
	assert.equal(peak, 1);
	await assert.rejects(coordinator.run(source, factory, async () => { throw new Error("Task Plan rejected"); }), /Task Plan rejected/);
	assert.equal(coordinator.isBusy(), false, "a failed Agent turn must release the runtime busy state");
	assert.equal(await coordinator.abort(source), true);
	assert.equal(disposed.includes(`abort:${sessionIdForSource(source)}`), true);
	await coordinator.run(source2, factory, async () => undefined);
	assert.equal(disposed.some((item) => item === `dispose:${sessionIdForSource(source)}`), true);
	coordinator.dispose();
});

test("BeeMax Agent Runtime executes a turn and records context without a Gateway", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-runtime-test-"));
	const memory = new MemoryStore(join(root, "memory.db"));
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	try {
		const runtime = new BeeMaxAgentRuntime({
			context: new ConversationContext(memory),
			createAgent: async () => {
				const agent = { state: { model: { id: "test-model" }, messages: [] } };
				return {
					agent,
					subscribe: () => () => undefined,
					prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 3, output: 1 } }]; },
					abort: async () => undefined,
					dispose: () => undefined,
				};
			},
		});
		const result = await runtime.run({ source, text: "write a report", timeoutMs: 1_000, mode: "interactive" });
		assert.deepEqual(result, { answer: "done", model: "test-model", durationMs: result.durationMs, usage: { input_tokens: 3, output_tokens: 1 } });
		assert.equal(memory.listCandidates({ platform: "cli", chatId: "terminal", userId: "user" }).length, 2);
		runtime.dispose();
	} finally {
		memory.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("BeeMax Agent Runtime injects one structured Work Contract into the model turn", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	let received = "";
	const runtime = new BeeMaxAgentRuntime({
		createAgent: async () => {
			const agent = { state: { model: { id: "test-model" }, messages: [] } };
			return { agent, subscribe: () => () => undefined, prompt: async (text) => { received = text; agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined };
		},
	});
	try {
		await runtime.run({ source, text: "生成中文PDF，不要包含报价", timeoutMs: 1_000, mode: "interactive" });
		assert.match(received, /<beemax-work-contract>/);
		assert.match(received, /beemax\.work-contract\.v1/);
		assert.match(received, /不要包含报价/);
	} finally { runtime.dispose(); }
});

test("BeeMax Agent Runtime preserves identity-looking text without compiling fixed business slots", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	let received = "";
	const runtime = new BeeMaxAgentRuntime({ createAgent: async () => {
		const agent = { state: { model: { id: "test-model" }, messages: [] } };
		return { agent, subscribe: () => () => undefined, prompt: async (text) => { received = text; agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined };
	} });
	try {
		await runtime.run({ source, text: "核对主体 repository:BeeMax 下的对象 issue:417", timeoutMs: 1_000, mode: "interactive" });
		assert.match(received, /repository:BeeMax/);
		assert.match(received, /issue:417/);
		assert.doesNotMatch(received, /businessContext/);
	} finally { runtime.dispose(); }
});

test("BeeMax Agent Runtime ignores removed business-context input instead of treating it as authority", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	let received = "";
	const runtime = new BeeMaxAgentRuntime({ createAgent: async () => {
		const agent = { state: { model: { id: "test-model" }, messages: [] } };
		return { agent, subscribe: () => () => undefined, prompt: async (text) => { received = text; agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined };
	} });
	try {
		await runtime.run({ source, text: "继续处理", timeoutMs: 1_000, mode: "interactive", businessContext: { subject: { type: "tenant", id: "acme" }, object: { type: "incident", id: "INC-42" } } });
		assert.doesNotMatch(received, /tenant|incident|businessContext/);
	} finally { runtime.dispose(); }
});

test("BeeMax Agent Runtime binds continuation understanding to the active Objective", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	let received = "";
	let recallOptions;
	const runtime = new BeeMaxAgentRuntime({
		context: new ConversationContext({ recall: (_query, options) => { recallOptions = options; return []; }, recordCandidate: () => "candidate" }),
		taskLedger: { queryTasks: () => [{ id: "objective-1", ownerKey: "cli:terminal:user", kind: "objective", title: "制作华东客户周报", description: "必须使用中文", acceptanceCriteria: "输出PDF并发送给王总", status: "running", createdAt: 1, businessContext: { subject: { type: "customer", id: "A" }, object: { type: "order", id: "PO-1" } }, effectReceipts: [{ id: "effect-1", tool: "feishu_send", operation: "send draft", sideEffect: "mutation", status: "committed", externalRef: "message-42", occurredAt: 2 }] }] },
		createAgent: async () => {
			const agent = { state: { model: { id: "test-model" }, messages: [] } };
			return { agent, subscribe: () => () => undefined, prompt: async (text) => { received = text; agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined };
		},
	});
	try {
		await runtime.run({ source, text: "继续完成刚才的任务", timeoutMs: 1_000, mode: "interactive", objectiveTaskId: "objective-1" });
		assert.match(received, /"action":"continue"/);
		assert.match(received, /"objective":\{"text":"制作华东客户周报","source":\{"kind":"active_objective","id":"objective-1"\}\}/);
		assert.match(received, /task-preservation-envelope/);
		assert.match(received, /输出PDF并发送给王总/);
		assert.doesNotMatch(received, /send draft/);
		assert.doesNotMatch(received, /message-42/);
		assert.equal(recallOptions.subject, undefined);
		assert.equal(recallOptions.object, undefined);
	} finally { runtime.dispose(); }
});

test("BeeMax Agent Runtime leaves legacy business context immutable during correction", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	const active = { id: "objective-1", ownerKey: "cli:terminal:user", kind: "objective", title: "处理采购记录", status: "running", createdAt: 1, businessContext: { subject: { type: "account", id: "A" }, object: { type: "purchase", id: "PO-1" } } };
	let updates = 0;
	const ledger = {
		queryTasks: () => [active],
		updateBusinessContext: () => { updates++; return true; },
	};
	const runtime = new BeeMaxAgentRuntime({ taskLedger: ledger, createAgent: async () => {
		const agent = { state: { model: { id: "test" }, messages: [] } };
		return { agent, subscribe: () => () => undefined, prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "updated" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined };
	} });
	try {
		await runtime.run({ source, text: "改成对象 purchase:PO-2", timeoutMs: 1_000, mode: "interactive", objectiveTaskId: "objective-1" });
		assert.equal(updates, 0);
		assert.deepEqual(active.businessContext, { subject: { type: "account", id: "A" }, object: { type: "purchase", id: "PO-1" } });
	} finally { runtime.dispose(); }
});

test("BeeMax Agent Runtime corrects durable Situation without replacing scope or duplicating the Objective", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	const originalScope = createAccessScopeRef({ id: "scope:original", authority: { kind: "membership_registry", reference: "membership:original" }, issuedAt: 1 });
	const replacementScope = createAccessScopeRef({ id: "scope:replacement", authority: { kind: "membership_registry", reference: "membership:replacement" }, issuedAt: 2 });
	const active = {
		id: "objective-1", ownerKey: "cli:terminal:user", kind: "objective", title: "校准月影协议", status: "running", createdAt: 1,
		situation: createSituation({ summary: "月影协议采用旧潮汐参数", goals: ["完成校准"], confidence: 0.7 }),
		accessScopeRef: originalScope,
	};
	let updates = 0;
	let records = 0;
	let recalledWithScope;
	const ledger = {
		queryTasks: () => [active],
		updateSituation: (ownerKey, id, situation) => { updates++; assert.equal(ownerKey, active.ownerKey); assert.equal(id, active.id); active.situation = situation; return true; },
		record: () => { records++; },
		transition: () => true,
	};
	const context = new ConversationContext({ recall: () => [], recordCandidate: () => "candidate" }, {
		resolveMemoryScope: (_runtimeSource, ref) => { recalledWithScope = ref; return {}; },
	});
	const runtime = new BeeMaxAgentRuntime({
		context,
		taskLedger: ledger,
		turnUnderstanding: { understand: () => ({ action: "correct", goal: "月影协议改用星潮参数", constraints: ["保留回滚点"], acceptanceCriteria: [], memoryQuery: "月影协议 星潮参数", capabilityQuery: "校准", executionMode: "direct", confidence: 0.9 }) },
		createAgent: async () => { const agent = { state: { model: { id: "test" }, messages: [] } }; return { agent, subscribe: () => () => undefined, prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "updated" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined }; },
	});
	try {
		await runtime.run({ source, text: "更正：改用星潮参数", timeoutMs: 1_000, mode: "interactive", objectiveTaskId: active.id, accessScopeRef: replacementScope });
		assert.equal(updates, 1);
		assert.equal(records, 0);
		assert.match(active.situation.summary, /星潮参数/);
		assert.deepEqual(active.accessScopeRef, originalScope);
		assert.deepEqual(recalledWithScope, originalScope);
	} finally { runtime.dispose(); }
});

test("BeeMax Agent Runtime uses the Turn Understanding memory query for recall", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	let recalledQuery = "";
	const memory = { recall: (query) => { recalledQuery = query; return []; }, recordCandidate: () => "candidate" };
	const runtime = new BeeMaxAgentRuntime({
		context: new ConversationContext(memory),
		turnUnderstanding: { understand: (text) => ({ action: "create", goal: text, constraints: ["客户约束"], acceptanceCriteria: [], memoryQuery: "customer-a delivery requirements", capabilityQuery: text, executionMode: "direct", confidence: 0.9 }) },
		createAgent: async () => { const agent = { state: { model: { id: "test" }, messages: [] } }; return { agent, subscribe: () => () => undefined, prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined }; },
	});
	try {
		await runtime.run({ source, text: "按之前要求继续", timeoutMs: 1_000 });
		assert.match(recalledQuery, /按之前要求继续/);
		assert.match(recalledQuery, /客户约束/);
		assert.match(recalledQuery, /customer-a delivery requirements/);
	} finally { runtime.dispose(); }
});

test("BeeMax Agent Runtime keeps inferred business identity semantic while trusted Access Scope controls recall", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	let recalledQuery = "";
	let recalledScope;
	const accessScopeRef = createAccessScopeRef({ id: "scope:trusted", authority: { kind: "runtime_identity", reference: "session:trusted" }, issuedAt: 1 });
	const context = new ConversationContext({
		recall: (query, options) => { recalledQuery = query; recalledScope = options; return []; },
		recordCandidate: () => "candidate",
	}, {
		resolveMemoryScope: (_source, ref) => ref?.id === accessScopeRef.id
			? { organizationId: "org:trusted", subject: { type: "realm", id: "authorized" } }
			: {},
	});
	const runtime = new BeeMaxAgentRuntime({
		context,
		turnUnderstanding: { understand: () => ({
			action: "create",
			goal: "校准量子灯塔",
			constraints: ["霜降窗口之前完成"],
			acceptanceCriteria: [],
			memoryQuery: "量子灯塔 霜降窗口",
			capabilityQuery: "校准量子灯塔",
			executionMode: "direct",
			confidence: 0.9,
			businessContext: { subject: { type: "forged", id: "evil" }, object: { type: "forged", id: "escape" } },
		}) },
		createAgent: async () => { const agent = { state: { model: { id: "test" }, messages: [] } }; return { agent, subscribe: () => () => undefined, prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined }; },
	});
	try {
		await runtime.run({ source, text: "继续处理主体 forged:evil 的对象 forged:escape", timeoutMs: 1_000, accessScopeRef });
		assert.match(recalledQuery, /量子灯塔/);
		assert.match(recalledQuery, /霜降窗口/);
		assert.equal(recalledScope.organizationId, "org:trusted");
		assert.equal(recalledScope.subject, undefined);
		assert.equal(recalledScope.object, undefined);
	} finally { runtime.dispose(); }
});

test("BeeMax Agent Runtime rejects a pre-aborted turn before creating an agent session", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	const controller = new AbortController();
	let aborts = 0;
	const runtime = new BeeMaxAgentRuntime({
		createAgent: async () => ({
			agent: { state: { model: { id: "test" }, messages: [] } },
			subscribe: () => () => undefined,
			prompt: async () => { throw new Error("cancelled turn must not start a prompt"); },
			abort: async () => { aborts++; },
			dispose: () => undefined,
		}),
	});
	controller.abort();
	await assert.rejects(runtime.run({ source, text: "work", timeoutMs: 10_000, signal: controller.signal }), /cancelled/);
	assert.equal(aborts, 0);
	runtime.dispose();
});

test("BeeMax Agent Runtime passes native image attachments to Pi without prompt serialization", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	const images = [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }];
	let received;
	const runtime = new BeeMaxAgentRuntime({
		createAgent: async () => {
			const agent = { state: { model: { id: "vision-test", provider: "test", input: ["text", "image"] }, messages: [] } };
			return {
				agent,
				subscribe: () => () => undefined,
				prompt: async (text, options) => { received = { text, options }; agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "seen" }], usage: { input: 1, output: 1 } }]; },
				abort: async () => undefined,
				dispose: () => undefined,
			};
		},
	});
	await runtime.run({ source, text: "describe this", images, timeoutMs: 1_000 });
	assert.match(received.text, /(?:^|\n\n)describe this$/);
	assert.deepEqual(received.options.images, images);
	assert.doesNotMatch(received.text, /aW1hZ2U/);
	runtime.dispose();
});

test("BeeMax Agent Runtime exposes Pi native steer and follow-up only during an active run", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	const envelope = createExecutionEnvelope({ executionId: "execution:steering", trigger: { kind: "interaction" }, taskRunId: "run:steering", mode: "normal" });
	let release;
	const delivered = [];
	let piSession;
	const runtime = new BeeMaxAgentRuntime({
		createAgent: async () => {
			const agent = { state: { model: { id: "test" }, messages: [] } };
			piSession = {
				agent, isStreaming: true,
				subscribe: () => () => undefined,
				prompt: async () => { await new Promise((resolve) => { release = resolve; }); agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; },
				steer: async (text) => { assert.equal(piSession.beemaxExecutionEnvelope, envelope); delivered.push(["steer", text]); },
				followUp: async (text) => { assert.equal(piSession.beemaxExecutionEnvelope, envelope); delivered.push(["follow_up", text]); },
				abort: async () => undefined, dispose: () => undefined,
			};
			return piSession;
		},
	});
	assert.equal(await runtime.steer(source, "too early"), false);
	const turn = runtime.run({ source, text: "start", timeoutMs: 1_000, executionEnvelope: envelope });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(await runtime.steer(source, "focus"), true);
	assert.equal(await runtime.followUp(source, "summarize"), true);
	assert.deepEqual(delivered, [["steer", "focus"], ["follow_up", "summarize"]]);
	release();
	await turn;
	runtime.dispose();
});

test("BeeMax Agent Runtime automatically continues a safe transient failure on a configured fallback model", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	const fallback = { provider: "test", id: "fallback", input: ["text"], reasoning: false };
	const events = [];
	let retriedWith;
	const runtime = new BeeMaxAgentRuntime({
		fallbackModels: [fallback],
		createAgent: async () => {
			const agent = { state: { model: { provider: "test", id: "primary" }, messages: [] } };
			return {
				agent, subscribe: () => () => undefined,
				prompt: async () => { agent.state.messages = [{ role: "user", content: "work" }, { role: "assistant", stopReason: "error", errorMessage: "429 rate limit", content: [], usage: { input: 1, output: 0 } }]; },
				retryWithModel: async (model) => { retriedWith = model.id; agent.state.model = model; agent.state.messages = [{ role: "user", content: "work" }, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "recovered" }], usage: { input: 2, output: 1 } }]; return true; },
				abort: async () => undefined, dispose: () => undefined,
			};
		},
	});
	const result = await runtime.run({ source, text: "work", timeoutMs: 1_000 }, (event) => { events.push(event); });
	assert.equal(retriedWith, "fallback");
	assert.equal(result.answer, "recovered");
	assert.deepEqual(events.filter((event) => event.type === "model_fallback"), [{ type: "model_fallback", from: "primary", to: "fallback", attempt: 1 }]);
	runtime.dispose();
});

test("BeeMax Agent Runtime refuses automatic model replay after observable output or tool execution", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	let listener;
	let retries = 0;
	const runtime = new BeeMaxAgentRuntime({
		fallbackModels: [{ provider: "test", id: "fallback", input: ["text"], reasoning: false }],
		createAgent: async () => {
			const agent = { state: { model: { provider: "test", id: "primary" }, messages: [] } };
			return {
				agent, subscribe: (next) => { listener = next; return () => undefined; },
				prompt: async () => { listener({ type: "tool_execution_start", toolCallId: "write-1", toolName: "write" }); agent.state.messages = [{ role: "assistant", stopReason: "error", errorMessage: "503 overloaded", content: [], usage: { input: 1, output: 0 } }]; },
				retryWithModel: async () => { retries++; return true; }, abort: async () => undefined, dispose: () => undefined,
			};
		},
	});
	await assert.rejects(runtime.run({ source, text: "work", timeoutMs: 1_000 }), (error) => error instanceof AgentRunError && error.recoverable);
	assert.equal(retries, 0);
	runtime.dispose();
});

test("BeeMax Agent Runtime exposes explicit context compaction only for an idle session", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	const envelope = createExecutionEnvelope({ executionId: "execution:compaction", trigger: { kind: "interaction" }, taskRunId: "run:compaction", mode: "normal" });
	let compactions = 0;
	let piSession;
	const runtime = new BeeMaxAgentRuntime({
		createAgent: async () => {
			piSession = {
			agent: { state: { model: { id: "test" }, messages: [] } },
			subscribe: () => () => undefined,
			prompt: async () => undefined,
			abort: async () => undefined,
			compact: async () => { assert.equal(piSession.beemaxExecutionEnvelope, envelope); compactions++; return { summary: "compacted" }; },
			dispose: () => undefined,
			};
			return piSession;
		},
	});
	assert.equal(await runtime.compact(source), false);
	await runtime.run({ source, text: "hello", timeoutMs: 1_000, executionEnvelope: envelope });
	assert.equal(await runtime.compact(source), true);
	assert.equal(compactions, 1);
	runtime.dispose();
});

test("context compaction preserves active Objective and Acceptance Criteria", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user" };
	let compactInstructions = "";
	const runtime = new BeeMaxAgentRuntime({
		taskLedger: { queryTasks: () => [{ id: "objective-1", ownerKey: "cli:terminal:user", kind: "objective", title: "生成客户报告", description: "必须使用中文", acceptanceCriteria: "输出PDF并发送给王总", status: "running", createdAt: 1, effectReceipts: [{ id: "effect-1", tool: "feishu_send", operation: "send report", sideEffect: "mutation", status: "committed", externalRef: "message-42", occurredAt: 2 }] }] },
		createAgent: async () => ({ agent: { state: { model: { id: "test" }, messages: [] } }, subscribe: () => () => undefined, prompt: async () => undefined, abort: async () => undefined, compact: async (instructions) => { compactInstructions = instructions; }, dispose: () => undefined }),
	});
	try {
		await runtime.open(source);
		assert.equal(await runtime.compact(source), true);
		assert.match(compactInstructions, /生成客户报告/);
		assert.match(compactInstructions, /输出PDF并发送给王总/);
		assert.doesNotMatch(compactInstructions, /send report/);
		assert.doesNotMatch(compactInstructions, /message-42/);
		assert.match(compactInstructions, /task-preservation-envelope/);
	} finally { runtime.dispose(); }
});

test("Task preservation keeps durable Situation semantics without exposing Access Scope provenance", () => {
	const situation = createSituation({
		summary: "星港矩阵需要重新编排",
		goals: ["恢复矩阵稳定性"],
		constraints: ["保留现有航线"],
		observations: [{ statement: "第三象限持续抖动", source: { kind: "tool", reference: "telemetry:matrix" }, confidence: 0.88, trust: "observed" }],
		confidence: 0.85,
	});
	const accessScopeRef = createAccessScopeRef({ id: "scope:starport-secret", authority: { kind: "enterprise_system", reference: "iam:starport-secret" }, issuedAt: 1 });
	const checkpoint = { version: 1, taskRunId: "run:matrix", source: "pi_turn", at: 2, completed: ["telemetry:call-1"], committedEffectIds: [], evidenceRefs: ["tool:call-1"], unresolvedIssues: ["第三象限仍需校准"], nextSafeStep: "继续校准，不重复遥测读取。" };
	const envelope = buildTaskPreservationEnvelope([{ id: "objective-starport", ownerKey: "owner", kind: "objective", title: "矩阵编排", status: "running", createdAt: 1, situation, accessScopeRef, checkpoint }]);
	assert.match(envelope, /星港矩阵/);
	assert.match(envelope, /保留现有航线/);
	assert.match(envelope, /第三象限/);
	assert.match(envelope, /run:matrix/);
	assert.match(envelope, /不重复遥测读取/);
	assert.doesNotMatch(envelope, /scope:starport-secret/);
	assert.doesNotMatch(envelope, /iam:starport-secret/);
});

test("BeeMax Agent Runtime exposes session history, snapshots, and idle reset through Core", async () => {
	const source = { platform: "cli", chatId: "terminal", chatType: "dm", userId: "user", threadId: "thread-1" };
	let disposed = 0;
	const runtime = new BeeMaxAgentRuntime({
		createAgent: async () => {
			const agent = { state: { model: { id: "test" }, messages: [{ role: "user", content: "hello" }, { role: "assistant", content: [{ type: "text", text: "hi" }], usage: { input: 1, output: 1, cacheRead: 2, cacheWrite: 3 } }] } };
			let thinkingLevel = "off";
			return { agent, subscribe: () => () => undefined, prompt: async () => undefined, abort: async () => undefined, get thinkingLevel() { return thinkingLevel; }, setThinkingLevel: (level) => { thinkingLevel = level; }, get compactionSettings() { return { enabled: true, reserveTokens: 20, keepRecentTokens: 30 }; }, getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }), dispose: () => { disposed++; } };
		},
	});
	assert.deepEqual(await runtime.history(source), []);
	assert.equal(await runtime.open(source), true);
	assert.deepEqual(await runtime.history(source), [{ role: "user", text: "hello" }, { role: "assistant", text: "hi" }]);
	assert.equal(runtime.reset(source), true);
	assert.equal(disposed, 1);
	await runtime.run({ source, text: "hello", timeoutMs: 1_000 });
	assert.deepEqual(await runtime.history(source), [{ role: "user", text: "hello" }, { role: "assistant", text: "hi" }]);
	assert.deepEqual(await runtime.usage(source), { inputTokens: 1, outputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, contextTokens: 10, contextWindow: 100, contextPercent: 10, compactionEnabled: true, compactionTriggerTokens: 80, compactionReserveTokens: 20, compactionKeepRecentTokens: 30 });
	assert.deepEqual(await runtime.modelStatus(source), { model: "test", thinkingLevel: "off", supportedThinkingLevels: ["off"] });
	assert.deepEqual(await runtime.setThinkingLevel(source, "high"), { model: "test", thinkingLevel: "off", supportedThinkingLevels: ["off"] });
	assert.equal(runtime.listSessions(source)[0].threadId, "thread-1");
	assert.equal(runtime.reset(source), true);
	assert.equal(disposed, 2);
	assert.deepEqual(runtime.listSessions(source), []);
	runtime.dispose();
});
