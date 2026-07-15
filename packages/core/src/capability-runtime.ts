import { createHash } from "node:crypto";
import { rankCapabilityIndex, type RankableCapability } from "./capability-ranking.ts";
import type { ToolSideEffect } from "./tool-runtime.ts";

export type CapabilityKind = "tool" | "mcp" | "skill";
export type CapabilityRankingStrategy = "lexical" | "semantic";
export type CapabilityEffectStatus = "none" | "planned" | "executing" | "committed" | "failed" | "unknown";

export interface CapabilityDescriptor extends RankableCapability {
	kind: CapabilityKind;
	version: string;
	activeTools: readonly string[];
}

export interface CapabilityExplanation {
	strategy: CapabilityRankingStrategy;
	summary: string;
	signals: string[];
}

export interface CapabilityCandidate {
	kind: CapabilityKind;
	name: string;
	version: string;
	score: number;
	confidence: number;
	explanation: CapabilityExplanation;
}

export interface CapabilitySelection {
	query: string;
	candidates: CapabilityCandidate[];
	activatedTools: string[];
}

interface RankedCapability {
	descriptor: CapabilityDescriptor;
	score: number;
	confidence: number;
	explanation: CapabilityExplanation;
}

const MIN_DISCOVERY_CONFIDENCE = 0.2;

export interface CapabilityRanker {
	rank(query: string, inventory: readonly CapabilityDescriptor[], limit: number): Promise<RankedCapability[]>;
}

export interface SemanticCapabilityPort {
	similarities(input: { query: string; candidates: Array<{ name: string; text: string }>; limit: number }): Promise<Array<{ name: string; similarity: number; signals?: string[] }>>;
}

export interface PiActiveToolsPort { setActiveTools(names: string[]): void; }

export class LexicalCapabilityRanker implements CapabilityRanker {
	async rank(query: string, inventory: readonly CapabilityDescriptor[], limit: number): Promise<RankedCapability[]> {
		return rankCapabilityIndex(query, inventory, limit).map(({ item, score, confidence, reason }) => ({
			descriptor: item,
			score,
			confidence,
			explanation: { strategy: "lexical", summary: reason, signals: [reason] },
		}));
	}
}

export class SemanticCapabilityRanker implements CapabilityRanker {
	private readonly port: SemanticCapabilityPort;
	constructor(port: SemanticCapabilityPort) { this.port = port; }
	async rank(query: string, inventory: readonly CapabilityDescriptor[], limit: number): Promise<RankedCapability[]> {
		const byName = new Map(inventory.map((descriptor) => [descriptor.name, descriptor]));
		const ranked = await this.port.similarities({ query, candidates: inventory.map((descriptor) => ({ name: descriptor.name, text: [descriptor.name, descriptor.description, ...(descriptor.aliases ?? []), ...(descriptor.triggers ?? [])].filter(Boolean).join("\n") })), limit });
		return ranked.flatMap((match): RankedCapability[] => {
			const descriptor = byName.get(match.name);
			if (!descriptor || !Number.isFinite(match.similarity) || match.similarity <= 0) return [];
			const confidence = Math.max(0, Math.min(1, match.similarity));
			const signals = (match.signals ?? []).filter((signal) => typeof signal === "string" && signal.trim()).map((signal) => signal.trim().slice(0, 200)).slice(0, 10);
			return [{ descriptor, score: confidence * 100, confidence, explanation: { strategy: "semantic", summary: signals[0] ?? "semantic similarity", signals } }];
		}).sort((left, right) => right.score - left.score || left.descriptor.name.localeCompare(right.descriptor.name)).slice(0, limit);
	}
}

/** Owns versioned Capability selection and safe activation while Pi remains execution authority. */
export class CapabilityRuntime {
	private readonly ranker: CapabilityRanker;
	private readonly activeTools?: PiActiveToolsPort;
	constructor(options: { ranker?: CapabilityRanker; activeTools?: PiActiveToolsPort } = {}) {
		this.ranker = options.ranker ?? new LexicalCapabilityRanker();
		this.activeTools = options.activeTools;
	}

