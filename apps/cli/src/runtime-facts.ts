import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConversationContext, conversationKey, conversationOwnerKey, type ConversationContextOptions } from "@beemax/core";
import type { MemoryStore, TaskFactRecord } from "@beemax/memory";
import { beemaxRoot } from "./config.ts";

export interface RuntimeFactSnapshot {
	model?: string;
	profile?: string;
}

export interface TaskAwareConversationOptions extends ConversationContextOptions {
	runtimeSnapshot?: () => RuntimeFactSnapshot;
}

const BUILTIN_TASKS: Array<Pick<TaskFactRecord, "id" | "title" | "status" | "evidence" | "completedAt">> = [
	{ id: "upgrade-preview-13", title: "Upgrade BeeMax to v0.1.0-preview.13", status: "done", evidence: "tag:v0.1.0-preview.13", completedAt: 1783728719000 },
	{ id: "anthropic-protocol", title: "Support Anthropic Messages protocol", status: "done", evidence: "tag:v0.1.0-preview.15", completedAt: 1783729196000 },
];

/** Populate documented release facts once, without overwriting user-managed task state. */
export function ensureBuiltinTasks(store: MemoryStore): void {
	for (const task of BUILTIN_TASKS) if (!store.hasTask(task.id)) store.upsertTask(task);
}

/** One app-level composition point prevents an ingress path from omitting task facts. */
export function createTaskAwareConversationContext(memory: MemoryStore, options: TaskAwareConversationOptions = {}): ConversationContext {
	ensureBuiltinTasks(memory);
	const { runtimeSnapshot, ...contextOptions } = options;
	return new ConversationContext(memory, { ...contextOptions, runtimeFacts: (source, text, verified) => taskLedgerContextForQuestion(memory, text, { ...runtimeSnapshot?.(), ...verified }, [...new Set([conversationKey(source), conversationOwnerKey(source), "profile"])]) });
}

/** Only task or version questions receive a snapshot; ordinary chat stays unchanged. */
export function taskLedgerContextForQuestion(store: MemoryStore, text: string, snapshot: RuntimeFactSnapshot = {}, ownerKeys = ["profile"]): string {
	const asksTasks = /(挂起|待办|任务|进度|完成|已过|升级|更新|协议|anthropic|release|task|todo|pending|outstanding|shipped|completed|complete|upgrade|update|protocol)/iu.test(text);
	const asksVersion = /(版本|版本号|version|release)/iu.test(text);
	const asksModel = /(什么模型|哪个模型|当前模型|使用.*模型|模型.*是什么|what model|which model|model.*using)/iu.test(text);
	if (!asksTasks && !asksVersion && !asksModel) return "";
	const lines = ["[Current runtime facts: chat history is not authoritative.]", `- observed_at=${new Date().toISOString()}`];
	if (asksVersion) lines.push(`- installed_version=${installedVersion()}`);
	if (asksModel && snapshot.model) lines.push(`- current_model=${snapshot.model}`);
	if (asksModel && snapshot.profile) lines.push(`- current_profile=${snapshot.profile}`);
	if (asksTasks) {
		const tasks = store.queryTasks({ ownerKeys, limit: 50 });
		lines.push(...(tasks.length === 0
			? ["- task_ledger=empty; do not infer task status from chat history"]
			: tasks.map((task) => `- ${task.id}: ${task.status}; kind=${task.kind}; ${task.title}${task.evidence ? `; evidence=${task.evidence}` : ""}${task.finishedAt ? `; finished_at=${new Date(task.finishedAt).toISOString()}` : ""}`)));
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
