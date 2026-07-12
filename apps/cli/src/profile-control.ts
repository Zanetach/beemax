import { parseInteractionCommand, sanitizeDisplayText, type AgentControlHandler, type InteractionEventAdapter, type ProfileTaskSchedulerSnapshot, type TaskPlanRecord, type TaskPlanRetryResult, type TaskRecord, type TaskVerificationRetryResult } from "@beemax/core";
import type { SessionSource } from "@beemax/gateway";
import type { BeeMaxAgentRuntime } from "@beemax/core";
import type { BeeMaxConfig } from "./config.ts";
import { configureModel } from "./profile-config.ts";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProfileModelCatalog } from "./model-catalog.ts";

export interface TaskRecoveryStatus { phase: "disabled" | "running" | "completed" | "failed"; plans: number; succeeded: number; failed: number; blocked: number; verification: TaskVerificationRetryResult; }
export interface ProfileOperationalFacts { taskScheduler?: ProfileTaskSchedulerSnapshot; taskRecovery?: TaskRecoveryStatus; }
export interface ProfileControlActions {
	verifyTaskPlan?: (source: SessionSource, planId: string) => Promise<{ attempted: number; accepted: number; rejected: number; unavailable: number }>;
	retryTaskPlan?: (source: SessionSource, planId: string, objectiveId?: string) => Promise<TaskPlanRetryResult>;
	cancelTaskPlan?: (source: SessionSource, planId: string) => { active: number; tasks: number };
	resumeTaskPlan?: (source: SessionSource, planId: string) => Promise<{ plans: number; succeeded: number; failed: number; cancelled: number; blocked: string[] }>;
}

export function renderTaskSchedulerStatus(snapshot?: ProfileTaskSchedulerSnapshot): string {
	if (!snapshot) return "Tasks: scheduler unavailable";
	const current = snapshot.currentConcurrent ?? snapshot.maxConcurrent;
	const reductions = snapshot.overloadReductions ?? 0;
	return `Tasks: running=${snapshot.running}; queued=${snapshot.queued}; queued-owners=${snapshot.queuedOwners}; capacity=${current}/${snapshot.maxConcurrent}; overload-reductions=${reductions}`;
}

export function renderTaskRecoveryStatus(status?: TaskRecoveryStatus): string {
	return status ? `Recovery: ${status.phase}; plans=${status.plans}; succeeded=${status.succeeded}; failed=${status.failed}; blocked=${status.blocked}; verification=${status.verification.attempted}/${status.verification.accepted}/${status.verification.rejected}/${status.verification.unavailable}` : "Recovery: unavailable";
}

export function renderTaskPlans(plans: readonly TaskPlanRecord[]): string {
	return plans.map((plan) => {
		const completed = plan.succeeded + plan.failed + plan.cancelled;
		return `${sanitizeDisplayText(plan.id, 128)}  [${plan.status}]  ${sanitizeDisplayText(plan.title, 120)} · progress=${completed}/${plan.taskCount} · verified=${plan.verified} · corrections=${plan.correctiveAttempts}`;
	}).join("\n") || "No durable Task Plans are visible to this conversation.";
}

export function renderTasks(tasks: readonly TaskRecord[]): string {
	return tasks.length ? tasks.map((task) => {
		const quality = task.verificationStatus ? ` [quality:${task.verificationStatus === "accepted" ? "verified" : task.verificationStatus}${task.correctiveAttempts ? ` corrections=${task.correctiveAttempts}` : ""}${task.verificationAttempts ? ` verify-attempts=${task.verificationAttempts}` : ""}${task.verificationRetryAt ? ` retry=${new Date(task.verificationRetryAt).toISOString()}` : ""}]` : "";
		return `${sanitizeDisplayText(task.id, 160)}  [${task.kind}/${task.status}]${task.planId ? ` [plan:${sanitizeDisplayText(task.planId, 128)}]` : ""}${quality}  ${sanitizeDisplayText(task.title, 120)}`;
	}).join("\n") : "No durable Tasks are visible to this conversation.";
}

