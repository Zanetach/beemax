import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { filterEligibleSkills } from "../dist/index.js";

test("Skill prerequisite eligibility uses only the immutable Profile environment", async () => {
	const root = await mkdtemp(join(tmpdir(), "beemax-profile-skill-environment-"));
	const bin = join(root, "bin");
	await mkdir(bin);
	await writeFile(join(bin, "profile-tool"), "fixture");
	const skill = { name: "profile-only", filePath: join(root, "SKILL.md"), metadata: { beemax: { env: ["PROFILE_SKILL_TOKEN"], bins: ["profile-tool"] } } };
	const previousToken = process.env.PROFILE_SKILL_TOKEN;
	const previousPath = process.env.PATH;
	process.env.PROFILE_SKILL_TOKEN = "ambient-must-not-authorize";
	process.env.PATH = [bin, previousPath ?? ""].filter(Boolean).join(delimiter);
	try {
		assert.deepEqual(filterEligibleSkills([skill], "standard", {}), []);
		assert.deepEqual(filterEligibleSkills([skill], "standard", { PROFILE_SKILL_TOKEN: "profile-authority", PATH: bin }), [skill]);
		assert.deepEqual(filterEligibleSkills([skill], "standard", { PROFILE_SKILL_TOKEN: "profile-authority", PATH: "" }), []);
	} finally {
		if (previousToken === undefined) delete process.env.PROFILE_SKILL_TOKEN; else process.env.PROFILE_SKILL_TOKEN = previousToken;
		if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
		await rm(root, { recursive: true, force: true });
	}
});
