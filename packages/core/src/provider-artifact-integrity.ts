import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export interface ProviderArtifactManifest {
	schemaVersion: "beemax.provider-artifact.v2";
	providerId: string;
	version: string;
	lockSha256: string;
	artifactSha256: string;
	entrypointSha256: string;
	configurationSha256: string;
	installedAt: number;
	evidenceRef: string;
	integrityTag: string;
}

const MAX_FILES = 100_000;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_ENTRYPOINT_BYTES = 16 * 1024 * 1024;
const MAX_CONFIGURATION_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const HASH_CHUNK_BYTES = 64 * 1024;
const MANIFEST_NAME = "beemax-provider.json";

/** Content-addresses a Provider tree, including internal symlink identities, but excluding its self-referential manifest. */
export async function providerArtifactSha256(root: string, signal?: AbortSignal): Promise<string> {
	const realRoot = await realpath(root);
	const hash = createHash("sha256");
	let files = 0;
	let bytes = 0;
	const visit = async (directory: string): Promise<void> => {
		for (const name of (await readdir(directory)).sort()) {
			if (signal?.aborted) throw signal.reason ?? new Error("Provider artifact verification aborted");
			const path = join(directory, name);
			const rel = relative(realRoot, path).split(sep).join("/");
			if (rel === MANIFEST_NAME) continue;
			const stat = await lstat(path);
			if (++files > MAX_FILES) throw new Error(`Provider artifact exceeds ${MAX_FILES} filesystem entries`);
			if (stat.isDirectory()) { hash.update(`D\0${rel}\0`); await visit(path); continue; }
			if (stat.isSymbolicLink()) {
				const target = await readlink(path);
				const resolved = await realpath(path);
				if (!inside(realRoot, resolved)) throw new Error(`Provider artifact symlink escapes its root: ${rel}`);
				hash.update(`L\0${rel}\0${target}\0`);
				continue;
			}
			if (!stat.isFile()) throw new Error(`Provider artifact contains unsupported filesystem entry: ${rel}`);
			if (stat.size > MAX_BYTES - bytes) throw new Error(`Provider artifact exceeds ${MAX_BYTES} bytes`);
			hash.update(`F\0${rel}\0${stat.size}\0`);
			const hashedBytes = await hashRegularFile(path, hash, MAX_BYTES - bytes, signal);
			if (hashedBytes !== stat.size) throw new Error(`Provider artifact changed while hashing: ${path}`);
			bytes += hashedBytes;
		}
	};
	await visit(realRoot);
	return hash.digest("hex");
}

export async function providerFileSha256(path: string, maxBytes = MAX_ENTRYPOINT_BYTES, signal?: AbortSignal): Promise<string> {
	const hash = createHash("sha256");
	await hashRegularFile(path, hash, maxBytes, signal);
	return hash.digest("hex");
}

export function providerManifestEvidenceRef(manifest: Omit<ProviderArtifactManifest, "evidenceRef" | "integrityTag">): string {
	return `sha256:${createHash("sha256").update(JSON.stringify(manifest)).digest("hex")}`;
}

export function providerManifestIntegrityTag(manifest: Omit<ProviderArtifactManifest, "integrityTag">, key: Uint8Array): string {
	if (key.byteLength < 32) throw new Error("Provider integrity key must contain at least 32 bytes");
	return `hmac-sha256:${createHmac("sha256", key).update(JSON.stringify(manifest)).digest("hex")}`;
}

