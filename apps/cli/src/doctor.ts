import { access, mkdir, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { AutomationStore, parseDuration } from "@beemax/automation";
import { validateFeishuWebhookSettings } from "@beemax/channel-feishu";
import { loadMcpConfig, McpManager } from "@beemax/mcp-capability";
import { MemoryStore } from "@beemax/memory";
import { AuthStorage, FileCredentialVault } from "@beemax/core";
import { consumeChannelCredential, type BeeMaxConfig } from "./config.ts";
import { providerApiKeyEnv } from "./provider-resolver.ts";
import { inspectOperationalMetrics, operationalMetricsPath } from "./operational-metrics.ts";
import { WeKnoraKnowledgeProvider } from "@beemax/knowledge";
import { ProfileModelCatalog } from "./model-catalog.ts";
import { createLocalMediaUnderstandingAdapters } from "./local-media-understanding.ts";

export interface DoctorCheck { name: string; status: "PASS" | "WARN" | "FAIL"; detail: string }
export interface DoctorResult { ok: boolean; checks: DoctorCheck[] }
const execFileAsync = promisify(execFile);

export interface DoctorOptions { requireGateway?: boolean; json?: boolean }

export async function runDoctor(config: BeeMaxConfig, options: DoctorOptions = {}): Promise<boolean> {
	const result = await inspectDoctor(config, options);
	if (options.json) console.log(JSON.stringify(result));
	else {
		for (const check of result.checks) console.log(`${check.status.padEnd(4)}  ${check.name.padEnd(22)} ${check.detail}`);
		console.log(result.ok ? "\nBeeMax configuration is ready to start." : "\nBeeMax is not ready; fix FAIL items before starting.");
	}
	return result.ok;
}

export async function inspectDoctor(config: BeeMaxConfig, options: DoctorOptions = {}): Promise<DoctorResult> {
	const checks: DoctorCheck[] = [];
	const node = process.versions.node.split(".").map(Number);
	checks.push({ name: "Node.js", status: node[0] > 22 || (node[0] === 22 && node[1] >= 19) ? "PASS" : "FAIL", detail: process.versions.node });

	const apiKey = config.model.apiKey;
	checks.push({ name: "Model", status: apiKey ? "PASS" : "FAIL", detail: apiKey ? `${config.model.provider}/${config.model.model}` : `missing ${providerApiKeyEnv(config.model.provider)} or BEEMAX_API_KEY` });
	const modelCatalog = new ProfileModelCatalog(config);
	const currentModel = modelCatalog.resolve(`${config.model.provider}/${config.model.model}`);
	const nativeVision = currentModel?.capabilities?.input.includes("image") ?? false;
	const auxiliaryVision = config.mediaUnderstanding.auxiliaryVisionEnabled
		? modelCatalog.list().filter((model) => model.available && model.key !== currentModel?.key && model.capabilities?.input.includes("image"))
		: [];
	const localOcr = createLocalMediaUnderstandingAdapters(config.mediaUnderstanding.localOcr);
	const perception = [
		...(nativeVision ? ["native vision"] : []),
		...auxiliaryVision.map((model) => `auxiliary ${model.key}`),
		...localOcr.map((adapter) => adapter.id),
	];
	checks.push({ name: "Media understanding", status: perception.length ? "PASS" : "WARN", detail: perception.length ? perception.join("; ") : "unavailable: configure an image-capable model or install Tesseract OCR" });
	checks.push({ name: "Toolset", status: config.agent.toolset === "safe" ? "WARN" : "PASS", detail: config.agent.toolset });
	await checkExecutionBackend(config, checks);
	const gatewayRequired = options.requireGateway ?? true;
	const enabledChannels = config.gateway.channels.filter((channel) => channel.enabled);
	checks.push({ name: "Gateway channels", status: enabledChannels.length ? "PASS" : gatewayRequired ? "FAIL" : "WARN", detail: enabledChannels.length ? enabledChannels.map((channel) => `${channel.id}:${channel.adapter}`).join(", ") : "none enabled" });
	if (enabledChannels.some((channel) => channel.adapter === "feishu")) {
		const feishuChannels = enabledChannels.filter((channel) => channel.adapter === "feishu");
		const credentials = feishuChannels.every((channel) => consumeChannelCredential(config, channel, (credential) => credential.adapter === "feishu") === true);
		checks.push({ name: "Feishu credentials", status: credentials ? "PASS" : "FAIL", detail: credentials ? "configured" : "not configured" });
		const admitted = config.gateway.feishu.allowAllUsers || config.gateway.feishu.allowedUsers.length > 0;
		checks.push({ name: "Feishu access", status: admitted ? (config.gateway.feishu.allowAllUsers ? "WARN" : "PASS") : "FAIL", detail: admitted ? (config.gateway.feishu.allowAllUsers ? "public/dev mode" : `${config.gateway.feishu.allowedUsers.length} allowed user(s)`) : "not configured" });
		try {
			const valid = feishuChannels.some((channel) => consumeChannelCredential(config, channel, (credential) => credential.adapter === "feishu" ? (validateFeishuWebhookSettings({ ...config.gateway.feishu, ...credential }), true) : false) === true);
			if (!valid) throw new Error("Feishu credentials are not configured");
			checks.push({ name: "Feishu transport", status: credentials ? "PASS" : "FAIL", detail: config.gateway.feishu.connectionMode });
		} catch (error) {
			checks.push({ name: "Feishu transport", status: "FAIL", detail: error instanceof Error ? error.message : String(error) });
		}
	}
	if (enabledChannels.some((channel) => channel.adapter === "telegram")) {
		const credentials = enabledChannels.filter((channel) => channel.adapter === "telegram")
			.every((channel) => consumeChannelCredential(config, channel, (credential) => credential.adapter === "telegram") === true);
		const admitted = config.gateway.telegram.allowAllUsers || config.gateway.telegram.allowedUsers.length > 0;
		checks.push({ name: "Telegram credentials", status: credentials ? "PASS" : "FAIL", detail: credentials ? "configured" : "not configured" });
		checks.push({ name: "Telegram access", status: admitted ? (config.gateway.telegram.allowAllUsers ? "WARN" : "PASS") : "FAIL", detail: admitted ? (config.gateway.telegram.allowAllUsers ? "public/dev mode" : `${config.gateway.telegram.allowedUsers.length} allowed user(s)`) : "not configured" });
	}

	try {
		await access(config.paths.cwd, constants.R_OK | constants.W_OK);
		checks.push({ name: "Workspace", status: "PASS", detail: config.paths.cwd });
	} catch (error) {
		checks.push({ name: "Workspace", status: "FAIL", detail: error instanceof Error ? error.message : String(error) });
	}
	const profileWorkspace = join(config.paths.agentDir, "workspace");
	checks.push({
		name: "Profile workspace",
		status: config.paths.cwd === profileWorkspace ? "PASS" : "WARN",
		detail: config.paths.cwd === profileWorkspace ? "isolated" : `shared or custom path: ${config.paths.cwd}`,
	});

	try {
		const memory = new MemoryStore(config.memory.dbPath, config.profile);
		memory.close();
		checks.push({ name: "Memory", status: "PASS", detail: config.memory.dbPath });
	} catch (error) {
		checks.push({ name: "Memory", status: "FAIL", detail: error instanceof Error ? error.message : String(error) });
	}

	try {
		if (!config.credentials.key) throw new Error("Profile Vault key is missing");
		const keyFile = await stat(config.credentials.keyPath).catch(() => undefined);
		if (keyFile && (keyFile.mode & 0o077) !== 0) throw new Error(`Vault key permissions are broader than 0600: ${config.credentials.keyPath}`);
		const vault = new FileCredentialVault(config.credentials.vaultPath, Buffer.from(config.credentials.key, "base64"));
		checks.push({ name: "Credential Vault", status: "PASS", detail: `${vault.list(`profile:${config.profile}`).length} credential(s); encrypted storage; ${keyFile ? "protected Profile key" : "external key"}` });
	} catch (error) {
		checks.push({ name: "Credential Vault", status: "FAIL", detail: error instanceof Error ? error.message : String(error) });
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
		const auditDir = join(config.paths.agentDir, "logs");
		await mkdir(auditDir, { recursive: true, mode: 0o700 });
		await access(auditDir, constants.W_OK);
		checks.push({ name: "Approval audit", status: "PASS", detail: join(auditDir, "gateway.jsonl") });
	} catch (error) {
		checks.push({ name: "Approval audit", status: "FAIL", detail: error instanceof Error ? error.message : String(error) });
	}

	try {
		await mkdir(config.paths.agentDir, { recursive: true, mode: 0o700 });
		await access(config.paths.agentDir, constants.R_OK | constants.W_OK);
		const journalPath = join(config.paths.agentDir, "interaction-events.jsonl");
		const existing = await stat(journalPath).catch(() => undefined);
		const privateEnough = !existing || (existing.mode & 0o077) === 0;
		checks.push({ name: "Interaction recovery", status: privateEnough ? "PASS" : "WARN", detail: privateEnough ? `privacy-safe journal ready; ${journalPath}` : `journal permissions are broader than 0600: ${journalPath}` });
	} catch (error) {
		checks.push({ name: "Interaction recovery", status: "FAIL", detail: error instanceof Error ? error.message : String(error) });
	}
	checks.push({ name: "Interaction protocol", status: "PASS", detail: "v1 scope-bound control contract available" });
	if (!config.knowledge.enabled) {
		checks.push({ name: "Knowledge Kernel", status: "WARN", detail: "disabled" });
	} else if (!config.knowledge.apiKey || config.knowledge.spaces.length === 0) {
		checks.push({
			name: "Knowledge Kernel",
			status: "FAIL",
			detail: !config.knowledge.apiKey ? "missing BEEMAX_WEKNORA_API_KEY" : "no knowledge spaces configured",
		});
	} else {
		const provider = new WeKnoraKnowledgeProvider({ baseUrl: config.knowledge.baseUrl, apiKey: config.knowledge.apiKey });
		const health = await provider.healthCheck();
		checks.push({
			name: "Knowledge Kernel",
			status: health.healthy ? "PASS" : "FAIL",
			detail: health.healthy
				? `${config.knowledge.spaces.length} space(s); ${config.knowledge.baseUrl}`
				: `unavailable (${health.status || "network error"}); ${config.knowledge.baseUrl}`,
		});
	}
	try {
		const metrics = inspectOperationalMetrics(config.paths.agentDir);
		const status = !metrics.available || !metrics.permissionsSafe || metrics.alerts.length ? "WARN" : "PASS";
		const detail = !metrics.available ? `no metrics recorded yet; ${operationalMetricsPath(config.paths.agentDir)}` : !metrics.permissionsSafe ? `permissions are broader than 0600: ${operationalMetricsPath(config.paths.agentDir)}` : metrics.alerts.length ? `${metrics.alerts.length} active alert(s): ${metrics.alerts.map((alert) => alert.code).join(", ")}` : `${metrics.events} recent event(s); ${operationalMetricsPath(config.paths.agentDir)}`;
		checks.push({ name: "Operational metrics", status, detail });
	} catch (error) {
		checks.push({ name: "Operational metrics", status: "WARN", detail: error instanceof Error ? error.message : String(error) });
	}

	try {
		const automation = new AutomationStore(config.memory.dbPath);
		parseDuration(config.automation.heartbeat.every);
		const snapshot = automation.status();
		automation.close();
		checks.push({
			name: "Automation",
			status: config.automation.enabled && snapshot.deliveryAbandoned === 0 ? "PASS" : "WARN",
			detail: config.automation.enabled
				? `scheduler enabled; due=${snapshot.due}; claimed=${snapshot.claimed}; retrying=${snapshot.retrying}; delivery queued=${snapshot.deliveryQueued}; abandoned=${snapshot.deliveryAbandoned}; heartbeat ${config.automation.heartbeat.enabled ? config.automation.heartbeat.every : "disabled"}`
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

	const ok = !checks.some((check) => check.status === "FAIL");
	return { ok, checks };
}

async function checkExecutionBackend(config: BeeMaxConfig, checks: DoctorCheck[]): Promise<void> {
	const detail = `${config.execution.backend}; mode=${config.execution.mode}; workspace=${config.execution.workspaceAccess}`;
	if (config.execution.mode === "off") {
		checks.push({ name: "Execution Sandbox", status: "WARN", detail: `disabled; Host Execution Adapter has the BeeMax process user's authority (${detail})` });
		return;
	}
	if (config.execution.backend !== "docker") {
		checks.push({ name: "Execution Sandbox", status: "FAIL", detail: `Sandbox mode 'all' requires Docker (${detail})` });
		return;
	}
	try {
		const { stdout } = await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 5_000 });
		checks.push({ name: "Execution Sandbox", status: "PASS", detail: `Docker ${stdout.trim()}; ${detail}` });
	} catch (error) {
		checks.push({ name: "Execution Sandbox", status: "FAIL", detail: `Docker unavailable: ${error instanceof Error ? error.message : String(error)}` });
	}
}
