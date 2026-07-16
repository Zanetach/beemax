import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { BeeMaxAgentRuntime, createSkillTools, createWebTools, ModelBackedSemanticCapabilityPort, SemanticCapabilityRanker } from "@beemax/core";
import { createProfileCapabilityProviderBundle } from "../dist/capability-provider-composition.js";
import { createProfile } from "../dist/profile-config.js";

const fixtureRoot = resolve("apps/cli/test/fixtures/cold-profile-root");
const hermeticMcporter = resolve("apps/cli/test/fixtures/hermetic-mcporter.mjs");
const execFileAsync = promisify(execFile);
const semanticAdjudication = Object.freeze({
	schemaVersion: "beemax.work-contract-adjudication.v1", inventorySchemaVersion: "beemax.semantic-inventory.v1",
	primaryModelIdentity: "fixture/contract/primary", reviewerModelIdentity: "fixture/contract/reviewer", reviewMode: "different_models", independentSamples: true,
	cognitionUsage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, modelIdentities: ["fixture/contract/primary", "fixture/contract/reviewer"] }, cognitionBudgetChargeTokens: 2,
});

test("a cold Profile installs a Skill, acquires its missing Provider, resumes the unchanged Objective, and verifies real receipts", async () => {
	const home = await mkdtemp(join(tmpdir(), "beemax-cold-fulfillment-home-"));
	const source = { platform: "cli", chatId: "cold-fulfillment", chatType: "dm", userId: "owner" };
	const rawRequest = "Create a hermetic current-source research brief and verify HERMETIC-SOURCE-42 without using remembered facts.";
	let runtime;
	try {
		const paths = await createProfile("cold", { home, root: fixtureRoot });
		const installedSkill = join(paths.homePath, "skills", "hermetic-research", "SKILL.md");
		assert.match(await readFile(installedSkill, "utf8"), /hermetic current-source research brief/i);
		assert.equal(await pathExists(join(paths.homePath, "providers", "exa-mcporter", "current")), false);

		const providerBundle = createProfileCapabilityProviderBundle({
			profileId: "cold", agentDir: paths.homePath,
			installation: { enabled: true, allowedProviders: ["exa-mcporter"] },
			environment: { PATH: process.env.PATH, LANG: "C.UTF-8" },
			runCommand: async (_command, args, options) => {
				assert.deepEqual(args, ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev"]);
				const destination = join(options.cwd, "node_modules", "mcporter", "dist", "cli.js");
				await mkdir(dirname(destination), { recursive: true });
				await cp(hermeticMcporter, destination);
			},
		});
		const webSearch = createWebTools({ env: providerBundle.environment }).find((tool) => tool.name === "web_search");
		assert.ok(webSearch);
		const capability = {
			name: webSearch.name, description: webSearch.description, parameters: webSearch.parameters, kind: "tool",
			aliases: webSearch.aliases, triggers: webSearch.triggers, providers: webSearch.providers,
			signals: webSearch.beemaxToolSpec?.ranking,
		};
		const capabilityRanker = new SemanticCapabilityRanker(new ModelBackedSemanticCapabilityPort(async ({ candidates, requirements, boundaries, contractDigest }) => {
			assert.deepEqual(boundaries, [{ kind: "prohibition", text: "without using remembered facts" }]);
			assert.match(contractDigest, /^sha256:[a-f0-9]{64}$/);
			return { matches: [
				{ id: candidates.find((candidate) => candidate.name === "hermetic-research").id, name: "hermetic-research", similarity: 0.99, requirementId: requirements[0].id, outcomeIndex: 0, necessity: "required" },
				{ id: candidates.find((candidate) => candidate.name === "web_search").id, name: "web_search", similarity: 0.99, requirementId: requirements[1].id, outcomeIndex: 0, necessity: "required" },
			] };
		}));
		const skillTools = createSkillTools(paths.homePath, () => undefined, [capability], undefined, [], undefined, capabilityRanker, undefined, undefined, providerBundle.runtime);
		const tools = new Map([...skillTools, webSearch].map((tool) => [tool.name, tool]));
		const evidence = {};
		let listener;
		let activeTools = [];
		const agent = { state: { model: { id: "fixture-model", input: ["text"], contextWindow: 32_000, maxTokens: 2_000 }, messages: [] } };
		const ledger = inMemoryLedger();
		const constraintText = "without using remembered facts";
		const constraintStart = rawRequest.indexOf(constraintText);
		const constraintClause = { text: constraintText, source: { kind: "raw_request", start: constraintStart, end: constraintStart + constraintText.length } };
		const outcomeText = "Create a hermetic current-source research brief and verify HERMETIC-SOURCE-42";
		const outcomeStart = rawRequest.indexOf(outcomeText);
		const outcomeClause = { text: outcomeText, source: { kind: "raw_request", start: outcomeStart, end: outcomeStart + outcomeText.length } };
		const researchText = "Create a hermetic current-source research brief";
		const researchStart = rawRequest.indexOf(researchText);
		const researchClause = { text: researchText, source: { kind: "raw_request", start: researchStart, end: researchStart + researchText.length } };
		const verificationText = "verify HERMETIC-SOURCE-42";
		const verificationStart = rawRequest.indexOf(verificationText);
		const verificationClause = { text: verificationText, source: { kind: "raw_request", start: verificationStart, end: verificationStart + verificationText.length } };
		runtime = new BeeMaxAgentRuntime({
			profileId: "profile:cold", taskLedger: ledger,
			turnUnderstanding: { understand: () => ({ action: "create", goal: rawRequest, constraints: ["without using remembered facts"], acceptanceCriteria: [outcomeText], uncertainties: [], memoryQuery: rawRequest, capabilityQuery: "hermetic current-source research brief", executionMode: "direct", confidence: 1 }) },
			workContractBuilder: { build: async () => ({ source: "model", cognitionBudgetChargeTokens: 2, semanticAdjudication, contract: { schemaVersion: "beemax.work-contract.v1", rawRequest, action: "create", objective: outcomeClause, constraints: [], prohibitions: [constraintClause], acceptanceCriteria: [outcomeClause], capabilityRequirements: [researchClause, verificationClause], uncertainties: [], executionMode: "direct", confidence: 1 } }) },
			planningPolicy: { decide: () => ({ mode: "direct", requiredTools: [], suggestedConcurrency: 1, budget: { maxSubagents: 0, maxToolCalls: 12, maxTokens: 8_000, maxCorrectiveAttempts: 0 }, signals: { substantialWork: true, requiresVerification: true }, reason: "hermetic fulfillment", directive: () => "Complete the unchanged Objective through the selected Skill and its declared Provider." }) },
			verifyObjectiveCandidate: async (_task, result, _signal, context) => {
				const successful = new Set(context?.successfulToolNames ?? []);
				const installedCli = join(paths.homePath, "providers", "exa-mcporter", "current", "node_modules", "mcporter", "dist", "cli.js");
				const independentlyFetched = await execFileAsync(process.execPath, [installedCli, "call", "exa.web_search_exa", "query=HERMETIC-SOURCE-42", "numResults=1"], { env: providerBundle.environment });
				const accepted = result.output.includes("HERMETIC-SOURCE-42") && independentlyFetched.stdout.includes("HERMETIC-SOURCE-42") && successful.has("web_search") && successful.has("skill_complete") && Boolean(evidence.acquisition?.details?.providerAcquisition?.installationReceipt?.evidenceRef);
				return { accepted, evidence: accepted ? "fixture-verification:HERMETIC-SOURCE-42" : undefined, feedback: accepted ? undefined : "missing acquired Provider, Skill, or source receipt" };
			},
			createAgent: async () => ({
				agent,
				getAllTools: () => [...tools.values()],
				getActiveToolNames: () => [...activeTools],
				setActiveToolsByName: (names) => { activeTools = [...names]; },
				subscribe: (next) => { listener = next; return () => undefined; },
				prompt: async () => {
					if (evidence.completed) return;
					evidence.activation = await execute("skill_activate", "activate", { name: "hermetic-research" });
					evidence.route = await execute("skill_route", "route", { route: "research" });
					evidence.module = await execute("skill_resource_read", "module", { path: "workflow.md" });
					evidence.reference = await execute("skill_resource_read", "reference", { path: "references/source-policy.md" });
					evidence.acquisition = await execute("capability_acquire", "acquire", { capability: "web_search" });
					evidence.search = await execute("web_search", "search", { query: "HERMETIC-SOURCE-42", maxResults: 1 });
					evidence.completed = await execute("skill_complete", "complete", {});
					agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "Verified HERMETIC-SOURCE-42 from https://example.com/hermetic-source-42 without weakening the Objective." }], usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } }];
					listener({ type: "message_end", message: { role: "assistant", responseId: "response:final", content: [{ type: "text", text: "Verified HERMETIC-SOURCE-42 from https://example.com/hermetic-source-42 without weakening the Objective." }], usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
				},
				abort: async () => undefined,
				dispose: () => undefined,
			}),
		});

		async function execute(name, toolCallId, args) {
			const tool = tools.get(name); assert.ok(tool, `missing Tool ${name}`);
			listener({ type: "message_end", message: { role: "assistant", responseId: `response:${toolCallId}`, content: [{ type: "toolCall", id: toolCallId, name, arguments: args }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
			const signal = new AbortController().signal;
			listener({ type: "tool_execution_start", toolCallId, toolName: name, args });
			const boundary = await agent.beforeToolCall?.({ toolCall: { id: toolCallId, name, arguments: args }, args, context: {} }, signal);
			assert.notEqual(boundary?.block, true, boundary?.reason);
			const result = await tool.execute(toolCallId, args, signal);
			listener({ type: "tool_execution_end", toolCallId, toolName: name, isError: Boolean(result?.isError), result });
			return result;
		}

		const result = await runtime.run({ source, text: rawRequest, timeoutMs: 10_000 });
		assert.match(result.answer, /HERMETIC-SOURCE-42/);
		assert.equal(evidence.route.details.providerResolutions[0].status, "blocked");
		assert.equal(evidence.route.details.providerResolutions[0].candidates.some((candidate) => candidate.id === "exa-mcporter" && candidate.installable), true);
		assert.equal(evidence.module.details.kind, "module");
		assert.match(evidence.module.details.sha256, /^[a-f0-9]{64}$/);
		assert.equal(evidence.reference.details.kind, "reference");
		assert.match(evidence.reference.details.sha256, /^[a-f0-9]{64}$/);
		assert.equal(evidence.acquisition.details.providerAcquisition.status, "ready");
		assert.match(evidence.acquisition.details.providerAcquisition.installationReceipt.evidenceRef, /^sha256:[a-f0-9]{64}$/);
		assert.equal(evidence.search.details.provider, "exa-mcporter");
		assert.match(evidence.search.content[0].text, /HERMETIC-SOURCE-42/);
		assert.equal(evidence.completed.details.skillLifecycleReceipt.phase, "completed");
		assert.equal(ledger.completed.length, 1);
		assert.match(ledger.completed[0].evidence, /fixture-verification/);
		assert.equal(await pathExists(join(paths.homePath, "providers", "exa-mcporter", "current", "beemax-provider.json")), true);
	} finally {
		runtime?.dispose();
		await rm(home, { recursive: true, force: true });
	}
});

function inMemoryLedger() {
	const tasks = new Map(); const runs = new Map(); const completed = [];
	return {
		completed,
		record(task) { tasks.set(task.id, { ...task }); },
		transition(id, change) { const task = tasks.get(id); if (!task) return false; tasks.set(id, { ...task, ...change }); return true; },
		recordRun(run) { runs.set(run.id, { ...run }); },
		transitionRun(id, change) { const run = runs.get(id); if (!run) return false; runs.set(id, { ...run, ...change }); return true; },
		queryTasks(query) { return [...tasks.values()].filter((task) => query.ownerKeys.includes(task.ownerKey) && (!query.id || task.id === query.id)).slice(0, query.limit ?? 100); },
		taskRuns(taskId) { return [...runs.values()].filter((run) => run.taskId === taskId); },
		isTaskRunExecutionActive(ownerKey, objectiveId, taskId, taskRunId, now) {
			const task = tasks.get(taskId); const run = runs.get(taskRunId);
			return objectiveId === taskId && task?.ownerKey === ownerKey && task.status === "running" && run?.taskId === taskId && run.status === "running" && (run.leaseExpiresAt ?? 0) > now;
		},
		checkpointTask() { return true; },
		settleDirectObjectiveCompletion(settlement) {
			const task = tasks.get(settlement.objectiveId); const run = runs.get(settlement.taskRunId);
			if (!task || task.ownerKey !== settlement.ownerKey || task.status !== "running" || !run || run.taskId !== task.id || run.status !== "running") return false;
			tasks.set(task.id, { ...task, status: "running", candidateResult: settlement.candidateResult, evidence: settlement.evidence, verificationStatus: "accepted" });
			runs.set(run.id, { ...run, status: "succeeded", output: settlement.candidateResult, finishedAt: Date.now() });
			completed.push({ ...settlement }); return true;
		},
	};
}

async function pathExists(path) { try { await readFile(path); return true; } catch { return false; } }
