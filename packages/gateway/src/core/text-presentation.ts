import type { DeliveryReceipt, InteractionEvent } from "@beemax/core";
import { randomUUID } from "node:crypto";
import type {
	InteractionPresentationOpen,
	InteractionPresenter,
	PlatformAdapter,
	TurnPresentation,
	TurnPresentationFinishOptions,
	WorkProgressPresentation,
} from "@beemax/channel-runtime";
import { formatAnswerWithPublishedArtifacts, formatWorkProgress } from "@beemax/channel-runtime";

/** Universal presentation fallback for channels that only implement text delivery. */
export class TextInteractionPresenter implements InteractionPresenter {
	private readonly platform: PlatformAdapter;

	constructor(platform: PlatformAdapter) { this.platform = platform; }

	open(input: InteractionPresentationOpen): TurnPresentation {
		return new TextTurnPresentation(this.platform, input);
	}

	async presentWorkProgress({ target, event, idempotencyKey }: WorkProgressPresentation): Promise<void> {
		const result = await this.platform.send(
			target.chatId,
			formatWorkProgress(event),
			{ idempotencyKey },
		);
		if (!result.success) throw new Error(result.error ?? `Failed to present Task Plan ${event.workId}`);
	}
}

class TextTurnPresentation implements TurnPresentation {
	private readonly platform: PlatformAdapter;
	private readonly input: InteractionPresentationOpen;

	constructor(platform: PlatformAdapter, input: InteractionPresentationOpen) {
		this.platform = platform;
		this.input = input;
	}

	async start(): Promise<void> {
		await this.platform.sendTyping(this.input.source.chatId, this.input.source.messageId).catch((error) => {
			console.warn(`[beemax] typing indicator failed: ${safeError(error)}`);
		});
	}

	async onEvent(_event: InteractionEvent): Promise<void> {}

	async finish(answer: string, options?: TurnPresentationFinishOptions): Promise<DeliveryReceipt> {
		const deliveryText = formatAnswerWithPublishedArtifacts(answer, options?.publishedArtifacts);
		const result = await this.platform.send(this.input.source.chatId, deliveryText, {
			...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
			...(this.input.source.replyToMessageId ? { replyTo: this.input.source.replyToMessageId, replyInThread: Boolean(this.input.source.threadId) } : {}),
		});
		if (!result.success) throw new Error(result.error ?? "Text answer delivery failed");
		return { idempotencyKey: options?.idempotencyKey ?? `interactive:${randomUUID()}`, deliveredAt: Date.now(), ...(result.messageId ? { providerMessageId: result.messageId } : {}) };
	}

	async fail(error: string): Promise<void> {
		const result = await this.platform.send(this.input.source.chatId, `❌ ${error}`);
		if (!result.success) throw new Error(result.error ?? "Text error delivery failed");
	}

	async close(failed: boolean): Promise<void> {
		await this.platform.stopTyping(this.input.source.chatId, this.input.source.messageId, failed).catch(() => undefined);
	}
}

function safeError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
