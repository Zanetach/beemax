import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConversationContext, type ConversationContextOptions } from "@beemax/core";
import type { MemoryStore, TaskRecord } from "@beemax/memory";
import { beemaxRoot } from "./config.ts";

const BUILTIN_TASKS: Array<Pick<TaskRecord, "id" | "title" | "status" | "evidence" | "completedAt">> = [
	{ id: "upgrade-preview-13", title: "Upgrade BeeMax to v0.1.0-preview.13", status: "done", evidence: "tag:v0.1.0-preview.13", completedAt: 1783728719000 },
	{ id: "anthropic-protocol", title: "Support Anthropic Messages protocol", status: "done", evidence: "tag:v0.1.0-preview.15", completedAt: 1783729196000 },
];

/** Populate documented release facts once, without overwriting user-managed task state. */
export function ensureBuiltinTasks(store: MemoryStore): void {
	const existing = new Set(store.listTasks().map((task) => task.id));
	for (const task of BUILTIN_TASKS) if (!existing.has(task.id)) store.upsertTask(task);
}

/** One app-level composition point prevents an ingress path from omitting task facts. */
export function createTaskAwareConversationContext(memory: MemoryStore, options: ConversationContextOptions = {}): ConversationContext {
	ensureBuiltinTasks(memory);
	return new ConversationContext(memory, { ...options, runtimeFacts: (text) => taskLedgerContextForQuestion(memory, text) });
}

/** Only task or version questions receive a snapshot; ordinary chat stays unchanged. */
export function taskLedgerContextForQuestion(store: MemoryStore, text: string): string {
	const asksTasks = /(挂起|待办|任务|进度|完成|已过|升级|更新|协议|anthropic|release|task|todo|pending|outstanding|shipped|completed|complete|upgrade|update|protocol)/iu.test(text);
	const asksVersion = /(版本|版本号|version|release)/iu.test(text);
	if (!asksTasks && !asksVersion) return "";
	const lines = ["[Current runtime facts: chat history is not authoritative.]", `- observed_at=${new Date().toISOString()}`];
	if (asksVersion) lines.push(`- installed_version=${installedVersion()}`);
	if (asksTasks) {
		const tasks = store.listTasks();
		lines.push(...(tasks.length === 0
			? ["- task_ledger=empty; do not infer task status from chat history"]
			: tasks.map((task) => `- ${task.id}: ${task.status}; ${task.title}${task.evidence ? `; evidence=${task.evidence}` : ""}${task.completedAt ? `; completed_at=${new Date(task.completedAt).toISOString()}` : ""}`)));
	}
	lines.push("[/Current runtime facts]");
	return lines.join("\n");
}

/** Prefer the checked-out release description; release installs fall back to package metadata. */
export function installedVersion(root = beemaxRoot()): string {
	const described = spawnSync("git", ["describe", "--tags", "--always", "--dirty"], { cwd: root, encoding: "utf8", timeout: 1_000 });
	if (described.status === 0 && described.stdout.trim()) return described.stdout.trim();
	try {
		const released = readFileSync(join(root, "RELEASE_VERSION"), "utf8").trim();
		if (released) return released;
	} catch { /* Source checkouts may not have a release manifest. */ }
	try { return `package:${JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version}`; } catch { return "unavailable"; }
}
