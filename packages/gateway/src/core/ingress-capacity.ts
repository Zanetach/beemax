export interface GatewayIngressOptions {
	maxActive?: number;
	maxActivePerConversation?: number;
}

export interface GatewayIngressSnapshot {
	active: number;
	activeConversations: number;
	maxActive: number;
	maxActivePerConversation: number;
	rejected: number;
}

export interface GatewayInteractionAdmission {
	tryAcquire(conversationKey: string): (() => void) | undefined;
}

/** Bounded Gateway admission before an Interaction can allocate Runtime work. */
export class GatewayIngressController implements GatewayInteractionAdmission {
	private readonly maxActive: number;
	private readonly maxActivePerConversation: number;
	private active = 0;
	private rejected = 0;
	private readonly conversations = new Map<string, number>();

	constructor(options: GatewayIngressOptions = {}) {
		this.maxActive = positiveInteger(options.maxActive, 1_000);
		this.maxActivePerConversation = Math.min(this.maxActive, positiveInteger(options.maxActivePerConversation, 100));
	}

	tryAcquire(conversationKey: string): (() => void) | undefined {
		const conversationActive = this.conversations.get(conversationKey) ?? 0;
		if (this.active >= this.maxActive || conversationActive >= this.maxActivePerConversation) {
			this.rejected++;
			return undefined;
		}
		this.active++;
		this.conversations.set(conversationKey, conversationActive + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active--;
			const remaining = (this.conversations.get(conversationKey) ?? 1) - 1;
			if (remaining > 0) this.conversations.set(conversationKey, remaining); else this.conversations.delete(conversationKey);
		};
	}

	snapshot(): GatewayIngressSnapshot {
		return { active: this.active, activeConversations: this.conversations.size, maxActive: this.maxActive, maxActivePerConversation: this.maxActivePerConversation, rejected: this.rejected };
	}
}

function positiveInteger(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1) throw new Error("Gateway ingress limits must be positive integers");
	return value;
}
