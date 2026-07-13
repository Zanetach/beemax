const seed = "beemax-unknown-business-v1";
const prefixes = ["Aster", "Vela", "Nori", "Quanta", "Lumen", "Cinder", "Tidal", "Mosaic", "Helio", "Kestrel"];
const suffixes = ["Weave", "Pulse", "Lattice", "Harbor", "Spindle", "Bloom", "Relay", "Prism", "Ledger", "Arc"];
const chinese = ["星潮", "雾桥", "玄羽", "澄镜", "浮光", "云砚", "霜环", "青岚", "月栈", "曜石"];
const nouns = ["协议", "阵列", "窗口", "脉络", "刻度", "航标", "回路", "谱系", "节点", "曲面"];
const actions = [
	{ capability: "web_search", prompt: (term) => `查找公开证据并核验 ${term}，必须保留来源。` },
	{ capability: "document_write", prompt: (term) => `把 ${term} 的结论写入文档并保留修订说明。` },
	{ capability: "meeting_schedule", prompt: (term) => `安排评审会议讨论 ${term}，会前确认参与人。` },
	{ capability: "data_analyze", prompt: (term) => `分析数据：${term} 的波动与异常，并生成可验证图表。` },
	{ capability: "browser_read", prompt: (term) => `读取网页并检查 ${term} 的当前公开状态。` },
	{ capability: "memory_recall", prompt: (term) => `回忆之前约定，找出与 ${term} 有关的已确认决定。` },
];

function seededIndex(index, salt, length) {
	let value = 2166136261;
	for (const char of `${seed}:${index}:${salt}`) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0;
	return value % length;
}

function vocabulary(index) {
	return index % 2 === 0
		? `${prefixes[seededIndex(index, "p", prefixes.length)]}${suffixes[seededIndex(index, "s", suffixes.length)]}-${100 + index}`
		: `${chinese[seededIndex(index, "c", chinese.length)]}${nouns[seededIndex(index, "n", nouns.length)]}-${100 + index}`;
}

const cases = Array.from({ length: 60 }, (_, index) => {
	const term = vocabulary(index);
	const correction = index % 5 === 0;
	const action = actions[index % actions.length];
	const facets = ["random_vocabulary"];
	if (correction) facets.push("correction");
	if (index % 10 === 1) facets.push("conflict");
	if (index % 4 === 2) facets.push("long_running");
	if (index % 12 === 3) facets.push("crash");
	if (index % 12 === 9) facets.push("crash", "side_effect");
	const actionPrompt = `${facets.includes("long_running") ? "这是长期任务，深入研究后继续执行。" : ""}${action.prompt(term)}`;
	const prompt = correction ? `更正：不是旧方案。${actionPrompt}` : actionPrompt;
	return Object.freeze({
		id: `unknown-${String(index + 1).padStart(3, "0")}`,
		term,
		prompt,
		expectedAction: correction ? "correct" : "create",
		expectedCapability: action.capability,
		facets: Object.freeze([...new Set(facets)]),
	});
});

export const unknownBusinessCorpus = Object.freeze({ version: 1, seed, cases: Object.freeze(cases) });
