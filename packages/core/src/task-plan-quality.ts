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
		if (!observableCriteria(task.acceptanceCriteria)) issues.push(`Task ${number} acceptance criteria must describe observable evidence`);
	}
	return { accepted: issues.length === 0, issues };
}

function observableCriteria(value: string): boolean {
	const normalized = normalize(value);
	if (normalized.length < 8) return false;
	return !/^(?:done|complete|completed|works|working|finished|ok|完成|做好|可用|正常)[.!。！]?$/.test(normalized);
}

function normalize(value: string): string { return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase(); }