	async discover(input: { query: string; inventory: readonly CapabilityDescriptor[]; limit?: number }): Promise<CapabilitySelection> {
		const query = required(input.query, "Capability query", 500);
		const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 10), 100));
		const inventory = input.inventory.map((descriptor) => capabilityDescriptor(descriptor));
		const allowed = new Map(inventory.map((descriptor) => [`${descriptor.kind}:${descriptor.name}:${descriptor.version}`, descriptor]));
		const ranked = (await this.ranker.rank(query, inventory, limit))
			.filter((match) => match.confidence >= MIN_DISCOVERY_CONFIDENCE && allowed.has(`${match.descriptor.kind}:${match.descriptor.name}:${match.descriptor.version}`))
			.slice(0, limit);
		// Candidate relevance and Pi Tool activation are different orderings: expose
		// ranked candidates as-is, but activate direct execution Tools before the
		// Skill control Tools that can progressively expand the turn inventory.
		const activationOrder = [...ranked].sort((left, right) => capabilityActivationPriority(left.descriptor.kind) - capabilityActivationPriority(right.descriptor.kind));
		const activatedTools = [...new Set(activationOrder.flatMap((match) => match.descriptor.activeTools))];
		this.activeTools?.setActiveTools(activatedTools);
		return {
			query,
			candidates: ranked.map((match) => ({ kind: match.descriptor.kind, name: match.descriptor.name, version: match.descriptor.version, score: match.score, confidence: match.confidence, explanation: { ...match.explanation, signals: [...match.explanation.signals] } })),
			activatedTools,
		};
	}

	canReroute(input: { sideEffect: ToolSideEffect; effectStatus?: CapabilityEffectStatus }): { allowed: boolean; reason: string } {
		const effectStatus = input.effectStatus ?? "none";
		if (effectStatus !== "none" && effectStatus !== "failed") return { allowed: false, reason: `Effect status ${effectStatus} requires settlement or reconciliation before reroute` };
		if (input.sideEffect !== "none") return { allowed: false, reason: `${input.sideEffect} mutation cannot be replayed through Capability reroute` };
		return { allowed: true, reason: "read-only capability failed without an unresolved Effect" };
	}
}

function capabilityActivationPriority(kind: CapabilityKind): number { return kind === "skill" ? 1 : 0; }

export function capabilityDescriptor(input: CapabilityDescriptor): CapabilityDescriptor {
	const kind = input.kind;
	if (kind !== "tool" && kind !== "mcp" && kind !== "skill") throw new Error("Capability kind is invalid");
	const activeTools = [...new Set(input.activeTools.map((name) => required(name, "Capability active Tool", 128)))];
	if (!activeTools.length) throw new Error("Capability must activate at least one Pi Tool");
	return Object.freeze({
		kind,
		name: required(input.name, "Capability name", 128),
		description: input.description ? required(input.description, "Capability description", 2_000) : undefined,
		version: required(input.version, "Capability version", 256),
		activeTools: Object.freeze(activeTools),
		aliases: Object.freeze([...(input.aliases ?? [])].map((value) => required(value, "Capability alias", 500))),
		triggers: Object.freeze([...(input.triggers ?? [])].map((value) => required(value, "Capability trigger", 500))),
		exclude: Object.freeze([...(input.exclude ?? [])].map((value) => required(value, "Capability exclusion", 500))),
		priority: input.priority,
	});
}

export function capabilityVersionOf(input: unknown): string {
	return `sha256:${createHash("sha256").update(stableJson(input)).digest("hex")}`;
}

function stableJson(input: unknown): string {
	if (Array.isArray(input)) return `[${input.map(stableJson).join(",")}]`;
	if (input && typeof input === "object") return `{${Object.entries(input as Record<string, unknown>).filter(([, value]) => value !== undefined && typeof value !== "function").sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${JSON.stringify(key)}:${stableJson(value)}`).join(",")}}`;
	return JSON.stringify(input) ?? "null";
}

function required(value: string, label: string, maxLength: number): string {
	const normalized = value?.trim();
	if (!normalized || normalized.length > maxLength) throw new Error(`${label} must be between 1 and ${maxLength} characters`);
	return normalized;
}
