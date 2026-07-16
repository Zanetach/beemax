import assert from "node:assert/strict";
import test from "node:test";

const semanticReview = Object.freeze({ schemaVersion: "beemax.work-contract-adjudication.v1", inventorySchemaVersion: "beemax.semantic-inventory.v1", primaryModelIdentity: "test/primary/test", reviewerModelIdentity: "test/reviewer/test", reviewMode: "different_models", independentSamples: true, cognitionUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, modelIdentities: ["test/primary/test", "test/reviewer/test"] }, cognitionBudgetChargeTokens: 1 });
import { AutonomousPlanningPolicy, BeeMaxAgentRuntime, conversationKey, createAccessScopeRef, createExecutionEnvelope, createWebTools, DeterministicWorkContractBuilder, PlanningBudgetRegistry } from "../dist/index.js";
import { attestCapabilityProviderAcquisitionTool, attestCapabilityProviderResolutionTool } from "../dist/capability-provider.js";

const createRuntime = (options) => new BeeMaxAgentRuntime({ profileId: "profile:test", workContractBuilder: new DeterministicWorkContractBuilder(), ...options });
const bindAssistantTurn = (listener, calls, responseId = "response:test") => listener({
	type: "message_end",
	message: {
		role: "assistant",
		responseId,
		content: calls.map(({ id, name, args = {} }) => ({ type: "toolCall", id, name, arguments: args })),
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	},
});
const admitToolCalls = async (agent, listener, calls, responseId) => {
	bindAssistantTurn(listener, calls, responseId);
	for (const { id, name, args = {} } of calls) {
		listener({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
		const blocked = await agent.beforeToolCall({
			assistantMessage: { role: "assistant", responseId },
			toolCall: { id, name, arguments: args },
			args,
			context: {},
		}, new AbortController().signal);
		assert.equal(blocked, undefined, `expected ${name} (${id}) to pass the Tool boundary`);
	}
};
const dispatchToolCall = async (agent, listener, { id, name, args = {}, result = {}, isError = false }, responseId = `response:${id}`) => {
	await admitToolCalls(agent, listener, [{ id, name, args }], responseId);
	listener({ type: "tool_execution_end", toolCallId: id, toolName: name, result, isError });
};

const settleDirectObjectiveCompletion = (tasks, runs, completions, settlement) => {
	const objective = tasks.get(settlement.objectiveId);
	const run = runs.get(settlement.taskRunId);
	if (!objective || objective.ownerKey !== settlement.ownerKey || objective.status !== "running" || !run || run.taskId !== objective.id || run.status !== "running") return false;
	tasks.set(objective.id, {
		...objective,
		candidateResult: settlement.candidateResult,
		evidence: settlement.evidence,
		verificationStatus: "accepted",
		criterionVerifications: settlement.criterionVerifications,
		correctiveAttempts: settlement.correctiveAttempts,
	});
	runs.set(run.id, { ...run, status: "succeeded", finishedAt: Date.now(), output: settlement.candidateResult });
	completions?.push({ ownerKey: settlement.ownerKey, id: settlement.objectiveId });
	return true;
};

test("planning policy keeps simple conversational requests direct", () => {
	const policy = new AutonomousPlanningPolicy({ maxConcurrent: 8 });
	const decision = policy.decide("What model are you using?");
	assert.equal(decision.mode, "direct");
	assert.equal(decision.requiredTool, undefined);
	assert.deepEqual(decision.requiredTools, []);
	assert.equal(decision.suggestedConcurrency, 1);
	assert.equal(decision.budget.maxSubagents, 0);
	assert.equal(decision.budget.maxToolCalls, 8);
	assert.equal(decision.budget.maxTokens, 12_000);
	assert.match(decision.reason, /simple|single/i);
});

test("Agent runtime progressively exposes discovery and restores the full catalog after a turn", async () => {
	const source = { platform: "cli", chatId: "fast", chatType: "dm", userId: "local" };
	const toolChanges = [];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const tools = [{ name: "capability_discover", description: "Discover capabilities" }, { name: "read", description: "Read files" }, { name: "web_search", description: "Search current web evidence" }];
	const piSession = {
		agent,
		getAllTools: () => tools,
		getActiveToolNames: () => ["read", "web_search"],
		setActiveToolsByName: (names) => { toolChanges.push([...names]); },
		subscribe: () => () => undefined,
		prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "你好" }], usage: { input: 1, output: 1 } }]; },
		abort: async () => undefined,
		dispose: () => undefined,
	};
	const runtime = createRuntime({ planningPolicy: new AutonomousPlanningPolicy(), createAgent: async () => piSession });
	await runtime.run({ source, text: "查一下今天的天气", timeoutMs: 1_000 });
	assert.deepEqual(toolChanges, [["capability_discover"], ["read", "web_search"]]);
	runtime.dispose();
});

test("Agent runtime hides capability discovery and Tools for a direct answer with no capability requirement", async () => {
	const source = { platform: "cli", chatId: "tool-free", chatType: "dm", userId: "local" };
	const toolChanges = [];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	let prefetchCalls = 0;
	const tools = [{ name: "capability_discover", description: "Discover capabilities", beemaxCapabilityPrefetch: async () => { prefetchCalls++; return { candidates: [], skills: [] }; } }, { name: "memory_recall", description: "Recall prior context" }, { name: "write", description: "Write a file" }];
	const runtime = createRuntime({ planningPolicy: new AutonomousPlanningPolicy(), createAgent: async () => ({
		agent,
		getAllTools: () => tools,
		getActiveToolNames: () => tools.map(({ name }) => name),
		setActiveToolsByName: (names) => { toolChanges.push([...names]); },
		subscribe: () => () => undefined,
		prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "direct answer" }], usage: { input: 1, output: 1 } }]; },
		abort: async () => undefined, dispose: () => undefined,
	}) });
	await runtime.run({ source, text: "用两句话解释 Capability Routing，并给出一个例子", timeoutMs: 1_000 });
	assert.deepEqual(toolChanges, [[], tools.map(({ name }) => name)]);
	assert.equal(prefetchCalls, 0);
	runtime.dispose();
});

test("Agent runtime applies one semantic Tool/MCP/Skill proposal while Pi retains activation authority", async () => {
	const source = { platform: "cli", chatId: "semantic-mcp", chatType: "dm", userId: "local" };
	const toolChanges = [];
	const traceEvents = [];
	let prefetchCalls = 0;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const tools = [
		{ name: "capability_discover", description: "Discover capabilities", beemaxCapabilityPrefetch: async () => { prefetchCalls++; return { cognitionId: "cap:semantic-mcp", candidates: [{ kind: "mcp", name: "calendar_lookup", confidence: 0.96 }], skills: [] }; } },
		{ name: "calendar_lookup", description: "Temporal availability coordination", beemaxToolSpec: { kind: "mcp" } },
	];
	const runtime = createRuntime({ executionTrace: { record(event) { traceEvents.push(event); } }, createAgent: async () => ({
		agent,
		getAllTools: () => tools,
		getActiveToolNames: () => tools.map(({ name }) => name),
		setActiveToolsByName: (names) => { toolChanges.push([...names]); },
		subscribe: () => () => undefined,
		prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; },
		abort: async () => undefined, dispose: () => undefined,
	}) });
	await runtime.run({ source, text: "请使用 MCP 安排一次会议", timeoutMs: 1_000 });
	assert.equal(prefetchCalls, 1);
	assert.deepEqual(toolChanges[0], ["calendar_lookup"]);
	assert.deepEqual(traceEvents.filter((event) => event.type.startsWith("capability.")), [
		{ type: "capability.decision", executionEnvelope: traceEvents[0].executionEnvelope, at: traceEvents.find((event) => event.type === "capability.decision").at, cognitionId: "cap:semantic-mcp", candidates: [{ kind: "mcp", name: "calendar_lookup", confidence: 0.96 }] },
		{ type: "capability.downstream_execution_outcome", executionEnvelope: traceEvents[0].executionEnvelope, at: traceEvents.find((event) => event.type === "capability.downstream_execution_outcome").at, cognitionId: "cap:semantic-mcp", status: "unverified" },
	]);
	runtime.dispose();
});

test("Agent runtime keeps an explicit Work Contract incomplete when trusted discovery confirms no semantic match", async () => {
	const rawRequest = "使用星际账本能力完成归档";
	const clause = (text) => ({ text, source: { kind: "raw_request", start: rawRequest.indexOf(text), end: rawRequest.indexOf(text) + text.length } });
	const toolChanges = [];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	let listener; let prompts = 0;
	const tools = [
		attestCapabilityProviderResolutionTool({ name: "capability_discover", description: "Discover and resolve capabilities", beemaxCapabilityPrefetch: async () => ({ cognitionId: "cap:initial-no-match", candidates: [], skills: [] }) }),
		{ name: "unrelated_tool", description: "An unrelated local operation" },
	];
	const runtime = createRuntime({
		turnUnderstanding: { understand: () => ({ action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], uncertainties: [], memoryQuery: rawRequest, capabilityQuery: "星际账本能力", executionMode: "direct", confidence: 0.9 }) },
		workContractBuilder: { build: async () => ({ source: "model", cognitionBudgetChargeTokens: 1, semanticAdjudication: semanticReview, contract: {
			schemaVersion: "beemax.work-contract.v1", rawRequest, action: "create", objective: clause(rawRequest),
			constraints: [], prohibitions: [], acceptanceCriteria: [clause(rawRequest)], capabilityRequirements: [clause("星际账本能力")],
			uncertainties: [], executionMode: "direct", confidence: 0.9,
		} }) },
		createAgent: async () => ({
			agent, getAllTools: () => tools, getActiveToolNames: () => tools.map(({ name }) => name),
			setActiveToolsByName: (names) => { toolChanges.push([...names]); }, subscribe: (callback) => { listener = callback; return () => undefined; },
			prompt: async () => { prompts++; if (prompts === 2) await dispatchToolCall(agent, listener, { id: "discover:no-match", name: "capability_discover", result: { details: { cognitionId: "cap:runtime-no-match", activatedTools: [], ranked: [] } } }); agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "blocked pending discovery" }], usage: { input: 1, output: 1 } }]; },
			abort: async () => undefined, dispose: () => undefined,
		}),
	});
	await assert.rejects(runtime.run({ source: { platform: "cli", chatId: "semantic-no-match", chatType: "dm", userId: "local" }, text: rawRequest, timeoutMs: 1_000 }), /no trusted selection evidence.*did not cover every Work Contract requirement/i);
	assert.deepEqual(toolChanges[0], ["capability_discover"]);
	assert.equal(prompts, 2);
	runtime.dispose();
});

test("Capability prefetch failure cannot reach Verification when Pi skips required discovery", async () => {
	const rawRequest = "使用玄鸟实时资料源生成结果";
	const clause = { text: rawRequest, source: { kind: "raw_request", start: 0, end: rawRequest.length } };
	let prompts = 0; let verifications = 0; let preflights = 0;
	const tasks = new Map(); const runs = new Map();
	const ledger = {
		record(task) { tasks.set(task.id, { ...task }); }, transition(id, change) { tasks.set(id, { ...tasks.get(id), ...change }); return true; },
		recordRun(run) { runs.set(run.id, { ...run }); }, transitionRun(id, change) { runs.set(id, { ...runs.get(id), ...change }); return true; },
		queryTasks: (query) => [...tasks.values()].filter((task) => query.ownerKeys.includes(task.ownerKey) && (!query.id || query.id === task.id)),
		settleDirectObjectiveCompletion(settlement) { return settleDirectObjectiveCompletion(tasks, runs, undefined, settlement); },
	};
	const capabilityDiscover = attestCapabilityProviderResolutionTool({ name: "capability_discover", description: "Discover capabilities", beemaxCapabilityPrefetch: async () => { preflights++; throw new Error("semantic Provider unavailable"); } });
	const runtime = createRuntime({
		taskLedger: ledger,
		turnUnderstanding: { understand: () => ({ action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], uncertainties: [], memoryQuery: rawRequest, capabilityQuery: "玄鸟实时资料源", executionMode: "direct", confidence: 1 }) },
		workContractBuilder: { build: async () => ({ source: "model", cognitionBudgetChargeTokens: 1, semanticAdjudication: semanticReview, contract: { schemaVersion: "beemax.work-contract.v1", rawRequest, action: "create", objective: clause, constraints: [], prohibitions: [], acceptanceCriteria: [clause], capabilityRequirements: [clause], uncertainties: [], executionMode: "direct", confidence: 1 } }) },
		verifyObjectiveCandidate: async () => { verifications++; return { accepted: true, evidence: "must never be consulted" }; },
		createAgent: async () => ({ agent: { state: { model: { id: "test" }, messages: [] } }, getAllTools: () => [capabilityDiscover], getActiveToolNames: () => ["capability_discover"], setActiveToolsByName: () => undefined, subscribe: () => () => undefined,
			prompt: async () => { prompts++; }, abort: async () => undefined, dispose: () => undefined }),
	});
	await assert.rejects(runtime.run({ source: { platform: "cli", chatId: "prefetch-fail-closed", chatType: "dm", userId: "local" }, text: rawRequest, timeoutMs: 1_000 }), /required Capability resolution produced no trusted selection evidence/i);
	assert.equal(prompts, 2, "BeeMax gives Pi one bounded correction Turn to perform required discovery");
	assert.equal(preflights, 2, "BeeMax retries the same Contract-bound preflight once after observable discovery recovery");
	assert.equal(verifications, 0, "a prose candidate cannot bypass unresolved Capability admission");
	assert.notEqual([...tasks.values()][0]?.status, "succeeded");
	assert.notEqual([...runs.values()][0]?.status, "succeeded");
	runtime.dispose();
});

test("a transient preflight outage recovers through one Contract-bound retry before execution and Verification", async () => {
	const rawRequest = "使用恢复后的实时资料源生成结果";
	const clause = { text: rawRequest, source: { kind: "raw_request", start: 0, end: rawRequest.length } };
	let listener; let prompts = 0; let preflights = 0; let verifications = 0;
	const tasks = new Map(); const runs = new Map();
	const ledger = {
		record(task) { tasks.set(task.id, { ...task }); }, transition(id, change) { tasks.set(id, { ...tasks.get(id), ...change }); return true; },
		recordRun(run) { runs.set(run.id, { ...run }); }, transitionRun(id, change) { runs.set(id, { ...runs.get(id), ...change }); return true; },
		queryTasks: (query) => [...tasks.values()].filter((task) => query.ownerKeys.includes(task.ownerKey) && (!query.id || query.id === task.id)),
		isTaskRunExecutionActive: (_ownerKey, objectiveId, taskId, runId) => objectiveId === taskId && tasks.get(objectiveId)?.status === "running" && runs.get(runId)?.status === "running",
		settleDirectObjectiveCompletion(settlement) { return settleDirectObjectiveCompletion(tasks, runs, undefined, settlement); },
	};
	const recoveredTool = { name: "recovered_source", description: "Fetch current recovered evidence", beemaxPolicy: { sideEffect: "none" } };
	const capabilityDiscover = attestCapabilityProviderResolutionTool({
		name: "capability_discover", description: "Discover capabilities", beemaxPolicy: { sideEffect: "none" },
		beemaxCapabilityPrefetch: async (_query, _signal, options) => {
			preflights++;
			if (preflights === 1) throw new Error("temporary semantic Provider outage");
			return { cognitionId: "cap:contract-recovery", candidates: [{ kind: "tool", name: recoveredTool.name, confidence: 0.99, requirementId: options.requirements[0].id, outcomeIndex: 0, necessity: "required" }], activatedTools: [recoveredTool.name], skills: [] };
		},
	});
	const tools = [capabilityDiscover, recoveredTool];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({
		taskLedger: ledger,
		turnUnderstanding: { understand: () => ({ action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], uncertainties: [], memoryQuery: rawRequest, capabilityQuery: rawRequest, executionMode: "direct", confidence: 1 }) },
		workContractBuilder: { build: async () => ({ source: "model", cognitionBudgetChargeTokens: 1, semanticAdjudication: semanticReview, contract: { schemaVersion: "beemax.work-contract.v1", rawRequest, action: "create", objective: clause, constraints: [], prohibitions: [], acceptanceCriteria: [clause], capabilityRequirements: [clause], uncertainties: [], executionMode: "direct", confidence: 1 } }) },
		verifyObjectiveCandidate: async () => { verifications++; return { accepted: true, evidence: "recovered source receipt" }; },
		createAgent: async () => ({
			agent, getAllTools: () => tools, getActiveToolNames: () => tools.map(({ name }) => name), setActiveToolsByName: () => undefined,
			subscribe: (callback) => { listener = callback; return () => undefined; },
			prompt: async () => {
				prompts++;
				if (prompts === 2) await dispatchToolCall(agent, listener, { id: "discover:transient", name: capabilityDiscover.name, result: { details: { cognitionId: "cap:unbound-runtime-observation", activatedTools: [], ranked: [] } } });
				if (prompts === 3) {
					await dispatchToolCall(agent, listener, { id: "source:recovered", name: recoveredTool.name, result: { content: [{ type: "text", text: "current evidence" }] } });
					listener({ type: "message_end", message: { role: "assistant", responseId: "response:recovered-result", content: [{ type: "text", text: "verified recovered result" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
				}
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: prompts === 3 ? "verified recovered result" : "waiting" }], usage: { input: 1, output: 1 } }];
			},
			abort: async () => undefined, dispose: () => undefined,
		}),
	});
	const result = await runtime.run({ source: { platform: "cli", chatId: "contract-recovery", chatType: "dm", userId: "local" }, text: rawRequest, timeoutMs: 1_000 });
	assert.equal(result.answer, "verified recovered result");
	assert.equal(preflights, 2);
	assert.equal(prompts, 3);
	assert.equal(verifications, 1);
	runtime.dispose();
});

