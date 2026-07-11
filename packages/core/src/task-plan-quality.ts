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
	return /\b(?:edit|delete|commit|push|deploy|publish|install)\b|\b(?:send|email)\s+(?:an?\s+)?(?:email|message|notification)\b|\b(?:execute|run)\s+(?:an?\s+)?(?:command|script)\b|\bcreate\s+(?:an?\s+)?account\b|修改文件|删除|提交代码|推送|部署|发送邮件|发布|安装|执行命令|创建账号/i.test(value);
}

function normalize(value: string): string { return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase(); }
