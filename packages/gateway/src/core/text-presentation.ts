import type { InteractionEvent } from "@beemax/core";
import type {
	InteractionPresentationOpen,
	InteractionPresenter,
	PlatformAdapter,
	TurnPresentation,
	WorkProgressPresentation,
} from "@beemax/channel-runtime";

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
			`${event.title} · ${event.completed}/${event.total}${event.failed ? ` · 失败 ${event.failed}` : ""}${event.cancelled ? ` · 取消 ${event.cancelled}` : ""}`,
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

	async onEvent(event: InteractionEvent): Promise<void> {
		if (event.type !== "approval.requested") return;
		const message = event.details
			? `等待审批：${event.toolName}\n目标：${event.details.target}\n风险：${event.details.risk} · ${event.details.impact}\n可逆性：${event.details.reversibility}\n回复 1（一次）/ 2（本会话）/ 3（拒绝），或 /stop 取消。`
			: `等待审批：${event.toolName}\n回复 1（一次）/ 2（本会话）/ 3（拒绝），或 /stop 取消。`;
		const result = await this.platform.send(event.scope.chatId, message, { idempotencyKey: `approval:${event.turnId}` });
		if (!result.success) throw new Error(result.error ?? `Failed to present approval for ${event.toolName}`);
	}

	async finish(answer: string): Promise<void> {
		const result = await this.platform.send(this.input.source.chatId, answer);
		if (!result.success) throw new Error(result.error ?? "Text answer delivery failed");
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
