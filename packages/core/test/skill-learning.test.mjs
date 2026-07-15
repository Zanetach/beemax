import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CapabilityProviderRuntime, ModelBackedSemanticCapabilityPort, SemanticCapabilityRanker, createSkillTools } from "../dist/index.js";

function toolsAt(root, inventory = [], verifier, activateTools, promotionAuthority, providerRuntime) {
	return new Map(createSkillTools(root, () => undefined, inventory, verifier, [], activateTools, undefined, promotionAuthority, undefined, providerRuntime).map((tool) => [tool.name, tool]));
}

test("capability discovery searches the current tool inventory before learning a Skill", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-capability-discovery-"));
	try {
		const activations = [];
		const tools = toolsAt(root, [{ name: "calendar_find", description: "Find free calendar time" }], undefined, (names) => activations.push(names));
		const discovered = await tools.get("capability_discover").execute("discover", { query: "calendar" });
		assert.deepEqual(discovered.details.tools, [{ name: "calendar_find", description: "Find free calendar time" }]);
		assert.deepEqual(discovered.details.activatedTools, ["calendar_find"]);
		assert.deepEqual(activations, []);
		assert.deepEqual(discovered.details.skills, []);
		assert.equal(existsSync(join(root, "state", "skill-learning.key")), false);
		assert.equal(tools.get("capability_discover").beemaxPolicy.sideEffect, "none");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("production capability prefetch returns one semantic Tool/MCP/Skill proposal without activating it", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-capability-prefetch-"));
	try {
		const ranker = { async rank(_query, inventory) {
			const descriptor = inventory.find((item) => item.name === "calendar_lookup");
			return [{ descriptor, score: 96, confidence: 0.96, explanation: { strategy: "semantic", summary: "cross-language temporal intent", signals: ["meaning"] } }];
		} };
		const tools = new Map(createSkillTools(root, () => undefined, [{ name: "calendar_lookup", description: "Coordinate temporal availability", kind: "mcp" }], undefined, [], undefined, ranker).map((tool) => [tool.name, tool]));
		const proposal = await tools.get("capability_discover").beemaxCapabilityPrefetch("安排一次会议");
		assert.equal(proposal.candidates.length, 1);
		assert.deepEqual({ ...proposal.candidates[0], version: undefined }, { kind: "mcp", name: "calendar_lookup", version: undefined, confidence: 0.96 });
		assert.match(proposal.candidates[0].version, /^sha256:[a-f0-9]{64}$/u);
		assert.deepEqual(proposal.skills, []);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Provider resolution ignores a blocked semantic backup when a required healthy capability satisfies the same obligation", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-provider-alternative-"));
	try {
		const ranker = new SemanticCapabilityRanker(new ModelBackedSemanticCapabilityPort(async ({ candidates }) => ({ matches: [
			{ id: candidates.find((candidate) => candidate.name === "primary_search").id, name: "primary_search", similarity: 0.97, requirementId: "fresh-evidence", necessity: "required" },
			{ id: candidates.find((candidate) => candidate.name === "backup_search").id, name: "backup_search", similarity: 0.95, requirementId: "fresh-evidence", necessity: "alternative" },
		] })));
		const tools = new Map(createSkillTools(root, () => undefined, [
			{ name: "primary_search", description: "Search fresh public evidence", providers: [{ id: "primary", kind: "tool", capabilities: ["primary_search"], installed: true, health: async () => ({ status: "ready", evidenceRef: "health:primary" }) }] },
			{ name: "backup_search", description: "Alternative search for fresh public evidence", providers: [{ id: "backup", kind: "tool", capabilities: ["backup_search"], installed: false, install: { source: "catalog", package: "backup", version: "1" }, health: async () => ({ status: "unavailable", reason: "not installed" }) }] },
		], undefined, [], undefined, ranker).map((tool) => [tool.name, tool]));
		const proposal = await tools.get("capability_discover").beemaxCapabilityPrefetch("Find fresh public evidence");
		assert.deepEqual(proposal.candidates.map((candidate) => candidate.name), ["primary_search"]);
		assert.deepEqual(proposal.activatedTools, ["primary_search"]);
		assert.deepEqual(proposal.providerResolutions.map((resolution) => [resolution.capability, resolution.status]), [["primary_search", "ready"]]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Skill lifecycle admission ignores an uncalibrated low-confidence fallback match", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-skill-admission-floor-"));
	try {
		const project = join(root, "project-skills");
		const skill = join(project, "weak-review");
		mkdirSync(skill, { recursive: true });
		writeFileSync(join(skill, "SKILL.md"), `---\nname: weak-review\ndescription: "Review supplied material"\n---\nReview the supplied material.`);
		const ranker = { async rank(_query, inventory) {
			const descriptor = inventory.find((item) => item.name === "weak-review");
			return [{ descriptor, score: 74, confidence: 0.74, explanation: { strategy: "lexical", summary: "weak fallback overlap", signals: ["weak overlap"] } }];
		} };
		const tools = new Map(createSkillTools(root, () => undefined, [], undefined, [project], undefined, ranker).map((tool) => [tool.name, tool]));
		const proposal = await tools.get("capability_discover").beemaxCapabilityPrefetch("explain review methods");
		assert.deepEqual(proposal.skills, []);
		assert.deepEqual(proposal.activatedTools, []);
		const discovered = await tools.get("capability_discover").execute("discover", { query: "explain review methods" });
		assert.deepEqual(discovered.details.skills, []);
		assert.deepEqual(discovered.details.activatedTools, []);
		await assert.rejects(() => tools.get("skill_activate").execute("activate", { name: "weak-review" }), /must be discovered/i);
		const explicit = await tools.get("capability_discover").beemaxCapabilityPrefetch("weak-review", undefined, { explicitSkillName: "weak-review" });
		assert.deepEqual(explicit.skills.map((item) => item.name), ["weak-review"]);
		assert.deepEqual(explicit.activatedTools, ["skill_activate", "skill_read"]);
		assert.match((await tools.get("skill_activate").execute("explicit-activate", { name: "weak-review" })).content[0].text, /Review the supplied material/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unavailable explicit Skill never falls through to a different semantic Skill", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-explicit-skill-missing-"));
	try {
		const project = join(root, "project-skills");
		const alternative = join(project, "alternative-review");
		mkdirSync(alternative, { recursive: true });
		writeFileSync(join(alternative, "SKILL.md"), `---\nname: alternative-review\ndescription: "Review alternate material"\n---\nUse the alternate workflow.`);
		const ranker = { async rank(_query, inventory) {
			const descriptor = inventory.find((item) => item.name === "alternative-review");
			return [{ descriptor, score: 99, confidence: 0.99, explanation: { strategy: "semantic", summary: "similar but not exact", signals: ["semantic similarity"] } }];
		} };
		const tools = new Map(createSkillTools(root, () => undefined, [], undefined, [project], undefined, ranker).map((tool) => [tool.name, tool]));
		const proposal = await tools.get("capability_discover").beemaxCapabilityPrefetch("missing-review", undefined, { explicitSkillName: "missing-review" });
		assert.deepEqual(proposal.skills, []);
		assert.deepEqual(proposal.candidates, []);
		assert.deepEqual(proposal.activatedTools, []);
		assert.deepEqual(proposal.skillBlocker, { code: "skill_not_installed", name: "missing-review" });
		await assert.rejects(() => tools.get("skill_activate").execute("activate", { name: "alternative-review" }), /must be discovered/i);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("operational health and Profile preference never change immutable Capability versions", async () => {
	const versions = [];
	const ranker = { async rank(_query, inventory) { versions.push(inventory[0].version); return []; } };
	for (const [health, profilePreference] of [["ready", 0.8], ["unverified", -0.4]]) {
		const root = mkdtempSync(join(tmpdir(), "beemax-capability-version-"));
		try {
			const tools = new Map(createSkillTools(root, () => undefined, [{ name: "stable_tool", description: "Stable implementation", parameters: { type: "object" }, signals: { health, profilePreference, inputModalities: ["text"] } }], undefined, [], undefined, ranker).map((tool) => [tool.name, tool]));
			await tools.get("capability_discover").execute("discover", { query: "stable tool" });
		} finally { rmSync(root, { recursive: true, force: true }); }
	}
	assert.equal(versions.length, 2);
	assert.equal(versions[0], versions[1]);
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

test("capability discovery reports matched Tool and MCP Provider health plus exact configuration blockers", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-provider-discovery-"));
	try {
		const tools = toolsAt(root, [{
			name: "web_search", description: "Search current public web sources", triggers: ["live research"],
			providers: [
				{ id: "ready-mcp", kind: "mcp", capabilities: ["web_search"], installed: true, health: async () => ({ status: "ready", evidenceRef: "probe:ready" }) },
				{ id: "needs-key", kind: "tool", capabilities: ["web_search"], installed: true, configuration: { required: ["SEARCH_API_KEY"], instructions: "Configure a Profile credential reference." }, health: async () => ({ status: "configuration_required", reason: "SEARCH_API_KEY is not configured", missingConfiguration: ["SEARCH_API_KEY"] }) },
			],
		}]);
		const discovered = await tools.get("capability_discover").execute("discover", { query: "live research" });
		assert.deepEqual(discovered.details.providers.map((provider) => [provider.id, provider.health.status]), [["ready-mcp", "ready"], ["needs-key", "configuration_required"]]);
		assert.match(discovered.content[0].text, /ready-mcp: ready/);
		assert.match(discovered.content[0].text, /SEARCH_API_KEY is not configured/);
		assert.doesNotThrow(() => structuredClone(discovered));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("capability acquisition installs an exact Provider with authority evidence and exposes only the recovered Tool", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-provider-acquisition-"));
	try {
		let installed = false;
		const providerRuntime = new CapabilityProviderRuntime({
			installAuthority: { authorize: async ({ provider }) => ({ allowed: provider.id === "approved-analysis-mcp", evidenceRef: "approval:analysis-mcp" }) },
			installer: { install: async (provider) => { installed = provider.id === "approved-analysis-mcp"; return { receiptId: "install:analysis-mcp", installedAt: 42, evidenceRef: "catalog:analysis-mcp" }; } },
		});
		const tools = toolsAt(root, [{
			name: "remote_analysis", description: "Analyze remote structured evidence", triggers: ["remote analysis"], signals: { health: "unavailable" },
			providers: [{ id: "approved-analysis-mcp", kind: "mcp", capabilities: ["remote_analysis"], installed: false, install: { source: "approved-catalog", package: "approved-analysis-mcp", version: "1.0.0" }, health: async () => installed ? { status: "ready", evidenceRef: "health:analysis-mcp" } : { status: "unavailable", reason: "not installed" } }],
		}], undefined, undefined, undefined, providerRuntime);
		const discovered = await tools.get("capability_discover").execute("discover", { query: "remote analysis" });
		assert.deepEqual(discovered.details.activatedTools, ["capability_acquire"]);
		assert.equal(discovered.details.providerResolutions[0].status, "blocked");
		const acquired = await tools.get("capability_acquire").execute("acquire", { capability: "remote_analysis" });
		assert.equal(acquired.details.providerAcquisition.status, "ready");
		assert.equal(acquired.details.providerAcquisition.authorityEvidenceRef, "approval:analysis-mcp");
		assert.equal(acquired.details.providerAcquisition.installationReceipt.receiptId, "install:analysis-mcp");
		assert.deepEqual(acquired.details.activatedTools, ["remote_analysis"]);
		assert.equal(tools.get("capability_acquire").beemaxPolicy.approval, "always");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("capability acquisition redacts Provider authority errors before they enter model content or details", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-provider-redaction-"));
	try {
		const providerRuntime = new CapabilityProviderRuntime({
			installAuthority: { authorize: async () => ({ allowed: false, reason: "API_KEY=super-secret-value cannot authorize this install" }) },
		});
		const tools = toolsAt(root, [{ name: "remote_analysis", description: "Analyze remote evidence", providers: [{ id: "remote-analysis", kind: "mcp", capabilities: ["remote_analysis"], installed: false, install: { source: "approved-catalog", package: "remote-analysis", version: "1.0.0" }, health: async () => ({ status: "ready", evidenceRef: "health:remote-analysis" }) }] }], undefined, undefined, undefined, providerRuntime);
		const acquired = await tools.get("capability_acquire").execute("acquire", { capability: "remote_analysis" });
		const serialized = JSON.stringify(acquired);
		assert.doesNotMatch(serialized, /super-secret-value/);
		assert.match(serialized, /credential details redacted/i);
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

test("capability discovery applies one Top-K budget across Tools and Skills", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-unified-capability-ranking-"));
	try {
		const project = join(root, "project-skills");
		const skill = join(project, "report-review");
		mkdirSync(skill, { recursive: true });
		writeFileSync(join(skill, "SKILL.md"), `---\nname: report-review\ndescription: "Review reports"\ntriggers: ["review reports"]\n---\nUse the route table.`);
		const losingSkill = join(project, "zzz-review"); mkdirSync(losingSkill, { recursive: true });
		writeFileSync(join(losingSkill, "SKILL.md"), `---\nname: zzz-review\ndescription: "Review reports"\n---\nThis Skill must lose the unified budget.`);
		const inventory = Array.from({ length: 12 }, (_, index) => ({ name: `report_tool_${index}`, description: `Review reports using tool ${index}`, kind: index === 0 ? "mcp" : "tool" }));
		const activations = [];
		const tools = new Map(createSkillTools(root, () => undefined, inventory, undefined, [project], (names) => activations.push(names)).map((tool) => [tool.name, tool]));
		const discovered = await tools.get("capability_discover").execute("discover", { query: "review reports" });
		assert.equal(discovered.details.ranked.length, 10);
		assert.equal(discovered.details.ranked[0].kind, "skill");
		assert.equal(discovered.details.ranked[0].name, "report-review");
		assert.equal(discovered.details.tools.length, 9);
		assert.deepEqual(discovered.details.skills.map((item) => item.name), ["report-review"]);
		assert.equal(discovered.details.ranked.some((item) => item.kind === "mcp"), true);
		assert.equal(discovered.details.ranked.every((item) => Number.isFinite(item.score) && item.confidence >= 0 && item.confidence <= 1 && item.reason.length > 0), true);
		assert.deepEqual(activations, []);
		assert.deepEqual(discovered.details.activatedTools, [...discovered.details.tools.map((item) => item.name), "skill_activate", "skill_read"]);
		await assert.rejects(() => tools.get("skill_activate").execute("activate-loser", { name: "zzz-review" }), /must be discovered/i);
		assert.doesNotThrow(() => structuredClone(discovered));
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
		const tools = new Map(createSkillTools(root, () => undefined, [{ name: "web_search", description: "Search public sources", providers: [{ id: "search-provider", kind: "tool", capabilities: ["web_search"], installed: true, health: async () => ({ status: "unhealthy", reason: "probe failed" }) }] }], undefined, [project], (names) => activations.push(names)).map((tool) => [tool.name, tool]));
		const discovery = await tools.get("capability_discover").execute("discover", { query: "report review" });
		assert.deepEqual(discovery.details.skills.map((item) => item.name), ["report-review"]);
		const activated = await tools.get("skill_activate").execute("activate", { name: "report-review" }); assert.match(activated.content[0].text, /route table/);
		const routed = await tools.get("skill_route").execute("route", { route: "review" });
		const resource = await tools.get("skill_resource_read").execute("read", { path: "modules/review.md" }); assert.equal(resource.content[0].text, "Review only material claims.");
		const completed = await tools.get("skill_complete").execute("complete", {}); assert.equal(completed.details.state, "completed");
		assert.deepEqual(activations, []);
		assert.deepEqual(discovery.details.activatedTools, ["skill_activate", "skill_read"]);
		assert.deepEqual(activated.details.activatedTools, ["skill_route", "skill_complete"]);
		assert.deepEqual(routed.details.activatedTools, ["skill_resource_read", "skill_complete", "web_search"]);
		assert.equal(routed.details.providerResolutions[0].capability, "web_search");
		assert.equal(routed.details.providerResolutions[0].status, "blocked");
		assert.equal(routed.details.providerResolutions[0].blocker.code, "provider_unhealthy");
		assert.match(routed.details.providerResolutions[0].blocker.reason, /probe failed/);
		assert.equal(routed.details.providerResolutions[0].candidates[0].health.status, "unhealthy");
		assert.deepEqual([activated, routed, resource, completed].map((item) => [item.details.skillLifecycleReceipt.phase, item.details.skillLifecycleReceipt.sourceTool]), [["activated", "skill_activate"], ["routed", "skill_route"], ["resource_read", "skill_resource_read"], ["completed", "skill_complete"]]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Skill routes resolve a unique legacy Tool alias to its current canonical Tool", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-skill-tool-alias-"));
	try {
		const project = join(root, "project-skills"); const skill = join(project, "legacy-search-skill");
		mkdirSync(join(skill, "modules"), { recursive: true });
		writeFileSync(join(skill, "SKILL.md"), `---\nname: legacy-search-skill\ndescription: "Use a renamed search capability"\ntriggers: ["legacy search"]\n---\nUse the declared route.`);
		writeFileSync(join(skill, "manifest.json"), JSON.stringify({ version: 1, routes: { research: { module: "modules/research.md", tools: ["legacy_search"] } } }));
		writeFileSync(join(skill, "modules", "research.md"), "Search and preserve evidence.");
		const tools = new Map(createSkillTools(root, () => undefined, [{ name: "current_search", description: "Current canonical search Tool", aliases: ["legacy_search"] }], undefined, [project]).map((tool) => [tool.name, tool]));
		await tools.get("capability_discover").execute("discover", { query: "legacy search" });
		await tools.get("skill_activate").execute("activate", { name: "legacy-search-skill" });
		const routed = await tools.get("skill_route").execute("route", { route: "research" });
		assert.deepEqual(routed.details.declaredTools, ["legacy_search"]);
		assert.deepEqual(routed.details.tools, ["current_search"]);
		assert.deepEqual(routed.details.activatedTools, ["skill_resource_read", "skill_complete", "current_search"]);
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

test("a failed Workflow Skill trial never changes the active Skill", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-skill-failed-update-"));
	try {
		const verifier = async () => ({ trialId: "trial:failed", accepted: false, evidence: "Controlled trial rejected the candidate without changing active behavior.", assertions: [], toolCalls: [] });
		const tools = toolsAt(root, [], verifier, undefined, async () => ({ allowed: true, evidenceRef: "authority:workflow:1" }));
		await tools.get("skill_create").execute("create", { name: "evidence-flow", description: "Existing stable evidence workflow", instructions: "Keep the existing stable evidence workflow active for every applicable request." });
		const activePath = join(root, "skills", "evidence-flow", "SKILL.md");
		const before = readFileSync(activePath, "utf8");
		await tools.get("skill_candidate_install").execute("install", { name: "evidence-flow", description: "Candidate evidence workflow", source: "workflow-candidate:workflow:1@2", instructions: "Trial a different evidence sequence in quarantine and verify it independently." });
		await tools.get("skill_candidate_verify").execute("verify", { name: "evidence-flow", scenario: "Representative failed evidence sequence", acceptanceCriteria: "The sequence must retain independently observable evidence." });
		assert.equal(readFileSync(activePath, "utf8"), before);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Workflow Skill promotion requires current configured authority evidence", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-skill-promotion-authority-"));
	let allowed = false;
	let trial = 0;
	try {
		const verifier = async (input) => ({ trialId: `trial:${++trial}`, accepted: true, evidence: `Controlled trial retained observable evidence for ${input.scenario}.`, assertions: [{ claim: "Outcome verified", evidence: "Independent verifier observed the required outcome." }], toolCalls: [] });
		const tools = toolsAt(root, [], verifier, undefined, async (input) => allowed && input.source === "workflow-candidate:workflow:7@3" ? { allowed: true, evidenceRef: "review:workflow:7:current" } : { allowed: false, reason: "Workflow source is no longer current" });
		await tools.get("skill_candidate_install").execute("install", { name: "workflow-seven", description: "Workflow-derived evidence routine", source: "workflow-candidate:workflow:7@3", instructions: "Follow the reviewed conditions and verify the expected outcome with independent evidence." });
		await tools.get("skill_candidate_verify").execute("verify-1", { name: "workflow-seven", scenario: "First independent representative scenario", acceptanceCriteria: "The expected outcome has observable evidence." });
		await tools.get("skill_candidate_verify").execute("verify-2", { name: "workflow-seven", scenario: "Second independent representative scenario", acceptanceCriteria: "The expected outcome has observable evidence." });
		await assert.rejects(() => tools.get("skill_candidate_promote").execute("promote-denied", { name: "workflow-seven" }), /no longer current/i);
		allowed = true;
		const promoted = await tools.get("skill_candidate_promote").execute("promote", { name: "workflow-seven" });
		assert.equal(promoted.details.authorityEvidenceRef, "review:workflow:7:current");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Skill promotions retain immutable versions and support observable durable rollback", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-skill-version-rollback-"));
	let trial = 0;
	try {
		const verifier = async (input) => ({ trialId: `trial:${++trial}`, accepted: true, evidence: `Controlled trial retained observable evidence for ${input.scenario}.`, assertions: [{ claim: "Version works", evidence: "Independent verifier observed the expected version outcome." }], toolCalls: [] });
		const tools = toolsAt(root, [], verifier);
		for (const [version, instructions] of [["v1", "Use the first verified workflow and retain its observable evidence trail."], ["v2", "Use the second verified workflow and retain its improved observable evidence trail."]]) {
			await tools.get("skill_candidate_install").execute(`install-${version}`, { name: "versioned-flow", description: "Versioned verified workflow", source: `reviewed:${version}`, instructions });
			await tools.get("skill_candidate_verify").execute(`verify-${version}-1`, { name: "versioned-flow", scenario: `${version} first independent scenario`, acceptanceCriteria: "The version produces observable evidence." });
			await tools.get("skill_candidate_verify").execute(`verify-${version}-2`, { name: "versioned-flow", scenario: `${version} second independent scenario`, acceptanceCriteria: "The version produces observable evidence." });
			await tools.get("skill_candidate_promote").execute(`promote-${version}`, { name: "versioned-flow" });
		}
		const versions = await tools.get("skill_versions").execute("versions", { name: "versioned-flow" });
		assert.equal(versions.details.versions.length, 2);
		const firstSha = versions.details.versions.find((item) => item.source === "reviewed:v1").sha256;
		await tools.get("skill_rollback").execute("rollback", { name: "versioned-flow", sha256: firstSha });
		assert.match(readFileSync(join(root, "skills", "versioned-flow", "SKILL.md"), "utf8"), /first verified workflow/);
		const after = await tools.get("skill_versions").execute("versions-after", { name: "versioned-flow" });
		assert.equal(after.details.currentSha256, firstSha);
		assert.equal(after.details.events.at(-1).kind, "rollback");
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
		assert.deepEqual(activations, []);
		assert.deepEqual(read.details.activatedTools, ["skill_complete"]);
		assert.deepEqual([read.details.skillLifecycleReceipt.phase, read.details.skillLifecycleReceipt.sourceTool], ["read", "skill_read"]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("repeated Skill lifecycle calls retain replay identity without colliding across Tool calls", async () => {
	const root = mkdtempSync(join(tmpdir(), "beemax-skill-receipt-identity-"));
	try {
		const tools = toolsAt(root);
		await tools.get("skill_create").execute("create", { name: "receipt-review", description: "Review evidence with stable lifecycle receipts", instructions: "Inspect the supplied evidence and return a concise verified result." });
		const first = await tools.get("skill_read").execute("read-call-one", { name: "receipt-review" });
		const replay = await tools.get("skill_read").execute("read-call-one", { name: "receipt-review" });
		const second = await tools.get("skill_read").execute("read-call-two", { name: "receipt-review" });
		assert.equal(first.details.skillLifecycleReceipt.id, replay.details.skillLifecycleReceipt.id);
		assert.notEqual(first.details.skillLifecycleReceipt.id, second.details.skillLifecycleReceipt.id);
		assert.match(first.details.skillLifecycleReceipt.id, /:[a-f0-9]{64}$/u);
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
