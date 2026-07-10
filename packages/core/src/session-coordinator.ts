import { createHash } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { BeeMaxRuntimeSource } from "./runtime.ts";

/** Stable per-conversation identity, independent of a transport adapter. */
export function sessionKeyForSource(source: BeeMaxRuntimeSource): string {
	const userPart = source.userIdAlt ?? source.userId ?? "anon";
	const chatPart = source.threadId ? `${source.chatId}#${source.threadId}` : source.chatId;
	return `${source.platform}:${chatPart}:${userPart}`;
}

/** A deterministic UUID-shaped id used by the runtime's persisted session store. */
export function sessionIdForSource(source: BeeMaxRuntimeSource): string {
	const hex = createHash("sha256").update(sessionKeyForSource(source)).digest("hex").slice(0, 32);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface RuntimeSession {
	sessionKey: string;
	sessionId: string;
	piSession: AgentSession;
	busy: boolean;
	lastActiveAt: number;
}

export type RuntimeSessionFactory<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> = (
	sessionId: string,
	source: Source,
) => Promise<AgentSession>;

export interface SessionCoordinatorOptions {
	maxSessions?: number;
	sessionIdleMs?: number;
}

/**
 * Owns runtime session identity, creation de-duplication, per-owner serial
 * execution, cancellation, and bounded in-memory session lifecycle. Gateway
 * renderers never decide these agent invariants.
 */
export class SessionCoordinator<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> {
	private readonly sessions = new Map<string, RuntimeSession>();
	private readonly creations = new Map<string, Promise<RuntimeSession>>();
	private readonly locks = new Map<string, Promise<void>>();
	private readonly maxSessions: number;
	private readonly sessionIdleMs: number;

	constructor(options: SessionCoordinatorOptions = {}) {
		this.maxSessions = clamp(options.maxSessions ?? 100, 1, 10_000);
		this.sessionIdleMs = clamp(options.sessionIdleMs ?? 30 * 60_000, 60_000, 24 * 60 * 60_000);
	}

	async run<T>(source: Source, factory: RuntimeSessionFactory<Source>, action: (session: RuntimeSession) => Promise<T>): Promise<T> {
		const key = sessionKeyForSource(source);
		return this.withLock(key, async () => {
			this.prune();
			const session = await this.getOrCreate(source, factory);
			session.busy = true;
			try { return await action(session); }
			finally { session.busy = false; session.lastActiveAt = Date.now(); }
		});
	}

	async abort(source: Source): Promise<boolean> {
		const session = this.sessions.get(sessionKeyForSource(source));
		if (!session) return false;
		await session.piSession.abort();
		return true;
	}

	isBusy(): boolean { return this.locks.size > 0 || [...this.sessions.values()].some((session) => session.busy); }

	dispose(): void {
		for (const session of this.sessions.values()) session.piSession.dispose();
		this.sessions.clear();
	}

	private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.locks.get(key) ?? Promise.resolve();
		let release!: () => void;
		const next = new Promise<void>((resolve) => { release = resolve; });
		const chain = previous.then(() => next);
		this.locks.set(key, chain);
		await previous;
		try { return await fn(); }
		finally { release(); if (this.locks.get(key) === chain) this.locks.delete(key); }
	}

	private async getOrCreate(source: Source, factory: RuntimeSessionFactory<Source>): Promise<RuntimeSession> {
		const key = sessionKeyForSource(source);
		const existing = this.sessions.get(key);
		if (existing) { existing.lastActiveAt = Date.now(); return existing; }
		const pending = this.creations.get(key);
		if (pending) return pending;
		this.prune(Date.now(), 1);
		const creation = (async () => {
			const session: RuntimeSession = { sessionKey: key, sessionId: sessionIdForSource(source), piSession: await factory(sessionIdForSource(source), source), busy: false, lastActiveAt: Date.now() };
			this.sessions.set(key, session);
			return session;
		})();
		this.creations.set(key, creation);
		try { return await creation; } finally { this.creations.delete(key); }
	}

	private prune(now = Date.now(), reserve = 0): void {
		const idle = [...this.sessions.values()].filter((session) => !session.busy).sort((a, b) => a.lastActiveAt - b.lastActiveAt);
		for (const session of idle) {
			if (now - session.lastActiveAt < this.sessionIdleMs && this.sessions.size + reserve <= this.maxSessions) break;
			session.piSession.dispose(); this.sessions.delete(session.sessionKey);
		}
	}
}

function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
