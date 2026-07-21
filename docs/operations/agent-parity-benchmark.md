# Agent parity benchmark

This benchmark compares BeeMax with pinned Codex and Hermes Agent builds on one versioned corpus. It is a differential diagnostic and release-evidence format, not a claim that a deterministic fixture run proves product parity.

## Reproducibility contract

[`evals/agent-parity-targets.json`](../../evals/agent-parity-targets.json) is the authority for product versions, models, machine profiles, network conditions, and scoring direction. [`evals/agent-parity-corpus.mjs`](../../evals/agent-parity-corpus.mjs) pins the seed and cases. Every captured run records its system identity, runtime environment, network condition, timestamp, adapter, exact corpus-content digest, and target-manifest digest. Each native adapter adds a source-evidence digest and the underlying Codex thread, Hermes session, or BeeMax execution identity when available.

Run products serially on an otherwise idle machine. Parallel product runs are invalid for latency comparison and can cause shared Provider throttling. Each case receives a fresh copy of the pinned fixture workspace. Gateway, Effect, Schedule, recovery, structured, source, image, Profile-scope, Skill, and MCP cases use the local `agent_parity` MCP fixture; the safety prompt prohibits contact with real messaging, enterprise, production, or customer systems. The benchmark process hosts a fresh loopback Streamable HTTP fixture service in-process for each case. The Agent receives only its random endpoint; the append-only authority path and HMAC key never enter a child-process environment or Agent configuration. Evidence credit requires both a valid authority record and a correlated settled Tool call.

`live-public-uncontrolled` preserves real source evidence but cannot make the public network deterministic. `isolated-fixture` is accepted only for the deterministic fixture adapter, so a native Agent cannot be mislabeled as isolated. `offline` is accepted only when the runner has already enforced network isolation and attests it with `AGENT_PARITY_OFFLINE_ENFORCED=true`; the environment label alone never counts as proof. Offline cases verify that current-data requirements block instead of silently becoming evergreen answers.

Every case receives a fresh workspace and isolated Agent state. BeeMax copies only Profile configuration, identity resources, and credential material into a disposable Profile; Hermes likewise receives a disposable home. Memory, Sessions, Tasks, Effects, logs, and prior case state are never reused. The cross-Profile differential case uses the same authority-backed target/foreign fixture for all three products; BeeMax's native Memory-store ownership remains covered separately by its release tests. Reports retain an OS identity/version check, the manifest-pinned adapter/provider/Profile/Toolset contract digest, and a one-way private configuration digest so configuration drift is visible without publishing credentials.

The comparison command accepts BeeMax only as the candidate and exactly Codex plus Hermes as baselines. It revalidates every report against the current corpus-content digest, target manifest, fixture-tree digest, product version/model/revision, machine profile, network enforcement, and pinned timeout before scoring it. Native CI additionally publishes GitHub build-provenance attestations for every JSON artifact; unattested local JSON is diagnostic evidence and must not be represented as release evidence.

## Capture native-product runs

Build BeeMax first, then run each command separately:

```sh
npm run build

npm run eval:agent-parity:capture -- \
  --mode best-native \
  --adapter evals/adapters/codex-cli.mjs \
  --system codex --version 0.144.1 --model gpt-5.6-sol \
  --adapter-options '{"fixtureRoot":"evals/fixtures/agent-parity"}' \
  --machine-profile darwin-26-arm64 \
  --network-condition live-public-uncontrolled --timeout-ms 180000 \
  --write evals/baselines/agent-parity/codex-native.json

npm run eval:agent-parity:capture -- \
  --mode best-native \
  --adapter evals/adapters/hermes-cli.mjs \
  --system hermes --version 0.15.1 --model glm-5-2-260617 \
  --adapter-options '{"fixtureRoot":"evals/fixtures/agent-parity","provider":"custom:ark"}' \
  --machine-profile darwin-26-arm64 \
  --network-condition live-public-uncontrolled --timeout-ms 180000 \
  --write evals/baselines/agent-parity/hermes-native.json

npm run eval:agent-parity:capture -- \
  --mode best-native \
  --adapter evals/adapters/beemax-cli.mjs \
  --system beemax --version 1.2.0 --model glm-5.2 \
  --adapter-options '{"fixtureRoot":"evals/fixtures/agent-parity","profile":"e2e-feishu","provider":"custom"}' \
  --machine-profile darwin-26-arm64 \
  --network-condition live-public-uncontrolled --timeout-ms 180000 \
  --write evals/baselines/agent-parity/beemax-native.json
```

Adapter configuration such as a BeeMax Profile or Hermes Provider is pinned as inline JSON with `--adapter-options`. Fixture mutations execute directly against the disposable loopback authority after the normal hard governance gates; the benchmark does not mint synthetic per-Turn Task grants. Do not include credentials: the report records evidence identities and digests, not secrets or raw Provider configuration.

Compare best supported native configurations:

```sh
npm run eval:agent-parity -- \
  --mode best-native \
  --candidate evals/baselines/agent-parity/beemax-native.json \
  --baseline evals/baselines/agent-parity/codex-native.json \
  --baseline evals/baselines/agent-parity/hermes-native.json \
  --write evals/baselines/agent-parity/best-native-comparison.json
```

The comparison exits nonzero when any gated BeeMax dimension is worse than a baseline. Success rate, capability recall, Tool-call settlement, argument validity, unnecessary calls, evidence coverage, downgrade assessment, Effect assessment, duplicate Effects, recovery, and user interventions remain separate; no aggregate score can hide a regression. Latency and tokens are recorded for diagnosis and must be interpreted only between matched machine, operating-system, and network profiles.

Argument validity means schema acceptance, not merely “some JSON was present”: malformed arguments are invalid, a Tool call accepted and completed by the Runtime is valid, and a syntactically valid call that failed before schema acceptance remains unassessed. Raw argument values and credentials are never copied into the report; only sanitized key shapes or execution correlations are retained. Current-data output passes only when final citations are bound to successful Tool receipts from the required number of distinct registrable domains and each exact URL, including its query, was fetched through a DNS-pinned public IP after validating every redirect. “Distinct” is deliberately a domain-diversity measure; it does not claim knowledge of legal ownership across domains. Query strings are removed only from the persisted report to avoid leaking credentials. A successful answer that fails its output contract is recorded as an unauthorized degradation rather than a successful fallback.

## CI evidence

CI runs the full corpus unattended on macOS 26 and Ubuntu 24.04 with the deterministic adapter, then uploads one contract report per operating system. Those artifacts prove that corpus execution and report generation are portable. The separate `agent-parity-native.yml` workflow runs the three pinned products serially on credentialed macOS and Ubuntu self-hosted runners, verifies installed revisions, and uploads native source-backed reports. Native artifacts from both platforms are required before making parity claims.
