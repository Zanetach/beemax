import { createHash } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { BeeMaxRuntimeSource } from "./runtime.ts";
import { conversationKey, conversationOwnerKey } from "./agent-scope.ts";
import type { ExecutionEnvelope } from "./execution-envelope.ts";

/** Stable per-conversation identity, independent of a transport adapter. */
export function sessionKeyForSource(source: BeeMaxRuntimeSource): string {
	return conversationKey(source);
}

/** Stable identity for a channel conversation, excluding a particular thread. */
export function sessionOwnerKey(source: BeeMaxRuntimeSource): string {
	return conversationOwnerKey(source);
}

/** A deterministic UUID-shaped id used by the runtime's persisted session store. */
export function sessionIdForSource(source: BeeMaxRuntimeSource): string {
	// Preserve the pre-R2 stable persisted transcript ids while the catalog adds
	// a separate owner/thread index for discovery.
	const hex = createHash("sha256").update(conversationKey(source)).digest("hex").slice(0, 32);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface RuntimeSession {
	sessionKey: string;
	sessionId: string;
	source: BeeMaxRuntimeSource;
	piSession: AgentSession;
	executionEnvelope?: Readonly<ExecutionEnvelope>;
	busy: boolean;
	lastActiveAt: number;
}

/** A renderer-safe view of a live runtime session. */
export interface RuntimeSessionSnapshot {
	sessionKey: string;
	sessionId: string;
	threadId?: string;
	busy: boolean;
	lastActiveAt: number;
}

export type RuntimeSessionFactory<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> = (
	sessionId: string,
	source: Source,
	executionEnvelope?: Readonly<ExecutionEnvelope>,
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

	async run<T>(source: Source, factory: RuntimeSessionFactory<Source>, action: (session: RuntimeSession) => Promise<T>, executionEnvelope?: Readonly<ExecutionEnvelope>): Promise<T> {
		const key = sessionKeyForSource(source);
		return this.withLock(key, async () => {
			this.prune();
			const session = await this.getOrCreate(source, factory, executionEnvelope);
			session.executionEnvelope = executionEnvelope;
			(session.piSession as AgentSession & { beemaxExecutionEnvelope?: Readonly<ExecutionEnvelope> }).beemaxExecutionEnvelope = executionEnvelope;
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

	async withSession<T>(source: Source, action: (session: RuntimeSession) => Promise<T>): Promise<T | undefined> {
		const session = this.sessions.get(sessionKeyForSource(source));
		return session ? action(session) : undefined;
	}

	/** Returns live sessions only; persisted transcripts are restored lazily by the session factory. */
	list(source?: Source): RuntimeSessionSnapshot[] {
		const owner = source ? sessionOwnerKey(source) : undefined;
		return [...this.sessions.values()]
			.filter((session) => owner === undefined || sessionOwnerKey(session.source) === owner)
			.map(({ sessionKey, sessionId, source: sessionSource, busy, lastActiveAt }) => ({ sessionKey, sessionId, threadId: sessionSource.threadId, busy, lastActiveAt }))
			.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
	}

	/** Drop an idle loaded session; persistent transcript retention is owned by the session factory. */
	reset(source: Source): boolean {
		const key = sessionKeyForSource(source);
		const session = this.sessions.get(key);
		if (!session || session.busy) return false;
		session.piSession.dispose();
		this.sessions.delete(key);
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

	private async getOrCreate(source: Source, factory: RuntimeSessionFactory<Source>, executionEnvelope?: Readonly<ExecutionEnvelope>): Promise<RuntimeSession> {
		const key = sessionKeyForSource(source);
		const existing = this.sessions.get(key);
		if (existing) { existing.lastActiveAt = Date.now(); return existing; }
		const pending = this.creations.get(key);
		if (pending) return pending;
		this.prune(Date.now(), 1);
		const creation = (async () => {
			const session: RuntimeSession = { sessionKey: key, sessionId: sessionIdForSource(source), source: { ...source }, piSession: await factory(sessionIdForSource(source), source, executionEnvelope), executionEnvelope, busy: false, lastActiveAt: Date.now() };
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
