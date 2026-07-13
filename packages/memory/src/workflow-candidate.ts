import type { ConventionCandidate, OrganizationMemoryPort, RecallOptions, WorkflowCandidate, WorkflowCandidateInput } from "./store.ts";

export type WorkflowCandidateScope = Pick<RecallOptions, "profileId" | "platform" | "chatId" | "userId" | "threadId">;
export interface WorkflowCandidateInferenceContext { conventions: readonly ConventionCandidate[]; }
export type WorkflowCandidateInference = (context: WorkflowCandidateInferenceContext) => Promise<Array<Omit<WorkflowCandidateInput, keyof WorkflowCandidateScope>>>;

type WorkflowCandidateMemoryPort = Pick<OrganizationMemoryPort, "listConventionCandidates" | "upsertWorkflowCandidate">;

/** Derives reviewable instruction data from confirmed Conventions; it never executes or publishes Policy. */
export class WorkflowCandidateDeriver {
	private readonly memory: WorkflowCandidateMemoryPort;
	private readonly infer: WorkflowCandidateInference;
	constructor(memory: WorkflowCandidateMemoryPort, infer: WorkflowCandidateInference) { this.memory = memory; this.infer = infer; }

	async run(scope: WorkflowCandidateScope): Promise<WorkflowCandidate[]> {
		const conventions = this.memory.listConventionCandidates({ ...scope, status: "confirmed", limit: 100 });
		if (!conventions.length) return [];
		const allowed = new Set(conventions.map((candidate) => candidate.id));
		const proposals = await this.infer({ conventions });
		return proposals.slice(0, 20).map((proposal) => {
			if (!proposal.sourceConventionIds.length || proposal.sourceConventionIds.some((id) => !allowed.has(id))) throw new Error("Workflow Candidate inference referenced an unconfirmed or out-of-scope Convention");
			return this.memory.upsertWorkflowCandidate({ ...scope, ...proposal });
		});
	}
}
