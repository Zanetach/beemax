import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createExecutionTools, DockerExecutionPort, LocalExecutionPort, resolveExecutionBackend } from "../dist/index.js";

const source = { platform: "feishu", chatId: "chat", chatType: "group", userId: "user" };

test("execution backend selection uses only configured, implemented modes", () => {
	assert.equal(resolveExecutionBackend({ backend: "docker", mode: "off" }, source), "local");
	assert.equal(resolveExecutionBackend({ backend: "docker", mode: "all" }, { ...source, platform: "cli", chatType: "dm" }), "docker");
	assert.throws(() => resolveExecutionBackend({ backend: "local", mode: "all" }, source), /requires the Docker Execution Sandbox/);
});

test("execution tools constrain file requests to their configured workspace", async () => {
	const calls = [];
	const execution = {
		execute: async (request) => { calls.push(["execute", request]); return { exitCode: 0, stdout: "ok", stderr: "" }; },
		readFile: async (request) => { calls.push(["read", request]); return "content"; },
		writeFile: async (request, content) => { calls.push(["write", request, content]); },
	};
	const tools = createExecutionTools(source, "/workspace", execution);
	const read = tools.find((tool) => tool.name === "read");
	const write = tools.find((tool) => tool.name === "write");
	assert.match(write.description, /ordinary reports.*18,000 characters.*one complete replace call/i);
	await read.execute("read", { path: "notes/today.md" });
	const writeResult = await write.execute("write", { path: "notes/today.md", content: "hello", mediaType: "text/html", idempotencyKey: "daily-notes-v1" });
	assert.equal(calls[0][1].path, "/workspace/notes/today.md");
	assert.equal(calls[1][1].path, "/workspace/notes/today.md");
	assert.deepEqual(writeResult.details, {
		path: "/workspace/notes/today.md",
		byteLength: 5,
		sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
		beemaxEffect: {
			operation: "write workspace file",
			externalRef: "workspace:notes/today.md",
			idempotencyKey: "daily-notes-v1",
		},
		artifactManifest: {
			schemaVersion: "beemax.artifact-manifest.v1",
			id: "artifact:sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
			locator: { kind: "workspace", uri: "workspace:notes/today.md" },
			mediaType: "text/html",
			byteLength: 5,
			sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
			producer: { providerId: "beemax.workspace-write", providerVersion: "1", operation: "write" },
			sourceRefs: [],
			createdAt: writeResult.details.artifactManifest.createdAt,
		},
	});
	assert.ok(Number.isSafeInteger(writeResult.details.artifactManifest.createdAt));
	await assert.rejects(read.execute("read", { path: "../secret" }), /outside the configured workspace/);
});

test("workspace writes support checksum-guarded chunks without duplicate appends", async () => {
	let current = "";
	const execution = {
		execute: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		readFile: async () => current,
		writeFile: async (_request, content) => { current = content; },
	};
	const write = createExecutionTools(source, "/workspace", execution).find((tool) => tool.name === "write");
	const first = await write.execute("chunk-1", { path: "report.html", content: "<html>", mode: "replace" });
	assert.equal(current, "<html>");
	const second = await write.execute("chunk-2", {
		path: "report.html", content: "报告</html>", mode: "append",
		expectedByteLength: first.details.byteLength,
		expectedSha256: first.details.sha256,
	});
	assert.equal(current, "<html>报告</html>");
	assert.equal(second.details.byteLength, Buffer.byteLength(current));
	await assert.rejects(write.execute("duplicate-chunk-2", {
		path: "report.html", content: "报告</html>", mode: "append",
		expectedByteLength: first.details.byteLength,
		expectedSha256: first.details.sha256,
	}), /does not match expected append base/u);
	assert.equal(current, "<html>报告</html>");
});

test("Host Execution Adapter stops an active command when its Tool execution is cancelled", async () => {
	const execution = new LocalExecutionPort();
	const controller = new AbortController();
	setTimeout(() => controller.abort(new Error("operator stopped execution")), 25);
	const startedAt = Date.now();
	const result = await execution.execute({ source, cwd: process.cwd(), command: "sleep 2", timeoutMs: 2_000, signal: controller.signal });
	assert.ok(Date.now() - startedAt < 500, "cancelled host command kept running");
	assert.notEqual(result.exitCode, 0);
});

test("Host Execution Adapter creates safe parent directories for workspace writes", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "beemax-write-test-"));
	try {
		const tools = createExecutionTools(source, cwd, new LocalExecutionPort());
		const write = tools.find((tool) => tool.name === "write");
		await write.execute("nested-write", { path: "reports/launch/copy.md", content: "verified" });
		assert.equal(await readFile(join(cwd, "reports/launch/copy.md"), "utf8"), "verified");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("Docker Execution Sandbox rejects writes before launch unless workspace access is read-write", async () => {
	const execution = new DockerExecutionPort({ image: "invalid.invalid/beemax-never:latest", timeoutMs: 1_000, workspaceAccess: "ro", workspace: process.cwd(), profileId: "test" });
	await assert.rejects(execution.writeFile({ source, cwd: process.cwd(), path: `${process.cwd()}/README.md` }, "blocked"), /requires read-write workspace access/);
});
