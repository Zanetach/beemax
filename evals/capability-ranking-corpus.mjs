export const capabilityInventory = Object.freeze([
	{ kind: "tool", name: "web_search", description: "Search current public sources and verify external evidence", aliases: ["联网检索", "公开证据"], triggers: ["research current sources"], exclude: ["不要联网", "do not search online"], version: "eval:1", activeTools: ["web_search"], signals: { inputModalities: ["text"], outputModalities: ["structured"], freshness: "realtime", evidence: "source_receipt", effect: "none", health: "ready", relativeCost: 0.3, expectedLatencyMs: 1200 } },
	{ kind: "mcp", name: "meeting_schedule", description: "Schedule a meeting with participants", aliases: ["安排会议", "book time"], version: "eval:1", activeTools: ["mcp_meeting_schedule"], signals: { inputModalities: ["text"], outputModalities: ["structured"], freshness: "current", evidence: "source_receipt", effect: "external", health: "ready", relativeCost: 0.2, expectedLatencyMs: 800 } },
	{ kind: "tool", name: "memory_recall", description: "Recall confirmed prior decisions and preferences", aliases: ["回忆约定", "之前决定"], version: "eval:1", activeTools: ["memory_recall"], signals: { inputModalities: ["text"], outputModalities: ["text"], freshness: "current", evidence: "verified", effect: "none", health: "ready", relativeCost: 0.1, expectedLatencyMs: 50 } },
	{ kind: "tool", name: "file_read", description: "Read attached or local files", aliases: ["读取文件", "附件内容"], version: "eval:1", activeTools: ["read"], signals: { inputModalities: ["file"], outputModalities: ["text"], freshness: "current", evidence: "source_receipt", effect: "none", health: "ready", relativeCost: 0.1, expectedLatencyMs: 30 } },
	{ kind: "tool", name: "data_analyze", description: "Analyze structured data, anomalies, and metrics", aliases: ["分析数据", "指标异常"], version: "eval:1", activeTools: ["data_analyze"], signals: { inputModalities: ["structured"], outputModalities: ["structured"], freshness: "unknown", evidence: "source_receipt", effect: "none", health: "ready", relativeCost: 0.4, expectedLatencyMs: 1500 } },
]);

export const capabilityRankingCases = Object.freeze([
	{ id: "zh-web", query: "联网检索最新公开证据", expected: "web_search", forbidden: ["memory_recall"] },
	{ id: "en-web", query: "research current sources", expected: "web_search", forbidden: ["file_read"] },
	{ id: "semantic-web-paraphrase", query: "find fresh live public evidence", expected: "web_search", forbidden: ["memory_recall"] },
	{ id: "mixed-web", query: "请 research current sources 验证一下", expected: "web_search", forbidden: ["memory_recall"] },
	{ id: "zh-meeting", query: "安排会议讨论方案", expected: "meeting_schedule", forbidden: ["web_search"] },
	{ id: "en-meeting", query: "book time with the team", expected: "meeting_schedule", forbidden: ["data_analyze"] },
	{ id: "zh-memory", query: "回忆我们之前决定的方案", expected: "memory_recall", forbidden: ["web_search"] },
	{ id: "zh-file", query: "读取文件里的附件内容，不要联网", expected: "file_read", forbidden: ["web_search"] },
	{ id: "zh-data", query: "分析数据并检查指标异常", expected: "data_analyze", forbidden: ["meeting_schedule"] },
	{ id: "negative-chat", query: "你好，介绍一下你自己" },
	{ id: "negative-weak-web", query: "explain how research methods work" },
	{ id: "negative-weak-meeting", query: "summarize the meeting notes already supplied" },
	{ id: "negative-negated-memory", query: "do not recall anything; explain the architecture" },
]);

// Frozen labels exercise the SemanticCapabilityRanker contract deterministically.
// They are not presented as evidence for any concrete embedding Provider.
export const frozenSemanticSimilarities = Object.freeze(Object.fromEntries(capabilityRankingCases.map((scenario) => [scenario.query,
	scenario.expected ? [{ name: scenario.expected, similarity: 0.92, signals: [`gold:${scenario.id}`] }] : [],
])));
