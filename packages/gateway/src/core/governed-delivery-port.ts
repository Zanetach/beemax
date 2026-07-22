import { DeliveryDeferredError, conversationKey, type DeliveryOptions, type DeliveryPort, type DeliveryReceipt, type DeliveryTarget, type MediaArtifact } from "@thruvera/core";
import type { GroupResponseGovernor } from "@thruvera/channel-runtime";

export interface GroupDeliveryGovernorResolver {
	resolve(target: DeliveryTarget): GroupResponseGovernor | undefined;
	onSettled?(event: GovernedDeliveryEvent): void;
}

export interface GovernedDeliveryEvent {
	platform: string; channelInstanceId?: string; chatType?: DeliveryTarget["chatType"];
	status: "delivered" | "deferred" | "failed"; reason?: DeliveryDeferredError["reason"]; attempts?: number; latencyMs: number;
}

/** Applies transport-neutral proactive group budgets without governing DM or requested replies. */
export class GovernedDeliveryPort implements DeliveryPort {
	private readonly inner: DeliveryPort;
	private readonly governors: GroupDeliveryGovernorResolver;
	constructor(inner: DeliveryPort, governors: GroupDeliveryGovernorResolver) { this.inner = inner; this.governors = governors; }

	async sendText(target: DeliveryTarget, text: string, options?: DeliveryOptions): Promise<DeliveryReceipt> {
		return this.deliver(target, options, () => this.inner.sendText(target, text, options));
	}

	async sendMedia(target: DeliveryTarget, media: MediaArtifact, options?: DeliveryOptions): Promise<DeliveryReceipt> {
		return this.deliver(target, options, () => this.inner.sendMedia(target, media, options));
	}

	private async deliver(target: DeliveryTarget, options: DeliveryOptions | undefined, send: () => Promise<DeliveryReceipt>): Promise<DeliveryReceipt> {
		const startedAt = Date.now();
		if (options?.deliveryClass !== "proactive") return send();
		if (!target.chatType) {
			const error = new DeliveryDeferredError("unknown_conversation_type", Date.now() + 24 * 60 * 60_000);
			this.observe(target, options, startedAt, "deferred", error.reason);
			throw error;
		}
		if (target.chatType === "dm") return this.sendObserved(target, options, startedAt, send);
		const governor = this.governors.resolve(target);
		if (!governor) return this.sendObserved(target, options, startedAt, send);
		const laneKey = conversationKey({ ...target, chatType: target.chatType });
		const reservation = governor.reserve(laneKey, "ambient");
		if (!reservation.allowed) {
			this.observe(target, options, startedAt, "deferred", reservation.reason);
			throw new DeliveryDeferredError(reservation.reason, reservation.retryAt);
		}
		try { const receipt = await send(); this.observe(target, options, startedAt, "delivered"); return receipt; }
		catch (error) { reservation.rollback?.(); this.observe(target, options, startedAt, "failed"); throw error; }
	}

	private async sendObserved(target: DeliveryTarget, options: DeliveryOptions, startedAt: number, send: () => Promise<DeliveryReceipt>): Promise<DeliveryReceipt> {
		try { const receipt = await send(); this.observe(target, options, startedAt, "delivered"); return receipt; }
		catch (error) { this.observe(target, options, startedAt, "failed"); throw error; }
	}

	private observe(target: DeliveryTarget, options: DeliveryOptions, startedAt: number, status: GovernedDeliveryEvent["status"], reason?: GovernedDeliveryEvent["reason"]): void {
		this.governors.onSettled?.({ platform: target.platform, ...(target.channelInstanceId ? { channelInstanceId: target.channelInstanceId } : {}), ...(target.chatType ? { chatType: target.chatType } : {}), status, ...(reason ? { reason } : {}), ...(options.deliveryAttempt === undefined ? {} : { attempts: options.deliveryAttempt }), latencyMs: Math.max(0, Date.now() - startedAt) });
	}
}
