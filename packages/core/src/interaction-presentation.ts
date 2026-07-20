export interface AdaptiveTextBufferOptions {
	minChunkChars?: number;
	initialPreferredChunkChars?: number;
	preferredChunkChars?: number;
	maxChunkChars?: number;
	initialMaxWaitMs?: number;
	maxWaitMs?: number;
	flushSmallOnMaxWait?: boolean;
}

/** Channel-neutral conversion of token deltas into stable, readable presentation chunks. */
export class AdaptiveTextBuffer {
	private pending = "";
	private timer?: ReturnType<typeof setTimeout>;
	private tail = Promise.resolve();
	private closed = false;
	private codeFenceOpen = false;
	private committedChunks = 0;
	private readonly minChunkChars: number;
	private readonly initialPreferredChunkChars: number;
	private readonly preferredChunkChars: number;
	private readonly maxChunkChars: number;
	private readonly initialMaxWaitMs: number;
	private readonly maxWaitMs: number;
	private readonly flushSmallOnMaxWait: boolean;
	private readonly onChunk: (chunk: string) => void | Promise<void>;

	constructor(onChunk: (chunk: string) => void | Promise<void>, options: AdaptiveTextBufferOptions = {}) {
		this.onChunk = onChunk;
		this.minChunkChars = options.minChunkChars ?? 12;
		this.preferredChunkChars = Math.max(this.minChunkChars, options.preferredChunkChars ?? 36);
		this.initialPreferredChunkChars = Math.max(this.minChunkChars, options.initialPreferredChunkChars ?? this.preferredChunkChars);
		this.maxChunkChars = Math.max(this.initialPreferredChunkChars, this.preferredChunkChars, options.maxChunkChars ?? 96);
		this.maxWaitMs = Math.max(50, options.maxWaitMs ?? 1_200);
		this.initialMaxWaitMs = Math.max(50, options.initialMaxWaitMs ?? this.maxWaitMs);
		this.flushSmallOnMaxWait = options.flushSmallOnMaxWait ?? false;
	}

	push(delta: string): void {
		if (this.closed || !delta) return;
		this.pending += delta;
		const preferredChunkChars = this.committedChunks === 0 ? this.initialPreferredChunkChars : this.preferredChunkChars;
		const cut = readableCut(this.pending, this.minChunkChars, preferredChunkChars, this.maxChunkChars, this.codeFenceOpen);
		if (cut > 0) this.commit(cut);
		if (this.pending) this.scheduleMaxWait();
	}

	async flush(): Promise<void> {
		this.clearTimer();
		if (this.pending) this.commit(this.pending.length);
		await this.tail;
	}

	async close(): Promise<void> {
		if (this.closed) return this.tail;
		this.closed = true;
		await this.flush();
	}

	private commit(length: number): void {
		const chunk = this.pending.slice(0, length);
		this.pending = this.pending.slice(length);
		if (!chunk) return;
		if ((chunk.match(/```/g)?.length ?? 0) % 2 === 1) this.codeFenceOpen = !this.codeFenceOpen;
		this.committedChunks++;
		this.clearTimer();
		this.tail = this.tail.then(() => this.onChunk(chunk));
	}

	private scheduleMaxWait(): void {
		if (this.timer || (!this.flushSmallOnMaxWait && this.pending.length < this.minChunkChars)) return;
		const waitMs = this.committedChunks === 0 ? this.initialMaxWaitMs : this.maxWaitMs;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (!this.closed && this.pending.length && (this.flushSmallOnMaxWait || this.pending.length >= this.minChunkChars)) this.commit(this.pending.length);
		}, waitMs);
	}

	private clearTimer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}

export interface TurnStatusPulseOptions { thresholdsMs?: number[]; repeatMs?: number; }

/** Emits truthful elapsed-time states for any interactive presenter. */
export class TurnStatusPulse {
	private timer?: ReturnType<typeof setTimeout>;
	private startedAt = 0;
	private stopped = false;
	private contentVisible = false;
	private thresholdIndex = 0;
	private readonly thresholdsMs: number[];
	private readonly repeatMs: number;
	private readonly onStatus: (message: string, elapsedMs: number) => void | Promise<void>;
	private tail = Promise.resolve();
	private failure?: unknown;

	constructor(onStatus: (message: string, elapsedMs: number) => void | Promise<void>, options: TurnStatusPulseOptions = {}) {
		this.onStatus = onStatus;
		this.thresholdsMs = (options.thresholdsMs ?? [3_000, 10_000, 30_000, 60_000]).filter((value) => value > 0).sort((a, b) => a - b);
		this.repeatMs = Math.max(1_000, options.repeatMs ?? 30_000);
	}

	start(): Promise<void> {
		if (this.startedAt) return this.tail;
		this.startedAt = Date.now();
		const presented = this.emit("已收到 · 正在理解需求", 0);
		this.scheduleNext();
		return presented;
	}

	contentStarted(): void {
		if (this.stopped || this.contentVisible) return;
		this.contentVisible = true;
		this.clearTimer();
		this.emit("正在组织回答", Date.now() - this.startedAt);
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.clearTimer();
		await this.tail;
		if (this.failure !== undefined) throw this.failure;
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
			this.emit(current >= 30_000 ? `模型响应较慢 · 已等待 ${seconds} 秒，连接正常` : `等待模型响应 · ${seconds} 秒`, current);
			if (this.thresholdIndex < this.thresholdsMs.length) this.thresholdIndex++;
			this.scheduleNext();
		}, Math.max(0, target - elapsed));
	}

	private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }

	private emit(message: string, elapsedMs: number): Promise<void> {
		this.tail = this.tail.then(() => this.onStatus(message, elapsedMs)).catch((error: unknown) => { if (this.failure === undefined) this.failure = error; });
		return this.tail;
	}
}

function readableCut(text: string, min: number, preferred: number, max: number, codeFenceOpen: boolean): number {
	if (text.length < min) return 0;
	if (codeFenceOpen || hasUnclosedCodeFence(text)) {
		const newline = text.lastIndexOf("\n") + 1;
		if (newline >= min) return newline;
		return text.length >= max ? max : 0;
	}
	const boundary = lastBoundary(text);
	if (boundary >= min && (boundary >= preferred || /\n\n$/.test(text.slice(0, boundary)))) return boundary;
	if (text.length < max) return 0;
	const safe = lastBoundary(text.slice(0, max));
	return safe >= min ? safe : max;
}

function lastBoundary(text: string): number {
	for (let index = text.length - 1; index >= 0; index--) if (/[。！？!?；;\n]/u.test(text[index]!)) return index + 1;
	return 0;
}

function hasUnclosedCodeFence(text: string): boolean { return (text.match(/```/g)?.length ?? 0) % 2 === 1; }
