import { createHash } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ThruveraRuntimeSource } from "./runtime.ts";
import { canonicalUserId, conversationKey, conversationOwnerKey } from "./agent-scope.ts";
import type { ExecutionEnvelope } from "./execution-envelope.ts";

/** Stable per-conversation identity, independent of a transport adapter. */
export function sessionKeyForSource(source: ThruveraRuntimeSource): string {
	return conversationKey(source);
}

/** Stable identity for a channel conversation, excluding a particular thread. */
export function sessionOwnerKey(source: ThruveraRuntimeSource): string {
	return conversationOwnerKey(source);
}

/** A deterministic UUID-shaped id used by the runtime's persisted session store. */
export function sessionIdForSource(source: ThruveraRuntimeSource): string {
	// Preserve the pre-R2 stable persisted transcript ids while the catalog adds
	// a separate owner/thread index for discovery.
	return sessionIdForKey(conversationKey(source));
}

/** Pre-shared-conversation transcript ids, ordered from the closest legacy identity to the oldest. */
export function legacySessionIdsForSource(source: ThruveraRuntimeSource): string[] {
	const actor = canonicalUserId(source) ?? "anon";
	const chat = source.threadId ? `${source.chatId}#${source.threadId}` : source.chatId;
	const keys = [
		`${source.platform}:${chat}:${actor}`,
		...(source.chatType === "dm" ? [] : [`${source.platform}:${chat}`]),
	];
	return [...new Set(keys.map(sessionIdForKey))].filter((id) => id !== sessionIdForSource(source));
}

function sessionIdForKey(key: string): string {
	const hex = createHash("sha256").update(key).digest("hex").slice(0, 32);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface RuntimeSession {
	sessionKey: string;
	sessionId: string;
	source: ThruveraRuntimeSource;
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

export type RuntimeSessionFactory<Source extends ThruveraRuntimeSource = ThruveraRuntimeSource> = (
	sessionId: string,
	source: Source,
	executionEnvelope?: Readonly<ExecutionEnvelope>,
	legacySessionIds?: string[],
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
export class SessionCoordinator<Source extends ThruveraRuntimeSource = ThruveraRuntimeSource> {
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
			const sessionId = sessionIdForSource(source);
			const session: RuntimeSession = { sessionKey: key, sessionId, source: { ...source }, piSession: await factory(sessionId, source, executionEnvelope, legacySessionIdsForSource(source)), executionEnvelope, busy: false, lastActiveAt: Date.now() };
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
