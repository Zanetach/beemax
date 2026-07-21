/**
 * Feishu CardKit v2.0 card renderer. Ported from render.py - produces the
 * interactive card JSON the lark SDK sends as msg_type "interactive".
 *
 * Card structure:
 *   header  -> status-colored title (green=done, red=failed, blue=streaming, indigo=thinking)
 *   body    -> main answer markdown (chunked) + collapsible timeline panel + footer
 */

import type { CardSession } from "./session.ts";
import type { PublishedArtifactPresentation } from "@beemax/channel-runtime";
import { splitMarkdownBlocks, countMarkdownTables, MAX_CARD_TABLES, normalizeStreamText } from "./text.ts";

const MAIN_CONTENT_CHUNK_CHARS = 2400;
const DEFAULT_TITLE = "BeeMax Agent";
const MAX_TIMELINE_ITEMS = 12;
const MAX_REASONING_CHARS = 1200;
const MAX_TOOL_RESULT_CHARS = 600;
const MAX_CARD_SUMMARY_CHARS = 6_000;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface CardRenderOptions {
	title?: string;
	footerFields?: string[];
	/** Raw reasoning is for an explicitly trusted diagnostic profile only. */
	reasoningDisplay?: "off" | "summary" | "raw";
	/** Use one stable markdown element and let CardKit animate content updates. */
	streaming?: boolean;
	/** Trusted publication metadata supplied by the Gateway Artifact boundary. */
	publishedArtifacts?: readonly PublishedArtifactPresentation[];
}

export function spinnerFrame(): string {
	return SPINNER_FRAMES[Math.floor((Date.now() / 125) % SPINNER_FRAMES.length)];
}

export function renderCard(session: CardSession, opts: CardRenderOptions = {}): Record<string, unknown> {
	const title = (opts.title ?? DEFAULT_TITLE).trim() || DEFAULT_TITLE;
	const status = renderStatus(session);
	const projection = projectCardContent(session, opts.publishedArtifacts);
	let primaryText = projection.content;

	// Cap tables at MAX_CARD_TABLES to avoid Feishu rejecting huge card payloads.
	if (countMarkdownTables(primaryText) > MAX_CARD_TABLES) {
		primaryText = capTables(primaryText);
	}

	const elements: Record<string, unknown>[] = [];
	elements.push(...(opts.streaming
		? [{ tag: "markdown", element_id: "main_content", content: primaryText }]
		: renderMainContent(primaryText)));
	if (projection.artifacts.length) {
		elements.push({ tag: "markdown", element_id: "artifact_heading", content: "**交付文件**" });
		elements.push(...renderArtifactActions(projection.artifacts));
	}

	const timelineElements = projection.summarized ? [] : renderTimeline(session, opts.reasoningDisplay === "raw");
	elements.push(...timelineElements);
	elements.push({ tag: "hr", element_id: "main_divider" });
	if (!timelineElements.length) {
		elements.push({ tag: "markdown", element_id: "tool_summary", content: renderToolSummary(session) });
	}
	elements.push({
		tag: "markdown",
		element_id: "footer",
		content: renderFooter(session, opts.footerFields),
		text_size: "x-small",
	});

	const header: Record<string, unknown> = {
		template: status.template,
		title: { tag: "plain_text", content: title },
	};
	if (status.subtitle) header.subtitle = { tag: "plain_text", content: status.subtitle };

	const config: Record<string, unknown> = { update_multi: true, summary: { content: status.summary ?? status.subtitle } };
	if (opts.streaming) {
		config.streaming_mode = true;
		config.streaming_config = {
			print_frequency_ms: { default: 70 },
			print_step: { default: 1 },
			print_strategy: "fast",
		};
	}

	return {
		schema: "2.0",
		config,
		header,
		body: { elements },
	};
}

export function renderStreamingContent(session: CardSession, publishedArtifacts: readonly PublishedArtifactPresentation[] = []): string {
	return projectCardContent(session, publishedArtifacts).content;
}

export function answerNeedsSeparateDelivery(answer: string, _publishedArtifacts: readonly PublishedArtifactPresentation[] = []): boolean {
	return normalizeStreamText(answer).length > MAX_CARD_SUMMARY_CHARS;
}

function rawPrimaryText(session: CardSession): string {
	const answer = normalizeStreamText(session.answerText);
	if (answer) return answer;
	return session.status === "thinking"
		? normalizeStreamText(session.progressText) || `处理中 ${spinnerFrame()}`
		: normalizeStreamText(session.visibleMainText);
}

