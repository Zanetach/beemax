import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSkillTools } from "../dist/index.js";

function toolsAt(root, inventory = [], verifier, activateTools) {
	return new Map(createSkillTools(root, () => undefined, inventory, verifier, [], activateTools).map((tool) => [tool.name, tool]));
}

test("capability discovery searches the current tool inventory before learning a Skill", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-capability-discovery-"));
	try {
		const activations = [];
		const tools = toolsAt(root, [{ name: "calendar_find", description: "Find free calendar time" }], undefined, (names) => activations.push(names));
		const discovered = await tools.get("capability_discover").execute("discover", { query: "calendar" });
		assert.deepEqual(discovered.details.tools, [{ name: "calendar_find", description: "Find free calendar time" }]);
		assert.deepEqual(discovered.details.activatedTools, ["calendar_find"]);
		assert.deepEqual(activations, [["calendar_find"]]);
		assert.deepEqual(discovered.details.skills, []);
		assert.equal(existsSync(join(root, "state", "skill-learning.key")), false);
		assert.equal(tools.get("capability_discover").beemaxPolicy.sideEffect, "none");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("capability discovery returns clone-safe metadata instead of executable Tool definitions", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-capability-clone-safe-"));
	try {
		const executableTool = { name: "meeting_list", description: "List meetings", execute: async () => ({ content: [] }) };
		const tools = toolsAt(root, [executableTool]);
		const discovered = await tools.get("capability_discover").execute("discover", { query: "meeting" });
		assert.doesNotThrow(() => structuredClone(discovered));
		assert.deepEqual(discovered.details.tools, [{ name: "meeting_list", description: "List meetings" }]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("capability discovery ranks multilingual aliases and excludes negative matches", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-capability-ranking-"));
	try {
		const tools = toolsAt(root, [
			{ name: "calendar_find", description: "Find available calendar time", aliases: ["查日程", "空闲时间"], triggers: ["安排会议"] },
			{ name: "calendar_delete", description: "Delete calendar events", aliases: ["删除日程"], exclude: ["查询", "查"] },
		]);
		const discovered = await tools.get("capability_discover").execute("discover", { query: "帮我查日程并安排会议" });
		assert.deepEqual(discovered.details.tools.map((tool) => tool.name), ["calendar_find"]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Skill tools progressively activate a project Skill route and only its declared resource", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-progressive-skill-tools-"));
	try {
		const project = join(root, "project-skills"); const skill = join(project, "report-review");
		mkdirSync(join(skill, "modules"), { recursive: true });
		writeFileSync(join(skill, "SKILL.md"), `---\nname: report-review\ndescription: "Review business reports"\ntriggers: ["report review"]\n---\nUse the route table.`);
		writeFileSync(join(skill, "manifest.json"), JSON.stringify({ version: 1, routes: { review: { module: "modules/review.md", tools: ["web_search"] } } }));
		writeFileSync(join(skill, "modules", "review.md"), "Review only material claims.");
		const activations = [];
		const tools = new Map(createSkillTools(root, () => undefined, [{ name: "web_search", description: "Search public sources" }], undefined, [project], (names) => activations.push(names)).map((tool) => [tool.name, tool]));
		const discovery = await tools.get("capability_discover").execute("discover", { query: "report review" });
		assert.deepEqual(discovery.details.skills.map((item) => item.name), ["report-review"]);
		const activated = await tools.get("skill_activate").execute("activate", { name: "report-review" }); assert.match(activated.content[0].text, /route table/);
		await tools.get("skill_route").execute("route", { route: "review" });
		assert.equal((await tools.get("skill_resource_read").execute("read", { path: "modules/review.md" })).content[0].text, "Review only material claims.");
		assert.equal((await tools.get("skill_complete").execute("complete", {})).details.state, "completed");
		assert.deepEqual(activations, [["skill_activate", "skill_read"], ["skill_route", "skill_complete"], ["skill_resource_read", "skill_complete", "web_search"]]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Skill activation never reports success with silently truncated instructions", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-complete-skill-tools-"));
	try {
		const skill = join(root, "project-skills", "large-review");
		mkdirSync(skill, { recursive: true });
		const sentinel = "END-OF-SKILL-INSTRUCTIONS";
		writeFileSync(join(skill, "SKILL.md"), `---\nname: large-review\ndescription: "Review large structured documents"\n---\n${"x".repeat(55_000)}${sentinel}`);
		const tools = new Map(createSkillTools(root, () => undefined, [], undefined, [join(root, "project-skills")]).map((tool) => [tool.name, tool]));
		await tools.get("capability_discover").execute("discover", { query: "large review" });
		const activated = await tools.get("skill_activate").execute("activate", { name: "large-review" });
		assert.match(activated.content[0].text, new RegExp(`${sentinel}$`));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed Skill trial remains quarantined until two later independent successes promote it", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-skill-learning-"));
	let reloads = 0;
	try {
		let trial = 0;
		const verifier = async (input) => ({ trialId: `trial-${++trial}`, assertions: [{ claim: "Official date matches", evidence: `Observed official evidence for ${input.scenario}` }], toolCalls: [{ callId: `call-${trial}`, name: "web_extract" }], ...(input.scenario.includes("missing") ? { accepted: false, evidence: "Missed the publication date in a controlled trial." } : { accepted: true, evidence: `Matched official evidence for ${input.scenario}` }) });
		const tools = new Map(createSkillTools(root, () => { reloads++; }, [], verifier).map((tool) => [tool.name, tool]));
		await tools.get("skill_candidate_install").execute("install", {
			name: "source-check", description: "Check claims against primary sources", source: "verified local workflow",
			instructions: "Find the primary source, compare the material claim, and report a concise evidence trail.",
		});
		assert.equal((await tools.get("skill_list").execute("list", {})).details.skills.length, 0);
		await tools.get("skill_candidate_verify").execute("verify-1", { name: "source-check", scenario: "missing publication date case", acceptanceCriteria: "Reject any result missing the official publication date." });
		await tools.get("skill_candidate_verify").execute("verify-2", { name: "source-check", scenario: "official release date case", acceptanceCriteria: "Match the official release and publication date." });
		await assert.rejects(() => tools.get("skill_candidate_verify").execute("verify-duplicate", { name: "source-check", scenario: "official release date case", acceptanceCriteria: "Match the official release and publication date." }), /distinct scenario/i);
		await assert.rejects(() => tools.get("skill_candidate_promote").execute("promote", { name: "source-check" }), /two consecutive accepted trials/i);
		await tools.get("skill_candidate_verify").execute("verify-3", { name: "source-check", scenario: "second independent official source case", acceptanceCriteria: "Match the second official source and retain its evidence." });
		await tools.get("skill_candidate_promote").execute("promote", { name: "source-check" });
		assert.equal(reloads, 1);
		assert.match(readFileSync(join(root, "skills", "source-check", "SKILL.md"), "utf8"), /managed-by: beemax/);
		assert.equal((await tools.get("skill_list").execute("list", {})).details.skills.length, 1);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Skill candidate installation rejects credential-like material", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-skill-secret-"));
	try {
		const tool = toolsAt(root).get("skill_candidate_install");
		await assert.rejects(() => tool.execute("install", { name: "unsafe", description: "Unsafe candidate instructions", source: "untrusted", instructions: "Use api_key=secret-value when invoking this workflow." }), /credential-like/i);
		await assert.rejects(() => tool.execute("install", { name: "unsafe-source", description: "Unsafe candidate instructions", source: "Bearer abcdefghijklmnopqrstuvwxyz", instructions: "Use the documented authenticated workflow without embedding any private values." }), /credential-like/i);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("direct Skill creation rejects credential material at the durable write boundary", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-direct-skill-secret-"));
	try {
		const tool = toolsAt(root).get("skill_create");
		await assert.rejects(() => tool.execute("create", { name: "unsafe-direct", description: "Unsafe direct workflow", instructions: 'Read config {"password":"must-not-persist"} and continue with the documented workflow.' }), /credential-like/i);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy skill_read preserves one-call activation for self-contained Skills", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-legacy-skill-")); const activations = [];
	try {
		const tools = new Map(createSkillTools(root, () => undefined, [{ name: "web_search", description: "Search" }], undefined, [], (names) => activations.push(names)).map((tool) => [tool.name, tool]));
		await tools.get("skill_create").execute("create", { name: "legacy-review", description: "Review a source using the legacy workflow", instructions: "Search the primary source and produce a concise review." });
		const read = await tools.get("skill_read").execute("read", { name: "legacy-review" });
		assert.equal(read.details.legacy, true); assert.equal(read.details.state.state, "module_loaded"); assert.match(read.content[0].text, /Search the primary source/);
		assert.deepEqual(activations.at(-1), ["skill_complete"]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Skill verification never persists credential material returned as evidence", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-skill-evidence-secret-"));
	try {
		const tools = toolsAt(root, [], async () => ({ trialId: "trial-secret", accepted: true, evidence: "password=leaked-secret", assertions: [{ claim: "Secret leaked", evidence: "Observed unsafe verifier output" }], toolCalls: [] }));
		await tools.get("skill_candidate_install").execute("install", { name: "safe", description: "A safe reusable workflow", source: "local observation", instructions: "Inspect the supplied public evidence and return a structured factual result." });
		await assert.rejects(() => tools.get("skill_candidate_verify").execute("verify", { name: "safe", scenario: "Check a representative public source", acceptanceCriteria: "The result cites observable public evidence" }), /credential-like/i);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Skill verification requires a structured unique trial identity", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-skill-trial-id-"));
	try {
		const tools = toolsAt(root, [], async () => ({ trialId: "", accepted: true, evidence: "Observable evidence from a controlled run", assertions: [{ claim: "Result exists", evidence: "Observed controlled run output" }], toolCalls: [] }));
		await tools.get("skill_candidate_install").execute("install", { name: "trial", description: "A workflow requiring real trials", source: "local observation", instructions: "Inspect public evidence and return a structured result with concrete references." });
		await assert.rejects(() => tools.get("skill_candidate_verify").execute("verify", { name: "trial", scenario: "Representative public evidence case", acceptanceCriteria: "Concrete references are returned" }), /trial identity/i);
		assert.equal(tools.get("skill_candidate_verify").beemaxPolicy.reversible, false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
