import { appendFile, readFile, writeFile } from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import * as z from "zod/v4";

export function createAgentParityFixtureServer({ root, workspace, receiptKey }) {
	root = resolve(root);
	workspace = resolve(workspace);
	if (!receiptKey || receiptKey.length < 32) throw new Error("AGENT_PARITY_RECEIPT_KEY is required");
	const server = new McpServer({ name: "agent-parity-fixture", version: "1.0.0" });

server.registerTool("status", { description: "Read the deterministic fixture system status.", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => {
	await record({ kind: "source_read", id: "MCP-STATUS-READY", source: "fixture-status" });
	return text({ status: "ready", fixtureId: "MCP-STATUS-READY" });
});
server.registerTool("deliver", { description: "Deliver only to a local fixture conversation and retain a receipt.", inputSchema: { conversation: z.enum(["original-private", "fixture-group-thread"]), message: z.string().min(1) }, annotations: { readOnlyHint: false } }, async (input) => {
	const receipt = { receiptId: `DELIVERY-${input.conversation}`, ...input, delivered: true };
	await record({ kind: "delivery_committed", id: receipt.receiptId, conversation: input.conversation });
	return text(receipt);
});
server.registerTool("send_unknown", { description: "Fixture mutation that commits once but deliberately reports an unknown transport outcome.", inputSchema: { idempotencyKey: z.literal("fixture-effect-1") }, annotations: { readOnlyHint: false } }, async ({ idempotencyKey }) => {
	await record({ kind: "effect_attempted", id: crypto.randomUUID(), idempotencyKey });
	try { await readFile(resolve(root, "effect-state.json"), "utf8"); }
	catch {
		await writeFile(resolve(root, "effect-state.json"), JSON.stringify({ idempotencyKey, status: "committed", receiptId: "EFFECT-COMMITTED-1" }));
		await record({ kind: "effect_committed", id: "EFFECT-COMMITTED-1", idempotencyKey });
	}
	throw new Error("simulated timeout: outcome unknown; reconcile before retry");
});
server.registerTool("effect_status", { description: "Reconcile the authoritative fixture Effect state without replaying it.", inputSchema: { idempotencyKey: z.literal("fixture-effect-1") }, annotations: { readOnlyHint: true } }, async ({ idempotencyKey }) => {
	const state = JSON.parse(await readFile(resolve(root, "effect-state.json"), "utf8"));
	await record({ kind: "effect_reconciled", id: crypto.randomUUID(), idempotencyKey, status: state.status });
	return text(state);
});
server.registerTool("schedule_delivery", { description: "Run a deterministic local Schedule and deliver through the fixture outbox.", inputSchema: { scheduleId: z.literal("fixture-schedule-1"), conversation: z.literal("original-private") }, annotations: { readOnlyHint: false } }, async (input) => {
	const receipt = { ...input, checkpoint: "SCHEDULE-CHECKPOINT-1", deliveryReceipt: "SCHEDULE-DELIVERY-1" };
	await record({ kind: "checkpoint_saved", id: receipt.checkpoint, scheduleId: input.scheduleId });
	await record({ kind: "delivery_committed", id: receipt.deliveryReceipt, conversation: input.conversation });
	return text(receipt);
});
server.registerTool("recover_step", { description: "Resume a fixture operation from its durable checkpoint after the first Provider failure.", inputSchema: { recoveryId: z.literal("fixture-recovery-1") }, annotations: { readOnlyHint: false } }, async ({ recoveryId }) => {
	const path = resolve(root, "recovery-checkpoint.json");
	try { return text({ ...(JSON.parse(await readFile(path, "utf8"))), recovered: true, duplicateEffects: 0 }); }
	catch {
		await writeFile(path, JSON.stringify({ recoveryId, checkpoint: "RECOVERY-CHECKPOINT-1", completed: ["step-a"] }));
		await record({ kind: "checkpoint_saved", id: "RECOVERY-CHECKPOINT-1", recoveryId });
		throw new Error("simulated Provider crash after durable checkpoint; retry by recoveryId");
	}
});
server.registerTool("structured_lookup", { description: "Validate a complete structured Tool call.", inputSchema: { entityId: z.literal("fixture-42"), fields: z.array(z.string()).min(2) }, annotations: { readOnlyHint: true } }, async ({ entityId, fields }) => text({ entityId, fields, receiptId: "STRUCTURED-42" }));
server.registerTool("activate_skill", { description: "Load the pinned evaluation-research Skill and return its immutable receipt.", inputSchema: { name: z.literal("evaluation-research") }, annotations: { readOnlyHint: true } }, async ({ name }) => {
	const content = await readFile(resolve(workspace, name, "SKILL.md"), "utf8");
	const receipt = { name, skillReceipt: "SKILL-evaluation-research-v1", sha256: `sha256:${createHash("sha256").update(content).digest("hex")}` };
	await record({ kind: "skill_activated", id: receipt.skillReceipt, name, sha256: receipt.sha256 });
	return text(receipt);
});
server.registerTool("memory_recall", { description: "Recall only the selected fixture Profile scope; foreign Profile memory is never returned.", inputSchema: { profile: z.literal("target") }, annotations: { readOnlyHint: true } }, async ({ profile }) => {
	await record({ kind: "scope_checked", id: "PROFILE-TARGET-ISOLATED", profile, foreignRecordPresent: true, foreignRecordReturned: false });
	return text({ profile, isolated: true, leakage: false, receiptId: "PROFILE-TARGET-ISOLATED" });
});
server.registerTool("read_source_a", { description: "Read parity Source A.", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => { await record({ kind: "source_read", id: "SOURCE-A-ROUTING", source: "source-a.md" }); return text({ fixtureId: "SOURCE-A-ROUTING", content: await readFile(resolve(workspace, "source-a.md"), "utf8") }); });
server.registerTool("read_source_b", { description: "Read parity Source B.", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => { await record({ kind: "source_read", id: "SOURCE-B-VERIFY", source: "source-b.md" }); return text({ fixtureId: "SOURCE-B-VERIFY", content: await readFile(resolve(workspace, "source-b.md"), "utf8") }); });
server.registerTool("inspect_image", { description: "Inspect the parity image when the primary model has no vision input.", inputSchema: { path: z.literal("image-fixture.svg") }, annotations: { readOnlyHint: true } }, async () => { await record({ kind: "artifact_inspected", id: "IMAGE-42", artifact: "image-fixture.svg" }); return text({ path: "image-fixture.svg", shape: "hexagon", color: "blue", code: "VISION-42", receiptId: "IMAGE-42" }); });
	function text(value) { return { content: [{ type: "text", text: JSON.stringify(value) }] }; }
	async function record(event) {
		const payload = { ...event, at: Date.now() };
		const mac = createHmac("sha256", receiptKey).update(JSON.stringify(payload)).digest("hex");
		await appendFile(resolve(root, "fixture-authority.jsonl"), `${JSON.stringify({ ...payload, mac })}\n`);
	}
	return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	const root = resolve(process.env.AGENT_PARITY_STATE_DIR || process.cwd());
	const workspace = resolve(process.env.AGENT_PARITY_WORKSPACE || process.cwd());
	const receiptKey = process.env.AGENT_PARITY_RECEIPT_KEY;
	const server = createAgentParityFixtureServer({ root, workspace, receiptKey });
	if (process.env.AGENT_PARITY_HTTP === "true") {
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
		await server.connect(transport);
		const app = createMcpExpressApp({ host: "127.0.0.1" });
		app.post("/mcp", (request, response) => transport.handleRequest(request, response, request.body));
		app.get("/mcp", (request, response) => transport.handleRequest(request, response));
		app.delete("/mcp", (request, response) => transport.handleRequest(request, response));
		const listener = app.listen(0, "127.0.0.1", () => {
			const address = listener.address();
			if (!address || typeof address === "string") throw new Error("Fixture MCP did not bind a TCP port");
			process.stdout.write(`${JSON.stringify({ ready: true, url: `http://127.0.0.1:${address.port}/mcp` })}\n`);
		});
		const shutdown = async () => { await transport.close().catch(() => {}); listener.close(() => process.exit(0)); };
		process.once("SIGTERM", shutdown);
		process.once("SIGINT", shutdown);
	} else {
		await server.connect(new StdioServerTransport());
	}
}
