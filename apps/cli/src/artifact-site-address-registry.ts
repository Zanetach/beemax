import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { acquireChannelLock } from "./channel-lock.ts";
import { parseArtifactSiteListen } from "./artifact-site.ts";
import { validateProfileName } from "./profile-home.ts";

const SCHEMA_VERSION = 1;
const AUTO_PORT_MIN = 12_000;
const AUTO_PORT_COUNT = 20_000;

interface ArtifactSiteAddressRegistry {
	schemaVersion: typeof SCHEMA_VERSION;
	profiles: Record<string, { listen: string }>;
}

export interface ProfileArtifactSiteListenRequest {
	home: string;
	profile: string;
	preferredListen: string;
	automatic: boolean;
}

/** Persist one collision-free Caddy listen address for every enabled Profile. */
export async function reserveProfileArtifactSiteListen(request: ProfileArtifactSiteListenRequest): Promise<string> {
	validateProfileName(request.profile);
	const home = resolve(request.home);
	const preferred = parseArtifactSiteListen(request.preferredListen);
	const release = await acquireRegistryLock(home);
	try {
		const path = resolve(home, "state", "artifact-site-addresses.json");
		const registry = await readRegistry(path);
		const ownersByPort = new Map<number, string>();
		for (const [profile, allocation] of Object.entries(registry.profiles)) {
			const { port } = parseArtifactSiteListen(allocation.listen);
			const prior = ownersByPort.get(port);
			if (prior) throw new Error(`Artifact Site address registry assigns port ${port} to both ${prior} and ${profile}`);
			ownersByPort.set(port, profile);
		}
		const current = registry.profiles[request.profile];
		if (request.automatic && current) return current.listen;
		if (current) ownersByPort.delete(parseArtifactSiteListen(current.listen).port);

		let listen = request.preferredListen;
		if (request.automatic) {
			const start = preferred.port >= AUTO_PORT_MIN && preferred.port < AUTO_PORT_MIN + AUTO_PORT_COUNT
				? preferred.port
				: AUTO_PORT_MIN + preferred.port % AUTO_PORT_COUNT;
			let allocatedPort: number | undefined;
			for (let offset = 0; offset < AUTO_PORT_COUNT; offset += 1) {
				const candidate = AUTO_PORT_MIN + (start - AUTO_PORT_MIN + offset) % AUTO_PORT_COUNT;
				if (!ownersByPort.has(candidate)) { allocatedPort = candidate; break; }
			}
			if (allocatedPort === undefined) throw new Error("Artifact Site automatic port range is exhausted");
			listen = `${preferred.host}:${allocatedPort}`;
		} else {
			const owner = ownersByPort.get(preferred.port);
			if (owner) throw new Error(`Artifact Site port ${preferred.port} is already reserved by Profile ${owner}`);
		}

		registry.profiles[request.profile] = { listen };
		await writeRegistry(path, registry);
		return listen;
	} finally {
		await release();
	}
}

async function acquireRegistryLock(home: string): Promise<() => Promise<void>> {
	const deadline = Date.now() + 5_000;
	for (;;) {
		try {
			return await acquireChannelLock(home, "artifact-site-address-registry");
		} catch (error) {
			if (!(error instanceof Error) || !/already locked by process/u.test(error.message)) throw error;
			if (Date.now() >= deadline) throw new Error("Timed out waiting for the Artifact Site address registry lock", { cause: error });
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
}

async function readRegistry(path: string): Promise<ArtifactSiteAddressRegistry> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: SCHEMA_VERSION, profiles: {} };
		throw error;
	}
	let value: unknown;
	try { value = JSON.parse(raw); }
	catch { throw new Error("Artifact Site address registry is not valid JSON"); }
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Artifact Site address registry is invalid");
	const candidate = value as { schemaVersion?: unknown; profiles?: unknown };
	if (candidate.schemaVersion !== SCHEMA_VERSION || !candidate.profiles || typeof candidate.profiles !== "object" || Array.isArray(candidate.profiles)) {
		throw new Error("Artifact Site address registry has an unsupported schema");
	}
	const profiles: ArtifactSiteAddressRegistry["profiles"] = {};
	for (const [profile, allocation] of Object.entries(candidate.profiles as Record<string, unknown>)) {
		validateProfileName(profile);
		if (!allocation || typeof allocation !== "object" || Array.isArray(allocation) || typeof (allocation as { listen?: unknown }).listen !== "string") {
			throw new Error(`Artifact Site address registry entry for ${profile} is invalid`);
		}
		const listen = (allocation as { listen: string }).listen;
		parseArtifactSiteListen(listen);
		profiles[profile] = { listen };
	}
	return { schemaVersion: SCHEMA_VERSION, profiles };
}

async function writeRegistry(path: string, registry: ArtifactSiteAddressRegistry): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
	const orderedProfiles = Object.fromEntries(Object.entries(registry.profiles).sort(([left], [right]) => left.localeCompare(right)));
	try {
		await writeFile(temporary, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, profiles: orderedProfiles }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await rename(temporary, path);
		await chmod(path, 0o600);
	} finally {
		await rm(temporary, { force: true });
	}
}
