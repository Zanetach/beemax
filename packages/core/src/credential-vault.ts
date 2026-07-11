import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BoundedJsonlJournal } from "./bounded-jsonl-journal.ts";

export interface CredentialInput { ownerKey: string; label: string; purpose: string; secret: string; }
export interface CredentialMetadata { ref: string; ownerKey: string; label: string; purpose: string; createdAt: number; updatedAt: number; lastUsedAt?: number; }
export interface CredentialVaultAuditEvent { action: "stored" | "accessed" | "access_denied" | "removed"; ownerKey: string; ref: string; capability?: string; at: number; }
export type CredentialVaultAuditSink = (event: CredentialVaultAuditEvent) => void;

export class FileCredentialVaultAuditJournal {
	private readonly journal: BoundedJsonlJournal<CredentialVaultAuditEvent>;
	constructor(path: string, limit = 5_000) {
		this.journal = new BoundedJsonlJournal<CredentialVaultAuditEvent>({ path, limit, minLimit: 100, maxLimit: 50_000, isRecord: isAuditEvent });
	}
	append(event: CredentialVaultAuditEvent): void { this.journal.append(event); }
	records(): CredentialVaultAuditEvent[] { return this.journal.records(); }
}
export interface CredentialVault {
	put(input: CredentialInput, now?: number): CredentialMetadata;
	list(ownerKey: string): CredentialMetadata[];
	withSecret<T>(ownerKey: string, ref: string, capability: string, consume: (secret: string) => T | Promise<T>, now?: number): Promise<T>;
	remove(ownerKey: string, ref: string, now?: number): boolean;
}

interface StoredCredential extends CredentialMetadata { secret: string; }
interface VaultPayload { records: StoredCredential[]; }
interface VaultEnvelope { version: 1; algorithm: "aes-256-gcm"; iv: string; tag: string; ciphertext: string; }
interface VaultWriteLease { token: string; acquiredAt: number; }
const WRITE_LEASE_MS = 30_000;

/** Encrypted Profile-local Secret storage. Plaintext only crosses the trusted consumer callback. */
export class FileCredentialVault implements CredentialVault {
	private readonly path: string;
	private readonly key: Buffer;
	private readonly audit?: CredentialVaultAuditSink;
	private records: StoredCredential[];
	private writeLease?: VaultWriteLease;

	constructor(path: string, key: Uint8Array, audit?: CredentialVaultAuditSink) {
		if (key.byteLength !== 32) throw new Error("Credential Vault key must contain exactly 32 bytes");
		this.path = path;
		this.key = Buffer.from(key);
		this.audit = audit;
		this.records = existsSync(path) ? this.decrypt(readFileSync(path, "utf8")) : [];
		if (existsSync(path)) chmodSync(path, 0o600);
	}

	put(input: CredentialInput, now = Date.now()): CredentialMetadata {
		const ownerKey = required(input.ownerKey, "ownerKey", 512);
		const label = required(input.label, "label", 256);
		const purpose = required(input.purpose, "purpose", 512);
		const secret = required(input.secret, "secret", 64 * 1024, false);
		const record: StoredCredential = { ref: `cred_${randomUUID()}`, ownerKey, label, purpose, secret, createdAt: now, updatedAt: now };
		this.mutate(() => { this.records.push(record); this.persist(); });
		this.emit({ action: "stored", ownerKey, ref: record.ref, at: now });
		return metadata(record);
	}

	list(ownerKey: string): CredentialMetadata[] {
		this.refresh();
		return this.records.filter((record) => record.ownerKey === ownerKey).map(metadata).sort((left, right) => right.updatedAt - left.updatedAt || left.ref.localeCompare(right.ref));
	}

	async withSecret<T>(ownerKey: string, ref: string, capability: string, consume: (secret: string) => T | Promise<T>, now = Date.now()): Promise<T> {
		if (!/^[a-z][a-z0-9._-]{1,63}$/.test(capability)) throw new Error("Credential access capability must be a stable non-sensitive identifier");
		const secret = this.mutate(() => {
			const record = this.records.find((candidate) => candidate.ref === ref && candidate.ownerKey === ownerKey);
			if (!record) return undefined;
			record.lastUsedAt = now; record.updatedAt = now;
			this.persist();
			return record.secret;
		});
		if (secret === undefined) {
			this.emit({ action: "access_denied", ownerKey, ref: safeRef(ref), capability, at: now });
			throw new Error(`Credential Ref not found: ${ref}`);
		}
		this.emit({ action: "accessed", ownerKey, ref, capability, at: now });
		return await consume(secret);
	}

