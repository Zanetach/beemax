import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { MemoryStore, memoryPersistencePorts } from "@thruvera/memory";
import { createAccessScopeRef, createExecutionEnvelope, createSituation, DefaultMemoryLearningKernel, FileExecutionTraceStore, MUTATING_TOOL_POLICY } from "@thruvera/core";
import { buildMainAgentSystemPrompt, buildSubagentSystemPrompt, createTaskVerifier as createTaskVerifierRaw, createVerifiedObjectiveMemoryPublisher, executeObjectiveDelivery as executeObjectiveDeliveryRaw, executePlannedTask as executePlannedTaskRaw, executeSubagentTask as executeSubagentTaskRaw, verificationAgentTools, verificationAgentToolsForTask } from "../dist/gateway.js";
import { attestAgentFactoryProfile, buildAgentFactory, createExecutionRoleTools } from "../dist/agent-factory.js";
import { createSuccessfulVerificationReceipt, normalizeVerifierEvidenceRefs } from "../dist/verification-protocol.js";

const scopedFactory = (factory) => attestAgentFactoryProfile(factory, "profile:test");
const executePlannedTask = (factory, ...args) => executePlannedTaskRaw(scopedFactory(factory), ...args);
const executeSubagentTask = (factory, ...args) => executeSubagentTaskRaw(scopedFactory(factory), ...args);
const executeObjectiveDelivery = (factory, ...args) => executeObjectiveDeliveryRaw(scopedFactory(factory), ...args);
const createTaskVerifier = (factory, ...args) => createTaskVerifierRaw(scopedFactory(factory), ...args);
const bindAssistantTurn = (emit, calls, responseId = "response:verification-test") => emit({
	type: "message_end",
	message: {
		role: "assistant",
		responseId,
		content: calls.map(({ id, name, args = {} }) => ({ type: "toolCall", id, name, arguments: args })),
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	},
});
const startAdmittedToolCall = async (agent, emit, { id, name, args = {} }, responseId = "response:verification-test") => {
	emit({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
	const boundary = await agent.beforeToolCall?.({
		assistantMessage: { role: "assistant", responseId },
		toolCall: { id, name, arguments: args },
		args,
		context: {},
	}, new AbortController().signal);
	assert.notEqual(boundary?.block, true, boundary?.reason);
};
const readOnlyTestTool = (name) => ({
	name,
	description: `Read-only ${name} test capability`,
	parameters: {},
	beemaxPolicy: { sideEffect: "none" },
	beemaxToolSpec: { configured: true, health: "ready" },
});

test("Sub-Agents must discover admitted capabilities and fail explicitly instead of weakening the Task contract", () => {
	const prompt = buildSubagentSystemPrompt();
	assert.match(prompt, /capability_discover/);
	assert.match(prompt, /Never replace the requested outcome, evidence standard, quality level, or mandatory constraint with a weaker substitute/);
	assert.match(prompt, /exact blocker and attempted remedies/);
	assert.match(prompt, /stop discovery as soon as the Acceptance Criteria are met/i);
	assert.match(prompt, /reserve enough time and tokens for one final structured response/i);
	assert.match(prompt, /at most 8 unique external URLs/i);
});

test("Sub-Agent execution receives exact Acceptance Criteria and a convergence boundary", async () => {
	let prompt = "";
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const factory = async () => ({
		agent, subscribe: () => () => undefined,
		prompt: async (text) => {
			prompt = text;
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }];
		},
		abort: async () => undefined, dispose: () => undefined,
	});
	await executeSubagentTask(factory, {
		id: "task-converge", ownerKey: "cli:local:local", source: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" },
		name: "Research", goal: "Research the weekly market move", acceptanceCriteria: "Return exactly two independently accessible source URLs.",
		capability: "research", status: "running", createdAt: 1, timeoutMs: 1_000,
	}, new AbortController().signal, 1_000);
	assert.match(prompt, /Acceptance Criteria:\nReturn exactly two independently accessible source URLs\./);
	assert.match(prompt, /Stop discovery as soon as the Acceptance Criteria are met\./i);
	assert.match(prompt, /Do not repeat equivalent searches or improve beyond the requested scope\./i);
});

test("main Agent preserves a minimal material citation set for independent verification", () => {
	const prompt = buildMainAgentSystemPrompt("Profile prompt");
	assert.match(prompt, /smallest sufficient set of material citations/i);
	assert.match(prompt, /every cited external URL/i);
	assert.match(prompt, /at most 8 unique external URLs/i);
	assert.match(prompt, /all key facts need source URLs.*does not.*justify exceeding/i);
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
	const tools = verificationAgentTools([], "Independently verify current public sources", ["exa_web_search"], true);
	assert.deepEqual(tools, ["verification_submit", "read", "exa_web_search", "web_extract"]);
	assert.equal(tools.includes("web_search"), false);
});

test("verification Tool Spec exposes exact-source extraction for external evidence from any Provider", () => {
	assert.deepEqual(verificationAgentTools([{ name: "mcp_public_source", description: "Read public evidence" }], "Verify the cited source", ["mcp_public_source"], true), ["verification_submit", "read", "mcp_public_source", "web_extract"]);
});

test("Task-aware verification Tool routing re-admits the structurally required source capability", () => {
	assert.deepEqual(
		verificationAgentToolsForTask(
			[{ name: "temporal_evidence_feed", description: "Resolve qx-17 state" }],
			{
				title: "qx-17 zorb flux",
				description: "naru vek tal",
				acceptanceCriteria: "zorb receipt attached",
				verificationRequirements: [{ capability: "temporal_evidence_feed", freshness: "realtime", evidence: "source_receipt" }],
			},
			[],
		),
		["verification_submit", "read", "temporal_evidence_feed"],
	);
});

test("Task-aware verification progressively admits direct Artifact inspection", () => {
	assert.deepEqual(
		verificationAgentToolsForTask([], {
			title: "核验黄金周报交付文件",
			description: "真实检查 HTML 内容与渲染，并确认 PDF 可解析和页面渲染",
			acceptanceCriteria: "gold-weekly-report.html 与 gold-weekly-report.pdf 均通过",
			verificationRequirements: [],
		}, []),
		["verification_submit", "read", "artifact_inspect"],
	);
});

test("the internal verdict Tool exists only in verification execution sessions", () => {
	assert.deepEqual(createExecutionRoleTools().map((tool) => tool.name), []);
	assert.deepEqual(createExecutionRoleTools({ mode: "normal" }).map((tool) => tool.name), []);
	assert.deepEqual(createExecutionRoleTools({ mode: "verification", verificationProtocol: "skill_candidate_v1" }).map((tool) => tool.name), []);
	assert.deepEqual(createExecutionRoleTools({ mode: "verification", verificationProtocol: "task_candidate_v1" }).map((tool) => tool.name), ["verification_submit"]);
});

