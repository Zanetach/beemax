import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SkillRegistry, SkillRuntime } from "../dist/index.js";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "beemax-skill-runtime-"));
	const skill = join(root, "skills", "contract-review"); mkdirSync(join(skill, "modules"), { recursive: true }); mkdirSync(join(skill, "references"));
	writeFileSync(join(skill, "SKILL.md"), `---\nname: contract-review\ndescription: "Review commercial contracts and identify risky clauses"\ntriggers: ["合同审查", "contract review"]\nexclude: ["translate only"]\n---\n\n# Rules\n\nSelect one manifest route before loading detailed knowledge.\n`);
	writeFileSync(join(skill, "manifest.json"), JSON.stringify({ version: 1, routes: { commercial: { description: "Commercial contract review", module: "modules/commercial.md", references: ["references/risk.md"], tools: ["read"] } } }));
	writeFileSync(join(skill, "modules", "commercial.md"), "Commercial review workflow"); writeFileSync(join(skill, "references", "risk.md"), "Risk clause reference");
	return { root, skills: join(root, "skills"), skill };
}

test("Skill discovery returns ranked metadata without loading unrelated bodies", async () => {
	const f = fixture();
	try {
		const other = join(f.skills, "translator"); mkdirSync(other); writeFileSync(join(other, "SKILL.md"), `---\nname: translator\ndescription: "Translate ordinary text"\n---\nSECRET UNRELATED BODY`);
		const matches = await new SkillRegistry([f.skills]).search("请进行合同审查", 1);
		assert.equal(matches.length, 1); assert.equal(matches[0].name, "contract-review"); assert.equal("instructions" in matches[0], false); assert.ok(matches[0].confidence > 0);
		assert.deepEqual((await new SkillRegistry([f.skills]).search("translate only this contract", 5)).map((item) => item.name), ["translator"]);
	} finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("Skill Runtime enforces discover, activate, route and declared-resource order", async () => {
	const f = fixture();
	try {
		const runtime = new SkillRuntime(new SkillRegistry([f.skills]));
		await assert.rejects(() => runtime.activate("contract-review"), /discovered/);
		await runtime.discover("合同审查"); const activation = await runtime.activate("contract-review");
		assert.match(activation.instructions, /Select one manifest route/); assert.deepEqual(activation.routes, [{ name: "commercial", description: "Commercial contract review" }]);
		await assert.rejects(() => runtime.activate("contract-review"), /only be activated immediately/);
		assert.throws(() => runtime.complete(), /cannot complete/);
		await assert.rejects(() => runtime.readResource("modules/commercial.md"), /route must be selected/);
		assert.deepEqual((await runtime.routeTo("commercial")).tools, ["read"]);
		assert.throws(() => runtime.complete(), /cannot complete/);
		await assert.rejects(() => runtime.readResource("references/not-declared.md"), /not declared/);
		await assert.rejects(() => runtime.readResource("references/risk.md"), /module must be loaded/);
		assert.equal((await runtime.readResource("modules/commercial.md")).content, "Commercial review workflow");
		assert.throws(() => runtime.complete(), /every declared reference.*references\/risk\.md/);
		assert.equal((await runtime.readResource("references/risk.md")).content, "Risk clause reference");
		const completed = runtime.complete(); assert.equal(completed.state, "completed"); assert.equal(completed.loadedResources.length, 2); assert.equal(runtime.snapshot().state, "idle");
	} finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("Skill Runtime fences a changed Skill and blocks path escape and resource budget overflow", async () => {
	const f = fixture();
	try {
		const runtime = new SkillRuntime(new SkillRegistry([f.skills]), 10, 2); await runtime.discover("contract review"); await runtime.activate("contract-review");
		await assert.rejects(() => runtime.routeTo("commercial"), /byte budget/);
		const second = new SkillRuntime(new SkillRegistry([f.skills])); await second.discover("contract review"); await second.activate("contract-review"); await second.routeTo("commercial");
		await assert.rejects(() => second.readResource("../outside.md"), /not declared/);
		writeFileSync(join(f.skill, "SKILL.md"), "---\nname: contract-review\ndescription: changed\n---\nchanged");
		await assert.rejects(() => second.readResource("modules/commercial.md"), /changed after discovery/);
	} finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("Skill Runtime locks only the selected route resource hashes before execution", async () => {
	const f = fixture();
	try {
		const runtime = new SkillRuntime(new SkillRegistry([f.skills])); await runtime.discover("contract review"); await runtime.activate("contract-review"); await runtime.routeTo("commercial");
		writeFileSync(join(f.skill, "modules", "commercial.md"), "changed after activation");
		await assert.rejects(() => runtime.readResource("modules/commercial.md"), /changed after activation/);
	} finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("Skill Runtime rejects a declared resource whose symlink escapes the Skill directory", async () => {
	const f = fixture();
	try {
		const outside = join(f.root, "outside.md"); writeFileSync(outside, "outside secret");
		rmSync(join(f.skill, "modules", "commercial.md")); symlinkSync(outside, join(f.skill, "modules", "commercial.md"));
		const runtime = new SkillRuntime(new SkillRegistry([f.skills])); await runtime.discover("contract review"); await runtime.activate("contract-review");
		await assert.rejects(() => runtime.routeTo("commercial"), /symlink escaped/);
	} finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("Skill Registry parses standard multiline YAML routing metadata", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-skill-yaml-")); const skill = join(root, "yaml-skill"); mkdirSync(skill);
	try {
		writeFileSync(join(skill, "SKILL.md"), `---\nname: yaml-skill\ndescription: >\n  Review structured commercial documents\ntriggers:\n  - 商业审查\n  - commercial review\nexclude:\n  - translate only\n---\nRules`);
		assert.deepEqual((await new SkillRegistry([root]).search("请做商业审查")).map((item) => item.name), ["yaml-skill"]);
		assert.deepEqual((await new SkillRegistry([root]).search("translate only commercial review")).map((item) => item.name), []);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("standard SKILL.md compatibility route exposes referenced local resources without a BeeMax manifest", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-standard-skill-"));
	const skill = join(root, "research-brief");
	mkdirSync(join(skill, "references"), { recursive: true });
	try {
		writeFileSync(join(skill, "SKILL.md"), `---\nname: research-brief\ndescription: "Create a sourced research brief"\n---\n\nRead references/source-policy.md before researching.`);
		writeFileSync(join(skill, "references", "source-policy.md"), "Require two independently verifiable public sources.");
		writeFileSync(join(skill, "references", "policy.md"), "Substring-only path must not leak into the route.");
		writeFileSync(join(skill, "references", "unmentioned.md"), "This file was not requested by the Skill entry.");
		const runtime = new SkillRuntime(new SkillRegistry([root]));
		await runtime.discover("sourced research brief");
		const activation = await runtime.activate("research-brief");
		assert.deepEqual(activation.routes, [{ name: "legacy", description: "Compatibility route for a self-contained SKILL.md" }]);
		const route = await runtime.routeTo("legacy");
		assert.deepEqual(route.references, ["references/source-policy.md"]);
		runtime.useActivatedInstructionsAsModule();
		assert.equal((await runtime.readResource("references/source-policy.md")).content, "Require two independently verifiable public sources.");
		await assert.rejects(() => runtime.readResource("references/unmentioned.md"), /not declared/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("standard Skill reference discovery is direct, bounded, and fails loudly for a missing declared path", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-standard-skill-direct-")); const skill = join(root, "direct-skill");
	mkdirSync(join(skill, "references"), { recursive: true });
	try {
		for (let index = 0; index < 150; index++) writeFileSync(join(skill, "references", `unrelated-${String(index).padStart(3, "0")}.md`), "unrelated");
		writeFileSync(join(skill, "references", "late.md"), "explicit resource");
		writeFileSync(join(skill, "SKILL.md"), "---\nname: direct-skill\ndescription: Direct reference parsing\n---\nRead `references/late.md`.");
		const runtime = new SkillRuntime(new SkillRegistry([root])); await runtime.discover("Direct reference parsing"); await runtime.activate("direct-skill");
		assert.deepEqual((await runtime.routeTo("legacy")).references, ["references/late.md"]);
		writeFileSync(join(skill, "SKILL.md"), "---\nname: direct-skill\ndescription: Missing reference parsing\n---\nRead `references/missing.md`.");
		new SkillRegistry([root]).invalidate();
		const missing = new SkillRuntime(new SkillRegistry([root])); await missing.discover("Missing reference parsing");
		await assert.rejects(() => missing.activate("direct-skill"), /referenced resource is unavailable: references\/missing\.md/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Skill Registries share one Profile catalog snapshot until explicit invalidation", async () => {
	const f = fixture();
	try {
		const first = new SkillRegistry([f.skills]);
		const firstSnapshot = await first.list();
		assert.match(firstSnapshot[0].description, /commercial contracts/);
		assert.equal(Object.isFrozen(firstSnapshot), true);
		assert.equal(Object.isFrozen(firstSnapshot[0]), true);
		writeFileSync(join(f.skill, "SKILL.md"), `---\nname: contract-review\ndescription: "Changed description for a new catalog generation"\n---\nRules`);
		const concurrentSession = new SkillRegistry([f.skills]);
		assert.match((await concurrentSession.list())[0].description, /commercial contracts/);
		concurrentSession.invalidate();
		assert.match((await new SkillRegistry([f.skills]).list())[0].description, /Changed description/);
	} finally { rmSync(f.root, { recursive: true, force: true }); }
});
