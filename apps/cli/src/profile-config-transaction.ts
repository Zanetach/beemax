import { open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { acquireProcessLock } from "./process-lock.ts";

export async function mutateProfileConfig(
	configPath: string,
	mutate: (config: Record<string, unknown>) => void | Promise<void>,
): Promise<void> {
	const release = await acquireProcessLock(dirname(configPath), `profile-config:${resolve(configPath)}`, "Profile configuration");
	let temporary: string | undefined;
	try {
		const config = (parseYaml(await readFile(configPath, "utf8")) ?? {}) as Record<string, unknown>;
		await mutate(config);
		temporary = `${configPath}.update-${crypto.randomUUID()}`;
		await writeFile(temporary, stringifyYaml(config), { encoding: "utf8", mode: 0o600, flag: "wx" });
		const file = await open(temporary, "r");
		try { await file.sync(); } finally { await file.close(); }
		await rename(temporary, configPath);
		temporary = undefined;
		const directory = await open(dirname(configPath), "r");
		try { await directory.sync(); } finally { await directory.close(); }
	} finally {
		if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
		await release();
	}
}
