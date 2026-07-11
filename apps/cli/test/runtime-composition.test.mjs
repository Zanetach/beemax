import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileAgentRuntime } from "../dist/runtime-composition.js";

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
