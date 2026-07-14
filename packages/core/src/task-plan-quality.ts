export interface TaskPlanQualityInput {
	title: string;
	goal: string;
	acceptanceCriteria: string;
}

export interface TaskPlanQualityResult { accepted: boolean; issues: string[]; }

/** Deterministic semantic quality gate applied before a model-authored Plan is persisted. */
export function assessTaskPlanQuality(tasks: readonly TaskPlanQualityInput[]): TaskPlanQualityResult {
	const issues: string[] = [];
	const titles = new Set<string>();
	for (const [index, task] of tasks.entries()) {
		const number = index + 1;
		const title = normalize(task.title);
		if (titles.has(title)) issues.push(`Task ${number} duplicates another Task title: ${title}`);
		else titles.add(title);
		if (requiresMutation(task.goal)) issues.push(`Task ${number} goal requires mutating capability unavailable to isolated Sub-Agents`);
		if (!observableCriteria(task.acceptanceCriteria)) issues.push(`Task ${number} acceptance criteria must describe observable evidence`);
	}
	return { accepted: issues.length === 0, issues };
}

function observableCriteria(value: string): boolean {
	const normalized = normalize(value);
	if (normalized.length < 8) return false;
	return !/^(?:done|complete|completed|works|working|finished|ok|完成|做好|可用|正常)[.!。！]?$/.test(normalized);
}

function requiresMutation(value: string): boolean {
	const mutation = /\b(?:edit|delete|commit|push|deploy|publish|install)\b|\bwrite\s+(?:(?:the|an?|final)\s+)?(?:files?\b|[^.;。；!?！？\n]{1,80}\b(?:to|into)\s+(?:(?:the|an?)\s+)?(?:file|disk|workspace)\b)|\b(?:send|email)\s+(?:an?\s+)?(?:email|message|notification)\b|\b(?:execute|run)\s+(?:an?\s+)?(?:command|script)\b|\bcreate\s+(?:an?\s+)?account\b|修改文件|写入文件|写文件|保存(?:到|至)(?:文件|磁盘|工作区)|删除|提交代码|推送|部署|发送邮件|发布|安装|执行命令|创建账号/gi;
	for (const match of value.matchAll(mutation)) {
		if (isContentModifier(value, match)) continue;
		const clause = value.slice(clauseStart(value, match.index ?? 0), match.index).trim();
		if (!/(?:\b(?:do\s+not|don't|must\s+not|never|no\s+need\s+to)\b|不要|不得|无需|禁止)[^.;。；!?！？\n]*$/i.test(clause)) return true;
	}
	return false;
}

/** Distinguish content attributes from requests to perform the named mutation. */
function isContentModifier(value: string, match: RegExpMatchArray): boolean {
	const index = match.index ?? 0;
	if (match[0]?.toLowerCase() === "publish") {
		if (/^publish-ready\b/i.test(value.slice(index))) return true;
		if (/\bready(?:\s*-\s*|\s+)to(?:\s*-\s*|\s+)$/i.test(value.slice(Math.max(0, index - 32), index))) return true;
	}
	return match[0] === "发布" && /(?:可(?:直接)?|待)$/.test(value.slice(Math.max(0, index - 3), index));
}

function clauseStart(value: string, index: number): number {
	const boundary = Math.max(value.lastIndexOf(".", index - 1), value.lastIndexOf(";", index - 1), value.lastIndexOf("。", index - 1), value.lastIndexOf("；", index - 1), value.lastIndexOf("!", index - 1), value.lastIndexOf("！", index - 1), value.lastIndexOf("?", index - 1), value.lastIndexOf("？", index - 1), value.lastIndexOf("\n", index - 1));
	return boundary + 1;
}

function normalize(value: string): string { return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase(); }
