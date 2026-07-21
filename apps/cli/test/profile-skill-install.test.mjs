import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProfile } from "../dist/profile-config.js";
import { inspectLocalSkill, installLocalSkill } from "../dist/profile-skill-install.js";

async function makeSkill(parent, name = "customer-research") {
	const source = join(parent, name);
	await mkdir(source, { recursive: true });
	await writeFile(join(source, "SKILL.md"), `---\nname: ${name}\ndescription: Customer-owned research workflow.\n---\n\nUse the Profile Tools to research.\n`);
	await mkdir(join(source, "references"));
	await writeFile(join(source, "references", "policy.md"), "Use public sources.\n");
	return source;
}

test("a customer can install one complete digest-pinned local Skill into only one Profile", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-local-skill-install-"));
	try {
		const home = join(root, "home");
		const source = await makeSkill(join(root, "sources"));
		const first = await createProfile("first", { home });
		const second = await createProfile("second", { home });
		const inspected = await inspectLocalSkill(source);
		assert.match(inspected.sha256, /^[a-f0-9]{64}$/);

		const installed = await installLocalSkill({ profileHome: first.homePath, agentDir: first.dataPath, source, expectedSha256: inspected.sha256 });
		assert.equal(installed.destination, join(first.dataPath, "skills", "customer-research"));
		assert.match(await readFile(join(installed.destination, "SKILL.md"), "utf8"), /Customer-owned research workflow/);
		await assert.rejects(() => readFile(join(second.dataPath, "skills", "customer-research", "SKILL.md"), "utf8"), { code: "ENOENT" });
		await assert.rejects(
			() => installLocalSkill({ profileHome: first.homePath, agentDir: first.dataPath, source, expectedSha256: inspected.sha256 }),
			/already exists/,
		);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("local Skill installation rejects mismatched digests and linked source content", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-local-skill-reject-"));
	try {
		const home = join(root, "home");
		const paths = await createProfile("target", { home });
		const source = await makeSkill(join(root, "sources"));
		const inspected = await inspectLocalSkill(source);
		await assert.rejects(
			() => installLocalSkill({ profileHome: paths.homePath, agentDir: paths.dataPath, source, expectedSha256: "0".repeat(64) }),
			/digest mismatch/,
		);
		await symlink(join(source, "SKILL.md"), join(source, "linked.md"));
		await assert.rejects(() => inspectLocalSkill(source), /symbolic link/);
		await assert.rejects(
			() => installLocalSkill({ profileHome: paths.homePath, agentDir: paths.dataPath, source, expectedSha256: inspected.sha256 }),
			/symbolic link/,
		);
	} finally { await rm(root, { recursive: true, force: true }); }
});
