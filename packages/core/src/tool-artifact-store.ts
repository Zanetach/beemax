import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { containsCredentialMaterial } from "./credential-material.ts";
import { boundToolResultContent, READ_ONLY_TOOL_POLICY, withToolPolicy } from "./tool-runtime.ts";

const ARTIFACT_REF = /^beemax-artifact:sha256:([a-f0-9]{64})$/u;
const SCHEMA_VERSION = "beemax.tool-artifact.v1" as const;
const REDACTED = "[credential-like Tool output redacted]";

export interface ToolOutputArtifactReceipt {
	ref: string;
	sha256: string;
	mediaType: "application/vnd.beemax.tool-artifact+json";
	originalBytes: number;
	storedBytes: number;
	truncated: boolean;
	redacted: boolean;
	binaryBlocks: number;
}

export interface ToolOutputProjectionInput {
	scopeId: string;
	executionId?: string;
	toolCallId: string;
	toolName: string;
	result: { content: (TextContent | ImageContent)[]; details: unknown; terminate?: boolean };
	budget: { maxBytes: number; maxEstimatedTokens: number };
}

export interface ToolOutputProjection {
	result: ToolOutputProjectionInput["result"];
	bytes: number;
	estimatedTokens: number;
	truncated: boolean;
	artifact?: ToolOutputArtifactReceipt;
}

interface ToolArtifactManifest {
	schemaVersion: typeof SCHEMA_VERSION;
	nonce: string;
	id: string;
	ref: string;
	createdAt: number;
	scopeSha256: string;
	executionIdSha256?: string;
	toolCallIdSha256: string;
	toolName: string;
	originalBytes: number;
	truncated: boolean;
	redacted: boolean;
	binaryBlocks: number;
	blocks: Array<
		| { type: "text"; text: string }
		| { type: "image"; mimeType: string; bytes: number; data?: string; omitted?: true }
	>;
}

export interface FileToolArtifactStoreOptions {
	maxArtifactBytes?: number;
	maxFiles?: number;
	maxTotalBytes?: number;
}

/** Profile-local, conversation-scoped storage for Tool output excluded from model context. */
export class FileToolArtifactStore {
	private readonly root: string;
	private readonly maxArtifactBytes: number;
	private readonly maxFiles: number;
	private readonly maxTotalBytes: number;
	private mutation = Promise.resolve();

	constructor(root: string, options: FileToolArtifactStoreOptions = {}) {
		this.root = resolve(root);
		this.maxArtifactBytes = clampInteger(options.maxArtifactBytes ?? 10 * 1024 * 1024, 4 * 1024, 10 * 1024 * 1024);
		this.maxFiles = clampInteger(options.maxFiles ?? 500, 10, 10_000);
		this.maxTotalBytes = clampInteger(options.maxTotalBytes ?? 512 * 1024 * 1024, this.maxArtifactBytes, 2 * 1024 * 1024 * 1024);
	}

