# Isolate Channel Runtime and platform Adapters

BeeMax keeps the platform-neutral Channel Runtime, the Interaction Gateway, and each messaging-platform Adapter in independently buildable packages, composed only at the application root. We rejected a single Gateway package containing Feishu and Telegram because it makes the generic Runtime depend on every platform SDK, hides broken per-instance configuration behind a nominal Adapter seam, and forces unrelated channels to change together; the cost is explicit package composition and migration of existing imports.