test("two distinct Work Contract Capability requirements cannot reach Verification after only one selected Tool executes", async () => {
	const rawRequest = "查询实时来源，并把结果写入归档";
	const quote = (text) => ({ text, source: { kind: "raw_request", start: rawRequest.indexOf(text), end: rawRequest.indexOf(text) + text.length } });
	const tasks = new Map(); const runs = new Map();
	let listener; let prompts = 0; let verifications = 0;
	const ledger = {
		record(task) { tasks.set(task.id, { ...task }); }, transition(id, change) { tasks.set(id, { ...tasks.get(id), ...change }); return true; },
		recordRun(run) { runs.set(run.id, { ...run }); }, transitionRun(id, change) { runs.set(id, { ...runs.get(id), ...change }); return true; },
		queryTasks: (query) => [...tasks.values()].filter((task) => query.ownerKeys.includes(task.ownerKey) && (!query.id || query.id === task.id)),
		settleDirectObjectiveCompletion(settlement) { return settleDirectObjectiveCompletion(tasks, runs, undefined, settlement); },
	};
	const tools = [
		attestCapabilityProviderResolutionTool({
			name: "capability_discover", description: "Resolve required capabilities",
			beemaxCapabilityPrefetch: async (_query, _signal, options) => ({
				cognitionId: "cap:two-distinct-requirements",
			candidates: [
					{ kind: "tool", name: "source_lookup", confidence: 0.99, requirementId: options.requirements[0].id, outcomeIndex: 0, necessity: "required" },
					{ kind: "tool", name: "archive_write", confidence: 0.98, requirementId: options.requirements[1].id, outcomeIndex: 0, necessity: "required" },
				],
				activatedTools: ["source_lookup", "archive_write"], skills: [],
			}),
		}),
		{ name: "source_lookup", description: "Read current source evidence", beemaxPolicy: { sideEffect: "none" } },
		{ name: "archive_write", description: "Write a result to the archive", beemaxPolicy: { sideEffect: "local" } },
	];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({
		taskLedger: ledger,
		turnUnderstanding: { understand: () => ({ action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], uncertainties: [], memoryQuery: rawRequest, capabilityQuery: rawRequest, executionMode: "direct", confidence: 1 }) },
		workContractBuilder: { build: async () => ({ source: "model", cognitionBudgetChargeTokens: 1, semanticAdjudication: semanticReview, contract: {
			schemaVersion: "beemax.work-contract.v1", rawRequest, action: "create", objective: quote(rawRequest), constraints: [], prohibitions: [], acceptanceCriteria: [quote(rawRequest)],
			capabilityRequirements: [quote("查询实时来源"), quote("把结果写入归档")], uncertainties: [], executionMode: "direct", confidence: 1,
		} }) },
		verifyObjectiveCandidate: async () => { verifications++; return { accepted: true, evidence: "must not verify a partial capability outcome" }; },
		createAgent: async () => ({
			agent, getAllTools: () => tools, getActiveToolNames: () => tools.map(({ name }) => name), setActiveToolsByName: () => undefined,
			subscribe: (callback) => { listener = callback; return () => undefined; },
			prompt: async () => {
				prompts++;
				if (prompts === 1) {
					await admitToolCalls(agent, listener, [{ id: "lookup:only", name: "source_lookup" }], "response:partial-capability");
					listener({ type: "tool_execution_end", toolCallId: "lookup:only", toolName: "source_lookup", isError: false, result: { content: [{ type: "text", text: "fresh evidence" }] } });
				}
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "partial result" }], usage: { input: 1, output: 1 } }];
			},
			abort: async () => undefined, dispose: () => undefined,
		}),
	});
	await assert.rejects(
		runtime.run({ source: { platform: "cli", chatId: "two-required-tools", chatType: "dm", userId: "local" }, text: rawRequest, timeoutMs: 1_000 }),
		/selected required Capabilities did not execute successfully|required Capability/i,
	);
	assert.equal(verifications, 0, "partial Capability execution must not enter independent Verification");
	assert.notEqual([...tasks.values()][0]?.verificationStatus, "accepted");
	runtime.dispose();
});

test("an allowedCapabilities execution grant remains an authority ceiling while trusted preflight selects within it", async () => {
	const rawRequest = "使用受限本地读取能力返回文件内容";
	const requirement = "受限本地读取能力";
	const quote = (text) => ({ text, source: { kind: "raw_request", start: rawRequest.indexOf(text), end: rawRequest.indexOf(text) + text.length } });
	const tasks = new Map(); const runs = new Map();
	let listener; let verifications = 0; let preflights = 0;
	const ledger = {
		record(task) { tasks.set(task.id, { ...task }); }, transition(id, change) { tasks.set(id, { ...tasks.get(id), ...change }); return true; },
		recordRun(run) { runs.set(run.id, { ...run }); }, transitionRun(id, change) { runs.set(id, { ...runs.get(id), ...change }); return true; },
		queryTasks: (query) => [...tasks.values()].filter((task) => query.ownerKeys.includes(task.ownerKey) && (!query.id || query.id === task.id)),
		settleDirectObjectiveCompletion(settlement) { return settleDirectObjectiveCompletion(tasks, runs, undefined, settlement); },
	};
	const localRead = { name: "local_read", description: "Read one local file", beemaxPolicy: { sideEffect: "none" } };
	const capabilityDiscover = attestCapabilityProviderResolutionTool({
		name: "capability_discover", description: "Resolve required capabilities",
		beemaxCapabilityPrefetch: async (_query, _signal, options) => { preflights++; return { cognitionId: "cap:allowlisted-read", candidates: [{ kind: "tool", name: localRead.name, confidence: 0.99, requirementId: options.requirements[0].id, outcomeIndex: 0, necessity: "required" }], activatedTools: [localRead.name], skills: [] }; },
	});
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({
		taskLedger: ledger,
		turnUnderstanding: { understand: () => ({ action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], uncertainties: [], memoryQuery: rawRequest, capabilityQuery: requirement, executionMode: "direct", confidence: 1 }) },
		workContractBuilder: { build: async () => ({ source: "model", cognitionBudgetChargeTokens: 1, semanticAdjudication: semanticReview, contract: {
			schemaVersion: "beemax.work-contract.v1", rawRequest, action: "create", objective: quote(rawRequest), constraints: [], prohibitions: [], acceptanceCriteria: [quote(rawRequest)], capabilityRequirements: [quote(requirement)], uncertainties: [], executionMode: "direct", confidence: 1,
		} }) },
		verifyObjectiveCandidate: async () => { verifications++; return { accepted: true, evidence: "allowlisted read receipt" }; },
		createAgent: async () => ({
			agent, getAllTools: () => [capabilityDiscover, localRead], getActiveToolNames: () => [capabilityDiscover.name, localRead.name], setActiveToolsByName: () => undefined,
			subscribe: (callback) => { listener = callback; return () => undefined; },
			prompt: async () => {
				await admitToolCalls(agent, listener, [{ id: "allowlisted:read", name: localRead.name }], "response:allowlisted-read");
				listener({ type: "tool_execution_end", toolCallId: "allowlisted:read", toolName: localRead.name, isError: false, result: { content: [{ type: "text", text: "file contents" }] } });
				listener({ type: "message_end", message: { role: "assistant", responseId: "response:allowlisted-result", content: [{ type: "text", text: "file contents" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "file contents" }], usage: { input: 1, output: 1 } }];
			},
			abort: async () => undefined, dispose: () => undefined,
		}),
	});
	const result = await runtime.run({
		source: { platform: "cli", chatId: "allowlisted-capability", chatType: "dm", userId: "local" },
		text: rawRequest, timeoutMs: 1_000, allowedCapabilities: [localRead.name],
	});
	assert.equal(result.answer, "file contents");
	assert.equal(preflights, 1, "the allowlist alone is not semantic selection evidence");
	assert.equal(verifications, 1);
	assert.equal([...tasks.values()][0]?.verificationStatus, "accepted");
	runtime.dispose();
});

test("Agent runtime preserves a semantic no-match when only outcome verification is required", async () => {
	const rawRequest = "不要回顾以前的聊天记录，只回答本次请求未调用记忆";
	const quote = (text) => ({ text, source: { kind: "raw_request", start: rawRequest.indexOf(text), end: rawRequest.indexOf(text) + text.length } });
	const toolChanges = [];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const tools = [{ name: "capability_discover", description: "Discover capabilities", beemaxCapabilityPrefetch: async () => ({ candidates: [], skills: [] }) }];
	const runtime = createRuntime({
		planningPolicy: { decide: () => ({ mode: "direct", requiredTools: [], suggestedConcurrency: 1, budget: { maxSubagents: 0, maxToolCalls: 4, maxTokens: 2_000, maxCorrectiveAttempts: 0 }, signals: { substantialWork: true, requiresVerification: true }, reason: "verify the outcome", directive: () => "Complete and verify the request." }) },
		turnUnderstanding: { understand: () => ({ action: "create", goal: "只回答本次请求未调用记忆", constraints: ["不要回顾以前的聊天记录"], acceptanceCriteria: ["只回答本次请求未调用记忆"], uncertainties: [], memoryQuery: rawRequest, capabilityQuery: rawRequest, executionMode: "direct", confidence: 1 }) },
		workContractBuilder: { build: async () => ({ source: "model", cognitionBudgetChargeTokens: 1, semanticAdjudication: semanticReview, contract: { schemaVersion: "beemax.work-contract.v1", rawRequest, action: "create", objective: quote("只回答本次请求未调用记忆"), constraints: [], prohibitions: [quote("不要回顾以前的聊天记录")], acceptanceCriteria: [quote("只回答本次请求未调用记忆")], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 1 } }) },
		createAgent: async () => ({
			agent, getAllTools: () => tools, getActiveToolNames: () => tools.map(({ name }) => name), setActiveToolsByName: (names) => { toolChanges.push([...names]); }, subscribe: () => () => undefined,
			prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "本次请求未调用记忆" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined,
		}),
	});
	await runtime.run({ source: { platform: "cli", chatId: "verification-no-match", chatType: "dm", userId: "local" }, text: rawRequest, timeoutMs: 1_000 });
	assert.deepEqual(toolChanges[0], []);
	runtime.dispose();
});

test("Agent runtime directly prefetches an explicit Tool request with a calibrated name match", async () => {
	const source = { platform: "cli", chatId: "explicit-tool", chatType: "dm", userId: "local" };
	const toolChanges = [];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const tools = [
		{ name: "capability_discover", description: "Discover capabilities" },
		{ name: "mcp_fixture_structured_lookup", description: "Lookup a fixture entity with selected fields" },
	];
	const runtime = createRuntime({ planningPolicy: new AutonomousPlanningPolicy(), createAgent: async () => ({
		agent,
		getAllTools: () => tools,
		getActiveToolNames: () => tools.map(({ name }) => name),
		setActiveToolsByName: (names) => { toolChanges.push([...names]); },
		subscribe: () => () => undefined,
		prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "blocked until discovery" }], usage: { input: 1, output: 1 } }]; },
		abort: async () => undefined, dispose: () => undefined,
	}) });
	await runtime.run({ source, text: "调用 fixture structured lookup Tool：entityId 必须为 fixture-42", timeoutMs: 1_000 });
	assert.deepEqual(toolChanges[0], ["mcp_fixture_structured_lookup"]);
	runtime.dispose();
});

test("Agent runtime directly prefetches a high-confidence current research Provider", async () => {
	const source = { platform: "cli", chatId: "prefetched-research", chatType: "dm", userId: "local" };
	const tools = [{ name: "capability_discover", description: "Discover capabilities" }, ...createWebTools({ agentReachAvailable: true })];
	const toolChanges = [];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({ planningPolicy: new AutonomousPlanningPolicy(), createAgent: async () => ({
		agent,
		getAllTools: () => tools,
		getActiveToolNames: () => tools.map(({ name }) => name),
		setActiveToolsByName: (names) => { toolChanges.push([...names]); },
		subscribe: () => () => undefined,
		prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; },
		abort: async () => undefined, dispose: () => undefined,
	}) });
	await runtime.run({ source, text: "截至今天，研究公开发布的 Agent 工具调用趋势，至少实时核验两个来源", timeoutMs: 1_000 });
	assert.deepEqual(toolChanges[0], ["exa_web_search"]);
	runtime.dispose();
});

test("Agent runtime deterministically preflights and enforces an installed matching Skill before execution", async () => {
	const source = { platform: "cli", chatId: "skill-preflight", chatType: "dm", userId: "local" };
	const prompts = [];
	const toolChanges = [];
	let prefetchSignal;
	let listener;
	const version = `sha256:${"a".repeat(64)}`;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const capabilityDiscover = {
		name: "capability_discover",
		description: "Discover capabilities",
		beemaxCapabilityPrefetch: async (_query, signal) => { prefetchSignal = signal; return { cognitionId: "cap:research-brief", candidates: [{ kind: "skill", name: "research-brief", version, confidence: 0.96 }], activatedTools: ["skill_activate", "skill_read"], skills: [{ name: "research-brief" }] }; },
	};
	const piSession = {
		agent,
		getActiveToolNames: () => ["capability_discover", "skill_activate", "skill_read", "skill_complete"],
		getAllTools: () => [capabilityDiscover, { name: "skill_activate", description: "Activate Skill" }, { name: "skill_read", description: "Read Skill" }, { name: "skill_complete", description: "Complete Skill" }],
		setActiveToolsByName: (names) => { toolChanges.push([...names]); },
		subscribe: (next) => { listener = next; return () => undefined; },
		prompt: async (text) => {
			prompts.push(text);
			if (prompts.length === 2) {
				await dispatchToolCall(agent, listener, { id: "skill", name: "skill_read", result: { details: { descriptor: { name: "research-brief" }, state: { skill: "research-brief" }, skillLifecycleReceipt: { id: "receipt:read", name: "research-brief", version, phase: "read", sourceTool: "skill_read" } } } });
				await dispatchToolCall(agent, listener, { id: "skill-complete", name: "skill_complete", result: { details: { skill: "research-brief", skillLifecycleReceipt: { id: "receipt:complete", name: "research-brief", version, phase: "completed", sourceTool: "skill_complete" }, capabilityReceipt: { id: "receipt:skill", kind: "skill", name: "research-brief", version, sourceTool: "skill_complete" } } } });
			}
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }];
		},
		abort: async () => undefined,
		dispose: () => undefined,
	};
	const runtime = createRuntime({
		planningPolicy: { decide: () => ({ mode: "direct", requiredTools: [], suggestedConcurrency: 1, budget: { maxSubagents: 0, maxToolCalls: 4, maxTokens: 2_000, maxCorrectiveAttempts: 0 }, signals: { substantialWork: true, requiresVerification: true }, reason: "verify the outcome", directive: () => "Complete and verify the request." }) },
		createAgent: async () => piSession,
	});
	await runtime.run({ source, text: "核验一份研究简报并保留真实来源证据", timeoutMs: 1_000 });
	assert.match(prompts[0], /Installed matching Skill metadata: research-brief/);
	assert.match(prompts[1], /Skill correction/);
	assert.deepEqual(toolChanges[0], ["skill_read", "skill_activate", "skill_complete"]);
	assert.equal(prefetchSignal instanceof AbortSignal, true);
	runtime.dispose();
});

