export type ManagedSkillRiskTier = "low" | "medium" | "high";
export type ManagedSkillSelectionChannel = "stable" | "canary";

export interface RegisterManagedSkillVersionInput {
	profileId: string;
	name: string;
	versionSha256: string;
	artifactSha256: string;
	signedReceiptRef: string;
	acceptedTrialIds: readonly string[];
	riskTier: ManagedSkillRiskTier;
	policyVersion: string;
	registeredAt: number;
}

export interface ManagedSkillPointerSnapshot {
	name: string;
	stableVersionSha256: string;
	stableArtifactSha256: string;
	canaryVersionSha256?: string;
	canaryArtifactSha256?: string;
	canaryPercentage: number;
	status: "stable" | "canary" | "rolled_back";
	revision: number;
	updatedAt: number;
}

export interface SelectManagedSkillVersionInput {
	profileId: string;
	name: string;
	executionId: string;
	policyVersion: string;
	selectedAt: number;
}

export interface ManagedSkillSelectionReceipt {
	receiptId: string;
	receiptDigest: string;
	name: string;
	executionId: string;
	channel: ManagedSkillSelectionChannel;
	versionSha256: string;
	artifactSha256: string;
	bucket: number;
	canaryPercentage: number;
	pointerRevision: number;
	policyVersion: string;
	selectedAt: number;
	/** Effective execution fallback after the selected canary failed an immutable artifact fence. */
	fallbackFromReceiptId?: string;
	fallbackReasonCode?: "canary_artifact_integrity_failed";
}

export interface RollbackManagedSkillVersionInput {
	profileId: string;
	name: string;
	targetVersionSha256: string;
	evidenceRef: string;
	policyVersion: string;
	rolledBackAt: number;
	mode?: "manual" | "automatic_integrity";
}

/** Profile-bound semantic authority for managed Skill rollout metadata. */
export interface ManagedSkillLearningPort {
	registerVersion(input: RegisterManagedSkillVersionInput): ManagedSkillPointerSnapshot;
	selectVersion(input: SelectManagedSkillVersionInput): ManagedSkillSelectionReceipt | undefined;
	listManagedSkillNames(profileId: string): readonly string[];
	getPointer?(profileId: string, name: string): ManagedSkillPointerSnapshot | undefined;
	rollbackVersion(input: RollbackManagedSkillVersionInput): ManagedSkillPointerSnapshot;
}
