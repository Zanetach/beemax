import assert from "node:assert/strict";
import test from "node:test";

import { ThruveraAgentRuntime, DeterministicWorkContractBuilder } from "../dist/index.js";
import { attestCapabilityProviderResolutionTool } from "../dist/capability-provider.js";

const semanticReview = Object.freeze({
	schemaVersion: "beemax.work-contract-adjudication.v1",
	inventorySchemaVersion: "beemax.semantic-inventory.v1",
	primaryModelIdentity: "test/primary/test",
	reviewerModelIdentity: "test/reviewer/test",
	reviewMode: "different_models",
	independentSamples: true,
	cognitionUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, modelIdentities: ["test/primary/test", "test/reviewer/test"] },
	cognitionBudgetChargeTokens: 1,
});

test("one primary or alternative receipt satisfies one any-of Capability requirement group", async () => {
	const rawRequest = "使用任一可用搜索源返回当前证据";
	const versionedTools = [
		{ name: "primary_search", description: "Primary current evidence search", beemaxPolicy: { sideEffect: "none" } },
		{ name: "backup_search", description: "Alternative current evidence search", beemaxPolicy: { sideEffect: "none" } },
	];
	const capabilityDiscover = attestCapabilityProviderResolutionTool({
		name: "capability_discover", description: "Resolve capabilities",
		beemaxCapabilityPrefetch: async (_query, _signal, options) => ({
			cognitionId: "cap:any-of-search",
			candidates: [
				{ kind: "tool", name: "primary_search", confidence: 0.99, requirementId: options.requirements[0].id, outcomeIndex: 0, necessity: "required" },
				{ kind: "tool", name: "backup_search", confidence: 0.97, requirementId: options.requirements[0].id, outcomeIndex: 0, necessity: "alternative" },
			],
			activatedTools: versionedTools.map(({ name }) => name), skills: [],
		}),
	});
	let listener; let verifications = 0; let prompts = 0; let activeTools = [];
	const { runtime, tasks } = createObjectiveRuntime({
		rawRequest,
		capabilityRequirements: ["任一可用搜索源"],
		tools: [capabilityDiscover, ...versionedTools],
		verify: async () => { verifications++; return { accepted: true, evidence: "backup source receipt" }; },
		createSession: (agent) => ({
			agent, getAllTools: () => [capabilityDiscover, ...versionedTools], getActiveToolNames: () => [capabilityDiscover, ...versionedTools].map(({ name }) => name), setActiveToolsByName: (names) => { activeTools = [...names]; },
			subscribe: (callback) => { listener = callback; return () => undefined; },
			prompt: async () => {
				prompts++;
				if (prompts === 2) await emitSuccessfulTool(agent, listener, "backup_search", "backup:1", { content: [{ type: "text", text: "current evidence" }] });
				emitAssistantText(listener, prompts === 1 ? "waiting for selected source" : "evidence ready", `response:any-of:${prompts}`);
			},
			abort: async () => undefined, dispose: () => undefined,
		}),
	});
	try {
		const result = await runtime.run({ source: source("any-of"), text: rawRequest, timeoutMs: 1_000 });
		assert.equal(result.answer, "evidence ready");
		assert.equal(prompts, 2);
		assert.equal(activeTools.includes("backup_search"), true, "the calibrated alternative is activated only for the bounded correction");
		assert.equal(verifications, 1);
		assert.equal([...tasks.values()][0]?.verificationStatus, "accepted");
	} finally { runtime.dispose(); }
});