test("the real Agent factory enables the internal verdict Tool only for its verification role", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-verification-role-tools-"));
	const factory = buildAgentFactory({
		profileId: "profile:test",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		cwd: root,
		agentDir: join(root, "agent"),
		getApiKey: () => "test",
		tools: ["read"],
	});
	const source = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };
	const normal = await factory("normal-role", source, createExecutionEnvelope({ executionId: "execution:normal-role", trigger: { kind: "delegation", id: "normal-role" }, mode: "normal" }));
	const verifier = await factory("verification-role", source, createExecutionEnvelope({ executionId: "execution:verification-role", trigger: { kind: "verification", id: "task" }, mode: "verification", verificationProtocol: "task_candidate_v1" }));
	try {
		assert.equal(normal.getAllTools().some((tool) => tool.name === "verification_submit"), false);
		assert.equal(normal.thinkingLevel, "off", "normal execution should call evidence Tools promptly instead of spending minutes on hidden reasoning");
		assert.equal(verifier.getAllTools().some((tool) => tool.name === "verification_submit"), true);
		assert.equal(verifier.thinkingLevel, "off", "receipt-bound verification should not spend a second medium-reasoning pass on deterministic Tool evidence");
	} finally {
		normal.dispose();
		verifier.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("the production Agent factory discovers only Profile-local Skills without project fallback", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-agent-factory-skill-priority-"));
	const agentDir = join(root, "agent");
	const profileSkill = join(agentDir, "skills", "agent-reach");
	const projectSkill = join(root, ".agents", "skills", "agent-reach");
	for (const [path, marker] of [[profileSkill, "PROFILE_NATIVE"], [projectSkill, "PROJECT_EXTERNAL"]]) {
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, "SKILL.md"), `---\nname: agent-reach\ndescription: Current public Web retrieval ${marker}\n---\n${marker}\n`);
	}
	const projectOnlySkill = join(root, ".agents", "skills", "project-only");
	mkdirSync(projectOnlySkill, { recursive: true });
	writeFileSync(join(projectOnlySkill, "SKILL.md"), "---\nname: project-only\ndescription: Must not cross the Profile boundary.\n---\nPROJECT_ONLY\n");
	const factory = buildAgentFactory({
		profileId: "profile:test",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		cwd: root,
		agentDir,
		getApiKey: () => "test",
	});
	const session = await factory("skill-priority", { platform: "cli", chatId: "local", chatType: "dm", userId: "local" });
	try {
		const skillList = session.getToolDefinition("skill_list");
		const skillRead = session.getToolDefinition("skill_read");
		assert.ok(skillList);
		assert.ok(skillRead);
		const listed = await skillList.execute("list", {}, new AbortController().signal);
		const reach = listed.details.skills.find(({ name }) => name === "agent-reach");
		assert.equal(listed.details.skills.some(({ name }) => name === "project-only"), false);
		assert.match(reach.description, /PROFILE_NATIVE/);
		assert.doesNotMatch(reach.description, /PROJECT_EXTERNAL/);
		const activated = await skillRead.execute("read", { name: "agent-reach" }, new AbortController().signal);
		assert.match(activated.content[0].text, /PROFILE_NATIVE/);
		assert.doesNotMatch(activated.content[0].text, /PROJECT_EXTERNAL/);
	} finally {
		session.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("the Agent factory admits Profile-local Skill requirements from the full Profile snapshot, not the narrowed Provider environment", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-agent-factory-skill-environment-"));
	const agentDir = join(root, "agent");
	const skill = join(agentDir, "skills", "customer-acme");
	mkdirSync(skill, { recursive: true });
	writeFileSync(join(skill, "SKILL.md"), `---
name: customer-acme
description: Customer Profile Skill requiring its own credential.
metadata:
  beemax:
    env: [ACME_API_KEY]
---
Use the customer-scoped ACME capability.
`);
	const factory = buildAgentFactory({
		profileId: "profile:test",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		cwd: root,
		agentDir,
		getApiKey: () => "test",
		capabilityProviderEnvironment: { TAVILY_API_KEY: "provider-only" },
		skillEnvironment: { ACME_API_KEY: "profile-secret", PATH: process.env.PATH ?? "" },
	});
	const session = await factory("skill-environment", { platform: "cli", chatId: "local", chatType: "dm", userId: "local" });
	try {
		const listed = await session.getToolDefinition("skill_list").execute("list", {}, new AbortController().signal);
		assert.equal(listed.details.skills.some(({ name }) => name === "customer-acme"), true);
	} finally {
		session.dispose();
		rmSync(root, { recursive: true, force: true });
	}
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
	assert.deepEqual(executionTrace.trace({ executionId: "execution:run-situation", accessScopeId: "scope:cloud-whale" }).events.map((event) => event.type), ["execution.started", "tool_spec.published", "execution.settled"]);
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

for (const authorityLoss of ["objective cancellation", "Task Run lease loss"]) test(`Gateway delegated execution fails the mutating boundary on ${authorityLoss}`, async () => {
	const mutation = { name: "mutate", label: "Mutate", description: "Mutate", parameters: {}, beemaxPolicy: MUTATING_TOOL_POLICY, execute: async () => ({ content: [], details: {} }) };
	let listener;
	let boundary;
	let authorityCheck;
	const agent = { state: { model: { id: "test" }, messages: [], tools: [mutation] }, beforeToolCall: undefined };
	const factory = async () => ({
		agent,
		subscribe: (next) => { listener = next; return () => undefined; },
		getAllTools: () => [mutation], getToolDefinition: () => mutation,
		getActiveToolNames: () => [mutation.name], setActiveToolsByName: () => undefined,
		prompt: async () => {
			listener({ type: "message_end", message: { role: "assistant", responseId: `response:${authorityLoss}`, content: [{ type: "toolCall", id: `call:${authorityLoss}`, name: mutation.name, arguments: {} }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
			listener({ type: "tool_execution_start", toolCallId: `call:${authorityLoss}`, toolName: mutation.name, args: {} });
			boundary = await agent.beforeToolCall({ assistantMessage: {}, toolCall: { id: `call:${authorityLoss}`, name: mutation.name, arguments: {} }, args: {}, context: {} });
			listener({ type: "tool_execution_end", toolCallId: `call:${authorityLoss}`, toolName: mutation.name, args: {}, isError: true, result: { details: { dispatchError: { stage: "authorization", code: "blocked", retryable: false } } } });
			const terminal = { role: "assistant", responseId: `response:${authorityLoss}:terminal`, stopReason: "stop", content: [{ type: "text", text: '<beemax-task-result>{"output":"fenced","evidence":"","artifacts":[],"unresolvedIssues":[]}</beemax-task-result>' }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
			listener({ type: "message_end", message: terminal });
			agent.state.messages = [terminal];
		},
		abort: async () => undefined, dispose: () => undefined,
	});
	const ledger = {
		isTaskRunExecutionActive: (...args) => { authorityCheck = args; return false; },
		transitionRun: () => true,
	};
	await executeSubagentTask(factory, {
		id: "task-gateway-fence", ownerKey: "cli:local:local", source: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" }, name: "Apply change", goal: "Use mutate to apply the change", capability: "mutation", status: "running", createdAt: 1,
	}, new AbortController().signal, 1_000, undefined, createExecutionEnvelope({ executionId: `execution:${authorityLoss}`, trigger: { kind: "delegation", id: "task-gateway-fence" }, objectiveId: "objective-gateway-fence", taskId: "task-gateway-fence", taskRunId: "run-gateway-fence" }), undefined, [mutation.name], undefined, ledger);
	assert.equal(boundary?.block, true);
	assert.match(boundary?.reason ?? "", /no active durable Execution Holder authority/i);
	assert.deepEqual(authorityCheck?.slice(0, 4), ["cli:local:local", "objective-gateway-fence", "task-gateway-fence", "run-gateway-fence"]);
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
	const tools = [readOnlyTestTool("read")];
	const factory = async () => ({
		agent,
		getActiveToolNames: () => tools.map(({ name }) => name),
		getAllTools: () => tools,
		setActiveToolsByName: () => undefined,
		subscribe: (next) => { listener = next; return () => undefined; },
		prompt: async () => {
			bindAssistantTurn(listener, [{ id: "read-1", name: "read", args: {} }], "response:checkpoint-read");
			await startAdmittedToolCall(agent, listener, { id: "read-1", name: "read", args: {} }, "response:checkpoint-read");
			listener({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: {}, isError: false });
			listener({ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] });
			const terminal = { role: "assistant", responseId: "response:checkpoint-terminal", stopReason: "stop", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
			listener({ type: "message_end", message: terminal });
			agent.state.messages = [terminal];
		},
		abort: async () => undefined, dispose: () => undefined,
	});
	await executePlannedTask(factory, {
		id: "task-native-checkpoint", ownerKey: "cli:local:local", kind: "delegated", title: "Inspect", description: "Use read to inspect the evidence", status: "running", createdAt: 1,
	}, { platform: "cli", chatId: "local", chatType: "dm", userId: "local" }, undefined, 1_000, {
		taskRunId: "run-native-checkpoint", attempt: 1, executionMode: "normal", maxCorrectiveAttempts: 0, dependencies: [],
		saveCheckpoint: (checkpoint) => { saved.push(checkpoint); return true; },
	}, undefined, { taskProjection: () => [] });
	assert.equal(saved.length, 1);
	assert.equal(saved[0].source, "pi_turn");
	assert.equal(saved[0].taskRunId, "run-native-checkpoint");
	assert.deepEqual(saved[0].completed, ["read:read-1"]);
});

test("verified Objective outcomes atomically publish an idempotent Episode and learning signal", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-verified-outcome-memory-"));
	const database = join(root, "memory.db");
	const memory = new MemoryStore(database);
	try {
		const publish = createVerifiedObjectiveMemoryPublisher(memory);
		publish({
			objectiveId: "objective-1", title: "Order delivery", result: "Delivery is Friday", evidence: "ERP checked",
			taskRunId: "run:objective-1", verificationRevision: 1,
			criterionVerifications: [{ criterionId: "C1", criterion: "Delivery date is verified", status: "accepted", evidenceRefs: ["verification:erp"] }],
			deliveryReceipt: { idempotencyKey: "delivery:objective-1", deliveredAt: 100, providerMessageId: "message-1" },
			executionScope: { platform: "feishu", chatId: "sales", chatType: "group", userId: "seller" },
			situation: createSituation({ summary: "浮光引擎交付已完成", goals: ["确认交付"], confidence: 1 }),
		});
		publish({
			objectiveId: "objective-1", title: "Order delivery", result: "Delivery is Friday", evidence: "ERP checked",
			taskRunId: "run:objective-1", verificationRevision: 1,
			criterionVerifications: [{ criterionId: "C1", criterion: "Delivery date is verified", status: "accepted", evidenceRefs: ["verification:erp"] }],
			deliveryReceipt: { idempotencyKey: "delivery:objective-1", deliveredAt: 100, providerMessageId: "message-1" },
			executionScope: { platform: "feishu", chatId: "sales", chatType: "group", userId: "seller" },
			situation: createSituation({ summary: "浮光引擎交付已完成", goals: ["确认交付"], confidence: 1 }),
		});
		const scope = { platform: "feishu", chatId: "sales", userId: "seller" };
		assert.match(memory.recallEpisodes("Friday", scope)[0].outcome, /Delivery is Friday/);
		assert.equal(memory.listEpisodes(scope).length, 1);
		const raw = new Database(database, { readonly: true });
		assert.equal(raw.prepare("SELECT COUNT(*) AS count FROM memory_learning_settlements WHERE subject_kind = 'objective' AND subject_id = 'objective-1'").get().count, 1);
		assert.equal(raw.prepare("SELECT COUNT(*) AS count FROM memory_settlement_evidence_refs WHERE ref_kind = 'delivery'").get().count, 1);
		raw.close();
		const maintenance = await new DefaultMemoryLearningKernel({ authority: memoryPersistencePorts(memory).memoryLearningAuthority })
			.maintain({ profileId: "default", trigger: "signal", maxItems: 10, maxModelCalls: 0, leaseMs: 30_000, now: Date.now() + 1 });
		assert.equal(maintenance.claimed, 1);
	} finally { memory.close(); rmSync(root, { recursive: true, force: true }); }
});

test("verified Objective outcomes containing credentials are never published from any field", () => {
	for (const unsafe of [
		{ title: "OPENAI_API_KEY=sk-title-secret", result: "safe", evidence: "safe" },
		{ title: "safe", result: "safe", evidence: "Authorization: Bearer evidence-secret" },
	]) {
		let writes = 0;
		createVerifiedObjectiveMemoryPublisher({ upsertVerifiedEpisodeAndSignal: () => { writes++; return {}; } })({
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
	assert.deepEqual(trace.events.map((event) => event.type), ["delivery.started", "execution.started", "tool_spec.published", "execution.settled", "delivery.settled"]);
	rmSync(root, { recursive: true, force: true });
});

test("independent verification receives the Task Situation", async () => {
	let prompt = "";
	let envelope;
	let emit = () => undefined;
	let activeTools = ["verification_submit", "capability_discover", "read", "skill_read", "web_search", "exa_web_search", "web_extract", "write"];
	let toolsDuringPrompt = [];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const factory = async (_source, _profile, receivedEnvelope) => {
		envelope = receivedEnvelope;
		return {
			agent, subscribe: (listener) => { emit = listener; return () => undefined; },
			getActiveToolNames: () => [...activeTools],
			getAllTools: () => activeTools.map(readOnlyTestTool),
			setActiveToolsByName: (names) => { activeTools = [...names]; },
			prompt: async (text) => {
				prompt = text; toolsDuringPrompt = [...activeTools];
				const args = { status: "accepted", reason: "All observable criteria passed", assertions: [{ status: "accepted", criterionId: "C1", evidence: "Observed Friday", evidenceRefs: ["tool:read"] }] };
				bindAssistantTurn(emit, [{ id: "read-situation", name: "read", args: { path: "result.txt" } }, { id: "verdict-situation", name: "verification_submit", args }], "response:situation-verification");
				await startAdmittedToolCall(agent, emit, { id: "read-situation", name: "read", args: { path: "result.txt" } }, "response:situation-verification");
				emit({ type: "tool_execution_end", toolCallId: "read-situation", toolName: "read", args: { path: "result.txt" }, isError: false, result: { content: [{ type: "text", text: "Friday" }], details: {} } });
				await startAdmittedToolCall(agent, emit, { id: "verdict-situation", name: "verification_submit", args }, "response:situation-verification");
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
	assert.equal(envelope.budget.maxToolCalls, undefined, "read-only verification must inherit the unbounded Contract instead of failing on a synthetic Tool-call ceiling");
	assert.equal(envelope.budget.maxTokens, undefined, "independent verification must not be cancelled by a cumulative token ceiling");
	assert.deepEqual(toolsDuringPrompt, ["verification_submit", "read"]);
});

test("independent verification rejects free-text verdicts instead of parsing model-authored envelopes", async () => {
	for (const answer of ["ACCEPT: unable to verify", '<beemax-verdict>{"status":"accepted","reason":"first","assertions":[]}</beemax-verdict><beemax-verdict>{"status":"accepted","reason":"second","assertions":[]}</beemax-verdict>', '<beemax-verdict>{"status":"unavailable","reason":"source provider offline"}</beemax-verdict>']) {
		let activeTools = ["verification_submit", "capability_discover", "read", "web_search", "exa_web_search", "web_extract"];
		const agent = { state: { model: { id: "test" }, messages: [] } };
		const factory = async () => ({
			agent, subscribe: () => () => undefined,
			getActiveToolNames: () => [...activeTools], getAllTools: () => activeTools.map(readOnlyTestTool), setActiveToolsByName: (names) => { activeTools = [...names]; },
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
		getAllTools: () => activeTools.map(readOnlyTestTool),
		setActiveToolsByName: (names) => { activeTools = [...names]; },
		prompt: async () => {
			const args = { status: "accepted", reason: "The requested draft exists", assertions: [{ status: "accepted", criterionId: "C1", evidence: "draft.md was observed", evidenceRefs: ["tool:read"] }] };
			bindAssistantTurn(emit, [{ id: "read-1", name: "read", args: { path: "draft.md" } }, { id: "verdict-1", name: "verification_submit", args }], "response:accepted-verdict");
			await startAdmittedToolCall(agent, emit, { id: "read-1", name: "read", args: { path: "draft.md" } }, "response:accepted-verdict");
			emit({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", args: { path: "draft.md" }, isError: false, result: { content: [{ type: "text", text: "draft" }], details: {} } });
			await startAdmittedToolCall(agent, emit, { id: "verdict-1", name: "verification_submit", args }, "response:accepted-verdict");
			emit({ type: "tool_execution_end", toolCallId: "verdict-1", toolName: "verification_submit", args, isError: false, result: { content: [{ type: "text", text: "Verdict recorded" }], details: {} } });
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "I submitted the verdict." }], usage: { input: 1, output: 1 } }];
		},
		abort: async () => undefined,
		dispose: () => undefined,
	});
	const verify = createTaskVerifier(factory, 1_000, undefined, ["verification_submit", "read"]);
	const result = await verify({ id: "task", ownerKey: "owner", kind: "delegated", title: "Verify draft", acceptanceCriteria: "draft exists", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } }, { output: "draft.md" }, undefined, { taskRunId: "run-accepted" });
	assert.equal(result.accepted, true);
	assert.match(result.evidence, /tool-call:read-1/);
	assert.deepEqual(result.criterionVerifications, [{ status: "accepted", criterionId: "C1", evidence: "draft.md was observed", evidenceRefs: ["execution:verification:run-accepted:tool-call:read-1"], criterion: "draft exists" }]);
});

test("independent verification returns receipt-bound status for every rejected criterion", async () => {
	let emit = () => undefined;
	let activeTools = ["verification_submit", "read"];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const factory = async () => ({
		agent,
		subscribe: (listener) => { emit = listener; return () => undefined; },
		getActiveToolNames: () => [...activeTools],
		getAllTools: () => activeTools.map(readOnlyTestTool),
		setActiveToolsByName: (names) => { activeTools = [...names]; },
		prompt: async () => {
			const args = { status: "rejected", reason: "Delivery receipt is missing", assertions: [
				{ status: "accepted", criterionId: "C1", evidence: "report exists", evidenceRefs: ["tool-call:read-report"] },
				{ status: "rejected", criterionId: "C2", evidence: "delivery receipt is absent", evidenceRefs: ["tool-call:read-delivery"] },
			] };
			bindAssistantTurn(emit, [
				{ id: "read-report", name: "read", args: { path: "report.md" } },
				{ id: "read-delivery", name: "read", args: { path: "delivery.json" } },
				{ id: "verdict-rejected", name: "verification_submit", args },
			], "response:rejected-verdict");
			for (const [id, path, text] of [["read-report", "report.md", "report"], ["read-delivery", "delivery.json", "not found"]]) {
				await startAdmittedToolCall(agent, emit, { id, name: "read", args: { path } }, "response:rejected-verdict");
				emit({ type: "tool_execution_end", toolCallId: id, toolName: "read", isError: false, result: { content: [{ type: "text", text }], details: {} } });
			}
			await startAdmittedToolCall(agent, emit, { id: "verdict-rejected", name: "verification_submit", args }, "response:rejected-verdict");
			emit({ type: "tool_execution_end", toolCallId: "verdict-rejected", toolName: "verification_submit", isError: false, result: { content: [{ type: "text", text: "recorded" }], details: {} } });
		},
		abort: async () => undefined,
		dispose: () => undefined,
	});
	const result = await createTaskVerifier(factory, 1_000, undefined, ["verification_submit", "read"])(
		{ id: "task", ownerKey: "owner", kind: "delegated", title: "Verify report", acceptanceCriteria: "report exists\ndelivery receipt exists", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } },
		{ output: "report.md" }, undefined, { taskRunId: "run-rejected" },
	);
	assert.deepEqual(result, {
		accepted: false,
		feedback: "Delivery receipt is missing",
		criterionVerifications: [
			{ status: "accepted", criterionId: "C1", evidence: "report exists", evidenceRefs: ["execution:verification:run-rejected:tool-call:read-report"], criterion: "report exists" },
			{ status: "rejected", criterionId: "C2", evidence: "delivery receipt is absent", evidenceRefs: ["execution:verification:run-rejected:tool-call:read-delivery"], criterion: "delivery receipt exists" },
		],
	});
});

test("independent verification does not let a fresh correction Session judge prior content-free receipts", async () => {
	let emit = () => undefined;
	let activeTools = ["verification_submit", "read"];
	let prompts = 0;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const factory = async () => ({
		agent,
		subscribe: (listener) => { emit = listener; return () => undefined; },
		getActiveToolNames: () => [...activeTools], getAllTools: () => ["verification_submit", "read"].map(readOnlyTestTool), setActiveToolsByName: (names) => { activeTools = [...names]; },
		prompt: async () => {
			prompts++;
			if (prompts === 1) {
				bindAssistantTurn(emit, [{ id: "read-correction", name: "read", args: { path: "draft.md" } }], "response:prior-session-read");
				await startAdmittedToolCall(agent, emit, { id: "read-correction", name: "read", args: { path: "draft.md" } }, "response:prior-session-read");
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
		getActiveToolNames: () => [...activeTools], getAllTools: () => ["verification_submit", "read"].map(readOnlyTestTool), setActiveToolsByName: (names) => { activeTools = [...names]; },
		prompt: async () => {
			prompts++;
			if (prompts === 2) {
				const args = { status: "accepted", reason: "The corrected check observed the draft", assertions: [{ status: "accepted", criterionId: "C1", evidence: "draft observed", evidenceRefs: ["tool:read"] }] };
				bindAssistantTurn(emit, [{ id: "read-after-correction", name: "read", args: { path: "draft.md" } }, { id: "verdict-after-correction", name: "verification_submit", args }], "response:corrected-verdict");
				await startAdmittedToolCall(agent, emit, { id: "read-after-correction", name: "read", args: { path: "draft.md" } }, "response:corrected-verdict");
				emit({ type: "tool_execution_end", toolCallId: "read-after-correction", toolName: "read", isError: false, result: { content: [{ type: "text", text: "draft" }], details: {} } });
				await startAdmittedToolCall(agent, emit, { id: "verdict-after-correction", name: "verification_submit", args }, "response:corrected-verdict");
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

test("a length-limited verifier recovery exposes only the structured verdict Tool", async () => {
	let listener = () => undefined;
	let activeTools = ["verification_submit", "read"];
	let promptCount = 0;
	const toolsDuringPrompt = [];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const factory = async () => ({
		agent,
		subscribe: (next) => { listener = next; return () => undefined; },
		getActiveToolNames: () => [...activeTools],
		getAllTools: () => activeTools.map(readOnlyTestTool),
		setActiveToolsByName: (names) => { activeTools = [...names]; },
		prompt: async () => {
			promptCount++;
			toolsDuringPrompt.push([...activeTools]);
			if (promptCount === 1) {
				bindAssistantTurn(listener, [{ id: "read-before-length", name: "read", args: { path: "draft.md" } }], "response:read-before-length");
				await startAdmittedToolCall(agent, listener, { id: "read-before-length", name: "read", args: { path: "draft.md" } }, "response:read-before-length");
				listener({ type: "tool_execution_end", toolCallId: "read-before-length", toolName: "read", args: { path: "draft.md" }, isError: false, result: { content: [{ type: "text", text: "draft" }], details: {} } });
				listener({ type: "message_end", message: { role: "assistant", responseId: "response:length-verifier", stopReason: "length", content: [{ type: "thinking", thinking: "output allowance exhausted" }, { type: "text", text: "" }], usage: { input: 10, output: 8_192, cacheRead: 0, cacheWrite: 0 } } });
				return;
			}
			const args = { status: "accepted", reason: "The draft was observed", assertions: [{ status: "accepted", criterionId: "C1", evidence: "draft.md contains the draft", evidenceRefs: ["tool:read"] }] };
			bindAssistantTurn(listener, [{ id: "submit-after-length", name: "verification_submit", args }], "response:submit-after-length");
			await startAdmittedToolCall(agent, listener, { id: "submit-after-length", name: "verification_submit", args }, "response:submit-after-length");
			listener({ type: "tool_execution_end", toolCallId: "submit-after-length", toolName: "verification_submit", args, isError: false, result: { content: [{ type: "text", text: "Verdict recorded" }], details: { verdict: args } } });
			listener({ type: "message_end", message: { role: "assistant", responseId: "response:submitted-after-length", stopReason: "stop", content: [{ type: "text", text: "Verification submitted." }], usage: { input: 11, output: 3, cacheRead: 0, cacheWrite: 0 } } });
		},
		abort: async () => undefined,
		dispose: () => undefined,
	});
	const result = await createTaskVerifier(factory, 1_000, undefined, ["verification_submit", "read"])(
		{ id: "task-length-verifier", ownerKey: "owner", kind: "delegated", title: "Verify draft", acceptanceCriteria: "draft exists", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } },
		{ output: "draft.md" },
		undefined,
		{ taskRunId: "run-length-verifier" },
	);
	assert.equal(result.accepted, true);
	assert.deepEqual(toolsDuringPrompt[1], ["verification_submit"]);
});

test("independent verification refuses to carry search-only receipts into a fresh correction Session", async () => {
	let emit = () => undefined;
	let activeTools = ["verification_submit", "web_search", "web_extract"];
	let prompts = 0;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const factory = async () => ({
		agent, subscribe: (listener) => { emit = listener; return () => undefined; },
		getActiveToolNames: () => [...activeTools], getAllTools: () => ["verification_submit", "web_search", "web_extract"].map(readOnlyTestTool), setActiveToolsByName: (names) => { activeTools = [...names]; },
		prompt: async () => {
			prompts++;
			if (prompts === 1) {
				bindAssistantTurn(emit, [{ id: "search-only", name: "web_search", args: { query: "fact" } }], "response:search-only");
				await startAdmittedToolCall(agent, emit, { id: "search-only", name: "web_search", args: { query: "fact" } }, "response:search-only");
				emit({ type: "tool_execution_end", toolCallId: "search-only", toolName: "web_search", isError: false, result: { content: [{ type: "text", text: "https://source.example/report" }] } });
			}
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }];
		}, abort: async () => undefined, dispose: () => undefined,
	});
	await assert.rejects(
		() => createTaskVerifier(factory, 1_000, undefined, activeTools)(
			{ id: "task", ownerKey: "owner", kind: "delegated", title: "Verify current source", acceptanceCriteria: "source is current", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } },
			{ output: "Finding requires a current source check" },
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
		getActiveToolNames: () => [...activeTools], getAllTools: () => activeTools.map(readOnlyTestTool), setActiveToolsByName: (names) => { activeTools = [...names]; },
		prompt: async () => {
			const args = { status: "accepted", reason: "observed", assertions: [{ status: "accepted", criterionId: "C1", evidence: "observed", evidenceRefs: ["tool:read"] }] };
			const secondArgs = { ...args, reason: "duplicate rejected attempt" };
			bindAssistantTurn(emit, [{ id: "read-1", name: "read", args: { path: "draft.md" } }, { id: "verdict-1", name: "verification_submit", args }, { id: "verdict-2", name: "verification_submit", args: secondArgs }], "response:duplicate-verdict");
			await startAdmittedToolCall(agent, emit, { id: "read-1", name: "read", args: { path: "draft.md" } }, "response:duplicate-verdict");
			emit({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", isError: false, result: {} });
			await startAdmittedToolCall(agent, emit, { id: "verdict-1", name: "verification_submit", args }, "response:duplicate-verdict");
			emit({ type: "tool_execution_end", toolCallId: "verdict-1", toolName: "verification_submit", isError: false, result: {} });
			await startAdmittedToolCall(agent, emit, { id: "verdict-2", name: "verification_submit", args: secondArgs }, "response:duplicate-verdict");
			emit({ type: "tool_execution_end", toolCallId: "verdict-2", toolName: "verification_submit", isError: true, result: { details: { dispatchError: { stage: "authorization", code: "blocked", retryable: false } } } });
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }];
		},
		abort: async () => undefined, dispose: () => undefined,
	});
	const verify = createTaskVerifier(factory, 1_000, undefined, ["verification_submit", "read"]);
	await assert.rejects(() => verify({ id: "task", ownerKey: "owner", kind: "delegated", title: "Verify", acceptanceCriteria: "draft exists", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } }, { output: "draft.md" }), /exactly one successful structured verdict/);
});

test("independent verification cannot accept an external URL without fetching it", async () => {
	let emit = () => undefined;
	let activeTools = ["verification_submit", "capability_discover", "read", "web_search", "exa_web_search", "web_extract"];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const factory = async () => ({
		agent, subscribe: (listener) => { emit = listener; return () => undefined; },
		getActiveToolNames: () => [...activeTools], getAllTools: () => activeTools.map(readOnlyTestTool), setActiveToolsByName: (names) => { activeTools = [...names]; },
		prompt: async () => {
			const unrelatedUrl = "https://other.example/unrelated";
			const args = { status: "accepted", reason: "looks plausible", assertions: [{ status: "accepted", criterionId: "C1", evidence: "unrelated URL fetched", evidenceRefs: ["tool:web_extract"] }] };
			bindAssistantTurn(emit, [{ id: "extract-unrelated", name: "web_extract", args: { url: unrelatedUrl } }, { id: "verdict-1", name: "verification_submit", args }], "response:unfetched-url-verdict");
			await startAdmittedToolCall(agent, emit, { id: "extract-unrelated", name: "web_extract", args: { url: unrelatedUrl } }, "response:unfetched-url-verdict");
			emit({ type: "tool_execution_end", toolCallId: "extract-unrelated", toolName: "web_extract", args: { url: unrelatedUrl }, isError: false, result: { content: [{ type: "text", text: "unrelated source" }], details: {} } });
			await startAdmittedToolCall(agent, emit, { id: "verdict-1", name: "verification_submit", args }, "response:unfetched-url-verdict");
			emit({ type: "tool_execution_end", toolCallId: "verdict-1", toolName: "verification_submit", args, isError: false, result: {} });
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "submitted" }], usage: { input: 1, output: 1 } }];
		},
		abort: async () => undefined, dispose: () => undefined,
	});
	const verify = createTaskVerifier(factory, 1_000);
	await assert.rejects(() => verify({ id: "task", ownerKey: "owner", kind: "delegated", title: "Verify URL", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } }, { output: "Source: https://example.com/fact" }), /not every cited external source URL was independently fetched/);
});

test("independent verification cannot accept an external URL discovered inside an Artifact without fetching it", async () => {
	let emit = () => undefined;
	let activeTools = ["verification_submit", "artifact_inspect", "web_extract"];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const factory = async () => ({
		agent, subscribe: (listener) => { emit = listener; return () => undefined; },
		getActiveToolNames: () => [...activeTools], getAllTools: () => activeTools.map(readOnlyTestTool), setActiveToolsByName: (names) => { activeTools = [...names]; },
		prompt: async () => {
			const inspectResult = {
				content: [{ type: "text", text: "Inspected report.html" }],
				details: { checks: [{ dimension: "semantic", status: "accepted", evidenceRefs: ["semantic:external-urls:1", "artifact:external-url:https://source.example/report"] }], externalUrls: ["https://source.example/report"] },
			};
			const args = { status: "accepted", reason: "artifact exists", assertions: [{ status: "accepted", criterionId: "C1", evidence: "artifact inspected", evidenceRefs: ["tool:artifact_inspect"] }] };
			bindAssistantTurn(emit, [{ id: "inspect-report", name: "artifact_inspect", args: { path: "report.html" } }, { id: "verdict-1", name: "verification_submit", args }], "response:artifact-url-verdict");
			await startAdmittedToolCall(agent, emit, { id: "inspect-report", name: "artifact_inspect", args: { path: "report.html" } }, "response:artifact-url-verdict");
			emit({ type: "tool_execution_end", toolCallId: "inspect-report", toolName: "artifact_inspect", args: { path: "report.html" }, isError: false, result: inspectResult });
			await startAdmittedToolCall(agent, emit, { id: "verdict-1", name: "verification_submit", args }, "response:artifact-url-verdict");
			emit({ type: "tool_execution_end", toolCallId: "verdict-1", toolName: "verification_submit", args, isError: false, result: {} });
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "submitted" }], usage: { input: 1, output: 1 } }];
		}, abort: async () => undefined, dispose: () => undefined,
	});
	const verify = createTaskVerifier(factory, 1_000, undefined, activeTools);
	await assert.rejects(() => verify(
		{ id: "task", ownerKey: "owner", kind: "delegated", title: "Verify artifact", acceptanceCriteria: "report exists", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } },
		{ output: "report.html" },
	), /not every cited external source URL was independently fetched/);
});

test("independent verification cannot claim HTML/PDF consistency without a receipt for the consistency dimension", async () => {
	let emit = () => undefined;
	let activeTools = ["verification_submit", "artifact_inspect", "web_extract"];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const factory = async () => ({
		agent, subscribe: (listener) => { emit = listener; return () => undefined; },
		getActiveToolNames: () => [...activeTools], getAllTools: () => activeTools.map(readOnlyTestTool), setActiveToolsByName: (names) => { activeTools = [...names]; },
		prompt: async () => {
			const inspectArgs = { path: "report.pdf", mediaType: "application/pdf", requiredDimensions: ["existence", "integrity", "semantic", "render"], requiredText: ["4,111.40"] };
			const inspectResult = { content: [{ type: "text", text: "PDF inspected" }], details: { checks: inspectArgs.requiredDimensions.map((dimension) => ({ dimension, status: "accepted", evidenceRefs: [`evidence:${dimension}`] })) } };
			const verdictArgs = { status: "accepted", reason: "files look consistent", assertions: [{ status: "accepted", criterionId: "C1", evidence: "PDF inspected", evidenceRefs: ["tool:artifact_inspect"] }] };
			bindAssistantTurn(emit, [{ id: "inspect-pdf", name: "artifact_inspect", args: inspectArgs }, { id: "verdict", name: "verification_submit", args: verdictArgs }], "response:missing-consistency");
			await startAdmittedToolCall(agent, emit, { id: "inspect-pdf", name: "artifact_inspect", args: inspectArgs }, "response:missing-consistency");
			emit({ type: "tool_execution_end", toolCallId: "inspect-pdf", toolName: "artifact_inspect", args: inspectArgs, isError: false, result: inspectResult });
			await startAdmittedToolCall(agent, emit, { id: "verdict", name: "verification_submit", args: verdictArgs }, "response:missing-consistency");
			emit({ type: "tool_execution_end", toolCallId: "verdict", toolName: "verification_submit", args: verdictArgs, isError: false, result: {} });
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "submitted" }], usage: { input: 1, output: 1 } }];
		}, abort: async () => undefined, dispose: () => undefined,
	});
	await assert.rejects(() => createTaskVerifier(factory, 1_000, undefined, activeTools)(
		{ id: "task", ownerKey: "owner", kind: "delegated", title: "Verify report", acceptanceCriteria: "HTML 与 PDF 的关键数字和来源一致。", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } },
		{ output: "report.html\nreport.pdf" },
	), /consistency dimension/i);
});

