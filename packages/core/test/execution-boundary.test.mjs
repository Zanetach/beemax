import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionTools, resolveExecutionBackend } from "../dist/index.js";

const source = { platform: "feishu", chatId: "chat", chatType: "group", userId: "user" };

test("execution backend selection uses only configured, implemented modes", () => {
	assert.equal(resolveExecutionBackend({ backend: "docker", mode: "off" }, source), "local");
	assert.equal(resolveExecutionBackend({ backend: "docker", mode: "all" }, { ...source, platform: "cli", chatType: "dm" }), "docker");
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
	await write.execute("write", { path: "notes/today.md", content: "hello" });
	assert.equal(calls[0][1].path, "/workspace/notes/today.md");
	assert.equal(calls[1][1].path, "/workspace/notes/today.md");
	await assert.rejects(read.execute("read", { path: "../secret" }), /outside the configured workspace/);
});