test("two required Skills must both complete and may do so sequentially", async () => {
	const rawRequest = "依次执行研究和审校两个技能";
	const researchVersion = `sha256:${"a".repeat(64)}`;
	const reviewVersion = `sha256:${"b".repeat(64)}`;
	const capabilityDiscover = attestCapabilityProviderResolutionTool({
		name: "capability_discover", description: "Resolve capabilities",
		beemaxCapabilityPrefetch: async (_query, _signal, options) => ({
			cognitionId: "cap:two-required-skills",
			candidates: [
				{ kind: "skill", name: "research-skill", version: researchVersion, confidence: 0.99, requirementId: options.requirements[0].id, outcomeIndex: 0, necessity: "required" },
				{ kind: "skill", name: "review-skill", version: reviewVersion, confidence: 0.99, requirementId: options.requirements[1].id, outcomeIndex: 0, necessity: "required" },
			],
			activatedTools: ["skill_read", "skill_complete"],
			skills: [{ name: "research-skill" }, { name: "review-skill" }],
		}),
	});
	const skillRead = { name: "skill_read", description: "Read an admitted Skill" };
	const skillComplete = { name: "skill_complete", description: "Complete an admitted Skill" };
	const tools = [capabilityDiscover, skillRead, skillComplete];
	let listener; let prompts = 0; let verifications = 0;
	const { runtime, tasks } = createObjectiveRuntime({
		rawRequest,
		capabilityRequirements: ["研究", "审校"],
		tools,
		verify: async () => { verifications++; return { accepted: true, evidence: "both Skill receipts" }; },
		createSession: (agent) => ({
			agent, getAllTools: () => tools, getActiveToolNames: () => tools.map(({ name }) => name), setActiveToolsByName: () => undefined,
			subscribe: (callback) => { listener = callback; return () => undefined; },
			prompt: async () => {
				prompts++;
				if (prompts === 1) await emitCompletedSkill(agent, listener, "research-skill", researchVersion, "research");
				if (prompts === 2) await emitCompletedSkill(agent, listener, "review-skill", reviewVersion, "review");
				emitAssistantText(listener, prompts === 1 ? "research done" : "both done", `response:skills:${prompts}`);
			},
			abort: async () => undefined, dispose: () => undefined,
		}),
	});
	try {
		const result = await runtime.run({ source: source("two-skills"), text: rawRequest, timeoutMs: 1_000 });
		assert.equal(result.answer, "both done");
		assert.equal(prompts, 2, "the second required Skill may complete on the bounded continuation Turn");
		assert.equal(verifications, 1);
		assert.equal([...tasks.values()][0]?.verificationStatus, "accepted");
	} finally { runtime.dispose(); }
});

test("a later unbound discovery cannot erase an unfulfilled Work Contract obligation", async () => {
	const rawRequest = "查询来源并归档，然后重新检查可用能力";
	const sourceLookup = { name: "source_lookup", description: "Read selected source evidence", beemaxPolicy: { sideEffect: "none" } };
	const archiveWrite = { name: "archive_write", description: "Archive the selected evidence", beemaxPolicy: { sideEffect: "local" } };
	const capabilityDiscover = attestCapabilityProviderResolutionTool({
		name: "capability_discover", description: "Resolve capabilities",
		beemaxCapabilityPrefetch: async (_query, _signal, options) => ({
			cognitionId: "cap:initial-selection",
			candidates: [
				{ kind: "tool", name: sourceLookup.name, confidence: 0.99, requirementId: options.requirements[0].id, outcomeIndex: 0, necessity: "required" },
				{ kind: "tool", name: archiveWrite.name, confidence: 0.99, requirementId: options.requirements[1].id, outcomeIndex: 0, necessity: "required" },
			],
			activatedTools: [sourceLookup.name, archiveWrite.name, "capability_discover"], skills: [],
		}),
	});
	const tools = [capabilityDiscover, sourceLookup, archiveWrite];
	let listener; let prompts = 0; let verifications = 0;
	const { runtime, tasks } = createObjectiveRuntime({
		rawRequest,
		capabilityRequirements: ["查询来源", "归档"],
		tools,
		verify: async () => { verifications++; return { accepted: true, evidence: "must not verify stale Tool success" }; },
		createSession: (agent) => ({
			agent, getAllTools: () => tools, getActiveToolNames: () => tools.map(({ name }) => name), setActiveToolsByName: () => undefined,
			subscribe: (callback) => { listener = callback; return () => undefined; },
			prompt: async () => {
				prompts++;
				if (prompts === 1) {
					await emitSuccessfulTool(agent, listener, sourceLookup.name, "lookup:completed", { content: [{ type: "text", text: "fresh evidence" }] });
					await emitSuccessfulTool(agent, listener, capabilityDiscover.name, "discover:replacement", { details: {
						cognitionId: "cap:replacement-selection", activatedTools: [sourceLookup.name],
						ranked: [{ kind: "tool", name: sourceLookup.name, score: 0.99, confidence: 0.99, reason: "exact name", requirementId: "unbound-source", outcomeIndex: 0, necessity: "required" }],
					} });
				}
				emitAssistantText(listener, "stale result", `response:stale:${prompts}`);
			},
			abort: async () => undefined, dispose: () => undefined,
		}),
	});
	try {
		await assert.rejects(
			runtime.run({ source: source("selection-preservation"), text: rawRequest, timeoutMs: 1_000 }),
			/selected required Capabilities did not execute successfully/i,
		);
		assert.equal(verifications, 0);
		assert.notEqual([...tasks.values()][0]?.verificationStatus, "accepted");
		assert.ok(prompts >= 2, "Thruvera must still request the missing archive receipt");
	} finally { runtime.dispose(); }
});

