# Organizational intelligence autonomy rollout

BeeMax releases organizational-intelligence capabilities per Profile. These levels are platform capability boundaries, not customer business stages and not an ontology for orders, tickets, customers, or any other domain object.

## Levels and dependencies

| Level | Capability boundary | Required enabled dependency |
| --- | --- | --- |
| `situation_context` | Situation may contribute to organizational cognition | none |
| `episode_publication` | verified outcomes may become Episodes | Situation |
| `initiative_observation` | triggers may create observe-only Initiative observations | Situation and Episodes |
| `read_only_investigation` | accepted Initiative may create a read-only Objective executed by Pi | Initiative |
| `reversible_action` | a separately governed low-risk reversible mutation may be admitted | read-only investigation |

New Profiles are fail-closed: all five levels start `disabled`. Enabling a level never bypasses Action Governance, Enterprise Policy, Access Scope, Tool Effects, Verification, or the Pi execution path. High-risk and irreversible autonomy are deliberately absent from the level set.

## Promotion evidence

Promotion and resume consume only the passing, schema-versioned `evals/baselines/current.json` shipped with the installed release. BeeMax maps its measured quality, safety, value, interruption, duplication, and reversibility metrics and derives an evidence reference from the corpus identity plus the artifact SHA-256. Callers cannot supply their own promotion JSON or evidence reference. Enterprise `allow` cannot override a failed metric or disabled dependency. Enterprise `deny`, stop, and rollback fail closed.

Minimum gates are:

- Situation: precision and correction retention at least 98%; unauthorized retrievals zero.
- Episodes: verified completion 100%, correction retention at least 98%; unauthorized retrievals zero.
- Initiative: precision at least 60%, average expected value at least 70%, interruption at most 10%; duplicates and unauthorized retrievals zero.
- Read-only investigation: precision and adoption at least 60%, interruption at most 10%; duplicate Objectives and unauthorized retrievals zero.
- Reversible action: Policy/scope coverage, Emergency Stop blocking, and Compensation success all 100%; duplicate Compensation, high-risk actions, and irreversible actions zero.

The internal mapped shape is the `AutonomyRolloutEvidence` interface in `packages/core/src/autonomy-rollout.ts`. Promotion references identify the immutable installed evaluation artifact. Stop and rollback references identify an incident, release decision, or other auditable operator event.

## Operations

```bash
beemax autonomy status --profile <profile>
beemax autonomy promote situation_context --yes --profile <profile>
beemax autonomy stop read_only_investigation --evidence-ref incident:2026-07-13 --yes --profile <profile>
beemax autonomy rollback reversible_action --evidence-ref release:rollback-42 --yes --profile <profile>
beemax autonomy resume read_only_investigation --yes --profile <profile>
```

Stop and rollback affect only the named persisted level. Lower independent levels remain active. Any higher level that depends on a stopped level is effectively denied without having its own history overwritten. Resume re-runs current evidence gates; it is not a blind toggle. Gateway workers read the same SQLite authority on each admission boundary, so a stop takes effect without restarting the Profile.

The local CLI acts only as the Profile operator; it cannot label itself as an enterprise authority. Enterprise overrides enter through a trusted Enterprise Policy publisher at the Core API and retain that publisher in the durable record. The SQLite row is revision-fenced and timestamp-fenced. Concurrent stale writers cannot overwrite a newer pause or rollback. The record retains actor/publisher, evidence reference, evaluated metrics, reasons, revision, and time for audit and restart recovery.
