import type { AgentSession } from "@earendil-works/pi-coding-agent";

const pending = new WeakSet<AgentSession>();

export function markResourceReloadNeeded(session: AgentSession | undefined): void {
	if (session) pending.add(session);
}

export async function reloadResourcesIfNeeded(session: AgentSession): Promise<boolean> {
	if (!pending.has(session)) return false;
	pending.delete(session);
	await session.reload();
	return true;
}
