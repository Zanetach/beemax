import type { TurnAction } from "./turn-understanding.ts";
import type { WorkContract, WorkContractClause } from "./work-contract.ts";

export const SEMANTIC_INVENTORY_SCHEMA_VERSION = "beemax.semantic-inventory.v1" as const;

export const SEMANTIC_ROLES = ["objective", "constraint", "prohibition", "acceptance_criterion", "capability_requirement", "uncertainty", "context"] as const;
export type SemanticRole = typeof SEMANTIC_ROLES[number];

export interface SemanticSourceSpan { start: number; end: number; }

export interface SemanticInventorySegment extends SemanticSourceSpan {
	text: string;
	occurrence: number;
	roles: SemanticRole[];
}

export interface SemanticInventory {
	schemaVersion: typeof SEMANTIC_INVENTORY_SCHEMA_VERSION;
	/** Trusted decoder input retained for deterministic Contract comparison; never model supplied. */
	rawRequest: string;
	action: TurnAction;
	targetObjectiveId?: string;
	segments: SemanticInventorySegment[];
	confidence: number;
}

export interface SemanticInventoryDecodeContext {
	rawRequest: string;
	activeObjectives: readonly { id: string; title: string }[];
	/** Trusted deterministic lifecycle fallback used only when no target exists. */
	fallbackAction?: TurnAction;
}

export type SemanticCompletenessBlockCode =
	| "RAW_REQUEST_MISMATCH"
	| "ACTION_DISAGREEMENT"
	| "TARGET_DISAGREEMENT"
	| "LOW_PRIMARY_CONFIDENCE"
	| "LOW_INVENTORY_CONFIDENCE"
	| "CAPABILITY_REQUIREMENTS_NOT_ATOMIC"
	| "ROLE_COVERAGE_INCOMPLETE";

export interface MissingSemanticRole extends SemanticSourceSpan { text: string; role: Exclude<SemanticRole, "context">; }

export type WorkContractAdjudication =
	| { kind: "accepted"; normalizedObjective?: WorkContractClause; normalizedConstraints?: WorkContractClause[]; normalizedProhibitions?: WorkContractClause[]; normalizedAcceptanceCriteria?: WorkContractClause[]; normalizedCapabilityRequirements?: WorkContractClause[]; normalizedUncertainties?: WorkContractClause[] }
	| { kind: "blocked"; code: Exclude<SemanticCompletenessBlockCode, "ROLE_COVERAGE_INCOMPLETE"> }
	| { kind: "blocked"; code: "ROLE_COVERAGE_INCOMPLETE"; missing: MissingSemanticRole[] };

export interface WorkContractAdjudicationInput {
	contract: WorkContract;
	inventory: SemanticInventory;
	minimumConfidence?: number;
	/**
	 * Recovery-only mode used after a bounded model repair. It may add exact-span
	 * constraints and prohibitions from the independent inventory, but can never
	 * remove or weaken a restriction or normalize any other missing role.
	 */
	allowAdditiveRestrictionNormalization?: boolean;
}

const ROLE_SET = new Set<string>(SEMANTIC_ROLES);

export function decodeSemanticInventory(value: unknown, context: SemanticInventoryDecodeContext): SemanticInventory {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Semantic Inventory must be an object");
	const proposal = value as Record<string, unknown>;
	assertOnlyKeys(proposal, ["schemaVersion", "action", "targetObjectiveId", "segments", "confidence"], "Semantic Inventory");
	if (proposal.schemaVersion !== SEMANTIC_INVENTORY_SCHEMA_VERSION) throw new Error("Semantic Inventory schema version is unsupported");
	const rawRequest = requiredRawRequest(context.rawRequest);
	const action = normalizeUntargetableLifecycleAction(decodeAction(proposal.action), context);
	const targetObjectiveId = decodeTargetObjective(proposal.targetObjectiveId, action, context.activeObjectives);
	const confidence = decodeConfidence(proposal.confidence);
	if (!Array.isArray(proposal.segments) || proposal.segments.length === 0 || proposal.segments.length > 100) throw new Error("Semantic Inventory segments must be a non-empty bounded list");
	// Ordering is representational, not semantic: every segment is already bound
	// to an exact Raw Request occurrence. Canonicalize those trusted positions
	// before enforcing non-overlap and complete coverage.
	const segments = atomizeSemanticSegments(rawRequest, proposal.segments.map((segment, index) => decodeSegment(segment, rawRequest, index)));
	assertMeaningfulCoverage(rawRequest, segments);
	assertNoMaterialContextSegments(rawRequest, segments);
	const materialRoles = new Set(segments.flatMap((segment) => segment.roles.filter((role) => role !== "context")));
	if (!materialRoles.has("objective")) throw new Error("Semantic Inventory must identify material Objective semantics");
	if ((action === "create" || action === "correct") && !materialRoles.has("acceptance_criterion")) throw new Error(`Semantic Inventory ${action} must identify an observable acceptance criterion`);
	return { schemaVersion: SEMANTIC_INVENTORY_SCHEMA_VERSION, rawRequest, action, ...(targetObjectiveId ? { targetObjectiveId } : {}), segments, confidence };
}

function normalizeUntargetableLifecycleAction(action: TurnAction, context: SemanticInventoryDecodeContext): TurnAction {
	if (context.activeObjectives.length > 0 || (action !== "continue" && action !== "correct" && action !== "cancel")) return action;
	return context.fallbackAction === "create" || context.fallbackAction === "query" ? context.fallbackAction : action;
}

