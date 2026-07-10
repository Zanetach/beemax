/** GPT Image generation through ChatGPT/Codex OAuth, modeled on Hermes' provider. */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { SessionSource } from "./types.ts";

const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const SIZE = { landscape: "1536x1024", square: "1024x1024", portrait: "1024x1536" } as const;

export interface CodexImageToolOptions {
	outputDir: string;
	quality: "low" | "medium" | "high";
	getAccessToken: () => Promise<string | undefined>;
	deliver?: (source: SessionSource, imagePath: string) => Promise<void>;
}

export function createCodexImageTool(source: SessionSource, options: CodexImageToolOptions): ToolDefinition {
	return defineTool({
		name: "image_generate",
		label: "Generate Image",
		description: "Generate one PNG with GPT Image 2 through this profile's ChatGPT/Codex OAuth. Requires approval because it consumes an external image-generation quota.",
		parameters: Type.Object({
			prompt: Type.String({ minLength: 1, maxLength: 20_000 }),
			aspectRatio: Type.Optional(StringEnum(["landscape", "square", "portrait"] as const)),
		}),
		execute: async (_id, params, signal) => {
			const token = await options.getAccessToken();
			if (!token) throw new Error("Codex OAuth is not configured for this profile. Run: beemax auth codex --profile <name>");
			const aspect = params.aspectRatio ?? "landscape";
			const image = await generateCodexImage(token, params.prompt.trim(), SIZE[aspect], options.quality, signal);
			const outputDir = resolve(options.outputDir);
			await mkdir(outputDir, { recursive: true, mode: 0o700 });
			const path = join(outputDir, `gpt-image-2-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.png`);
			await writeFile(path, image, { mode: 0o600 });
			await options.deliver?.(source, path);
			return {
				content: [{ type: "text" as const, text: `Generated image: ${path}${options.deliver ? " (delivered to the current chat)" : ""}` }],
				details: { path, provider: "openai-codex", model: "gpt-image-2", quality: options.quality, aspectRatio: aspect },
			};
		},
	});
}

async function generateCodexImage(
	token: string,
	prompt: string,
	size: string,
	quality: "low" | "medium" | "high",
	signal?: AbortSignal,
): Promise<Buffer> {
	const accountId = extractAccountId(token);
	const timeout = AbortSignal.timeout(300_000);
	const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const response = await fetch(CODEX_URL, {
		method: "POST",
		signal: requestSignal,
		headers: {
			Accept: "text/event-stream",
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			"OpenAI-Beta": "responses=experimental",
			"chatgpt-account-id": accountId,
			originator: "pi",
			"User-Agent": `BeeMax/pi (${process.platform}; ${process.arch})`,
		},
		body: JSON.stringify({
			model: "gpt-5.4",
			store: false,
			instructions: "Use the image_generation tool to fulfill the user's image request.",
			input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }],
			tools: [{ type: "image_generation", model: "gpt-image-2", size, quality, output_format: "png", background: "opaque", partial_images: 1 }],
			tool_choice: { type: "allowed_tools", mode: "required", tools: [{ type: "image_generation" }] },
			stream: true,
		}),
	});
	if (!response.ok) {
		const body = (await response.text()).slice(0, 500);
		throw new Error(`Codex image API returned HTTP ${response.status}: ${body}`);
	}
	const raw = await response.text();
	let latest: string | undefined;
	for (const block of raw.split(/\r?\n\r?\n/)) {
		const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart()).join("\n").trim();
		if (!data || data === "[DONE]") continue;
		try { latest = extractImageBase64(JSON.parse(data)) ?? latest; } catch { /* Ignore malformed SSE events. */ }
	}
	if (!latest) throw new Error("Codex response contained no image_generation result");
	const image = Buffer.from(latest, "base64");
	if (image.length === 0 || image.length > 20 * 1024 * 1024) throw new Error("Generated image payload had an invalid size");
	return image;
}

function extractAccountId(token: string): string {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
		const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		if (typeof id !== "string" || !id) throw new Error("missing account id");
		return id;
	} catch {
		throw new Error("Could not extract ChatGPT account ID from Codex OAuth token");
	}
}

function extractImageBase64(value: unknown): string | undefined {
	if (Array.isArray(value)) {
		let found: string | undefined;
		for (const child of value) found = extractImageBase64(child) ?? found;
		return found;
	}
	if (!value || typeof value !== "object") return undefined;
	const item = value as Record<string, unknown>;
	let found = typeof item.partial_image_b64 === "string" ? item.partial_image_b64 : undefined;
	if (item.type === "image_generation_call" && typeof item.result === "string") found = item.result;
	for (const child of Object.values(item)) found = extractImageBase64(child) ?? found;
	return found;
}
