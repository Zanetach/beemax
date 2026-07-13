import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { BeeMaxRuntimeSource } from "./runtime.ts";

export interface InteractionQueuedInput<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> {
	id: string;
	key: string;
	text: string;
	source: Source;
	createdAt: number;
	claimToken?: string;
	claimExpiresAt?: number;
}

export interface InteractionInputQueueStore<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> {
	load(key: string): InteractionQueuedInput<Source>[];
	all(): InteractionQueuedInput<Source>[];
	enqueue(input: InteractionQueuedInput<Source>, limit?: number): number;
	enqueueClaimed(input: InteractionQueuedInput<Source>, limit?: number, leaseMs?: number): number;
	remove(key: string, id: string): void;
	clear(key: string): void;
	claim(platform: string, limit?: number, leaseMs?: number): InteractionQueuedInput<Source>[];
	claimKey(key: string, leaseMs?: number): InteractionQueuedInput<Source> | undefined;
	acknowledge(key: string, id: string, claimToken: string): boolean;
	release(key: string, id: string, claimToken: string): boolean;
}

/** Owner-only, lock-protected fallback store for deployments without SQLite composition. */
export class FileInteractionInputQueueStore<Source extends BeeMaxRuntimeSource = BeeMaxRuntimeSource> implements InteractionInputQueueStore<Source> {
	private readonly lockPath: string;
	private readonly maxRecords: number;
	private readonly maxBytes: number;

	constructor(privatePath: string, limits: { maxRecords?: number; maxBytes?: number } = {}) {
		this.path = privatePath;
		this.lockPath = `${privatePath}.lock`;
		this.maxRecords = Math.max(1, Math.min(limits.maxRecords ?? 10_000, 100_000));
		this.maxBytes = Math.max(256, Math.min(limits.maxBytes ?? 16 * 1024 * 1024, 128 * 1024 * 1024));
		if (existsSync(privatePath)) this.readRecords();
	}

	private readonly path: string;

	load(key: string): InteractionQueuedInput<Source>[] { return this.readRecords().filter((input) => input.key === key); }
	all(): InteractionQueuedInput<Source>[] { return this.readRecords(); }

	enqueue(input: InteractionQueuedInput<Source>, limit = 100): number {
		return this.withLock(() => {
			const records = this.readRecords();
			if (records.length >= this.maxRecords) return 0;
			const position = records.filter((candidate) => candidate.key === input.key).length;
			if (position >= limit) return 0;
			records.push(input);
			this.writeRecords(records);
			return position + 1;
		});
	}

	enqueueClaimed(input: InteractionQueuedInput<Source>, limit = 100, leaseMs = 60 * 60_000): number {
		return this.withLock(() => {
			const records = this.readRecords();
			if (records.length >= this.maxRecords) return 0;
			const position = records.filter((candidate) => candidate.key === input.key).length;
			if (position >= limit) return 0;
			if (position === 0) {
				input.claimToken = randomUUID();
				input.claimExpiresAt = Date.now() + leaseMs;
			}
			records.push(input);
			this.writeRecords(records);
			return position + 1;
		});
	}

	remove(key: string, id: string): void { this.withLock(() => this.writeRecords(this.readRecords().filter((input) => input.key !== key || input.id !== id))); }
	clear(key: string): void { this.withLock(() => this.writeRecords(this.readRecords().filter((input) => input.key !== key))); }

	claim(platform: string, limit = 100, leaseMs = 5 * 60_000): InteractionQueuedInput<Source>[] {
		return this.withLock(() => {
			const now = Date.now();
			const records = this.readRecords();
			const claimed: InteractionQueuedInput<Source>[] = [];
			const seenKeys = new Set<string>();
			for (const input of records) {
				if (claimed.length >= limit) break;
				if (seenKeys.has(input.key)) continue;
				seenKeys.add(input.key);
				if (input.source.platform !== platform || (input.claimToken && (input.claimExpiresAt ?? 0) > now)) continue;
				input.claimToken = randomUUID();
				input.claimExpiresAt = now + leaseMs;
				claimed.push({ ...input, source: { ...input.source } });
			}
			if (claimed.length) this.writeRecords(records);
			return claimed;
		});
	}

	acknowledge(key: string, id: string, claimToken: string): boolean {
		return this.withLock(() => {
			const records = this.readRecords();
			const index = records.findIndex((input) => input.key === key && input.id === id && input.claimToken === claimToken);
			if (index < 0) return false;
			records.splice(index, 1);
			this.writeRecords(records);
			return true;
		});
	}

	claimKey(key: string, leaseMs = 60 * 60_000): InteractionQueuedInput<Source> | undefined {
		return this.withLock(() => {
			const now = Date.now();
			const records = this.readRecords();
			const input = records.find((candidate) => candidate.key === key);
			if (!input || input.claimToken && (input.claimExpiresAt ?? 0) > now) return undefined;
			input.claimToken = randomUUID(); input.claimExpiresAt = now + leaseMs;
			this.writeRecords(records);
			return { ...input, source: { ...input.source } };
		});
	}

