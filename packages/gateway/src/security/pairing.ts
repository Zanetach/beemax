import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomInt, randomUUID } from "node:crypto";
import type { PairingApproval, PairingAuthority, PairingRequest, PairingRequestResult } from "@thruvera/channel-runtime";

export type { PairingApproval, PairingAuthority, PairingRequest, PairingRequestResult } from "@thruvera/channel-runtime";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_TTL_MS = 60 * 60_000;
const RATE_LIMIT_MS = 10 * 60_000;
const LOCKOUT_MS = 60 * 60_000;
const MAX_PENDING = 3;
const MAX_FAILED = 5;
const LOCK_TIMEOUT_MS = 2_000;
const STALE_LOCK_MS = 30_000;

interface PairingState {
	pending: Record<string, PairingRequest[]>;
	approved: Record<string, PairingApproval[]>;
	rates: Record<string, number>;
}

export class PairingStore implements PairingAuthority {
	private readonly directory: string;
	private readonly statePath: string;
	private readonly lockPath: string;
	constructor(profileDirectory: string) {
		this.directory = join(profileDirectory, "state", "pairing");
		this.statePath = join(this.directory, "state.json");
		this.lockPath = join(this.directory, ".lock");
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		chmodSync(this.directory, 0o700);
	}

	isApproved(platform: string, userIds: string[]): boolean {
		platform = safePlatform(platform);
		return (this.readState().approved[platform] ?? []).some((entry) => userIds.includes(entry.userId));
	}

	request(platform: string, userId: string, now = Date.now()): PairingRequestResult {
		platform = safePlatform(platform); userId = safeUserId(userId);
		return this.mutate((state) => {
			const pending = activePending(state, platform, now);
			const rateKey = `request:${platform}:${userId}`;
			const last = state.rates[rateKey];
			if (last !== undefined && now - last < RATE_LIMIT_MS) return { status: "rate_limited" };
			const existing = pending.find((entry) => entry.userId === userId);
			if (existing) { state.rates[rateKey] = now; return { status: "existing", code: existing.code, expiresAt: existing.expiresAt }; }
			if (pending.length >= MAX_PENDING) return { status: "capacity" };
			let code: string;
			do { code = randomCode(); } while (Object.values(state.pending).flat().some((entry) => entry.code === code));
			const request = { platform, userId, code, createdAt: now, expiresAt: now + CODE_TTL_MS };
			state.pending[platform] = [...pending, request];
			state.rates[rateKey] = now;
			return { status: "created", code, expiresAt: request.expiresAt };
		});
	}

	approve(platform: string, code: string, now = Date.now()): PairingApproval | undefined {
		platform = safePlatform(platform);
		return this.mutate((state) => {
			const lockKey = `lockout:${platform}`;
			if ((state.rates[lockKey] ?? 0) > now) throw new Error(`Pairing approvals for ${platform} are temporarily locked`);
			const pending = activePending(state, platform, now);
			const index = pending.findIndex((entry) => entry.code === code.trim().toUpperCase());
			if (index < 0) {
				const failureKey = `failures:${platform}`;
				const failures = (state.rates[failureKey] ?? 0) + 1;
				state.rates[failureKey] = failures;
				if (failures >= MAX_FAILED) { state.rates[lockKey] = now + LOCKOUT_MS; state.rates[failureKey] = 0; }
				return undefined;
			}
			const request = pending[index];
			const approval = { platform, userId: request.userId, approvedAt: now };
			state.approved[platform] = [...(state.approved[platform] ?? []).filter((entry) => entry.userId !== approval.userId), approval];
			state.pending[platform] = pending.filter((_, candidate) => candidate !== index);
			delete state.rates[`failures:${platform}`]; delete state.rates[lockKey];
			return approval;
		});
	}

	revoke(platform: string, userId: string): boolean {
		platform = safePlatform(platform); userId = safeUserId(userId);
		return this.mutate((state) => {
			const approved = state.approved[platform] ?? [];
			const next = approved.filter((entry) => entry.userId !== userId);
			state.approved[platform] = next;
			return next.length !== approved.length;
		});
	}

	list(platform = "feishu", now = Date.now()): { pending: PairingRequest[]; approved: PairingApproval[] } {
		platform = safePlatform(platform);
		return this.mutate((state) => ({ pending: [...activePending(state, platform, now)], approved: [...(state.approved[platform] ?? [])] }));
	}

