import type { DeliveryPort } from "./delivery-port.ts";
import type { TaskLedger, TaskPlanCompletionNotice } from "./task-ledger.ts";
import { sanitizeDisplayText } from "./display-text.ts";

export interface TaskPlanNoticeDeliveryResult { claimed: number; delivered: number; failed: number; }
export interface TaskPlanProgressEvent {
	type: "work.changed"; workId: string; kind: "task_plan"; state: "completed" | "failed" | "cancelled";
	title: string; completed: number; total: number; failed: number; cancelled: number; at: number;
}
export interface TaskPlanNoticeDeliveryOptions {
	platform: string; intervalMs?: number; batchSize?: number;
	leaseMs?: number; leaseHeartbeatMs?: number; maxAttempts?: number; deliveryConcurrency?: number; shutdownGraceMs?: number;
	deliverObjective?: (notice: TaskPlanCompletionNotice, signal?: AbortSignal) => Promise<{ status: "succeeded" | "failed" | "cancelled"; result?: string; error?: string } | undefined>;
	onProgress?: (event: TaskPlanProgressEvent, notice: TaskPlanCompletionNotice) => void | Promise<void>;
	onCycle?: (result: TaskPlanNoticeDeliveryResult) => void; onError?: (error: unknown) => void;
}
export type TaskPlanNoticeOutbox = Required<Pick<TaskLedger, "claimTaskPlanCompletionNotices" | "completeTaskPlanCompletionNotice" | "failTaskPlanCompletionNotice">> & Partial<Pick<TaskLedger, "renewTaskPlanCompletionNotice" | "abandonTaskPlanCompletionNotice">>;

/** Delivers durable Objective results or terminal Plan progress through a channel-neutral port. */
export class TaskPlanNoticeDeliveryService {
	private readonly outbox: TaskPlanNoticeOutbox;
	private readonly delivery: Pick<DeliveryPort, "sendText">;
	private readonly options: TaskPlanNoticeDeliveryOptions;
	private readonly intervalMs: number;
	private readonly batchSize: number;
	private readonly leaseMs: number;
	private readonly leaseHeartbeatMs: number;
	private readonly maxAttempts: number;
	private readonly deliveryConcurrency: number;
	private readonly shutdownGraceMs: number;
	private readonly controllers = new Set<AbortController>();
	private active?: Promise<TaskPlanNoticeDeliveryResult>;
	private timer?: ReturnType<typeof setTimeout>;
	private stopped = true;

	constructor(outbox: TaskPlanNoticeOutbox, delivery: Pick<DeliveryPort, "sendText">, options: TaskPlanNoticeDeliveryOptions) {
		this.outbox = outbox; this.delivery = delivery; this.options = options;
		this.intervalMs = Math.max(1_000, Math.trunc(options.intervalMs ?? 30_000));
		this.batchSize = Math.max(1, Math.min(Math.trunc(options.batchSize ?? 10), 50));
		this.leaseMs = Math.max(100, Math.trunc(options.leaseMs ?? 20 * 60_000));
		this.leaseHeartbeatMs = Math.max(10, Math.min(Math.trunc(options.leaseHeartbeatMs ?? 60_000), Math.trunc(this.leaseMs / 2)));
		this.maxAttempts = Math.max(1, Math.min(Math.trunc(options.maxAttempts ?? 10), 100));
		this.deliveryConcurrency = Math.max(1, Math.min(Math.trunc(options.deliveryConcurrency ?? 2), 10));
		this.shutdownGraceMs = Math.max(0, Math.min(Math.trunc(options.shutdownGraceMs ?? 30_000), 5 * 60_000));
	}

	async runOnce(now = Date.now()): Promise<TaskPlanNoticeDeliveryResult> {
		if (this.active) return this.active;
		const cycle = this.deliverBatch(now);
		this.active = cycle;
		try { return await cycle; }
		finally { if (this.active === cycle) this.active = undefined; }
	}

	start(): void { if (!this.stopped) return; this.stopped = false; this.schedule(0); }
	async stop(): Promise<void> {
		this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined;
		for (const controller of this.controllers) if (!controller.signal.aborted) controller.abort(new Error("Task Plan notice delivery stopped"));
		if (!this.active) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try { await Promise.race([this.active, new Promise<void>((resolve) => { timer = setTimeout(resolve, this.shutdownGraceMs); })]); }
		catch { /* surfaced through onError */ }
		finally { if (timer) clearTimeout(timer); }
	}

