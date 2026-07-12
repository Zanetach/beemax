export { Dispatcher, type DispatcherDeps } from "./core/dispatcher.ts";
export { InteractionControlServer, type InteractionControlServerOptions } from "./core/interaction-control-server.ts";
export { GatewayDeliveryPort } from "./core/delivery-port.ts";
export { MessageDeduplicator } from "./core/message-deduplicator.ts";
export { prepareAgentMediaInput, type AgentMediaInput } from "./core/media-input.ts";
export { CardSession } from "./card/session.ts";
export { renderCard, type CardRenderOptions } from "./card/render.ts";
export { FlushController } from "./card/flush.ts";
export { CardTimeline } from "./card/timeline.ts";
export { PairingStore, type PairingAuthority, type PairingApproval, type PairingRequest, type PairingRequestResult } from "./security/pairing.ts";
export type {
	PlatformAdapter,
	PlatformName,
	SessionSource,
	InboundMessage,
	MessageHandler,
	CardActionHandler,
	PlatformCardAction,
	MessageType,
	SendResult,
	SendOptions,
} from "./core/types.ts";
export { FeishuAdapter, parseFeishuCardActionEvent, parseFeishuMediaDescriptor, type FeishuMediaDescriptor } from "./platforms/feishu/adapter.ts";
export { loadFeishuSettings, validateFeishuWebhookSettings, type FeishuSettings } from "./platforms/feishu/settings.ts";
