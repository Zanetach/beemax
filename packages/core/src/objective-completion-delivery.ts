import { DeliveryDeferredError, type DeliveryPort } from "./delivery-port.ts";
import { createHash } from "node:crypto";
import type { AgentScope } from "./agent-scope.ts";
import type { ObjectiveCompletion, TaskLedger } from "./task-ledger.ts";

const OBJECTIVE_COMPLETION_PREFIX = "objective-completion:";
export function objectiveCompletionId(objectiveId: string): string {
	const normalized = objectiveId.trim();
	if (!normalized) throw new Error("Objective identity is required for Completion Outbox identity");
	return `${OBJECTIVE_COMPLETION_PREFIX}${normalized}`;
}
export function objectiveIdFromCompletionId(completionId: string): string | undefined {
	return completionId.startsWith(OBJECTIVE_COMPLETION_PREFIX) && completionId.length > OBJECTIVE_COMPLETION_PREFIX.length ? completionId.slice(OBJECTIVE_COMPLETION_PREFIX.length) : undefined;
}

/** One provider-stable key shared by canonical interactive delivery and crash recovery. */
export function interactionCompletionDeliveryKey(profileId: string, scope: Pick<AgentScope, "platform" | "channelInstanceId" | "chatId">, originMessageId: string): string {
	const identity = [profileId.trim(), scope.platform.trim(), scope.channelInstanceId?.trim() ?? "", scope.chatId.trim(), originMessageId.trim()];
	if (identity[0] === "" || identity[1] === "" || identity[3] === "" || identity[4] === "") throw new Error("Interactive completion delivery identity is incomplete");
	return `objective-interaction:sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

export interface ObjectiveCompletionDeliveryResult { claimed: number; delivered: number; failed: number; deferred: number; blocked: number; }
export type ObjectiveCompletionOutbox = Required<Pick<TaskLedger,
	"claimObjectiveCompletions" | "completeObjectiveCompletion" | "failObjectiveCompletion"
>> & Partial<Pick<TaskLedger, "getObjectiveCompletion" | "renewObjectiveCompletion" | "deferObjectiveCompletion" | "blockObjectiveCompletion">>;

export interface ObjectiveCompletionDeliveryOptions {
	platform: string;
	intervalMs?: number;
	batchSize?: number;
	leaseMs?: number;
	leaseHeartbeatMs?: number;
	maxAttempts?: number;
	deliveryConcurrency?: number;
	shutdownGraceMs?: number;
	onDelivered?: (completion: ObjectiveCompletion) => void | Promise<void>;
	onCycle?: (result: ObjectiveCompletionDeliveryResult) => void;
	onError?: (error: unknown) => void;
}

/** The sole channel-delivery worker for accepted durable Objective outcomes. */
export class ObjectiveCompletionDeliveryService {
	private readonly outbox: ObjectiveCompletionOutbox;
	private readonly delivery: Pick<DeliveryPort, "sendText">;
	private readonly options: ObjectiveCompletionDeliveryOptions;
	private readonly intervalMs: number;
	private readonly batchSize: number;
	private readonly leaseMs: number;
	private readonly leaseHeartbeatMs: number;
	private readonly maxAttempts: number;
	private readonly deliveryConcurrency: number;
	private readonly shutdownGraceMs: number;
	private readonly controllers = new Set<AbortController>();
	private active?: Promise<ObjectiveCompletionDeliveryResult>;
	private timer?: ReturnType<typeof setTimeout>;
	private stopped = true;

	constructor(
		outbox: ObjectiveCompletionOutbox,
		delivery: Pick<DeliveryPort, "sendText">,
		options: ObjectiveCompletionDeliveryOptions,
	) {
		this.outbox = outbox;
		this.delivery = delivery;
		this.options = options;
		this.intervalMs = Math.max(1_000, Math.trunc(options.intervalMs ?? 30_000));
		this.batchSize = Math.max(1, Math.min(Math.trunc(options.batchSize ?? 10), 50));
		this.leaseMs = Math.max(100, Math.trunc(options.leaseMs ?? 20 * 60_000));
		this.leaseHeartbeatMs = Math.max(10, Math.min(Math.trunc(options.leaseHeartbeatMs ?? 60_000), Math.trunc(this.leaseMs / 2)));
		this.maxAttempts = Math.max(1, Math.min(Math.trunc(options.maxAttempts ?? 10), 100));
		this.deliveryConcurrency = Math.max(1, Math.min(Math.trunc(options.deliveryConcurrency ?? 2), 10));
		this.shutdownGraceMs = Math.max(0, Math.min(Math.trunc(options.shutdownGraceMs ?? 30_000), 5 * 60_000));
	}

	async runOnce(now = Date.now()): Promise<ObjectiveCompletionDeliveryResult> {
		if (this.active) return this.active;
		const cycle = this.deliverBatch(now);
		this.active = cycle;
		try { return await cycle; }
		finally { if (this.active === cycle) this.active = undefined; }
	}

	start(): void { if (!this.stopped) return; this.stopped = false; this.schedule(0); }
	wake(): void { if (!this.stopped) { if (this.timer) clearTimeout(this.timer); this.schedule(0); } }
	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		for (const controller of this.controllers) if (!controller.signal.aborted) controller.abort(new Error("Objective Completion delivery stopped"));
		if (!this.active) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try { await Promise.race([this.active, new Promise<void>((resolve) => { timer = setTimeout(resolve, this.shutdownGraceMs); })]); }
		catch { /* surfaced through onError */ }
		finally { if (timer) clearTimeout(timer); }
	}

	private async deliverBatch(now: number): Promise<ObjectiveCompletionDeliveryResult> {
		const completions = this.outbox.claimObjectiveCompletions(this.options.platform, now, this.batchSize, this.leaseMs);
		const summary: ObjectiveCompletionDeliveryResult = { claimed: completions.length, delivered: 0, failed: 0, deferred: 0, blocked: 0 };
		let cursor = 0;
		const workers = Array.from({ length: Math.min(this.deliveryConcurrency, completions.length) }, async () => {
			while (cursor < completions.length) {
				const completion = completions[cursor++]!;
				const outcome = await this.deliverOne(completion, now);
				summary[outcome]++;
			}
		});
		await Promise.all(workers);
		return summary;
	}

	private async deliverOne(completion: ObjectiveCompletion, now: number): Promise<"delivered" | "failed" | "deferred" | "blocked"> {
		const controller = new AbortController();
		this.controllers.add(controller);
		const heartbeat = completion.claimToken && this.outbox.renewObjectiveCompletion ? setInterval(() => {
			if (!this.outbox.renewObjectiveCompletion?.(completion.id, completion.claimToken!, Date.now() + this.leaseMs)) controller.abort(new Error(`Objective Completion lease lost: ${completion.id}`));
		}, this.leaseHeartbeatMs) : undefined;
		heartbeat?.unref();
		try {
			const receipt = await this.delivery.sendText(completion.target, completion.result, { idempotencyKey: completion.deliveryIdempotencyKey, deliveryClass: "proactive", deliveryAttempt: completion.attempts });
			if (controller.signal.aborted) throw controller.signal.reason;
			if (!receipt || receipt.idempotencyKey !== completion.deliveryIdempotencyKey) throw new Error(`Channel returned an invalid Delivery Receipt for ${completion.id}`);
			await this.options.onDelivered?.({ ...completion, status: "delivered", receipt });
			if (!completion.claimToken || !this.outbox.completeObjectiveCompletion(completion.id, completion.claimToken, receipt, now)) throw new Error(`Objective Completion acknowledgement failed: ${completion.id}`);
			return "delivered";
		} catch (error) {
			if (error instanceof DeliveryDeferredError && completion.claimToken && this.outbox.deferObjectiveCompletion?.(completion.id, completion.claimToken, error.retryAt, now)) return "deferred";
			if (completion.claimToken && completion.attempts >= this.maxAttempts && this.outbox.blockObjectiveCompletion?.(completion.id, completion.claimToken, error instanceof Error ? error.message : String(error), now)) {
				this.options.onError?.(error);
				return "blocked";
			}
			if (completion.claimToken) this.outbox.failObjectiveCompletion(completion.id, completion.claimToken, now);
			return "failed";
		} finally {
			if (heartbeat) clearInterval(heartbeat);
			this.controllers.delete(controller);
		}
	}

	private schedule(delay: number): void {
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.runOnce().then((result) => this.options.onCycle?.(result)).catch((error) => this.options.onError?.(error)).finally(() => { if (!this.stopped) this.schedule(this.intervalMs); });
		}, delay);
		this.timer.unref?.();
	}
}