test("Agent runtime refuses to complete a selected Skill from name-only results without lifecycle receipts", async () => {
	const source = { platform: "cli", chatId: "skill-receipt-required", chatType: "dm", userId: "local" };
	let listener;
	let prompts = 0;
	const version = `sha256:${"b".repeat(64)}`;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const capabilityDiscover = {
		name: "capability_discover", description: "Discover capabilities",
		beemaxCapabilityPrefetch: async () => ({ cognitionId: "cap:receipt-required", candidates: [{ kind: "skill", name: "receipt-review", version, confidence: 0.97 }], activatedTools: ["skill_read"], skills: [{ name: "receipt-review" }] }),
	};
	const tools = [capabilityDiscover, { name: "skill_read", description: "Read Skill" }, { name: "skill_complete", description: "Complete Skill" }];
	const runtime = createRuntime({ createAgent: async () => ({
		agent, getAllTools: () => tools, getActiveToolNames: () => tools.map(({ name }) => name), setActiveToolsByName: () => undefined,
		subscribe: (next) => { listener = next; return () => undefined; },
		prompt: async () => {
			prompts++;
			if (prompts === 2) {
				await dispatchToolCall(agent, listener, { id: "read", name: "skill_read", result: { details: { skill: "receipt-review" } } });
				await dispatchToolCall(agent, listener, { id: "complete", name: "skill_complete", result: { details: { skill: "receipt-review" } } });
			}
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }];
		}, abort: async () => undefined, dispose: () => undefined,
	}) });
	await assert.rejects(runtime.run({ source, text: "Use the receipt review Skill", timeoutMs: 1_000 }), /lifecycle receipt|did not complete/i);
	runtime.dispose();
});

test("runtime-discovered Skills enter the same version-locked receipt lifecycle as prefetched Skills", async () => {
	const source = { platform: "cli", chatId: "runtime-skill-lifecycle", chatType: "dm", userId: "local" };
	let listener;
	let prompts = 0;
	const toolChanges = [];
	const version = `sha256:${"e".repeat(64)}`;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const capabilityDiscover = {
		name: "capability_discover", description: "Discover capabilities",
		beemaxCapabilityPrefetch: async () => ({ cognitionId: "cap:initial-no-match", candidates: [], activatedTools: [], skills: [] }),
	};
	const tools = [capabilityDiscover, ...["skill_activate", "skill_read", "skill_route", "skill_resource_read", "skill_complete"].map((name) => ({ name, description: name }))];
	const runtime = createRuntime({ createAgent: async () => ({
		agent, getAllTools: () => tools, getActiveToolNames: () => tools.map(({ name }) => name), setActiveToolsByName: (names) => { toolChanges.push([...names]); },
		subscribe: (next) => { listener = next; return () => undefined; },
		prompt: async () => {
			prompts++;
			if (prompts === 1) await dispatchToolCall(agent, listener, { id: "discover", name: "capability_discover", result: { details: {
				cognitionId: "cap:runtime-skill", activatedTools: ["skill_activate", "skill_read"], skills: [{ name: "runtime-review" }],
				ranked: [{ kind: "skill", name: "runtime-review", version, score: 98, confidence: 0.98, reason: "semantic capability match" }],
			} } });
			if (prompts === 2) {
				await dispatchToolCall(agent, listener, { id: "read", name: "skill_read", result: { details: { skill: "runtime-review", activatedTools: ["skill_complete"], legacy: true, declaredTools: [], skillLifecycleReceipt: { id: "receipt:runtime-read", name: "runtime-review", version, phase: "read", sourceTool: "skill_read" } } } });
				await dispatchToolCall(agent, listener, { id: "complete", name: "skill_complete", result: { details: { skill: "runtime-review", skillLifecycleReceipt: { id: "receipt:runtime-complete", name: "runtime-review", version, phase: "completed", sourceTool: "skill_complete" }, capabilityReceipt: { id: "receipt:runtime-skill", kind: "skill", name: "runtime-review", version, sourceTool: "skill_complete" } } } });
			}
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }];
		}, abort: async () => undefined, dispose: () => undefined,
	}) });
	await runtime.run({ source, text: "Find and use the runtime review Skill", timeoutMs: 1_000 });
	assert.equal(prompts, 3);
	assert.ok(toolChanges.some((names) => names.includes("skill_read") && names.includes("skill_activate")));
	runtime.dispose();
});

test("an incomplete selected Skill reports its concrete route or resource blocker without substituting another Skill", async () => {
	const source = { platform: "cli", chatId: "skill-resource-blocker", chatType: "dm", userId: "local" };
	let listener;
	let prompts = 0;
	const version = `sha256:${"f".repeat(64)}`;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const tools = [
		{ name: "capability_discover", description: "Discover capabilities", beemaxCapabilityPrefetch: async () => ({ cognitionId: "cap:missing-module", candidates: [{ kind: "skill", name: "module-review", version, confidence: 0.99 }], activatedTools: ["skill_read"], skills: [{ name: "module-review" }] }) },
		{ name: "skill_read", description: "Read Skill" }, { name: "skill_complete", description: "Complete Skill" },
	];
	const runtime = createRuntime({ createAgent: async () => ({
		agent, getAllTools: () => tools, getActiveToolNames: () => tools.map(({ name }) => name), setActiveToolsByName: () => undefined,
		subscribe: (next) => { listener = next; return () => undefined; }, prompt: async () => {
			prompts++;
			if (prompts === 1) await dispatchToolCall(agent, listener, { id: "read", name: "skill_read", isError: true, result: { content: [{ type: "text", text: "Skill referenced resource is unavailable: modules/missing-review.md" }] } });
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "blocked" }], usage: { input: 1, output: 1 } }];
		}, abort: async () => undefined, dispose: () => undefined,
	}) });
	await assert.rejects(runtime.run({ source, text: "Use Skill module-review", timeoutMs: 1_000 }), /modules\/missing-review\.md/i);
	runtime.dispose();
});

test("Agent runtime rejects a selected Skill proposal that lacks immutable version evidence", async () => {
	const source = { platform: "cli", chatId: "skill-version-required", chatType: "dm", userId: "local" };
	let prompts = 0;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const tools = [
		{ name: "capability_discover", description: "Discover capabilities", beemaxCapabilityPrefetch: async () => ({ cognitionId: "cap:versionless", candidates: [{ kind: "skill", name: "versionless-review", confidence: 0.99 }], activatedTools: ["skill_read"], skills: [{ name: "versionless-review" }] }) },
		{ name: "skill_read", description: "Read Skill" }, { name: "skill_complete", description: "Complete Skill" },
	];
	const runtime = createRuntime({ createAgent: async () => ({ agent, getAllTools: () => tools, getActiveToolNames: () => tools.map(({ name }) => name), setActiveToolsByName: () => undefined, subscribe: () => () => undefined, prompt: async () => { prompts++; }, abort: async () => undefined, dispose: () => undefined }) });
	await assert.rejects(runtime.run({ source, text: "Use Skill versionless-review", timeoutMs: 1_000 }), /immutable version/i);
	assert.equal(prompts, 0);
	runtime.dispose();
});

test("Agent runtime rejects mutable Skill version labels before Pi execution", async () => {
	const source = { platform: "cli", chatId: "skill-mutable-version", chatType: "dm", userId: "local" };
	let prompts = 0;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const tools = [
		{ name: "capability_discover", description: "Discover capabilities", beemaxCapabilityPrefetch: async () => ({ cognitionId: "cap:mutable-version", candidates: [{ kind: "skill", name: "mutable-review", version: "latest", confidence: 0.99 }], activatedTools: ["skill_read"], skills: [{ name: "mutable-review" }] }) },
		{ name: "skill_read", description: "Read Skill" }, { name: "skill_complete", description: "Complete Skill" },
	];
	const runtime = createRuntime({ createAgent: async () => ({ agent, getAllTools: () => tools, getActiveToolNames: () => tools.map(({ name }) => name), setActiveToolsByName: () => undefined, subscribe: () => () => undefined, prompt: async () => { prompts++; }, abort: async () => undefined, dispose: () => undefined }) });
	await assert.rejects(runtime.run({ source, text: "Use Skill mutable-review", timeoutMs: 1_000 }), /immutable version/i);
	assert.equal(prompts, 0);
	runtime.dispose();
});

test("Agent runtime reports an explicitly requested missing Skill before Pi can substitute another one", async () => {
	const source = { platform: "cli", chatId: "explicit-skill-missing", chatType: "dm", userId: "local" };
	let prompts = 0;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const tools = [{ name: "capability_discover", description: "Discover capabilities", beemaxCapabilityPrefetch: async (_query, _signal, options) => ({ cognitionId: "cap:missing", candidates: [], activatedTools: [], skills: [], skillBlocker: { code: "skill_not_installed", name: options.explicitSkillName } }) }];
	const runtime = createRuntime({ createAgent: async () => ({ agent, getAllTools: () => tools, getActiveToolNames: () => ["capability_discover"], setActiveToolsByName: () => undefined, subscribe: () => () => undefined, prompt: async () => { prompts++; }, abort: async () => undefined, dispose: () => undefined }) });
	await assert.rejects(runtime.run({ source, text: "/skill:missing-review perform the requested workflow", timeoutMs: 1_000 }), /missing-review.*not installed/i);
	assert.equal(prompts, 0);
	runtime.dispose();
});

test("Agent runtime enforces an explicit Skill name even when a prefetch adapter proposes an alternative", async () => {
	const source = { platform: "cli", chatId: "explicit-skill-exclusive", chatType: "dm", userId: "local" };
	let prompts = 0;
	const version = `sha256:${"a".repeat(64)}`;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const tools = [
		{ name: "capability_discover", description: "Discover capabilities", beemaxCapabilityPrefetch: async () => ({ cognitionId: "cap:wrong-skill", candidates: [{ kind: "skill", name: "alternative-review", version, confidence: 0.99 }], activatedTools: ["skill_read"], skills: [{ name: "alternative-review" }] }) },
		{ name: "skill_read", description: "Read Skill" }, { name: "skill_complete", description: "Complete Skill" },
	];
	const runtime = createRuntime({ createAgent: async () => ({ agent, getAllTools: () => tools, getActiveToolNames: () => tools.map(({ name }) => name), setActiveToolsByName: () => undefined, subscribe: () => () => undefined, prompt: async () => { prompts++; }, abort: async () => undefined, dispose: () => undefined }) });
	await assert.rejects(runtime.run({ source, text: "/skill:required-review perform the requested workflow", timeoutMs: 1_000 }), /required-review.*not installed|required-review.*unavailable/i);
	assert.equal(prompts, 0);
	runtime.dispose();
});

test("Agent runtime does not admit a legacy Skill prefetch without explicit selection or calibrated confidence", async () => {
	const source = { platform: "cli", chatId: "legacy-skill-confidence", chatType: "dm", userId: "local", delegatedTask: { id: "legacy-review", ownerKey: "cli:local:local" } };
	let prompts = 0;
	const version = `sha256:${"1".repeat(64)}`;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const tools = [
		{ name: "capability_discover", description: "Discover capabilities", beemaxSkillPrefetch: async () => [{ name: "legacy-review", version }] },
		{ name: "skill_read", description: "Read Skill" }, { name: "skill_complete", description: "Complete Skill" },
	];
	const runtime = createRuntime({ createAgent: async () => ({ agent, getAllTools: () => tools, getActiveToolNames: () => tools.map(({ name }) => name), setActiveToolsByName: () => undefined, subscribe: () => () => undefined, prompt: async () => { prompts++; agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "explained without executing a Skill" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined }) });
	await runtime.run({ source, text: "Explain review methods", timeoutMs: 1_000 });
	assert.equal(prompts, 1);
	runtime.dispose();
});

test("delegated Chinese research starts with Exa web search active instead of degrading before discovery", async () => {
	const source = { platform: "cli", chatId: "research", chatType: "dm", userId: "local", delegatedTask: { id: "task-research", ownerKey: "cli:local:local" } };
	const tools = createWebTools({ agentReachAvailable: true });
	const activeChanges = [];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({ createAgent: async () => ({
		agent,
		getAllTools: () => tools,
		getActiveToolNames: () => tools.map(({ name }) => name),
		setActiveToolsByName: (names) => { activeChanges.push([...names]); },
		subscribe: () => () => undefined,
		prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; },
		abort: async () => undefined,
		dispose: () => undefined,
	}) });
	await runtime.run({ source, text: "用 agent-reach 网络检索可验证的公开趋势和真实可溯源来源", timeoutMs: 1_000, mode: "automation" });
	assert.ok(activeChanges[0].includes("exa_web_search"));
	runtime.dispose();
});

test("Agent runtime settles a model turn after bounded visible-output inactivity", async () => {
	const source = { platform: "cli", chatId: "idle-settle", chatType: "dm", userId: "local" };
	let listener;
	let finishPrompt;
	let fallback;
	let aborts = 0;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({
		turnIdleSettleMs: 20,
		createAgent: async () => ({
			agent,
			getAllTools: () => [{ name: "read", description: "Read a file", beemaxPolicy: { sideEffect: "none" } }],
			getActiveToolNames: () => ["read"],
			setActiveToolsByName: () => undefined,
			subscribe: (next) => { listener = next; return () => undefined; },
			prompt: async () => {
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "completed result" }], usage: { input: 1, output: 1 } }];
				await admitToolCalls(agent, listener, [{ id: "orphaned-tool", name: "read" }], "response:idle-tool");
				listener({ type: "message_update", message: agent.state.messages[0], assistantMessageEvent: { type: "text_delta", delta: "completed result" } });
				listener({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "completed result" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
				await new Promise((resolve) => { finishPrompt = resolve; fallback = setTimeout(resolve, 200); });
			},
			abort: async () => { aborts++; clearTimeout(fallback); finishPrompt?.(); },
			dispose: () => undefined,
		}),
	});
	const startedAt = Date.now();
	const result = await runtime.run({ source, text: "hello", timeoutMs: 1_000, allowedCapabilities: ["read"] });
	assert.equal(result.answer, "completed result");
	assert.equal(aborts, 1);
	assert.ok(Date.now() - startedAt < 150);
	runtime.dispose();
});

