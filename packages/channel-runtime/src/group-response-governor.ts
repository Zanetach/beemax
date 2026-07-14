import type { GroupActivationSignal } from "./group-admission.ts";

export interface GroupQuietHours {
	start: string;
	end: string;
	timezone?: string;
}

export interface GroupResponseGovernorOptions {
	quietHours?: GroupQuietHours;
	maxRepliesPerWindow?: number;
	replyWindowMs?: number;
	maxTrackedLanes?: number;
	now?: () => number;
}

export type GroupResponseReservation = { allowed: true; rollback?: () => void } | { allowed: false; reason: "quiet_hours" | "reply_budget"; retryAt: number };

export interface GroupResponseGovernorSnapshot {
	trackedLanes: number;
	suppressedByQuietHours: number;
	suppressedByReplyBudget: number;
}

/** Bounded, transport-neutral quiet-hours and group reply-frequency authority. */
export class GroupResponseGovernor {
	private readonly maxRepliesPerWindow: number;
	private readonly replyWindowMs: number;
	private readonly maxTrackedLanes: number;
	private readonly now: () => number;
	private readonly quietHours?: { start: number; end: number; formatter: Intl.DateTimeFormat };
	private readonly replies = new Map<string, number[]>();
	private suppressedByQuietHours = 0;
	private suppressedByReplyBudget = 0;

	constructor(options: GroupResponseGovernorOptions = {}) {
		this.maxRepliesPerWindow = positiveInteger(options.maxRepliesPerWindow, 6, "maxRepliesPerWindow");
		this.replyWindowMs = positiveInteger(options.replyWindowMs, 60_000, "replyWindowMs");
		this.maxTrackedLanes = positiveInteger(options.maxTrackedLanes, 10_000, "maxTrackedLanes");
		this.now = options.now ?? Date.now;
		if (options.quietHours) this.quietHours = normalizeQuietHours(options.quietHours);
	}

	reserve(laneKey: string, activation: GroupActivationSignal | "ambient"): GroupResponseReservation {
		if (!laneKey.trim()) throw new Error("Group Response Governor requires a Conversation lane key");
		const now = this.now();
		if (activation === "ambient" && this.isQuiet(now)) {
			this.suppressedByQuietHours++;
			return { allowed: false, reason: "quiet_hours", retryAt: this.nextAllowedAt(now) };
		}
		if (activation === "command") return { allowed: true };
		const threshold = now - this.replyWindowMs;
		const recent = (this.replies.get(laneKey) ?? []).filter((timestamp) => timestamp > threshold && timestamp <= now);
		if (recent.length >= this.maxRepliesPerWindow) {
			this.suppressedByReplyBudget++;
			this.touch(laneKey, recent);
			return { allowed: false, reason: "reply_budget", retryAt: recent[0]! + this.replyWindowMs + 1 };
		}
		recent.push(now);
		this.touch(laneKey, recent);
		let active = true;
		return { allowed: true, rollback: () => {
			if (!active) return;
			active = false;
			const timestamps = this.replies.get(laneKey);
			if (!timestamps) return;
			const index = timestamps.lastIndexOf(now);
			if (index >= 0) timestamps.splice(index, 1);
			if (timestamps.length) this.touch(laneKey, timestamps); else this.replies.delete(laneKey);
		} };
	}

	snapshot(): GroupResponseGovernorSnapshot {
		return { trackedLanes: this.replies.size, suppressedByQuietHours: this.suppressedByQuietHours, suppressedByReplyBudget: this.suppressedByReplyBudget };
	}

	private touch(laneKey: string, timestamps: number[]): void {
		this.replies.delete(laneKey);
		this.replies.set(laneKey, timestamps);
		while (this.replies.size > this.maxTrackedLanes) this.replies.delete(this.replies.keys().next().value!);
	}

	private isQuiet(now: number): boolean {
		if (!this.quietHours) return false;
		const parts = Object.fromEntries(this.quietHours.formatter.formatToParts(new Date(now)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
		const current = Number(parts.hour) * 60 + Number(parts.minute);
		if (!Number.isFinite(current)) return false;
		const { start, end } = this.quietHours;
		return start === end || (end > start ? current >= start && current < end : current >= start || current < end);
	}

	private nextAllowedAt(now: number): number {
		const minute = Math.floor(now / 60_000) * 60_000;
		for (let step = 1; step <= 24 * 60; step++) {
			const candidate = minute + step * 60_000;
			if (!this.isQuiet(candidate)) return candidate;
		}
		return now + 24 * 60 * 60_000;
	}
}

function normalizeQuietHours(input: GroupQuietHours): { start: number; end: number; formatter: Intl.DateTimeFormat } {
	const start = parseClock(input.start);
	const end = parseClock(input.end);
	if (start === undefined || end === undefined) throw new Error("Group quiet hours must use HH:MM");
	let formatter: Intl.DateTimeFormat;
	try { formatter = new Intl.DateTimeFormat("en-US", { ...(input.timezone ? { timeZone: input.timezone } : {}), hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); }
	catch { throw new Error(`Invalid group quiet-hours timezone: ${input.timezone}`); }
	return { start, end, formatter };
}

function parseClock(value: string): number | undefined {
	const match = value.match(/^(\d{2}):(\d{2})$/);
	if (!match) return undefined;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	return hour > 23 || minute > 59 ? undefined : hour * 60 + minute;
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Group Response Governor ${field} must be a positive integer`);
	return value;
}
