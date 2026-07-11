import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface BoundedJsonlJournalOptions<T> {
	path: string;
	limit: number;
	minLimit: number;
	maxLimit: number;
	isRecord: (value: T) => boolean;
	onCompacting?: (records: T[]) => void;
}

/** Shared secure, bounded JSONL persistence primitive for content-free operational records. */
export class BoundedJsonlJournal<T> {
	private readonly path: string;
	private readonly limit: number;
	private readonly isRecord: (value: T) => boolean;
	private readonly onCompacting?: (records: T[]) => void;
	private lineCount: number;

	constructor(options: BoundedJsonlJournalOptions<T>) {
		this.path = options.path;
		this.limit = Math.max(options.minLimit, Math.min(options.limit, options.maxLimit));
		this.isRecord = options.isRecord;
		this.onCompacting = options.onCompacting;
		mkdirSync(dirname(this.path), { recursive: true });
		if (existsSync(this.path)) chmodSync(this.path, 0o600);
		this.lineCount = this.lines().length;
	}

	append(record: T): void {
		appendFileSync(this.path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
		this.lineCount++;
		if (this.lineCount <= this.limit) return;
		const records = this.readAll();
		this.onCompacting?.(records);
		const retained = records.slice(-Math.max(1, Math.floor(this.limit * 0.8)));
		writeFileSync(this.path, retained.length ? `${retained.map((item) => JSON.stringify(item)).join("\n")}\n` : "", { encoding: "utf8", mode: 0o600 });
		this.lineCount = retained.length;
	}

	records(): T[] { return this.readAll().slice(-this.limit); }

	private readAll(): T[] {
		return this.lines().flatMap((line) => {
			try { const value = JSON.parse(line) as T; return this.isRecord(value) ? [value] : []; }
			catch { return []; }
		});
	}

	private lines(): string[] {
		if (!existsSync(this.path)) return [];
		try { return readFileSync(this.path, "utf8").split("\n").filter((line) => line.trim()); }
		catch { return []; }
	}
}
