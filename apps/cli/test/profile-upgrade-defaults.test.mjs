import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../dist/config.js";
import { runGateway } from "../dist/gateway.js";
import { createProfile } from "../dist/profile-config.js";

test("Gateway startup backfills missing managed standard Web Skills for an upgraded Profile", async () => {
	const home = await mkdtemp(join(tmpdir(), "beemax-profile-upgrade-defaults-"));
	try {
		const paths = await createProfile("upgraded", { home });
		await rm(join(paths.homePath, "skills", "agent-reach"), { recursive: true });
		const config = loadConfig(paths.configPath, "upgraded");
		await assert.rejects(() => runGateway(config), /No enabled Gateway channels/u);
		assert.match(await readFile(join(paths.homePath, "skills", "agent-reach", "SKILL.md"), "utf8"), /name: agent-reach/u);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