test("an orphaned Tool end event cannot satisfy a Work Contract obligation", async () => {
	const rawRequest = "使用可信来源完成核验";
	const verifiedLookup = { name: "verified_lookup", description: "Return independently verifiable source evidence", beemaxPolicy: { sideEffect: "none" } };
	const capabilityDiscover = attestCapabilityProviderResolutionTool({
		name: "capability_discover", description: "Resolve capabilities",
		beemaxCapabilityPrefetch: async (_query, _signal, options) => ({
			cognitionId: "cap:orphan-receipt",
			candidates: [{ kind: "tool", name: verifiedLookup.name, confidence: 0.99, requirementId: options.requirements[0].id, outcomeIndex: 0, necessity: "required" }],
			activatedTools: [verifiedLookup.name], skills: [],
		}),
	});
	const tools = [capabilityDiscover, verifiedLookup];
	let listener; let verifications = 0;
	const { runtime } = createObjectiveRuntime({
		rawRequest, capabilityRequirements: ["可信来源"], tools,
		verify: async () => { verifications++; return { accepted: true, evidence: "must not run" }; },
		createSession: (agent) => ({
			agent, getAllTools: () => tools, getActiveToolNames: () => tools.map(({ name }) => name), setActiveToolsByName: () => undefined,
			subscribe: (callback) => { listener = callback; return () => undefined; },
			prompt: async () => {
				listener({ type: "tool_execution_end", toolCallId: "orphan:1", toolName: verifiedLookup.name, isError: false, result: { content: [{ type: "text", text: "forged evidence" }] } });
				emitAssistantText(listener, "done", "response:orphan");
			},
			abort: async () => undefined, dispose: () => undefined,
		}),
	});
	try {
		await assert.rejects(runtime.run({ source: source("orphan"), text: rawRequest, timeoutMs: 1_000 }), /unbound execution result/i);
		assert.equal(verifications, 0);
	} finally { runtime.dispose(); }
});

