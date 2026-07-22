# Thruvera L4 Memory Learning Rollout and Certification

Status: release-gate design

Architecture: [Thruvera L4 Memory Learning Architecture](../architecture/l4-memory-learning-architecture.md)

Product specification: [Thruvera L4 Outcome-Driven Memory and Learning System](../superpowers/specs/2026-07-18-thruvera-l4-memory-learning-system.md)

## 1. Release truth

Thruvera may be labeled L4 Memory only after this document's production-path gates
pass. Deterministic fixtures, simulated faults, mocked providers, route-only
checks, and live end-to-end trials are reported separately. None may substitute
for another category.

A real trial has all of these properties:

- the released Thruvera application entry point is used;
- the declared real model and Tool providers are actually called;
- authentication, network, sandbox, file generation, Verification, and delivery
  use the same production path as a user Objective;
- the Work Contract, source snapshot or time window, provider/model versions,
  Profile rollout state, and exact verifier are captured;
- expected Artifacts are opened and independently checked, not inferred from an
  Agent message;
- retry, reroute, and fallback are included in the outcome rather than hidden;
- raw run evidence remains attributable to one manifest and execution identity.

If any condition is missing, the result is `not-certified`; it is never converted
to success by manual interpretation.

## 2. Release evidence bundle

Every certification run produces an immutable bundle:

```text
certification/<release-candidate>/
  manifest.json
  environment.json
  cases.jsonl
  executions.jsonl
  verification.jsonl
  metrics.json
  comparison.json
  incidents.jsonl
  report.html
  report.pdf
  checksums.txt
```

The repository may store only content-safe summaries while protected evidence is
retained in the configured artifact authority. The checksums and identity links
must still be present.

### 2.1 Manifest requirements

`manifest.json` records:

- Thruvera release candidate commit and package version;
- SQLite schema and L4 policy versions;
- Profile rollout configuration;
- task corpus version and case IDs;
- real provider, model, Tool, browser, renderer, and verifier versions;
- Skill stable/canary digests;
- source snapshot identifiers or exact observation windows;
- timezone, locale, sandbox, and supported operating-system information;
- Memory-On/Memory-Off assignment and randomization seed;
- repetition count and planned confidence calculation;
- declared exclusions before execution.

Changing any item creates a new manifest. Results from different manifests may be
compared but cannot be pooled without an explicit stratified analysis.

### 2.2 Per-execution record

Each `executions.jsonl` row includes content-free IDs and bounded measurements:

- case, repetition, arm, Profile, execution, Objective, Task Run, and manifest IDs;
- start/end time, terminal state, retry/reroute count, and user intervention count;
- Context Pack and settlement IDs;
- selected Capability, Tool, and exact Skill version receipts;
- artifact and source receipt IDs;
- criterion Verification statuses and independent verifier identity;
- attributed causes, unknown-attribution flag, and learning transitions;
- end-to-end, prepare, retrieval, Tool, model, Verification, and delivery latency;
- whether every required production path condition was observed.

No chain-of-thought, Credential, raw prompt, or customer content is required for
certification.

## 3. Corpus design

The versioned corpus contains representative and adversarial task families:

1. time-sensitive, source-backed research with HTML and PDF Artifacts;
2. structured data analysis and verified spreadsheet delivery;
3. repository investigation and independently verified code change;
4. browser interaction with state observation and safe recovery;
5. multimodal input and artifact production;
6. personal, project, and organization recall with exact scope distractors;
7. correction, conflict, expiry, revocation, and forgetting propagation;
8. repeated workflow learning and managed Skill canary;
9. missing-Capability investigation and safe alternative selection;
10. provider, Tool, renderer, and Verification transient failures;
11. crash/restart during each atomic learning boundary;
12. negative activation cases where Memory or a Skill must remain absent;
13. poisoned evidence, stored prompt injection, Credential, and forged authority;
14. high-risk situations in which automatic promotion or restoration is forbidden.

Every family includes accepted and negative cases. The corpus must not consist only
of workflows from which the learned item was derived.

### 3.1 Paired comparison

