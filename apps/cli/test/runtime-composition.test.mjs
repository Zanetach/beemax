import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileAgentRuntime, createProfileRuntime } from "../dist/runtime-composition.js";

test("Gateway runtime composition preserves the configured session bound", async () => {
	const disposed = [];
	const runtime = createProfileRuntime(
		{ maxSessions: 1, sessionIdleMs: 30 * 60_000 },
		{
			createAgent: async (id) => ({
				agent: { state: { model: { id: "test" }, messages: [] } },
				subscribe: () => () => undefined,
				prompt: async () => undefined,
				abort: async () => undefined,
				dispose: () => { disposed.push(id); },
			}),
		},
	);
	try {
		await runtime.run({ source: { platform: "test", chatId: "one", chatType: "dm" }, text: "one", timeoutMs: 1_000 });
		await runtime.run({ source: { platform: "test", chatId: "two", chatType: "dm" }, text: "two", timeoutMs: 1_000 });
		assert.equal(disposed.length, 1);
	} finally {
		runtime.dispose();
	}
});

test("Gateway runtime composition expires idle sessions using the Profile policy", async () => {
	const originalNow = Date.now;
	let now = 1_000;
	const disposed = [];
	Date.now = () => now;
	const runtime = createProfileRuntime(
		{ maxSessions: 10, sessionIdleMs: 60_000 },
		{
			createAgent: async (id) => ({
				agent: { state: { model: { id: "test" }, messages: [] } },
				subscribe: () => () => undefined,
				prompt: async () => undefined,
				abort: async () => undefined,
				dispose: () => { disposed.push(id); },
			}),
		},
	);
	try {
		await runtime.run({ source: { platform: "test", chatId: "one", chatType: "dm" }, text: "one", timeoutMs: 1_000 });
		now += 60_001;
		await runtime.run({ source: { platform: "test", chatId: "two", chatType: "dm" }, text: "two", timeoutMs: 1_000 });
		assert.equal(disposed.length, 1);
	} finally {
		runtime.dispose();
		Date.now = originalNow;
	}
});

test("Profile Agent composition gives every surface the same durable interaction and session wiring", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-profile-runtime-"));
	const source = { platform: "cli", chatId: "local", chatType: "dm", userId: "local" };
	const profile = createProfileAgentRuntime({
		profileId: "personal",
		agentDir: root,
		policy: { maxSessions: 2 },
		runtime: {
			createAgent: async () => ({
				agent: { state: { model: { id: "test" }, messages: [] } },
				subscribe: () => () => undefined,
				prompt: async () => undefined,
				abort: async () => undefined,
				dispose: () => undefined,
			}),
		},
	});
	try {
		await profile.interaction.dispatch({ type: "message.send", source, text: "hello", input: { timeoutMs: 1_000 } });
		const events = await readFile(join(root, "interaction-events.jsonl"), "utf8");
		const sessions = await readFile(join(root, "sessions", "beemax-session-index.json"), "utf8");
		assert.match(events, /"profileId":"personal"/);
		assert.match(sessions, /"owner":"cli:local:local"/);
	} finally {
		profile.dispose();
		await rm(root, { recursive: true, force: true });
	}
});