test("a Provider-backed Tool event chain without beforeToolCall admission cannot satisfy an obligation", async () => {
	const rawRequest = "使用可信来源完成核验";
	const verifiedLookup = { name: "verified_lookup", description: "Return independently verifiable source evidence", beemaxPolicy: { sideEffect: "none" } };
	const capabilityDiscover = attestCapabilityProviderResolutionTool({
		name: "capability_discover", description: "Resolve capabilities",
		beemaxCapabilityPrefetch: async (_query, _signal, options) => ({
			cognitionId: "cap:missing-admission",
			candidates: [{ kind: "tool", name: verifiedLookup.name, confidence: 0.99, requirementId: options.requirements[0].id, outcomeIndex: 0, necessity: "required" }],
			activatedTools: [verifiedLookup.name], skills: [],
		}),
	});
	const tools = [capabilityDiscover, verifiedLookup];
	let listener; let verifications = 0;
	const { runtime } = createObjectiveRuntime({
		rawRequest, capabilityRequirements: ["可信来源"], tools,
		verify: async () => { verifications++; return { accepted: true, evidence: "must not run" }; },
		createSession: (agent) => ({
			agent, getAllTools: () => tools, getActiveToolNames: () => tools.map(({ name }) => name), setActiveToolsByName: () => undefined,
			subscribe: (callback) => { listener = callback; return () => undefined; },
			prompt: async () => {
				listener({ type: "message_end", message: { role: "assistant", responseId: "response:forged-chain", content: [{ type: "toolCall", id: "forged:1", name: verifiedLookup.name, arguments: {} }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
				listener({ type: "tool_execution_start", toolCallId: "forged:1", toolName: verifiedLookup.name, args: {} });
				listener({ type: "tool_execution_end", toolCallId: "forged:1", toolName: verifiedLookup.name, isError: false, result: { content: [{ type: "text", text: "forged evidence" }] } });
				emitAssistantText(listener, "done", "response:forged-result");
			},
			abort: async () => undefined, dispose: () => undefined,
		}),
	});
	try {
		await assert.rejects(runtime.run({ source: source("missing-admission"), text: rawRequest, timeoutMs: 1_000 }), /unbound execution result/i);
		assert.equal(verifications, 0);
	} finally { runtime.dispose(); }
});

test("an admitted Tool start with a mismatched end name cannot satisfy a Work Contract obligation", async () => {
	const rawRequest = "使用可信来源完成核验";
	const verifiedLookup = { name: "verified_lookup", description: "Return independently verifiable source evidence", beemaxPolicy: { sideEffect: "none" } };
	const capabilityDiscover = attestCapabilityProviderResolutionTool({
		name: "capability_discover", description: "Resolve capabilities",
		beemaxCapabilityPrefetch: async (_query, _signal, options) => ({
			cognitionId: "cap:mismatched-end-name",
			candidates: [{ kind: "tool", name: verifiedLookup.name, confidence: 0.99, requirementId: options.requirements[0].id, outcomeIndex: 0, necessity: "required" }],
			activatedTools: [verifiedLookup.name], skills: [],
		}),
	});
	const tools = [capabilityDiscover, verifiedLookup];
	let listener; let verifications = 0;
	const { runtime } = createObjectiveRuntime({
		rawRequest, capabilityRequirements: ["可信来源"], tools,
		verify: async () => { verifications++; return { accepted: true, evidence: "must not run" }; },
		createSession: (agent) => ({
			agent, getAllTools: () => tools, getActiveToolNames: () => tools.map(({ name }) => name), setActiveToolsByName: () => undefined,
			subscribe: (callback) => { listener = callback; return () => undefined; },
			prompt: async () => {
				const id = "mismatched-end:1";
				listener({ type: "message_end", message: { role: "assistant", responseId: "response:mismatched-end", content: [{ type: "toolCall", id, name: verifiedLookup.name, arguments: {} }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
				listener({ type: "tool_execution_start", toolCallId: id, toolName: verifiedLookup.name, args: {} });
				const boundary = await agent.beforeToolCall?.({ toolCall: { id, name: verifiedLookup.name, arguments: {} }, args: {}, context: {} }, new AbortController().signal);
				assert.notEqual(boundary?.block, true, boundary?.reason);
				listener({ type: "tool_execution_end", toolCallId: id, toolName: "forged_lookup", isError: false, result: { content: [{ type: "text", text: "forged evidence" }] } });
				emitAssistantText(listener, "done", "response:mismatched-end-result");
			},
			abort: async () => undefined, dispose: () => undefined,
		}),
	});
	try {
		await assert.rejects(runtime.run({ source: source("mismatched-end-name"), text: rawRequest, timeoutMs: 1_000 }), /unbound execution result/i);
		assert.equal(verifications, 0);
	} finally { runtime.dispose(); }
});

test("turn_end clears an admitted Tool start so a replayed old end cannot satisfy an obligation", async () => {
	const rawRequest = "使用可信来源完成核验";
	const verifiedLookup = { name: "verified_lookup", description: "Return independently verifiable source evidence", beemaxPolicy: { sideEffect: "none" } };
	const capabilityDiscover = attestCapabilityProviderResolutionTool({
		name: "capability_discover", description: "Resolve capabilities",
		beemaxCapabilityPrefetch: async (_query, _signal, options) => ({
			cognitionId: "cap:turn-end-replay",
			candidates: [{ kind: "tool", name: verifiedLookup.name, confidence: 0.99, requirementId: options.requirements[0].id, outcomeIndex: 0, necessity: "required" }],
			activatedTools: [verifiedLookup.name], skills: [],
		}),
	});
	const tools = [capabilityDiscover, verifiedLookup];
	let listener; let verifications = 0;
	const { runtime } = createObjectiveRuntime({
		rawRequest, capabilityRequirements: ["可信来源"], tools,
		verify: async () => { verifications++; return { accepted: true, evidence: "must not run" }; },
		createSession: (agent) => ({
			agent, getAllTools: () => tools, getActiveToolNames: () => tools.map(({ name }) => name), setActiveToolsByName: () => undefined,
			subscribe: (callback) => { listener = callback; return () => undefined; },
			prompt: async () => {
				const id = "turn-end-replay:1";
				const assistantMessage = { role: "assistant", responseId: "response:turn-end-replay", content: [{ type: "toolCall", id, name: verifiedLookup.name, arguments: {} }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
				listener({ type: "message_end", message: assistantMessage });
				listener({ type: "tool_execution_start", toolCallId: id, toolName: verifiedLookup.name, args: {} });
				const boundary = await agent.beforeToolCall?.({ toolCall: { id, name: verifiedLookup.name, arguments: {} }, args: {}, context: {} }, new AbortController().signal);
				assert.notEqual(boundary?.block, true, boundary?.reason);
				listener({ type: "turn_end", message: assistantMessage, toolResults: [] });
				listener({ type: "tool_execution_end", toolCallId: id, toolName: verifiedLookup.name, isError: false, result: { content: [{ type: "text", text: "replayed evidence" }] } });
				emitAssistantText(listener, "done", "response:turn-end-replay-result");
			},
			abort: async () => undefined, dispose: () => undefined,
		}),
	});
	try {
		await assert.rejects(runtime.run({ source: source("turn-end-replay"), text: rawRequest, timeoutMs: 1_000 }), /unbound execution result/i);
		assert.equal(verifications, 0);
	} finally { runtime.dispose(); }
});

function createObjectiveRuntime({ rawRequest, capabilityRequirements, tools, verify, createSession }) {
	const tasks = new Map(); const runs = new Map();
	const quote = (text) => ({ text, source: { kind: "raw_request", start: rawRequest.indexOf(text), end: rawRequest.indexOf(text) + text.length } });
	const ledger = {
		record(task) { tasks.set(task.id, { ...task }); },
		transition(id, change) { const task = tasks.get(id); if (!task) return false; tasks.set(id, { ...task, ...change }); return true; },
		recordRun(run) { runs.set(run.id, { ...run }); },
		transitionRun(id, change) { const run = runs.get(id); if (!run) return false; runs.set(id, { ...run, ...change }); return true; },
		queryTasks(query) { return [...tasks.values()].filter((task) => query.ownerKeys.includes(task.ownerKey) && (!query.id || query.id === task.id)); },
		isTaskRunExecutionActive(ownerKey, objectiveId, taskId, taskRunId) {
			const task = tasks.get(taskId); const run = runs.get(taskRunId);
			return task?.ownerKey === ownerKey && task?.id === objectiveId && taskId === objectiveId && task?.status === "running"
				&& run?.taskId === taskId && run?.status === "running";
		},
		settleDirectObjectiveCompletion(settlement) {
			const task = tasks.get(settlement.objectiveId); const run = runs.get(settlement.taskRunId);
			if (!task || task.ownerKey !== settlement.ownerKey || task.status !== "running" || !run || run.taskId !== task.id || run.status !== "running") return false;
			tasks.set(task.id, { ...task, candidateResult: settlement.candidateResult, evidence: settlement.evidence, verificationStatus: "accepted", criterionVerifications: settlement.criterionVerifications });
			runs.set(run.id, { ...run, status: "succeeded", finishedAt: Date.now(), output: settlement.candidateResult });
			return true;
		},
	};
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = new ThruveraAgentRuntime({
		profileId: "profile:capability-obligation-regression",
		interactiveAdmission: "contract_first",
		taskLedger: ledger,
		turnUnderstanding: { understand: () => ({ action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], uncertainties: [], memoryQuery: rawRequest, capabilityQuery: rawRequest, executionMode: "direct", confidence: 1 }) },
		workContractBuilder: { build: async () => ({ source: "model", cognitionBudgetChargeTokens: 1, semanticAdjudication: semanticReview, contract: {
			schemaVersion: "beemax.work-contract.v1", rawRequest, action: "create", objective: quote(rawRequest), constraints: [], prohibitions: [], acceptanceCriteria: [quote(rawRequest)], capabilityRequirements: capabilityRequirements.map(quote), uncertainties: [], executionMode: "direct", confidence: 1,
		} }) },
		verifyObjectiveCandidate: verify,
		createAgent: async () => createSession(agent),
	});
	return { runtime, tasks, runs, tools };
}

async function emitSuccessfulTool(agent, listener, name, id, result) {
	listener({ type: "message_end", message: { role: "assistant", responseId: `response:${id}`, content: [{ type: "toolCall", id, name, arguments: {} }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
	listener({ type: "tool_execution_start", toolCallId: id, toolName: name, args: {} });
	const boundary = await agent.beforeToolCall?.({ toolCall: { id, name, arguments: {} }, args: {}, context: {} }, new AbortController().signal);
	assert.notEqual(boundary?.block, true, boundary?.reason);
	listener({ type: "tool_execution_end", toolCallId: id, toolName: name, isError: false, result });
}

async function emitCompletedSkill(agent, listener, name, version, id) {
	await emitSuccessfulTool(agent, listener, "skill_read", `${id}:read`, { details: { skillLifecycleReceipt: { id: `receipt:${id}:read`, name, version, phase: "read", sourceTool: "skill_read" } } });
	await emitSuccessfulTool(agent, listener, "skill_complete", `${id}:complete`, { details: {
		skillLifecycleReceipt: { id: `receipt:${id}:complete`, name, version, phase: "completed", sourceTool: "skill_complete" },
		capabilityReceipt: { id: `receipt:${id}:capability`, kind: "skill", name, version, sourceTool: "skill_complete" },
	} });
}

function emitAssistantText(listener, text, responseId) {
	listener({ type: "message_end", message: { role: "assistant", responseId, content: [{ type: "text", text }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
}

function source(id) { return { platform: "cli", chatId: `capability-obligation-${id}`, chatType: "dm", userId: "local" }; }