export function resolveSemanticOccurrence(rawRequest: string, text: string, occurrence: number): SemanticSourceSpan {
	if (!text || !text.trim() || text.length > 10_000) throw new Error("Semantic Inventory segment text is invalid");
	if (!Number.isSafeInteger(occurrence) || occurrence < 0 || occurrence > 100) throw new Error("Semantic Inventory occurrence is invalid");
	let start = -1;
	let cursor = 0;
	for (let index = 0; index <= occurrence; index++) {
		start = rawRequest.indexOf(text, cursor);
		if (start < 0) throw new Error(`Semantic Inventory occurrence ${occurrence} does not exist in Raw Request for ${JSON.stringify(text.slice(0, 240))}`);
		cursor = start + 1;
	}
	return { start, end: start + text.length };
}

export function adjudicateWorkContract(input: WorkContractAdjudicationInput): WorkContractAdjudication {
	const { contract, inventory } = input;
	const minimumConfidence = input.minimumConfidence ?? 0.6;
	if (!Number.isFinite(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 1) throw new Error("Semantic completeness confidence threshold must be between 0 and 1");
	if (contract.rawRequest !== inventory.rawRequest) return { kind: "blocked", code: "RAW_REQUEST_MISMATCH" };
	if (contract.action !== inventory.action) return { kind: "blocked", code: "ACTION_DISAGREEMENT" };
	if (contract.targetObjective?.id !== inventory.targetObjectiveId) return { kind: "blocked", code: "TARGET_DISAGREEMENT" };
	// Model self-ratings are retained as evidence but are not calibrated admission
	// scores. Admission confidence comes from the independent action, target,
	// exact-span, role, and atomicity agreement enforced below.
	const missing: MissingSemanticRole[] = [];
	let objectiveCoverageIncomplete = false;
	let acceptanceCoverageIncomplete = false;
	for (const segment of inventory.segments) for (const role of segment.roles) {
		if (role === "context") continue;
		// Capability obligations are fail-safe when restored from the independent,
		// exact-span inventory below: they require governed execution evidence and
		// never grant Tool authority. Other semantic roles must still agree exactly.
		if (role === "capability_requirement") continue;
		if (semanticRoleCovered(contract, role, segment)) continue;
		if (role === "objective") { objectiveCoverageIncomplete = true; continue; }
		if (role === "acceptance_criterion") { acceptanceCoverageIncomplete = true; continue; }
		missing.push({ text: segment.text, role, start: segment.start, end: segment.end });
	}
	if (missing.length && (!input.allowAdditiveRestrictionNormalization
		|| missing.some(({ role }) => role !== "constraint" && role !== "prohibition"))) {
		return { kind: "blocked", code: "ROLE_COVERAGE_INCOMPLETE", missing };
	}
	const normalizedConstraints = missing.some(({ role }) => role === "constraint")
		? mergeExactClauses(contract.constraints, missingRoleClauses(inventory, missing, "constraint"))
		: undefined;
	const normalizedProhibitions = missing.some(({ role }) => role === "prohibition")
		? mergeExactClauses(contract.prohibitions, missingRoleClauses(inventory, missing, "prohibition"))
		: undefined;
	if ((normalizedConstraints?.length ?? 0) > 100 || (normalizedProhibitions?.length ?? 0) > 100) {
		return { kind: "blocked", code: "ROLE_COVERAGE_INCOMPLETE", missing };
	}
	const normalizedUncertainties = inventoryRoleClauses(inventory, "uncertainty")
		.filter((clause) => !isConditionalExecutionInstruction(inventory.rawRequest, clause));
	const normalizedAcceptanceCriteria = inventoryRoleClauses(inventory, "acceptance_criterion");
	const acceptanceIncludesIndependentProhibition = contract.acceptanceCriteria.some((criterion) => {
		const source = criterion.source;
		return source.kind === "raw_request" && inventory.segments.some((segment) => segment.roles.includes("prohibition")
			&& source.start < segment.end && segment.start < source.end);
	});
	const normalizations: Pick<Extract<WorkContractAdjudication, { kind: "accepted" }>, "normalizedObjective" | "normalizedConstraints" | "normalizedProhibitions" | "normalizedAcceptanceCriteria" | "normalizedUncertainties"> = {
		...(objectiveCoverageIncomplete ? { normalizedObjective: inventoryObjectiveClause(inventory) } : {}),
		...(normalizedConstraints ? { normalizedConstraints } : {}),
		...(normalizedProhibitions ? { normalizedProhibitions } : {}),
		...(acceptanceCoverageIncomplete || acceptanceIncludesIndependentProhibition ? { normalizedAcceptanceCriteria } : {}),
		...(!sameClauses(contract.uncertainties, normalizedUncertainties) ? { normalizedUncertainties } : {}),
	};
	const capabilityOutcomes = normalizedCapabilityOutcomeSegments(inventory);
	// The downstream Capability selector may choose alternatives for one outcome,
	// but it must not decide how many mandatory outcomes the Contract contains.
	// Normalize both broader and fragmented primary clauses from the independent,
	// exact-span inventory. Every primary clause must remain related by containment
	// to an inventoried outcome; unrelated or invented obligations still fail closed.
	if (!capabilityOutcomes.length && contract.capabilityRequirements.length) {
		const [single] = contract.capabilityRequirements;
		const singleRawSource = single?.source.kind === "raw_request" ? single.source : undefined;
		const independentlyObservable = contract.capabilityRequirements.length === 1 && singleRawSource && inventory.segments.some((segment) =>
			(segment.roles.includes("objective") || segment.roles.includes("acceptance_criterion"))
			&& !segment.roles.includes("prohibition") && !segment.roles.includes("constraint")
			&& segment.start <= singleRawSource.start && segment.end >= singleRawSource.end,
		);
		if (!independentlyObservable) return { kind: "blocked", code: "CAPABILITY_REQUIREMENTS_NOT_ATOMIC" };
		return { kind: "accepted", ...normalizations };
	}
	const normalizedCapabilityRequirements = capabilityOutcomes.map((segment): WorkContractClause => ({
		text: segment.text,
		source: { kind: "raw_request", start: segment.start, end: segment.end },
	}));
	return sameClauses(contract.capabilityRequirements, normalizedCapabilityRequirements)
		? { kind: "accepted", ...normalizations }
		: { kind: "accepted", ...normalizations, normalizedCapabilityRequirements };
}

/**
 * Compile one complete exact-span Semantic Inventory into an executable Work
 * Contract. The model owns semantic roles; Core owns structure, normalization,
 * lifecycle binding, and the execution-mode policy selected by Turn cognition.
 */
export function compileSemanticInventoryWorkContract(inventory: SemanticInventory, executionMode: WorkContract["executionMode"]): WorkContract {
	const capabilityRequirements = normalizedCapabilityOutcomeSegments(inventory).map((segment): WorkContractClause => ({
		text: segment.text,
		source: { kind: "raw_request", start: segment.start, end: segment.end },
	}));
	return {
		schemaVersion: "beemax.work-contract.v1",
		rawRequest: inventory.rawRequest,
		action: inventory.action,
		...(inventory.targetObjectiveId ? { targetObjective: { kind: "active_objective", id: inventory.targetObjectiveId } } : {}),
		objective: inventoryObjectiveClause(inventory),
		constraints: inventoryRoleClauses(inventory, "constraint"),
		prohibitions: inventoryRoleClauses(inventory, "prohibition"),
		acceptanceCriteria: inventoryRoleClauses(inventory, "acceptance_criterion"),
		capabilityRequirements,
		uncertainties: inventoryRoleClauses(inventory, "uncertainty").filter((clause) => !isConditionalExecutionInstruction(inventory.rawRequest, clause)),
		executionMode,
		confidence: Math.max(0.6, inventory.confidence),
	};
}

function normalizedCapabilityOutcomeSegments(inventory: SemanticInventory): SemanticInventorySegment[] {
	const modelCandidates = inventory.segments.filter((segment) =>
		segment.roles.includes("capability_requirement") && isIntrinsicCapabilityBoundary(segment),
	).flatMap((segment) => atomizeFusedCapabilityOutcome(inventory.rawRequest, segment));
	// A complete inventory can still omit the capability role from an explicit
	// source-artifact creation or derived render phrase. Those two operations have
	// deterministic lexical boundaries and grant no authority beyond the user's
	// exact words, so restore them before Tool routing. This prevents artifact
	// inspection/render Tools from being exposed without the file writer needed to
	// create their source input.
	const inferredArtifactCandidates = inferredArtifactBoundarySegments(inventory);
	const inferredObservationCandidates = inferredObservationBoundarySegments(inventory)
		.filter((candidate) => !modelCandidates.some((modelCandidate) => modelCandidate.start < candidate.end && candidate.start < modelCandidate.end));
	const candidates = [...new Map([...modelCandidates, ...inferredArtifactCandidates, ...inferredObservationCandidates]
		.map((segment) => capabilitySegment(inventory.rawRequest, segment.start, segment.end))
		.sort((left, right) => left.start - right.start || left.end - right.end)
		.map((segment) => [`${segment.start}:${segment.end}`, segment])).values()];
	const normalized: SemanticInventorySegment[] = [];
	for (let index = 0; index < candidates.length; index++) {
		const segment = candidates[index]!;
		const next = candidates[index + 1];
		if (next && isArtifactDeliveryPrefix(segment.text) && isSourceArtifactOutcome(next.text)
			&& isOnlyBoundarySeparator(inventory.rawRequest.slice(segment.end, next.start))) {
			const text = inventory.rawRequest.slice(segment.start, next.end);
			normalized.push({
				text,
				occurrence: occurrenceAtPosition(inventory.rawRequest, text, segment.start),
				roles: ["capability_requirement"],
				start: segment.start,
				end: next.end,
			});
			index++;
			continue;
		}
		normalized.push(segment);
	}
	return normalized;
}

function inferredObservationBoundarySegments(inventory: SemanticInventory): SemanticInventorySegment[] {
	const eligibleSpans = inventory.segments.filter((segment) =>
		segment.roles.includes("objective") || segment.roles.includes("acceptance_criterion") || segment.roles.includes("constraint"),
	);
	const sourceCrosscheck = /(?:使用|采用|基于|use|using)[^。；;]{0,100}?(?:公开可访问|公开|public(?:ly)?(?:\s+accessible)?)[^。；;]{0,80}?(?:来源|sources?)[^。；;]{0,48}?(?:交叉验证|交叉核验|核验|验证|cross[- ]?check|verify)/giu;
	const inferred: SemanticInventorySegment[] = [];
	for (const match of inventory.rawRequest.matchAll(sourceCrosscheck)) {
		const start = match.index;
		const end = start + match[0].length;
		if (!eligibleSpans.some((segment) => segment.start <= start && segment.end >= end)) continue;
		if (inventory.segments.some((segment) => segment.roles.includes("prohibition") && segment.start < end && start < segment.end)) continue;
		inferred.push(capabilitySegment(inventory.rawRequest, start, end));
	}
	const coordinatedSpans = [...eligibleSpans];
	if (eligibleSpans.length > 1) {
		const start = Math.min(...eligibleSpans.map((segment) => segment.start));
		const end = Math.max(...eligibleSpans.map((segment) => segment.end));
		coordinatedSpans.push({
			text: inventory.rawRequest.slice(start, end),
			occurrence: occurrenceAtPosition(inventory.rawRequest, inventory.rawRequest.slice(start, end), start),
			roles: ["acceptance_criterion"],
			start,
			end,
		});
	}
	for (const span of coordinatedSpans) for (const candidate of atomizeCoordinatedDataBoundary(inventory.rawRequest, span) ?? []) {
		if (inventory.segments.some((segment) => segment.roles.includes("prohibition") && segment.start < candidate.end && candidate.start < segment.end)) continue;
		inferred.push(candidate);
	}
	return inferred;
}

function inferredArtifactBoundarySegments(inventory: SemanticInventory): SemanticInventorySegment[] {
	const materialSpans = inventory.segments.filter((segment) =>
		segment.roles.includes("objective") || segment.roles.includes("acceptance_criterion"),
	);
	const patterns = [
		/(?:生成|创建|制作|编写|create|generate|produce)[^。；;]{0,48}?\bHTML\b/giu,
		/(?:由|从|from)\s*[^。；;]{0,12}?\bHTML\b[^。；;]{0,24}?(?:渲染|转换|导出|render|convert|export)[^。；;]{0,12}?\bPDF\b/giu,
		/(?:把|将)\s*[^。；;]{0,48}?\bHTML\b[^。；;]{0,48}?(?:渲染|转换|转成|导出)(?:为|成|到)?[^。；;]{0,48}?\bPDF\b/giu,
		/(?:render|convert|export)\b[^.;]{0,48}?\bHTML\b[^.;]{0,24}?\b(?:to|as|into)\b[^.;]{0,24}?\bPDF\b/giu,
		/(?:render|convert|export)[^.;]{0,24}?\bPDF\b[^.;]{0,24}?\bfrom\b[^.;]{0,12}?\bHTML\b/giu,
	];
	let inferred: SemanticInventorySegment[] = [];
	for (const pattern of patterns) for (const match of inventory.rawRequest.matchAll(pattern)) {
		const start = match.index;
		const end = start + match[0].length;
		if (!materialSpans.some((segment) => segment.start <= start && segment.end >= end)) continue;
		if (inventory.segments.some((segment) => segment.roles.includes("prohibition") && segment.start < end && start < segment.end)) continue;
		inferred.push(capabilitySegment(inventory.rawRequest, start, end));
	}
	const sourceDeliveries: SemanticInventorySegment[] = [];
	const sourceDelivery = /(?:写入|保存|导出|write|save|export)[^。；;]{0,48}?\b[^\s，,；;]+\.html?\b/giu;
	for (const match of inventory.rawRequest.matchAll(sourceDelivery)) {
		const start = match.index;
		const end = start + match[0].length;
		if (materialSpans.some((segment) => segment.start <= start && segment.end >= end)) sourceDeliveries.push(capabilitySegment(inventory.rawRequest, start, end));
	}
	if (sourceDeliveries.length) {
		// Prefer the exact filename-bound delivery phrase over a preceding generic
		// "generate HTML" phrase. It denotes the same source-artifact outcome and
		// gives the Tool selector the concrete workspace file boundary it needs.
		inferred = inferred.filter((segment) => !(/\bHTML\b/iu.test(segment.text) && !/\bPDF\b/iu.test(segment.text)));
		inferred.push(...sourceDeliveries);
	}
	return inferred;
}

function isIntrinsicCapabilityBoundary(segment: SemanticInventorySegment): boolean {
	const text = segment.text.trim();
	// Choosing or progressively loading whatever Skill/Tool the task needs is an
	// execution method. It remains a source-bound constraint, while the concrete
	// research, file, media, and named-Tool outcomes below become executable
	// Capability obligations. Treating this generic control instruction as its
	// own outcome creates an impossible receipt after the real work has finished.
	if (/(?:动态|渐进式|按需|逐步|dynamic(?:ally)?|progressive(?:ly)?|on[- ]demand)[^。；;]{0,80}(?:加载|选择|发现|调用|load|select|discover|invoke)[^。；;]{0,80}(?:skills?|tools?|技能|工具)/iu.test(text)
		&& !/\b[a-z][a-z0-9]*(?:[_:-][a-z0-9._:-]+)\b/iu.test(text)) return false;
	// Recovery policy governs execution after a boundary fails; it does not create
	// another boundary that a selector could satisfy with a Tool.
	if (/(?:如果|若|假如|\b(?:when|if)\b)[^。；;]*(?:失败|不可用|出错|错误|fail(?:s|ed|ure)?|unavailable|error)[^。；;]*(?:换用|切换|重试|继续|备用|fallback|switch|retry|continue)/iu.test(text)) return false;
	// Citations and source URLs are report content unless the request also asks to
	// retrieve or access them. Their factual correctness is settled by verification.
	if (/(?:来源\s*URL|source\s*URLs?|citations?|引用链接)/iu.test(text)
		&& !/(?:检索|搜索|查询|获取|读取|访问|下载|联网|fetch|search|retrieve|read|lookup|access|download|browse)/iu.test(text)) return false;
	// A consistency statement is an acceptance property. An explicit independent
	// inspection/comparison remains a real capability boundary.
	if (/(?:一致性|一致|consisten(?:cy|t))/iu.test(text)
		&& !/(?:检查|验证|核验|校验|比较|对比|审查|inspect|verify|validate|check|compare|audit)/iu.test(text)) return false;
	// Language, style, and generic report-format modifiers constrain an outcome but
	// do not themselves require a Tool. Concrete files and delivery operations are
	// deliberately excluded from this rule.
	if (/(?:中文|英文|语言|专业|风格|样式|格式|language|professional|style|format)/iu.test(text)
		&& !/(?:\.[a-z0-9]{1,10}\b|文件|目录|workspace|path|file|artifact|交付|保存|写入|导出|转换|渲染|发送|邮件|deliver|save|write|export|convert|render|send|email)/iu.test(text)) return false;
	return true;
}

function isConditionalExecutionInstruction(rawRequest: string, clause: WorkContractClause): boolean {
	if (clause.source.kind !== "raw_request" || !/^(?:如果|若|假如|如遇|倘若|(?:if|when)\b)/iu.test(clause.text.trim())) return false;
	const sentenceEnd = rawRequest.slice(clause.source.end).search(/[。；;.!?？]/u);
	const tailEnd = sentenceEnd < 0 ? Math.min(rawRequest.length, clause.source.end + 500) : clause.source.end + sentenceEnd;
	const instruction = rawRequest.slice(clause.source.start, tailEnd);
	return /(?:请|则|就|应当|应该|必须|需要|使用|改用|换用|重试|继续|保留|返回|报告|分块|不要|不得|不能|do not|must|should|use|retry|continue|preserve|return|report|chunk)/iu.test(instruction.slice(clause.text.length));
}

function atomizeFusedCapabilityOutcome(rawRequest: string, segment: SemanticInventorySegment): SemanticInventorySegment[] {
	const normalizedSegment = normalizeCoordinatedDataBoundaryPrefix(rawRequest, segment);
	const delivered = atomizeFusedArtifactDelivery(rawRequest, normalizedSegment);
	if (delivered) return delivered;
	const inspected = atomizeFusedArtifactInspection(rawRequest, normalizedSegment);
	if (inspected) return inspected;
	const coordinated = atomizeCoordinatedDataBoundary(rawRequest, normalizedSegment);
	return coordinated ?? [normalizedSegment];
}

function normalizeCoordinatedDataBoundaryPrefix(rawRequest: string, segment: SemanticInventorySegment): SemanticInventorySegment {
	const prefix = /^(?:[\s，,；;]*(?:并且?|然后|再|and(?:\s+then)?|then)\s*)/iu.exec(segment.text);
	if (!prefix?.[0]) return segment;
	const remainder = segment.text.slice(prefix[0].length);
	const dataBoundary = /(?:检索|搜索|查询|获取|读取|访问|下载|联网|搜集|采集|分析|计算|统计|聚合|\b(?:search|retrieve|fetch|look\s*up|lookup|read|access|download|browse|collect|analy[sz]e|compute|calculate|aggregate|inspect|check)\b)/iu;
	if (!dataBoundary.test(remainder)) return segment;
	return capabilitySegment(rawRequest, segment.start + prefix[0].length, segment.end);
}

/**
 * Retrieval and structured analysis are independently observable boundary
 * operations even when a semantic inventory returns one fused exact span. Keep
 * the rule deliberately narrow: ordinary research facts, attribution, and
 * prose review remain one outcome.
 */
function atomizeCoordinatedDataBoundary(rawRequest: string, segment: SemanticInventorySegment): SemanticInventorySegment[] | undefined {
	const retrieval = /(?:检索|搜索|查询|获取|读取|访问|下载|联网|搜集|采集|\b(?:search|retrieve|fetch|look\s*up|lookup|read|access|download|browse|collect)\b)/iu;
	const structuredAnalysis = /(?:分析|计算|统计|聚合|检查[^。；;]{0,24}(?:数据|指标|异常)|\b(?:analy[sz]e|compute|calculate|aggregate|inspect|check)\b[^.;]{0,48}(?:data|metrics?|anomal))/iu;
	const separators = [...segment.text.matchAll(/(?:[，,；;]\s*(?:(?:并且?|然后|再|and(?:\s+then)?|then)\s*)?|\s+(?:and(?:\s+then)?|then)\s+)/giu)];
	for (const separator of separators) {
		const separatorStart = separator.index ?? -1;
		if (separatorStart <= 0) continue;
		const rightOffset = separatorStart + separator[0].length;
		const left = segment.text.slice(0, separatorStart).trimEnd();
		const right = segment.text.slice(rightOffset).trimStart();
		if (!left || !right) continue;
		const independentPair = retrieval.test(left) && structuredAnalysis.test(right)
			|| structuredAnalysis.test(left) && retrieval.test(right);
		if (!independentPair) continue;
		const leftStart = segment.start;
		const leftEnd = leftStart + left.length;
		const rightLeading = segment.text.slice(rightOffset).length - segment.text.slice(rightOffset).trimStart().length;
		const rightStart = segment.start + rightOffset + rightLeading;
		return [capabilitySegment(rawRequest, leftStart, leftEnd), capabilitySegment(rawRequest, rightStart, segment.end)];
	}
	return undefined;
}

function atomizeFusedArtifactDelivery(rawRequest: string, segment: SemanticInventorySegment): SemanticInventorySegment[] | undefined {
	if (!/(?:交付|保存|写入|导出|deliver|save|write|export)/iu.test(segment.text)) return undefined;
	const files = [...segment.text.matchAll(/[a-z0-9_.-]+\.(?:html?|pdf)\b/giu)];
	if (files.length < 2 || !files.some((match) => /\.html?$/iu.test(match[0])) || !files.some((match) => /\.pdf$/iu.test(match[0]))) return undefined;
	return files.map((match, index) => {
		const start = index === 0 ? segment.start : segment.start + match.index;
		const end = segment.start + match.index + match[0].length;
		return capabilitySegment(rawRequest, start, end);
	});
}

function atomizeFusedArtifactInspection(rawRequest: string, segment: SemanticInventorySegment): SemanticInventorySegment[] | undefined {
	if (!/(?:检查|验证|核验|校验|审查|inspect|verify|validate|check|audit)/iu.test(segment.text)) return undefined;
	const html = /\bhtml\b/iu.exec(segment.text);
	const pdf = /\bpdf\b/iu.exec(segment.text);
	if (!html || !pdf || pdf.index <= html.index) return undefined;
	const consistency = /(?:两份文件|html\s*(?:与|和|and)\s*pdf)[^。；;]*(?:一致性|一致|consisten(?:cy|t))/iu.exec(segment.text);
	let htmlEnd = segment.start + pdf.index;
	while (htmlEnd > segment.start && /[\s，,、；;]/u.test(rawRequest[htmlEnd - 1]!)) htmlEnd--;
	let pdfEnd = consistency ? segment.start + consistency.index : segment.end;
	if (consistency) {
		const beforeConsistency = rawRequest.slice(segment.start + pdf.index, pdfEnd);
		const suffix = /[\s，,、；;]*(?:以及|并且|and)\s*$/iu.exec(beforeConsistency);
		if (suffix) pdfEnd -= suffix[0].length;
	}
	while (pdfEnd > segment.start + pdf.index && /[\s，,、；;。]/u.test(rawRequest[pdfEnd - 1]!)) pdfEnd--;
	const outcomes = [
		capabilitySegment(rawRequest, segment.start, htmlEnd),
		capabilitySegment(rawRequest, segment.start + pdf.index, pdfEnd),
	];
	if (consistency) outcomes.push(capabilitySegment(rawRequest, segment.start + consistency.index, segment.end));
	return outcomes;
}

function capabilitySegment(rawRequest: string, start: number, proposedEnd: number): SemanticInventorySegment {
	let end = proposedEnd;
	while (end > start && /[\s。；;]/u.test(rawRequest[end - 1]!)) end--;
	const text = rawRequest.slice(start, end);
	return {
		text,
		occurrence: occurrenceAtPosition(rawRequest, text, start),
		roles: ["capability_requirement"],
		start,
		end,
	};
}

function isArtifactDeliveryPrefix(text: string): boolean {
	return /(?:交付|保存|写入|导出|deliver|save|write|export)/iu.test(text)
		&& /(?:workspace|工作区|目录|文件夹|路径|directory|folder|path)/iu.test(text)
		&& !/(?:\.[a-z0-9]{1,10}\b|\b(?:html?|pdf|docx?|xlsx?|pptx?|csv|json|md)\b)/iu.test(text);
}

function isSourceArtifactOutcome(text: string): boolean {
	return /(?:\.html?\b|text\/html)/iu.test(text);
}

function isOnlyBoundarySeparator(text: string): boolean {
	return /^[\p{P}\p{S}\s]*$/u.test(text);
}

function inventoryObjectiveClause(inventory: SemanticInventory): WorkContractClause {
	const objectives = inventory.segments.filter((segment) => segment.roles.includes("objective"));
	const start = Math.min(...objectives.map((segment) => segment.start));
	const end = Math.max(...objectives.map((segment) => segment.end));
	return { text: inventory.rawRequest.slice(start, end), source: { kind: "raw_request", start, end } };
}

function inventoryRoleClauses(inventory: SemanticInventory, role: SemanticRole): WorkContractClause[] {
	const spans: Array<{ start: number; end: number }> = [];
	for (const segment of inventory.segments.filter((candidate) => candidate.roles.includes(role))) {
		const previous = spans.at(-1);
		if (previous && previous.end === segment.start) previous.end = segment.end;
		else spans.push({ start: segment.start, end: segment.end });
	}
	return spans.map(({ start, end }) => ({ text: inventory.rawRequest.slice(start, end), source: { kind: "raw_request", start, end } }));
}

function missingRoleClauses(inventory: SemanticInventory, missing: readonly MissingSemanticRole[], role: "constraint" | "prohibition"): WorkContractClause[] {
	return missing.filter((item) => item.role === role).map(({ start, end }) => ({
		text: inventory.rawRequest.slice(start, end),
		source: { kind: "raw_request", start, end },
	}));
}

function mergeExactClauses(existing: readonly WorkContractClause[], additions: readonly WorkContractClause[]): WorkContractClause[] {
	const merged = [...existing];
	const keys = new Set(existing.map(exactClauseKey));
	for (const clause of additions) {
		const key = exactClauseKey(clause);
		if (keys.has(key)) continue;
		keys.add(key);
		merged.push(clause);
	}
	return merged;
}

function exactClauseKey(clause: WorkContractClause): string {
	return clause.source.kind === "raw_request"
		? `${clause.source.start}:${clause.source.end}:${clause.text}`
		: `${clause.source.kind}:${clause.text}`;
}

function sameClauses(left: readonly WorkContractClause[], right: readonly WorkContractClause[]): boolean {
	return left.length === right.length && left.every((clause, index) => {
		const candidate = right[index];
		return candidate !== undefined && clause.text === candidate.text && clause.source.kind === "raw_request"
			&& candidate.source.kind === "raw_request" && clause.source.start === candidate.source.start && clause.source.end === candidate.source.end;
	});
}

function decodeSegment(value: unknown, rawRequest: string, index: number): SemanticInventorySegment {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Semantic Inventory segment ${index} is invalid`);
	const segment = value as Record<string, unknown>;
	assertOnlyKeys(segment, ["text", "occurrence", "roles"], `Semantic Inventory segment ${index}`);
	if (typeof segment.text !== "string") throw new Error(`Semantic Inventory segment ${index} text is invalid`);
	if (!Array.isArray(segment.roles) || segment.roles.length === 0 || segment.roles.length > SEMANTIC_ROLES.length || segment.roles.some((role) => typeof role !== "string" || !ROLE_SET.has(role))) throw new Error(`Semantic Inventory segment ${index} roles are invalid`);
	const proposedRoles = segment.roles as SemanticRole[];
	if (new Set(proposedRoles).size !== proposedRoles.length) throw new Error(`Semantic Inventory segment ${index} roles contain duplicates`);
	const roles = normalizeExplicitProhibitionRoles(segment.text, proposedRoles);
	assertCompatibleSemanticRoles(roles, `Semantic Inventory segment ${index}`);
	if (typeof segment.occurrence !== "number") throw new Error(`Semantic Inventory segment ${index} occurrence is invalid`);
	const resolved = resolveModelSemanticOccurrence(rawRequest, segment.text, segment.occurrence);
	return { text: segment.text, occurrence: resolved.occurrence, roles: [...roles], start: resolved.start, end: resolved.end };
}

function normalizeExplicitProhibitionRoles(text: string, roles: readonly SemanticRole[]): SemanticRole[] {
	if (!roles.includes("prohibition") || !isExplicitProhibitionText(text)) return [...roles];
	return roles.filter((role) => role !== "acceptance_criterion" && role !== "capability_requirement");
}

function isExplicitProhibitionText(text: string): boolean {
	return /(?:不要|不得|禁止|严禁|不可|不能|不允许|无需|无须|拒绝)|(?:do not|don't|must not|never|forbid|reject)/iu.test(text);
}

function resolveModelSemanticOccurrence(rawRequest: string, text: string, occurrence: number): SemanticSourceSpan & { occurrence: number } {
	try { return { occurrence, ...resolveSemanticOccurrence(rawRequest, text, occurrence) }; }
	catch (error) {
		// A one-based or otherwise wrong occurrence carries no ambiguity when the
		// exact quote exists once. Repeated quotes still require the model's exact
		// zero-based occurrence and remain closed on a missing index.
		if (!Number.isSafeInteger(occurrence) || occurrence < 0 || occurrence > 100) throw error;
		const start = rawRequest.indexOf(text);
		if (start < 0 || rawRequest.indexOf(text, start + 1) >= 0) throw error;
		return { occurrence: 0, start, end: start + text.length };
	}
}

function atomizeSemanticSegments(rawRequest: string, proposed: readonly SemanticInventorySegment[]): SemanticInventorySegment[] {
	const boundaries = [...new Set(proposed.flatMap((segment) => [segment.start, segment.end]))].sort((left, right) => left - right);
	const segments: SemanticInventorySegment[] = [];
	for (let index = 1; index < boundaries.length; index++) {
		const start = boundaries[index - 1]!;
		const end = boundaries[index]!;
		const covering = proposed.filter((segment) => segment.start <= start && segment.end >= end);
		if (!covering.length || end <= start) continue;
		const includedRoles = new Set(covering.flatMap((segment) => segment.roles));
		const roles = SEMANTIC_ROLES.filter((role) => includedRoles.has(role));
		assertCompatibleSemanticRoles(roles, "Semantic Inventory normalized segment");
		const text = rawRequest.slice(start, end);
		segments.push({ text, occurrence: occurrenceAtPosition(rawRequest, text, start), roles, start, end });
	}
	return segments;
}

function occurrenceAtPosition(rawRequest: string, text: string, expectedStart: number): number {
	let occurrence = 0;
	let cursor = 0;
	while (occurrence <= 100) {
		const start = rawRequest.indexOf(text, cursor);
		if (start === expectedStart) return occurrence;
		if (start < 0 || start > expectedStart) break;
		occurrence++;
		cursor = start + 1;
	}
	throw new Error("Semantic Inventory normalized occurrence is invalid");
}

function assertCompatibleSemanticRoles(roles: readonly SemanticRole[], label: string): void {
	if (roles.includes("prohibition") && roles.includes("capability_requirement")) throw new Error(`${label} prohibition cannot be a capability requirement`);
	if (roles.includes("prohibition") && roles.includes("acceptance_criterion")) throw new Error(`${label} prohibition cannot be an acceptance criterion`);
}

function decodeTargetObjective(value: unknown, action: TurnAction, candidates: readonly { id: string; title: string }[]): string | undefined {
	const requiresTarget = action === "continue" || action === "correct" || action === "cancel";
	if (value === undefined || value === null) {
		if (requiresTarget) throw new Error(`Semantic Inventory ${action} must target one active Objective`);
		return undefined;
	}
	if (typeof value !== "string" || !value.trim() || value.length > 500 || !candidates.some((candidate) => candidate.id === value)) throw new Error("Semantic Inventory target does not match an active Objective");
	if (action === "create") throw new Error("Semantic Inventory create action cannot target an active Objective");
	return value;
}

function decodeAction(value: unknown): TurnAction {
	if (value !== "create" && value !== "continue" && value !== "correct" && value !== "query" && value !== "cancel") throw new Error("Semantic Inventory action is invalid");
	return value;
}

function decodeConfidence(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error("Semantic Inventory confidence is invalid");
	return value;
}

function assertMeaningfulCoverage(rawRequest: string, segments: readonly SemanticInventorySegment[]): void {
	const covered = new Uint8Array(rawRequest.length);
	for (const segment of segments) covered.fill(1, segment.start, segment.end);
	for (let index = 0; index < rawRequest.length; index++) if (isMeaningful(rawRequest[index]!) && !covered[index]) throw new Error(`Semantic Inventory coverage is incomplete at Raw Request position ${index}`);
}

function structuredJsonSpans(rawRequest: string): SemanticSourceSpan[] {
	const spans: SemanticSourceSpan[] = [];
	const stack: Array<{ delimiter: "{" | "["; start: number }> = [];
	let quoted = false;
	let escaped = false;
	for (let index = 0; index < rawRequest.length; index++) {
		const character = rawRequest[index]!;
		if (quoted) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') quoted = false;
			continue;
		}
		if (character === '"') { quoted = true; continue; }
		if (character === "{" || character === "[") { stack.push({ delimiter: character, start: index }); continue; }
		if (character !== "}" && character !== "]") continue;
		const opening = stack.at(-1);
		if (!opening || (opening.delimiter === "{" ? character !== "}" : character !== "]")) { stack.length = 0; continue; }
		stack.pop();
		if (stack.length) continue;
		const text = rawRequest.slice(opening.start, index + 1);
		try { if (isArtifactManifestJson(JSON.parse(text))) spans.push({ start: opening.start, end: index + 1 }); }
		catch { /* balanced prose is not trusted as structured data */ }
	}
	return spans;
}

function isArtifactManifestJson(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const manifest = value as Record<string, unknown>;
	const locator = manifest.locator && typeof manifest.locator === "object" && !Array.isArray(manifest.locator) ? manifest.locator as Record<string, unknown> : undefined;
	const producer = manifest.producer && typeof manifest.producer === "object" && !Array.isArray(manifest.producer) ? manifest.producer as Record<string, unknown> : undefined;
	const digest = typeof manifest.sha256 === "string" && /^[a-f0-9]{64}$/iu.test(manifest.sha256) ? manifest.sha256.toLocaleLowerCase() : undefined;
	return manifest.schemaVersion === "beemax.artifact-manifest.v1"
		&& Boolean(digest && manifest.id === `artifact:sha256:${digest}`)
		&& typeof locator?.kind === "string" && typeof locator.uri === "string" && Boolean(locator.uri)
		&& typeof manifest.mediaType === "string" && Boolean(manifest.mediaType)
		&& Number.isSafeInteger(manifest.byteLength) && Number(manifest.byteLength) >= 0
		&& typeof producer?.providerId === "string" && typeof producer.providerVersion === "string" && typeof producer.operation === "string"
		&& Array.isArray(manifest.sourceRefs) && manifest.sourceRefs.every((ref) => typeof ref === "string")
		&& Number.isSafeInteger(manifest.createdAt) && Number(manifest.createdAt) >= 0;
}

function materialContextText(rawRequest: string, segment: SemanticInventorySegment, structuredSpans: readonly SemanticSourceSpan[]): string {
	let cursor = segment.start;
	let visible = "";
	for (const span of structuredSpans) {
		if (span.end <= cursor || span.start >= segment.end) continue;
		visible += rawRequest.slice(cursor, Math.max(cursor, Math.min(span.start, segment.end)));
		cursor = Math.max(cursor, Math.min(span.end, segment.end));
		if (cursor >= segment.end) break;
	}
	return visible + rawRequest.slice(cursor, segment.end);
}

function assertNoMaterialContextSegments(rawRequest: string, segments: readonly SemanticInventorySegment[]): void {
	const structuredSpans = structuredJsonSpans(rawRequest);
	for (const segment of segments) {
		if (segment.roles.length !== 1 || segment.roles[0] !== "context") continue;
		const semanticText = materialContextText(rawRequest, segment, structuredSpans);
		const materialOperation = /(?:调研|研究|检索|搜索|查询|查找|读取|获取|访问|下载|写入|保存|交付|导出|转换|渲染|检查|验证|核验|research|search|retrieve|lookup|read|fetch|access|download|write|save|deliver|export|convert|render|inspect|verify|validate)/iu.test(semanticText);
		const freshnessScope = /(?:截至|过去\s*(?:一|两|三|四|五|六|七|八|九|十|\d+)?\s*(?:天|周|月|年)|近\s*(?:一|两|三|四|五|六|七|八|九|十|\d+)\s*(?:天|周|月|年)|最新|实时|\b(?:latest|live|as\s+of|past\s+(?:day|week|month|year))\b)/iu.test(semanticText);
		if (materialOperation || freshnessScope) throw new Error(`Semantic Inventory cannot hide a material operation or freshness scope as context: ${JSON.stringify(semanticText.slice(0, 240))}`);
	}
}

function isMeaningful(value: string): boolean { return !/[\p{P}\p{S}\s]/u.test(value); }

function clausesForRole(contract: WorkContract, role: Exclude<SemanticRole, "context">): readonly WorkContractClause[] {
	if (role === "objective") return [contract.objective];
	if (role === "constraint") return contract.constraints;
	if (role === "prohibition") return contract.prohibitions;
	if (role === "acceptance_criterion") return contract.acceptanceCriteria;
	if (role === "capability_requirement") return contract.capabilityRequirements;
	return contract.uncertainties;
}

function clauseCovers(clause: WorkContractClause, segment: SemanticInventorySegment): boolean {
	return clause.source.kind === "raw_request" && clause.source.start <= segment.start && clause.source.end >= segment.end;
}

function clauseAndSegmentAreNested(clause: WorkContractClause, segment: SemanticInventorySegment): boolean {
	return clause.source.kind === "raw_request" && (
		clause.source.start <= segment.start && clause.source.end >= segment.end
		|| segment.start <= clause.source.start && segment.end >= clause.source.end
	);
}

function semanticRoleCovered(contract: WorkContract, role: Exclude<SemanticRole, "context" | "capability_requirement">, segment: SemanticInventorySegment): boolean {
	const fusedOutputConstraint = role === "constraint" && (segment.roles.includes("objective") || segment.roles.includes("acceptance_criterion"));
	const compatible = role === "objective" || role === "acceptance_criterion"
		? [contract.objective, ...contract.acceptanceCriteria]
		: role === "constraint"
			? [...contract.constraints, ...contract.prohibitions, ...(fusedOutputConstraint ? [contract.objective, ...contract.acceptanceCriteria] : [])]
			: role === "uncertainty"
				? [...contract.uncertainties, ...contract.constraints, ...contract.prohibitions]
				: clausesForRole(contract, role);
	return compatible.some((clause) => clauseAndSegmentAreNested(clause, segment));
}

function requiredRawRequest(value: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > 50_000) throw new Error("Semantic Inventory Raw Request is invalid");
	return value;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const allowedKeys = new Set(allowed);
	if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw new Error(`${label} contains unsupported fields`);
}
