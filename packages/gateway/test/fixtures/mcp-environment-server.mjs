import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const stderrFlag = process.argv.indexOf("--emit-stderr");
if (stderrFlag >= 0) process.stderr.write(`${process.argv[stderrFlag + 1] ?? "missing"}\n`);

const server = new McpServer({ name: "beemax-environment-test", version: "1.0.0" });
server.registerTool("runtime_context", {
	description: "Report the isolated MCP process context",
	inputSchema: {},
	annotations: { readOnlyHint: true },
}, async () => ({
	content: [{
		type: "text",
		text: JSON.stringify({
			args: process.argv.slice(2),
			cwd: process.cwd(),
			profileValue: process.env.PROFILE_VALUE,
			profileSecret: process.env.PROFILE_SECRET,
			serverValue: process.env.SERVER_VALUE,
			home: process.env.HOME,
			user: process.env.USER,
		}),
	}],
}));
await server.connect(new StdioServerTransport());
setInterval(() => {}, 1_000);
