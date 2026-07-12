import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface InteractionInputQueueStore {
	load(key: string): string[];
	save(key: string, inputs: readonly string[]): void;
}

/** Profile-local crash-safe queue storage. Files are owner-only because inputs contain user text. */
export class FileInteractionInputQueueStore implements InteractionInputQueueStore {
	private readonly queues = new Map<string, string[]>();
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
		if (!existsSync(path)) return;
		try {
			chmodSync(path, 0o600);
			const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			for (const [key, value] of Object.entries(parsed)) {
				if (Array.isArray(value)) this.queues.set(key, value.filter((item): item is string => typeof item === "string").slice(0, 100));
			}
		} catch { /* A corrupt optional queue cannot prevent the Agent from starting. */ }
	}

	load(key: string): string[] { return [...(this.queues.get(key) ?? [])]; }

	save(key: string, inputs: readonly string[]): void {
		if (inputs.length) this.queues.set(key, [...inputs].slice(0, 100));
		else this.queues.delete(key);
		const temporary = `${this.path}.${process.pid}.tmp`;
		writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.queues)), { encoding: "utf8", mode: 0o600 });
		renameSync(temporary, this.path);
		chmodSync(this.path, 0o600);
	}
}
