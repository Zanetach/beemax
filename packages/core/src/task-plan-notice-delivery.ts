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
	deliverObjective?: (notice: TaskPlanCompletionNotice) => Promise<{ status: "succeeded" | "failed" | "cancelled"; result?: string; error?: string } | undefined>;
	onProgress?: (event: TaskPlanProgressEvent, notice: TaskPlanCompletionNotice) => void | Promise<void>;
	onCycle?: (result: TaskPlanNoticeDeliveryResult) => void; onError?: (error: unknown) => void;
}
export type TaskPlanNoticeOutbox = Required<Pick<TaskLedger, "claimTaskPlanCompletionNotices" | "completeTaskPlanCompletionNotice" | "failTaskPlanCompletionNotice">>;

/** Delivers durable, result-free background Plan summaries through a channel-neutral port. */
export class TaskPlanNoticeDeliveryService {
	private readonly outbox: TaskPlanNoticeOutbox;
	private readonly delivery: Pick<DeliveryPort, "sendText">;
	private readonly options: TaskPlanNoticeDeliveryOptions;
	private readonly intervalMs: number;
	private readonly batchSize: number;
	private active?: Promise<TaskPlanNoticeDeliveryResult>;
	private timer?: ReturnType<typeof setTimeout>;
	private stopped = true;

	constructor(outbox: TaskPlanNoticeOutbox, delivery: Pick<DeliveryPort, "sendText">, options: TaskPlanNoticeDeliveryOptions) {
		this.outbox = outbox; this.delivery = delivery; this.options = options;
		this.intervalMs = Math.max(1_000, Math.trunc(options.intervalMs ?? 30_000));
		this.batchSize = Math.max(1, Math.min(Math.trunc(options.batchSize ?? 10), 50));
	}

	async runOnce(now = Date.now()): Promise<TaskPlanNoticeDeliveryResult> {
		if (this.active) return this.active;
		const cycle = this.deliverBatch(now);
		this.active = cycle;
		try { return await cycle; }
		finally { if (this.active === cycle) this.active = undefined; }
	}

	start(): void { if (!this.stopped) return; this.stopped = false; this.schedule(0); }
	async stop(): Promise<void> { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; try { await this.active; } catch { /* surfaced through onError */ } }

	private async deliverBatch(now: number): Promise<TaskPlanNoticeDeliveryResult> {
		const notices = this.outbox.claimTaskPlanCompletionNotices(this.options.platform, now, this.batchSize);
		const summary = { claimed: notices.length, delivered: 0, failed: 0 };
		for (const notice of notices) {
			try {
				if (this.options.deliverObjective) {
					const objective = await this.options.deliverObjective(notice);
					if (objective && notice.planStatus === "succeeded") {
						if (objective.status !== "succeeded" || !objective.result?.trim()) throw new Error(objective.error || `Objective delivery failed for Task Plan ${notice.planId}`);
						await this.delivery.sendText(notice.target, objective.result);
						if (!notice.claimToken || !this.outbox.completeTaskPlanCompletionNotice(notice.id, notice.claimToken)) throw new Error(`Task Plan Completion Notice acknowledgement failed: ${notice.id}`);
						summary.delivered++;
						continue;
					}
				}
				const progress: TaskPlanProgressEvent = {
					type: "work.changed", workId: notice.planId, kind: "task_plan",
					state: notice.planStatus === "succeeded" ? "completed" : notice.planStatus,
					title: notice.title, completed: notice.succeeded, total: notice.taskCount, failed: notice.failed, cancelled: notice.cancelled, at: now,
				};
				if (this.options.onProgress) await this.options.onProgress(progress, notice);
				else await this.delivery.sendText(notice.target, renderTaskPlanCompletionNotice(notice));
				if (!notice.claimToken || !this.outbox.completeTaskPlanCompletionNotice(notice.id, notice.claimToken)) throw new Error(`Task Plan Completion Notice acknowledgement failed: ${notice.id}`);
				summary.delivered++;
			} catch { if (notice.claimToken) this.outbox.failTaskPlanCompletionNotice(notice.id, notice.claimToken, now); summary.failed++; }
		}
		return summary;
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
