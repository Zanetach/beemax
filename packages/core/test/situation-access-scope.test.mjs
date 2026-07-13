import assert from "node:assert/strict";
import test from "node:test";
import { createAccessScopeRef, createSituation } from "../dist/index.js";

test("Access Scope references accept verified authorities and reject model or user inference", () => {
	const trusted = createAccessScopeRef({
		id: "scope:operations",
		authority: { kind: "membership_registry", reference: "membership:ops-user" },
		evidenceRef: "audit:membership-check-42",
		issuedAt: 1_752_384_000_000,
	});
	assert.deepEqual(trusted, {
		id: "scope:operations",
		trust: "verified",
		authority: { kind: "membership_registry", reference: "membership:ops-user" },
		evidenceRef: "audit:membership-check-42",
		issuedAt: 1_752_384_000_000,
	});

	for (const kind of ["model", "user"]) {
		assert.throws(
			() => createAccessScopeRef({ id: "scope:forged", authority: { kind, reference: "claim:forged" }, issuedAt: 1 }),
			/Access Scope authority must be trusted/,
		);
	}
});

test("Situation preserves open enterprise meaning with evidence, confidence, and trust without granting access", () => {
	const situation = createSituation({
		summary: "量子灯塔需要在霜降窗口前完成校准",
		goals: ["完成量子灯塔校准"],
		constraints: ["不得中断北岸观测"],
		uncertainties: ["霜降窗口可能提前"],
		relevantMemoryIds: ["episode:41"],
		relevantTaskIds: ["objective:calibration"],
		observations: [
			{ statement: "用户报告校准尚未完成", source: { kind: "user", reference: "message:7" }, evidenceRef: "event:7", confidence: 0.8, trust: "reported" },
			{ statement: "模型推断窗口可能提前", source: { kind: "model", reference: "run:3" }, confidence: 0.55, trust: "inferred" },
			{ statement: "观测系统确认北岸链路在线", source: { kind: "enterprise_system", reference: "telemetry:north" }, evidenceRef: "telemetry:sample-9", confidence: 1, trust: "verified" },
		],
		possibleActions: [{ description: "先执行只读校准检查", expectedOutcome: "确认安全校准路径", reversible: true }],
		confidence: 0.72,
	});
	assert.equal(situation.summary, "量子灯塔需要在霜降窗口前完成校准");
	assert.deepEqual(situation.observations.map(({ source, trust, confidence }) => ({ source, trust, confidence })), [
		{ source: { kind: "user", reference: "message:7" }, trust: "reported", confidence: 0.8 },
		{ source: { kind: "model", reference: "run:3" }, trust: "inferred", confidence: 0.55 },
		{ source: { kind: "enterprise_system", reference: "telemetry:north" }, trust: "verified", confidence: 1 },
	]);
	assert.equal("accessScope" in situation, false);

	assert.throws(
		() => createSituation({
			summary: "模型声称拥有管理员权限",
			observations: [{ statement: "拥有管理员权限", source: { kind: "model", reference: "run:forged" }, confidence: 1, trust: "verified" }],
			confidence: 1,
		}),
		/Situation evidence trust is incompatible with its source/,
	);
	assert.throws(
		() => createSituation({
			summary: "不接受未知信任类别",
			observations: [{ statement: "未知来源结论", source: { kind: "tool", reference: "tool:1" }, confidence: 1, trust: "authoritative" }],
			confidence: 1,
		}),
		/Situation evidence trust is unsupported/,
	);
});