test("independent verification cannot claim raw/formatted equivalence from unrelated source and visible substrings", async () => {
	let emit = () => undefined;
	let activeTools = ["verification_submit", "artifact_inspect", "web_extract"];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const factory = async () => ({
		agent, subscribe: (listener) => { emit = listener; return () => undefined; },
		getActiveToolNames: () => [...activeTools], getAllTools: () => activeTools.map(readOnlyTestTool), setActiveToolsByName: (names) => { activeTools = [...names]; },
		prompt: async () => {
			const inspectArgs = { path: "report.html", mediaType: "text/html", requiredDimensions: ["semantic"], requiredText: ["4,111.40"], requiredSourceText: ["4111.4"] };
			const inspectResult = { content: [{ type: "text", text: "HTML inspected" }], details: { checks: [{ dimension: "semantic", status: "accepted", evidenceRefs: ["semantic:matched:1", "semantic:source-matched:1"] }] } };
			const verdictArgs = { status: "accepted", reason: "raw and formatted values exist", assertions: [{ status: "accepted", criterionId: "C1", evidence: "HTML inspected", evidenceRefs: ["tool:artifact_inspect"] }] };
			bindAssistantTurn(emit, [{ id: "inspect-html", name: "artifact_inspect", args: inspectArgs }, { id: "verdict", name: "verification_submit", args: verdictArgs }], "response:missing-bound-pair");
			await startAdmittedToolCall(agent, emit, { id: "inspect-html", name: "artifact_inspect", args: inspectArgs }, "response:missing-bound-pair");
			emit({ type: "tool_execution_end", toolCallId: "inspect-html", toolName: "artifact_inspect", args: inspectArgs, isError: false, result: inspectResult });
			await startAdmittedToolCall(agent, emit, { id: "verdict", name: "verification_submit", args: verdictArgs }, "response:missing-bound-pair");
			emit({ type: "tool_execution_end", toolCallId: "verdict", toolName: "verification_submit", args: verdictArgs, isError: false, result: {} });
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "submitted" }], usage: { input: 1, output: 1 } }];
		}, abort: async () => undefined, dispose: () => undefined,
	});
	await assert.rejects(() => createTaskVerifier(factory, 1_000, undefined, activeTools)(
		{ id: "task", ownerKey: "owner", kind: "delegated", title: "Verify report", acceptanceCriteria: "HTML 源码中的原始数值必须与可见格式化数字一一对应且一致。", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } },
		{ output: "report.html" },
	), /source-visible pair/i);
});