test("Agent runtime continues once after capability discovery so activated tools can run", async () => {
	const source = { platform: "cli", chatId: "progressive", chatType: "dm", userId: "local" };
	let listener;
	let activeTools = ["capability_discover", "web_search"];
	const toolSelections = [];
	const prompts = [];
	const events = [];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({ planningPolicy: new AutonomousPlanningPolicy(), createAgent: async () => ({
		agent,
		getActiveToolNames: () => [...activeTools],
		getAllTools: () => [{ name: "capability_discover", description: "Discover", beemaxPolicy: { sideEffect: "none" } }, { name: "web_search", description: "Search", beemaxPolicy: { sideEffect: "none" } }],
		setActiveToolsByName: (names) => { activeTools = [...names]; toolSelections.push([...names]); },
		subscribe: (next) => { listener = next; return () => undefined; },
		prompt: async (text) => {
			prompts.push(text);
			if (prompts.length === 1) await dispatchToolCall(agent, listener, { id: "discover", name: "capability_discover", result: { details: { activatedTools: ["web_search"], ranked: [{ kind: "tool", name: "web_search", score: 60, confidence: 0.6, reason: "matched trigger" }] } } });
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }];
		},
		abort: async () => undefined, dispose: () => undefined,
	}) });
	await runtime.run({ source, text: "search current weather", timeoutMs: 1_000 }, (event) => events.push(event));
	assert.equal(prompts.length, 2);
	assert.match(prompts[1], /capability continuation/i);
	assert.doesNotMatch(prompts[1], /current weather/i);
	assert.ok(toolSelections.some((names) => names.length === 1 && names[0] === "web_search"));
	assert.deepEqual(activeTools, ["capability_discover", "web_search"]);
	assert.deepEqual(events.filter((event) => event.type === "capability_ranked"), [{ type: "capability_ranked", candidates: [{ kind: "tool", name: "web_search", score: 60, confidence: 0.6, reason: "trigger" }], activatedTools: ["web_search"] }]);
	runtime.dispose();
});

test("Agent runtime promotes artifact_read only after a Tool produces a scoped Artifact receipt", async () => {
	const source = { platform: "cli", chatId: "artifact-progressive", chatType: "dm", userId: "local" };
	let listener; let activeTools = ["capability_discover", "web_search", "artifact_read"];
	const selections = []; const prompts = []; let transitionPublished = false;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const tools = [
		{ name: "capability_discover", description: "Discover", beemaxPolicy: { sideEffect: "none" } },
		{ name: "web_search", description: "Search", beemaxPolicy: { sideEffect: "none" } },
		{ name: "artifact_read", description: "Read a scoped Tool Artifact", beemaxPolicy: { sideEffect: "none" } },
	];
	const runtime = createRuntime({ planningPolicy: new AutonomousPlanningPolicy(), createAgent: async () => ({
		agent, getAllTools: () => tools, getActiveToolNames: () => [...activeTools],
		setActiveToolsByName: (names) => { activeTools = [...names]; selections.push([...names]); },
		subscribe: (next) => { listener = next; return () => undefined; },
		prompt: async (text) => {
			prompts.push(text);
			if (prompts.length === 1) {
				assert.deepEqual(activeTools, ["capability_discover"]);
				await dispatchToolCall(agent, listener, { id: "discover", name: "capability_discover", result: { details: { activatedTools: ["web_search"], ranked: [{ kind: "tool", name: "web_search", score: 60, confidence: 0.6, reason: "matched trigger" }] } } });
			} else {
				assert.deepEqual(activeTools, ["web_search"]);
				await dispatchToolCall(agent, listener, { id: "search", name: "web_search", result: { details: { toolArtifact: { ref: `beemax-artifact:sha256:${"a".repeat(64)}` } } } });
				assert.deepEqual(activeTools, ["web_search", "artifact_read"]);
				transitionPublished = agent.state.messages.some((message) => message.customType === "beemax-tool-spec-transition" && /artifact_read/u.test(message.content));
			}
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }];
		},
		abort: async () => undefined, dispose: () => undefined,
	}) });
	await runtime.run({ source, text: "search current weather", timeoutMs: 1_000 });
	assert.equal(prompts.length, 2);
	assert.ok(selections.some((names) => names.length === 2 && names.includes("web_search") && names.includes("artifact_read")));
	assert.equal(transitionPublished, true);
	assert.deepEqual(activeTools, ["capability_discover", "web_search", "artifact_read"]);
	runtime.dispose();
});

test("Agent runtime reroutes one unresolved Tool failure through capability discovery before giving up", async () => {
	const source = { platform: "cli", chatId: "reroute", chatType: "dm", userId: "local" };
	let listener; const prompts = []; const traceEvents = []; const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({ executionTrace: { record: (event) => { traceEvents.push(event); } }, createAgent: async () => ({
		agent, getActiveToolNames: () => ["capability_discover", "read", "primary_search", "alternate_search"], setActiveToolsByName: () => undefined,
		getAllTools: () => [
			{ name: "capability_discover", description: "Discover", beemaxPolicy: { sideEffect: "none" } },
			{ name: "read", description: "Read context", beemaxPolicy: { sideEffect: "none" }, beemaxToolSpec: { configured: true, health: "ready", ranking: { inputModalities: ["text"], outputModalities: ["text"], freshness: "static", evidence: "source_receipt" } } },
			{ name: "primary_search", description: "Primary search", beemaxPolicy: { sideEffect: "none" }, beemaxToolSpec: { configured: true, health: "ready", ranking: { inputModalities: ["text"], outputModalities: ["structured"], freshness: "realtime", evidence: "source_receipt" } } },
			{ name: "alternate_search", description: "Alternate search", beemaxPolicy: { sideEffect: "none" }, beemaxToolSpec: { configured: true, health: "ready", ranking: { inputModalities: ["text"], outputModalities: ["structured"], freshness: "realtime", evidence: "source_receipt" } } },
		],
		subscribe: (next) => { listener = next; return () => undefined; },
		prompt: async (text) => {
			prompts.push(text);
			if (prompts.length === 1) {
				await dispatchToolCall(agent, listener, { id: "failed", name: "primary_search", isError: true });
				await dispatchToolCall(agent, listener, { id: "context", name: "read" });
			}
			if (prompts.length === 2) await dispatchToolCall(agent, listener, { id: "discover", name: "capability_discover", result: { details: { cognitionId: "cap:reroute-1", activatedTools: ["alternate_search"], ranked: [{ kind: "tool", name: "alternate_search", score: 60, confidence: 0.6, reason: "matched trigger" }] } } });
			if (prompts.length === 3) await dispatchToolCall(agent, listener, { id: "alternate", name: "alternate_search" });
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }];
		},
		abort: async () => undefined, dispose: () => undefined,
	}) });
	await runtime.run({ source, text: "find current evidence", timeoutMs: 1_000, allowedCapabilities: ["capability_discover", "read", "primary_search", "alternate_search"] });
	assert.equal(prompts.length, 3);
	assert.match(prompts[1], /primary_search/);
	assert.match(prompts[1], /capability_discover/);
	assert.match(prompts[1], /do not retry the same external mutation/i);
	assert.match(prompts[2], /capability continuation/i);
	assert.deepEqual(traceEvents.find((event) => event.type === "capability.rerouted"), {
		type: "capability.rerouted", executionEnvelope: traceEvents[0].executionEnvelope,
		at: traceEvents.find((event) => event.type === "capability.rerouted")?.at,
		cognitionId: "cap:reroute-1", failedTool: "primary_search", alternativeTool: "alternate_search",
	});
	runtime.dispose();
});

test("Agent runtime does not reroute a read-only Tool failure that succeeds later in the same Turn", async () => {
	const source = { platform: "cli", chatId: "read-recovered", chatType: "dm", userId: "local" };
	let listener; let prompts = 0; const agent = { state: { model: { id: "test" }, messages: [] } };
	const tools = [{ name: "primary_search", description: "Primary", beemaxPolicy: { sideEffect: "none" }, beemaxToolSpec: { configured: true, health: "ready", ranking: { inputModalities: ["text"], outputModalities: ["structured"], freshness: "realtime", evidence: "source_receipt" } } }];
	const runtime = createRuntime({ createAgent: async () => ({
		agent, getActiveToolNames: () => ["primary_search"], setActiveToolsByName: () => undefined, getAllTools: () => tools,
		subscribe: (next) => { listener = next; return () => undefined; },
		prompt: async () => {
			prompts++;
			await dispatchToolCall(agent, listener, { id: "failed", name: "primary_search", isError: true });
			await dispatchToolCall(agent, listener, { id: "recovered", name: "primary_search" });
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }];
		}, abort: async () => undefined, dispose: () => undefined,
	}) });
	await runtime.run({ source, text: "find current evidence", timeoutMs: 1_000, allowedCapabilities: ["primary_search"] });
	assert.equal(prompts, 1);
	runtime.dispose();
});

test("Agent runtime accepts an equivalent read reroute only after trusted Provider health recovery", async () => {
	const source = { platform: "cli", chatId: "reroute-provider-recovery", chatType: "dm", userId: "local" };
	let listener; let prompts = 0; const agent = { state: { model: { id: "test" }, messages: [] } };
	const capabilityDiscover = attestCapabilityProviderResolutionTool({ name: "capability_discover", description: "Discover", beemaxPolicy: { sideEffect: "none" } });
	const tools = [
		capabilityDiscover,
		{ name: "primary_search", description: "Primary", beemaxPolicy: { sideEffect: "none" }, beemaxToolSpec: { configured: true, health: "ready", ranking: { inputModalities: ["text"], outputModalities: ["structured"], freshness: "realtime", evidence: "source_receipt" } } },
		{ name: "recovered_search", description: "Recovered", beemaxPolicy: { sideEffect: "none" }, beemaxToolSpec: { configured: false, health: "unverified", ranking: { inputModalities: ["text"], outputModalities: ["structured"], freshness: "realtime", evidence: "verified" } } },
	];
	const runtime = createRuntime({ createAgent: async () => ({
		agent, getActiveToolNames: () => tools.map(({ name }) => name), setActiveToolsByName: () => undefined, getAllTools: () => tools,
		subscribe: (next) => { listener = next; return () => undefined; },
		prompt: async () => {
			prompts++;
			if (prompts === 1) await dispatchToolCall(agent, listener, { id: "failed", name: "primary_search", isError: true });
			if (prompts === 2) await dispatchToolCall(agent, listener, { id: "discover", name: "capability_discover", result: { details: {
				cognitionId: "cap:trusted-recovery", activatedTools: ["recovered_search"], ranked: [{ kind: "tool", name: "recovered_search", score: 95, confidence: 0.95, reason: "semantic match" }],
				providerResolutions: [{ capability: "recovered_search", status: "ready", selected: { id: "recovered-provider", kind: "tool", installed: true, health: { status: "ready", evidenceRef: "health:recovered" } } }],
			} } });
			if (prompts === 3) await dispatchToolCall(agent, listener, { id: "recovered", name: "recovered_search" });
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }];
		}, abort: async () => undefined, dispose: () => undefined,
	}) });
	await runtime.run({ source, text: "find verified realtime evidence", timeoutMs: 1_000, allowedCapabilities: tools.map(({ name }) => name) });
	assert.equal(prompts, 3);
	runtime.dispose();
});

test("Agent runtime acquires an installable equivalent read Provider and resumes the unchanged Contract", async () => {
	const source = { platform: "cli", chatId: "reroute-provider-acquire", chatType: "dm", userId: "local" };
	let listener; let prompts = 0; const agent = { state: { model: { id: "test" }, messages: [] } };
	const capabilityDiscover = attestCapabilityProviderResolutionTool({ name: "capability_discover", description: "Discover", beemaxPolicy: { sideEffect: "none" } });
	const capabilityAcquire = attestCapabilityProviderAcquisitionTool({ name: "capability_acquire", description: "Acquire", beemaxPolicy: { sideEffect: "local" } });
	const tools = [
		capabilityDiscover, capabilityAcquire,
		{ name: "primary_search", description: "Primary", beemaxPolicy: { sideEffect: "none" }, beemaxToolSpec: { configured: true, health: "ready", ranking: { inputModalities: ["text"], outputModalities: ["structured"], freshness: "realtime", evidence: "source_receipt" } } },
		{ name: "installable_search", description: "Installable", beemaxPolicy: { sideEffect: "none" }, beemaxToolSpec: { configured: false, health: "unavailable", ranking: { inputModalities: ["text"], outputModalities: ["structured"], freshness: "realtime", evidence: "verified" } } },
	];
	const runtime = createRuntime({ createAgent: async () => ({
		agent, getActiveToolNames: () => tools.map(({ name }) => name), setActiveToolsByName: () => undefined, getAllTools: () => tools,
		subscribe: (next) => { listener = next; return () => undefined; },
		prompt: async () => {
			prompts++;
			if (prompts === 1) await dispatchToolCall(agent, listener, { id: "failed", name: "primary_search", isError: true });
			if (prompts === 2) await dispatchToolCall(agent, listener, { id: "discover", name: "capability_discover", result: { details: {
				cognitionId: "cap:installable-reroute", activatedTools: ["capability_acquire"], ranked: [{ kind: "tool", name: "installable_search", score: 96, confidence: 0.96, reason: "semantic match" }],
				providerResolutions: [{ capability: "installable_search", status: "blocked", candidates: [{ id: "installable-provider", kind: "tool", installed: false, installable: true, health: { status: "unavailable", reason: "not installed" } }], blocker: { code: "provider_unavailable", reason: "installable-provider is not installed", requiredConfiguration: [] } }],
			} } });
			if (prompts === 3) await dispatchToolCall(agent, listener, { id: "acquire", name: "capability_acquire", result: { details: { providerAcquisition: { capability: "installable_search", status: "ready", selected: { id: "installable-provider", kind: "tool", installed: true, health: { status: "ready", evidenceRef: "health:installed" } } } } } });
			if (prompts === 4) await dispatchToolCall(agent, listener, { id: "installed", name: "installable_search" });
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }];
		}, abort: async () => undefined, dispose: () => undefined,
	}) });
	await runtime.run({ source, text: "find verified realtime evidence", timeoutMs: 1_000, allowedCapabilities: tools.map(({ name }) => name) });
	assert.equal(prompts, 4);
	runtime.dispose();
});

test("Agent runtime rejects read reroutes that cannot prove equivalent health, modality, freshness, and evidence", async () => {
	for (const variant of [
		{ name: "stale", configured: true, health: "ready", input: ["text"], output: ["structured"], freshness: "static", evidence: "source_receipt" },
		{ name: "unverified", configured: true, health: "unverified", input: ["text"], output: ["structured"], freshness: "realtime", evidence: "source_receipt" },
		{ name: "self-reported", configured: true, health: "ready", input: ["text"], output: ["structured"], freshness: "realtime", evidence: "self_reported" },
		{ name: "wrong-input", configured: true, health: "ready", input: ["file"], output: ["structured"], freshness: "realtime", evidence: "source_receipt" },
		{ name: "wrong-output", configured: true, health: "ready", input: ["text"], output: ["text"], freshness: "realtime", evidence: "source_receipt" },
		{ name: "unconfigured", configured: false, health: "ready", input: ["text"], output: ["structured"], freshness: "realtime", evidence: "source_receipt" },
		{ name: "undeclared-contract", configured: true, health: "ready" },
		{ name: "untraceable-selection", configured: true, health: "ready", input: ["text"], output: ["structured"], freshness: "realtime", evidence: "verified" },
	]) {
		const source = { platform: "cli", chatId: `reroute-${variant.name}`, chatType: "dm", userId: "local" };
		let listener; const prompts = []; const events = []; const agent = { state: { model: { id: "test" }, messages: [] } };
		const runtime = createRuntime({ createAgent: async () => ({
			agent, getActiveToolNames: () => ["capability_discover", "primary_search", "weak_alternate"], setActiveToolsByName: () => undefined,
			getAllTools: () => [
				{ name: "capability_discover", description: "Discover", beemaxPolicy: { sideEffect: "none" } },
				{ name: "primary_search", description: "Realtime source search", beemaxPolicy: { sideEffect: "none" }, beemaxToolSpec: { configured: true, health: "ready", ranking: { inputModalities: ["text"], outputModalities: ["structured"], freshness: "realtime", evidence: "source_receipt" } } },
				{ name: "weak_alternate", description: "Weaker alternate", beemaxPolicy: { sideEffect: "none" }, beemaxToolSpec: { configured: variant.configured, health: variant.health, ...(variant.input ? { ranking: { inputModalities: variant.input, outputModalities: variant.output, freshness: variant.freshness, evidence: variant.evidence } } : {}) } },
			],
			subscribe: (next) => { listener = next; return () => undefined; },
			prompt: async () => {
				prompts.push("prompt");
				if (prompts.length === 1) await dispatchToolCall(agent, listener, { id: "failed", name: "primary_search", isError: true });
				if (prompts.length === 2) await dispatchToolCall(agent, listener, { id: "discover", name: "capability_discover", result: { details: { activatedTools: ["weak_alternate"], ranked: [{ kind: "tool", name: "weak_alternate", score: 90, confidence: 0.9, reason: "semantic alternate" }] } } });
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "weaker answer" }], usage: { input: 1, output: 1 } }];
			},
			abort: async () => undefined, dispose: () => undefined,
		}) });
		await assert.rejects(runtime.run({ source, text: "find realtime evidence with source receipts", timeoutMs: 1_000, allowedCapabilities: ["capability_discover", "primary_search", "weak_alternate"] }, (event) => { events.push(event); }), /equivalent healthy read-only capability/i, variant.name);
		assert.equal(prompts.length, 2, variant.name);
		assert.deepEqual(events.find((event) => event.type === "capability_ranked")?.activatedTools, [], variant.name);
		runtime.dispose();
	}
});

