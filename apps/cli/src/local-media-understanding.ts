import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import type { MediaUnderstandingAdapter, MediaUnderstandingAdapterResult, MediaUnderstandingEvaluation, MediaUnderstandingRequest } from "@beemax/core";

const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;

export interface LocalMediaUnderstandingOptions {
	enabled?: boolean;
	command?: string;
	languages?: string;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
}

export interface LocalCommandInput {
	command: string;
	args: string[];
	stdin: Buffer;
	timeoutMs: number;
	env: NodeJS.ProcessEnv;
	signal?: AbortSignal;
}

export interface LocalCommandResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

export type LocalCommandRunner = (input: LocalCommandInput) => Promise<LocalCommandResult>;

export interface LocalTesseractMediaAdapterOptions {
	command: string;
	languages?: string;
	timeoutMs?: number;
	run?: LocalCommandRunner;
	/** Host-owned environment snapshot; Profile .env values must never be passed here. */
	environment?: NodeJS.ProcessEnv;
}

/** Local OCR adapter. Image bytes use stdin, so no temporary path crosses the seam. */
export class LocalTesseractMediaAdapter implements MediaUnderstandingAdapter {
	readonly id = "local-ocr:tesseract";
	private readonly command: string;
	private readonly languages?: string;
	private readonly timeoutMs: number;
	private readonly run: LocalCommandRunner;
	private readonly environment: NodeJS.ProcessEnv;

	constructor(options: LocalTesseractMediaAdapterOptions) {
		this.command = options.command;
		this.languages = options.languages?.trim() || undefined;
		this.timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 30_000, 300_000));
		this.run = options.run ?? runLocalCommand;
		this.environment = localOcrRuntimeEnvironment(options.environment ?? process.env);
	}

	evaluate(request: MediaUnderstandingRequest): MediaUnderstandingEvaluation | undefined {
		if (!request.images.some((image) => image.mimeType.startsWith("image/"))) return undefined;
		const explicitTextExtraction = /\b(?:ocr|read|extract|transcribe|text|words?|characters?)\b|(?:提取|读取|文字|文本|字幕)/iu.test(request.text);
		return {
			score: explicitTextExtraction ? 95 : 60,
			reason: explicitTextExtraction
				? "the request explicitly asks for text extraction that local OCR can verify"
				: "local OCR accepts image input without sending media to a remote provider",
		};
	}

	async understand(request: MediaUnderstandingRequest): Promise<MediaUnderstandingAdapterResult> {
		const outputs: Array<{ kind: string; content: string; confidence?: number }> = [];
		const warnings: string[] = [];
		for (const [index, image] of request.images.entries()) {
			const args = ["stdin", "stdout", ...(this.languages ? ["-l", this.languages] : []), "tsv"];
			const result = await this.run({ command: this.command, args, stdin: Buffer.from(image.data, "base64"), timeoutMs: this.timeoutMs, env: this.environment, signal: request.signal });
			if (result.exitCode !== 0) throw new Error(`Tesseract exited with code ${result.exitCode}: ${result.stderr.slice(0, 500)}`);
			const parsed = parseTesseractTsv(result.stdout);
			if (parsed.content) outputs.push({ kind: "text", content: request.images.length > 1 ? `[image ${index + 1}]\n${parsed.content}` : parsed.content, ...(parsed.confidence === undefined ? {} : { confidence: parsed.confidence }) });
			if (result.stderr.trim()) warnings.push(`image ${index + 1}: ${result.stderr.trim().slice(0, 500)}`);
		}
		return { adapterId: this.id, engine: "tesseract", outputs, warnings };
	}
}

