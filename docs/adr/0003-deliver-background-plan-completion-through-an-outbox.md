# Deliver background Plan completion through an Outbox

Background Task Plans may finish while their originating channel is disconnected, so Thruvera records a durable Task Plan Completion Notice before attempting delivery instead of relying on an in-process callback. Delivery is at least once with a stable Notice identity and bounded retry; the Notice contains only an outcome summary and a command for owner-scoped detail retrieval, keeping Task results out of the delivery queue.