function projectCardContent(session: CardSession, publishedArtifacts: readonly PublishedArtifactPresentation[] = []): { content: string; artifacts: PublishedArtifactPresentation[]; summarized: boolean } {
	const artifacts = validatedPublishedArtifacts(publishedArtifacts);
	let content = rawPrimaryText(session).trimEnd();
	if (!content && artifacts.length) content = "文件已生成，可直接在线打开或下载。";
	if (content.length <= MAX_CARD_SUMMARY_CHARS) return { content, artifacts, summarized: false };
	const notice = session.status === "thinking"
		? artifacts.length
			? "\n\n> 内容较长，正在继续生成；卡片将保持摘要视图，已生成文件可通过下方按钮打开。"
			: "\n\n> 内容较长，正在继续生成；卡片将保持摘要视图。"
		: artifacts.length
			? "\n\n> 内容较长，卡片仅显示摘要；完整回答已另行发送，文件可通过下方按钮打开。"
			: "\n\n> 内容较长，卡片仅显示摘要；完整回答已另行发送。";
	const budget = Math.max(1, MAX_CARD_SUMMARY_CHARS - notice.length);
	return { content: `${semanticPrefix(content, budget).trimEnd()}${notice}`, artifacts, summarized: true };
}

function validatedPublishedArtifacts(artifacts: readonly PublishedArtifactPresentation[]): PublishedArtifactPresentation[] {
	const seen = new Set<string>();
	return artifacts.flatMap((artifact) => {
		if (!safeHttpUrl(artifact.url) || seen.has(artifact.url)) return [];
		seen.add(artifact.url);
		return [{ ...artifact, name: compactArtifactName(artifact.name) }];
	}).slice(0, 6);
}

function compactArtifactName(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 120) || "文件";
}

function renderArtifactActions(artifacts: readonly PublishedArtifactPresentation[]): Record<string, unknown>[] {
	return artifacts.map((artifact, index) => ({
		tag: "button",
		element_id: `artifact_action_${index}`,
		text: { tag: "plain_text", content: `${artifact.disposition === "attachment" ? "下载" : "在线打开"} ${artifact.name}` },
		type: index === 0 ? "primary" : "default",
		width: "fill",
		size: "medium",
		behaviors: [{ type: "open_url", default_url: artifact.url, pc_url: "", ios_url: "", android_url: "" }],
	}));
}

function semanticPrefix(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const window = text.slice(0, limit);
	const candidates = [window.lastIndexOf("\n\n"), window.lastIndexOf("。"), window.lastIndexOf("！"), window.lastIndexOf("？"), window.lastIndexOf("\n")];
	const boundary = Math.max(...candidates);
	return boundary >= Math.floor(limit * 0.7) ? window.slice(0, boundary + 1) : window;
}

function safeHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
	} catch {
		return false;
	}
}

function renderStatus(session: CardSession): { subtitle: string; template: string; summary?: string } {
	if (session.status === "completed") return { subtitle: cardStatusSummary(session.status), template: "green" };
	if (session.status === "incomplete") return { subtitle: cardStatusSummary(session.status), template: "yellow" };
	if (session.status === "rejected") return { subtitle: cardStatusSummary(session.status), template: "red" };
	if (session.status === "failed") return { subtitle: cardStatusSummary(session.status), template: "red" };
	if (session.status === "cancelled") return { subtitle: cardStatusSummary(session.status), template: "grey" };
	if (normalizeStreamText(session.answerText).trim()) return { subtitle: "", summary: "处理中", template: "blue" };
	return { subtitle: "", summary: "处理中", template: "indigo" };
}

export function cardStatusSummary(status: CardSession["status"]): string {
	if (status === "completed") return "已完成";
	if (status === "incomplete") return "尚未完成";
	if (status === "rejected") return "验证未通过";
	if (status === "failed") return "处理失败";
	if (status === "cancelled") return "已取消";
	return "处理已结束";
}

function renderMainContent(text: string): Record<string, unknown>[] {
	const chunks = splitMarkdownBlocks(text, MAIN_CONTENT_CHUNK_CHARS);
	return chunks.map((chunk, i) => ({
		tag: "markdown",
		element_id: i === 0 ? "main_content" : `main_content_${i}`,
		content: chunk,
	}));
}

function renderToolSummary(session: CardSession): string {
	if (!session.tools.size) return "工具调用 0 次";
	const lines = [`工具调用 ${session.toolCount} 次`];
	for (const tool of session.tools.values()) lines.push(`- \`${tool.name}\`: ${tool.status}`);
	return lines.join("\n");
}

