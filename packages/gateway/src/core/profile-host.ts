import type { ChannelHostSnapshot } from "./channel-host.ts";
import { GatewayIngressController, type GatewayIngressSnapshot, type GatewayInteractionAdmission } from "./ingress-capacity.ts";

export type ProfileHostState = "stopped" | "starting" | "healthy" | "degraded" | "failed" | "recovering" | "draining";

export type ProfileHostHealth =
	| { status: "ready"; degradedReasons?: readonly string[] }
	| { status: "failed"; failureReason: string };

export interface ProfileHostSnapshot {
	state: ProfileHostState;
	acceptingInteractions: boolean;
	lifecycleRejected: number;
	degradedReasons: string[];
	lastError?: string;
	ingress: GatewayIngressSnapshot;
}

interface IdleWaiter {
	resolve(): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * Profile-level lifecycle and Interaction admission authority.
 *
 * It deliberately does not own Pi, Memory, Tasks, channels, or durable work.
 * Draining rejects new ordinary Interactions while already admitted work keeps
 * its existing authorities and can finish before the surrounding host stops.
 */
export class ProfileHost implements GatewayInteractionAdmission {
	private readonly ingress: GatewayIngressController;
	private state: ProfileHostState = "stopped";
	private lifecycleRejected = 0;
	private degradedReasons: string[] = [];
	private lastError?: string;
	private readonly idleWaiters = new Set<IdleWaiter>();

	constructor(ingress = new GatewayIngressController()) {
		this.ingress = ingress;
	}

	beginStart(): ProfileHostSnapshot {
		if (this.state !== "stopped") throw new Error(`Profile Host cannot start from ${this.state}`);
		this.state = "starting";
		this.lastError = undefined;
		return this.snapshot();
	}

	start(health: ProfileHostHealth): ProfileHostSnapshot {
		this.beginStart();
		return this.reportHealth(health);
	}

	reportHealth(health: ProfileHostHealth): ProfileHostSnapshot {
		if (!(["starting", "healthy", "degraded", "recovering"] as ProfileHostState[]).includes(this.state)) {
			throw new Error(`Profile Host cannot report health from ${this.state}`);
		}
		return this.applyHealth(health);
	}

	fail(error: unknown): ProfileHostSnapshot {
		if (this.state === "stopped") throw new Error("Profile Host cannot fail before it starts");
		this.state = "failed";
		this.degradedReasons = [];
		this.lastError = safeError(error);
		return this.snapshot();
	}

	beginRecovery(): ProfileHostSnapshot {
		if (this.state !== "failed") throw new Error(`Profile Host cannot recover from ${this.state}`);
		this.state = "recovering";
		return this.snapshot();
	}

	beginDrain(): ProfileHostSnapshot {
		if (this.state === "draining") return this.snapshot();
		if (!(["healthy", "degraded", "failed", "recovering"] as ProfileHostState[]).includes(this.state)) {
			throw new Error(`Profile Host cannot drain from ${this.state}`);
		}
		this.state = "draining";
		return this.snapshot();
	}

	completeStop(): ProfileHostSnapshot {
		if (this.state !== "draining") throw new Error(`Profile Host cannot stop from ${this.state}`);
		if (this.ingress.snapshot().active !== 0) throw new Error("Profile Host cannot stop while Interactions are active");
		this.state = "stopped";
		this.degradedReasons = [];
		return this.snapshot();
	}

	tryAcquire(conversationKey: string): (() => void) | undefined {
		if (!this.acceptingInteractions()) {
			this.lifecycleRejected++;
			return undefined;
		}
		const releaseIngress = this.ingress.tryAcquire(conversationKey);
		if (!releaseIngress) return undefined;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			releaseIngress();
			this.resolveIdleWaiters();
		};
	}

	waitForIdle(timeoutMs = 30_000): Promise<void> {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Profile Host drain timeout must be a positive integer");
		if (this.ingress.snapshot().active === 0) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			const waiter: IdleWaiter = {
				resolve,
				reject,
				timer: setTimeout(() => {
					this.idleWaiters.delete(waiter);
					reject(new Error(`Profile Host drain timed out with ${this.ingress.snapshot().active} active Interaction(s)`));
				}, timeoutMs),
			};
			waiter.timer.unref?.();
			this.idleWaiters.add(waiter);
		});
	}

	snapshot(): ProfileHostSnapshot {
		return {
			state: this.state,
			acceptingInteractions: this.acceptingInteractions(),
			lifecycleRejected: this.lifecycleRejected,
			degradedReasons: [...this.degradedReasons],
			...(this.lastError ? { lastError: this.lastError } : {}),
			ingress: this.ingress.snapshot(),
		};
	}

	private acceptingInteractions(): boolean {
		return this.state === "healthy" || this.state === "degraded";
	}

	private applyHealth(health: ProfileHostHealth): ProfileHostSnapshot {
		if (health.status === "failed") {
			this.state = "failed";
			this.degradedReasons = [];
			this.lastError = health.failureReason.trim() || "A required Profile authority is unavailable";
			return this.snapshot();
		}
		this.degradedReasons = [...new Set((health.degradedReasons ?? []).map((reason) => reason.trim()).filter(Boolean))];
		this.state = this.degradedReasons.length ? "degraded" : "healthy";
		this.lastError = undefined;
		return this.snapshot();
	}

	private resolveIdleWaiters(): void {
		if (this.ingress.snapshot().active !== 0) return;
		for (const waiter of this.idleWaiters) {
			clearTimeout(waiter.timer);
			waiter.resolve();
		}
		this.idleWaiters.clear();
	}
}

export function assessProfileChannelHealth(snapshot: ChannelHostSnapshot): ProfileHostHealth {
	const degradedReasons = snapshot.channels
		.filter((channel) => channel.state !== "connected")
		.map((channel) => `Channel Instance ${channel.id} is ${channel.state}${channel.lastError ? `: ${channel.lastError}` : ""}`);
	return { status: "ready", ...(degradedReasons.length ? { degradedReasons } : {}) };
}

function safeError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
