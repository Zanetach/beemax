import { acquireProcessLock } from "./process-lock.ts";
import { createHash } from "node:crypto";

export async function acquireChannelLock(home: string, channel: string): Promise<() => Promise<void>> {
	const key = createHash("sha256").update(channel).digest("hex").slice(0, 24);
	return acquireProcessLock(home, channel, `Channel '${channel}'`, `channel-${key}.lock`);
}