test("artifact verification prompt makes visible/source assertions and HTML-to-PDF consistency direction unambiguous", async () => {
	let prompt = "";
	let activeTools = ["verification_submit", "artifact_inspect", "web_extract"];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const factory = async () => ({
		agent, subscribe: () => () => undefined,
		getActiveToolNames: () => [...activeTools], getAllTools: () => activeTools.map(readOnlyTestTool), setActiveToolsByName: (names) => { activeTools = [...names]; },
		prompt: async (text) => { prompt = text; throw new Error("verification prompt probe"); },
		abort: async () => undefined, dispose: () => undefined,
	});
	await assert.rejects(() => createTaskVerifier(factory, 1_000, undefined, activeTools)(
		{
			id: "task", ownerKey: "owner", kind: "delegated", title: "Verify report", status: "running", createdAt: 1,
			acceptanceCriteria: "HTML 源码中的原始数值必须与可见格式化数字一一对应且一致；PDF 与 HTML 的关键数字和来源一致。",
			executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" },
		},
		{ output: "report.html\nreport.pdf" },
	), /verification prompt probe/i);
	assert.match(prompt, /requiredText is for visible text only/i);
	assert.match(prompt, /source-only raw literals.*requiredSourceVisiblePairs/i);
	assert.match(prompt, /inspect the PDF as the rendered output/i);
	assert.match(prompt, /consistentWithMediaType.*text\/html/i);
	assert.match(prompt, /never inspect the HTML with the PDF as its consistency source/i);
});