export function parseTesseractTsv(value: string): { content: string; confidence?: number } {
	const lines = value.trim().split(/\r?\n/);
	if (!/^level\tpage_num\t/i.test(lines[0] ?? "")) return { content: value.trim() };
	const textByLine = new Map<string, string[]>();
	const confidences: number[] = [];
	for (const line of lines.slice(1)) {
		const columns = line.split("\t");
		if (columns.length < 12) continue;
		const text = columns.slice(11).join("\t").trim();
		const confidence = Number(columns[10]);
		if (!text || !Number.isFinite(confidence) || confidence < 0) continue;
		const lineKey = columns.slice(1, 5).join(":");
		const words = textByLine.get(lineKey) ?? [];
		words.push(text);
		textByLine.set(lineKey, words);
		confidences.push(confidence / 100);
	}
	const content = [...textByLine.values()].map((words) => words.join(" ")).join("\n").trim();
	const confidence = confidences.length ? confidences.reduce((sum, item) => sum + item, 0) / confidences.length : undefined;
	return { content, ...(confidence === undefined ? {} : { confidence: Math.round(Math.max(0, Math.min(1, confidence)) * 1_000_000) / 1_000_000 }) };
}

/** Zero-configuration discovery: installed local OCR is used; absent OCR stays absent. */
export function createLocalMediaUnderstandingAdapters(options: LocalMediaUnderstandingOptions = {}): MediaUnderstandingAdapter[] {
	if (options.enabled === false) return [];
	const env = options.env ?? process.env;
	const command = findExecutable(options.command?.trim() || "tesseract", env);
	return command ? [new LocalTesseractMediaAdapter({ command, languages: options.languages, timeoutMs: options.timeoutMs, environment: env })] : [];
}

/** Host-only resolver used by Profile config composition. */
export function resolveLocalOcrHostCommand(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const configured = env.BEEMAX_LOCAL_OCR_COMMAND?.trim();
	if (configured && !isAbsolute(configured)) throw new Error("Trusted host BEEMAX_LOCAL_OCR_COMMAND must be an absolute executable path");
	return findExecutable(configured || "tesseract", env);
}

export function findExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const candidate = command.trim();
	if (!candidate) return undefined;
	if (isAbsolute(candidate) || candidate.includes("/")) return executable(candidate);
	for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
		const path = join(directory, candidate);
		const trusted = executable(path);
		if (trusted) return trusted;
	}
	return undefined;
}

export const runLocalCommand: LocalCommandRunner = (input) => new Promise((resolve, reject) => {
	let settled = false;
	let stdoutBytes = 0;
	let stderrBytes = 0;
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	const child = spawn(input.command, input.args, { shell: false, stdio: ["pipe", "pipe", "pipe"], signal: input.signal, env: input.env });
	const timeout = setTimeout(() => child.kill("SIGKILL"), input.timeoutMs);
	const fail = (error: unknown) => {
		if (settled) return;
		settled = true;
		clearTimeout(timeout);
		try { child.kill("SIGKILL"); } catch { /* process already exited */ }
		reject(error);
	};
	child.on("error", fail);
	child.stdout.on("data", (chunk: Buffer) => {
		stdoutBytes += chunk.length;
		if (stdoutBytes > MAX_PROCESS_OUTPUT_BYTES) return fail(new Error("Local OCR stdout exceeded 1MB"));
		stdout.push(chunk);
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderrBytes += chunk.length;
		if (stderrBytes > MAX_PROCESS_OUTPUT_BYTES) return fail(new Error("Local OCR stderr exceeded 1MB"));
		stderr.push(chunk);
	});
	child.on("close", (exitCode) => {
		if (settled) return;
		settled = true;
		clearTimeout(timeout);
		resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode });
	});
	child.stdin.on("error", fail);
	child.stdin.end(input.stdin);
});

function executable(path: string): string | undefined {
	try {
		const info = lstatSync(path);
		if (info.isSymbolicLink() || !info.isFile()) return undefined;
		accessSync(path, constants.X_OK);
		return realpathSync(path);
	} catch { return undefined; }
}

function localOcrRuntimeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return {
		...(source.PATH ? { PATH: source.PATH } : {}),
		...(source.LANG ? { LANG: source.LANG } : {}),
		...(source.LC_ALL ? { LC_ALL: source.LC_ALL } : {}),
		...(source.LC_CTYPE ? { LC_CTYPE: source.LC_CTYPE } : {}),
		...(source.TESSDATA_PREFIX ? { TESSDATA_PREFIX: source.TESSDATA_PREFIX } : {}),
	};
}
