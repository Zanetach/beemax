import { access, mkdir, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { AutomationStore, parseDuration } from "@beemax/automation";
import { loadMcpConfig, McpManager, validateFeishuWebhookSettings } from "@beemax/gateway";
import { MemoryStore } from "@beemax/memory";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { BeeMaxConfig } from "./config.ts";

interface Check { name: string; status: "PASS" | "WARN" | "FAIL"; detail: string }

export async function runDoctor(config: BeeMaxConfig): Promise<boolean> {
	const checks: Check[] = [];
	const node = process.versions.node.split(".").map(Number);
	checks.push({ name: "Node.js", status: node[0] > 22 || (node[0] === 22 && node[1] >= 19) ? "PASS" : "FAIL", detail: process.versions.node });

	const apiKey = config.model.apiKey || process.env[providerKeyEnv(config.model.provider)];
	checks.push({ name: "Model", status: apiKey ? "PASS" : "FAIL", detail: apiKey ? `${config.model.provider}/${config.model.model}` : `missing ${providerKeyEnv(config.model.provider)} or BEEMAX_API_KEY` });
	checks.push({ name: "Feishu credentials", status: config.feishu.appId && config.feishu.appSecret ? "PASS" : "FAIL", detail: config.feishu.appId && config.feishu.appSecret ? "configured" : "missing FEISHU_APP_ID/FEISHU_APP_SECRET" });
	const admitted = config.feishu.allowAllUsers || config.feishu.allowedUsers.length > 0;
	checks.push({ name: "Feishu access", status: admitted ? (config.feishu.allowAllUsers ? "WARN" : "PASS") : "FAIL", detail: config.feishu.allowAllUsers ? "public/dev mode" : `${config.feishu.allowedUsers.length} allowed user(s)` });
	try {
		validateFeishuWebhookSettings(config.feishu);
		checks.push({ name: "Feishu transport", status: "PASS", detail: config.feishu.connectionMode });
	} catch (error) {
		checks.push({ name: "Feishu transport", status: "FAIL", detail: error instanceof Error ? error.message : String(error) });
	}

	try {
		await access(config.paths.cwd, constants.R_OK | constants.W_OK);
		checks.push({ name: "Workspace", status: "PASS", detail: config.paths.cwd });
	} catch (error) {
		checks.push({ name: "Workspace", status: "FAIL", detail: error instanceof Error ? error.message : String(error) });
	}

	try {
		const memory = new MemoryStore(config.memory.dbPath);
		memory.close();
		checks.push({ name: "Memory", status: "PASS", detail: config.memory.dbPath });
	} catch (error) {
		checks.push({ name: "Memory", status: "FAIL", detail: error instanceof Error ? error.message : String(error) });
	}

	if (config.imageGeneration.enabled) {
		const auth = AuthStorage.create(join(config.paths.agentDir, "auth.json"));
		checks.push({
			name: "Image generation",
			status: auth.hasAuth("openai-codex") ? "PASS" : "FAIL",
			detail: auth.hasAuth("openai-codex")
				? `Codex OAuth; quality=${config.imageGeneration.quality}`
				: `missing profile Codex OAuth; run beemax auth codex --profile ${config.profile}`,
		});
	}

	checks.push({
		name: "Sub-Agents",
		status: config.subagents.enabled ? "PASS" : "WARN",
		detail: config.subagents.enabled
			? `concurrency=${config.subagents.maxConcurrent}; children=${config.subagents.maxChildrenPerOwner}; depth=1`
			: "disabled",
	});

	try {
		const automation = new AutomationStore(config.memory.dbPath);
		parseDuration(config.automation.heartbeat.every);
		automation.close();
		checks.push({
			name: "Automation",
			status: config.automation.enabled ? "PASS" : "WARN",
			detail: config.automation.enabled
				? `scheduler enabled; heartbeat ${config.automation.heartbeat.enabled ? config.automation.heartbeat.every : "disabled"}`
				: "disabled",
		});
	} catch (error) {
		checks.push({ name: "Automation", status: "FAIL", detail: error instanceof Error ? error.message : String(error) });
	}

	try {
		const skillsRoot = join(config.paths.agentDir, "skills");
		await mkdir(skillsRoot, { recursive: true });
		const entries = await readdir(skillsRoot, { withFileTypes: true });
		const count = entries.filter((entry) => entry.isDirectory()).length;
		checks.push({ name: "Skills", status: count ? "PASS" : "WARN", detail: `${count} installed; ${skillsRoot}` });
	} catch (error) {
		checks.push({ name: "Skills", status: "FAIL", detail: error instanceof Error ? error.message : String(error) });
	}

	const mcp = new McpManager();
	try {
		const statuses = await mcp.connectAll(loadMcpConfig(config.mcp.configPath));
		if (statuses.length === 0) checks.push({ name: "MCP", status: "PASS", detail: "no servers configured" });
		for (const status of statuses) checks.push({
			name: `MCP ${status.name}`,
			status: status.connected ? "PASS" : "WARN",
			detail: status.connected ? `${status.tools.length} tool(s)` : status.error ?? "connection failed",
		});
	} catch (error) {
		checks.push({ name: "MCP", status: "FAIL", detail: error instanceof Error ? error.message : String(error) });
	} finally {
		await mcp.close();
	}

	for (const check of checks) console.log(`${check.status.padEnd(4)}  ${check.name.padEnd(22)} ${check.detail}`);
	const ok = !checks.some((check) => check.status === "FAIL");
	console.log(ok ? "\nBeeMax configuration is ready to start." : "\nBeeMax is not ready; fix FAIL items before starting.");
	return ok;
}

function providerKeyEnv(provider: string): string {
	const map: Record<string, string> = {
		anthropic: "ANTHROPIC_API_KEY",
		openai: "OPENAI_API_KEY",
		google: "GOOGLE_GENERATIVE_AI_API_KEY",
		openrouter: "OPENROUTER_API_KEY",
	};
	return map[provider] ?? `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}
