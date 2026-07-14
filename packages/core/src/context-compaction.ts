export interface ContextCompactionPlanInput {
	contextWindow: number;
	enabled?: boolean;
	reserveTokens?: number;
	keepRecentTokens?: number;
}

export interface ContextCompactionPlan {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
	triggerAtTokens: number;
}

export interface CompactionPreservationAssessment {
	complete: boolean;
	missingTaskIds: string[];
}

export interface CompactionPreservationRecovery extends CompactionPreservationAssessment {
	recoveryContext?: string;
}

export interface CompactionQualityAssessment extends CompactionPreservationAssessment {
	status: "good" | "degraded" | "critical";
	identityCoverage: number;
	semanticCoverage: number;
	semanticAnchorCount: number;
	missingSemanticAnchors: string[];
}

/**
 * Translate one model context window plus optional Profile overrides into the
 * small settings interface owned by Pi. Defaults scale with the actual model
 * instead of assuming every provider has a 128K window.
 */
export function planContextCompaction(input: ContextCompactionPlanInput): ContextCompactionPlan {
	const contextWindow = finiteInteger(input.contextWindow, "contextWindow");
	if (contextWindow < 8_000) throw new Error("Context compaction requires a model context window of at least 8000 tokens");
	const reserveTokens = input.reserveTokens === undefined
		? clamp(Math.round(contextWindow * 0.15), 4_096, 65_536)
		: positiveInteger(input.reserveTokens, "reserveTokens");
	const keepRecentTokens = input.keepRecentTokens === undefined
		? clamp(Math.round(contextWindow * 0.16), 8_000, 65_536)
		: positiveInteger(input.keepRecentTokens, "keepRecentTokens");
	if (reserveTokens + keepRecentTokens > Math.floor(contextWindow * 0.8)) {
		throw new Error("Compaction reserveTokens and keepRecentTokens must leave at least 20% of the model context available");
	}
	return {
		enabled: input.enabled ?? true,
		reserveTokens,
		keepRecentTokens,
		triggerAtTokens: contextWindow - reserveTokens,
	};
}

/** Verify that Pi's lossy summary retained every durable Task identity. */
export function assessCompactionPreservation(input: { summary: string; expectedTaskIds: readonly string[] }): CompactionPreservationAssessment {
	const expected = [...new Set(input.expectedTaskIds.map((id) => id.trim()).filter(Boolean))];
	const missingTaskIds = expected.filter((id) => !input.summary.includes(id));
	return { complete: missingTaskIds.length === 0, missingTaskIds };
}

/** Return the authoritative envelope only when Pi's summary omitted durable identities. */
export function recoverCompactionPreservation(input: { summary: string; preservation: string; expectedTaskIds: readonly string[] }): CompactionPreservationRecovery {
	const assessment = assessCompactionPreservation(input);
	const quality = evaluateCompactionQuality({ summary: input.summary, preservation: input.preservation });
	return assessment.complete && quality.status === "good" ? assessment : { ...assessment, recoveryContext: input.preservation };
}

/**
 * Evaluate the lossy summary against durable identity and continuation anchors.
 * This is a deterministic multilingual lexical proxy, not a second LLM judge;
 * only identity loss triggers authoritative recovery.
 */
export function evaluateCompactionQuality(input: { summary: string; preservation: string }): CompactionQualityAssessment {
	const expectedTaskIds = taskIdsFromCompactionPreservation(input.preservation);
	const identity = assessCompactionPreservation({ summary: input.summary, expectedTaskIds });
	const semanticAnchors = semanticAnchorsFromPreservation(input.preservation);
	const scores = semanticAnchors.map((anchor) => lexicalCoverage(anchor, input.summary));
	const semanticCoverage = scores.length ? scores.reduce((total, score) => total + score, 0) / scores.length : 1;
	const missingSemanticAnchors = semanticAnchors.filter((_anchor, index) => scores[index] < 0.35);
	const identityCoverage = expectedTaskIds.length ? (expectedTaskIds.length - identity.missingTaskIds.length) / expectedTaskIds.length : 1;
	return {
		...identity,
		status: !identity.complete ? "critical" : semanticCoverage < 0.6 ? "degraded" : "good",
		identityCoverage,
		semanticCoverage,
		semanticAnchorCount: semanticAnchors.length,
		missingSemanticAnchors,
	};
}

/** Extract only Task Ledger identities from the authoritative envelope records. */
export function taskIdsFromCompactionPreservation(envelope: string): string[] {
	return [...new Set(parseTaskPreservationRecords(envelope).flatMap((record) => typeof record.authoritative.id === "string" ? [record.authoritative.id] : []))];
}

function semanticAnchorsFromPreservation(envelope: string): string[] {
	const records = parseTaskPreservationRecords(envelope);
	const anchors: string[] = [];
	for (const record of records) {
		const authoritative = record.authoritative;
		collectText(anchors, authoritative.title, authoritative.description, authoritative.acceptanceCriteria);
		const situation = asRecord(authoritative.situation);
		collectText(anchors, situation.summary);
		collectTextList(anchors, situation.goals, situation.constraints, situation.uncertainties);
		collectTextList(anchors, authoritative.routes);
		const checkpoint = authoritative.checkpoint;
		if (typeof checkpoint === "string") {
			try {
				const parsed = asRecord(JSON.parse(checkpoint));
				collectText(anchors, parsed.nextSafeStep);
				collectTextList(anchors, parsed.unresolvedIssues, parsed.completed, parsed.evidenceRefs);
			} catch { collectText(anchors, checkpoint); }
		}
	}
	return [...new Set(anchors.map((anchor) => anchor.trim()).filter((anchor) => normalizedText(anchor).length >= 4))];
}

function parseTaskPreservationRecords(envelope: string): Array<{ authoritative: Record<string, unknown> }> {
	const start = envelope.indexOf("[");
	const end = envelope.lastIndexOf("]");
	if (start < 0 || end <= start) return [];
	try {
		const parsed = JSON.parse(envelope.slice(start, end + 1));
		return Array.isArray(parsed) ? parsed.map((record) => ({ authoritative: asRecord(asRecord(record).authoritative) })) : [];
	} catch { return []; }
}

function lexicalCoverage(anchor: string, summary: string): number {
	const expected = normalizedText(anchor);
	const actual = normalizedText(summary);
	if (!expected) return 1;
	if (actual.includes(expected)) return 1;
	const grams = characterGrams(expected, expected.length < 8 ? 2 : 3);
	if (!grams.length) return 0;
	const actualGrams = new Set(characterGrams(actual, expected.length < 8 ? 2 : 3));
	return grams.filter((gram) => actualGrams.has(gram)).length / grams.length;
}

function characterGrams(value: string, size: number): string[] {
	const chars = [...value];
	if (chars.length < size) return chars.length ? [value] : [];
	return [...new Set(chars.slice(0, chars.length - size + 1).map((_char, index) => chars.slice(index, index + size).join("")))];
}

function normalizedText(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
}

function collectText(target: string[], ...values: unknown[]): void {
	for (const value of values) if (typeof value === "string" && value.trim()) target.push(value);
}

function collectTextList(target: string[], ...values: unknown[]): void {
	for (const value of values) if (Array.isArray(value)) collectText(target, ...value);
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finiteInteger(value: number, name: string): number {
	if (!Number.isFinite(value) || !Number.isInteger(value)) throw new Error(`${name} must be a finite integer`);
	return value;
}

function positiveInteger(value: number, name: string): number {
	const integer = finiteInteger(value, name);
	if (integer < 1_024) throw new Error(`${name} must be at least 1024 tokens`);
	return integer;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}
