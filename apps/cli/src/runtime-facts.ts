import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConversationContext, redactCredentialMaterial, responsibilityOwnerKeys, type ConversationContextOptions, type ConversationMemoryPort, type TaskLedger } from "@thruvera/core";
import type { TaskFactRecord } from "@thruvera/memory";
import { thruveraRoot } from "./config.ts";

export interface RuntimeFactSnapshot {
	model?: string;
	profile?: string;
}

export interface TaskAwareConversationOptions extends ConversationContextOptions {
	runtimeSnapshot?: () => RuntimeFactSnapshot;
}

const BUILTIN_TASKS: Array<Pick<TaskFactRecord, "id" | "title" | "status" | "evidence" | "completedAt">> = [
	{ id: "upgrade-preview-13", title: "Upgrade Thruvera to v0.1.0-preview.13", status: "done", evidence: "tag:v0.1.0-preview.13", completedAt: 1783728719000 },
	{ id: "anthropic-protocol", title: "Support Anthropic Messages protocol", status: "done", evidence: "tag:v0.1.0-preview.15", completedAt: 1783729196000 },
];

/** Populate documented release facts once, without overwriting user-managed task state. */
type BuiltinTaskStore = { hasTask(id: string): boolean; upsertTask(task: Pick<TaskFactRecord, "id" | "title" | "status"> & { evidence?: string; completedAt?: number }): void };
type TaskFactReader = Pick<TaskLedger, "queryTasks">;
type TaskAwareMemory = ConversationMemoryPort & BuiltinTaskStore & TaskFactReader;

export function ensureBuiltinTasks(store: BuiltinTaskStore): void {
	for (const task of BUILTIN_TASKS) if (!store.hasTask(task.id)) store.upsertTask(task);
}

/** One app-level composition point prevents an ingress path from omitting task facts. */
export function createTaskAwareConversationContext(memory: TaskAwareMemory, options: TaskAwareConversationOptions = {}): ConversationContext {
	ensureBuiltinTasks(memory);
	const { runtimeSnapshot, ...contextOptions } = options;
	return new ConversationContext(memory, { ...contextOptions, runtimeFacts: (source, text, verified) => taskLedgerContextForQuestion(memory, text, { ...runtimeSnapshot?.(), ...verified }, [...responsibilityOwnerKeys(source), "profile"]) });
}

/** Only task or version questions receive a snapshot; ordinary chat stays unchanged. */
export function taskLedgerContextForQuestion(store: TaskFactReader, text: string, snapshot: RuntimeFactSnapshot = {}, ownerKeys = ["profile"]): string {
	const namesTaskDomain = /(挂起|待办|任务|进度|升级|更新|协议|anthropic|release|task|todo|upgrade|update|protocol)/iu.test(text);
	const asksTaskStatus = /(?:哪些|还有|当前|查看|列出|多少).{0,24}(?:挂起|待办|任务|进度|升级|更新|协议)|(?:挂起|待办|任务|进度|升级|更新|协议).{0,24}(?:哪些|还有|状态|进度|是否完成|完成了吗|完成了没|呢|吗|\?|？)|\b(?:what|which|show|list)\b.{0,40}\b(?:release|task|todo|upgrade|update|protocol)s?\b|\b(?:release|task|todo|upgrade|update|protocol)s?\b.{0,40}\b(?:status|progress|pending|outstanding|shipped|completed|complete|done)\b|\b(?:was|were|has|have)\b.{0,60}\b(?:shipped|completed|done)\b/iu.test(text);
	const asksTasks = namesTaskDomain && asksTaskStatus;
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
			: tasks.map((task) => `- ${compactFact(task.id, 120)}: ${task.status}; kind=${task.kind}; ${compactFact(task.title, 240)}${task.evidence ? `; evidence=${compactFact(task.evidence, 240)}` : ""}${task.finishedAt ? `; finished_at=${new Date(task.finishedAt).toISOString()}` : ""}`)));
	}
	lines.push("[/Current runtime facts]");
	return lines.join("\n");
}

function compactFact(value: string, limit: number): string {
	return redactCredentialMaterial(value).replace(/\s+/gu, " ").trim().slice(0, limit);
}

/** Prefer the checked-out release description; release installs fall back to package metadata. */
export function installedVersion(root = thruveraRoot()): string {
	const described = spawnSync("git", ["describe", "--tags", "--always", "--dirty"], { cwd: root, encoding: "utf8", timeout: 1_000 });
	if (described.status === 0 && described.stdout.trim()) return described.stdout.trim();
	try {
		const released = readFileSync(join(root, "RELEASE_VERSION"), "utf8").trim();
		if (released) return released;
	} catch { /* Source checkouts may not have a release manifest. */ }
	try { return `package:${JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version}`; } catch { return "unavailable"; }
}
