import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

export function readEnvFileSync(path: string): Record<string, string> {
	try {
		return parseEnv(readFileSync(path, "utf8"));
	} catch {
		return {};
	}
}

export async function readEnvFile(path: string): Promise<Record<string, string>> {
	return parseEnv(await readFile(path, "utf8").catch(() => ""));
}

export async function writeEnvFile(path: string, values: Record<string, string>): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, renderEnv(values), { encoding: "utf8", mode: 0o600 });
	await chmod(path, 0o600);
}

export function parseEnv(raw: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const separator = trimmed.indexOf("=");
		if (separator < 1) continue;
		const key = trimmed.slice(0, separator).trim();
		if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue;
		const encoded = trimmed.slice(separator + 1).trim();
		if (encoded.startsWith('"')) {
			try {
				const value = JSON.parse(encoded);
				if (typeof value === "string") values[key] = value;
				continue;
			} catch { /* fall back to the literal value */ }
		}
		values[key] = encoded.startsWith("'") && encoded.endsWith("'")
			? encoded.slice(1, -1)
			: encoded;
	}
	return values;
}

export function renderEnv(values: Record<string, string>): string {
	return `${Object.entries(values).sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n")}\n`;
}