	remove(ownerKey: string, ref: string, now = Date.now()): boolean {
		const removed = this.mutate(() => {
			const index = this.records.findIndex((record) => record.ref === ref && record.ownerKey === ownerKey);
			if (index < 0) return false;
			this.records.splice(index, 1); this.persist(); return true;
		});
		if (!removed) return false;
		this.emit({ action: "removed", ownerKey, ref, at: now });
		return true;
	}

	private persist(): void {
		if (!this.writeLease) throw new Error("Credential Vault persistence requires a write lease");
		this.assertWriteLease(this.writeLease);
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.key, iv);
		const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ records: this.records } satisfies VaultPayload), "utf8"), cipher.final()]);
		const envelope: VaultEnvelope = { version: 1, algorithm: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
		const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
		writeFileSync(temporary, JSON.stringify(envelope), { encoding: "utf8", mode: 0o600 });
		renameSync(temporary, this.path);
		chmodSync(this.path, 0o600);
	}

	private refresh(): void { if (existsSync(this.path)) this.records = this.decrypt(readFileSync(this.path, "utf8")); }

	private mutate<T>(change: () => T): T {
		const lease = this.acquireWriteLease();
		this.writeLease = lease;
		try { this.refresh(); return change(); }
		finally { this.writeLease = undefined; this.releaseWriteLease(lease); }
	}

	private acquireWriteLease(): VaultWriteLease {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const lockPath = `${this.path}.lock`;
		for (let attempt = 0; attempt < 2; attempt++) {
			const lease = { token: randomUUID(), acquiredAt: Date.now() };
			try {
				const fd = openSync(lockPath, "wx", 0o600);
				try { writeFileSync(fd, JSON.stringify(lease), "utf8"); } finally { closeSync(fd); }
				return lease;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const existing = readLease(lockPath);
				const acquiredAt = existing?.acquiredAt ?? statSync(lockPath).mtimeMs;
				if (Date.now() - acquiredAt <= WRITE_LEASE_MS) throw new Error("Credential Vault is busy behind an active write lease");
				const stale = `${lockPath}.stale.${randomUUID()}`;
				try { renameSync(lockPath, stale); unlinkSync(stale); } catch { /* another process recovered it; retry */ }
			}
		}
		throw new Error("Credential Vault write lease could not be acquired");
	}

	private assertWriteLease(lease: VaultWriteLease): void {
		if (readLease(`${this.path}.lock`)?.token !== lease.token) throw new Error("Credential Vault write lease was lost");
	}

	private releaseWriteLease(lease: VaultWriteLease): void {
		const lockPath = `${this.path}.lock`;
		if (readLease(lockPath)?.token === lease.token) try { unlinkSync(lockPath); } catch { /* already released */ }
	}

	private decrypt(serialized: string): StoredCredential[] {
		try {
			const envelope = JSON.parse(serialized) as VaultEnvelope;
			if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") throw new Error("unsupported format");
			const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(envelope.iv, "base64"));
			decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
			const payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8")) as VaultPayload;
			if (!Array.isArray(payload.records)) throw new Error("invalid payload");
			return payload.records;
		} catch { throw new Error("Credential Vault could not decrypt data; the key is wrong or the vault is corrupt"); }
	}

	private emit(event: CredentialVaultAuditEvent): void { this.audit?.(event); }
}

function readLease(path: string): VaultWriteLease | undefined {
	try { const value = JSON.parse(readFileSync(path, "utf8")) as Partial<VaultWriteLease>; return typeof value.token === "string" && typeof value.acquiredAt === "number" ? value as VaultWriteLease : undefined; }
	catch { return undefined; }
}

function metadata(record: StoredCredential): CredentialMetadata {
	const { secret: _secret, ...value } = record;
	return { ...value };
}

function required(value: string, name: string, maxLength: number, trim = true): string {
	const normalized = trim ? value.trim() : value;
	if (!normalized) throw new Error(`Credential ${name} is required`);
	if (Buffer.byteLength(normalized, "utf8") > maxLength) throw new Error(`Credential ${name} exceeds ${maxLength} bytes`);
	return normalized;
}

function safeRef(value: string): string { return /^cred_[a-f0-9-]{36}$/.test(value) ? value : "invalid"; }

function isAuditEvent(value: unknown): value is CredentialVaultAuditEvent {
	if (!value || typeof value !== "object") return false;
	const event = value as Partial<CredentialVaultAuditEvent>;
	return (event.action === "stored" || event.action === "accessed" || event.action === "access_denied" || event.action === "removed")
		&& typeof event.ownerKey === "string" && typeof event.ref === "string" && typeof event.at === "number"
		&& (event.capability === undefined || /^[a-z][a-z0-9._-]{1,63}$/.test(event.capability));
}