	async project(input: ToolOutputProjectionInput): Promise<ToolOutputProjection> {
		const scopeId = requiredText(input.scopeId, "Tool Artifact scope", 2_000);
		const toolCallId = requiredText(input.toolCallId, "Tool Artifact call id", 2_000);
		const toolName = safeToolName(input.toolName);
		const sanitized = sanitizeContent(input.result.content);
		const preliminary = boundToolResultContent(sanitized.content, input.budget);
		const details = sanitizeDetails(input.result.details);
		const needsArtifact = sanitized.binaryBlocks > 0 || sanitized.truncated || preliminary.truncated || details.artifactText !== undefined || details.redacted || details.truncated;

		if (!needsArtifact) {
			return {
				result: { ...input.result, content: preliminary.content as (TextContent | ImageContent)[], details: details.context },
				bytes: preliminary.bytes,
				estimatedTokens: preliminary.estimatedTokens,
				truncated: false,
			};
		}

		const artifact = await this.persist({
			scopeId, toolCallId, toolName, executionId: input.executionId,
			content: details.artifactText === undefined ? sanitized.content : [...sanitized.content, { type: "text", text: details.artifactText }],
			originalBytes: sanitized.originalBytes + details.originalBytes,
			binaryBlocks: sanitized.binaryBlocks, redacted: sanitized.redacted || details.redacted,
			forceTruncated: sanitized.truncated || details.truncated,
		});
		const marker = `[Tool output stored as a scoped Artifact]\nartifact_ref=${artifact.ref}\noriginal_bytes=${artifact.originalBytes}\nstored_bytes=${artifact.storedBytes}\ntruncated=${artifact.truncated}\nbinary_blocks=${artifact.binaryBlocks}`;
		const markerBytes = Buffer.byteLength(marker);
		const markerTokens = Math.ceil(marker.length / 4);
		const textOnly = sanitized.content.filter((block): block is TextContent => block.type === "text");
		const summary = boundToolResultContent(textOnly, {
			maxBytes: Math.max(0, input.budget.maxBytes - markerBytes),
			maxEstimatedTokens: Math.max(0, input.budget.maxEstimatedTokens - markerTokens),
		});
		const content = [
			...summary.content.filter((block) => !(block.type === "text" && block.text === "\n[Tool result truncated by Thruvera Tool Runtime]")),
			{ type: "text" as const, text: marker },
		];
		return {
			result: { ...input.result, content, details: { ...details.context, toolArtifact: artifact } },
			bytes: content.reduce((sum, block) => sum + (block.type === "text" ? Buffer.byteLength(block.text) : 0), 0),
			estimatedTokens: summary.estimatedTokens + markerTokens,
			truncated: true,
			artifact,
		};
	}

	async read(ref: string, scopeId: string, options: { offset?: number; maxChars?: number } = {}): Promise<{ text: string; offset: number; nextOffset: number; complete: boolean; artifact: ToolOutputArtifactReceipt }> {
		const match = ARTIFACT_REF.exec(ref);
		if (!match) throw new Error("Tool Artifact reference is invalid");
		await this.ensureRoot();
		const path = join(this.root, `${match[1]}.json`);
		let bytes: Buffer;
		try {
			const info = await lstat(path);
			if (!info.isFile() || info.isSymbolicLink() || info.size > this.maxArtifactBytes) throw new Error("invalid");
			bytes = await readFile(path);
		} catch {
			throw new Error("Tool Artifact was not found in this scope");
		}
		let manifest: ToolArtifactManifest;
		try { manifest = JSON.parse(bytes.toString("utf8")) as ToolArtifactManifest; }
		catch { throw new Error("Tool Artifact was not found in this scope"); }
		if (!validManifest(manifest, ref, scopeSha256(scopeId))) throw new Error("Tool Artifact was not found in this scope");
		const rendered = manifest.blocks.map((block) => block.type === "text"
			? block.text
			: `[Binary block: ${block.mimeType}; bytes=${block.bytes}; stored=${block.data ? "yes" : "no"}]`).join("\n");
		const offset = clampInteger(options.offset ?? 0, 0, rendered.length);
		const maxChars = clampInteger(options.maxChars ?? 20_000, 200, 30_000);
		const text = rendered.slice(offset, offset + maxChars);
		const nextOffset = offset + text.length;
		return { text, offset, nextOffset, complete: nextOffset >= rendered.length, artifact: receiptFromManifest(manifest, bytes.length) };
	}

