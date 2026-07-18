#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	AuthStorage,
	AutonomousPlanningPolicy,
	BeeMaxAgentRuntime,
	FileExecutionTraceStore,
	PiWorkContractBuilder,
	buildBeeMaxRuntimeFactory,
	createAccessScopeRef,
	createExecutionEnvelope,
} from "../packages/core/dist/index.js";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { loadConfig } from "../apps/cli/dist/config.js";
import { resolveProfileCognitionModels } from "../apps/cli/dist/model-catalog.js";
import { adaptiveTurnAdmissionCases as cases } from "../evals/adaptive-turn-admission-corpus.mjs";
import { liveAdaptiveAdmissionImplementationDigest } from "./adaptive-turn-admission-evidence.mjs";

const args = process.argv.slice(2);
const profileIndex = args.indexOf("--profile");
const profile = profileIndex >= 0 ? args[profileIndex + 1]?.trim() : process.env.BEEMAX_PROFILE?.trim();
if (!profile) throw new Error("Live Adaptive Turn Admission evaluation requires --profile <name> or BEEMAX_PROFILE");

const config = loadConfig(undefined, profile);
const auth = AuthStorage.create(join(config.paths.agentDir, "auth.json"));
const candidates = await resolveProfileCognitionModels(config, async (provider) => auth.getApiKey(provider, { includeFallback: false }));
const authenticated = [];
for (const candidate of candidates) {
	const apiKey = candidate.apiKey ?? await candidate.getApiKey?.();
	if (apiKey) authenticated.push({ ...candidate, apiKey });
}
if (!authenticated.length) throw new Error(`Profile ${profile} has no authenticated text model for live Adaptive Turn Admission evaluation`);

const root = mkdtempSync(join(tmpdir(), "beemax-live-adaptive-admission-"));
const observations = [];
try {
	for (const scenario of cases) observations.push(await executeCase(scenario, authenticated, root));
} finally {
	rmSync(root, { recursive: true, force: true });
}

const failures = [];
for (const observation of observations) {
	if (observation.observedAdmissionLane !== observation.expectedBasis) failures.push(`${observation.id}: expected ${observation.expectedBasis}, observed ${observation.observedAdmissionLane ?? "none"}`);
	if (observation.planningBasis !== observation.expectedBasis) failures.push(`${observation.id}: planning event did not report ${observation.expectedBasis}`);
	if (observation.planningMode !== observation.expectedPlanningMode) failures.push(`${observation.id}: expected planning mode ${observation.expectedPlanningMode}, observed ${observation.planningMode ?? "none"}`);
	if (observation.expectedBasis === "raw_prompt" && observation.workContractCalls !== 0) failures.push(`${observation.id}: direct lane invoked Work Contract cognition`);
	if (observation.expectedBasis === "work_contract" && observation.workContractCalls < 1) failures.push(`${observation.id}: semantic Contract lane did not invoke Work Contract cognition`);
	if (observation.expectedBasis === "work_contract" && !observation.workContractAdmitted) failures.push(`${observation.id}: semantic Work Contract was not admitted`);
	if (observation.expectedBasis === "work_contract" && observation.workContractProviderTurns < 1) failures.push(`${observation.id}: semantic Contract lane lacks Provider evidence`);
	if (observation.runtimeFailure) failures.push(`${observation.id}: live Runtime failed: ${observation.runtimeFailure}`);
	if (!observation.answerChars) failures.push(`${observation.id}: live Pi returned no answer`);
	if (observation.totalTokens < 1) failures.push(`${observation.id}: live Pi returned no measured token usage`);
	if (observation.outcomeStatus !== "answered") failures.push(`${observation.id}: unexpected live outcome ${observation.outcomeStatus}`);
	const mainPiTokens = observation.mainPiProviderEvidence.reduce((total, turn) => total + turn.inputTokens + turn.outputTokens, 0);
	const declaredModels = new Set(authenticated.map((candidate) => `${candidate.model.provider}/${candidate.model.id}/${candidate.model.api}`));
	if (!observation.mainPiProviderEvidence.length || observation.mainPiProviderEvidence.some((turn) => !declaredModels.has(turn.modelIdentity) || turn.traceCorrelated !== true || turn.providerResponseStatus !== "reported" || !turn.providerResponseIdentitySha256)) failures.push(`${observation.id}: main Pi lacks model-bound Provider response identity evidence`);
	if (mainPiTokens + observation.workContractTokens !== observation.totalTokens) failures.push(`${observation.id}: main Pi, Contract cognition, and run token evidence do not reconcile`);
	if (observation.expectedBasis === "work_contract" && !observation.workContractProviderEvidence.some((turn) => turn.providerResponseStatus === "reported" && turn.providerResponseIdentitySha256 && turn.inputTokens + turn.outputTokens > 0)) failures.push(`${observation.id}: Work Contract lacks measured Provider response identity evidence`);
}

