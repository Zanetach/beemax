export { Dispatcher, type DispatcherDeps } from "./core/dispatcher.ts";
export { InteractionControlServer, type InteractionControlServerOptions } from "./core/interaction-control-server.ts";
export { GatewayDeliveryPort } from "./core/delivery-port.ts";
export { AdapterRegistry, ChannelHost } from "./core/channel-host.ts";
export type { ChannelAdapterRegistration, ChannelAdapterResolver, ChannelHostOptions, ChannelHostSnapshot, ChannelInstanceConfig, ChannelLifecycleState, ChannelStatus } from "./core/channel-host.ts";
export { MessageDeduplicator } from "./core/message-deduplicator.ts";
export { GatewayIngressController, type GatewayIngressOptions, type GatewayIngressSnapshot } from "./core/ingress-capacity.ts";
export { decideGroupActivation, decideGroupAdmission, type GroupActivationDecision, type GroupActivationInput, type GroupActivationMode, type GroupActivationSignal, type GroupAdmissionDecision, type GroupAdmissionInput, type GroupAdmissionPolicy } from "./core/group-admission.ts";
export { ProfileBindingResolver, type ProfileBinding, type ProfileBindingConflict, type ProfileBindingExplanation, type ProfileBindingPrecedence, type ProfileBindingRoute } from "./core/profile-binding.ts";
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
export { retryFeishuOperation, type FeishuRetryOptions } from "./platforms/feishu/retry.ts";
export { runFeishuSmoke, type FeishuSmokeCheck, type FeishuSmokeResult } from "./platforms/feishu/smoke.ts";
export { TelegramAdapter, type TelegramAdapterDependencies, type TelegramSettings } from "./platforms/telegram/adapter.ts";
