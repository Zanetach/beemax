import { createHash } from "node:crypto";

const CAPABILITY_ALIASES = Object.freeze({
	web_search: ["web_search", "search_query", "browser_search", "browser.search", "web.search"],
	document_write: ["document_write", "write", "apply_patch", "file_write"],
	file_read: ["file_read", "read", "read_file"],
	research_skill: ["research_skill", "activate_skill", "skill_activate", "skill_read", "skill_route"],
	status_mcp: ["status_mcp", "mcp_status", "mcp.call", "status"],
	image_understand: ["image_understand", "vision", "ocr", "tesseract", "inspect_image"],
	task_plan: ["task_plan", "task_plan_create", "update_plan"],
	task_recover: ["task_recover", "task_resume", "checkpoint_read", "recover_step"],
	effect_reconcile: ["effect_reconcile", "effect_status"],
	message_deliver: ["message_deliver", "send_message", "delivery_send", "deliver"],
	memory_recall: ["memory_recall", "memory_search"],
	schedule_run: ["schedule_run", "cron_run", "schedule_delivery"],
	structured_tool: ["structured_tool", "structured_lookup"],
	source_read_a: ["source_read_a", "read_source_a"],
	source_read_b: ["source_read_b", "read_source_b"],
});
const EVIDENCE_BY_CAPABILITY = Object.freeze({
	web_search: ["source"], research_skill: ["skill"], status_mcp: ["source"], source_read_a: ["source"], source_read_b: ["source"],
	document_write: ["artifact", "filesystem"], file_read: ["filesystem"], image_understand: ["artifact"],
	task_plan: ["checkpoint"], task_recover: ["checkpoint"], schedule_run: ["checkpoint", "delivery"], effect_reconcile: ["effect"],
	message_deliver: ["delivery"], memory_recall: ["scope"], structured_tool: ["tool"],
});

