/**
 * Bounded in-memory ingress idempotency guard for a single Gateway process.
 * The key intentionally includes Profile: the same channel event may be
 * routed to different isolated Profiles in a multi-tenant deployment.
 */
export class MessageDeduplicator {
	private readonly seen = new Map<string, number>();
	private readonly ttlMs: number;
	private readonly maxEntries: number;
	private nextPruneAt = 0;

	constructor(options: { ttlMs?: number; maxEntries?: number } = {}) {
		this.ttlMs = clamp(options.ttlMs ?? 10 * 60_000, 1_000, 24 * 60 * 60_000);
		this.maxEntries = clamp(options.maxEntries ?? 50_000, 100, 1_000_000);
	}

	/** Returns true only for the first receipt of a provider event id. */
	accept(profile: string, platform: string, messageId: string | undefined, now = Date.now()): boolean {
		if (!messageId) return true; // providers without an id require durable adapter-specific idempotency.
		if (now >= this.nextPruneAt) {
			this.prune(now);
			this.nextPruneAt = now + Math.min(this.ttlMs, 60_000);
		}
		const key = `${profile}\u0000${platform}\u0000${messageId}`;
		if (this.seen.has(key)) return false;
		this.seen.set(key, now + this.ttlMs);
		if (this.seen.size > this.maxEntries) this.evictOldest();
		return true;
	}

	rollback(profile: string, platform: string, messageId: string | undefined): void {
		if (messageId) this.seen.delete(`${profile}\u0000${platform}\u0000${messageId}`);
	}

	private prune(now: number): void {
		for (const [key, expiresAt] of this.seen) if (expiresAt <= now) this.seen.delete(key);
	}
	private evictOldest(): void { const oldest = this.seen.keys().next().value; if (typeof oldest === "string") this.seen.delete(oldest); }
}
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
