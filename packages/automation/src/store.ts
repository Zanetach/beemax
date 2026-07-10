import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { Cron } from "croner";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type ScheduleKind = "at" | "every" | "cron";
export type AutomationKind = "reminder" | "agent";

export interface AutomationOwner {
	platform: string;
	chatId: string;
	userId?: string;
}

export interface CreateJobInput extends AutomationOwner {
	name: string;
	kind: AutomationKind;
	scheduleKind: ScheduleKind;
	schedule: string;
	text: string;
	timezone?: string;
	deleteAfterRun?: boolean;
}

export interface AutomationJob extends AutomationOwner {
	id: string;
	name: string;
	kind: AutomationKind;
	scheduleKind: ScheduleKind;
	schedule: string;
	text: string;
	timezone?: string;
	enabled: boolean;
	deleteAfterRun: boolean;
	nextRunAt: number;
	lastRunAt?: number;
	lastStatus?: string;
	consecutiveErrors: number;
	createdAt: number;
	updatedAt: number;
}

export interface AutomationRun {
	id: string;
	jobId: string;
	startedAt: number;
	finishedAt: number;
	status: "ok" | "error" | "skipped";
	output?: string;
	error?: string;
}

export class AutomationStore {
	private readonly db: DatabaseType;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = new Database(path);
		this.db.pragma("journal_mode = WAL");
		this.migrate();
	}

	create(input: CreateJobInput, now = Date.now()): AutomationJob {
		validateInput(input);
		const id = randomId();
		const nextRunAt = computeNextRun(input.scheduleKind, input.schedule, input.timezone, now);
		const deleteAfterRun = input.deleteAfterRun ?? input.scheduleKind === "at";
		this.db.prepare(`INSERT INTO automation_jobs (
			id, platform, chat_id, user_id, name, kind, schedule_kind, schedule_value, timezone,
			payload_text, enabled, delete_after_run, next_run_at, consecutive_errors, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0, ?, ?)`)
			.run(id, input.platform, input.chatId, input.userId ?? null, input.name.trim(), input.kind,
				input.scheduleKind, input.schedule.trim(), input.timezone ?? null, input.text.trim(),
				deleteAfterRun ? 1 : 0, nextRunAt, now, now);
		return this.getRequired(id);
	}

	get(id: string, owner?: AutomationOwner): AutomationJob | undefined {
		const row = this.db.prepare(`SELECT * FROM automation_jobs WHERE id = ?`).get(id) as JobRow | undefined;
		if (!row) return undefined;
		const job = mapJob(row);
		return !owner || owns(job, owner) ? job : undefined;
	}

	list(owner: AutomationOwner, limit = 50): AutomationJob[] {
		const rows = this.db.prepare(`SELECT * FROM automation_jobs
			WHERE platform = ? AND (chat_id = ? OR (? IS NOT NULL AND user_id = ?))
			ORDER BY enabled DESC, next_run_at ASC LIMIT ?`)
			.all(owner.platform, owner.chatId, owner.userId ?? null, owner.userId ?? null, clamp(limit, 1, 100)) as JobRow[];
		return rows.map(mapJob);
	}

	remove(id: string, owner: AutomationOwner): boolean {
		return this.db.prepare(`DELETE FROM automation_jobs WHERE id = ? AND platform = ?
			AND (chat_id = ? OR (? IS NOT NULL AND user_id = ?))`)
			.run(id, owner.platform, owner.chatId, owner.userId ?? null, owner.userId ?? null).changes > 0;
	}

	setEnabled(id: string, enabled: boolean, owner: AutomationOwner, now = Date.now()): boolean {
		const job = this.get(id, owner);
		if (!job) return false;
		const next = enabled ? computeNextRun(job.scheduleKind, job.schedule, job.timezone, now) : job.nextRunAt;
		return this.db.prepare(`UPDATE automation_jobs SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?`)
			.run(enabled ? 1 : 0, next, now, id).changes > 0;
	}

	nextDueAt(): number | undefined {
		const row = this.db.prepare(`SELECT MIN(next_run_at) AS next_run_at FROM automation_jobs WHERE enabled = 1`)
			.get() as { next_run_at: number | null };
		return row.next_run_at ?? undefined;
	}

	claimDue(now = Date.now(), limit = 4, leaseMs = 15 * 60_000): AutomationJob[] {
		const claim = this.db.transaction(() => {
			const rows = this.db.prepare(`SELECT * FROM automation_jobs
				WHERE enabled = 1 AND next_run_at <= ? AND (locked_until IS NULL OR locked_until < ?)
				ORDER BY next_run_at ASC LIMIT ?`).all(now, now, clamp(limit, 1, 20)) as JobRow[];
			for (const row of rows) {
				this.db.prepare(`UPDATE automation_jobs SET locked_until = ?, updated_at = ? WHERE id = ?`)
					.run(now + leaseMs, now, row.id);
			}
			return rows.map(mapJob);
		});
		return claim();
	}

	complete(job: AutomationJob, result: Omit<AutomationRun, "id" | "jobId">, now = Date.now()): void {
		this.db.transaction(() => {
			this.db.prepare(`INSERT INTO automation_runs
				(id, job_id, started_at, finished_at, status, output, error)
				VALUES (?, ?, ?, ?, ?, ?, ?)`)
				.run(randomId(), job.id, result.startedAt, result.finishedAt, result.status,
					result.output ?? null, result.error ?? null);
			if (result.status === "ok" && job.scheduleKind === "at" && job.deleteAfterRun) {
				this.db.prepare(`DELETE FROM automation_jobs WHERE id = ?`).run(job.id);
				return;
			}
			if (result.status === "ok") {
				const enabled = job.scheduleKind === "at" ? 0 : 1;
				const next = enabled ? computeNextRun(job.scheduleKind, job.schedule, job.timezone, now) : job.nextRunAt;
				this.db.prepare(`UPDATE automation_jobs SET enabled = ?, next_run_at = ?, last_run_at = ?,
					last_status = 'ok', consecutive_errors = 0, locked_until = NULL, updated_at = ? WHERE id = ?`)
					.run(enabled, next, result.finishedAt, now, job.id);
				return;
			}
			const errors = job.consecutiveErrors + 1;
			const retryDelay = [30_000, 60_000, 5 * 60_000][Math.min(errors - 1, 2)];
			this.db.prepare(`UPDATE automation_jobs SET next_run_at = ?, last_run_at = ?, last_status = ?,
				consecutive_errors = ?, locked_until = NULL, updated_at = ? WHERE id = ?`)
				.run(now + retryDelay, result.finishedAt, result.status, errors, now, job.id);
		})();
	}

	runs(jobId: string, owner: AutomationOwner, limit = 20): AutomationRun[] {
		if (!this.get(jobId, owner)) return [];
		return (this.db.prepare(`SELECT * FROM automation_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?`)
			.all(jobId, clamp(limit, 1, 100)) as RunRow[]).map(mapRun);
	}

	setLastRoute(owner: AutomationOwner, now = Date.now()): void {
		this.db.prepare(`INSERT INTO automation_routes(platform, user_id, chat_id, updated_at)
			VALUES (?, ?, ?, ?) ON CONFLICT(platform, user_id) DO UPDATE SET chat_id=excluded.chat_id, updated_at=excluded.updated_at`)
			.run(owner.platform, owner.userId ?? `chat:${owner.chatId}`, owner.chatId, now);
	}

	getLastRoute(platform: string, userId?: string): AutomationOwner | undefined {
		const row = userId
			? this.db.prepare(`SELECT * FROM automation_routes WHERE platform = ? AND user_id = ?`).get(platform, userId)
			: this.db.prepare(`SELECT * FROM automation_routes WHERE platform = ? ORDER BY updated_at DESC LIMIT 1`).get(platform);
		const route = row as { platform: string; user_id: string; chat_id: string } | undefined;
		return route ? { platform: route.platform, chatId: route.chat_id, userId: route.user_id.startsWith("chat:") ? undefined : route.user_id } : undefined;
	}

	recordHeartbeat(status: string, detail?: string, now = Date.now()): void {
		this.db.prepare(`INSERT INTO heartbeat_state(id, last_run_at, last_status, detail)
			VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET last_run_at=excluded.last_run_at,
			last_status=excluded.last_status, detail=excluded.detail`).run(now, status, detail ?? null);
	}

	lastHeartbeat(): { lastRunAt: number; status: string; detail?: string } | undefined {
		const row = this.db.prepare(`SELECT last_run_at, last_status, detail FROM heartbeat_state WHERE id = 1`).get() as
			{ last_run_at: number; last_status: string; detail: string | null } | undefined;
		return row ? { lastRunAt: row.last_run_at, status: row.last_status, detail: row.detail ?? undefined } : undefined;
	}

	close(): void { this.db.close(); }

	private getRequired(id: string): AutomationJob {
		const job = this.get(id);
		if (!job) throw new Error(`Automation job ${id} disappeared`);
		return job;
	}

	private migrate(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS automation_jobs (
				id TEXT PRIMARY KEY, platform TEXT NOT NULL, chat_id TEXT NOT NULL, user_id TEXT,
				name TEXT NOT NULL, kind TEXT NOT NULL, schedule_kind TEXT NOT NULL,
				schedule_value TEXT NOT NULL, timezone TEXT, payload_text TEXT NOT NULL,
				enabled INTEGER NOT NULL, delete_after_run INTEGER NOT NULL, next_run_at INTEGER NOT NULL,
				last_run_at INTEGER, last_status TEXT, consecutive_errors INTEGER NOT NULL DEFAULT 0,
				locked_until INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_automation_due ON automation_jobs(enabled, next_run_at);
			CREATE TABLE IF NOT EXISTS automation_runs (
				id TEXT PRIMARY KEY, job_id TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL,
				status TEXT NOT NULL, output TEXT, error TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_automation_runs_job ON automation_runs(job_id, started_at DESC);
			CREATE TABLE IF NOT EXISTS automation_routes (
				platform TEXT NOT NULL, user_id TEXT NOT NULL, chat_id TEXT NOT NULL, updated_at INTEGER NOT NULL,
				PRIMARY KEY(platform, user_id)
			);
			CREATE TABLE IF NOT EXISTS heartbeat_state (
				id INTEGER PRIMARY KEY CHECK(id = 1), last_run_at INTEGER NOT NULL,
				last_status TEXT NOT NULL, detail TEXT
			);
		`);
	}
}

export function parseDuration(value: string): number {
	const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i);
	if (!match) throw new Error(`Invalid duration ${value}; use forms like 30m, 2h, or 1d`);
	const amount = Number(match[1]);
	const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
	const ms = amount * units[match[2].toLowerCase()];
	if (!Number.isFinite(ms) || ms < 1000) throw new Error("Duration must be at least 1 second");
	return Math.floor(ms);
}

export function computeNextRun(kind: ScheduleKind, schedule: string, timezone: string | undefined, now: number): number {
	if (kind === "at") {
		if (/^\d+(?:\.\d+)?\s*(?:ms|s|m|h|d)$/i.test(schedule.trim())) return now + parseDuration(schedule);
		const parsed = Date.parse(schedule);
		if (!Number.isFinite(parsed)) throw new Error("One-shot schedule must be an ISO 8601 timestamp with timezone or a duration like 20m");
		if (parsed <= now) throw new Error("One-shot schedule must be in the future");
		return parsed;
	}
	if (kind === "every") return now + parseDuration(schedule);
	try {
		const next = new Cron(schedule, { timezone, paused: true }).nextRun(new Date(now));
		if (!next) throw new Error("expression has no future occurrence");
		return next.getTime();
	} catch (error) {
		throw new Error(`Invalid cron schedule: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function validateInput(input: CreateJobInput): void {
	if (!input.name.trim() || input.name.length > 120) throw new Error("Job name must be 1-120 characters");
	if (!input.text.trim() || input.text.length > 20_000) throw new Error("Job text must be 1-20000 characters");
	if (!input.chatId) throw new Error("Automation delivery requires a chat ID");
}

function owns(job: AutomationJob, owner: AutomationOwner): boolean {
	return job.platform === owner.platform && (job.chatId === owner.chatId || Boolean(owner.userId && job.userId === owner.userId));
}
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
function randomId(): string { return crypto.randomUUID(); }

interface JobRow { id:string;platform:string;chat_id:string;user_id:string|null;name:string;kind:string;schedule_kind:string;schedule_value:string;timezone:string|null;payload_text:string;enabled:number;delete_after_run:number;next_run_at:number;last_run_at:number|null;last_status:string|null;consecutive_errors:number;created_at:number;updated_at:number }
interface RunRow { id:string;job_id:string;started_at:number;finished_at:number;status:string;output:string|null;error:string|null }
function mapJob(row: JobRow): AutomationJob { return { id:row.id,platform:row.platform,chatId:row.chat_id,userId:row.user_id??undefined,name:row.name,kind:row.kind as AutomationKind,scheduleKind:row.schedule_kind as ScheduleKind,schedule:row.schedule_value,text:row.payload_text,timezone:row.timezone??undefined,enabled:Boolean(row.enabled),deleteAfterRun:Boolean(row.delete_after_run),nextRunAt:row.next_run_at,lastRunAt:row.last_run_at??undefined,lastStatus:row.last_status??undefined,consecutiveErrors:row.consecutive_errors,createdAt:row.created_at,updatedAt:row.updated_at }; }
function mapRun(row: RunRow): AutomationRun { return { id:row.id,jobId:row.job_id,startedAt:row.started_at,finishedAt:row.finished_at,status:row.status as AutomationRun["status"],output:row.output??undefined,error:row.error??undefined }; }