	private async deliverBatch(now: number): Promise<TaskPlanNoticeDeliveryResult> {
		const notices = this.outbox.claimTaskPlanCompletionNotices(this.options.platform, now, this.batchSize, this.leaseMs);
		const summary = { claimed: notices.length, delivered: 0, failed: 0 };
		let cursor = 0;
		const workers = Array.from({ length: Math.min(this.deliveryConcurrency, notices.length) }, async () => {
			while (cursor < notices.length) {
				const notice = notices[cursor++]!;
				if (await this.deliverNotice(notice, now)) summary.delivered++; else summary.failed++;
			}
		});
		await Promise.all(workers);
		return summary;
	}

	private async deliverNotice(notice: TaskPlanCompletionNotice, now: number): Promise<boolean> {
			const controller = new AbortController();
			this.controllers.add(controller);
			let objectiveOutcome: { status: "succeeded" | "failed" | "cancelled"; result?: string; error?: string } | undefined;
			const heartbeat = notice.claimToken && this.outbox.renewTaskPlanCompletionNotice ? setInterval(() => {
				if (!this.outbox.renewTaskPlanCompletionNotice?.(notice.id, notice.claimToken!, Date.now() + this.leaseMs)) controller.abort(new Error(`Task Plan Completion Notice lease lost: ${notice.id}`));
			}, this.leaseHeartbeatMs) : undefined;
			heartbeat?.unref();
			try {
				if (this.options.deliverObjective) {
					const objective = await this.options.deliverObjective(notice, controller.signal);
					objectiveOutcome = objective;
					if (controller.signal.aborted) throw controller.signal.reason;
					if (objective && notice.planStatus === "succeeded") {
						if (objective.status === "succeeded" && objective.result?.trim()) {
							await this.delivery.sendText(notice.target, objective.result, { idempotencyKey: notice.id });
							if (!notice.claimToken || !this.outbox.completeTaskPlanCompletionNotice(notice.id, notice.claimToken)) throw new Error(`Task Plan Completion Notice acknowledgement failed: ${notice.id}`);
							return true;
						}
						if (objective.status !== "cancelled") throw new Error(objective.error || `Objective delivery failed for Task Plan ${notice.planId}`);
					}
				}
				const progress: TaskPlanProgressEvent = {
					type: "work.changed", workId: notice.planId, kind: "task_plan",
					state: objectiveOutcome?.status === "cancelled" ? "cancelled" : notice.planStatus === "succeeded" ? "completed" : notice.planStatus,
					title: notice.title, completed: notice.succeeded, total: notice.taskCount, failed: notice.failed, cancelled: notice.cancelled, at: now,
				};
				if (this.options.onProgress) await this.options.onProgress(progress, notice);
				else await this.delivery.sendText(notice.target, renderTaskPlanCompletionNotice(notice), { idempotencyKey: notice.id });
				if (!notice.claimToken || !this.outbox.completeTaskPlanCompletionNotice(notice.id, notice.claimToken)) throw new Error(`Task Plan Completion Notice acknowledgement failed: ${notice.id}`);
				return true;
			} catch (error) {
				if (notice.claimToken) {
					if (notice.attempts >= this.maxAttempts) this.outbox.abandonTaskPlanCompletionNotice?.(notice.id, notice.claimToken, error instanceof Error ? error.message : String(error), now) ?? this.outbox.completeTaskPlanCompletionNotice(notice.id, notice.claimToken);
					else this.outbox.failTaskPlanCompletionNotice(notice.id, notice.claimToken, now);
				}
				if (notice.attempts >= this.maxAttempts) this.options.onError?.(error);
				return false;
			} finally { if (heartbeat) clearInterval(heartbeat); this.controllers.delete(controller); }
	}

	private schedule(delay: number): void {
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.runOnce().then((result) => this.options.onCycle?.(result)).catch((error) => this.options.onError?.(error)).finally(() => { if (!this.stopped) this.schedule(this.intervalMs); });
		}, delay);
		this.timer.unref?.();
	}
}

export function renderTaskPlanCompletionNotice(notice: TaskPlanCompletionNotice): string {
	const title = sanitizeDisplayText(notice.title, 120);
	const planId = sanitizeDisplayText(notice.planId, 128);
	return `Task Plan completed: ${title} [${notice.planStatus}]\nProgress: succeeded=${notice.succeeded}; failed=${notice.failed}; cancelled=${notice.cancelled}; total=${notice.taskCount}\nDetails: /tasks show ${planId}`;
}