test("independent verification treats citation overflow as a correctable candidate rejection", async () => {
	let factoryCalls = 0;
	const factory = async () => { factoryCalls++; throw new Error("verification Agent must not start for an oversized Candidate"); };
	const urls = Array.from({ length: 25 }, (_, index) => `https://source-${index + 1}.example/report`);
	const result = await createTaskVerifier(factory, 1_000)(
		{ id: "task", ownerKey: "owner", kind: "delegated", title: "Verify research", acceptanceCriteria: "cite material sources", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } },
		{ output: urls.join("\n") },
	);
	assert.equal(result.accepted, false);
	assert.match(result.feedback, /at most 24 unique external URLs/i);
	assert.match(result.feedback, /smallest sufficient material source set/i);
	assert.equal(factoryCalls, 0);
});

test("independent verification enforces a stricter citation bound declared by the Task", async () => {
	let factoryCalls = 0;
	const factory = async () => { factoryCalls++; throw new Error("verification Agent must not start for a contract-violating Candidate"); };
	const urls = Array.from({ length: 9 }, (_, index) => `https://source-${index + 1}.example/report`);
	const result = await createTaskVerifier(factory, 1_000)(
		{ id: "task", ownerKey: "owner", kind: "delegated", title: "Verify research", acceptanceCriteria: "Return at most 8 unique external URLs.", status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } },
		{ output: urls.join("\n") },
	);
	assert.equal(result.accepted, false);
	assert.match(result.feedback, /at most 8 unique external URLs/i);
	assert.equal(factoryCalls, 0);
});