function renderTimeline(session: CardSession, showRawReasoning: boolean): Record<string, unknown>[] {
	const all = session.timeline.snapshot(MAX_TIMELINE_ITEMS).filter((entry) => showRawReasoning || entry.kind !== "reasoning");
	const folded = session.timeline.foldedCount(MAX_TIMELINE_ITEMS);
	if (!all.length && !folded) return [];

	const panelElements: Record<string, unknown>[] = [];
	if (folded) {
		panelElements.push({
			tag: "markdown",
			element_id: "aux_folded",
		content: `> 已折叠 ${folded} 条早期执行记录`,
			text_size: "x-small",
		});
	}

	for (let i = 0; i < all.length; i++) {
		const entry = all[i];
		if (entry.kind === "reasoning") {
			const content = limitText(entry.content, MAX_REASONING_CHARS, "思考内容过长，已截断");
			panelElements.push({ tag: "markdown", element_id: `aux_reason_${i}`, content: `**${entry.title}** · ${entry.status}\n${content}`, text_size: "small" });
		} else if (entry.kind === "tool") {
			const detail = limitText(entry.detail, MAX_TOOL_RESULT_CHARS, "工具详情过长，已截断");
			const lines = [`\`${entry.title}\` · ${entry.status}`];
			if (detail) lines.push(detail);
			panelElements.push({
				tag: "markdown",
				element_id: `aux_tool_${i}`,
				content: quoteMarkdown(lines.join("\n")),
				text_size: "x-small",
			});
		} else {
			const content = limitText(normalizeStreamText(entry.content), MAX_TOOL_RESULT_CHARS, "提示内容过长，已截断");
			const lines = [`**${entry.title}** · ${entry.status}`];
			if (content) lines.push(content);
			panelElements.push({
				tag: "markdown",
				element_id: `aux_notice_${i}`,
				content: quoteMarkdown(lines.join("\n")),
				text_size: "x-small",
			});
		}
	}

	if (!panelElements.length) return [];
	return [
		{
			tag: "collapsible_panel",
			element_id: "auxiliary_timeline",
			expanded: false,
			header: {
				title: { tag: "plain_text", content: `执行详情 · ${session.toolCount} 次工具调用` },
				vertical_align: "center",
			},
			border: { color: "grey", corner_radius: "5px" },
			padding: "8px 8px 8px 8px",
			elements: panelElements,
		},
	];
}

function quoteMarkdown(content: string): string {
	return content
		.split("\n")
		.map((l) => (l ? `> ${l}` : ">"))
		.join("\n");
}

function capTables(text: string): string {
	const sepRe = /^\|[-: ]+\|/gm;
	const matches = [...text.matchAll(sepRe)];
	if (matches.length <= MAX_CARD_TABLES) return text;
	const cutoff = matches[MAX_CARD_TABLES - 1].index! + matches[MAX_CARD_TABLES - 1][0].length;
	const rest = text.slice(cutoff);
	const nextPara = rest.search(/\n\n/);
	const end = nextPara >= 0 ? cutoff + nextPara : text.length;
	return text.slice(0, end).replace(/\s+$/, "") + "\n\n> 内容含超过 5 个表格，超出部分已省略。";
}

function limitText(text: string, limit: number, overflowLabel: string): string {
	if (limit <= 0 || text.length <= limit) return text;
	const suffix = `\n> ${overflowLabel}`;
	return text.slice(0, Math.max(0, limit - suffix.length)).replace(/\s+$/, "") + suffix;
}

function renderFooter(session: CardSession, fields?: string[]): string {
	if (session.status === "failed" || session.status === "cancelled") return "已停止";
	if (session.status !== "completed") return `${spinnerFrame()} 处理中`;
	const inputTokens = safeInt(session.tokens.input_tokens);
	const outputTokens = safeInt(session.tokens.output_tokens);
	const usedContext = safeInt(session.context.used_tokens);
	const maxContext = safeInt(session.context.max_tokens);
	const contextPercent = maxContext > 0 ? Math.round((usedContext / maxContext) * 100) : 0;
	const model = session.model || "Unknown";
	const values: Record<string, string> = {
		duration: formatDuration(session.duration),
		model,
		input_tokens: `↑${formatCount(inputTokens)}`,
		output_tokens: `↓${formatCount(outputTokens)}`,
		context: `ctx ${formatCount(usedContext)}/${formatCount(maxContext)} ${contextPercent}%`,
	};
	const selected: string[] = [];
	const list = fields ?? ["duration", "model", "input_tokens", "output_tokens", "context"];
	for (const f of list) {
		const v = values[f];
		if (v) selected.push(v);
	}
	return selected.length ? selected.join(" · ") : values.duration;
}

function safeInt(v: unknown): number {
	const n = typeof v === "number" ? v : Number(v);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

function formatDuration(seconds: number): string {
	const total = Math.max(0, Math.round(seconds));
	const m = Math.floor(total / 60);
	const s = total % 60;
	const h = Math.floor(m / 60);
	const mm = m % 60;
	if (h) return `${h}h${mm}m${s}s`;
	if (m) return `${m}m${s}s`;
	return `${s}s`;
}

function formatCount(v: number): string {
	if (v >= 1_000_000) return formatScaled(v, 1_000_000, "m");
	if (v >= 1_000) return formatScaled(v, 1_000, "k");
	return String(v);
}

function formatScaled(v: number, factor: number, suffix: string): string {
	const scaled = v / factor;
	if (scaled >= 100 || Number.isInteger(scaled)) return `${Math.round(scaled)}${suffix}`;
	return `${scaled.toFixed(1).replace(/0$/, "").replace(/\.$/, "")}${suffix}`;
}