	private async persist(input: { scopeId: string; toolCallId: string; toolName: string; executionId?: string; content: (TextContent | ImageContent)[]; originalBytes: number; binaryBlocks: number; redacted: boolean; forceTruncated: boolean }): Promise<ToolOutputArtifactReceipt> {
		return this.withMutation(async () => {
			await this.ensureRoot();
			const payloadBudget = Math.max(1_024, this.maxArtifactBytes - 2_048);
			const encoded = encodeBlocks(input.content, payloadBudget);
			const createdAt = Date.now(); const nonce = randomUUID();
			const identity = {
				schemaVersion: SCHEMA_VERSION, nonce, createdAt, scopeSha256: scopeSha256(input.scopeId),
				...(input.executionId ? { executionIdSha256: opaqueSha256(requiredText(input.executionId, "Tool Artifact execution id", 2_000)) } : {}),
				toolCallIdSha256: opaqueSha256(input.toolCallId), toolName: input.toolName,
				originalBytes: input.originalBytes, truncated: input.forceTruncated || encoded.truncated, redacted: input.redacted,
				binaryBlocks: input.binaryBlocks, blocks: encoded.blocks,
			};
			const sha256 = manifestDigest(identity);
			const ref = `beemax-artifact:sha256:${sha256}`;
			const manifest: ToolArtifactManifest = {
				...identity, id: sha256, ref,
			};
			const serialized = Buffer.from(JSON.stringify(manifest), "utf8");
			if (serialized.length > this.maxArtifactBytes) throw new Error("Bounded Tool Artifact serialization exceeded its storage limit");
			const target = join(this.root, `${sha256}.json`);
			const temporary = join(this.root, `.${sha256}.${process.pid}.${randomUUID()}.tmp`);
			await writeFile(temporary, serialized, { flag: "wx", mode: 0o600 });
			try { await rename(temporary, target); }
			catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
			await chmod(target, 0o600);
			await this.prune();
			return receiptFromManifest(manifest, serialized.length);
		});
	}

	private async ensureRoot(): Promise<void> {
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		const info = await lstat(this.root);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Tool Artifact root is not a trusted regular directory");
		await realpath(this.root);
		await chmod(this.root, 0o700);
	}

	private async prune(): Promise<void> {
		const entries = await readdir(this.root, { withFileTypes: true });
		const files = (await Promise.all(entries.filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/u.test(entry.name)).map(async (entry) => {
			const path = join(this.root, entry.name);
			try { const info = await stat(path); return { path, size: info.size, mtimeMs: info.mtimeMs }; }
			catch { return undefined; }
		}))).filter((file): file is { path: string; size: number; mtimeMs: number } => file !== undefined).sort((left, right) => right.mtimeMs - left.mtimeMs);
		let total = 0;
		for (let index = 0; index < files.length; index++) {
			const file = files[index]!;
			if (index >= this.maxFiles || total + file.size > this.maxTotalBytes) await unlink(file.path).catch(() => undefined);
			else total += file.size;
		}
	}

	private withMutation<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.mutation.then(operation, operation);
		this.mutation = next.then(() => undefined, () => undefined);
		return next;
	}
}

export function createToolArtifactReadTool(store: FileToolArtifactStore, scopeId: string): ToolDefinition {
	return withToolPolicy(defineTool({
		name: "artifact_read",
		label: "Read Tool Artifact",
		description: "Read a bounded text chunk from a Tool Artifact created in this exact Profile conversation. Use the next offset until complete.",
		parameters: Type.Object({
			ref: Type.String({ pattern: "^beemax-artifact:sha256:[a-f0-9]{64}$" }),
			offset: Type.Optional(Type.Integer({ minimum: 0 })),
			maxChars: Type.Optional(Type.Integer({ minimum: 200, maximum: 30_000 })),
		}),
		execute: async (_id, params) => {
			const chunk = await store.read(params.ref, scopeId, { offset: params.offset, maxChars: params.maxChars });
			return {
				content: [{ type: "text", text: chunk.text || "[Artifact chunk is empty]" }],
				details: { artifactRef: params.ref, offset: chunk.offset, nextOffset: chunk.nextOffset, complete: chunk.complete },
			};
		},
	}), { ...READ_ONLY_TOOL_POLICY, maxResultBytes: 64 * 1024, impact: "Reads a bounded chunk from a conversation-scoped Tool Artifact" });
}

