# Separate group Conversations from Actors and route concrete Channel Instances

BeeMax identifies a group Conversation by its Channel Instance, platform conversation, and optional Thread, without including the current Actor. Actor identity remains separate and continues to own personal responsibility, private Memory, approval, and Access Scope. Direct-message Conversations retain their peer identity.

BeeMax also treats a Channel Instance, rather than a platform name, as the concrete ingress and delivery route. Multiple instances may use the same platform Adapter; platform-only delivery remains compatible only when exactly one connected instance is unambiguous.

We rejected per-sender group Sessions because they fragment shared collaboration and make replies from different participants lose context. We rejected platform-only routing because it cannot safely support multiple bots or workspaces. The trade-off is an additive Session migration and the requirement that new durable delivery targets retain `channelInstanceId`; legacy routes remain readable while a single platform instance is unambiguous.