test("Agent runtime asks Pi to correct malformed arguments without treating them as a Provider outage", async () => {
	const source = { platform: "cli", chatId: "argument-correction", chatType: "dm", userId: "local" };
	let listener;
	const prompts = [];
	const traceEvents = [];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({ executionTrace: { record(event) { traceEvents.push(event); } }, createAgent: async () => ({
		agent,
		getActiveToolNames: () => ["capability_discover", "primary_search"],
		setActiveToolsByName: () => undefined,
		getAllTools: () => [{ name: "primary_search", description: "Primary search", beemaxPolicy: { sideEffect: "none" } }],
		subscribe: (next) => { listener = next; return () => undefined; },
		prompt: async (text) => {
			prompts.push(text);
			await dispatchToolCall(agent, listener, { id: "invalid", name: "primary_search", isError: true,
				result: { content: [{ type: "text", text: "query: required constraint was not satisfied" }], details: { dispatchError: { stage: "validation", code: "arguments_invalid", retryable: true } } } });
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "will correct through Pi" }], usage: { input: 1, output: 1 } }];
		},
		abort: async () => undefined, dispose: () => undefined,
	}) });

	await runtime.run({ source, text: "find current evidence", timeoutMs: 1_000, allowedCapabilities: ["primary_search"] });
	assert.equal(prompts.length, 1);
	assert.doesNotMatch(prompts.join("\n"), /capability reroute/i);
	assert.deepEqual(traceEvents.find((event) => event.type === "tool.settled")?.dispatchReceipt, {
		stage: "validation", code: "arguments_invalid", outcome: "rejected", retryable: true,
	});
	runtime.dispose();
});

test("Agent runtime aborts an identical failed read-only Tool loop before another model continuation", async () => {
	const source = { platform: "cli", chatId: "duplicate-read", chatType: "dm", userId: "local" };
	let listener;
	let aborts = 0;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({ planningPolicy: new AutonomousPlanningPolicy(), createAgent: async () => ({
		agent,
		getActiveToolNames: () => ["read"],
		getAllTools: () => [{ name: "read", description: "Read a file", beemaxPolicy: { sideEffect: "none" } }],
		setActiveToolsByName: () => undefined,
		subscribe: (next) => { listener = next; return () => undefined; },
		prompt: async () => {
			await admitToolCalls(agent, listener, ["first", "second"].map((id) => ({ id, name: "read", args: { path: "missing.txt" } })), "response:duplicate-read");
			for (const id of ["first", "second"]) {
				listener({ type: "tool_execution_end", toolCallId: id, toolName: "read", result: { error: "missing" }, isError: true });
			}
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "still trying" }], usage: { input: 1, output: 1 } }];
		},
		abort: async () => { aborts++; }, dispose: () => undefined,
	}) });
	await assert.rejects(runtime.run({ source, text: "读取 missing.txt", timeoutMs: 1_000, allowedCapabilities: ["read"] }), /repeated the same failed read-only Tool call/);
	assert.equal(aborts, 1);
	runtime.dispose();
});

test("Agent runtime never auto-reroutes an unresolved external mutation", async () => {
	const source = { platform: "cli", chatId: "write-failure", chatType: "dm", userId: "local" };
	let listener; const prompts = []; const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({ createAgent: async () => ({
		agent, getActiveToolNames: () => ["capability_discover", "external_write"], setActiveToolsByName: () => undefined,
		getAllTools: () => [{ name: "external_write", description: "Write externally", beemaxPolicy: { sideEffect: "external" } }],
		subscribe: (next) => { listener = next; return () => undefined; },
		prompt: async (text) => { prompts.push(text); await dispatchToolCall(agent, listener, { id: "write", name: "external_write", isError: true }); agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "failed" }], usage: { input: 1, output: 1 } }]; },
		abort: async () => undefined, dispose: () => undefined,
	}) });
	await runtime.run({ source, text: "perform write", timeoutMs: 1_000, allowedCapabilities: ["external_write"] });
	assert.equal(prompts.length, 1);
	runtime.dispose();
});

test("Capability event validation rejects unregistered names and free-form ranking content", async () => {
	const source = { platform: "cli", chatId: "capability-event-boundary", chatType: "dm", userId: "local" };
	let listener; let prompts = 0; const events = []; const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({ createAgent: async () => ({
		agent, getActiveToolNames: () => ["capability_discover", "safe_search"], setActiveToolsByName: () => undefined,
		getAllTools: () => [{ name: "capability_discover", description: "Discover", beemaxPolicy: { sideEffect: "none" }, beemaxCapabilityPrefetch: async () => { throw new Error("semantic Provider temporarily unavailable"); } }, { name: "safe_search", description: "Safe search", beemaxPolicy: { sideEffect: "none" } }],
		subscribe: (next) => { listener = next; return () => undefined; },
		prompt: async () => { prompts++; if (prompts === 1) await dispatchToolCall(agent, listener, { id: "discover", name: "capability_discover", result: { details: { cognitionId: "cap:sanitized-event", activatedTools: ["safe_search", "SECRET prompt and args", "safe_search"], ranked: [{ kind: "tool", name: "safe_search", score: 5, confidence: 2, reason: "SECRET prompt schema args" }, { kind: "tool", name: "SECRET body", score: 99, confidence: 1, reason: "SECRET" }] } } }); agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; },
		abort: async () => undefined, dispose: () => undefined,
	}) });
	await runtime.run({ source, text: "Use a Tool to resolve the required capability", timeoutMs: 1_000 }, (event) => { events.push(event); });
	const ranked = events.find((event) => event.type === "capability_ranked");
	assert.deepEqual(ranked, { type: "capability_ranked", candidates: [{ kind: "tool", name: "safe_search", score: 5, confidence: 1, reason: "lexical" }], activatedTools: ["safe_search"] });
	assert.doesNotMatch(JSON.stringify(ranked), /SECRET|schema|args/);
	runtime.dispose();
});

test("Agent runtime releases Skill bodies at turn boundaries while retaining execution metadata", async () => {
	const source = { platform: "cli", chatId: "skill-context", chatType: "dm", userId: "local" };
	const agent = { state: { model: { id: "test" }, messages: [{ role: "toolResult", toolCallId: "old", toolName: "skill_resource_read", content: [{ type: "text", text: "old sensitive skill body" }], details: { sha256: "old-hash" } }] } };
	let historicalAtPrompt = "";
	const runtime = createRuntime({ createAgent: async () => ({
		agent, getActiveToolNames: () => ["capability_discover"], setActiveToolsByName: () => undefined, subscribe: () => () => undefined,
		prompt: async () => {
			historicalAtPrompt = agent.state.messages[0].content[0].text;
			agent.state.messages = [...agent.state.messages, { role: "toolResult", toolCallId: "new", toolName: "skill_activate", content: [{ type: "text", text: "current skill body" }], details: { descriptor: { name: "review", sha256: "new-hash" } } }, { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }];
		}, abort: async () => undefined, dispose: () => undefined,
	}) });
	await runtime.run({ source, text: "review", timeoutMs: 1_000 });
	assert.doesNotMatch(historicalAtPrompt, /old sensitive/);
	assert.doesNotMatch(agent.state.messages.find((message) => message.toolCallId === "new").content[0].text, /current skill body/);
	assert.equal(agent.state.messages.find((message) => message.toolCallId === "new").details.descriptor.sha256, "new-hash");
	runtime.dispose();
});

test("BeeMax explicit Skill commands enter the enforced runtime lifecycle instead of Pi body expansion", async () => {
	const source = { platform: "cli", chatId: "explicit-skill", chatType: "dm", userId: "local" }; let received = ""; let listener;
	const version = `sha256:${"b".repeat(64)}`;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const tools = [
		{ name: "capability_discover", description: "Discover capabilities", beemaxCapabilityPrefetch: async () => ({ cognitionId: "cap:explicit-contract-review", candidates: [{ kind: "skill", name: "contract-review", version, confidence: 1 }], activatedTools: ["skill_read"], skills: [{ name: "contract-review" }] }) },
		{ name: "skill_read", description: "Read Skill" }, { name: "skill_complete", description: "Complete Skill" },
	];
	const runtime = createRuntime({ context: { enrich: (_source, text) => `verified facts\n\n${text}`, record: () => undefined }, createAgent: async () => ({
		agent, getAllTools: () => tools, getActiveToolNames: () => tools.map(({ name }) => name), setActiveToolsByName: () => undefined, subscribe: (next) => { listener = next; return () => undefined; },
		prompt: async (text) => {
			received = text;
			await dispatchToolCall(agent, listener, { id: "read", name: "skill_read", result: { details: { skill: "contract-review", activatedTools: ["skill_complete"], legacy: true, declaredTools: [], skillLifecycleReceipt: { id: "receipt:explicit-read", name: "contract-review", version, phase: "read", sourceTool: "skill_read" } } } });
			await dispatchToolCall(agent, listener, { id: "complete", name: "skill_complete", result: { details: { skill: "contract-review", skillLifecycleReceipt: { id: "receipt:explicit-complete", name: "contract-review", version, phase: "completed", sourceTool: "skill_complete" }, capabilityReceipt: { id: "receipt:explicit-skill", kind: "skill", name: "contract-review", version, sourceTool: "skill_complete" } } } });
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }];
		}, abort: async () => undefined, dispose: () => undefined,
	}) });
	await runtime.run({ source, text: "/skill:contract-review inspect this", timeoutMs: 1_000 });
	assert.match(received, /verified facts/); assert.match(received, /Explicit Skill request: contract-review/); assert.match(received, /capability_discover/); assert.doesNotMatch(received, /<skill name=/);
	runtime.dispose();
});

test("planning policy does not over-delegate lightweight English or Chinese review requests", () => {
	const policy = new AutonomousPlanningPolicy();
	for (const prompt of ["Review this sentence", "Please look at this code snippet", "帮我看一下这段代码", "检查这句话是否通顺"]) {
		assert.equal(policy.decide(prompt).mode, "direct", prompt);
	}
});

test("planning policy keeps a single bounded Tool query direct even with evaluation safety context", () => {
	const prompt = "通过已配置的 agent_parity MCP 查询 fixture 系统状态，返回 fixture ID。\n\nOperate only inside the current isolated evaluation workspace. Never contact or mutate a real messaging, enterprise, production, or customer system. If a required safe capability is unavailable, report the exact blocker without weakening the requested objective.";
	const decision = new AutonomousPlanningPolicy().decide(prompt);
	assert.equal(decision.signals.requiresResearch, true);
	assert.equal(decision.mode, "direct");
	assert.deepEqual(decision.requiredTools, []);
});

test("planning policy gives multi-source direct research enough token budget without changing simple Turns", () => {
	const policy = new AutonomousPlanningPolicy();
	const decision = policy.decide("截至今天，研究公开发布的 Agent 工具调用趋势，至少实时核验两个不同来源");
	assert.equal(decision.mode, "direct");
	assert.equal(decision.budget.maxTokens, 20_000);
	assert.equal(policy.decide("What model are you using?").budget.maxTokens, 12_000);
});

test("planning policy consistently escalates substantial bilingual work", () => {
	const policy = new AutonomousPlanningPolicy();
	assert.equal(policy.decide("Research the official documentation deeply and produce an evidence-backed comparison report").mode, "delegate");
	assert.equal(policy.decide("深入研究官方文档，形成有证据支持的完整报告").mode, "delegate");
	assert.equal(policy.decide("全面审查 API、CLI 和安全模块，并行验证后汇总报告").mode, "dag");
});

test("planning policy delegates one substantial isolated work item", () => {
	const policy = new AutonomousPlanningPolicy({ maxConcurrent: 8 });
	const decision = policy.decide("Research the official documentation deeply and produce an evidence-backed comparison report");
	assert.equal(decision.mode, "delegate");
	assert.equal(decision.requiredTool, "task_spawn");
	assert.deepEqual(decision.requiredTools, ["task_spawn", "task_wait"]);
	assert.equal(decision.suggestedConcurrency, 1);
	assert.equal(decision.budget.maxSubagents, 1);
	assert.equal(decision.budget.maxToolCalls, 12);
	assert.equal(decision.budget.maxTokens, 20_000);
});

test("planning policy keeps one bounded writing and file-verification workflow in the parent Agent", () => {
	const decision = new AutonomousPlanningPolicy().decide("请使用当前最合适的标准 Skill，为 BeeMax 写一段约120字的中文发布短文，必须包含持久任务、飞书、可验证结果三个词。将最终文本写入文件，然后重新读取并确认三个关键词都存在。不要发布到外部平台。");
	assert.equal(decision.mode, "direct");
	assert.equal(decision.signals.requiresResearch, false);
	assert.deepEqual(decision.requiredTools, []);
});

test("planning policy distinguishes temporal information needs from ordinary current-context modifiers", () => {
	const policy = new AutonomousPlanningPolicy();
	assert.equal(policy.decide("current weather").signals.requiresResearch, true);
	assert.equal(policy.decide("查询当前天气").signals.requiresResearch, true);
	assert.equal(policy.decide("use the current best Skill").signals.requiresResearch, false);
	assert.equal(policy.decide("使用当前最合适的 Skill").signals.requiresResearch, false);
	assert.equal(policy.decide("当前目标是继续完成报告，不要改目标").signals.requiresResearch, false);
	assert.equal(policy.decide("work only in the current workspace").signals.requiresResearch, false);
});

test("planning policy does not mistake an independent verification capability name for parallel work", () => {
	const decision = new AutonomousPlanningPolicy().decide("写一份 BeeMax 营销 brief，仅描述 Pi 循环、Task Ledger、独立 Verification、Memory 和 Skills，写入文件后读回确认。");
	assert.equal(decision.mode, "direct");
	assert.equal(decision.signals.requestsParallelism, false);
	assert.deepEqual(decision.requiredTools, []);
});

test("planning policy honors an explicit request not to delegate", () => {
	const decision = new AutonomousPlanningPolicy().decide("全面整理这份营销材料并写入文件，不要委派，不使用子代理。");
	assert.equal(decision.mode, "direct");
	assert.match(decision.reason, /explicitly requires/i);
	assert.deepEqual(decision.requiredTools, []);
});

test("planning policy selects a DAG and derives bounded parallel resources for independent deliverables", () => {
	const policy = new AutonomousPlanningPolicy({ maxConcurrent: 8, maxSubagents: 6, maxToolCalls: 60, maxTokens: 120_000 });
	const decision = policy.decide("Review the API, CLI, memory, security, and operations modules in parallel; compare each independently, then synthesize and verify a release report");
	assert.equal(decision.mode, "dag");
	assert.equal(decision.requiredTool, "task_plan_execute");
	assert.deepEqual(decision.requiredTools, ["task_plan_execute"]);
	assert.ok(decision.suggestedConcurrency >= 2);
	assert.ok(decision.suggestedConcurrency <= 6);
	assert.ok(decision.budget.maxSubagents >= decision.suggestedConcurrency);
	assert.ok(decision.budget.maxToolCalls <= 60);
	assert.ok(decision.budget.maxTokens <= 120_000);
	assert.ok(decision.signals.independentWorkItems >= 2);
});

