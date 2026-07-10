import assert from "node:assert/strict";
import test from "node:test";
import { createProfileRuntime } from "../dist/runtime-composition.js";

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