test("independent verification cannot accept an unknown-domain current claim from an unrelated receipt", async () => {
	let emit = () => undefined;
	const activeTools = ["verification_submit", "read", "temporal_evidence_feed"];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const factory = async () => ({
		agent, subscribe: (listener) => { emit = listener; return () => undefined; },
		getActiveToolNames: () => [...activeTools], getAllTools: () => activeTools.map(readOnlyTestTool), setActiveToolsByName: () => undefined,
		prompt: async () => {
			const args = { status: "accepted", reason: "local note looked plausible", assertions: [{ status: "accepted", criterionId: "C1", evidence: "local note", evidenceRefs: ["tool:read"] }] };
			bindAssistantTurn(emit, [{ id: "local-only", name: "read", args: { path: "note.txt" } }, { id: "verdict-local", name: "verification_submit", args }], "response:unrelated-receipt");
			await startAdmittedToolCall(agent, emit, { id: "local-only", name: "read", args: { path: "note.txt" } }, "response:unrelated-receipt");
			emit({ type: "tool_execution_end", toolCallId: "local-only", toolName: "read", isError: false, result: { content: [{ type: "text", text: "qx-17 guess" }] } });
			await startAdmittedToolCall(agent, emit, { id: "verdict-local", name: "verification_submit", args }, "response:unrelated-receipt");
			emit({ type: "tool_execution_end", toolCallId: "verdict-local", toolName: "verification_submit", isError: false, result: {} });
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "submitted" }], usage: { input: 1, output: 1 } }];
		}, abort: async () => undefined, dispose: () => undefined,
	});
	const verify = createTaskVerifier(factory, 1_000, undefined, activeTools);
	await assert.rejects(
		() => verify({
			id: "task", ownerKey: "owner", kind: "delegated", title: "qx-17 zorb flux", acceptanceCriteria: "zorb receipt attached",
			verificationRequirements: [{ capability: "temporal_evidence_feed", freshness: "realtime", evidence: "source_receipt" }],
			status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" },
		}, { output: "naru vek tal" }),
		/required current-source capability receipt/,
	);
});