test("planning policy degrades a complex request when its resource ceiling cannot support a DAG", () => {
	const policy = new AutonomousPlanningPolicy({ maxConcurrent: 1, maxSubagents: 1, maxToolCalls: 8, maxTokens: 8_000 });
	const decision = policy.decide("Research three independent providers in parallel, compare them, verify every result, and publish one report");
	assert.equal(decision.mode, "delegate");
	assert.equal(decision.suggestedConcurrency, 1);
	assert.equal(decision.budget.maxSubagents, 1);
	assert.match(decision.reason, /budget|capacity/i);
});

test("planning policy exposes a content-free directive for the Agent runtime", () => {
	const decision = new AutonomousPlanningPolicy().decide("Review frontend and backend independently, then combine the results");
	const directive = decision.directive();
	assert.match(directive, /mode=(?:dag|delegate)/);
	assert.match(directive, /maxSubagents=/);
	assert.doesNotMatch(directive, /frontend|backend/);
});

test("planning directives scope execution control to the current Objective", () => {
	const decision = new AutonomousPlanningPolicy().decide("Research the official documentation deeply and produce an evidence-backed comparison report");
	const directive = decision.directive("objective:current");
	assert.match(directive, /objective:current/);
	assert.match(directive, /sole current execution policy/i);
	assert.match(directive, /ignore earlier BeeMax planning correction.*other Objectives/i);
});

test("Agent runtime injects a deterministic planning directive without changing the user exchange", async () => {
	const source = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };
	let received = "";
	let runtimeListener;
	const recorded = [];
	const runEvents = [];
	const budgets = new PlanningBudgetRegistry();
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({
		planningPolicy: new AutonomousPlanningPolicy(),
		planningBudgets: budgets,
		context: { enrich: (_source, text) => text, record: (_source, exchange) => recorded.push(exchange) },
		createAgent: async () => ({
			agent,
			getAllTools: () => [{ name: "task_plan_execute", beemaxPolicy: { sideEffect: "local" } }],
			getActiveToolNames: () => ["task_plan_execute"],
			setActiveToolsByName: () => undefined,
			subscribe: (next) => { runtimeListener = next; return () => undefined; },
			prompt: async (text) => { received = text; await dispatchToolCall(agent, runtimeListener, { id: "plan", name: "task_plan_execute", result: { details: { planId: "plan-1", accepted: true, status: "running" } } }); runtimeListener({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } }); agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }]; },
			abort: async () => undefined,
			dispose: () => undefined,
		}),
	});
	await runtime.run({ source, text: "Review frontend and backend independently, then combine the results", timeoutMs: 1_000, allowedCapabilities: ["task_plan_execute"] }, (event) => { runEvents.push(event); });
	assert.match(received, /BeeMax execution policy/);
	assert.match(received, /mode=(?:dag|delegate)/);
	assert.deepEqual(recorded, [{ user: "Review frontend and backend independently, then combine the results", assistant: "done" }]);
	assert.equal(budgets.current("cli:local:local"), undefined);
	assert.deepEqual(runEvents.filter((event) => event.type === "planning_decision"), [{ type: "planning_decision", mode: "dag", concurrency: 2, maxSubagents: 2, requiredTools: ["task_plan_execute"] }]);
	runtime.dispose();
});

test("interactive runs persist an Objective and keep background DAG Objectives running", async () => {
	const source = { platform: "cli", chatId: "objective", chatType: "dm", userId: "local" };
	const tasks = new Map();
	const runs = new Map();
	const ledger = {
		record(task) { tasks.set(task.id, { ...task }); },
		transition(id, change) { tasks.set(id, { ...tasks.get(id), ...change }); return true; },
		recordRun(run) { runs.set(run.id, { ...run }); },
		transitionRun(id, change) { runs.set(id, { ...runs.get(id), ...change }); return true; },
		queryTasks: (query) => [...tasks.values()].filter((task) => query.ownerKeys.includes(task.ownerKey) && (!query.id || query.id === task.id)),
		isTaskRunExecutionActive: (_ownerKey, objectiveId, taskId, runId) => objectiveId === taskId && tasks.get(objectiveId)?.status === "running" && runs.get(runId)?.status === "running",
	};
	let listener;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({
		taskLedger: ledger,
		planningPolicy: new AutonomousPlanningPolicy(),
		createAgent: async () => ({
			agent, getAllTools: () => [{ name: "task_plan_execute", beemaxPolicy: { sideEffect: "local" } }], getActiveToolNames: () => ["task_plan_execute"], setActiveToolsByName: () => undefined, subscribe: (next) => { listener = next; return () => undefined; },
			prompt: async () => {
				await dispatchToolCall(agent, listener, { id: "plan", name: "task_plan_execute", result: { details: { planId: "plan", accepted: true, status: "running" } } });
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "Work accepted" }], usage: { input: 1, output: 1 } }];
			},
			abort: async () => undefined, dispose: () => undefined,
		}),
	});

	await runtime.run({ source, text: "Review frontend and backend independently, then combine the results", timeoutMs: 1_000, allowedCapabilities: ["task_plan_execute"] });

	const [objective] = [...tasks.values()];
	assert.equal(objective.kind, "objective");
	assert.equal(objective.ownerKey, "cli:objective:local");
	assert.equal(objective.description, "Review frontend and backend independently, then combine the results");
	assert.equal(objective.status, "running");
	runtime.dispose();
});

test("durable Objectives retain arbitrary identity-looking text only through Situation", async () => {
	const source = { platform: "cli", chatId: "objective-context", chatType: "dm", userId: "local" };
	const tasks = new Map();
	const ledger = { record(task) { tasks.set(task.id, { ...task }); }, transition(id, change) { tasks.set(id, { ...tasks.get(id), ...change }); return true; }, queryTasks: () => [] };
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({ taskLedger: ledger, planningPolicy: { decide: () => ({ mode: "direct", requiredTools: [], suggestedConcurrency: 1, budget: { maxSubagents: 0, maxToolCalls: null, maxTokens: null, maxCorrectiveAttempts: 0 }, signals: { substantialWork: true }, reason: "test", directive: () => "[policy]" }) }, createAgent: async () => ({
		agent, subscribe: () => () => undefined,
		prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "accepted" }], usage: { input: 1, output: 1 } }]; },
		abort: async () => undefined, dispose: () => undefined,
	}) });
	await runtime.run({ source, text: "核对主体 portfolio:A 下的对象 investment:INV-2026-0713", timeoutMs: 1_000 });
	const objective = [...tasks.values()][0];
	assert.match(objective.situation.summary, /portfolio:A/);
	assert.match(objective.situation.summary, /investment:INV-2026-0713/);
	assert.equal(objective.businessContext, undefined);
	runtime.dispose();
});

test("new durable Objectives preserve Situation and trusted Access Scope provenance separately", async () => {
	const source = { platform: "cli", chatId: "objective-situation", chatType: "dm", userId: "local" };
	const tasks = new Map();
	const ledger = { record(task) { tasks.set(task.id, { ...task }); }, transition(id, change) { tasks.set(id, { ...tasks.get(id), ...change }); return true; }, queryTasks: () => [] };
	const accessScopeRef = createAccessScopeRef({ id: "scope:aurora", authority: { kind: "membership_registry", reference: "membership:aurora" }, issuedAt: 1 });
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({ taskLedger: ledger, planningPolicy: { decide: () => ({ mode: "direct", requiredTools: [], suggestedConcurrency: 1, budget: { maxSubagents: 0, maxToolCalls: null, maxTokens: null, maxCorrectiveAttempts: 0 }, signals: { substantialWork: true }, reason: "test", directive: () => "[policy]" }) }, createAgent: async () => ({
		agent, subscribe: () => () => undefined,
		prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "accepted" }], usage: { input: 1, output: 1 } }]; },
		abort: async () => undefined, dispose: () => undefined,
	}) });
	const result = await runtime.run({ source, text: "在极光窗口前完成浮光引擎调谐，保留回滚点", timeoutMs: 1_000, accessScopeRef });
	const objective = [...tasks.values()][0];
	assert.match(objective.situation.summary, /浮光引擎/);
	assert.deepEqual(objective.accessScopeRef, accessScopeRef);
	assert.equal(objective.businessContext, undefined);
	assert.equal(objective.status, "running");
	assert.equal(objective.verificationStatus, "unavailable");
	assert.ok(objective.criterionVerifications?.length);
	assert.ok(objective.criterionVerifications.every((criterion) => criterion.status === "unavailable"));
	assert.equal(objective.candidateResult, "accepted");
	assert.equal(objective.result, undefined);
	assert.match(result.answer, /任务尚未完成.*Verification/);
	assert.notEqual(result.answer, "accepted");
	runtime.dispose();
});

test("a direct conversational answer does not create durable Objective work", async () => {
	const source = { platform: "cli", chatId: "direct-objective", chatType: "dm", userId: "local" };
	const tasks = new Map();
	const ledger = {
		record(task) { tasks.set(task.id, { ...task }); },
		transition(id, change) { tasks.set(id, { ...tasks.get(id), ...change }); return true; },
	};
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({ taskLedger: ledger, planningPolicy: new AutonomousPlanningPolicy(), createAgent: async () => ({
		agent, subscribe: () => () => undefined,
		prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "42" }], usage: { input: 1, output: 1 } }]; },
		abort: async () => undefined, dispose: () => undefined,
	}) });

	await runtime.run({ source, text: "当前目标是完成一份 Capability Routing 报告。不要取消，继续完成报告；不要改目标。", timeoutMs: 1_000 });

	assert.equal(tasks.size, 0);
	runtime.dispose();
});

test("a responsible direct Turn completes one durable Objective through one verified Task Run", async () => {
	const source = { platform: "cli", chatId: "direct-work", chatType: "dm", userId: "local" };
	const tasks = new Map();
	const runs = new Map();
	const completions = [];
	const ledger = {
		record(task) { tasks.set(task.id, { ...task }); },
		transition(id, change) { tasks.set(id, { ...tasks.get(id), ...change }); return true; },
		recordRun(run) { runs.set(run.id, { ...run }); },
		transitionRun(id, change) { runs.set(id, { ...runs.get(id), ...change }); return true; },
		queryTasks: (query) => [...tasks.values()].filter((task) => query.ownerKeys.includes(task.ownerKey) && (!query.id || task.id === query.id)),
		checkpointTask(ownerKey, id, checkpoint) { const task = tasks.get(id); if (!task || task.ownerKey !== ownerKey) return false; tasks.set(id, { ...task, checkpoint }); return true; },
		isTaskRunExecutionActive: (_ownerKey, objectiveId, taskId, runId) => objectiveId === taskId && tasks.get(objectiveId)?.status === "running" && runs.get(runId)?.status === "running",
		settleDirectObjectiveCompletion(settlement) { return settleDirectObjectiveCompletion(tasks, runs, completions, settlement); },
	};
	let envelope;
	let listener;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({
		taskLedger: ledger,
		planningPolicy: new AutonomousPlanningPolicy(),
		turnUnderstanding: { understand: (text) => ({ action: "create", goal: text, constraints: ["保留证据"], acceptanceCriteria: ["报告包含来源"], memoryQuery: text, capabilityQuery: text, executionMode: "direct", confidence: 0.9 }) },
		verifyObjectiveCandidate: async (_objective, result, _signal, context) => {
			assert.equal(result.output, "完成并附来源");
			assert.equal(context.taskRunId, envelope.taskRunId);
			assert.deepEqual(context.successfulToolNames, ["read"]);
			return { accepted: true, evidence: "来源已检查", criterionVerifications: [{ criterionId: "C1", criterion: "报告包含来源", status: "accepted", evidence: "source.md was read", evidenceRefs: ["execution:verification:direct:tool-call:source-1"] }] };
		},
		createAgent: async (_id, _source, receivedEnvelope) => {
			envelope = receivedEnvelope;
			return { agent, getAllTools: () => [{ name: "read", beemaxPolicy: { sideEffect: "none" } }], getActiveToolNames: () => ["read"], setActiveToolsByName: () => undefined, subscribe: (next) => { listener = next; return () => undefined; }, prompt: async () => {
				await admitToolCalls(agent, listener, [{ id: "source-1", name: "read", args: { path: "source.md" } }], "response:direct-source");
				listener({ type: "tool_execution_end", toolCallId: "source-1", toolName: "read", result: { content: [{ type: "text", text: "source evidence" }] }, isError: false });
				listener({ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] });
				listener({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "完成并附来源" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "完成并附来源" }], usage: { input: 1, output: 1 } }];
			}, abort: async () => undefined, dispose: () => undefined };
		},
	});

	const result = await runtime.run({ source, text: "生成一份有来源的简短报告", timeoutMs: 1_000, allowedCapabilities: ["read"] });

	assert.equal(tasks.size, 1);
	assert.equal(runs.size, 1);
	const [objective] = [...tasks.values()];
	const [run] = [...runs.values()];
	assert.equal(objective.status, "running");
	assert.equal(objective.verificationStatus, "accepted");
	assert.equal(objective.candidateResult, "完成并附来源");
	assert.equal(objective.result, undefined);
	assert.deepEqual(completions, [{ ownerKey: objective.ownerKey, id: objective.id }]);
	assert.equal(result.completionId, `objective-completion:${objective.id}`);
	assert.deepEqual(objective.criterionVerifications, [{ criterionId: "C1", criterion: "报告包含来源", status: "accepted", evidence: "source.md was read", evidenceRefs: ["execution:verification:direct:tool-call:source-1"] }]);
	assert.match(objective.description, /生成一份有来源的简短报告/);
	assert.equal(objective.workContract.rawRequest, "生成一份有来源的简短报告");
	assert.equal(objective.workContract.schemaVersion, "beemax.work-contract.v1");
	assert.deepEqual(objective.situation.constraints, ["保留证据"]);
	assert.match(objective.acceptanceCriteria, /报告包含来源/);
	assert.doesNotMatch(objective.acceptanceCriteria, /生成一份有来源的简短报告|保留证据|weaker substitute/i);
	assert.equal(run.status, "succeeded");
	assert.equal(run.output, "完成并附来源");
	assert.equal(envelope.objectiveId, objective.id);
	assert.equal(envelope.taskId, objective.id);
	assert.equal(envelope.taskRunId, run.id);
	assert.equal(objective.checkpoint.source, "pi_turn");
	assert.deepEqual(objective.checkpoint.completed, ["read:source-1"]);
	runtime.dispose();
});

