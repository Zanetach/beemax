import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const server = new McpServer({ name: "beemax-test", version: "1.0.0" });
server.registerTool("echo", {
	description: "Echo text",
	inputSchema: { text: z.string() },
	annotations: { readOnlyHint: true },
}, async ({ text }) => ({ content: [{ type: "text", text: `echo:${text}` }] }));
server.registerTool("mutate", {
	description: "Mutating test tool",
	inputSchema: { value: z.string() },
	annotations: { readOnlyHint: false },
}, async ({ value }) => ({ content: [{ type: "text", text: `mutated:${value}` }] }));
await server.connect(new StdioServerTransport());