const direct = observations.filter((item) => item.expectedBasis === "raw_prompt");
const contracted = observations.filter((item) => item.expectedBasis === "work_contract");
const artifact = {
	schemaVersion: 1,
	generatedAt: new Date().toISOString(),
	profile,
	models: authenticated.map((candidate) => `${candidate.model.provider}/${candidate.model.id}/${candidate.model.api}`),
	implementationDigest: await liveAdaptiveAdmissionImplementationDigest(),
	cases: observations,
	metrics: {
		cases: observations.length,
		correct: observations.filter((item) => item.observedAdmissionLane === item.expectedBasis).length,
		accuracy: observations.filter((item) => item.observedAdmissionLane === item.expectedBasis).length / observations.length,
		directCases: direct.length,
		contractCases: contracted.length,
		averageDirectDurationMs: average(direct.map((item) => item.durationMs)),
		averageContractDurationMs: average(contracted.map((item) => item.durationMs)),
		totalRunTokens: observations.reduce((total, item) => total + item.totalTokens, 0),
		totalMainPiProviderTokens: observations.reduce((total, item) => total + item.mainPiProviderEvidence.reduce((sum, turn) => sum + turn.inputTokens + turn.outputTokens, 0), 0),
		totalWorkContractTokens: observations.reduce((total, item) => total + item.workContractTokens, 0),
		totalWorkContractProviderTurns: observations.reduce((total, item) => total + item.workContractProviderTurns, 0),
	},
	gate: { passed: failures.length === 0, failures },
};

