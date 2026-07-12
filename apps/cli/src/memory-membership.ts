import { canonicalUserId, type BeeMaxRuntimeSource, type MemoryScope } from "@beemax/core";

export interface MemoryMembership {
	platform: string;
	userId: string;
	projectId?: string;
	organizationId?: string;
}

/** Build a fail-closed resolver from operator-controlled Profile configuration. */
export function createMemoryScopeResolver(memberships: readonly MemoryMembership[] = []): (source: BeeMaxRuntimeSource) => Pick<MemoryScope, "projectId" | "organizationId"> {
	const index = new Map<string, Pick<MemoryScope, "projectId" | "organizationId">>();
	for (const membership of memberships) {
		const platform = membership.platform.trim();
		const userId = membership.userId.trim();
		const projectId = membership.projectId?.trim();
		const organizationId = membership.organizationId?.trim();
		if (!platform || !userId) throw new Error("Memory membership requires platform and userId");
		if (!projectId && !organizationId) throw new Error(`Memory membership ${platform}:${userId} has no project or organization scope`);
		const key = `${platform}:${userId}`;
		if (index.has(key)) throw new Error(`Duplicate memory membership for ${key}`);
		index.set(key, {
			...(projectId ? { projectId } : {}),
			...(organizationId ? { organizationId } : {}),
		});
	}
	return (source) => index.get(`${source.platform}:${canonicalUserId(source) ?? ""}`) ?? {};
}