export async function verifyProviderArtifact(input: {
	root: string;
	manifestPath: string;
	entrypointPath: string;
	configurationPath: string;
	expected: Pick<ProviderArtifactManifest, "providerId" | "version" | "lockSha256">;
	integrityKey: Uint8Array;
}, signal?: AbortSignal): Promise<ProviderArtifactManifest | undefined> {
	try {
		const raw = JSON.parse((await readBoundedFile(input.manifestPath, MAX_MANIFEST_BYTES, signal)).toString("utf8")) as Partial<ProviderArtifactManifest>;
		if (raw.schemaVersion !== "beemax.provider-artifact.v2" || raw.providerId !== input.expected.providerId || raw.version !== input.expected.version || raw.lockSha256 !== input.expected.lockSha256 || !Number.isSafeInteger(raw.installedAt) || typeof raw.artifactSha256 !== "string" || typeof raw.entrypointSha256 !== "string" || typeof raw.configurationSha256 !== "string" || typeof raw.evidenceRef !== "string" || typeof raw.integrityTag !== "string") return undefined;
		const manifest = raw as ProviderArtifactManifest;
		if (!/^[a-f0-9]{64}$/.test(manifest.artifactSha256) || !/^[a-f0-9]{64}$/.test(manifest.entrypointSha256) || !/^[a-f0-9]{64}$/.test(manifest.configurationSha256) || !/^sha256:[a-f0-9]{64}$/.test(manifest.evidenceRef) || !/^hmac-sha256:[a-f0-9]{64}$/.test(manifest.integrityTag)) return undefined;
		const [artifactSha256, entrypointSha256, configurationSha256] = await Promise.all([
			providerArtifactSha256(input.root, signal), providerFileSha256(input.entrypointPath, MAX_ENTRYPOINT_BYTES, signal), providerFileSha256(input.configurationPath, MAX_CONFIGURATION_BYTES, signal),
		]);
		if (artifactSha256 !== manifest.artifactSha256 || entrypointSha256 !== manifest.entrypointSha256 || configurationSha256 !== manifest.configurationSha256) return undefined;
		const { evidenceRef: _evidenceRef, integrityTag: _integrityTag, ...unsigned } = manifest;
		if (providerManifestEvidenceRef(unsigned) !== manifest.evidenceRef) return undefined;
		const expectedTag = providerManifestIntegrityTag({ ...unsigned, evidenceRef: manifest.evidenceRef }, input.integrityKey);
		if (!safeTagEqual(expectedTag, manifest.integrityTag)) return undefined;
		return manifest;
	} catch { return undefined; }
}

function safeTagEqual(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

async function readBoundedFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
	const handle = await open(path, "r");
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > maxBytes) throw new Error(`Provider artifact file exceeds ${maxBytes} bytes: ${path}`);
		const content = Buffer.allocUnsafe(stat.size);
		let offset = 0;
		while (offset < stat.size) {
			if (signal?.aborted) throw signal.reason ?? new Error("Provider artifact verification aborted");
			const { bytesRead } = await handle.read(content, offset, Math.min(HASH_CHUNK_BYTES, stat.size - offset), offset);
			if (!bytesRead) throw new Error(`Provider artifact changed while reading: ${path}`);
			offset += bytesRead;
		}
		if ((await handle.stat()).size !== stat.size) throw new Error(`Provider artifact changed while reading: ${path}`);
		return content;
	} finally { await handle.close(); }
}

async function hashRegularFile(path: string, hash: ReturnType<typeof createHash>, maxBytes: number, signal?: AbortSignal): Promise<number> {
	const handle = await open(path, "r");
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > maxBytes) throw new Error(`Provider artifact file exceeds ${maxBytes} bytes: ${path}`);
		const buffer = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, Math.max(1, maxBytes)));
		let offset = 0;
		while (offset < stat.size) {
			if (signal?.aborted) throw signal.reason ?? new Error("Provider artifact verification aborted");
			const length = Math.min(buffer.byteLength, stat.size - offset);
			const { bytesRead } = await handle.read(buffer, 0, length, offset);
			if (!bytesRead) throw new Error(`Provider artifact changed while hashing: ${path}`);
			offset += bytesRead;
			if (offset > maxBytes) throw new Error(`Provider artifact file exceeds ${maxBytes} bytes: ${path}`);
			hash.update(buffer.subarray(0, bytesRead));
		}
		if ((await handle.stat()).size !== stat.size) throw new Error(`Provider artifact changed while hashing: ${path}`);
		return offset;
	} finally { await handle.close(); }
}

function inside(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}