	clearPending(platform = "feishu"): number {
		platform = safePlatform(platform);
		return this.mutate((state) => { const count = (state.pending[platform] ?? []).length; state.pending[platform] = []; return count; });
	}

	private mutate<T>(operation: (state: PairingState) => T): T {
		const release = this.acquireLock();
		try { const state = this.readState(); const result = operation(state); this.writeState(state); return result; }
		finally { release(); }
	}

	private readState(): PairingState {
		let raw: string;
		try { raw = readFileSync(this.statePath, "utf8"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { pending: {}, approved: {}, rates: {} }; throw error; }
		let value: unknown;
		try { value = JSON.parse(raw); } catch { throw new Error("Pairing state is corrupt; refusing access changes"); }
		if (!validState(value)) throw new Error("Pairing state has an invalid schema; refusing access changes");
		return value;
	}

	private writeState(state: PairingState): void {
		const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
			const file = openSync(temporary, "r");
			try { fsyncSync(file); } finally { closeSync(file); }
			renameSync(temporary, this.statePath); chmodSync(this.statePath, 0o600);
			const directory = openSync(this.directory, "r");
			try { fsyncSync(directory); } finally { closeSync(directory); }
		}
		catch (error) { rmSync(temporary, { force: true }); throw error; }
	}

	private acquireLock(): () => void {
		const startedAt = Date.now();
		const token = `${process.pid}:${randomUUID()}`;
		const ownerPath = join(this.lockPath, "owner");
		for (;;) {
			try {
				mkdirSync(this.lockPath, { mode: 0o700 });
				try { writeFileSync(ownerPath, token, { encoding: "utf8", mode: 0o600, flag: "wx" }); }
				catch (error) { rmSync(this.lockPath, { recursive: true, force: true }); throw error; }
				return () => {
					try { if (readFileSync(ownerPath, "utf8") === token) rmSync(this.lockPath, { recursive: true, force: true }); }
					catch { /* lock was already reclaimed; never remove a new owner's lock */ }
				};
			}
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				try { if (Date.now() - statSync(this.lockPath).mtimeMs > STALE_LOCK_MS) { rmSync(this.lockPath, { recursive: true, force: true }); continue; } } catch { continue; }
				if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) throw new Error("Pairing state is busy; retry the command");
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
			}
		}
	}
}

function activePending(state: PairingState, platform: string, now: number): PairingRequest[] { const active = (state.pending[platform] ?? []).filter((entry) => entry.expiresAt > now); state.pending[platform] = active; return active; }
function randomCode(): string { return Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(""); }
function safePlatform(value: string): string { if (!/^[a-z][a-z0-9_-]{0,31}$/.test(value)) throw new Error("Invalid pairing platform"); return value; }
function safeUserId(value: string): string { const id = value.trim(); if (!id || id.length > 256 || /[\u0000-\u001f]/.test(id)) throw new Error("Invalid pairing user ID"); return id; }
function validState(value: unknown): value is PairingState {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const state = value as Record<string, unknown>;
	if (!plainRecord(state.pending) || !plainRecord(state.approved) || !plainRecord(state.rates)) return false;
	if (!Object.values(state.rates).every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0)) return false;
	return Object.entries(state.pending).every(([platform, entries]) => /^[a-z][a-z0-9_-]{0,31}$/.test(platform) && Array.isArray(entries) && entries.length <= MAX_PENDING && entries.every(validRequest))
		&& Object.entries(state.approved).every(([platform, entries]) => /^[a-z][a-z0-9_-]{0,31}$/.test(platform) && Array.isArray(entries) && entries.length <= 10_000 && entries.every(validApproval));
}
function plainRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function validRequest(value: unknown): value is PairingRequest { if (!plainRecord(value)) return false; return typeof value.platform === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(value.platform) && validIdentity(value.userId) && typeof value.code === "string" && /^[A-HJ-NP-Z2-9]{8}$/.test(value.code) && finiteTime(value.createdAt) && finiteTime(value.expiresAt) && value.expiresAt > value.createdAt; }
function validApproval(value: unknown): value is PairingApproval { if (!plainRecord(value)) return false; return typeof value.platform === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(value.platform) && validIdentity(value.userId) && finiteTime(value.approvedAt); }
function finiteTime(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function validIdentity(value: unknown): value is string { return typeof value === "string" && Boolean(value.trim()) && value.length <= 256 && !/[\u0000-\u001f]/.test(value); }