export function parseCodexEvidence(input) {
	const events = parseJsonLines(input.stdout);
	const byId = new Map();
	for (const event of events) {
		const item = event?.item;
		if (!item?.id || !isToolItem(item)) continue;
		const parsedArguments = parsedToolArguments(item);
		const current = byId.get(item.id) ?? { rawName: toolName(item), argumentsValid: parsedArguments.valid ? null : false, status: "started", argumentEvidence: argumentEvidence(parsedArguments.value) };
		if (event.type === "item.completed") {
			current.status = codexToolSucceeded(item) ? "succeeded" : "failed";
			if (current.status === "succeeded") current.argumentsValid = true;
		}
		byId.set(item.id, current);
	}
	const usage = [...events].reverse().find((event) => event.type === "turn.completed")?.usage ?? {};
	const attempted = [...byId.values()];
	const observedToolSourceRefs = events.filter((event) => event.type === "item.completed" && isToolItem(event.item) && codexToolSucceeded(event.item)).flatMap((event) => publicSourceRefs(JSON.stringify(event.item)));
	const sourceRefs = [...new Set(input.scenario.outputContract.minPublicSources > 0 ? (input.validatedSourceRefs ?? []) : [...observedToolSourceRefs, ...(input.validatedSourceRefs ?? [])])];
	const answer = events.filter((event) => event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string").map((event) => event.item.text).join("\n").trim();
	const result = resultFromEvidence(input, {
		status: input.exitCode === 0 && answer ? "succeeded" : "failed", answer,
		inputTokens: finite(usage.input_tokens), outputTokens: finite(usage.output_tokens),
		calls: attempted, duplicateEffects: input.fixtureEvidence?.duplicateEffects ?? null, sourceRefs,
	});
	result.evidenceRefs = { kind: "codex_jsonl", threadId: events.find((event) => event.type === "thread.started")?.thread_id, sha256: digest(input.stdout), sources: publicSourceRefs(input.stdout), fixture: input.fixtureEvidence?.refs ?? [] };
	return result;
}

export function codexSuccessfulToolSourceMaterial(stdout) {
	return parseJsonLines(stdout).filter((event) => event.type === "item.completed" && isToolItem(event.item) && codexToolSucceeded(event.item)).map((event) => JSON.stringify(event.item)).join("\n");
}

export function parseHermesEvidence(input) {
	const calls = [];
	const toolResults = input.messages.filter((message) => message.role === "tool");
	const resultsById = new Map(toolResults.filter((message) => message.toolCallId).map((message) => [message.toolCallId, message]));
	const anonymousResults = toolResults.filter((message) => !message.toolCallId);
	const successfulResults = new Set(toolResults.filter(hermesToolResultSucceeded));
	let anonymousResultIndex = 0;
	for (const message of input.messages) {
		for (const call of parseToolCalls(message.toolCalls)) {
			const rawName = call.function?.name ?? call.name;
			if (!rawName) continue;
			const args = call.function?.arguments ?? call.arguments;
			const resultMessage = call.id ? resultsById.get(call.id) : matchingAnonymousResult(anonymousResults, rawName, anonymousResultIndex);
			if (!call.id && resultMessage) anonymousResultIndex = anonymousResults.indexOf(resultMessage) + 1;
			const status = !resultMessage ? "started" : successfulResults.has(resultMessage) ? "succeeded" : "failed";
			const syntacticallyValid = validJsonArguments(args);
			calls.push({ rawName, argumentsValid: status === "succeeded" ? syntacticallyValid : syntacticallyValid ? null : false, status, argumentEvidence: argumentEvidence(parseArguments(args)) });
		}
	}
	const result = resultFromEvidence(input, {
		status: input.exitCode === 0 && input.stdout.trim() && input.session?.endReason !== "failed" ? "succeeded" : "failed",
		inputTokens: finite(input.session?.inputTokens), outputTokens: finite(input.session?.outputTokens),
		calls, duplicateEffects: input.fixtureEvidence?.duplicateEffects ?? null, answer: input.stdout,
		sourceRefs: [...new Set(input.scenario.outputContract.minPublicSources > 0 ? (input.validatedSourceRefs ?? []) : [...toolResults.filter((message) => successfulResults.has(message)).flatMap((message) => publicSourceRefs(message.content)), ...(input.validatedSourceRefs ?? [])])],
	});
	result.evidenceRefs = { kind: "hermes_session", sessionId: input.session?.id, sha256: digest(JSON.stringify(input.messages)), sources: publicSourceRefs(JSON.stringify(input.messages)), fixture: input.fixtureEvidence?.refs ?? [] };
	return result;
}

export function hermesSuccessfulToolSourceMaterial(messages) {
	return (messages ?? []).filter((message) => message.role === "tool" && hermesToolResultSucceeded(message)).map((message) => String(message.content ?? "")).join("\n");
}

export function parseBeeMaxEvidence(input) {
	const executionEvents = input.executionTrace.filter((event) => event.triggerKind !== "verification");
	const callKey = (event) => `${event.executionId ?? "unknown"}:${event.toolCallId}`;
	const started = new Map(executionEvents.filter((event) => event.type === "tool.started" && event.toolCallId).map((event) => [callKey(event), event]));
	const settledById = new Map(executionEvents.filter((event) => event.type === "tool.settled" && event.toolCallId).map((event) => [callKey(event), event]));
	const calls = [...started.entries()].map(([key, event]) => ({
		rawName: event.toolName,
		argumentsValid: settledById.get(key)?.status === "succeeded" ? true : null,
		status: settledById.get(key)?.status === "succeeded" ? "succeeded" : settledById.has(key) ? "failed" : "started",
		argumentEvidence: { kind: "diagnostic_trace_correlation", reference: key },
	}));
	const objective = input.tasks.find((task) => !task.parentId) ?? input.tasks[0];
	const turn = [...input.interactionEvents].reverse().find((event) => event.type === "turn.finished");
	const usage = turn?.result?.usage ?? {};
	const modelTurns = input.executionTrace.filter((event) => event.type === "model.turn_settled");
	const inputTokens = modelTurns.length ? modelTurns.reduce((total, event) => total + finite(event.inputTokens), 0) : finite(usage.input_tokens);
	const outputTokens = modelTurns.length ? modelTurns.reduce((total, event) => total + finite(event.outputTokens), 0) : finite(usage.output_tokens);
	let status = "blocked";
	if (input.exitCode !== 0 || objective?.verificationOutcome === "rejected" || objective?.status === "failed") status = "failed";
	else if (objective?.verificationOutcome === "accepted" && objective?.status === "succeeded") status = "succeeded";
	else if (!objective && input.scenario.requiredCapabilities.length === 0 && input.scenario.requiredEvidenceKinds.length === 0 && input.stdout.trim()) status = "succeeded";
	const committedEffects = input.effects.filter((effect) => effect.status === "committed");
	const sourceRefs = input.scenario.outputContract.minPublicSources > 0 ? (input.validatedSourceRefs ?? []) : [...new Set([...publicSourceRefs(objective?.evidence), ...(input.validatedSourceRefs ?? [])])];
	const result = resultFromEvidence(input, { status, inputTokens, outputTokens, calls, duplicateEffects: input.fixtureEvidence ? input.fixtureEvidence.duplicateEffects : committedEffects.length - new Set(committedEffects.map((effect) => effect.id)).size, answer: objective?.result ?? input.stdout, sourceRefs, recovered: input.scenario.id === "provider-failure-recovery" ? status === "succeeded" && Boolean(objective?.checkpoint) : null });
	result.evidenceKinds = [...new Set([...beeMaxAuthorityEvidenceKinds(objective, input.effects, calls.filter((call) => call.status === "succeeded")), ...(input.fixtureEvidence?.kinds ?? [])])];
	if (input.scenario.outputContract.minPublicSources > 0 && sourceRefs.length < input.scenario.outputContract.minPublicSources) result.evidenceKinds = result.evidenceKinds.filter((kind) => kind !== "source");
	if (!objective && result.status === "blocked" && input.exitCode === 0 && input.stdout.trim() && result.outcomeVerified
		&& input.scenario.requiredCapabilities.every((capability) => result.toolCalls.some((call) => call.name === capability && call.status === "succeeded"))
		&& input.scenario.requiredEvidenceKinds.every((kind) => result.evidenceKinds.includes(kind))) {
		result.status = "succeeded";
		result.objectiveDegraded = false;
	}
	result.evidenceRefs = {
		kind: "beemax_durable_authorities",
		turnId: turn?.turnId,
		task: objective ? { id: objective.id, status: objective.status, verificationOutcome: objective.verificationOutcome, ...(objective.error ? { error: String(objective.error).slice(0, 2_000) } : {}), ...(objective.verificationFeedback ? { verificationFeedback: String(objective.verificationFeedback).slice(0, 2_000) } : {}), sha256: digest(JSON.stringify(objective)) } : undefined,
		effects: input.effects.map((effect) => ({ id: effect.id, status: effect.status, sha256: digest(effect.recordJson) })),
		sources: publicSourceRefs(objective?.evidence),
		fixture: input.fixtureEvidence?.refs ?? [],
		diagnosticTraceSha256: digest(JSON.stringify([...input.interactionEvents, ...input.executionTrace])),
	};
	if (status !== "succeeded" && objective?.error) result.error = String(objective.error).slice(0, 2_000);
	return result;
}

function resultFromEvidence(input, evidence) {
	const toolCalls = evidence.calls.map((call) => normalizeCall(call, input.scenario));
	const authorityCorrelationFailures = fixtureAuthorityCorrelationFailures(input.fixtureEvidence, toolCalls);
	const trustedFixtureEvidence = authorityCorrelationFailures.length ? undefined : input.fixtureEvidence;
	let evidenceKinds = [...new Set([...evidenceKindsFor(toolCalls.filter((call) => call.status === "succeeded").map((call) => call.name)), ...(trustedFixtureEvidence?.kinds ?? [])])];
	if (input.scenario.outputContract.minPublicSources > 0 && (evidence.sourceRefs?.length ?? 0) < input.scenario.outputContract.minPublicSources) evidenceKinds = evidenceKinds.filter((kind) => kind !== "source");
	const status = authorityCorrelationFailures.length ? "failed" : evidence.status;
	const outcomeVerified = verifyOutput(input.scenario.outputContract, evidence.answer, trustedFixtureEvidence, evidence.sourceRefs ?? []);
	return {
		status,
		durationMs: Math.max(0, finite(input.durationMs)),
		inputTokens: evidence.inputTokens,
		outputTokens: evidence.outputTokens,
		toolCalls,
		evidenceKinds,
		userInterventions: 0,
		duplicateEffects: evidence.duplicateEffects,
		objectiveDegraded: status === "succeeded" && !outcomeVerified,
		outcomeVerified,
		recovered: input.scenario.facets.includes("recovery") ? evidence.recovered ?? (input.scenario.id === "provider-failure-recovery" && input.fixtureEvidence?.kinds.includes("checkpoint") && evidence.status === "succeeded" ? true : null) : undefined,
		...(input.stderr?.trim() ? { error: evidence.status === "failed" ? input.stderr.trim().slice(0, 2_000) : undefined } : {}),
		...(authorityCorrelationFailures.length ? { error: `Fixture authority correlation failed: ${authorityCorrelationFailures.join(", ")}` } : {}),
	};
}

function fixtureAuthorityCorrelationFailures(fixtureEvidence, toolCalls) {
	const authority = fixtureEvidence?.refs?.filter((ref) => ref.kind === "fixture_authority") ?? [];
	if (!authority.length) return [];
	const failures = [];
	const called = (name, statuses = ["succeeded"]) => toolCalls.some((call) => statuses.includes(call.status) && (normalizedToolName(call.rawName).endsWith(`_${name}`) || normalizedToolName(call.rawName) === name));
	for (const ref of authority) {
		let supported = false;
		if (ref.eventKind === "source_read" && ref.id === "MCP-STATUS-READY") supported = called("status");
		else if (ref.eventKind === "source_read" && ref.id === "SOURCE-A-ROUTING") supported = called("read_source_a");
		else if (ref.eventKind === "source_read" && ref.id === "SOURCE-B-VERIFY") supported = called("read_source_b");
		else if (ref.eventKind === "artifact_inspected" && ref.id === "IMAGE-42") supported = called("inspect_image");
		else if (ref.eventKind === "skill_activated" && ref.id === "SKILL-evaluation-research-v1") supported = called("activate_skill");
		else if (ref.eventKind === "scope_checked" && ref.id === "PROFILE-TARGET-ISOLATED") supported = called("memory_recall");
		else if (ref.eventKind === "effect_attempted" || ref.eventKind === "effect_committed") supported = called("send_unknown", ["succeeded", "failed"]);
		else if (ref.eventKind === "effect_reconciled") supported = called("effect_status");
		else if (ref.eventKind === "checkpoint_saved" && ref.id === "RECOVERY-CHECKPOINT-1") supported = called("recover_step", ["succeeded", "failed"]);
		else if (ref.eventKind === "checkpoint_saved" && ref.id === "SCHEDULE-CHECKPOINT-1") supported = called("schedule_delivery");
		else if (ref.eventKind === "delivery_committed" && ref.id === "SCHEDULE-DELIVERY-1") supported = called("schedule_delivery");
		else if (ref.eventKind === "delivery_committed") supported = called("deliver");
		if (!supported) failures.push(`${ref.eventKind}:${ref.id}`);
	}
	return failures;
}

function normalizedToolName(value) { return String(value).normalize("NFKC").toLocaleLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""); }

