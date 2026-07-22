import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createProfile } from "../dist/profile-config.js";

const cli = resolve("apps/cli/dist/cli.js");

function isolatedEnvironment(root, home) {
	const environment = { ...process.env };
	for (const key of [
		"THRUVERA_PROFILE", "THRUVERA_PROVIDER", "THRUVERA_MODEL", "THRUVERA_API_KEY", "THRUVERA_DB_PATH",
		"THRUVERA_MCP_CONFIG", "THRUVERA_AGENT_DIR", "THRUVERA_CWD", "FEISHU_APP_ID", "FEISHU_APP_SECRET",
	]) delete environment[key];
	return { ...environment, THRUVERA_ROOT: root, THRUVERA_HOME: home };
}

async function useMissingAgentDirectory(paths, name) {
	const config = await readFile(paths.configPath, "utf8");
	const changed = config.replace(/^  agentDir: \.$/mu, `  agentDir: ${name}`);
	assert.notEqual(changed, config, "fixture must replace the default Agent directory");
	await writeFile(paths.configPath, changed);
}

test("CLI install commands safely create a missing Profile-local Agent directory while status fails closed", async () => {
	const fixture = await mkdtemp(join(tmpdir(), "beemax-cli-agent-dir-repair-"));
	const root = join(fixture, "release");
	const home = join(fixture, "home");
	const invocationDir = join(fixture, "invocation");
	await mkdir(invocationDir, { recursive: true });
	await cp(resolve("skills/builtin"), join(root, "skills", "builtin"), { recursive: true });
	const environment = isolatedEnvironment(root, home);
	const run = (args) => execFileSync(process.execPath, [cli, ...args], { cwd: invocationDir, encoding: "utf8", env: environment });
	try {
		const skillsProfile = await createProfile("skills-repair", { root, home });
		await useMissingAgentDirectory(skillsProfile, "runtime");
		assert.throws(
			() => run(["capabilities", "status", "--profile", "skills-repair"]),
			(error) => /Profile Agent directory|ENOENT/u.test(`${error.message}\n${error.stderr ?? ""}`),
		);
		assert.match(run(["skills", "sync", "--profile", "skills-repair"]), /Synced bundled Skills/u);
		assert.match(await readFile(join(skillsProfile.homePath, "runtime", "skills", "agent-reach", "SKILL.md"), "utf8"), /agent-reach/u);

		const capabilitiesProfile = await createProfile("capability-repair", { root, home });
		await useMissingAgentDirectory(capabilitiesProfile, "runtime");
		assert.match(
			run(["capabilities", "install", "agent-reach", "--profile", "capability-repair"]),
			/Installed Thruvera-native Agent Reach/u,
		);
		assert.match(await readFile(join(capabilitiesProfile.homePath, "runtime", "skills", "pi-web-access", "SKILL.md"), "utf8"), /pi-web-access/u);
	} finally {
		await rm(fixture, { recursive: true, force: true });
	}
});