test("independent verification accepts an unknown-domain current claim from its selected alternate Provider receipt", async () => {
	let emit = () => undefined;
	const activeTools = ["verification_submit", "temporal_evidence_feed_alt"];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const factory = async () => ({
		agent, subscribe: (listener) => { emit = listener; return () => undefined; },
		getActiveToolNames: () => [...activeTools], getAllTools: () => activeTools.map(readOnlyTestTool), setActiveToolsByName: () => undefined,
		prompt: async () => {
			const args = { status: "accepted", reason: "alternate source returned the qx-17 snapshot", assertions: [{ status: "accepted", criterionId: "C1", evidence: "snapshot observed", evidenceRefs: ["tool:temporal_evidence_feed_alt"] }] };
			bindAssistantTurn(emit, [{ id: "alternate-source", name: "temporal_evidence_feed_alt", args: { key: "qx-17" } }, { id: "verdict-alt", name: "verification_submit", args }], "response:alternate-provider-verdict");
			await startAdmittedToolCall(agent, emit, { id: "alternate-source", name: "temporal_evidence_feed_alt", args: { key: "qx-17" } }, "response:alternate-provider-verdict");
			emit({ type: "tool_execution_end", toolCallId: "alternate-source", toolName: "temporal_evidence_feed_alt", isError: false, result: { content: [{ type: "text", text: "qx-17 snapshot at t=42" }] } });
			await startAdmittedToolCall(agent, emit, { id: "verdict-alt", name: "verification_submit", args }, "response:alternate-provider-verdict");
			emit({ type: "tool_execution_end", toolCallId: "verdict-alt", toolName: "verification_submit", isError: false, result: {} });
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "submitted" }], usage: { input: 1, output: 1 } }];
		}, abort: async () => undefined, dispose: () => undefined,
	});
	const result = await createTaskVerifier(factory, 1_000, undefined, activeTools)({
		id: "task", ownerKey: "owner", kind: "delegated", title: "qx-17 zorb flux", acceptanceCriteria: "zorb receipt attached",
		verificationRequirements: [{ capability: "temporal_evidence_feed_alt", freshness: "realtime", evidence: "source_receipt" }],
		status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" },
	}, { output: "naru vek tal" });
	assert.equal(result.accepted, true);
	assert.match(result.evidence, /temporal_evidence_feed_alt/);
	assert.equal(result.criterionVerifications[0].evidenceRefs.length, 1);
	assert.match(result.criterionVerifications[0].evidenceRefs[0], /^execution:verification:[^:]+:tool-call:alternate-source$/);
});

