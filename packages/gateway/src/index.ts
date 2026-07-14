export { Dispatcher, type DispatcherDeps } from "./core/dispatcher.ts";
export { InteractionControlServer, type InteractionControlServerOptions } from "./core/interaction-control-server.ts";
export { GatewayDeliveryPort } from "./core/delivery-port.ts";
export { GovernedDeliveryPort, type GovernedDeliveryEvent, type GroupDeliveryGovernorResolver } from "./core/governed-delivery-port.ts";
export { DeliveryDeferredError } from "@beemax/core";
export { AdapterRegistry, ChannelHost } from "./core/channel-host.ts";
export type { ChannelAdapterRegistration, ChannelAdapterResolver, ChannelHostOptions, ChannelHostSnapshot, ChannelInstanceConfig, ChannelLifecycleState, ChannelStatus } from "./core/channel-host.ts";
export { MessageDeduplicator } from "./core/message-deduplicator.ts";
export { GatewayIngressController, type GatewayIngressOptions, type GatewayIngressSnapshot, type GatewayInteractionAdmission } from "./core/ingress-capacity.ts";
export { ProfileHost, assessProfileChannelHealth, type ProfileHostHealth, type ProfileHostSnapshot, type ProfileHostState } from "./core/profile-host.ts";
export { GroupResponseGovernor, type GroupQuietHours, type GroupResponseGovernorOptions, type GroupResponseGovernorSnapshot, type GroupResponseReservation } from "./core/group-response-governor.ts";
export { GroupActivationController, decideGroupActivation, decideGroupAdmission, type GroupActivationControllerInput, type GroupActivationControllerOptions, type GroupActivationDecision, type GroupActivationInput, type GroupActivationMode, type GroupActivationSignal, type GroupAdmissionDecision, type GroupAdmissionInput, type GroupAdmissionPolicy } from "./core/group-admission.ts";
export { ProfileBindingResolver, assertProfileBindingConfiguration, type ProfileBinding, type ProfileBindingAuthority, type ProfileBindingConflict, type ProfileBindingExplanation, type ProfileBindingPrecedence, type ProfileBindingRoute } from "./core/profile-binding.ts";
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
	InboundObservation,
	MessageHandler,
	ObservationHandler,
	CardActionHandler,
	PlatformCardAction,
	MessageType,
	SendResult,
	SendOptions,
} from "./core/types.ts";
export { FeishuAdapter, parseFeishuCardActionEvent, parseFeishuMediaDescriptor, type FeishuMediaDescriptor } from "./platforms/feishu/adapter.ts";
export { loadFeishuSettings, validateFeishuWebhookSettings, type FeishuActivationSettings, type FeishuGroupRule, type FeishuSettings } from "./platforms/feishu/settings.ts";
export { retryFeishuOperation, type FeishuRetryOptions } from "./platforms/feishu/retry.ts";
export { runFeishuSmoke, type FeishuSmokeCheck, type FeishuSmokeResult } from "./platforms/feishu/smoke.ts";
export { TelegramAdapter, type TelegramAdapterDependencies, type TelegramSettings } from "./platforms/telegram/adapter.ts";
