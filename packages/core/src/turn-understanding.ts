export type TurnAction = "create" | "continue" | "correct" | "query" | "cancel";
export type TurnExecutionMode = "direct" | "delegate" | "plan";

export interface TurnUnderstanding {
	action: TurnAction;
	goal: string;
	constraints: string[];
	acceptanceCriteria: string[];
	memoryQuery: string;
	capabilityQuery: string;
	executionMode: TurnExecutionMode;
	confidence: number;
}

export interface TurnUnderstandingInput { activeObjective?: string; }
export interface TurnUnderstandingPort { understand(text: string, input?: TurnUnderstandingInput): TurnUnderstanding; }

/**
 * Deterministic fast path for common Turn routing. Complex semantic understanding remains
 * the model's responsibility, but every downstream subsystem receives one stable envelope.
 */
export class TurnUnderstandingEngine implements TurnUnderstandingPort {
	understand(text: string, input: TurnUnderstandingInput = {}): TurnUnderstanding {
		const goal = text.trim();
		const normalized = goal.normalize("NFKC").toLocaleLowerCase();
		const action = detectAction(normalized, Boolean(input.activeObjective));
		const clauses = goal.split(/[，。；;,.]|\b(?:and|but)\b/iu).map((item) => item.trim()).filter(Boolean);
		const constraints = clauses.filter((item) => /必须|不要|不能|不得|只用|使用|格式|语言|截止|预算|without|must|do not|don't|only|deadline|budget/i.test(item));
		const acceptanceCriteria = clauses.filter((item) => /完成后|发给|发送|交付|生成|保存|上传|发布|after completion|send to|deliver|create|save|upload|publish/i.test(item));
		const independentWork = (normalized.match(/并行|分别|独立|同时|parallel|independently|separately/g) ?? []).length;
		const executionMode: TurnExecutionMode = independentWork >= 2 ? "plan" : /深入研究|深度分析|research deeply|independent research/i.test(normalized) ? "delegate" : "direct";
		return {
			action,
			goal: action === "continue" && input.activeObjective ? input.activeObjective : goal,
			constraints: [...new Set(constraints)],
			acceptanceCriteria: [...new Set(acceptanceCriteria)],
			memoryQuery: goal,
			capabilityQuery: goal,
			executionMode,
			confidence: goal ? (action === "create" ? 0.65 : 0.85) : 0,
		};
	}
}

function detectAction(text: string, hasActiveObjective: boolean): TurnAction {
	if (/取消|停止|终止|cancel|stop|abort/.test(text)) return "cancel";
	if (/不是|改成|更正|纠正|修改为|rather than|change (?:it )?to|correction/.test(text)) return "correct";
	if (hasActiveObjective && /继续|接着|刚才|上一个|之前的|continue|resume|previous|carry on/.test(text)) return "continue";
	if (/^(?:查询|查一下|看看|列出|what|which|show|list|find|search)/.test(text)) return "query";
	return "create";
}

export function renderWorkContext(value: TurnUnderstanding): string {
	return `<beemax-work-context>\n${JSON.stringify(value)}\n</beemax-work-context>`;
}

export function selectTurnTools(query: string, tools: ReadonlyArray<{ name: string; description?: string }>, limit = 3): string[] {
	const normalized = query.normalize("NFKC").toLocaleLowerCase();
	const terms = multilingualLexicalTerms(query);
	return tools.flatMap((tool): Array<{ name: string; score: number }> => {
		if (tool.name === "capability_discover") return [];
		const name = tool.name.toLocaleLowerCase();
		const haystack = `${name} ${tool.description ?? ""}`.normalize("NFKC").toLocaleLowerCase();
		let score = normalized === name ? 100 : normalized.includes(name) ? 60 : 0;
		score += terms.filter((term) => term.length >= 3 && haystack.includes(term)).length * 10;
		return score >= 20 ? [{ name: tool.name, score }] : [];
	}).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, Math.max(1, Math.min(limit, 5))).map(({ name }) => name);
}
import { multilingualLexicalTerms } from "./multilingual-lexical.ts";
