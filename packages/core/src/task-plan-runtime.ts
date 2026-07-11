/** Profile-wide registry for the live AbortController of each Task Plan. */
export class TaskPlanRuntime {
	private readonly active = new Map<string, AbortController>();

	async run<T>(ownerKey: string, planId: string, parentSignal: AbortSignal | undefined, execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const key = taskPlanKey(ownerKey, planId);
		if (this.active.has(key)) throw new Error(`Task Plan is already running: ${planId}`);
		const controller = new AbortController();
		const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
		this.active.set(key, controller);
		try { return await execute(signal); }
		finally { this.active.delete(key); }
	}

	cancel(ownerKeys: string[], planId: string): number {
		let cancelled = 0;
		for (const ownerKey of ownerKeys) {
			const controller = this.active.get(taskPlanKey(ownerKey, planId));
			if (!controller || controller.signal.aborted) continue;
			controller.abort(new Error(`Task Plan cancelled: ${planId}`));
			cancelled++;
		}
		return cancelled;
	}

	snapshot(): { active: number } { return { active: this.active.size }; }
}

function taskPlanKey(ownerKey: string, planId: string): string {
	if (!ownerKey.trim() || !planId.trim()) throw new Error("Task Plan owner and id are required");
	return `${ownerKey}\0${planId}`;
}