Memory-On and Memory-Off use the same Work Contract, source window, Tool inventory,
authority, verifier, and provider/model stratum. Assignment alternates or is
randomized within the stratum to reduce temporal provider drift. Where a live
source cannot be frozen, the pair runs inside the same declared observation window
and the limitation is reported.

Memory-Off disables optional L4 retrieval, contextual assessment influence,
projections, and learned managed Skill selection. It keeps safety Memory, current
request, Work Contract, Task preservation, Credentials, Policy, and normal Runtime
recovery so the comparison isolates L4 contribution rather than disabling Thruvera.

### 3.2 Repetition and stability

Each representative task family runs at least five independent current-version
repetitions across at least two real model providers and separate time windows.
More samples are required when the confidence interval crosses a release gate.

One accepted run proves only that a route worked once. It does not establish a
success rate, accuracy rate, or stability rate.

## 4. Metric definitions

All denominators, exclusions, sample counts, point estimates, and 95% confidence
intervals are published.

### 4.1 Outcome metrics

```text
accepted_completion_rate = independently accepted executions
                         / eligible real executions

accuracy_rate = accepted required criteria
              / all available required criteria

stability_rate = task families meeting their acceptance floor in every required
                 provider/time stratum
               / evaluated representative task families

negative_transfer_rate = paired cases accepted with Memory-Off but rejected with
                         Memory-On where L4 contribution is causally implicated
                       / eligible paired cases

user_intervention_rate = user operation requests during execution
                       / accepted Objectives
```

Unavailable independent Verification is excluded from accuracy only when reported
as a separate availability failure; it never counts as accepted. Cancellation and
authorization denial have separate denominators and do not train utility.

### 4.2 Memory quality metrics

```text
promotion_precision = valid promoted semantic items / reviewed promoted items
scoped_recall_at_5 = relevant accessible items in top five / relevant accessible items
provenance_coverage = active items with valid evidence lineage / active items
correction_propagation = dependent views invalidated or rebuilt / affected views
false_downgrade_rate = unsupported automatic downgrades / automatic downgrades
downgrade_precision = supported automatic downgrades / automatic downgrades
```

Forbidden retrieval is counted before rendering and after rendering. Either count
above zero fails the release.

### 4.3 Attribution and Skill metrics

```text
attribution_accuracy = correctly labeled supported/unknown component causes
                     / labeled settlement cases

skill_route_completion = independently accepted executions using the selected
                         managed Skill version
                       / eligible executions selecting a managed Skill

candidate_contamination = executions loading an unpromoted Candidate
```

The attribution set includes ambiguous cases. Guessing a plausible cause instead
of returning `unknown` is incorrect.

### 4.4 Reliability and performance

- exact-once logical settlement/promotion/projection/rollback under crash;
- reconciliation lag from terminal outcome to durable learning signal;
- `prepare` P50/P95 and fallback rate;
- end-to-end duration and healthy-provider report-class P50/P95;
- model/Tool calls, recovery attempts, and provider availability;
- projection freshness and maintenance backlog age;
- Skill pointer mismatch and fallback count.

For the representative research-report family, the healthy-provider target is
P95 at or below five minutes. Duration, Tool calls, token use, and cost are
diagnostics and optimization inputs; they are not cumulative silent Objective
termination rules.

## 5. Initial L4 release gates

All gates must pass in the same release-candidate evidence set:

| Gate | Requirement |
| --- | ---: |
| cross-scope or cross-Profile retrieval | exactly 0 |
| active Claim and promoted Skill provenance coverage | 100% |
| correction and forgetting propagation | 100% |
| critical organization fact false promotion | 0 |
| general promoted-memory precision | at least 98% |
| scoped Recall@5 | at least 90%, forbidden retrieval 0 |
| labeled causal-attribution accuracy | at least 90% |
| automatic downgrade precision | at least 95% |
| false automatic downgrade | at most 2% |
| managed-Skill route completion | at least 95% |
| Candidate contamination of active behavior | 0 |
| fault-corpus logical exactly-once behavior | 100% |
| Memory-On accepted completion uplift | at least +10 percentage points |
| negative transfer | at most 2% |
| user intervention reduction on repeated Objectives | at least 30% |
| production-path evidence coverage for claimed real trials | 100% |