test("Work Contract capability selection persists generic realtime source requirements without domain keywords", async () => {
	const rawRequest = "用 qx-17 脉冲镜像完成星历核验，结果必须对应 qx-17 即时源快照";
	const source = { platform: "cli", chatId: "unknown-realtime", chatType: "dm", userId: "local" };
	const clause = (text) => ({ text, source: { kind: "raw_request", start: rawRequest.indexOf(text), end: rawRequest.indexOf(text) + text.length } });
	const tasks = new Map();
	const runs = new Map();
	const requirementUpdates = [];
	const ledger = {
		record(task) { tasks.set(task.id, { ...task }); },
		transition(id, change) { tasks.set(id, { ...tasks.get(id), ...change }); return true; },
		recordRun(run) { runs.set(run.id, { ...run }); },
		transitionRun(id, change) { runs.set(id, { ...runs.get(id), ...change }); return true; },
		queryTasks: (query) => [...tasks.values()].filter((task) => query.ownerKeys.includes(task.ownerKey) && (!query.id || task.id === query.id)),
		updateVerificationRequirements(ownerKey, id, requirements) { requirementUpdates.push({ ownerKey, id, requirements }); const task = tasks.get(id); if (!task || task.ownerKey !== ownerKey) return false; tasks.set(id, { ...task, verificationRequirements: structuredClone(requirements) }); return true; },
		checkpointTask: () => true,
		settleDirectObjectiveCompletion(settlement) { return settleDirectObjectiveCompletion(tasks, runs, undefined, settlement); },
	};
	const tools = [
		attestCapabilityProviderResolutionTool({ name: "capability_discover", description: "Discover capabilities", beemaxCapabilityPrefetch: async () => ({ cognitionId: "cap:qx17", candidates: [{ kind: "tool", name: "temporal_evidence_feed", confidence: 0.97 }], activatedTools: ["temporal_evidence_feed"], skills: [] }) }),
		{ name: "temporal_evidence_feed", description: "Resolve arbitrary temporal evidence", beemaxPolicy: { sideEffect: "none" }, beemaxToolSpec: { kind: "tool", version: "fixture:1", configured: true, health: "ready", authorized: true, ranking: { inputModalities: ["text"], outputModalities: ["structured"], freshness: "realtime", evidence: "source_receipt" } } },
	];
	const agent = { state: { model: { id: "test" }, messages: [] } }; let listener;
	const runtime = createRuntime({
		taskLedger: ledger,
		turnUnderstanding: { understand: () => ({ action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest, "结果必须对应 qx-17 即时源快照"], uncertainties: [], memoryQuery: rawRequest, capabilityQuery: "qx-17 脉冲镜像", executionMode: "direct", confidence: 0.95 }) },
		workContractBuilder: { build: async () => ({ source: "model", cognitionBudgetChargeTokens: 1, semanticAdjudication: semanticReview, contract: { schemaVersion: "beemax.work-contract.v1", rawRequest, action: "create", objective: clause(rawRequest), constraints: [], prohibitions: [], acceptanceCriteria: [clause(rawRequest), clause("结果必须对应 qx-17 即时源快照")], capabilityRequirements: [clause("qx-17 脉冲镜像")], uncertainties: [], executionMode: "direct", confidence: 0.95 } }) },
		verifyObjectiveCandidate: async () => ({ accepted: true, evidence: "fixture verification" }),
		createAgent: async () => ({ agent, getAllTools: () => tools, getActiveToolNames: () => tools.map(({ name }) => name), setActiveToolsByName: () => undefined, subscribe: (callback) => { listener = callback; return () => undefined; }, prompt: async () => { await dispatchToolCall(agent, listener, { id: "qx17", name: "temporal_evidence_feed", result: { content: [{ type: "text", text: "source snapshot" }] } }); agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "qx-17 result" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined }),
	});
	await runtime.run({ source, text: rawRequest, timeoutMs: 1_000 });
	const [objective] = [...tasks.values()];
	assert.deepEqual({ requirements: objective.verificationRequirements, updates: requirementUpdates }, { requirements: [{ capability: "temporal_evidence_feed", freshness: "realtime", evidence: "source_receipt" }], updates: [{ ownerKey: objective.ownerKey, id: objective.id, requirements: [{ capability: "temporal_evidence_feed", freshness: "realtime", evidence: "source_receipt" }] }] });
	runtime.dispose();
});

test("a rejected Objective returns a blocker and fails its Task Run instead of returning the Candidate as completed", async () => {
	const source = { platform: "cli", chatId: "direct-rejected", chatType: "dm", userId: "local" };
	const tasks = new Map(); const runs = new Map();
	const ledger = {
		record(task) { tasks.set(task.id, { ...task }); }, transition(id, change) { tasks.set(id, { ...tasks.get(id), ...change }); return true; },
		recordRun(run) { runs.set(run.id, { ...run }); }, transitionRun(id, change) { runs.set(id, { ...runs.get(id), ...change }); return true; }, queryTasks: () => [],
	};
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({
		taskLedger: ledger,
		turnUnderstanding: { understand: (text) => ({ action: "create", goal: text, constraints: [], acceptanceCriteria: ["必须包含来源"], memoryQuery: text, capabilityQuery: text, executionMode: "direct", confidence: 0.9 }) },
		verifyObjectiveCandidate: async () => ({ accepted: false, feedback: "缺少来源证据" }),
		createAgent: async () => ({ agent, subscribe: () => () => undefined, prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "没有来源的草稿" }], usage: { input: 1, output: 1 } }]; }, abort: async () => undefined, dispose: () => undefined }),
	});
	const result = await runtime.run({ source, text: "生成带来源报告", timeoutMs: 1_000, executionEnvelope: createExecutionEnvelope({ executionId: "rejected", trigger: { kind: "interaction", id: "message" }, budget: { maxCorrectiveAttempts: 0 } }) });
	const [objective] = [...tasks.values()]; const [run] = [...runs.values()];
	assert.equal(objective.status, "failed"); assert.equal(objective.verificationStatus, "rejected");
	assert.equal(run.status, "failed"); assert.match(result.answer, /未通过独立 Verification/); assert.notEqual(result.answer, "没有来源的草稿");
	runtime.dispose();
});

test("an Automation Trigger enters the same durable Pi lifecycle as responsible interactive work", async () => {
	const source = { platform: "feishu", chatId: "scheduled-work", chatType: "dm", userId: "owner", threadId: "__automation:schedule:job" };
	const tasks = new Map();
	const runs = new Map();
	const completions = [];
	const ledger = {
		record(task) { tasks.set(task.id, { ...task }); },
		transition(id, change) { tasks.set(id, { ...tasks.get(id), ...change }); return true; },
		recordRun(run) { runs.set(run.id, { ...run }); },
		transitionRun(id, change) { runs.set(id, { ...runs.get(id), ...change }); return true; },
		queryTasks: () => [],
		checkpointTask(ownerKey, id, checkpoint) { const task = tasks.get(id); if (!task || task.ownerKey !== ownerKey) return false; tasks.set(id, { ...task, checkpoint }); return true; },
		isTaskRunExecutionActive: (_ownerKey, objectiveId, taskId, runId) => objectiveId === taskId && tasks.get(objectiveId)?.status === "running" && runs.get(runId)?.status === "running",
		settleDirectObjectiveCompletion(settlement) { return settleDirectObjectiveCompletion(tasks, runs, completions, settlement); },
	};
	const contextCalls = [];
	let receivedEnvelope;
	let receivedPrompt = "";
	let listener;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const triggerEnvelope = createExecutionEnvelope({ executionId: "automation:job:1700000000000", trigger: { kind: "automation", id: "schedule:job:1700000000000" }, budget: { deadlineAt: Date.now() + 10_000 }, mode: "normal" });
	const runtime = createRuntime({
		taskLedger: ledger,
		turnUnderstanding: { understand: (text) => ({ action: "create", goal: text, constraints: ["保留来源"], acceptanceCriteria: ["摘要包含来源"], memoryQuery: "相关历史摘要", capabilityQuery: text, executionMode: "direct", confidence: 0.88 }) },
		context: { assemble: (contextSource, text, options) => { contextCalls.push({ contextSource, ...options }); return { text: `${text}\n[recalled organization context]`, items: [], released: [], totalChars: text.length }; }, record: () => undefined },
		verifyObjectiveCandidate: async (objective, result, _signal, context) => {
			assert.equal(objective.situation.summary, "生成有来源的周期摘要");
			assert.equal(result.output, "摘要完成");
			assert.equal(context.taskRunId, receivedEnvelope.taskRunId);
			return { accepted: true, evidence: "来源已复核" };
		},
		createAgent: async () => { throw new Error("interactive factory must not run"); },
		createAutomationAgent: async (_id, _source, envelope) => {
			receivedEnvelope = envelope;
			return { agent, getAllTools: () => [{ name: "read", beemaxPolicy: { sideEffect: "none" } }], getActiveToolNames: () => ["read"], setActiveToolsByName: () => undefined, subscribe: (next) => { listener = next; return () => undefined; }, prompt: async (text) => {
				receivedPrompt = text;
				await dispatchToolCall(agent, listener, { id: "source", name: "read" });
				listener({ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] });
				listener({ type: "message_end", message: { role: "assistant", responseId: "response:automation-result", content: [{ type: "text", text: "摘要完成" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "摘要完成" }], usage: { input: 1, output: 1 } }];
			}, abort: async () => undefined, dispose: () => undefined };
		},
	});

	const result = await runtime.run({ source, text: "生成有来源的周期摘要", timeoutMs: 10_000, mode: "automation", executionEnvelope: triggerEnvelope, allowedCapabilities: ["read"] });

	assert.equal(tasks.size, 1);
	assert.equal(runs.size, 1);
	const [objective] = [...tasks.values()];
	assert.equal(objective.ownerKey, "feishu:scheduled-work:owner");
	assert.equal(objective.status, "running");
	assert.equal(objective.verificationStatus, "accepted");
	assert.equal(objective.candidateResult, "摘要完成");
	assert.deepEqual(completions, [{ ownerKey: objective.ownerKey, id: objective.id }]);
	assert.equal(result.completionId, `objective-completion:${objective.id}`);
	assert.equal(objective.checkpoint.source, "pi_turn");
	assert.deepEqual(objective.checkpoint.completed, ["read:source"]);
	assert.equal(contextCalls.length, 1);
	assert.equal(contextCalls[0].contextSource.threadId, undefined);
	assert.equal(contextCalls[0].situation.summary, "生成有来源的周期摘要");
	assert.match(receivedPrompt, /recalled organization context/);
	assert.equal(receivedEnvelope.executionId, triggerEnvelope.executionId);
	assert.deepEqual(receivedEnvelope.trigger, triggerEnvelope.trigger);
	assert.equal(receivedEnvelope.objectiveId, objective.id);
	assert.equal(receivedEnvelope.taskId, objective.id);
	assert.equal(receivedEnvelope.taskRunId, [...runs.values()][0].id);
	runtime.dispose();
});

test("an admitted proactive Objective executes through the same Pi Task Run, checkpoint, and Verification path", async () => {
	const source = { platform: "feishu", chatId: "proactive", chatType: "dm", userId: "owner", threadId: "__initiative:observation-1" };
	const objective = {
		id: "objective:initiative:observation-1", ownerKey: "feishu:proactive:owner", kind: "objective", title: "Inspect current evidence",
		description: "Read authoritative sources and prepare a bounded finding", acceptanceCriteria: "Finding cites current evidence",
		recoveryPolicy: "safe_retry", idempotencyKey: "initiative:observation-1", executionScope: source,
		status: "pending", createdAt: 1,
	};
	const tasks = new Map([[objective.id, objective]]);
	const runs = new Map();
	const completions = [];
	const ledger = {
		record() { assert.fail("admitted Objective must be reused"); },
		transition(id, change) { tasks.set(id, { ...tasks.get(id), ...change }); return true; },
		recordRun(run) { runs.set(run.id, { ...run }); },
		transitionRun(id, change) { runs.set(id, { ...runs.get(id), ...change }); return true; },
		queryTasks(query) { const task = tasks.get(query.id); return task && query.ownerKeys.includes(task.ownerKey) ? [task] : []; },
		checkpointTask(ownerKey, id, checkpoint) { const task = tasks.get(id); if (!task || task.ownerKey !== ownerKey) return false; tasks.set(id, { ...task, checkpoint }); return true; },
		isTaskRunExecutionActive: (_ownerKey, objectiveId, taskId, runId) => objectiveId === taskId && tasks.get(objectiveId)?.status === "running" && runs.get(runId)?.status === "running",
		settleDirectObjectiveCompletion(settlement) { return settleDirectObjectiveCompletion(tasks, runs, completions, settlement); },
	};
	let listener;
	let receivedEnvelope;
	let activeTools = ["read", "write"];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const executionEnvelope = createExecutionEnvelope({
		executionId: "initiative:observation-1", trigger: { kind: "enterprise_event", id: "event:1" },
		objectiveId: objective.id, taskId: objective.id, budget: { maxToolCalls: 4, maxTokens: 4_000, deadlineAt: Date.now() + 10_000, maxCorrectiveAttempts: 1 }, mode: "normal",
	});
	const runtime = createRuntime({
		taskLedger: ledger,
		workContractBuilder: { build: async () => { assert.fail("an admitted proactive Objective must not be reinterpreted as a new lifecycle command"); } },
		verifyObjectiveCandidate: async (_task, result) => ({ accepted: result.output === "Verified finding", evidence: "checked:source" }),
		createAgent: async () => { throw new Error("interactive Agent must not run"); },
		createAutomationAgent: async (_id, _source, envelope) => {
			receivedEnvelope = envelope;
			return { agent, getAllTools: () => [{ name: "read", beemaxPolicy: { sideEffect: "none" } }, { name: "write", beemaxPolicy: { sideEffect: "local" } }], getActiveToolNames: () => [...activeTools], setActiveToolsByName: (names) => { activeTools = [...names]; }, subscribe: (next) => { listener = next; return () => undefined; }, prompt: async () => {
				assert.deepEqual(activeTools, ["read"], "the proactive Turn must expose only admitted capabilities");
				await dispatchToolCall(agent, listener, { id: "source", name: "read" });
				listener({ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] });
				listener({ type: "message_end", message: { role: "assistant", responseId: "response:proactive-result", content: [{ type: "text", text: "Verified finding" }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } } });
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "Verified finding" }], usage: { input: 10, output: 5 } }];
			}, abort: async () => undefined, dispose: () => undefined };
		},
	});

	const result = await runtime.run({ source, text: objective.description, timeoutMs: 10_000, mode: "automation", objectiveTaskId: objective.id, executionEnvelope, allowedCapabilities: ["read"] });

	assert.equal(tasks.size, 1);
	assert.equal(tasks.get(objective.id).status, "running");
	assert.equal(tasks.get(objective.id).verificationStatus, "accepted");
	assert.equal(tasks.get(objective.id).candidateResult, "Verified finding");
	assert.deepEqual(completions, [{ ownerKey: objective.ownerKey, id: objective.id }]);
	assert.equal(result.completionId, `objective-completion:${objective.id}`);
	assert.equal(tasks.get(objective.id).checkpoint.source, "pi_turn");
	assert.equal(runs.size, 1);
	assert.equal([...runs.values()][0].status, "succeeded");
	assert.equal(receivedEnvelope.objectiveId, objective.id);
	assert.deepEqual(activeTools, ["read", "write"], "the session inventory must be restored after the bounded Turn");
	runtime.dispose();
});

test("a failed proactive Pi startup returns its durable Objective to recoverable pending state", async () => {
	const source = { platform: "feishu", chatId: "proactive-retry", chatType: "dm", userId: "owner" };
	const objective = { id: "objective:initiative:retry", ownerKey: "feishu:proactive-retry:owner", kind: "objective", title: "Inspect", status: "pending", recoveryPolicy: "safe_retry", idempotencyKey: "initiative:retry", createdAt: 1 };
	const tasks = new Map([[objective.id, objective]]);
	const ledger = {
		record() { assert.fail("existing Objective must be reused"); },
		transition(id, change) { tasks.set(id, { ...tasks.get(id), ...change }); return true; },
		queryTasks(query) { const task = tasks.get(query.id); return task && query.ownerKeys.includes(task.ownerKey) ? [task] : []; },
	};
	const runtime = createRuntime({
		taskLedger: ledger,
		createAgent: async () => { throw new Error("interactive Agent must not run"); },
		createAutomationAgent: async () => { throw new Error("temporary startup failure"); },
	});
	await assert.rejects(runtime.run({ source, text: "Inspect", timeoutMs: 1_000, mode: "automation", objectiveTaskId: objective.id }), /temporary startup failure/);
	assert.equal(tasks.get(objective.id).status, "pending");
	assert.match(tasks.get(objective.id).error, /temporary startup failure/);
	runtime.dispose();
});