const writeIndex = args.indexOf("--write");
if (writeIndex >= 0) {
	const path = args[writeIndex + 1]?.trim();
	if (!path) throw new Error("--write requires an artifact path");
	await writeFile(resolve(path), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}
if (!args.includes("--quiet")) process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
if (failures.length) process.exitCode = 1;

async function executeCase(scenario, modelCandidates, evaluationRoot) {
	const providerTurns = [];
	const liveModels = modelCandidates.map((candidate) => ({ model: candidate.model, apiKey: candidate.apiKey }));
	const workContractBuilder = new PiWorkContractBuilder({
		models: liveModels,
		complete: async (model, context, options) => {
			const startedAt = Date.now();
			const response = await completeSimple(model, context, options);
			providerTurns.push({
				model: `${model.provider}/${model.id}/${model.api}`,
				durationMs: Date.now() - startedAt,
				inputTokens: finite(response.usage?.input),
				outputTokens: finite(response.usage?.output),
				providerResponseStatus: response.responseId ? "reported" : "unavailable",
				...(response.responseId ? { providerResponseIdentitySha256: `sha256:${createHash("sha256").update(response.responseId).digest("hex")}` } : {}),
				contentSha256: `sha256:${createHash("sha256").update(JSON.stringify({ content: response.content, stopReason: response.stopReason })).digest("hex")}`,
			});
			return response;
		},
	});
	let workContractCalls = 0;
	let workContractAdmitted = false;
	const observedBuilder = { build: async (input) => {
		workContractCalls++;
		const built = await workContractBuilder.build(input);
		workContractAdmitted = true;
		return built;
	} };
	const primary = modelCandidates[0];
	const caseRoot = join(evaluationRoot, scenario.id);
	const trace = new FileExecutionTraceStore(join(caseRoot, "trace.jsonl"), 1_000);
	const factory = buildBeeMaxRuntimeFactory({
		provider: "custom",
		model: primary.model.id,
		baseUrl: primary.model.baseUrl,
		customProtocol: primary.model.api,
		modelLimits: { contextWindow: primary.model.contextWindow, maxTokens: primary.model.maxTokens },
		cwd: caseRoot,
		agentDir: join(caseRoot, "agent"),
		getApiKey: async (provider) => modelCandidates.find((candidate) => candidate.model.provider === provider)?.apiKey ?? primary.apiKey,
		additionalModelProviders: modelCandidates.map((candidate) => candidate.model.provider),
		systemPrompt: "You are the BeeMax live Adaptive Turn Admission evaluator. Answer the user's request concisely. Do not invent current facts or sources when no research Tool is available; state that limitation plainly.",
		skillToolset: "safe",
		tools: [],
		createTools: () => [],
	});
	const events = [];
	const runtime = new BeeMaxAgentRuntime({
		profileId: `profile:adaptive-admission:${scenario.id}`,
		interactiveAdmission: "model_first",
		fallbackModels: modelCandidates.slice(1).map((candidate) => candidate.model),
		maxModelFallbacks: Math.max(0, modelCandidates.length - 1),
		workContractBuilder: observedBuilder,
		planningPolicy: new AutonomousPlanningPolicy(),
		executionTrace: trace,
		createAgent: factory,
	});
	const startedAt = Date.now();
	const executionId = `execution:live-adaptive:${scenario.id}`;
	const accessScopeId = `scope:live-adaptive:${scenario.id}`;
	const accessScopeRef = createAccessScopeRef({ id: accessScopeId, authority: { kind: "enterprise_system", reference: "live-adaptive-evaluator" }, issuedAt: 1 });
	const executionEnvelope = createExecutionEnvelope({
		executionId,
		trigger: scenario.mode === "automation" ? { kind: "automation", id: `schedule:${scenario.id}` } : { kind: "interaction" },
		accessScopeRef,
		mode: "normal",
	});
	let result;
	let runtimeFailure;
	try {
		result = await runtime.run({
			source: { platform: "cli", chatId: `live-adaptive-${scenario.id}`, chatType: "dm", userId: "evaluator" },
			text: scenario.request,
			timeoutMs: null,
			mode: scenario.mode,
			accessScopeRef,
			executionEnvelope,
		}, (event) => events.push(event));
	} catch (error) {
		runtimeFailure = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
	} finally {
		runtime.dispose();
	}
	const decision = events.find((event) => event.type === "planning_decision");
	const execution = trace.trace({ executionId, accessScopeId });
	const traceTurns = (execution?.events ?? []).filter((event) => event.type === "model.turn_settled");
	const mainPiProviderEvidence = events.filter((event) => event.type === "message_end" && event.message.role === "assistant").map((event) => {
		const providerResponseIdentitySha256 = event.message.responseId ? `sha256:${createHash("sha256").update(event.message.responseId).digest("hex")}` : undefined;
		const traceTurn = traceTurns.find((turn) => turn.providerResponseIdentitySha256 === providerResponseIdentitySha256 && turn.inputTokens === event.message.usage.input && turn.outputTokens === event.message.usage.output);
		return {
			modelIdentity: `${event.message.provider}/${event.message.model}/${event.message.api}`,
			providerResponseStatus: providerResponseIdentitySha256 ? "reported" : "unavailable",
			providerResponseIdentitySha256,
			inputTokens: finite(event.message.usage.input),
			outputTokens: finite(event.message.usage.output),
			traceCorrelated: Boolean(traceTurn),
		};
	});
	return {
		id: scenario.id,
		request: scenario.request,
		mode: scenario.mode,
		expectedBasis: scenario.expectedBasis,
		expectedPlanningMode: scenario.expectedPlanningMode,
		observedAdmissionLane: workContractCalls > 0 ? "work_contract" : decision?.basis ?? "raw_prompt",
		planningBasis: decision?.basis,
		planningMode: decision?.mode,
		workContractCalls,
		workContractAdmitted,
		workContractProviderTurns: providerTurns.length,
		workContractTokens: providerTurns.reduce((total, turn) => total + turn.inputTokens + turn.outputTokens, 0),
		workContractProviderEvidence: providerTurns,
		model: result?.model,
		mainPiProviderEvidence,
		answerChars: result?.answer.length ?? 0,
		outcomeStatus: result?.outcome.status,
		inputTokens: finite(result?.usage.input_tokens),
		outputTokens: finite(result?.usage.output_tokens),
		totalTokens: finite(result?.usage.input_tokens) + finite(result?.usage.output_tokens),
		durationMs: Date.now() - startedAt,
		...(runtimeFailure ? { runtimeFailure } : {}),
	};
}

function finite(value) { return Number.isFinite(value) && value >= 0 ? value : 0; }
function average(values) { return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0; }