Safety gates have no confidence-interval waiver. For statistical quality gates,
the conservative bound used for release must be declared in the manifest; a point
estimate above the threshold with an inconclusive interval is not a pass.

## 6. Test layers

### 6.1 Deterministic contract suite

Runs on every change and covers:

- four-method Kernel Interface behavior;
- exact scope predicates before rank and limit;
- English, spaced Chinese, and continuous Chinese retrieval;
- immutable receipts, idempotency, correction, conflict, expiry, forgetting;
- accepted/rejected/unavailable/cancelled/mixed settlement;
- posterior math, hysteresis, high-risk failure, restoration;
- projection lineage, pointer swap, invalidation, and fallback;
- Skill quarantine, exact-version fencing, canary, and rollback;
- secret, stored-instruction, scope escalation, and authority-forgery rejection;
- migration, backup, restore, schema checksum, and old-Profile compatibility.

The suite includes mutation tests for gate ordering, attribution eligibility,
threshold comparisons, state transitions, and transaction fences. A test that
passes after removing the critical guard is insufficient.

### 6.2 Simulated-fault suite

Fault injection covers source drift, malformed model output, semantic index
corruption, busy SQLite, expired lease, duplicate signal, concurrent settlement,
process kill, stale projection, Skill pointer mismatch, provider outage, Tool
partial failure, unknown Effect, duplicate delivery, and Verification outage.

Expected outcomes are local attribution, deterministic fallback or durable defer,
no duplicate authority transition, no unrelated downgrade, and no expanded
authority.

### 6.3 Live component suite

Real extractors, rankers, model providers, Tools, browser, renderer, and verifiers
run individually against versioned cases. This identifies provider regressions but
does not count as end-to-end task success.

### 6.4 Real end-to-end suite

Runs through the released application entry point and independently opens every
required artifact. It produces the paired evidence used for L4 outcome gates.

## 7. Migration procedure

L4 migrations are additive and numbered. Each release performs:

1. acquire Profile maintenance ownership and stop new write admission;
2. verify Profile database identity and current schema checksum;
3. create a SQLite online backup to a versioned path;
4. run integrity verification on the backup;
5. apply each pending migration in its own transaction;
6. verify schema, foreign keys, required indices, and migration checksums;
7. start read-compatible Runtime with `adaptive_learning=disabled`;
8. run Profile smoke tests and reconciliation in observation mode;
9. re-enable normal writes;
10. retain the verified backup until the rollback window closes.

No migration destructively rewrites existing Claims, Episodes, Candidates, Tasks,
or signed Skills. Rebuildable search indices and projections populate
asynchronously after normal service resumes.

### 7.1 Backfill rules

- existing active Claims begin `eligible` with the neutral `Beta(2,2)` prior;
- no historical success credit is invented from an Episode unless the current
  Verification and contribution identities can be correlated exactly;
- existing verified Episodes remain semantic authority but do not become
  assessment events by mere existence;
- current managed Skill becomes the stable version; no canary is inferred;
- existing compiled summaries are marked legacy rebuildable projections and are
  not authoritative inputs;
- missing immutable digests are generated from canonical current records with a
  migration evidence receipt.

### 7.2 Migration rollback

Before learning influence is enabled, application rollback may use the verified
pre-migration backup. After new semantic writes occur, file replacement is unsafe;
the release must disable `adaptive_learning`, run forward-compatible code, and use
a tested corrective migration. Never discard new user evidence to restore an old
schema.

## 8. Staged rollout

One new Profile rollout level, `adaptive_learning`, uses the existing status model
and emergency stop. Rollout proceeds by cohort and never silently skips a phase.

