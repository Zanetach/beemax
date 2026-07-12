export interface TurnStatusPulseOptions {
	thresholdsMs?: number[];
	repeatMs?: number;
}

/** Emits truthful elapsed-time waiting states independently from model output. */
export class TurnStatusPulse {
	private timer?: ReturnType<typeof setTimeout>;
	private startedAt = 0;
	private stopped = false;
	private contentVisible = false;
	private thresholdIndex = 0;
	private readonly thresholdsMs: number[];
	private readonly repeatMs: number;
	private readonly onStatus: (message: string, elapsedMs: number) => void | Promise<void>;

	constructor(onStatus: (message: string, elapsedMs: number) => void | Promise<void>, options: TurnStatusPulseOptions = {}) {
		this.onStatus = onStatus;
		this.thresholdsMs = (options.thresholdsMs ?? [3_000, 10_000, 30_000, 60_000]).filter((value) => value > 0).sort((a, b) => a - b);
		this.repeatMs = Math.max(1_000, options.repeatMs ?? 30_000);
	}

	start(): void {
		if (this.startedAt) return;
		this.startedAt = Date.now();
		void this.onStatus("已收到 · 正在理解需求", 0);
		this.scheduleNext();
	}

	contentStarted(): void {
		if (this.stopped || this.contentVisible) return;
		this.contentVisible = true;
		this.clearTimer();
		void this.onStatus("正在组织回答", Date.now() - this.startedAt);
	}

	stop(): void {
		this.stopped = true;
		this.clearTimer();
	}

	private scheduleNext(): void {
		if (this.stopped || !this.startedAt) return;
		const elapsed = Date.now() - this.startedAt;
		const target = this.thresholdsMs[this.thresholdIndex] ?? elapsed + this.repeatMs;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.stopped) return;
			const current = Date.now() - this.startedAt;
			const seconds = Math.max(1, Math.round(current / 1_000));
			void this.onStatus(current >= 30_000 ? `模型响应较慢 · 已等待 ${seconds} 秒，连接正常` : `等待模型响应 · ${seconds} 秒`, current);
			if (this.thresholdIndex < this.thresholdsMs.length) this.thresholdIndex++;
			this.scheduleNext();
		}, Math.max(0, target - elapsed));
	}

	private clearTimer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}
