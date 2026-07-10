import type { AutomationJob, AutomationRun, AutomationStore } from "./store.ts";

export type AutomationExecutor = (job: AutomationJob) => Promise<{ output?: string }>;

export class AutomationScheduler {
	private timer?: ReturnType<typeof setTimeout>;
	private readonly running = new Set<Promise<void>>();
	private stopped = true;
	private readonly store: AutomationStore;
	private readonly execute: AutomationExecutor;
	private readonly maxConcurrent: number;

	constructor(store: AutomationStore, execute: AutomationExecutor, maxConcurrent = 4) {
		this.store = store;
		this.execute = execute;
		this.maxConcurrent = maxConcurrent;
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.schedule(0);
	}

	wake(): void {
		if (this.stopped) return;
		if (this.timer) clearTimeout(this.timer);
		this.schedule(0);
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		await Promise.allSettled([...this.running]);
	}

	private schedule(delay: number): void {
		if (this.stopped) return;
		this.timer = setTimeout(() => void this.tick(), Math.max(0, delay));
	}

	private async tick(): Promise<void> {
		if (this.stopped) return;
		try {
			const capacity = Math.max(0, this.maxConcurrent - this.running.size);
			if (capacity > 0) {
				for (const job of this.store.claimDue(Date.now(), capacity)) this.launch(job);
			}
		} catch (error) {
			console.error(`[beemax] automation scheduler tick failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		const next = this.store.nextDueAt();
		this.schedule(next === undefined ? 30_000 : Math.min(30_000, Math.max(250, next - Date.now())));
	}

	private launch(job: AutomationJob): void {
		const startedAt = Date.now();
		const promise = (async () => {
			let result: Omit<AutomationRun, "id" | "jobId">;
			try {
				const executed = await this.execute(job);
				result = { startedAt, finishedAt: Date.now(), status: "ok", output: executed.output };
			} catch (error) {
				result = {
					startedAt,
					finishedAt: Date.now(),
					status: "error",
					error: error instanceof Error ? error.message : String(error),
				};
			}
			this.store.complete(job, result);
		})().finally(() => {
			this.running.delete(promise);
			this.wake();
		});
		this.running.add(promise);
	}
}
