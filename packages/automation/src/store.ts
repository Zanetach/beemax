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
	maxAttempts?: number;
	misfirePolicy?: "skip" | "run_once";
	misfireGraceMs?: number;
}

export type UpdateJobInput = Partial<Pick<CreateJobInput,
	"name" | "kind" | "scheduleKind" | "schedule" | "text" | "timezone" | "deleteAfterRun" | "maxAttempts" | "misfirePolicy" | "misfireGraceMs"
>>;

export interface AutomationStatus {
	enabled: number;
	due: number;
	claimed: number;
	retrying: number;
	deliveryQueued: number;
	deliveryAbandoned: number;
	occurrenceHistory: number;
	deliveryHistory: number;
	nextDueAt?: number;
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
	maxAttempts: number;
	misfirePolicy: "skip" | "run_once";
	misfireGraceMs: number;
	nextRunAt: number;
	lastRunAt?: number;
	lastStatus?: string;
	consecutiveErrors: number;
	createdAt: number;
	updatedAt: number;
	claimToken?: string;
	/** Canonical recurring due time preserved while a manual run is in progress. */
	manualResumeAt?: number;
}

export interface AutomationClaim extends AutomationJob {
	occurrenceId: string;
	nominalDueAt: number;
	occurrenceAttempt: number;
	objectiveId?: string;
	taskRunId?: string;
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

export interface AutomationDeliveryInput {
	kind: "text";
	text: string;
	idempotencyKey: string;
}

export interface AutomationCompletion extends Omit<AutomationRun, "id" | "jobId"> {
	delivery?: AutomationDeliveryInput;
	objectiveId?: string;
	taskRunId?: string;
}

export interface AutomationDelivery extends AutomationOwner {
	id: string;
	occurrenceId: string;
	scheduleId: string;
	kind: "text";
	text: string;
	idempotencyKey: string;
	status: "queued" | "delivering" | "delivered" | "abandoned";
	attempts: number;
	nextAttemptAt: number;
	claimToken: string;
	createdAt: number;
}

export interface AutomationOccurrence {
	id: string;
	scheduleId: string;
	nominalDueAt: number;
	status: "claimed" | "succeeded" | "retrying" | "failed" | "skipped" | "cancelled";
	attempts: number;
	startedAt?: number;
	finishedAt?: number;
	output?: string;
	error?: string;
	objectiveId?: string;
	taskRunId?: string;
}

export interface MediaDelivery extends AutomationOwner {
	id: string;
	path: string;
	mimeType?: string;
	status: "queued" | "delivering" | "delivered" | "abandoned";
	attempts: number;
	nextAttemptAt: number;
	createdAt: number;
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
			payload_text, enabled, delete_after_run, max_attempts, misfire_policy, misfire_grace_ms,
			next_run_at, consecutive_errors, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 0, ?, ?)`)
			.run(id, input.platform, input.chatId, input.userId ?? null, input.name.trim(), input.kind,
				input.scheduleKind, input.schedule.trim(), input.timezone ?? null, input.text.trim(),
				deleteAfterRun ? 1 : 0, clamp(input.maxAttempts ?? 3, 1, 20), input.misfirePolicy ?? "run_once",
				clamp(input.misfireGraceMs ?? 5 * 60_000, 0, 7 * 24 * 60 * 60_000), nextRunAt, now, now);
		return this.getRequired(id);
	}

	get(id: string, owner?: AutomationOwner): AutomationJob | undefined {
		const row = this.db.prepare(`SELECT * FROM automation_jobs WHERE id = ? AND deleted_at IS NULL`).get(id) as JobRow | undefined;
		if (!row) return undefined;
		const job = mapJob(row);
		return !owner || owns(job, owner) ? job : undefined;
	}

	list(owner: AutomationOwner, limit = 50): AutomationJob[] {
		const rows = this.db.prepare(`SELECT * FROM automation_jobs
			WHERE deleted_at IS NULL AND platform = ? AND (chat_id = ? OR (? IS NOT NULL AND user_id = ?))
			ORDER BY enabled DESC, next_run_at ASC LIMIT ?`)
			.all(owner.platform, owner.chatId, owner.userId ?? null, owner.userId ?? null, clamp(limit, 1, 100)) as JobRow[];
		return rows.map(mapJob);
	}

	update(id: string, patch: UpdateJobInput, owner: AutomationOwner, now = Date.now()): AutomationJob {
		const current = this.get(id, owner);
		if (!current) throw new Error(`Schedule not found: ${id}`);
		if (current.claimToken) throw new Error(`Schedule ${id} is currently running`);
		const input: CreateJobInput = {
			platform: current.platform, chatId: current.chatId, ...(current.userId ? { userId: current.userId } : {}),
			name: patch.name ?? current.name,
			kind: patch.kind ?? current.kind,
			scheduleKind: patch.scheduleKind ?? current.scheduleKind,
			schedule: patch.schedule ?? current.schedule,
			text: patch.text ?? current.text,
			...(patch.timezone !== undefined ? { timezone: patch.timezone } : current.timezone ? { timezone: current.timezone } : {}),
			deleteAfterRun: patch.deleteAfterRun ?? current.deleteAfterRun,
			maxAttempts: patch.maxAttempts ?? current.maxAttempts,
			misfirePolicy: patch.misfirePolicy ?? current.misfirePolicy,
			misfireGraceMs: patch.misfireGraceMs ?? current.misfireGraceMs,
		};
		validateInput(input);
		const triggerChanged = patch.scheduleKind !== undefined || patch.schedule !== undefined || patch.timezone !== undefined;
		const nextRunAt = triggerChanged ? computeNextRun(input.scheduleKind, input.schedule, input.timezone, now) : current.nextRunAt;
		this.db.prepare(`UPDATE automation_jobs SET name=?, kind=?, schedule_kind=?, schedule_value=?, timezone=?,
			payload_text=?, delete_after_run=?, max_attempts=?, misfire_policy=?, misfire_grace_ms=?, next_run_at=?, updated_at=?
			WHERE id=? AND deleted_at IS NULL`)
			.run(input.name.trim(), input.kind, input.scheduleKind, input.schedule.trim(), input.timezone ?? null,
				input.text.trim(), input.deleteAfterRun ? 1 : 0, clamp(input.maxAttempts ?? 3, 1, 20),
				input.misfirePolicy ?? "run_once", clamp(input.misfireGraceMs ?? 300_000, 0, 7 * 24 * 60 * 60_000), nextRunAt, now, id);
		return this.getRequired(id);
	}

	runNow(id: string, owner: AutomationOwner, now = Date.now()): boolean {
		const current = this.get(id, owner);
		if (!current || !current.enabled || current.claimToken) return false;
		return this.db.prepare(`UPDATE automation_jobs SET next_run_at=?, manual_resume_at=?, updated_at=?
			WHERE id=? AND enabled=1 AND deleted_at IS NULL AND manual_resume_at IS NULL`)
			.run(now, current.scheduleKind === "at" ? null : current.nextRunAt, now, id).changes === 1;
	}

	status(now = Date.now()): AutomationStatus {
		const jobs = this.db.prepare(`SELECT
			SUM(CASE WHEN enabled=1 AND deleted_at IS NULL THEN 1 ELSE 0 END) AS enabled,
			SUM(CASE WHEN enabled=1 AND deleted_at IS NULL AND next_run_at<=? THEN 1 ELSE 0 END) AS due,
			MIN(CASE WHEN enabled=1 AND deleted_at IS NULL THEN next_run_at END) AS next_due_at
			FROM automation_jobs`).get(now) as { enabled:number|null;due:number|null;next_due_at:number|null };
		const occurrences = this.db.prepare(`SELECT
			SUM(CASE WHEN status='claimed' THEN 1 ELSE 0 END) AS claimed,
			SUM(CASE WHEN status='retrying' THEN 1 ELSE 0 END) AS retrying,
			COUNT(*) AS history FROM automation_occurrences`)
			.get() as { claimed:number|null;retrying:number|null;history:number };
		const deliveries = this.db.prepare(`SELECT
			SUM(CASE WHEN status IN ('queued','delivering') THEN 1 ELSE 0 END) AS queued,
			SUM(CASE WHEN status='abandoned' THEN 1 ELSE 0 END) AS abandoned,
			COUNT(*) AS history FROM automation_deliveries`)
			.get() as { queued:number|null;abandoned:number|null;history:number };
		return { enabled:jobs.enabled??0,due:jobs.due??0,claimed:occurrences.claimed??0,retrying:occurrences.retrying??0,
			deliveryQueued:deliveries.queued??0,deliveryAbandoned:deliveries.abandoned??0,
			occurrenceHistory:occurrences.history,deliveryHistory:deliveries.history,...(jobs.next_due_at === null ? {} : { nextDueAt:jobs.next_due_at }) };
	}

	remove(id: string, owner: AutomationOwner): boolean {
		return this.db.transaction(() => {
			const changed = this.db.prepare(`DELETE FROM automation_jobs WHERE id = ? AND platform = ?
				AND (chat_id = ? OR (? IS NOT NULL AND user_id = ?))`)
				.run(id, owner.platform, owner.chatId, owner.userId ?? null, owner.userId ?? null).changes > 0;
			if (changed) this.db.prepare("DELETE FROM automation_runs WHERE job_id = ?").run(id);
			if (changed) this.db.prepare("DELETE FROM automation_occurrences WHERE schedule_id = ?").run(id);
			if (changed) this.db.prepare("DELETE FROM automation_deliveries WHERE schedule_id = ?").run(id);
			return changed;
		})();
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

	claimDue(now = Date.now(), limit = 4, leaseMs = 15 * 60_000): AutomationClaim[] {
		const claim = this.db.transaction(() => {
			const rows = this.db.prepare(`SELECT * FROM automation_jobs
				WHERE enabled = 1 AND next_run_at <= ? AND (locked_until IS NULL OR locked_until < ?)
				ORDER BY next_run_at ASC LIMIT ?`).all(now, now, clamp(limit, 1, 20)) as JobRow[];
			const claims: AutomationClaim[] = [];
			for (const row of rows) {
				if (row.misfire_policy === "skip" && now - row.next_run_at > row.misfire_grace_ms) {
					this.db.prepare(`INSERT INTO automation_occurrences (
						id, schedule_id, nominal_due_at, status, attempts, finished_at, created_at, updated_at
					) VALUES (?, ?, ?, 'skipped', 0, ?, ?, ?)
					ON CONFLICT(schedule_id, nominal_due_at) DO NOTHING`)
						.run(randomId(), row.id, row.next_run_at, now, now, now);
					const enabled = row.schedule_kind === "at" ? 0 : 1;
					const nextRunAt = enabled ? computeNextRun(row.schedule_kind as ScheduleKind, row.schedule_value, row.timezone ?? undefined, now) : row.next_run_at;
					this.db.prepare(`UPDATE automation_jobs SET enabled=?, next_run_at=?, last_run_at=?, last_status='skipped',
						locked_until=NULL, claim_token=NULL, updated_at=? WHERE id=?`)
						.run(enabled, nextRunAt, now, now, row.id);
					this.pruneAutomationHistory(row.id);
					continue;
				}
				const claimToken = randomId();
				const retrying = this.db.prepare(`SELECT id, nominal_due_at, attempts, objective_id, task_run_id FROM automation_occurrences
					WHERE schedule_id = ? AND (status = 'retrying' OR (status = 'claimed' AND claim_expires_at < ?))
					ORDER BY nominal_due_at DESC LIMIT 1`)
					.get(row.id, now) as { id: string; nominal_due_at: number; attempts: number; objective_id:string|null;task_run_id:string|null } | undefined;
				const occurrenceId = retrying?.id ?? randomId();
				const nominalDueAt = retrying?.nominal_due_at ?? row.next_run_at;
				const claimed = this.db.prepare(`UPDATE automation_jobs SET locked_until = ?, claim_token = ?, updated_at = ?
					WHERE id = ? AND enabled=1 AND next_run_at<=? AND (locked_until IS NULL OR locked_until < ?)`)
					.run(now + leaseMs, claimToken, now, row.id, now, now).changes === 1;
				if (!claimed) continue;
				if (retrying) this.db.prepare(`UPDATE automation_occurrences SET status='claimed', attempts=attempts + 1,
					claim_token=?, claim_expires_at=?, finished_at=NULL, updated_at=? WHERE id=?`)
					.run(claimToken, now + leaseMs, now, occurrenceId);
				else this.db.prepare(`INSERT INTO automation_occurrences (
					id, schedule_id, nominal_due_at, status, attempts, claim_token, claim_expires_at, started_at, created_at, updated_at
				) VALUES (?, ?, ?, 'claimed', 1, ?, ?, ?, ?, ?)`)
					.run(occurrenceId, row.id, nominalDueAt, claimToken, now + leaseMs, now, now, now);
				const claimedJob = mapJob(this.db.prepare("SELECT * FROM automation_jobs WHERE id = ?").get(row.id) as JobRow);
				claims.push({ ...claimedJob, occurrenceId, nominalDueAt, occurrenceAttempt: (retrying?.attempts ?? 0) + 1,
					...(retrying?.objective_id ? { objectiveId:retrying.objective_id } : {}), ...(retrying?.task_run_id ? { taskRunId:retrying.task_run_id } : {}) });
			}
			return claims;
		});
		return claim();
	}

	renewClaim(id: string, claimToken: string, leaseExpiresAt: number): boolean {
		return this.db.transaction(() => {
			const jobChanged = this.db.prepare("UPDATE automation_jobs SET locked_until = ? WHERE id = ? AND claim_token = ?")
				.run(leaseExpiresAt, id, claimToken).changes === 1;
			if (!jobChanged) return false;
			const occurrenceChanged = this.db.prepare(`UPDATE automation_occurrences SET claim_expires_at=?, updated_at=?
				WHERE schedule_id=? AND status='claimed' AND claim_token=?`)
				.run(leaseExpiresAt, Date.now(), id, claimToken).changes === 1;
			if (!occurrenceChanged) throw new Error(`Automation occurrence claim is missing for Schedule ${id}`);
			return true;
		})();
	}

	bindClaimExecution(id: string, occurrenceId: string, claimToken: string, objectiveId: string, taskRunId: string | undefined, now = Date.now()): boolean {
		return this.db.prepare(`UPDATE automation_occurrences SET objective_id=?, task_run_id=COALESCE(?, task_run_id), updated_at=?
			WHERE id=? AND schedule_id=? AND status='claimed' AND claim_token=? AND claim_expires_at>=?`)
			.run(objectiveId, taskRunId ?? null, now, occurrenceId, id, claimToken, now).changes === 1;
	}

	complete(job: AutomationClaim, result: AutomationCompletion, now = Date.now()): boolean {
		return this.db.transaction(() => {
			if (!job.claimToken || !(this.db.prepare("SELECT 1 FROM automation_jobs WHERE id = ? AND claim_token = ? AND locked_until >= ?").get(job.id, job.claimToken, now))) return false;
			const occurrence = this.db.prepare(`SELECT id, attempts FROM automation_occurrences
				WHERE schedule_id = ? AND claim_token = ? AND claim_expires_at >= ?`).get(job.id, job.claimToken, now) as { id: string; attempts: number } | undefined;
			if (!occurrence) return false;
			this.db.prepare("UPDATE automation_occurrences SET objective_id=COALESCE(?, objective_id), task_run_id=COALESCE(?, task_run_id), updated_at=? WHERE id=? AND claim_token=?")
				.run(result.objectiveId ?? null, result.taskRunId ?? null, now, occurrence.id, job.claimToken);
			this.db.prepare(`INSERT INTO automation_runs
				(id, job_id, started_at, finished_at, status, output, error)
				VALUES (?, ?, ?, ?, ?, ?, ?)`)
				.run(randomId(), job.id, result.startedAt, result.finishedAt, result.status,
					result.output ?? null, result.error ?? null);
			this.db.prepare(`DELETE FROM automation_runs WHERE job_id = ? AND id NOT IN (SELECT id FROM automation_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 100)`).run(job.id, job.id);
			this.db.prepare("DELETE FROM automation_runs WHERE id NOT IN (SELECT id FROM automation_runs ORDER BY started_at DESC LIMIT 10000)").run();
			if (result.status === "ok" && result.delivery) {
				this.db.prepare(`INSERT INTO automation_deliveries (
					id, occurrence_id, schedule_id, platform, chat_id, user_id, kind, payload_text,
					idempotency_key, status, attempts, next_attempt_at, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)
				ON CONFLICT(occurrence_id) DO NOTHING`)
					.run(randomId(), occurrence.id, job.id, job.platform, job.chatId, job.userId ?? null,
						result.delivery.kind, result.delivery.text, result.delivery.idempotencyKey, now, now, now);
			}
			if (result.status === "ok" && job.scheduleKind === "at" && job.deleteAfterRun) {
				this.db.prepare(`UPDATE automation_occurrences SET status='succeeded', finished_at=?, output=?, error=NULL,
					claim_token=NULL, claim_expires_at=NULL, updated_at=? WHERE id=? AND claim_token=?`)
					.run(result.finishedAt, result.output ?? null, now, occurrence.id, job.claimToken);
				this.db.prepare(`UPDATE automation_jobs SET enabled=0, deleted_at=?, last_run_at=?, last_status='ok',
					consecutive_errors=0, locked_until=NULL, claim_token=NULL, updated_at=? WHERE id=? AND claim_token=?`)
					.run(now, result.finishedAt, now, job.id, job.claimToken);
				this.pruneAutomationHistory(job.id);
				return true;
			}
			if (result.status === "ok") {
				this.db.prepare(`UPDATE automation_occurrences SET status='succeeded', finished_at=?, output=?, error=NULL,
					claim_token=NULL, claim_expires_at=NULL, updated_at=? WHERE id=? AND claim_token=?`)
					.run(result.finishedAt, result.output ?? null, now, occurrence.id, job.claimToken);
				const enabled = job.scheduleKind === "at" ? 0 : 1;
				const next = enabled ? job.manualResumeAt ?? computeNextRun(job.scheduleKind, job.schedule, job.timezone, now) : job.nextRunAt;
				this.db.prepare(`UPDATE automation_jobs SET enabled = ?, next_run_at = ?, last_run_at = ?,
					last_status = 'ok', consecutive_errors = 0, locked_until = NULL, claim_token = NULL, manual_resume_at=NULL,
					updated_at = ? WHERE id = ? AND claim_token = ?`)
					.run(enabled, next, result.finishedAt, now, job.id, job.claimToken);
				this.pruneAutomationHistory(job.id);
				return true;
			}
			const errors = job.consecutiveErrors + 1;
			const exhausted = occurrence.attempts >= job.maxAttempts;
			this.db.prepare(`UPDATE automation_occurrences SET status=?, finished_at=?, output=?, error=?,
				claim_token=NULL, claim_expires_at=NULL, updated_at=? WHERE id=? AND claim_token=?`)
				.run(exhausted ? "failed" : "retrying", result.finishedAt, result.output ?? null, result.error ?? null, now, occurrence.id, job.claimToken);
			const retryDelay = [30_000, 60_000, 5 * 60_000][Math.min(occurrence.attempts - 1, 2)];
			const enabled = exhausted && job.scheduleKind === "at" ? 0 : 1;
			const nextRunAt = exhausted
				? job.scheduleKind === "at" ? job.nextRunAt : job.manualResumeAt ?? computeNextRun(job.scheduleKind, job.schedule, job.timezone, now)
				: now + retryDelay;
			this.db.prepare(`UPDATE automation_jobs SET next_run_at = ?, last_run_at = ?, last_status = ?,
				consecutive_errors = ?, enabled = ?, locked_until = NULL, claim_token = NULL,
				manual_resume_at=CASE WHEN ? THEN NULL ELSE manual_resume_at END, updated_at = ? WHERE id = ? AND claim_token = ?`)
				.run(nextRunAt, result.finishedAt, exhausted ? "failed" : result.status, errors, enabled, exhausted ? 1 : 0, now, job.id, job.claimToken);
			if (exhausted) this.pruneAutomationHistory(job.id);
			return true;
		})();
	}

	runs(jobId: string, owner: AutomationOwner, limit = 20): AutomationRun[] {
		const schedule = this.db.prepare("SELECT * FROM automation_jobs WHERE id = ?").get(jobId) as JobRow | undefined;
		if (!schedule || !owns(mapJob(schedule), owner)) return [];
		return (this.db.prepare(`SELECT * FROM automation_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?`)
			.all(jobId, clamp(limit, 1, 100)) as RunRow[]).map(mapRun);
	}

	occurrences(jobId: string, owner: AutomationOwner, limit = 20): AutomationOccurrence[] {
		const schedule = this.db.prepare("SELECT * FROM automation_jobs WHERE id = ?").get(jobId) as JobRow | undefined;
		if (!schedule || !owns(mapJob(schedule), owner)) return [];
		return (this.db.prepare("SELECT * FROM automation_occurrences WHERE schedule_id = ? ORDER BY nominal_due_at DESC LIMIT ?")
			.all(jobId, clamp(limit, 1, 100)) as OccurrenceRow[]).map(mapOccurrence);
	}

	claimDeliveriesDue(now = Date.now(), limit = 4, leaseMs = 5 * 60_000): AutomationDelivery[] {
		return this.db.transaction(() => {
			const rows = this.db.prepare(`SELECT * FROM automation_deliveries
				WHERE status IN ('queued', 'delivering') AND next_attempt_at <= ?
					AND (claim_expires_at IS NULL OR claim_expires_at < ?)
				ORDER BY next_attempt_at ASC LIMIT ?`).all(now, now, clamp(limit, 1, 20)) as DeliveryRow[];
			const claimed: AutomationDelivery[] = [];
			for (const row of rows) {
				const token = randomId();
				const changed = this.db.prepare(`UPDATE automation_deliveries SET status='delivering', attempts=attempts+1,
					claim_token=?, claim_expires_at=?, updated_at=? WHERE id=? AND status IN ('queued','delivering')
					AND next_attempt_at<=? AND (claim_expires_at IS NULL OR claim_expires_at < ?)`)
					.run(token, now + leaseMs, now, row.id, now, now).changes === 1;
				if (changed) claimed.push(mapDelivery(this.db.prepare("SELECT * FROM automation_deliveries WHERE id=?").get(row.id) as DeliveryRow));
			}
			return claimed;
		})();
	}

	completeDelivery(id: string, claimToken: string, now = Date.now()): boolean {
		return this.db.transaction(() => {
			const row = this.db.prepare(`SELECT schedule_id FROM automation_deliveries
				WHERE id=? AND status='delivering' AND claim_token=? AND claim_expires_at>=?`).get(id, claimToken, now) as { schedule_id: string } | undefined;
			if (!row) return false;
			const changed = this.db.prepare(`UPDATE automation_deliveries SET status='delivered', delivered_at=?,
				claim_token=NULL, claim_expires_at=NULL, error=NULL, updated_at=?
				WHERE id=? AND status='delivering' AND claim_token=? AND claim_expires_at>=?`).run(now, now, id, claimToken, now).changes === 1;
			if (!changed) return false;
			this.pruneDeliveryHistory(row.schedule_id);
			this.pruneAutomationHistory(row.schedule_id);
			return true;
		})();
	}

	failDelivery(id: string, claimToken: string, error: string, now = Date.now()): boolean {
		const row = this.db.prepare(`SELECT attempts, schedule_id FROM automation_deliveries
			WHERE id=? AND status='delivering' AND claim_token=? AND claim_expires_at>=?`).get(id, claimToken, now) as { attempts: number;schedule_id:string } | undefined;
		if (!row) return false;
		const abandoned = row.attempts >= 10;
		const delay = Math.min(60 * 60_000, 30_000 * 2 ** Math.min(Math.max(0, row.attempts - 1), 7));
		const changed = this.db.prepare(`UPDATE automation_deliveries SET status=?, next_attempt_at=?, error=?,
			claim_token=NULL, claim_expires_at=NULL, updated_at=? WHERE id=? AND claim_token=?`)
			.run(abandoned ? "abandoned" : "queued", abandoned ? now : now + delay, error.slice(0, 2_000), now, id, claimToken).changes === 1;
		if (changed && abandoned) { this.pruneDeliveryHistory(row.schedule_id); this.pruneAutomationHistory(row.schedule_id); }
		return changed;
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

	enqueueMedia(owner: AutomationOwner, media: { path: string; mimeType?: string }, now = Date.now()): MediaDelivery {
		if (!owner.platform || !owner.chatId || !media.path) throw new Error("Media delivery requires a platform, chat ID, and file path");
		const id = randomId();
		this.db.prepare(`INSERT INTO media_deliveries(id, platform, chat_id, user_id, path, mime_type, status, attempts, next_attempt_at, created_at)
			VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`).run(id, owner.platform, owner.chatId, owner.userId ?? null, media.path, media.mimeType ?? null, now, now);
		return this.getMediaRequired(id);
	}

	claimMediaDue(now = Date.now(), limit = 4, leaseMs = 5 * 60_000): MediaDelivery[] {
		return this.db.transaction(() => {
			// An expired delivering lease means the previous worker disappeared before
			// acknowledging the outcome. Reclaim it for at-least-once delivery.
			const rows = this.db.prepare(`SELECT * FROM media_deliveries
				WHERE status IN ('queued', 'delivering') AND next_attempt_at <= ?
				ORDER BY next_attempt_at ASC LIMIT ?`).all(now, clamp(limit, 1, 20)) as MediaRow[];
			for (const row of rows) {
				this.db.prepare(`UPDATE media_deliveries
					SET status = 'delivering', attempts = attempts + ?, next_attempt_at = ? WHERE id = ?`)
					.run(row.status === "delivering" ? 1 : 0, now + leaseMs, row.id);
			}
			return rows.map((row) => this.getMediaRequired(row.id));
		})();
	}

	completeMedia(id: string): void { this.db.prepare(`DELETE FROM media_deliveries WHERE id = ?`).run(id); }
	failMedia(id: string, now = Date.now()): void {
		const row = this.db.prepare(`SELECT attempts FROM media_deliveries WHERE id = ?`).get(id) as { attempts: number } | undefined;
		if (!row) return;
		const attempts = row.attempts + 1;
		if (attempts >= 10) {
			this.db.prepare("UPDATE media_deliveries SET status = 'abandoned', attempts = ? WHERE id = ?").run(attempts, id);
			this.db.prepare("DELETE FROM media_deliveries WHERE status = 'abandoned' AND id NOT IN (SELECT id FROM media_deliveries WHERE status = 'abandoned' ORDER BY created_at DESC LIMIT 1000)").run();
			return;
		}
		const delay = Math.min(60 * 60_000, 30_000 * 2 ** Math.min(attempts - 1, 7));
		this.db.prepare(`UPDATE media_deliveries SET status = 'queued', attempts = ?, next_attempt_at = ? WHERE id = ?`).run(attempts, now + delay, id);
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
	private getMediaRequired(id: string): MediaDelivery {
		const row = this.db.prepare(`SELECT * FROM media_deliveries WHERE id = ?`).get(id) as MediaRow | undefined;
		if (!row) throw new Error(`Media delivery ${id} disappeared`);
		return mapMedia(row);
	}
	private pruneAutomationHistory(scheduleId: string): void {
		this.db.prepare(`DELETE FROM automation_occurrences
			WHERE schedule_id=? AND status IN ('succeeded','failed','skipped','cancelled')
				AND id NOT IN (SELECT id FROM automation_occurrences WHERE schedule_id=? ORDER BY nominal_due_at DESC LIMIT 100)
				AND id NOT IN (SELECT occurrence_id FROM automation_deliveries WHERE status IN ('queued','delivering'))`)
			.run(scheduleId, scheduleId);
		this.db.prepare(`DELETE FROM automation_occurrences
			WHERE status IN ('succeeded','failed','skipped','cancelled')
				AND id NOT IN (SELECT id FROM automation_occurrences ORDER BY updated_at DESC LIMIT 10000)
				AND id NOT IN (SELECT occurrence_id FROM automation_deliveries WHERE status IN ('queued','delivering'))`).run();
	}
	private pruneDeliveryHistory(scheduleId: string): void {
		this.db.prepare(`DELETE FROM automation_deliveries WHERE schedule_id=? AND status IN ('delivered','abandoned')
			AND id NOT IN (SELECT id FROM automation_deliveries WHERE schedule_id=? AND status IN ('delivered','abandoned') ORDER BY updated_at DESC LIMIT 100)`)
			.run(scheduleId, scheduleId);
		this.db.prepare(`DELETE FROM automation_deliveries WHERE status IN ('delivered','abandoned')
			AND id NOT IN (SELECT id FROM automation_deliveries WHERE status IN ('delivered','abandoned') ORDER BY updated_at DESC LIMIT 10000)`).run();
	}

	private migrate(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS automation_jobs (
				id TEXT PRIMARY KEY, platform TEXT NOT NULL, chat_id TEXT NOT NULL, user_id TEXT,
				name TEXT NOT NULL, kind TEXT NOT NULL, schedule_kind TEXT NOT NULL,
				schedule_value TEXT NOT NULL, timezone TEXT, payload_text TEXT NOT NULL,
				enabled INTEGER NOT NULL, delete_after_run INTEGER NOT NULL, next_run_at INTEGER NOT NULL,
				last_run_at INTEGER, last_status TEXT, consecutive_errors INTEGER NOT NULL DEFAULT 0,
				max_attempts INTEGER NOT NULL DEFAULT 3, misfire_policy TEXT NOT NULL DEFAULT 'run_once',
				misfire_grace_ms INTEGER NOT NULL DEFAULT 300000,
				locked_until INTEGER, claim_token TEXT, manual_resume_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_automation_due ON automation_jobs(enabled, next_run_at);
			CREATE TABLE IF NOT EXISTS automation_runs (
				id TEXT PRIMARY KEY, job_id TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL,
				status TEXT NOT NULL, output TEXT, error TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_automation_runs_job ON automation_runs(job_id, started_at DESC);
			CREATE TABLE IF NOT EXISTS automation_occurrences (
				id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, nominal_due_at INTEGER NOT NULL,
				status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
				claim_token TEXT, claim_expires_at INTEGER, started_at INTEGER, finished_at INTEGER,
				output TEXT, error TEXT, objective_id TEXT, task_run_id TEXT,
				created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
				UNIQUE(schedule_id, nominal_due_at)
			);
			CREATE INDEX IF NOT EXISTS idx_automation_occurrences_schedule ON automation_occurrences(schedule_id, nominal_due_at DESC);
			CREATE TABLE IF NOT EXISTS automation_deliveries (
				id TEXT PRIMARY KEY, occurrence_id TEXT NOT NULL UNIQUE, schedule_id TEXT NOT NULL,
				platform TEXT NOT NULL, chat_id TEXT NOT NULL, user_id TEXT, kind TEXT NOT NULL,
				payload_text TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
				status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
				claim_token TEXT, claim_expires_at INTEGER, delivered_at INTEGER, error TEXT,
				created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_automation_deliveries_due ON automation_deliveries(status, next_attempt_at);
			CREATE TABLE IF NOT EXISTS automation_routes (
				platform TEXT NOT NULL, user_id TEXT NOT NULL, chat_id TEXT NOT NULL, updated_at INTEGER NOT NULL,
				PRIMARY KEY(platform, user_id)
			);
			CREATE TABLE IF NOT EXISTS heartbeat_state (
				id INTEGER PRIMARY KEY CHECK(id = 1), last_run_at INTEGER NOT NULL,
				last_status TEXT NOT NULL, detail TEXT
			);
			CREATE TABLE IF NOT EXISTS media_deliveries (
				id TEXT PRIMARY KEY, platform TEXT NOT NULL, chat_id TEXT NOT NULL, user_id TEXT,
				path TEXT NOT NULL, mime_type TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL,
				next_attempt_at INTEGER NOT NULL, created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_media_deliveries_due ON media_deliveries(status, next_attempt_at);
		`);
		const columns = this.db.prepare("PRAGMA table_info(automation_jobs)").all() as Array<{ name: string }>;
		if (!columns.some((column) => column.name === "claim_token")) this.db.exec("ALTER TABLE automation_jobs ADD COLUMN claim_token TEXT");
		if (!columns.some((column) => column.name === "deleted_at")) this.db.exec("ALTER TABLE automation_jobs ADD COLUMN deleted_at INTEGER");
		if (!columns.some((column) => column.name === "max_attempts")) this.db.exec("ALTER TABLE automation_jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3");
		if (!columns.some((column) => column.name === "misfire_policy")) this.db.exec("ALTER TABLE automation_jobs ADD COLUMN misfire_policy TEXT NOT NULL DEFAULT 'run_once'");
		if (!columns.some((column) => column.name === "misfire_grace_ms")) this.db.exec("ALTER TABLE automation_jobs ADD COLUMN misfire_grace_ms INTEGER NOT NULL DEFAULT 300000");
		if (!columns.some((column) => column.name === "manual_resume_at")) this.db.exec("ALTER TABLE automation_jobs ADD COLUMN manual_resume_at INTEGER");
		const occurrenceColumns = this.db.prepare("PRAGMA table_info(automation_occurrences)").all() as Array<{ name: string }>;
		if (!occurrenceColumns.some((column) => column.name === "objective_id")) this.db.exec("ALTER TABLE automation_occurrences ADD COLUMN objective_id TEXT");
		if (!occurrenceColumns.some((column) => column.name === "task_run_id")) this.db.exec("ALTER TABLE automation_occurrences ADD COLUMN task_run_id TEXT");
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