| Phase | Behavior | Minimum exit evidence |
| --- | --- | --- |
| 0 baseline | tables/Interface absent or unused | current suites and live baseline frozen |
| 1 observe | signals, packs, receipts; no model extraction or influence | exact correlation/reconciliation |
| 2 shadow extraction | proposals and attribution, no authority transition | precision and poisoning gates |
| 3 shadow prepare | compare Context Packs, do not inject optional L4 Memory | recall, latency, scope gates |
| 4 personal/project recall | eligible records influence low/medium-risk context | paired uplift, negative transfer gate |
| 5 low-risk promotion | automatic bounded semantic promotion | promotion precision and correction gates |
| 6 assessment influence | cautious/suppressed/restored state affects selection | downgrade/false-downgrade gates |
| 7 managed Skill canary | read-only canary and automatic rollback | exact-version and Skill completion gates |
| 8 governed organization learning | authorized broader projections/candidates | organization false-promotion gate |

Each phase starts with internal Profiles, then an explicit small cohort, then wider
cohorts. A minimum seven-day soak is required after assessment influence and after
managed Skill canary; the final release evidence still requires the separate time
windows defined in section 3.

## 9. Monitoring and alerts

Release dashboards separate execution health from learning health.

### Execution health

- accepted completion and criterion accuracy;
- Verification availability;
- delivery success and artifact validity;
- healthy-provider report duration;
- recovery/reroute and user intervention.

### Learning health

- signal backlog age and lease churn;
- Contribution Receipt coverage;
- unknown and rejected attribution rates;
- promotion, cautious, suppression, restoration, and rollback counts;
- false-downgrade samples;
- projection invalidation/rebuild lag;
- Context Pack optional omission and deterministic fallback rate;
- Skill canary exposure, success, safety failure, and pointer mismatch.

Alerts use bounded reason codes and component kinds. They do not label by customer
content or Situation open features.

## 10. Emergency stop and incident response

Emergency stop changes `adaptive_learning` to `stopped` through existing trusted
authority. It must:

- stop new assessment influence, promotion, suppression/restoration, projection
  publication, and canary selection;
- route managed Skills to the last mutually verified stable version;
- preserve Evidence, terminal outcomes, learning signals, explanation, and manual
  rollback capability;
- leave unrelated accepted Objectives and safe Memory reads operating;
- avoid deleting or rewriting history.

### 10.1 Leakage or authority expansion

1. stop adaptive learning for affected Profiles;
2. stop optional L4 recall if exposure may continue;
3. preserve content-safe execution, pack, and query-plan evidence;
4. identify the violated hard gate and affected scope set;
5. invalidate affected projections/receipts and complete required privacy response;
6. patch and add a mutation test that fails without the gate;
7. rerun all zero-tolerance scope and poisoning suites before restart.

### 10.2 False promotion or downgrade

1. stop the affected transition class, not unrelated evidence capture;
2. roll back the Candidate/Skill pointer or set component to `cautious`;
3. inspect settlement, attribution support, threshold policy, and assessment event;
4. compensate erroneous assessment events rather than editing history;
5. add the case to the labeled corpus;
6. resume from shadow mode after precision gates pass.

### 10.3 Corrupt projection or index

Invalidate the derived artifact, use authoritative fallback, rebuild from fenced
inputs, and verify the current pointer. Do not restore a projection from a cache
without validating every input revision.

### 10.4 Skill pointer mismatch

Select the last signed version whose filesystem receipt and SQLite stable pointer
agree, stop canary exposure, reconcile under maintenance ownership, and verify a
real safe route before resuming.

## 11. Release checklist

- [ ] package and schema versions updated together;
- [ ] all design and ADR links resolve;
- [ ] deterministic, mutation, migration, and simulated-fault suites pass;
- [ ] live component failures are explicitly separated from fixtures;
- [ ] real end-to-end bundle satisfies production-path evidence coverage;
- [ ] all zero-tolerance gates pass;
- [ ] quality gates pass with declared conservative confidence treatment;
- [ ] Memory-On/Off uplift and negative transfer pass in each required stratum;
- [ ] backup, restore, forward-corrective migration, and emergency stop rehearsed;
- [ ] seven-day assessment and Skill-canary soak evidence complete;
- [ ] no Candidate, external Runtime, secret, or untrusted authority enters release;
- [ ] report HTML and PDF open successfully and match `metrics.json`;
- [ ] release notes state exact measured sample counts and do not generalize beyond
      the certified task families.

Only after the checklist and gates pass may the package version be published as an
L4 release. A version update is the final evidence-backed step, not a substitute
for the evidence.
