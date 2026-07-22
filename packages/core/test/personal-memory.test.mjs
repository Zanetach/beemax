import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compileLongTermMemorySnapshot } from "../dist/index.js";

test("only the isolated local personal session can compile profile MEMORY.md", () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-personal-memory-"));
	try {
		const memory = { compileLongTermMemory: () => "# Thruvera 长期记忆\n- local preference" };
		const path = compileLongTermMemorySnapshot(memory, root, { platform: "cli", chatId: "local", chatType: "dm", userId: "local" });
		assert.match(readFileSync(path, "utf8"), /local preference/);
		assert.throws(() => compileLongTermMemorySnapshot(memory, root, { platform: "feishu", chatId: "shared", chatType: "group", userId: "other" }), /isolated local personal session/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
