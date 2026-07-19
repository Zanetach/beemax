export const adaptiveTurnAdmissionCases = Object.freeze([
	{ id: "model-first-explain-zh", request: "解释合同驱动", mode: "interactive", expectedBasis: "raw_prompt", expectedPlanningMode: "direct" },
	{ id: "model-first-unknown-en", request: "Why is idempotency useful?", mode: "interactive", expectedBasis: "raw_prompt", expectedPlanningMode: "direct" },
	{ id: "model-first-comparison", request: "Compare idempotency with deduplication conceptually without external sources.", mode: "interactive", expectedBasis: "raw_prompt", expectedPlanningMode: "direct" },
	{ id: "model-first-current-query", request: "What happened in the gold market yesterday? State clearly if current evidence is unavailable.", mode: "interactive", expectedBasis: "raw_prompt", expectedPlanningMode: "direct" },
	{ id: "model-first-artifact-intent", request: "调研过去一周黄金走势，说明应如何输出 HTML 和 PDF 文件；没有工具时明确说明限制。", mode: "interactive", expectedBasis: "raw_prompt", expectedPlanningMode: "direct" },
	{ id: "durable-automation", request: "解释幂等性的含义", mode: "automation", expectedBasis: "work_contract", expectedPlanningMode: "direct" },
]);