export function renderTaskPlanDetails(plan: TaskPlanRecord, tasks: readonly TaskRecord[]): string {
	const details = tasks.map((task) => [
		renderTasks([task]),
		task.result !== undefined ? `  Result: ${sanitizeDisplayText(task.result, 1_000)}` : undefined,
		task.evidence !== undefined ? `  Evidence: ${sanitizeDisplayText(task.evidence, 500)}` : undefined,
		task.error !== undefined ? `  Error: ${sanitizeDisplayText(task.error, 500)}` : undefined,
	].filter((line): line is string => Boolean(line)).join("\n")).join("\n");
	return `${renderTaskPlans([plan])}${details ? `\n${details}` : ""}`;
}

export function renderTaskPlanNotFound(planId: string): string { return `Task Plan not found or not visible: ${sanitizeDisplayText(planId, 128)}.`; }

export function renderTaskPlanRetryResult(planId: string, result: TaskPlanRetryResult): string {
	const verification = result.verification;
	if (!verification.attempted && !result.prepared) return `No recoverable failed Tasks or unavailable Candidate Results found in owned Plan ${planId}.`;
	return `Retried Task Plan ${planId}: verification attempted=${verification.attempted}; accepted=${verification.accepted}; rejected=${verification.rejected}; unavailable=${verification.unavailable}; execution prepared=${result.prepared}; succeeded=${result.succeeded}; failed=${result.failed}; blocked=${result.blocked.length}.`;
}

