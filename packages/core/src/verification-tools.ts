import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { READ_ONLY_TOOL_POLICY, withToolPolicy } from "./tool-runtime.ts";

export const VERIFICATION_SUBMIT_TOOL_NAME = "verification_submit";

/** A structured, receipt-producing verdict boundary for independent Verification. */
export function createVerificationSubmitTool() {
	return withToolPolicy(defineTool({
		name: VERIFICATION_SUBMIT_TOOL_NAME,
		label: "Submit Verification Verdict",
		description: "Submit exactly one structured independent Verification verdict for the current Task. Every criterion has an accepted, rejected, or unavailable assertion; evaluated assertions cite successful evidence Tools as tool:<exact_name>, which Thruvera binds to concrete call receipts.",
		parameters: Type.Object({
			status: Type.Union([Type.Literal("accepted"), Type.Literal("rejected"), Type.Literal("unavailable")]),
			reason: Type.String({ minLength: 1, maxLength: 5_000 }),
			assertions: Type.Array(Type.Object({
				status: Type.Union([Type.Literal("accepted"), Type.Literal("rejected"), Type.Literal("unavailable")]),
				criterionId: Type.String({ pattern: "^C[1-9][0-9]*$", maxLength: 16 }),
				evidence: Type.String({ minLength: 1, maxLength: 5_000 }),
				evidenceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 256, pattern: "^(tool:[a-zA-Z0-9_-]{1,128}|tool-call:[^\\s]{1,220})$", description: "Use tool:<exact successful Tool name>, or an exact tool-call:<id> when known." }), { minItems: 1, maxItems: 100 }),
			}), { maxItems: 100 }),
		}),
		execute: async (_id, params) => ({ content: [{ type: "text" as const, text: "Verification verdict receipt recorded." }], details: { verdict: params } }),
	}), { ...READ_ONLY_TOOL_POLICY, maxAttempts: 1, impact: "Records one turn-scoped structured Verification verdict without changing business state" });
}