function sanitizeContent(content: readonly (TextContent | ImageContent)[]): { content: (TextContent | ImageContent)[]; originalBytes: number; binaryBlocks: number; redacted: boolean; truncated: boolean } {
	let originalBytes = 0; let binaryBlocks = 0; let redacted = false;
	const sanitized: (TextContent | ImageContent)[] = [];
	for (const [index, block] of content.entries()) {
		if (block.type === "text") {
			originalBytes += Buffer.byteLength(block.text);
			if (index >= 1_000) { if (containsCredentialMaterialBounded(block.text)) redacted = true; continue; }
			if (containsCredentialMaterialBounded(block.text)) { redacted = true; sanitized.push({ type: "text", text: REDACTED }); }
			else sanitized.push({ type: "text", text: block.text });
			continue;
		}
		binaryBlocks++;
		originalBytes += estimatedBase64Bytes(block.data);
		if (index < 1_000) sanitized.push({ type: "image", data: block.data, mimeType: block.mimeType });
	}
	return { content: sanitized, originalBytes, binaryBlocks, redacted, truncated: content.length > 1_000 };
}

function encodeBlocks(content: readonly (TextContent | ImageContent)[], maxBytes: number): { blocks: ToolArtifactManifest["blocks"]; truncated: boolean } {
	let remaining = maxBytes; let truncated = false;
	const blocks: ToolArtifactManifest["blocks"] = [];
	for (const [index, block] of content.entries()) {
		if (index >= 1_000 || remaining < 32) { truncated = true; break; }
		if (block.type === "text") {
			const text = fitTextBlock(block.text, remaining);
			if (text.length > 0) {
				const candidate = { type: "text" as const, text };
				blocks.push(candidate);
				remaining -= encodedBlockBytes(candidate);
			}
			if (text.length < block.text.length) truncated = true;
			continue;
		}
		const bytes = estimatedBase64Bytes(block.data);
		const stored = { type: "image" as const, mimeType: safeMimeType(block.mimeType), bytes, data: block.data };
		const storedBytes = BASE64.test(block.data) ? encodedImageBlockBytes(stored) : Number.POSITIVE_INFINITY;
		if (storedBytes <= remaining) {
			blocks.push(stored);
			remaining -= storedBytes;
		} else {
			const omitted = { type: "image" as const, mimeType: safeMimeType(block.mimeType), bytes, omitted: true as const };
			if (encodedBlockBytes(omitted) <= remaining) { blocks.push(omitted); remaining -= encodedBlockBytes(omitted); }
			truncated = true;
		}
	}
	return { blocks, truncated };
}

function sanitizeDetails(details: unknown): { context: Record<string, unknown>; artifactText?: string; originalBytes: number; redacted: boolean; truncated: boolean } {
	if (!details || typeof details !== "object" || Array.isArray(details)) return { context: {}, originalBytes: 0, redacted: false, truncated: false };
	try {
		const serialized = JSON.stringify(details);
		const originalBytes = Buffer.byteLength(serialized);
		if (containsCredentialMaterialBounded(serialized)) return { context: {}, originalBytes, redacted: true, truncated: false };
		if (originalBytes > 64 * 1024) return { context: {}, artifactText: `[Tool result structured details]\n${serialized}`, originalBytes, redacted: false, truncated: false };
		return { context: JSON.parse(serialized) as Record<string, unknown>, originalBytes, redacted: false, truncated: false };
	} catch { return { context: {}, originalBytes: 0, redacted: false, truncated: true }; }
}

function receiptFromManifest(manifest: ToolArtifactManifest, storedBytes: number): ToolOutputArtifactReceipt {
	return { ref: manifest.ref, sha256: manifest.id, mediaType: "application/vnd.beemax.tool-artifact+json", originalBytes: manifest.originalBytes, storedBytes, truncated: manifest.truncated, redacted: manifest.redacted, binaryBlocks: manifest.binaryBlocks };
}

