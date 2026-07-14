export { Dispatcher, type DispatcherDeps } from "./core/dispatcher.ts";
export { InteractionControlServer, type InteractionControlServerOptions } from "./core/interaction-control-server.ts";
export { GatewayDeliveryPort } from "./core/delivery-port.ts";
export { GovernedDeliveryPort, type GovernedDeliveryEvent, type GroupDeliveryGovernorResolver } from "./core/governed-delivery-port.ts";
export { DeliveryDeferredError } from "@beemax/core";
export { AdapterRegistry, ChannelHost } from "@beemax/channel-runtime";
export type { ChannelAdapterRegistration, ChannelAdapterResolver, ChannelHostOptions, ChannelHostSnapshot, ChannelInstanceConfig, ChannelLifecycleState, ChannelStatus } from "@beemax/channel-runtime";
export { MessageDeduplicator } from "./core/message-deduplicator.ts";
export { GatewayIngressController, type GatewayIngressOptions, type GatewayIngressSnapshot, type GatewayInteractionAdmission } from "./core/ingress-capacity.ts";
export { ProfileHost, assessProfileChannelHealth, type ProfileHostHealth, type ProfileHostSnapshot, type ProfileHostState } from "./core/profile-host.ts";
export { GroupResponseGovernor, type GroupQuietHours, type GroupResponseGovernorOptions, type GroupResponseGovernorSnapshot, type GroupResponseReservation } from "@beemax/channel-runtime";
export { GroupActivationController, decideGroupActivation, decideGroupAdmission, type GroupActivationControllerInput, type GroupActivationControllerOptions, type GroupActivationDecision, type GroupActivationInput, type GroupActivationMode, type GroupActivationSignal, type GroupAdmissionDecision, type GroupAdmissionInput, type GroupAdmissionPolicy } from "@beemax/channel-runtime";
export { ProfileBindingResolver, assertProfileBindingConfiguration, type ProfileBinding, type ProfileBindingAuthority, type ProfileBindingConflict, type ProfileBindingExplanation, type ProfileBindingPrecedence, type ProfileBindingRoute } from "./core/profile-binding.ts";
export { prepareAgentMediaInput, type AgentMediaInput } from "./core/media-input.ts";
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
} from "@beemax/channel-runtime";
