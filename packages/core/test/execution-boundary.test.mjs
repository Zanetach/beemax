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
	await read.execute("read", { path: "notes/today.md" });
	const writeResult = await write.execute("write", { path: "notes/today.md", content: "hello", idempotencyKey: "daily-notes-v1" });
	assert.equal(calls[0][1].path, "/workspace/notes/today.md");
	assert.equal(calls[1][1].path, "/workspace/notes/today.md");
	assert.deepEqual(writeResult.details, {
		path: "/workspace/notes/today.md",
		beemaxEffect: {
			operation: "write workspace file",
			externalRef: "workspace:notes/today.md",
			idempotencyKey: "daily-notes-v1",
		},
	});
	await assert.rejects(read.execute("read", { path: "../secret" }), /outside the configured workspace/);
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