test("independent verification can fetch every cited source without a synthetic Tool-call ceiling", async () => {
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
			getActiveToolNames: () => [...activeTools], getAllTools: () => activeTools.map(readOnlyTestTool), setActiveToolsByName: (names) => { activeTools = [...names]; },
			prompt: async (text) => {
				verificationPrompt = text;
				toolsDuringPrompt = [...activeTools];
				const args = { status: "accepted", reason: "all cited sources fetched", assertions: [{ status: "accepted", criterionId: "C1", evidence: "sources fetched", evidenceRefs: ["tool:web_extract"] }] };
				bindAssistantTurn(emit, [...urls.map((url, index) => ({ id: `extract-${index + 1}`, name: "web_extract", args: { url } })), { id: "verdict-all", name: "verification_submit", args }], "response:all-source-verdict");
				for (const [index, url] of urls.entries()) {
					const callId = `extract-${index + 1}`;
					await startAdmittedToolCall(agent, emit, { id: callId, name: "web_extract", args: { url } }, "response:all-source-verdict");
					emit({ type: "tool_execution_end", toolCallId: callId, toolName: "web_extract", isError: false, result: { content: [{ type: "text", text: `source ${index + 1}` }] } });
				}
				await startAdmittedToolCall(agent, emit, { id: "verdict-all", name: "verification_submit", args }, "response:all-source-verdict");
				emit({ type: "tool_execution_end", toolCallId: "verdict-all", toolName: "verification_submit", isError: false, result: {} });
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "submitted" }], usage: { input: 1, output: 1 } }];
			}, abort: async () => undefined, dispose: () => undefined,
		};
	};
	const verify = createTaskVerifier(factory, 1_000, undefined, activeTools);
	const result = await verify(
		{ id: "task", ownerKey: "owner", kind: "delegated", title: "Verify current public research", acceptanceCriteria: "all cited sources are independently verified", verificationRequirements: [{ capability: "web_search", freshness: "realtime", evidence: "source_receipt" }], status: "running", createdAt: 1, executionScope: { platform: "cli", chatId: "local", chatType: "dm", userId: "local" } },
		{ output: `${"context ".repeat(3_000)}\n${urls.map((url) => `Source: ${url}`).join("\n")}` },
	);
	assert.equal(result.accepted, true);
	assert.equal(envelope.budget.maxToolCalls, undefined);
	assert.equal(envelope.budget.maxTokens, undefined);
	assert.equal(toolsDuringPrompt.includes("web_search"), false);
	assert.match(verificationPrompt, /required-exact-source-urls/);
	assert.match(verificationPrompt, /source-7\.example/);
});