function normalizeCall(call, scenario) {
	const normalized = String(call.rawName).normalize("NFKC").toLocaleLowerCase();
	const capability = scenario.requiredCapabilities.find((required) => required === normalized || (CAPABILITY_ALIASES[required] ?? []).some((alias) => normalized === alias || normalized.endsWith(`.${alias}`) || normalized.endsWith(`__${alias}`) || normalized.endsWith(`_${alias}`)));
	return { name: capability ?? normalized, rawName: String(call.rawName), status: call.status ?? "succeeded", argumentsValid: call.argumentsValid === true ? true : call.argumentsValid === false ? false : null, required: capability || isRoutingControl(normalized) ? true : null, argumentEvidence: call.argumentEvidence };
}

function evidenceKindsFor(names) {
	const kinds = new Set();
	for (const value of names) {
		for (const kind of EVIDENCE_BY_CAPABILITY[value] ?? []) kinds.add(kind);
		kinds.add("tool");
	}
	return [...kinds];
}

function beeMaxAuthorityEvidenceKinds(task, effects, calls) {
	const kinds = new Set(calls.length ? ["tool"] : []);
	if (task?.evidence) kinds.add("source");
	if (task?.artifacts) { kinds.add("artifact"); kinds.add("filesystem"); }
	if (task?.checkpoint) kinds.add("checkpoint");
	if (task?.accessScopeRef) kinds.add("scope");
	if (task?.verificationOutcome === "accepted") kinds.add("verification");
	if (task?.effectReceipts || effects.length) kinds.add("effect");
	return [...kinds];
}