function validManifest(value: ToolArtifactManifest, ref: string, scopeHash: string): boolean {
	if (value?.schemaVersion !== SCHEMA_VERSION || value.ref !== ref || value.scopeSha256 !== scopeHash || !SHA256.test(value.id) || !ref.endsWith(value.id) || !UUID.test(value.nonce) || !boundedInteger(value.createdAt) || !SHA256.test(value.scopeSha256) || (value.executionIdSha256 !== undefined && !SHA256.test(value.executionIdSha256)) || !SHA256.test(value.toolCallIdSha256) || safeToolName(value.toolName) !== value.toolName || !boundedInteger(value.originalBytes) || typeof value.truncated !== "boolean" || typeof value.redacted !== "boolean" || !boundedInteger(value.binaryBlocks) || !Array.isArray(value.blocks) || value.blocks.length > 1_000 || !value.blocks.every(validBlock)) return false;
	return manifestDigest(value) === value.id;
}

function manifestDigest(value: Omit<ToolArtifactManifest, "id" | "ref">): string {
	const identity = {
		schemaVersion: value.schemaVersion, nonce: value.nonce, createdAt: value.createdAt, scopeSha256: value.scopeSha256,
		...(value.executionIdSha256 ? { executionIdSha256: value.executionIdSha256 } : {}), toolCallIdSha256: value.toolCallIdSha256, toolName: value.toolName,
		originalBytes: value.originalBytes, truncated: value.truncated, redacted: value.redacted, binaryBlocks: value.binaryBlocks, blocks: value.blocks,
	};
	return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
function boundedInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function validBlock(value: unknown): value is ToolArtifactManifest["blocks"][number] {
	if (!value || typeof value !== "object") return false;
	const block = value as Record<string, unknown>;
	if (block.type === "text") return typeof block.text === "string";
	if (block.type !== "image" || typeof block.mimeType !== "string" || safeMimeType(block.mimeType) !== block.mimeType || !boundedInteger(block.bytes)) return false;
	if (block.omitted === true) return block.data === undefined;
	return typeof block.data === "string" && BASE64.test(block.data) && estimatedBase64Bytes(block.data) === block.bytes;
}

function scopeSha256(value: string): string { return opaqueSha256(requiredText(value, "Tool Artifact scope", 2_000)); }
function opaqueSha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function requiredText(value: string, label: string, max: number): string { const normalized = value.trim(); if (!normalized || normalized.length > max) throw new Error(`${label} is invalid`); return normalized; }
function safeToolName(value: string): string { const normalized = value.trim(); return /^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(normalized) ? normalized : `unregistered:${opaqueSha256(value)}`; }
function safeMimeType(value: string): string { return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/iu.test(value) ? value : "application/octet-stream"; }
function estimatedBase64Bytes(value: string): number { const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0; return Math.floor((value.length - padding) * 3 / 4); }
function clampInteger(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, Number.isFinite(value) ? Math.trunc(value) : min)); }
function encodedBlockBytes(value: ToolArtifactManifest["blocks"][number]): number { return Buffer.byteLength(JSON.stringify(value)) + 1; }
function fitTextBlock(value: string, maxEncodedBytes: number): string {
	if (value.length <= maxEncodedBytes && encodedBlockBytes({ type: "text", text: value }) <= maxEncodedBytes) return value;
	let low = 0; let high = Math.min(value.length, maxEncodedBytes);
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (encodedBlockBytes({ type: "text", text: value.slice(0, middle) }) <= maxEncodedBytes) low = middle;
		else high = middle - 1;
	}
	return value.slice(0, low);
}
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
function encodedImageBlockBytes(value: Extract<ToolArtifactManifest["blocks"][number], { type: "image" }> & { data: string }): number {
	return encodedBlockBytes({ ...value, data: "" }) + value.data.length;
}
function containsCredentialMaterialBounded(value: string): boolean {
	const chunkSize = 64 * 1024; const overlap = 512;
	for (let offset = 0; offset < value.length; offset += chunkSize - overlap) {
		if (containsCredentialMaterial(value.slice(offset, offset + chunkSize))) return true;
	}
	return false;
}