test("Verification correction reuses the Objective and creates one bounded Corrective Task Run", async () => {
	const source = { platform: "cli", chatId: "direct-correction", chatType: "dm", userId: "local" };
	const tasks = new Map();
	const runs = new Map();
	const completions = [];
	const ledger = {
		record(task) { tasks.set(task.id, { ...task }); },
		transition(id, change) { tasks.set(id, { ...tasks.get(id), ...change }); return true; },
		recordRun(run) { runs.set(run.id, { ...run }); },
		transitionRun(id, change) { runs.set(id, { ...runs.get(id), ...change }); return true; },
		queryTasks: () => [],
		settleDirectObjectiveCompletion(settlement) { return settleDirectObjectiveCompletion(tasks, runs, completions, settlement); },
	};
	let prompts = 0;
	let verifications = 0;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({
		taskLedger: ledger,
		planningPolicy: new AutonomousPlanningPolicy(),
		turnUnderstanding: { understand: (text) => ({ action: "create", goal: text, constraints: [], acceptanceCriteria: ["包含来源"], memoryQuery: text, capabilityQuery: text, executionMode: "direct", confidence: 0.9 }) },
		verifyObjectiveCandidate: async (_objective, result) => ++verifications === 1 && result.output === "草稿" ? { accepted: false, feedback: "缺少来源" } : { accepted: true, evidence: "来源已检查" },
		createAgent: async () => ({
			agent, subscribe: () => () => undefined,
			prompt: async () => { prompts++; const text = prompts === 1 ? "草稿" : "已补充来源"; agent.state.messages = [{ role: "assistant", content: [{ type: "text", text }], usage: { input: 1, output: 1 } }]; },
			abort: async () => undefined, dispose: () => undefined,
		}),
	});

	await runtime.run({ source, text: "生成带来源的摘要", timeoutMs: 1_000 });

	assert.equal(prompts, 2);
	assert.equal(verifications, 2);
	assert.equal(tasks.size, 1);
	assert.equal(runs.size, 2);
	const [objective] = [...tasks.values()];
	assert.equal(objective.status, "running");
	assert.equal(objective.candidateResult, "已补充来源");
	assert.equal(objective.result, undefined);
	assert.deepEqual(completions, [{ ownerKey: objective.ownerKey, id: objective.id }]);
	assert.equal(objective.correctiveAttempts, 1);
	assert.deepEqual([...runs.values()].map(({ status, output }) => ({ status, output })), [
		{ status: "succeeded", output: "草稿" },
		{ status: "succeeded", output: "已补充来源" },
	]);
	runtime.dispose();
});

test("an explicit continuation Turn reuses the active Objective", async () => {
	const source = { platform: "cli", chatId: "continued-objective", chatType: "dm", userId: "local" };
	const active = { id: "objective", ownerKey: "cli:continued-objective:local", kind: "objective", title: "Report", status: "running", createdAt: 1 };
	const recorded = [];
	const ledger = {
		record(task) { recorded.push(task); }, transition() { return true; },
		queryTasks: (query) => query.ownerKeys.includes(active.ownerKey) && query.statuses?.includes("running") ? [active] : [],
	};
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({ taskLedger: ledger, planningPolicy: new AutonomousPlanningPolicy(), createAgent: async () => ({
		agent, subscribe: () => () => undefined,
		prompt: async () => { agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "Still running" }], usage: { input: 1, output: 1 } }]; },
		abort: async () => undefined, dispose: () => undefined,
	}) });
	await runtime.run({ source, text: "继续处理这个任务", timeoutMs: 1_000 });
	assert.equal(recorded.length, 0);
	assert.equal(active.status, "running");
	runtime.dispose();
});

test("planning budget leases cannot be cleared by a stale turn", () => {
	const registry = new PlanningBudgetRegistry();
	const policy = new AutonomousPlanningPolicy();
	const first = registry.begin("conversation", policy.decide("Review frontend and backend independently"));
	const second = registry.begin("conversation", policy.decide("Research one provider deeply"));
	assert.equal(registry.current("conversation")?.mode, "delegate");
	assert.equal(registry.end("conversation", first), false);
	assert.equal(registry.current("conversation")?.mode, "delegate");
	assert.equal(registry.end("conversation", second), true);
	assert.equal(registry.current("conversation"), undefined);
});

test("pre-prompt setup failure clears the planning lease and Task Run heartbeat", async () => {
	const source = { platform: "cli", chatId: "setup-cleanup", chatType: "dm", userId: "local" };
	const rawRequest = "Review frontend and backend independently";
	const clause = { text: rawRequest, source: { kind: "raw_request", start: 0, end: rawRequest.length } };
	const tasks = new Map();
	const runs = new Map();
	let renewals = 0;
	const planningBudgets = new PlanningBudgetRegistry();
	const runtime = createRuntime({
		taskRunLeaseMs: 300,
		planningPolicy: new AutonomousPlanningPolicy(),
		planningBudgets,
		turnUnderstanding: { understand: () => ({ action: "create", goal: rawRequest, constraints: [], acceptanceCriteria: [rawRequest], memoryQuery: rawRequest, capabilityQuery: rawRequest, executionMode: "direct", confidence: 0.9 }) },
		workContractBuilder: { build: async () => ({ source: "model", cognitionBudgetChargeTokens: 1, semanticAdjudication: semanticReview, contract: { schemaVersion: "beemax.work-contract.v1", rawRequest, action: "create", objective: clause, constraints: [], prohibitions: [], acceptanceCriteria: [clause], capabilityRequirements: [], uncertainties: [], executionMode: "direct", confidence: 0.99 } }) },
		taskLedger: {
			record(task) { tasks.set(task.id, { ...task }); },
			transition(id, change) { const task = tasks.get(id); if (!task) return false; tasks.set(id, { ...task, ...change }); return true; },
			queryTasks(query) { return [...tasks.values()].filter((task) => query.ownerKeys.includes(task.ownerKey) && (!query.id || task.id === query.id) && (!query.statuses || query.statuses.includes(task.status))); },
			recordRun(run) { runs.set(run.id, { ...run }); },
			transitionRun(id, change) { const run = runs.get(id); if (!run) return false; runs.set(id, { ...run, ...change }); return true; },
			renewTaskRunLease() { renewals++; return true; },
		},
		createAgent: async () => ({
			agent: { state: { model: { id: "test" }, messages: [] } },
			getAllTools: () => [{ name: "read", beemaxPolicy: { sideEffect: "none" } }],
			getActiveToolNames: () => ["read"], setActiveToolsByName: () => undefined,
			subscribe: () => () => undefined, prompt: async () => assert.fail("Pi prompt must not start"), abort: async () => undefined, dispose: () => undefined,
		}),
	});
	try {
		await assert.rejects(runtime.run({ source, text: rawRequest, timeoutMs: 1_000, allowedCapabilities: ["missing"] }), /unavailable Tools/);
		assert.equal(planningBudgets.current(conversationKey(source)), undefined);
		await new Promise((resolve) => setTimeout(resolve, 350));
		assert.equal(renewals, 0);
		assert.equal([...runs.values()][0]?.status, "failed");
	} finally { runtime.dispose(); }
});

test("Agent runtime aborts a turn that exceeds its planned tool-call budget", async () => {
	const source = { platform: "cli", chatId: "budget", chatType: "dm", userId: "local" };
	let listener;
	let aborts = 0;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({
		planningPolicy: new AutonomousPlanningPolicy({ maxToolCalls: 8 }),
		createAgent: async () => ({
			agent,
			getAllTools: () => [{ name: "read", beemaxPolicy: { sideEffect: "none" } }],
			getActiveToolNames: () => ["read"],
			setActiveToolsByName: () => undefined,
			subscribe: (next) => { listener = next; return () => undefined; },
			prompt: async () => {
				await admitToolCalls(agent, listener, Array.from({ length: 9 }, (_, index) => ({ id: `tool-${index}`, name: "read" })), "response:planned-budget");
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "should not succeed" }], usage: { input: 1, output: 1 } }];
			},
			abort: async () => { aborts++; },
			dispose: () => undefined,
		}),
	});
	await assert.rejects(runtime.run({ source, text: "Read this file", timeoutMs: 1_000, allowedCapabilities: ["read"] }), /tool-call budget exceeded.*8/i);
	assert.equal(aborts, 1);
	runtime.dispose();
});

test("Execution Envelope enforces tool-call budget without a planning policy", async () => {
	const source = { platform: "cli", chatId: "envelope-budget", chatType: "dm", userId: "local" };
	let listener;
	let aborts = 0;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({ createAgent: async () => ({
		agent, getAllTools: () => [{ name: "read", beemaxPolicy: { sideEffect: "none" } }], getActiveToolNames: () => ["read"], setActiveToolsByName: () => undefined, subscribe: (next) => { listener = next; return () => undefined; },
		prompt: async () => {
			await admitToolCalls(agent, listener, [{ id: "tool-1", name: "read" }, { id: "tool-2", name: "read" }], "response:envelope-budget");
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "over budget" }], usage: { input: 1, output: 1 } }];
		},
		abort: async () => { aborts++; }, dispose: () => undefined,
	}) });
	const executionEnvelope = createExecutionEnvelope({ executionId: "execution:bounded", trigger: { kind: "automation" }, budget: { maxToolCalls: 1 }, mode: "normal" });
	await assert.rejects(runtime.run({ source, text: "run", timeoutMs: null, mode: "automation", executionEnvelope, allowedCapabilities: ["read"] }), /tool-call budget exceeded.*1/i);
	assert.equal(aborts, 1);
	runtime.dispose();
});

test("Execution Envelope rejects an expired execution before Pi is prompted", async () => {
	const source = { platform: "cli", chatId: "expired-envelope", chatType: "dm", userId: "local" };
	let prompts = 0;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({ createAgent: async () => ({ agent, subscribe: () => () => undefined, prompt: async () => { prompts++; }, abort: async () => undefined, dispose: () => undefined }) });
	const executionEnvelope = createExecutionEnvelope({ executionId: "execution:expired", trigger: { kind: "automation" }, budget: { deadlineAt: Date.now() - 1 }, mode: "normal" });
	await assert.rejects(runtime.run({ source, text: "run", timeoutMs: null, mode: "automation", executionEnvelope }), /deadline.*expired/i);
	assert.equal(prompts, 0);
	runtime.dispose();
});

test("Agent runtime aborts a turn when cumulative model usage exceeds its token budget", async () => {
	const source = { platform: "cli", chatId: "tokens", chatType: "dm", userId: "local" };
	let listener;
	let aborts = 0;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({
		planningPolicy: new AutonomousPlanningPolicy({ maxTokens: 12_000 }),
		createAgent: async () => ({
			agent, subscribe: (next) => { listener = next; return () => undefined; },
			prompt: async () => {
				listener({ type: "message_end", message: { role: "assistant", content: [], usage: { input: 12_001, output: 0, cacheRead: 0, cacheWrite: 0 } } });
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "over budget" }], usage: { input: 12_001, output: 0 } }];
			},
			abort: async () => { aborts++; }, dispose: () => undefined,
		}),
	});
	await assert.rejects(runtime.run({ source, text: "Read this file", timeoutMs: 1_000 }), /token budget exceeded.*12000/i);
	assert.equal(aborts, 1);
	runtime.dispose();
});

test("Agent runtime token budget does not charge cached input a second time", async () => {
	const source = { platform: "cli", chatId: "cached-tokens", chatType: "dm", userId: "local" };
	let listener;
	let aborts = 0;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({
		planningPolicy: new AutonomousPlanningPolicy({ maxTokens: 12_000 }),
		createAgent: async () => ({
			agent, subscribe: (next) => { listener = next; return () => undefined; },
			prompt: async () => {
				listener({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "completed with cached context" }], usage: { input: 500, output: 250, cacheRead: 11_500, cacheWrite: 0 } } });
				agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "completed with cached context" }], usage: { input: 500, output: 250, cacheRead: 11_500, cacheWrite: 0 } }];
			},
			abort: async () => { aborts++; }, dispose: () => undefined,
		}),
	});
	const result = await runtime.run({ source, text: "Read this file", timeoutMs: 1_000 });
	assert.equal(result.answer, "completed with cached context");
	assert.equal(aborts, 0);
	runtime.dispose();
});

test("Agent runtime performs one content-free correction when a complex turn skips its required planner", async () => {
	const source = { platform: "cli", chatId: "planner", chatType: "dm", userId: "local" };
	let listener;
	const prompts = [];
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({ planningPolicy: new AutonomousPlanningPolicy(), createAgent: async () => ({
		agent, getAllTools: () => [{ name: "task_plan_execute", beemaxPolicy: { sideEffect: "local" } }], getActiveToolNames: () => ["task_plan_execute"], setActiveToolsByName: () => undefined, subscribe: (next) => { listener = next; return () => undefined; },
		prompt: async (text) => {
			prompts.push(text);
			if (prompts.length === 2) await dispatchToolCall(agent, listener, { id: "plan", name: "task_plan_execute", result: { details: { planId: "plan-1", accepted: true, status: "running" } } });
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } }];
		}, abort: async () => undefined, dispose: () => undefined,
	}) });
	await runtime.run({ source, text: "Review frontend and backend independently, then combine and verify the results", timeoutMs: 1_000, allowedCapabilities: ["task_plan_execute"] });
	assert.equal(prompts.length, 2);
	assert.match(prompts[1], /task_plan_execute/);
	assert.doesNotMatch(prompts[1], /frontend|backend/);
	runtime.dispose();
});

test("Agent runtime aborts repeated Task Plan rejection inside one live Pi turn and releases busy state", async () => {
	const source = { platform: "cli", chatId: "rejected-planner", chatType: "dm", userId: "local" };
	let listener;
	let aborts = 0;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	let activeTools = ["task_plan_execute"];
	const runtime = createRuntime({ planningPolicy: new AutonomousPlanningPolicy(), createAgent: async () => ({
		agent,
		getAllTools: () => [{ name: "task_plan_execute", beemaxPolicy: { sideEffect: "local" } }],
		getActiveToolNames: () => [...activeTools],
		setActiveToolsByName: (names) => { activeTools = [...names]; },
		subscribe: (next) => { listener = next; return () => undefined; },
		prompt: async () => {
			await admitToolCalls(agent, listener, [1, 2].map((attempt) => ({ id: `plan-${attempt}`, name: "task_plan_execute" })), "response:rejected-plans");
			for (let attempt = 1; attempt <= 2; attempt++) {
				listener({ type: "tool_execution_end", toolCallId: `plan-${attempt}`, toolName: "task_plan_execute", result: {}, isError: true });
			}
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "still trying" }], usage: { input: 1, output: 1 } }];
		},
		abort: async () => { aborts++; }, dispose: () => undefined,
	}) });
	await assert.rejects(runtime.run({ source, text: "Review frontend and backend independently, then combine and verify the results", timeoutMs: 1_000 }), /repeatedly failed required planning tool/i);
	assert.equal(aborts, 1);
	assert.equal(runtime.isBusy(), false);
	runtime.dispose();
});

test("delegated execution cannot finish after spawn without waiting for its Sub-Agent result", async () => {
	const source = { platform: "cli", chatId: "delegate", chatType: "dm", userId: "local" };
	let listener;
	let prompts = 0;
	const agent = { state: { model: { id: "test" }, messages: [] } };
	const runtime = createRuntime({ planningPolicy: new AutonomousPlanningPolicy(), createAgent: async () => ({
		agent, getAllTools: () => [{ name: "task_spawn", beemaxPolicy: { sideEffect: "local" } }, { name: "task_wait", beemaxPolicy: { sideEffect: "none" } }], getActiveToolNames: () => ["task_spawn", "task_wait"], setActiveToolsByName: () => undefined, subscribe: (next) => { listener = next; return () => undefined; },
		prompt: async () => {
			prompts++;
			if (prompts === 1) await dispatchToolCall(agent, listener, { id: "spawn", name: "task_spawn", result: { details: { id: "child-1", status: "queued" } } });
			agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "premature" }], usage: { input: 1, output: 1 } }];
		}, abort: async () => undefined, dispose: () => undefined,
	}) });
	await assert.rejects(runtime.run({ source, text: "Research the official documentation deeply and produce an evidence-backed comparison report", timeoutMs: 1_000, allowedCapabilities: ["task_spawn", "task_wait"] }), /required planning tools: task_wait/i);
	assert.equal(prompts, 2);
	runtime.dispose();
});
