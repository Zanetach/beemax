export interface AdaptiveTextBufferOptions {
	minChunkChars?: number;
	preferredChunkChars?: number;
	maxChunkChars?: number;
	maxWaitMs?: number;
}

/** Converts model token deltas into stable, readable chunks before a channel render. */
export class AdaptiveTextBuffer {
	private pending = "";
	private timer?: ReturnType<typeof setTimeout>;
	private tail = Promise.resolve();
	private closed = false;
	private readonly minChunkChars: number;
	private readonly preferredChunkChars: number;
	private readonly maxChunkChars: number;
	private readonly maxWaitMs: number;
	private readonly onChunk: (chunk: string) => void | Promise<void>;

	constructor(
		onChunk: (chunk: string) => void | Promise<void>,
		options: AdaptiveTextBufferOptions = {},
	) {
		this.onChunk = onChunk;
		this.minChunkChars = options.minChunkChars ?? 12;
		this.preferredChunkChars = Math.max(this.minChunkChars, options.preferredChunkChars ?? 36);
		this.maxChunkChars = Math.max(this.preferredChunkChars, options.maxChunkChars ?? 96);
		this.maxWaitMs = Math.max(50, options.maxWaitMs ?? 1_200);
	}

	push(delta: string): void {
		if (this.closed || !delta) return;
		this.pending += delta;
		const cut = readableCut(this.pending, this.minChunkChars, this.preferredChunkChars, this.maxChunkChars);
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
		this.clearTimer();
		this.tail = this.tail.then(() => this.onChunk(chunk));
	}

	private scheduleMaxWait(): void {
		if (this.timer || this.pending.length < this.minChunkChars || hasUnclosedCodeFence(this.pending)) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (!this.closed && this.pending.length >= this.minChunkChars) this.commit(this.pending.length);
		}, this.maxWaitMs);
	}

	private clearTimer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}

function readableCut(text: string, min: number, preferred: number, max: number): number {
	if (text.length < min || hasUnclosedCodeFence(text)) return 0;
	const boundary = lastBoundary(text);
	if (boundary >= min && (boundary >= preferred || /\n\n$/.test(text.slice(0, boundary)))) return boundary;
	if (text.length < max) return 0;
	const safe = lastBoundary(text.slice(0, max));
	return safe >= min ? safe : max;
}

function lastBoundary(text: string): number {
	for (let index = text.length - 1; index >= 0; index--) {
		if (/[。！？!?；;\n]/u.test(text[index]!)) return index + 1;
	}
	return 0;
}

function hasUnclosedCodeFence(text: string): boolean {
	return (text.match(/```/g)?.length ?? 0) % 2 === 1;
}
