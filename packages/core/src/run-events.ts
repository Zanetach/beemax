/** Canonical, channel-neutral run stream. Renderers must not treat internal events as assistant text. */
export type RunEvent =
	| { type: "run.started"; runId: string; at: number }
	| { type: "assistant.delta"; text: string }
	| { type: "assistant.interim"; text: string }
	| { type: "tool.started"; callId: string; name: string; summary?: string }
	| { type: "tool.progress"; callId: string; summary: string }
	| { type: "tool.finished"; callId: string; outcome: "ok" | "error"; summary?: string }
	| { type: "approval.requested"; callId: string; risk: "low" | "high" }
	| { type: "reasoning.delta"; text: string; providerRequired?: boolean }
	| { type: "run.finished"; answer: string; at: number }
	| { type: "run.failed"; error: string; at: number };

/** Durable execution diagnostics, deliberately separate from a user-visible transcript. */
export interface RunRecord {
	runId: string;
	sessionId: string;
	startedAt: number;
	finishedAt?: number;
	events: RunEvent[];
}
