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
	private closed = false;
	private lastFlushAt = 0;
	private readonly intervalMs: number;

	constructor(intervalMs: number) {
		this.intervalMs = intervalMs;
	}

	schedule(renderUpdate: RenderUpdate, terminal = false): Promise<void> {
		if (this.closed && !terminal) return this.task ?? Promise.resolve();
		this.latestRender = renderUpdate;
		if (this.task) {
			this.pending = true;
			this.pendingTerminal = this.pendingTerminal || terminal;
			return this.task;
		}
		this.pending = false;
		this.pendingTerminal = terminal;
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
	}

	private async run(): Promise<void> {
		try {
			for (;;) {
				const terminal = this.pendingTerminal;
				if (!terminal) {
					const delay = this.intervalMs - (Date.now() - this.lastFlushAt);
					if (delay > 0) await sleep(delay);
				}
				const render = this.latestRender;
				if (!render) return;
				this.pending = false;
				this.pendingTerminal = false;
				await render();
				this.lastFlushAt = Date.now();
				if (terminal || !this.pending) return;
			}
		} finally {
			this.task = null;
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
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
