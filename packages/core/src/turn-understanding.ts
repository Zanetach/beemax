import { rankCapabilityIndex, type RankableCapability } from "./capability-ranking.ts";
import { explicitlyForbidsDelegation } from "./delegation-boundary.ts";

export type TurnAction = "create" | "continue" | "correct" | "query" | "cancel";
export type TurnExecutionMode = "direct" | "delegate" | "plan";

export interface TurnUnderstanding {
	action: TurnAction;
	goal: string;
	constraints: string[];
	acceptanceCriteria: string[];
	uncertainties?: string[];
	memoryQuery: string;
	capabilityQuery: string;
	executionMode: TurnExecutionMode;
	confidence: number;
}

export interface TurnUnderstandingInput {
	activeObjective?: string;
}
export interface TurnUnderstandingPort { understand(text: string, input?: TurnUnderstandingInput): TurnUnderstanding; }
const PREFETCH_MIN_CONFIDENCE = 0.5;

/**
 * Deterministic fast path for common Turn routing. Complex semantic understanding remains
 * the model's responsibility, but every downstream subsystem receives one stable envelope.
 */
export class TurnUnderstandingEngine implements TurnUnderstandingPort {
	understand(text: string, input: TurnUnderstandingInput = {}): TurnUnderstanding {
		const goal = text.trim();
		const normalized = goal.normalize("NFKC").toLocaleLowerCase();
		const action = detectAction(normalized, Boolean(input.activeObjective));
		const clauses = goal.split(/[，。；;,]|\b(?:and|but)\b/iu).map((item) => item.trim()).filter(Boolean);
		const constraints = clauses.filter((item) => /必须|不要|不能|不得|无需|不必|只用|只需|仅|使用|格式|语言|截止|预算|without|must|do not|don't|never|only|no need|deadline|budget/i.test(item));
		const acceptanceCriteria = clauses.filter((item) => /完成后|发给|发送|交付|生成|保存|上传|发布|after completion|send to|deliver|create|save|upload|publish/i.test(item) && !forbidsDeliveryAction(item));
		const requestsParallelExecution = /并行|并发|\bparallel(?:ize|ly)?\b|\bconcurrent(?:ly)?\b|(?:分别|同时)(?:调研|研究|分析|处理|执行|完成|制作|生成|核验|验证)|\b(?:independently|separately)\s+(?:research|investigate|analy[sz]e|process|execute|complete|build|create|verify)\b/iu.test(normalized);
		const executionMode: TurnExecutionMode = explicitlyForbidsDelegation(normalized)
			? "direct"
			: requestsParallelExecution
				? "plan"
				: /深入研究|深度分析|research deeply|independent research/i.test(normalized) ? "delegate" : "direct";
		const resolvedGoal = action === "continue" && input.activeObjective ? input.activeObjective : goal;
		const resolvedQuery = action === "continue" && input.activeObjective ? `${input.activeObjective} ${goal}` : goal;
		return {
			action,
			goal: resolvedGoal,
			constraints: [...new Set(constraints)],
			acceptanceCriteria: [...new Set(acceptanceCriteria)],
			uncertainties: [],
			memoryQuery: resolvedQuery,
			capabilityQuery: resolvedQuery,
			executionMode,
			confidence: goal ? (action === "create" ? 0.65 : 0.85) : 0,
		};
	}
}

function detectAction(text: string, hasActiveObjective: boolean): TurnAction {
	const actionable = withoutNegatedCommands(text);
	if (/取消|停止|终止|cancel|stop|abort/.test(actionable)) return "cancel";
	if (/改成|更正|纠正|修改为|修正(?:为|成|一下|之前|当前|这个|它)|rather than|change (?:it )?to|correction/.test(actionable)) return "correct";
	if (hasActiveObjective && /继续|接着|刚才|上一个|之前的|continue|resume|previous|carry on/.test(actionable)) return "continue";
	if (/^(?:查询|查一下|看看|列出|解释|说明|介绍|为什么|为何|怎么|如何|什么是|what|which|why|how|explain|describe|show|list|find|search)/i.test(actionable)) return "query";
	const leadingIntent = actionable.split(/[。；;.!?？]/, 1)[0] ?? actionable;
	if (/(?:解释|说明|介绍|explain|describe)/i.test(leadingIntent) && !/(?:制作|生成|创建|编写|写入|保存|发送|发布|上传|create|generate|write|save|send|publish|upload)/i.test(leadingIntent)) return "query";
	return "create";
}

function withoutNegatedCommands(text: string): string {
	return text
		.replace(/(?:不要|不能|不得|无需|不必|不是(?:要)?)(?:再)?(?:取消|停止|终止|更改|修改|改动)[^，。；;,.]*/giu, "")
		.replace(/(?:do not|don't|must not|never)\s+(?:cancel|stop|abort|change|correct|modify)\b[^,.;]*/giu, "")
		.trim();
}

function forbidsDeliveryAction(clause: string): boolean {
	return /(?:不要|不能|不得|无需|不必|禁止)[^，。；;,.]*(?:发给|发送|交付|生成|保存|上传|发布)|(?:do not|don't|must not|never|without|no need to)[^,.;]*(?:send|deliver|create|save|upload|publish)/iu.test(clause);
}

export function renderWorkContext(value: TurnUnderstanding): string {
	return `<beemax-work-context>\n${JSON.stringify(value)}\n</beemax-work-context>`;
}

export function selectTurnTools(query: string, tools: ReadonlyArray<RankableCapability>, limit = 3): string[] {
	const boundedLimit = Math.max(1, Math.min(limit, 5));
	const eligible = tools.filter((tool) => !["capability_discover", "bash"].includes(tool.name.normalize("NFKC").toLocaleLowerCase()));
	return rankCapabilityIndex(query, eligible, boundedLimit).filter((match) => match.confidence >= PREFETCH_MIN_CONFIDENCE).map(({ item }) => item.name);
}