function parseJsonLines(value) { return String(value).split(/\r?\n/).flatMap((line) => { try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; } }); }
function parseToolCalls(value) { if (Array.isArray(value)) return value; if (typeof value !== "string" || !value.trim()) return []; try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }
function parseArguments(value) { if (value && typeof value === "object") return value; if (typeof value !== "string" || !value.trim()) return {}; try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" ? parsed : {}; } catch { return {}; } }
function validJsonArguments(value) { if (value === undefined || value === null || typeof value === "object") return true; try { JSON.parse(value); return true; } catch { return false; } }
function toolArguments(item) {
	if (item.arguments !== undefined) return parseArguments(item.arguments);
	const { id: _id, type: _type, status: _status, name: _name, tool_name: _toolName, tool: _tool, server: _server, result: _result, error: _error, ...args } = item;
	return args;
}
function parsedToolArguments(item) {
	if (typeof item.arguments === "string") {
		try { const value = JSON.parse(item.arguments); return { valid: Boolean(value) && typeof value === "object", value: Boolean(value) && typeof value === "object" ? value : {} }; }
		catch { return { valid: false, value: {} }; }
	}
	return { valid: true, value: toolArguments(item) };
}
function argumentEvidence(value) { const normalized = value && typeof value === "object" ? value : {}; return { kind: "sanitized_argument_shape", keys: Object.keys(normalized).sort(), sha256: digest(JSON.stringify(normalized)) }; }
function verifyOutput(contract, answer, fixtureEvidence, sourceRefs) {
	if (!contract) return false;
	const normalized = String(answer ?? "").normalize("NFKC").toLocaleLowerCase();
	const facts = fixtureEvidence?.facts ?? {};
	const answerSources = publicSourceRefs(answer, true);
	const receiptSources = new Set(sourceRefs.map(sourceIdentity));
	const boundSources = answerSources.filter((url) => receiptSources.has(sourceIdentity(url)));
	const independentDomains = new Set(boundSources.flatMap((value) => { try { return [registrableDomain(new URL(value).hostname)]; } catch { return []; } }));
	return contract.requiredAnyGroups.every((group) => group.some((term) => normalized.includes(term.toLocaleLowerCase())))
		&& !contract.forbidden.some((term) => normalized.includes(term.toLocaleLowerCase()))
		&& independentDomains.size >= contract.minPublicSources
		&& contract.requiredAuthorityIds.every((id) => facts.authorityIds?.includes(id))
		&& Object.entries(contract.requiredFacts).every(([key, value]) => facts[key] === value)
		&& Object.entries(contract.minimumFacts).every(([key, value]) => Number(facts[key]) >= Number(value));
}
function sourceIdentity(value) {
	try {
		const url = new URL(value);
		url.username = ""; url.password = ""; url.hash = "";
		for (const key of [...url.searchParams.keys()]) if (/^(?:utm_.+|gclid|fbclid|msclkid)$/i.test(key)) url.searchParams.delete(key);
		url.searchParams.sort();
		url.pathname = url.pathname.replace(/\/+$/, "") || "/";
		return url.toString();
	} catch { return String(value); }
}
function isToolItem(item) { return !["agent_message", "reasoning", "error", "plan"].includes(item.type); }
function codexToolSucceeded(item) {
	if (!item || containsToolError(item)) return false;
	if (["failed", "error", "cancelled", "canceled"].includes(String(item.status ?? "").toLocaleLowerCase())) return false;
	return item.status === undefined || ["completed", "succeeded"].includes(item.status) || item.exit_code === 0;
}
function matchingAnonymousResult(results, rawName, start) {
	const normalized = normalizedToolName(rawName);
	return results.slice(start).find((message) => !message.toolName || normalizedToolName(message.toolName) === normalized);
}
function hermesToolResultSucceeded(message) {
	if (!message || containsToolError(message)) return false;
	const text = String(message.content ?? "").trim();
	if (!text) return true;
	try {
		const parsed = JSON.parse(text);
		return !containsToolError(parsed);
	} catch { return !/^\s*(?:error|tool_error)\s*:/i.test(text); }
}
function containsToolError(value) {
	const pending = [value];
	const seen = new WeakSet();
	let visited = 0;
	while (pending.length) {
		const current = pending.pop();
		if (++visited > 10_000) return true;
		if (typeof current === "string") {
			if (/^\s*(?:(?:error|tool_error)\s*:|error\s+executing\s+tool\b)/i.test(current)) return true;
			continue;
		}
		if (!current || typeof current !== "object") continue;
		if (seen.has(current)) continue;
		seen.add(current);
		if (current.isError === true || current.is_error === true || current.error || ["failed", "error", "cancelled", "canceled"].includes(String(current.status ?? "").toLocaleLowerCase())) return true;
		pending.push(...Object.values(current));
	}
	return false;
}
function registrableDomain(hostname) {
	const parts = String(hostname).toLocaleLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
	if (parts.length <= 2) return parts.join(".");
	const suffix = parts.slice(-2).join(".");
	const commonSecondLevelSuffixes = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.cn", "net.cn", "org.cn", "gov.cn", "com.au", "net.au", "org.au", "co.jp", "co.kr", "co.nz", "com.br", "com.sg", "com.hk"]);
	return parts.slice(commonSecondLevelSuffixes.has(suffix) ? -3 : -2).join(".");
}
function toolName(item) { return item.name ?? item.tool_name ?? item.tool ?? item.type; }
function isRoutingControl(name) { return /^(capability_discover|skill_(?:activate|read|route|resource_read|complete)|tool_search)$/.test(name); }
function finite(value) { return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0; }
function digest(value) { return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`; }
function publicSourceRefs(value, preserveQuery = false) {
	const refs = new Set();
	for (const match of String(value ?? "").matchAll(/https?:\/\/[^\s<>"'\\]+/gi)) {
		try {
			const url = new URL(match[0].replace(/[),.;]+$/, ""));
			url.username = ""; url.password = ""; if (!preserveQuery) url.search = ""; url.hash = "";
			refs.add(url.toString());
		} catch { /* malformed model output is not evidence */ }
		if (refs.size >= 20) break;
	}
	return [...refs];
}
