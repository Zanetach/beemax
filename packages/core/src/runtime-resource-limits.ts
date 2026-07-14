/** Default production Profile limits. Deployment Profiles must match or explicitly override these at composition. */
export const DEFAULT_RUNTIME_RESOURCE_LIMITS = Object.freeze({
	interactionQueueMaxRecords: 500,
	interactionQueueMaxBytes: 2 * 1024 * 1024,
	taskConcurrency: 4,
	taskQueueMax: 1_000,
	taskQueueMaxPerOwner: 100,
});
