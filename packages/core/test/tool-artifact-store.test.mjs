import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileToolArtifactStore, createToolArtifactReadTool } from "../dist/index.js";

test("oversized Tool text becomes a bounded scoped Artifact with a safe context projection", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-tool-artifact-"));
	try {
		const store = new FileToolArtifactStore(root, { maxArtifactBytes: 8 * 1024, maxFiles: 10, maxTotalBytes: 64 * 1024 });
		const sourceText = "material-evidence\n".repeat(2_000);
		const projected = await store.project({
			scopeId: "profile:test/conversation:a", executionId: "execution:1", toolCallId: "call:1", toolName: "search",
			result: { content: [{ type: "text", text: sourceText }], details: { provider: "fixture" } },
			budget: { maxBytes: 1_024, maxEstimatedTokens: 256 },
		});

		assert.equal(projected.truncated, true);
		assert.ok(projected.artifact);
		assert.match(projected.artifact.ref, /^beemax-artifact:sha256:[a-f0-9]{64}$/u);
		assert.ok(Buffer.byteLength(JSON.stringify(projected.result.content)) < 2_000);
		assert.match(projected.result.content.at(-1).text, /artifact_ref=/u);
		assert.equal(projected.result.details.provider, "fixture");
		assert.equal(projected.result.details.toolArtifact.ref, projected.artifact.ref);

		const read = await store.read(projected.artifact.ref, "profile:test/conversation:a", { offset: 0, maxChars: 500 });
		assert.match(read.text, /^material-evidence/u);
		assert.equal(read.offset, 0);
		assert.ok(read.nextOffset > 0);
		assert.equal(read.complete, false);
		await assert.rejects(() => store.read(projected.artifact.ref, "profile:test/conversation:b", { offset: 0, maxChars: 500 }), /not found/u);
		assert.equal(statSync(root).mode & 0o777, 0o700);
		for (const name of readdirSync(root)) {
			assert.ok(statSync(join(root, name)).size <= 8 * 1024);
			assert.equal(statSync(join(root, name)).mode & 0o777, 0o600);
		}
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("binary Tool output is removed from model context and retained only in a bounded Artifact", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-tool-binary-artifact-"));
	try {
		const store = new FileToolArtifactStore(root, { maxArtifactBytes: 16 * 1024, maxFiles: 10, maxTotalBytes: 64 * 1024 });
		const data = Buffer.from("binary-image-fixture").toString("base64");
		const projected = await store.project({
			scopeId: "scope:binary", toolCallId: "call:image", toolName: "image_result",
			result: { content: [{ type: "image", data, mimeType: "image/png" }], details: {} },
			budget: { maxBytes: 2_048, maxEstimatedTokens: 512 },
		});
		assert.ok(projected.artifact);
		assert.equal(projected.result.content.some((block) => block.type === "image"), false);
		const files = readdirSync(root);
		assert.equal(files.length, 1);
		const persisted = JSON.parse(readFileSync(join(root, files[0]), "utf8"));
		const image = persisted.blocks.find((block) => block.type === "image");
		assert.equal(Buffer.from(image.data, "base64").toString("utf8"), "binary-image-fixture");
		assert.match(projected.result.content[0].text, /binary_blocks=1/u);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("oversized structured Tool details are retained in the Artifact instead of silently discarded", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-tool-details-artifact-"));
	try {
		const store = new FileToolArtifactStore(root, { maxArtifactBytes: 128 * 1024, maxFiles: 10, maxTotalBytes: 1024 * 1024 });
		const projected = await store.project({
			scopeId: "scope:details", toolCallId: "call:details", toolName: "structured_result",
			result: { content: [{ type: "text", text: "summary" }], details: { records: ["evidence".repeat(10_000)] } },
			budget: { maxBytes: 2_048, maxEstimatedTokens: 512 },
		});
		assert.ok(projected.artifact);
		assert.deepEqual(Object.keys(projected.result.details), ["toolArtifact"]);
		const read = await store.read(projected.artifact.ref, "scope:details", { offset: 0, maxChars: 30_000 });
		assert.match(read.text, /Tool result structured details/u);
		assert.match(read.text, /evidenceevidence/u);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("omitted content blocks are reported as truncated, not falsely reported as redacted", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-tool-many-blocks-"));
	try {
		const store = new FileToolArtifactStore(root, { maxArtifactBytes: 16 * 1024, maxFiles: 10, maxTotalBytes: 128 * 1024 });
		const projected = await store.project({
			scopeId: "scope:many", toolCallId: "call:many", toolName: "many_blocks",
			result: { content: Array.from({ length: 1_001 }, (_, index) => ({ type: "text", text: `block-${index}` })), details: {} },
			budget: { maxBytes: 64 * 1024, maxEstimatedTokens: 16_000 },
		});
		assert.equal(projected.artifact.truncated, true);
		assert.equal(projected.artifact.redacted, false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("binary payloads larger than the Artifact bound retain metadata without exceeding storage limits", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-tool-bounded-binary-"));
	try {
		const store = new FileToolArtifactStore(root, { maxArtifactBytes: 8 * 1024, maxFiles: 10, maxTotalBytes: 64 * 1024 });
		const projected = await store.project({
			scopeId: "scope:bounded-binary", toolCallId: "call:bounded-binary", toolName: "image_result",
			result: { content: [{ type: "image", data: Buffer.alloc(32 * 1024, 7).toString("base64"), mimeType: "image/png" }], details: {} },
			budget: { maxBytes: 2_048, maxEstimatedTokens: 512 },
		});
		const persisted = JSON.parse(readFileSync(join(root, readdirSync(root)[0]), "utf8"));
		assert.equal(persisted.blocks[0].omitted, true);
		assert.equal(projected.artifact.truncated, true);
		assert.ok(statSync(join(root, readdirSync(root)[0])).size <= 8 * 1024);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("malformed binary Tool output is omitted from both model context and durable Artifact payload", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-tool-invalid-binary-"));
	try {
		const store = new FileToolArtifactStore(root, { maxArtifactBytes: 8 * 1024, maxFiles: 10, maxTotalBytes: 64 * 1024 });
		const projected = await store.project({
			scopeId: "scope:invalid-binary", toolCallId: "call:invalid-binary", toolName: "image_result",
			result: { content: [{ type: "image", data: "not base64!?", mimeType: "image/png" }], details: {} },
			budget: { maxBytes: 2_048, maxEstimatedTokens: 512 },
		});
		const persisted = JSON.parse(readFileSync(join(root, readdirSync(root)[0]), "utf8"));
		assert.equal(persisted.blocks[0].omitted, true);
		assert.equal(persisted.blocks[0].data, undefined);
		assert.equal(projected.result.content.some((block) => block.type === "image"), false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Tool Artifact retention enforces its configured file-count bound", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-tool-artifact-retention-"));
	try {
		const store = new FileToolArtifactStore(root, { maxArtifactBytes: 8 * 1024, maxFiles: 10, maxTotalBytes: 80 * 1024 });
		for (let index = 0; index < 12; index++) {
			await store.project({
				scopeId: "scope:retention", toolCallId: `call:${index}`, toolName: "large_result",
				result: { content: [{ type: "text", text: `${index}:${"x".repeat(10_000)}` }], details: {} },
				budget: { maxBytes: 512, maxEstimatedTokens: 128 },
			});
		}
		assert.equal(readdirSync(root).length, 10);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Tool Artifact projection redacts credentials from both durable and model-visible output", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-tool-secret-artifact-"));
	try {
		const store = new FileToolArtifactStore(root, { maxArtifactBytes: 8 * 1024, maxFiles: 10, maxTotalBytes: 64 * 1024 });
		const secret = "sk-1234567890abcdefghijklmnop";
		const projected = await store.project({
			scopeId: "scope:secret", toolCallId: "call:secret", toolName: "remote",
			result: { content: [{ type: "text", text: "x".repeat(4_000) }, { type: "text", text: `api_key=${secret}` }], details: { token: secret } },
			budget: { maxBytes: 512, maxEstimatedTokens: 128 },
		});
		assert.doesNotMatch(JSON.stringify(projected.result), new RegExp(secret, "u"));
		for (const name of readdirSync(root)) assert.doesNotMatch(readFileSync(join(root, name), "utf8"), new RegExp(secret, "u"));
		assert.equal(projected.artifact.redacted, true);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Tool Artifact reads reject a manifest whose content no longer matches its opaque reference", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-tool-artifact-integrity-"));
	try {
		const store = new FileToolArtifactStore(root, { maxArtifactBytes: 8 * 1024, maxFiles: 10, maxTotalBytes: 64 * 1024 });
		const projected = await store.project({
			scopeId: "scope:integrity", toolCallId: "call:integrity", toolName: "large_result",
			result: { content: [{ type: "text", text: "evidence".repeat(2_000) }], details: {} },
			budget: { maxBytes: 512, maxEstimatedTokens: 128 },
		});
		const path = join(root, readdirSync(root)[0]);
		const manifest = JSON.parse(readFileSync(path, "utf8"));
		manifest.blocks[0].text = "tampered";
		writeFileSync(path, JSON.stringify(manifest), { mode: 0o600 });
		await assert.rejects(() => store.read(projected.artifact.ref, "scope:integrity"), /not found/u);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("artifact_read exposes bounded chunks and rejects malformed references", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-tool-artifact-read-"));
	try {
		const store = new FileToolArtifactStore(root);
		const tool = createToolArtifactReadTool(store, "scope:read");
		await assert.rejects(() => tool.execute("read:bad", { ref: "../../secret", offset: 0, maxChars: 1_000 }), /validation|reference/i);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