/** Profile control plane shared by local chat and every Gateway channel. */
export function createProfileControlHandler(
	runtime: BeeMaxAgentRuntime<SessionSource>,
	config: BeeMaxConfig,
	interaction?: InteractionEventAdapter<SessionSource>,
	operationalFacts?: () => ProfileOperationalFacts,
	actions?: ProfileControlActions,
): AgentControlHandler<SessionSource> {
	return async ({ source, text }) => {
		const models = new ProfileModelCatalog(config);
		const command = text.trim().toLowerCase();
		if (command === "/new" || command === "/reset") {
			if (command === "/reset") {
				if (interaction) await interaction.dispatch({ type: "session.reset", source }); else runtime.reset(source);
			}
			const nextSource = { ...source, threadId: `conversation-${crypto.randomUUID()}` };
			if (interaction) await interaction.dispatch({ type: "session.open", source: nextSource }); else await runtime.open(nextSource);
			return { handled: true, nextSource, message: `${command === "/reset" ? "Reset and started" : "Started"} new session: ${nextSource.threadId}` };
		}
		if (command === "/sessions") {
			const sessions = await runtime.listSavedSessions(source);
			return { handled: true, message: sessions.length ? sessions.map((session) => `${session.threadId ?? "default"}  ${new Date(session.lastUsedAt).toLocaleString()}`).join("\n") : "No saved sessions." };
		}
		if (command === "/skills") {
			try {
				const entries = await readdir(join(config.paths.agentDir, "skills"), { withFileTypes: true });
				const skills = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
					const content = await readFile(join(config.paths.agentDir, "skills", entry.name, "SKILL.md"), "utf8").catch(() => "");
					const description = content.match(/^description:\s*(.+)$/m)?.[1]?.replaceAll('"', "").trim();
					return description ? `${entry.name}  ${description}` : undefined;
				}));
				return { handled: true, message: skills.filter((skill): skill is string => Boolean(skill)).sort().join("\n") || "No Profile Skills installed." };
			} catch { return { handled: true, message: "No Profile Skills installed." }; }
		}
		const resume = text.trim().match(/^\/resume\s+([^\s]+)$/i);
		if (resume) {
			const nextSource = resume[1] === "default" ? { ...source, threadId: undefined } : { ...source, threadId: resume[1] };
			if (!await runtime.hasSavedSession(nextSource)) return { handled: true, message: `Unknown session '${resume[1]}'. Use /sessions to list saved sessions.` };
			if (interaction) await interaction.dispatch({ type: "session.open", source: nextSource }); else await runtime.open(nextSource);
			return { handled: true, nextSource, message: `Restored session: ${nextSource.threadId ?? "default"}.` };
		}
		const history = command.match(/^\/history(?:\s+(\d{1,3}))?$/);
		if (history) {
			const entries = await runtime.history(source, history[1] ? Number(history[1]) : undefined);
			return { handled: true, message: entries.length ? entries.map((entry) => `[${entry.role}] ${entry.text.replaceAll("\n", " ")}`).join("\n") : "No live message history." };
		}
		if (command === "/help") return { handled: true, message: "Commands: /help /status /usage /continue /retry /compact /sessions /resume <id> /history [n] /skills /tasks [plans|show|verify|retry|cancel <plan-id>] /new /reset /model [provider/model] [--global] /stop\nCLI also supports local display, tool, and retry controls." };
		if (command === "/status" || command === "/usage") {
			const [model, usage] = await Promise.all([runtime.modelStatus(source), runtime.usage(source)]);
			const usageText = usage ? `input=${usage.inputTokens}; output=${usage.outputTokens}; context=${usage.contextTokens ?? "?"}/${usage.contextWindow ?? "?"}` : "no live session";
			const facts = operationalFacts?.();
			const objective = runtime.tasks(source, { kind: "objective", status: "running", limit: 1 })[0]
				?? runtime.tasks(source, { kind: "objective", status: "pending", limit: 1 })[0]
				?? runtime.tasks(source, { kind: "objective", limit: 1 })[0];
			const objectiveText = objective ? `Objective: [${objective.status}] ${sanitizeDisplayText(objective.title, 120)}` : "Objective: none";
			return { handled: true, message: command === "/usage" ? `Usage: ${usageText}` : `Profile: ${config.profile}\nModel: ${model?.model ?? `${config.model.provider}/${config.model.model}`}\nThinking: ${model?.thinkingLevel ?? "off"}\nRun: ${runtime.isBusy() ? "running" : "idle"}\n${objectiveText}\n${renderTaskSchedulerStatus(facts?.taskScheduler)}\n${renderTaskRecoveryStatus(facts?.taskRecovery)}\nUsage: ${usageText}` };
		}
		if (command === "/compact") {
			const compacted = interaction
				? await interaction.dispatch({ type: "session.compact", source })
				: { compacted: await runtime.compact(source) };
			return { handled: true, message: "compacted" in compacted && compacted.compacted ? "Context compacted." : "No idle session is available to compact." };
		}
		if (command === "/continue" || command === "/retry") {
			const objective = command === "/retry"
				? runtime.tasks(source, { kind: "objective", status: "failed", limit: 1 })[0]
				: runtime.tasks(source, { kind: "objective", status: "running", limit: 1 })[0]
					?? runtime.tasks(source, { kind: "objective", status: "pending", limit: 1 })[0]
					?? runtime.tasks(source, { kind: "objective", limit: 1 })[0];
			if (!objective) return { handled: true, message: "No durable Objective is available." };
			const child = runtime.tasks(source, { parentId: objective.id, limit: 1 }).find((task) => task.planId);
			if (!child?.planId) return { handled: true, message: `Objective ${objective.id} has no resumable Task Plan.` };
			if (command === "/retry") {
				if (!actions?.retryTaskPlan) return { handled: true, message: "Objective retry is unavailable in this runtime." };
				return { handled: true, message: renderTaskPlanRetryResult(child.planId, await actions.retryTaskPlan(source, child.planId, objective.id)) };
			}
			const plan = runtime.taskPlans(source, { id: child.planId, limit: 1 })[0];
			if (plan?.pausedAt && actions?.resumeTaskPlan) {
				const resumed = await actions.resumeTaskPlan(source, child.planId);
				return { handled: true, message: `Continued Objective ${objective.id}: plans=${resumed.plans}; blocked=${resumed.blocked.length}.` };
			}
			return { handled: true, message: `Objective: [${objective.status}] ${sanitizeDisplayText(objective.title, 120)}${plan ? `; Task Plan: [${plan.status}] ${plan.id}` : ""}.` };
		}
		const taskCommand = parseInteractionCommand(text);
		if (taskCommand?.kind === "tasks" && taskCommand.action === "plans") return { handled: true, message: renderTaskPlans(runtime.taskPlans(source, { limit: 200 })) };
		if (taskCommand?.kind === "tasks" && taskCommand.action === "show" && taskCommand.planId) {
			const plan = runtime.taskPlans(source, { id: taskCommand.planId, limit: 1 })[0];
			if (!plan) return { handled: true, message: renderTaskPlanNotFound(taskCommand.planId) };
			return { handled: true, message: renderTaskPlanDetails(plan, runtime.tasks(source, { planId: taskCommand.planId, limit: 100 })) };
		}
		if (taskCommand?.kind === "tasks" && taskCommand.action === "verify" && taskCommand.planId) {
			if (!actions?.verifyTaskPlan) return { handled: true, message: "Task Plan Verification Retry is unavailable in this runtime." };
			const result = await actions.verifyTaskPlan(source, taskCommand.planId);
			return { handled: true, message: result.attempted ? `Verified Candidate Results for Plan ${taskCommand.planId}: attempted=${result.attempted}; accepted=${result.accepted}; rejected=${result.rejected}; unavailable=${result.unavailable}.` : `No unavailable Candidate Results found in owned Plan ${taskCommand.planId}.` };
		}
		if (taskCommand?.kind === "tasks" && taskCommand.action === "retry" && taskCommand.planId) {
			if (!actions?.retryTaskPlan) return { handled: true, message: "Task Plan retry is unavailable in this runtime." };
			const result = await actions.retryTaskPlan(source, taskCommand.planId);
			return { handled: true, message: renderTaskPlanRetryResult(taskCommand.planId, result) };
		}
		if (taskCommand?.kind === "tasks" && taskCommand.action === "cancel" && taskCommand.planId) {
			if (!actions?.cancelTaskPlan) return { handled: true, message: "Task Plan cancellation is unavailable in this runtime." };
			const result = actions.cancelTaskPlan(source, taskCommand.planId);
			return { handled: true, message: result.active || result.tasks ? `Cancelled Task Plan ${taskCommand.planId}: active=${result.active}; tasks=${result.tasks}.` : `No active or queued Tasks found in owned Plan ${taskCommand.planId}.` };
		}
		if (command === "/tasks") {
			const tasks = runtime.tasks(source, { limit: 50 });
			return { handled: true, message: renderTasks(tasks) };
		}
		if (!command.startsWith("/model")) return undefined;
		const global = /\s--global\s*$/i.test(text);
		const requested = text.trim().slice("/model".length).replace(/\s--global\s*$/i, "").trim();
		if (!requested) {
			const current = await runtime.modelStatus(source);
			return { handled: true, message: `Profile default: ${config.model.provider}/${config.model.model}\nSession model: ${current?.model ?? "not loaded"}\nThinking: ${current?.thinkingLevel ?? "not loaded"}${current ? ` (supported: ${current.supportedThinkingLevels.join(", ")})` : ""}\nConfigured: ${models.list().map((entry) => entry.key).join(", ")}` };
		}
		const selected = models.resolve(requested);
		if (!selected) return { handled: true, message: `Model is not configured for this Profile. Available: ${models.list().map((entry) => entry.key).join(", ")}` };
		if (!selected.runtimeModel) return { handled: true, message: `Pi does not have a runtime model definition for ${requested}. Configure it as a supported Provider model first.` };
		if (!await runtime.setModel(source, selected.runtimeModel)) {
			return { handled: true, message: "No idle Agent session exists yet, or the Agent is busy. Try again after the current turn." };
		}
		const choice = config.models.find((item) => `${item.provider}/${item.model}` === selected.key)!;
		config.model = { ...choice, apiKey: config.model.apiKeys[choice.provider], apiKeys: config.model.apiKeys };
		if (global) {
			await configureModel(config.profile, { provider: choice.provider, model: choice.model, baseUrl: choice.baseUrl, customProtocol: choice.customProtocol });
			return { handled: true, message: `Switched this conversation to ${requested} and saved it as the Profile default.` };
		}
		return { handled: true, message: `Switched this conversation to ${requested}.` };
	};
}
