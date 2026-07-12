/**
 * Flush controller: coalesces rapid card updates into throttled renders.
 * Ported from flush.py. Instead of updating the Feishu card on every text
 * delta (which would hit the 5 QPS patch limit), it batches updates on an
 * interval and drains immediately for terminal events (completed/failed).
 */

export type RenderUpdate = () => Promise<boolean>;

export class FlushController {
	private task: Promise<void> | null = null;
	private latestRender: RenderUpdate | null = null;
	private pending = false;
	private pendingTerminal = false;
	private pendingUrgent = false;
	private closed = false;
	private lastFlushAt = 0;
	private readonly intervalMs: number;
	private readonly urgentIntervalMs: number;
	private delayTimer?: ReturnType<typeof setTimeout>;
	private resolveDelay?: () => void;

	constructor(intervalMs: number, urgentIntervalMs = 250) {
		this.intervalMs = Math.max(0, intervalMs);
		this.urgentIntervalMs = Math.min(this.intervalMs, Math.max(0, urgentIntervalMs));
	}

	schedule(renderUpdate: RenderUpdate, terminal = false, urgent = false): Promise<void> {
		if (this.closed) return this.task ?? Promise.resolve();
		this.latestRender = renderUpdate;
		if (this.task) {
			this.pending = true;
			this.pendingTerminal = this.pendingTerminal || terminal;
			this.pendingUrgent = this.pendingUrgent || urgent;
			if (terminal || urgent) this.interruptDelay();
			return this.task;
		}
		this.pending = false;
		this.pendingTerminal = terminal;
		this.pendingUrgent = urgent;
		this.task = this.run();
		return this.task;
	}

	async drain(timeoutMs: number): Promise<boolean> {
		const task = this.task;
		if (!task) return true;
		try {
			await withTimeout(task, timeoutMs);
			return true;
		} catch {
			return false;
		}
	}

	close(): void {
		this.closed = true;
		this.pending = false;
		this.pendingTerminal = false;
		this.pendingUrgent = false;
		this.latestRender = null;
		if (this.delayTimer) clearTimeout(this.delayTimer);
		this.delayTimer = undefined;
		this.resolveDelay?.();
		this.resolveDelay = undefined;
	}

	private async run(): Promise<void> {
		try {
			for (;;) {
				let terminal = this.pendingTerminal;
				let urgent = this.pendingUrgent;
				let delay = (terminal || urgent ? this.urgentIntervalMs : this.intervalMs) - (Date.now() - this.lastFlushAt);
				if (delay > 0) await this.wait(delay);
				if (this.closed) return;
				terminal = this.pendingTerminal;
				urgent = this.pendingUrgent;
				delay = (terminal || urgent ? this.urgentIntervalMs : this.intervalMs) - (Date.now() - this.lastFlushAt);
				if (delay > 0) await this.wait(delay);
				const render = this.latestRender;
				if (!render) return;
				this.pending = false;
				this.pendingTerminal = false;
				this.pendingUrgent = false;
				await render();
				this.lastFlushAt = Date.now();
				if (!this.pending) return;
			}
		} finally {
			this.task = null;
		}
	}

	private wait(ms: number): Promise<void> {
		return new Promise((resolve) => {
			this.resolveDelay = resolve;
			this.delayTimer = setTimeout(() => {
				this.delayTimer = undefined;
				this.resolveDelay = undefined;
				resolve();
			}, ms);
		});
	}

	private interruptDelay(): void {
		if (this.delayTimer) clearTimeout(this.delayTimer);
		this.delayTimer = undefined;
		this.resolveDelay?.();
		this.resolveDelay = undefined;
	}
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("timeout")), ms);
		p.then(
			(v) => { clearTimeout(t); resolve(v); },
			(e) => { clearTimeout(t); reject(e); },
		);
	});
}
