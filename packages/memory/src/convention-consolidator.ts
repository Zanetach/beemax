import type { ConventionCandidate, ConventionCandidateInput, MemoryClaim, OrganizationMemoryEpisode, OrganizationMemoryPort, RecallOptions } from "./store.ts";

export type ConventionScope = Pick<RecallOptions, "profileId" | "platform" | "chatId" | "userId" | "threadId">;

export interface ConventionInferenceContext {
	episodes: readonly OrganizationMemoryEpisode[];
	exceptions: readonly MemoryClaim[];
}

export type ConventionInference = (context: ConventionInferenceContext) => Promise<Array<Omit<ConventionCandidateInput, keyof ConventionScope>>>;

type ConventionMemoryPort = Pick<OrganizationMemoryPort, "listEpisodes" | "listClaims" | "upsertConventionCandidate">;

/** Async semantic inference around a deterministic, scope-enforcing Memory authority. */
export class ConventionConsolidator {
	private readonly memory: ConventionMemoryPort;
	private readonly infer: ConventionInference;

	constructor(memory: ConventionMemoryPort, infer: ConventionInference) {
		this.memory = memory;
		this.infer = infer;
	}

	async run(scope: ConventionScope): Promise<ConventionCandidate[]> {
		const episodes = this.memory.listEpisodes({ ...scope, statuses: ["verified", "conflicted"], limit: 100 });
		const exceptions = this.memory.listClaims({ ...scope, status: "active", limit: 100 }).filter((claim) => claim.kind === "exception");
		if (episodes.filter((episode) => episode.status === "verified").length < 2) return [];
		const proposals = await this.infer({ episodes, exceptions });
		return proposals.slice(0, 20).map((proposal) => this.memory.upsertConventionCandidate({ ...scope, ...proposal }));
	}
}
