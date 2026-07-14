/** Default production Profile limits. Deployment Profiles must match or explicitly override these at composition. */
export const DEFAULT_RUNTIME_RESOURCE_LIMITS = Object.freeze({
	interactionQueueMaxRecords: 500,
	interactionQueueMaxBytes: 2 * 1024 * 1024,
	taskConcurrency: 4,
	taskQueueMax: 1_000,
	taskQueueMaxPerOwner: 100,
});

/** Resolve a configurable task concurrency without permitting the production hard limit to be exceeded. */
export function resolveRuntimeTaskConcurrency(requested?: number): number {
	if (!Number.isInteger(requested) || Number(requested) < 1) return DEFAULT_RUNTIME_RESOURCE_LIMITS.taskConcurrency;
	return Math.min(Number(requested), DEFAULT_RUNTIME_RESOURCE_LIMITS.taskConcurrency);
}