interface JobRow { id:string;platform:string;chat_id:string;user_id:string|null;name:string;kind:string;schedule_kind:string;schedule_value:string;timezone:string|null;payload_text:string;enabled:number;delete_after_run:number;max_attempts:number;misfire_policy:string;misfire_grace_ms:number;next_run_at:number;last_run_at:number|null;last_status:string|null;consecutive_errors:number;claim_token:string|null;deleted_at:number|null;manual_resume_at:number|null;created_at:number;updated_at:number }
interface RunRow { id:string;job_id:string;started_at:number;finished_at:number;status:string;output:string|null;error:string|null }
interface OccurrenceRow { id:string;schedule_id:string;nominal_due_at:number;status:string;attempts:number;started_at:number|null;finished_at:number|null;output:string|null;error:string|null;objective_id:string|null;task_run_id:string|null }
interface DeliveryRow { id:string;occurrence_id:string;schedule_id:string;platform:string;chat_id:string;user_id:string|null;kind:string;payload_text:string;idempotency_key:string;status:string;attempts:number;next_attempt_at:number;claim_token:string|null;created_at:number }
interface MediaRow { id:string;platform:string;chat_id:string;user_id:string|null;path:string;mime_type:string|null;status:string;attempts:number;next_attempt_at:number;created_at:number }
function mapJob(row: JobRow): AutomationJob { return { id:row.id,platform:row.platform,chatId:row.chat_id,userId:row.user_id??undefined,name:row.name,kind:row.kind as AutomationKind,scheduleKind:row.schedule_kind as ScheduleKind,schedule:row.schedule_value,text:row.payload_text,timezone:row.timezone??undefined,enabled:Boolean(row.enabled),deleteAfterRun:Boolean(row.delete_after_run),maxAttempts:row.max_attempts,misfirePolicy:row.misfire_policy as AutomationJob["misfirePolicy"],misfireGraceMs:row.misfire_grace_ms,nextRunAt:row.next_run_at,lastRunAt:row.last_run_at??undefined,lastStatus:row.last_status??undefined,consecutiveErrors:row.consecutive_errors,claimToken:row.claim_token??undefined,manualResumeAt:row.manual_resume_at??undefined,createdAt:row.created_at,updatedAt:row.updated_at }; }
function mapRun(row: RunRow): AutomationRun { return { id:row.id,jobId:row.job_id,startedAt:row.started_at,finishedAt:row.finished_at,status:row.status as AutomationRun["status"],output:row.output??undefined,error:row.error??undefined }; }
function mapOccurrence(row: OccurrenceRow): AutomationOccurrence { return { id:row.id,scheduleId:row.schedule_id,nominalDueAt:row.nominal_due_at,status:row.status as AutomationOccurrence["status"],attempts:row.attempts,startedAt:row.started_at??undefined,finishedAt:row.finished_at??undefined,output:row.output??undefined,error:row.error??undefined,objectiveId:row.objective_id??undefined,taskRunId:row.task_run_id??undefined }; }
function mapDelivery(row: DeliveryRow): AutomationDelivery { return { id:row.id,occurrenceId:row.occurrence_id,scheduleId:row.schedule_id,platform:row.platform,chatId:row.chat_id,userId:row.user_id??undefined,kind:row.kind as "text",text:row.payload_text,idempotencyKey:row.idempotency_key,status:row.status as AutomationDelivery["status"],attempts:row.attempts,nextAttemptAt:row.next_attempt_at,claimToken:row.claim_token!,createdAt:row.created_at }; }
function mapMedia(row: MediaRow): MediaDelivery { return { id:row.id,platform:row.platform,chatId:row.chat_id,userId:row.user_id??undefined,path:row.path,mimeType:row.mime_type??undefined,status:row.status as MediaDelivery["status"],attempts:row.attempts,nextAttemptAt:row.next_attempt_at,createdAt:row.created_at }; }
