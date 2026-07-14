import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionCatalog } from "../dist/index.js";

test("Core session catalog persists content-free, owner-scoped session choices", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-session-catalog-"));
	const source = { platform: "cli", chatId: "local", chatType: "dm", userId: "user", threadId: "local-example" };
	try {
		const catalog = SessionCatalog.forAgentDir(root);
		await catalog.touch(source);
		assert.equal(await catalog.has(source), true);
		const restored = SessionCatalog.forAgentDir(root);
		assert.deepEqual(await restored.list(source), [{ threadId: "local-example", lastUsedAt: (await restored.list(source))[0].lastUsedAt, preferences: {} }]);
		await restored.updatePreferences(source, { reasoningDisplay: "summary", detailsDisplay: "collapsed" });
		assert.deepEqual(await restored.preferences(source), { reasoningDisplay: "summary", detailsDisplay: "collapsed" });
		assert.deepEqual(await restored.list({ ...source, userId: "another" }), []);
		const serialized = await readFile(join(root, "sessions", "beemax-session-index.json"), "utf8");
		assert.equal(serialized.includes("conversation"), false);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("Core session catalog serializes concurrent writes and bounds retained sessions", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-session-catalog-race-"));
	try {
		const path = join(root, "sessions.json");
		const catalog = new SessionCatalog(path, 100);
		await Promise.all(Array.from({ length: 150 }, (_, index) => catalog.touch({ platform: "cli", chatId: `chat-${index}`, threadId: `thread-${index}` })));
		const restored = new SessionCatalog(path, 100);
		let retained = 0;
		for (let index = 0; index < 150; index++) if (await restored.has({ platform: "cli", chatId: `chat-${index}`, threadId: `thread-${index}` })) retained++;
		assert.equal(retained, 100);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("shared group catalog reads legacy actor-owned choices and migrates preferences on touch", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-session-catalog-legacy-"));
	const path = join(root, "sessions", "beemax-session-index.json");
	const source = { platform: "feishu", channelInstanceId: "company-a", chatId: "group", chatType: "group", userId: "alice", threadId: "topic" };
	try {
		await mkdir(join(root, "sessions"), { recursive: true });
		await writeFile(path, JSON.stringify([{ owner: "feishu:group:alice", threadId: "topic", lastUsedAt: 10, preferences: { reasoningDisplay: "summary" } }]));
		const catalog = new SessionCatalog(path);
		assert.equal(await catalog.has(source), true);
		assert.deepEqual(await catalog.preferences(source), { reasoningDisplay: "summary" });
		await catalog.touch(source);
		assert.deepEqual(await catalog.preferences(source), { reasoningDisplay: "summary" });
	} finally { await rm(root, { recursive: true, force: true }); }
});
