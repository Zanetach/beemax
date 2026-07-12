export interface ProfileTaskSchedulerOptions { maxConcurrent?: number; adaptive?: boolean; increaseAfterSuccesses?: number; maxQueued?: number; maxQueuedPerOwner?: number; }
export interface ProfileTaskSchedulerSnapshot { running: number; queued: number; queuedOwners: number; maxConcurrent: number; currentConcurrent: number; overloadReductions: number; }

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
	private readonly adaptive: boolean;
	private readonly increaseAfterSuccesses: number;
	private readonly maxQueued: number;
	private readonly maxQueuedPerOwner: number;
	private queued = 0;
	private readonly queues = new Map<string, ScheduledWork<unknown>[]>();
	private readonly owners: string[] = [];
	private running = 0;
	private lastOwner: string | undefined;
	private currentConcurrent: number;
	private consecutiveSuccesses = 0;
	private overloadReductions = 0;

	constructor(options: ProfileTaskSchedulerOptions = {}) {
		this.maxConcurrent = Math.min(positiveInt(options.maxConcurrent, 3), 100);
		this.currentConcurrent = this.maxConcurrent;
		this.adaptive = options.adaptive ?? true;
		this.increaseAfterSuccesses = positiveInt(options.increaseAfterSuccesses, 4);
		this.maxQueued = positiveInt(options.maxQueued, 1_000);
		this.maxQueuedPerOwner = Math.min(this.maxQueued, positiveInt(options.maxQueuedPerOwner, 100));
	}

	run<T>(ownerKey: string, work: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (!ownerKey.trim()) return Promise.reject(new Error("Scheduled work owner is required"));
		if (signal?.aborted) return Promise.reject(abortReason(signal));
		const existing = this.queues.get(ownerKey)?.length ?? 0;
		if (this.queued >= this.maxQueued || existing >= this.maxQueuedPerOwner) return Promise.reject(new Error("Profile task queue is full; retry later"));
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
			this.queued++;
			this.pump();
		});
	}

	snapshot(): ProfileTaskSchedulerSnapshot {
		return { running: this.running, queued: this.queued, queuedOwners: this.queues.size, maxConcurrent: this.maxConcurrent, currentConcurrent: this.currentConcurrent, overloadReductions: this.overloadReductions };
	}

	private pump(): void {
		while (this.running < this.currentConcurrent) {
			const item = this.next();
			if (!item) return;
			item.signal?.removeEventListener("abort", item.abort!);
			this.running++;
			void item.work(item.signal).then((value) => {
				this.recordSuccess();
				item.resolve(value);
			}, (error) => {
				this.recordFailure(error);
				item.reject(error);
			}).finally(() => {
				this.running--;
				this.pump();
			});
		}
	}

	private recordSuccess(): void {
		if (!this.adaptive || this.currentConcurrent >= this.maxConcurrent) return;
		this.consecutiveSuccesses++;
		if (this.consecutiveSuccesses < this.increaseAfterSuccesses) return;
		this.currentConcurrent++;
		this.consecutiveSuccesses = 0;
	}

	private recordFailure(error: unknown): void {
		this.consecutiveSuccesses = 0;
		if (!this.adaptive || !isOverloadFailure(error)) return;
		const reduced = Math.max(1, Math.floor(this.currentConcurrent / 2));
		if (reduced === this.currentConcurrent) return;
		this.currentConcurrent = reduced;
		this.overloadReductions++;
	}

	private next(): ScheduledWork<unknown> | undefined {
		if (!this.owners.length) return undefined;
		const start = this.lastOwner ? (this.owners.indexOf(this.lastOwner) + 1) % this.owners.length : 0;
		for (let offset = 0; offset < this.owners.length; offset++) {
			const owner = this.owners[(start + offset) % this.owners.length]!;
			const queue = this.queues.get(owner);
			if (!queue?.length) continue;
			const item = queue.shift()!;
			this.queued--;
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
		this.queued--;
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

function isOverloadFailure(error: unknown): boolean {
	const candidate = error as { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown } | undefined;
	const status = Number(candidate?.status ?? candidate?.statusCode);
	if (status === 429 || status === 503 || status === 502 || status === 504) return true;
	const code = String(candidate?.code ?? "").toUpperCase();
	if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN"].includes(code)) return true;
	return /rate.?limit|too many requests|overload|temporar(?:y|ily) unavailable|service unavailable/i.test(String(candidate?.message ?? error ?? ""));
}