	release(key: string, id: string, claimToken: string): boolean {
		return this.withLock(() => {
			const records = this.readRecords();
			const input = records.find((candidate) => candidate.key === key && candidate.id === id && candidate.claimToken === claimToken);
			if (!input) return false;
			delete input.claimToken; delete input.claimExpiresAt;
			this.writeRecords(records);
			return true;
		});
	}

	private readRecords(): InteractionQueuedInput<Source>[] {
		if (!existsSync(this.path)) return [];
		if (statSync(this.path).size > this.maxBytes) throw new Error("Interaction input queue exceeds its byte limit");
		const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
		if (Array.isArray(parsed)) {
			if (!parsed.every(isQueuedInput)) throw new Error("Interaction input queue is corrupt");
			if (parsed.length > this.maxRecords) throw new Error("Interaction input queue exceeds its record limit");
			return parsed as InteractionQueuedInput<Source>[];
		}
		if (parsed && typeof parsed === "object") {
			const records = legacyRecords(parsed as Record<string, unknown>) as InteractionQueuedInput<Source>[];
			if (records.length > this.maxRecords) throw new Error("Interaction input queue exceeds its record limit");
			return records;
		}
		throw new Error("Interaction input queue is corrupt");
	}

	private writeRecords(records: readonly InteractionQueuedInput<Source>[]): void {
		if (records.length > this.maxRecords) throw new Error("Interaction input queue exceeds its record limit");
		const serialized = JSON.stringify(records);
		if (Buffer.byteLength(serialized, "utf8") > this.maxBytes) throw new Error("Interaction input queue exceeds its byte limit");
		const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
		writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600 });
		renameSync(temporary, this.path);
	}

	private withLock<T>(action: () => T): T {
		let descriptor: number | undefined;
		for (let attempt = 0; attempt < 100; attempt++) {
			try {
				descriptor = openSync(this.lockPath, "wx", 0o600);
				writeFileSync(descriptor, String(process.pid));
				break;
			}
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 99) throw error;
				this.recoverStaleLock();
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
			}
		}
		try { return action(); }
		finally {
			if (descriptor !== undefined) closeSync(descriptor);
			try { unlinkSync(this.lockPath); } catch { /* best-effort after acquired lock */ }
		}
	}

	private recoverStaleLock(): void {
		try {
			const owner = Number(readFileSync(this.lockPath, "utf8"));
			if (Number.isSafeInteger(owner) && owner > 0) {
				try { process.kill(owner, 0); return; }
				catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { unlinkSync(this.lockPath); return; } }
			}
		} catch { /* fall through to age-based recovery */ }
		try { if (Date.now() - statSync(this.lockPath).mtimeMs > 30_000) unlinkSync(this.lockPath); }
		catch { /* The current lock holder may be between create and PID write. */ }
	}
}

function isQueuedInput(value: unknown): value is InteractionQueuedInput {
	if (!value || typeof value !== "object") return false;
	const input = value as Partial<InteractionQueuedInput>;
	const source = input.source as Partial<BeeMaxRuntimeSource> | undefined;
	const claimValid = input.claimToken === undefined && input.claimExpiresAt === undefined
		|| typeof input.claimToken === "string" && input.claimToken.length > 0 && typeof input.claimExpiresAt === "number" && Number.isFinite(input.claimExpiresAt);
	return typeof input.id === "string" && input.id.length > 0 && typeof input.key === "string" && input.key.length > 0 && typeof input.text === "string"
		&& typeof input.createdAt === "number" && Number.isFinite(input.createdAt)
		&& Boolean(source && typeof source.platform === "string" && source.platform.length > 0 && typeof source.chatId === "string" && source.chatId.length > 0
			&& (source.chatType === "dm" || source.chatType === "group" || source.chatType === "channel" || source.chatType === "thread"))
		&& claimValid;
}

function legacyRecords(value: Record<string, unknown>): InteractionQueuedInput[] {
	const records: InteractionQueuedInput[] = [];
	for (const [key, inputs] of Object.entries(value)) {
		if (!Array.isArray(inputs) || !inputs.every((input) => typeof input === "string")) throw new Error("Interaction input queue is corrupt");
		const first = key.indexOf(":");
		const last = key.lastIndexOf(":");
		if (first <= 0 || last <= first) throw new Error("Interaction input queue is corrupt");
		const platform = key.slice(0, first);
		const chatThread = key.slice(first + 1, last);
		const marker = chatThread.indexOf("#");
		const chatId = marker >= 0 ? chatThread.slice(0, marker) : chatThread;
		const threadId = marker >= 0 ? chatThread.slice(marker + 1) : undefined;
		const userId = key.slice(last + 1);
		for (const text of inputs) records.push({
			id: randomUUID(), key, text, createdAt: Date.now(),
			source: { platform, chatId, chatType: threadId ? "thread" : "dm", threadId, userId: userId === "anon" ? undefined : userId },
		});
	}
	return records;
}
