import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	DefaultMemoryLearningKernel,
	LexicalCapabilityRanker,
	ProgressiveCapabilityRanker,
	createExecutionEnvelope,
	createSituation,
	createSkillTools,
} from "@beemax/core";
import { MemoryStore, memoryPersistencePorts } from "@beemax/memory";
import { createStructuredMarketTools } from "../dist/market-data-composition.js";
import { createProfile } from "../dist/profile-config.js";

const twelveDataHtml = `<!doctype html><html><body>
<div class="statistics-historical-prices-table"><table><tbody>
<tr><td>Jul 17, 2026</td><td>3.9765K</td><td>4.0087K</td><td>3.9714K</td><td>3.9950K</td><td>0.4654%</td></tr>
<tr><td>Jul 16, 2026</td><td>4.0603K</td><td>4.0687K</td><td>3.9690K</td><td>3.9768K</td><td>-2.0581%</td></tr>
</tbody></table></div><div>Last update Jul 17, 7:50 PM AEST</div>
</body></html>`;

test("release-stage journey progressively activates report guidance and verified gold data, then recalls the accepted outcome", async () => {
	const home = await mkdtemp(join(tmpdir(), "beemax-stage-journey-"));
	let memory;
	try {
		const paths = await createProfile("personal", { home, root: resolve(".") });
		const market = createStructuredMarketTools({
			now: () => Date.parse("2026-07-17T10:00:00Z"),
			fetch: async (input) => {
				const url = String(input);
				if (url.includes("twelvedata.com")) return new Response(twelveDataHtml, { status: 200, headers: { "content-type": "text/html" } });
				if (url.includes("cenyzlota")) return Response.json([{ data: "2026-07-16", cena: 490.84 }, { data: "2026-07-17", cena: 489.41 }]);
				if (url.includes("exchangerates")) return Response.json({ table: "A", code: "USD", rates: [{ no: "136/A/NBP/2026", effectiveDate: "2026-07-16", mid: 3.7731 }, { no: "137/A/NBP/2026", effectiveDate: "2026-07-17", mid: 3.7951 }] });
				throw new Error(`unexpected URL ${url}`);
			},
		})[0];
		const tools = new Map(createSkillTools(
			paths.homePath,
			() => undefined,
			[market],
			undefined,
			[],
			undefined,
			new ProgressiveCapabilityRanker(new LexicalCapabilityRanker(), { async rank() { return []; } }),
		).map((tool) => [tool.name, tool]));
		const requirements = [
			{ id: "capreq:0:aaaaaaaa", text: "调研过去30天黄金走势并形成专业报告" },
			{ id: "capreq:1:bbbbbbbb", text: "获取XAU/USD结构化行情数据" },
		];

		const proposal = await tools.get("capability_discover").beemaxCapabilityPrefetch(
			"调研过去的黄金走势报告",
			undefined,
			{ requirements },
		);
		assert.deepEqual(proposal.activatedTools, ["market_series", "skill_activate", "skill_read"]);
		assert.ok(proposal.candidates.some((candidate) => candidate.name === "market_series" && candidate.requirementId === requirements[1].id));
		assert.deepEqual(proposal.skills.map((skill) => skill.name), ["historical-market-research"]);

		const guidance = await tools.get("skill_read").execute("skill:research", { name: "historical-market-research" });
		assert.equal(guidance.details.skillLifecycleReceipt.phase, "read");
		assert.deepEqual(guidance.details.activatedTools, ["skill_complete"]);
		assert.match(guidance.content[0].text, /most recent 30 calendar days/i);
		assert.match(guidance.content[0].text, /market_series/);

		const marketResult = await market.execute("market:gold", {
			symbol: "XAU/USD",
			startDate: "2026-07-16",
			endDate: "2026-07-17",
		}, new AbortController().signal);
		assert.equal(marketResult.details.marketSeries.crosscheck.status, "accepted");
		assert.equal(marketResult.details.marketSeries.sources.length, 2);
		assert.match(marketResult.details.sourceReceipt.id, /^source-receipt:sha256:/);

		const completed = await tools.get("skill_complete").execute("skill:complete", {});
		assert.equal(completed.details.skillLifecycleReceipt.phase, "completed");
		assert.equal(completed.details.capabilityReceipt.name, "historical-market-research");

		memory = new MemoryStore(join(paths.homePath, "data", "stage-journey.db"), "personal");
		memory.upsertVerifiedEpisodeAndSignal({
			profileId: "personal",
			platform: "cli",
			chatId: "local",
			chatType: "dm",
			userId: "local",
			objectiveId: "objective:gold-trend",
			sourceRevision: 1,
			situation: createSituation({ summary: "调研过去30天XAU/USD黄金走势", goals: ["形成有来源的中文报告"], confidence: 1 }),
			action: "使用结构化行情与独立来源交叉验证",
			outcome: "黄金走势报告已完成，数据来源和时间范围已说明。",
			evidence: marketResult.details.sourceReceipt.id,
			status: "verified",
		});
		const kernel = new DefaultMemoryLearningKernel({ authority: memoryPersistencePorts(memory).memoryLearningAuthority });
		await kernel.maintain({ profileId: "personal", trigger: "signal", maxItems: 10, maxModelCalls: 0, leaseMs: 30_000, now: Date.now() + 1 });
		const query = "上次黄金走势报告采用了什么数据和范围";
		const pack = await kernel.prepare({
			envelope: createExecutionEnvelope({ executionId: "execution:gold-follow-up", trigger: { kind: "interaction" } }),
			scope: { profileId: "personal", platform: "cli", chatId: "local", chatType: "dm", userId: "local" },
			situation: createSituation({ summary: query, confidence: 1 }),
			query,
			queryDigest: createHash("sha256").update(query).digest("hex"),
			requiredItems: [],
			maxOptionalChars: 4_000,
			policyVersion: "l4.v1",
		});
		assert.ok(pack.optionalItems.some((item) => item.component?.kind === "projection"));
		assert.match(pack.safePrefix, /executable="false"/);
	} finally {
		memory?.close();
		await rm(home, { recursive: true, force: true });
	}
});
