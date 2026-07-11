export interface ProfileTaskSchedulerOptions { maxConcurrent?: number; }
export interface ProfileTaskSchedulerSnapshot { running: number; queued: number; queuedOwners: number; maxConcurrent: number; }

interface ScheduledWork<T> {
	ownerKey: string;
	work: (signal?: AbortSignal) => Promise<T>;
	signal?: AbortSignal;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
	abort?: () => void;
}

/** Profile-wide fair admission control shared by every delegated execution path. */
export class ProfileTaskScheduler {
	private readonly maxConcurrent: number;
	private readonly queues = new Map<string, ScheduledWork<unknown>[]>();
	private readonly owners: string[] = [];
	private running = 0;
	private lastOwner: string | undefined;

	constructor(options: ProfileTaskSchedulerOptions = {}) {
		this.maxConcurrent = Math.min(positiveInt(options.maxConcurrent, 3), 100);
	}

	run<T>(ownerKey: string, work: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (!ownerKey.trim()) return Promise.reject(new Error("Scheduled work owner is required"));
		if (signal?.aborted) return Promise.reject(abortReason(signal));
		return new Promise<T>((resolve, reject) => {
			const item: ScheduledWork<T> = { ownerKey, work, signal, resolve, reject };
			if (signal) {
				item.abort = () => {
					if (!this.remove(item as ScheduledWork<unknown>)) return;
					reject(abortReason(signal));
			};
				signal.addEventListener("abort", item.abort, { once: true });
			}
			const queue = this.queues.get(ownerKey) ?? [];
			if (!this.queues.has(ownerKey)) { this.queues.set(ownerKey, queue); this.owners.push(ownerKey); }
			queue.push(item as ScheduledWork<unknown>);
			this.pump();
		});
	}

	snapshot(): ProfileTaskSchedulerSnapshot {
		return { running: this.running, queued: [...this.queues.values()].reduce((sum, queue) => sum + queue.length, 0), queuedOwners: this.queues.size, maxConcurrent: this.maxConcurrent };
	}

	private pump(): void {
		while (this.running < this.maxConcurrent) {
			const item = this.next();
			if (!item) return;
			item.signal?.removeEventListener("abort", item.abort!);
			this.running++;
			void item.work(item.signal).then(item.resolve, item.reject).finally(() => {
				this.running--;
				this.pump();
			});
		}
	}

	private next(): ScheduledWork<unknown> | undefined {
		if (!this.owners.length) return undefined;
		const start = this.lastOwner ? (this.owners.indexOf(this.lastOwner) + 1) % this.owners.length : 0;
		for (let offset = 0; offset < this.owners.length; offset++) {
			const owner = this.owners[(start + offset) % this.owners.length]!;
			const queue = this.queues.get(owner);
			if (!queue?.length) continue;
			const item = queue.shift()!;
			this.lastOwner = owner;
			if (!queue.length) this.deleteOwner(owner);
			return item;
		}
		return undefined;
	}

	private remove(item: ScheduledWork<unknown>): boolean {
		const queue = this.queues.get(item.ownerKey);
		const index = queue?.indexOf(item) ?? -1;
		if (!queue || index < 0) return false;
		queue.splice(index, 1);
		item.signal?.removeEventListener("abort", item.abort!);
		if (!queue.length) this.deleteOwner(item.ownerKey);
		return true;
	}

	private deleteOwner(owner: string): void {
		this.queues.delete(owner);
		const index = this.owners.indexOf(owner);
		if (index >= 0) this.owners.splice(index, 1);
	}
}

function positiveInt(value: number | undefined, fallback: number): number {
	return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new Error("Scheduled work cancelled");
}
