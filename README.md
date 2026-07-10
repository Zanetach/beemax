# BeeMax Agent

An autonomous agent based on [Pi](https://pi.dev), targeting feature parity with Hermes Agent's gateway + memory model.

## Status: usable personal-agent runtime

- [x] Monorepo wired to Pi (`pi-ai` + `pi-agent-core` as workspace deps)
- [x] Platform abstraction layer (`PlatformAdapter`)
- [x] Feishu adapter (WebSocket long-connection, self-built app identity, @-mention gating, dedup, card send/update)
- [x] Dispatcher: per-chat agent sessions, serialized turns
- [x] **Streaming interactive cards (pure TS)** - no Python, no sidecar process
  - `CardSession` accumulates thinking + tools + answer + footer
  - `renderCard()` produces Feishu CardKit v2.0 JSON (status header + collapsible timeline + footer stats)
  - `FlushController` coalesces rapid deltas into throttled card patches (5 QPS limit)
  - Pi agent events mapped: tool_execution_* -> tool.updated, message_update -> answer.delta (growth only)
- [x] FTS5 long-term memory with safe natural-language queries, cross-chat user recall, and explicit remember/recall/list/forget tools
- [x] CLI: `beemax gateway` / `beemax chat` / `beemax model`
- [x] Pi AgentSession integration with built-in `read/bash/edit/write/grep/find/ls` tools (bound to configured cwd)
- [x] Network research tools: `web_search` (Tavily / Brave / SearXNG) + SSRF-guarded `web_extract`
- [x] Feishu meeting tools: details/list, reservations, participants, host control, and recording lifecycle
- [x] MCP client bridge: stdio + Streamable HTTP, environment-secret expansion, namespaced tools, mutating-tool approval
- [x] Pi Agent Skills loading plus managed instruction-only skill creation/update and post-turn hot reload
- [x] Persistent reminders, interval/cron agent tasks, run history, retries, and proactive delivery
- [x] OpenClaw-inspired Heartbeat: active hours, busy deferral, isolated read-only turns, `HEARTBEAT_OK` suppression
- [x] One-profile-per-process isolation with per-profile model, Feishu app, memory, sessions, Skills, MCP, automation, and systemd unit
- [x] GPT Image 2 generation through profile-local ChatGPT/Codex OAuth with native Feishu image delivery
- [x] Isolated read-only Sub-Agents with bounded concurrency, status/wait/cancel tools, and cascading `/stop`
- [x] `beemax doctor` readiness diagnostics
- [x] `beemax profile doctor` and `beemax gateway health` readiness aliases
- [x] Multi-profile Gateway service operations with `--all`
- [x] Profile-home backup via `beemax profile backup`
- [x] Deny-by-default Feishu user/chat allowlists
- [x] Text approval for `bash/edit/write`: allow once / allow for session / deny
- [x] Workspace boundary, sensitive credential path, and destructive-command hard blocks
- [x] Deterministic Pi JSONL persistence/resume per Feishu chat + stable user identity
- [ ] Feishu User OAuth for private calendar/doc resources
- [ ] Attachment/image/audio ingestion

## Architecture

```
Feishu today · DingTalk / WeCom / API adapters planned
              │
              ▼
Gateway Control Plane
  adapters · auth · profile routing · idempotency · delivery · health
              │
              ▼
BeeMax Core Runtime
  Agent runs · sessions · prompt/context · memory · tools · sub-agents
              │
              ▼
Capability adapters
  MCP · Web · Memory · Automation · Feishu meetings · image generation
```

**Pure TypeScript.** `@beemax/core` is the only Agent Runtime; Pi is its
implementation dependency. Gateway holds channel SDKs and enterprise control
plane concerns, while capability packages provide MCP, meeting and other
external integrations. The Feishu card renderer remains in
`packages/gateway/src/card/` and only presents Core run events.

## Quick start

### Install and configure an Agent

On Linux or macOS with Node.js 22.19 or newer:

```bash
curl -fsSL https://raw.githubusercontent.com/Zanetach/beemax/v0.1.0-preview.5/scripts/bootstrap-install.sh | bash

# Or, from a source checkout:
./scripts/install.sh

beemax setup --profile personal
```

The one-command installer downloads one verified BeeMax release archive, which
already contains Pi. It keeps executable source files in `~/.beemax/app` and
the `beemax` command in `~/.local/bin`; Agent Profiles, secrets, memory, and
sessions remain isolated under `~/.beemax/profiles`. To install another build,
set `BEEMAX_VERSION`, for example `curl -fsSL https://raw.githubusercontent.com/Zanetach/beemax/v0.1.0-preview.5/scripts/bootstrap-install.sh | BEEMAX_VERSION=v0.1.0-preview.5 bash`.
Run the same installer with `--uninstall` to remove application files while
keeping your Profiles and data.

The setup wizard creates the Profile, configures `SOUL.md`, model credentials,
the Feishu/Lark channel and allowlist, prints the required Feishu permissions
and publishing checklist, probes the tenant token and bot identity, then runs
the full doctor. Use `beemax gateway setup --profile personal` to reconfigure
only the messaging channel. The lower-level `model`, `channel`, and `doctor`
commands remain available for automation and focused changes.

The model and Feishu setup commands prompt for missing secrets without writing
them to YAML. Each Agent is an isolated Profile Home at
`~/.beemax/profiles/<name>/`; its secrets live in `.env` with mode `0600`, while
identity lives in `SOUL.md`. Set `BEEMAX_HOME` to relocate all Profile Homes.

For the first end-to-end test, keep the gateway in the foreground:

```bash
beemax gateway --profile personal
```

After a successful Feishu message test, install a user-level systemd service on
Linux (no root required) and start that profile as its own process:

```bash
beemax service install
beemax start personal
beemax status personal
beemax logs personal
```

The Hermes-style Gateway lifecycle aliases are also available:

```text
beemax gateway run --profile personal
beemax gateway install --profile personal
beemax gateway start --profile personal
beemax gateway stop --profile personal
beemax gateway restart --profile personal
beemax gateway status --profile personal
beemax gateway logs --profile personal
beemax gateway list
```

Only one running Profile Gateway may consume a given Feishu App ID. A second
Profile using the same App is rejected by the per-Home channel lock.

Profiles use the `standard` Toolset by default. For a lower-trust group or
public-facing Profile, set `agent.toolset: safe` in its `config.yaml` and
restart the Gateway. `safe` exposes read/search, memory inspection, schedules,
Skill inspection, task status, and read-only MCP tools only; it excludes shell,
file writes, memory mutation, scheduling mutation, image generation, and
mutating MCP tools.

### Feishu webhook deployment

WebSocket is the default. For a public HTTPS webhook deployment, configure a
reverse proxy to forward the exact event path to BeeMax and use an encryption
key from the Feishu event-subscription settings. BeeMax refuses to start a
webhook listener without that key. Put it in `FEISHU_WEBHOOK_ENCRYPT_KEY` in
the Profile `.env`; never pass it as a command-line argument.

```bash
beemax gateway setup --profile personal --connection-mode webhook \
  --webhook-host 127.0.0.1 --webhook-port 8787 \
  --webhook-path /feishu/events
beemax gateway health --profile personal
```

Set Feishu's request URL to your proxy's HTTPS URL ending in `/feishu/events`;
do not add a query string. BeeMax accepts only POST requests, limits request
bodies to 1 MiB, and applies short HTTP timeouts. `beemax channel qr --open`
opens the Feishu Developer Console for the required sign-in/app setup; it does
not create an app on your behalf.

Use `beemax service install --system` as root only when a machine-wide service
is required; set `BEEMAX_SERVICE_USER` to the non-root account that should run
the Agent. For a user service that must start before login on a headless server,
enable lingering once with `sudo loginctl enable-linger $USER`. On macOS, WSL
without systemd, or containers without a supervisor,
keep using the foreground `gateway` command.

Each profile has its own gateway process, model, Feishu application, secrets,
memory, sessions, Skills, MCP servers, and automation state. Useful management
commands are:

```text
beemax profile create <name>
beemax profile list
beemax profile show <name>
beemax profile use <name>
beemax profile migrate <name>
beemax profile delete <name> --yes
beemax channel list --profile <name>
beemax channel remove --profile <name> --yes
beemax stop|restart|status|logs <name>
```

### Source-only quick start

```bash
npm install
npm run build

# Feishu (self-built app: https://open.feishu.cn/app)
export FEISHU_APP_ID=cli_xxx
export FEISHU_APP_SECRET=xxx
export FEISHU_ALLOWED_USERS=on_xxx,ou_xxx  # required unless explicitly public
export BEEMAX_API_KEY=sk-ant-xxx        # or ANTHROPIC_API_KEY
export TAVILY_API_KEY=tvly-xxx           # or BRAVE_SEARCH_API_KEY / SEARXNG_URL

npm run doctor     # validates local readiness
npm run gateway    # starts the long-running Feishu agent
```

Access is deny-by-default. Set `FEISHU_ALLOWED_USERS` to Feishu union_id,
user_id, or open_id values. Optionally restrict chats with
`FEISHU_ALLOWED_CHATS`. `FEISHU_ALLOW_ALL_USERS=true` explicitly disables the
user allowlist and should only be used for intentional public/development bots.

Mutating local, Feishu, Skill, memory-deletion, and MCP tools pause for approval
in Feishu. Reply `1` to allow once, `2` to allow that tool for the current
process session, or `3` to deny.

Subscribe to the `im.message.receive_v1` event in the Feishu developer console
and enable "长连接" (WebSocket long-connection). Grant
`im:message.p2p_msg:readonly`, `im:message.group_at_msg:readonly`, and
`im:message:send_as_bot`; enable the Bot capability and publish an app version
before testing. No public HTTPS endpoint is needed.

## Profiles: one Agent per process

A named Profile is a self-contained Agent Home under
`~/.beemax/profiles/<name>/`. It owns `config.yaml`, `.env`, `SOUL.md`, Memory,
Pi auth/session state, Skills, MCP configuration, caches, schedules, and
Gateway state. Legacy `config/profiles/<name>.yaml` Profiles remain readable and
can be copied non-destructively with `beemax profile migrate <name>`.

```bash
beemax profile create personal
beemax profile list
beemax profile show personal
beemax profile use personal
beemax profile doctor personal
beemax profile start personal
# equivalent: npm run gateway -- --profile personal
```

Different profiles can use different models:

```yaml
# ~/.beemax/profiles/personal/config.yaml
model: { provider: anthropic, model: claude-sonnet-4-5 }

# ~/.beemax/profiles/work/config.yaml
model: { provider: openrouter, model: openai/gpt-5.2 }
```

The user-level service reads each Profile's `.env` directly. For a system-level
service, set `BEEMAX_HOME` to a directory owned by `BEEMAX_SERVICE_USER` before
installing; `/etc/beemax/<profile>.env` remains an optional final override:

```bash
sudo install -d -o beemax -g beemax /var/lib/beemax
sudo -u beemax BEEMAX_HOME=/var/lib/beemax beemax profile create personal
sudo BEEMAX_SERVICE_USER=beemax BEEMAX_HOME=/var/lib/beemax beemax service install --system
sudo systemctl enable --now beemax@personal
journalctl -u beemax@personal -f
```

## Reminders, scheduled tasks, and Heartbeat

```text
reminder_create
schedule_create
schedule_list
schedule_pause
schedule_resume
schedule_delete
schedule_runs
```

Schedules and run state live in the profile SQLite database. One-shot reminders
accept ISO timestamps or relative durations such as `20m`; recurring work accepts
fixed intervals or timezone-aware cron expressions. Transient failures retry with
30s/60s/5m backoff. Scheduled model turns run in isolated sessions with read-only
tools so unattended work cannot block on an approval prompt.

Heartbeat defaults to every 30 minutes during configured active hours. It uses
the last authorized DM unless a fixed chat is configured, defers while the agent
is busy, reads the small `HEARTBEAT.md` checklist, and suppresses `HEARTBEAT_OK`
responses. Only actionable output is proactively sent.

## Sub-Agent delegation

BeeMax 0.1 can delegate independent research and analysis to fresh Pi
AgentSessions without copying the parent conversation. Parent Agents receive:

```text
task_spawn   task_status   task_wait   task_cancel
```

Sub-Agents can read workspace files, search/extract the web, recall/list memory,
and call read-only MCP tools. They cannot run shell commands, modify files,
write or delete memory, change Skills, schedule work, send Feishu messages, or
spawn another Agent. Their task tools appear in the parent Feishu card timeline.

```yaml
subagents:
  enabled: true
  maxConcurrent: 3
  maxChildrenPerOwner: 5
  timeoutMs: 900000
```

Tasks above the concurrency limit queue. `/stop` aborts the active parent turn
and cascades cancellation to its queued/running Sub-Agents. In 0.1, task state
is process-local: active tasks are cancelled during Gateway shutdown and are
not resumed after restart; child Pi transcripts remain in the profile session
directory for audit.

## Codex image generation

Image generation is configured independently per profile and does not require
that profile's chat model to be Codex. For example, an Anthropic chat Agent can
still use its own profile-local Codex OAuth for `image_generate`.

```yaml
imageGeneration:
  enabled: true
  provider: openai-codex
  quality: medium # low | medium | high
  outputDir: cache/images
```

Authenticate once for that profile:

```bash
beemax auth codex --profile personal
```

The tool routes GPT Image 2 through the ChatGPT/Codex Responses image-generation
surface, stores the PNG under the profile cache with mode `0600`, uploads it to
Feishu as a native image message, and never writes OAuth tokens into tool output
or logs. Calls require approval because they consume external generation quota.

## Memory, MCP, and Skills

### Bundled Profile Skills

Every newly created BeeMax Profile receives the bundled Skills below in its
own `skills/` directory. Existing Profiles can receive missing packaged Skills
without replacing custom ones:

```bash
beemax skills list --profile personal
beemax skills sync --profile personal
```

| Skill | Purpose |
| --- | --- |
| `business-copywriting` | Campaign, product, sales, and social copy |
| `business-report` | Decision memos, reports, proposals, and reviews |
| `ppt-production` | Deck narrative, slide plan, speaker notes, and PPT production guardrails |
| `research-and-brief` | Sourced research and executive briefs |
| `feishu-workspace` | Safe Feishu messages, documents, meetings, and permissions |
| `image-creative` | Creative direction and image-generation workflow |
| `weekly-review` | Evidence-based weekly reviews and priorities |
| `humanizer` | Natural-language editing, copied from Hermes Agent under MIT |
| `arxiv-research` | arXiv paper discovery, copied from Hermes Agent under MIT |

Skills use progressive disclosure: only each Skill's name and description are
present in the Agent prompt; the Agent reads the relevant `SKILL.md` only after
the task matches it. See `THIRD_PARTY_NOTICES.md` for Hermes-derived Skill
attribution and license terms.

Skills may declare `metadata.beemax` requirements. BeeMax hides a Skill when
its required Toolset, environment variables, or binaries are unavailable. For
example, `arxiv-research` needs the `standard` Toolset plus `curl` and
`python3`; `image-creative` and `ppt-production` require `standard`.

BeeMax automatically recalls relevant prior exchanges and exposes explicit
personal-memory tools:

```text
memory_remember  memory_recall  memory_list  memory_forget
```

Inspect and curate a Profile's staged memory from the CLI:

```bash
beemax memory status --profile personal
beemax memory candidates --profile personal
beemax memory promote <candidate-id> --profile personal --yes
beemax memory reject <candidate-id> --profile personal --yes
```

Pi discovers trusted Skills from its standard global/project locations. BeeMax
also manages durable instruction-only evolved skills under
`data/agent/skills/<name>/SKILL.md` through `skill_create` and `skill_update`.
Both operations require approval, and successful changes hot-reload after the
current turn. Skills never receive an automatic executable-code trust grant.

To enable MCP, copy `config/mcp.json.example` to `config/mcp.json`. Both stdio
and Streamable HTTP servers are supported. Use `${ENV_VAR}` references for
secrets rather than writing tokens into JSON. MCP tools are exposed as
`mcp_<server>_<tool>`; any tool not explicitly annotated read-only by its server
requires Feishu approval.

Probe a Profile's configured MCP servers before starting its Gateway:

```bash
beemax mcp status --profile personal
```

## Feishu meeting tools

Registered when the gateway is connected:

```text
feishu_meeting_get
feishu_meeting_list
feishu_meeting_reserve_create
feishu_meeting_reserve_get
feishu_meeting_reserve_update
feishu_meeting_reserve_active_get
feishu_meeting_reserve_delete
feishu_meeting_end
feishu_meeting_invite
feishu_meeting_kickout
feishu_meeting_set_host
feishu_meeting_recording_get
feishu_meeting_recording_set_permission
feishu_meeting_recording_start
feishu_meeting_recording_stop
```

In Feishu Developer Console, grant the VC meeting/reservation/recording read
scopes for query tools and write scopes for reservation, end, and recording
controls. Scope labels can vary by console/API version; use the permission
recommendation shown by these APIs: `vc.v1.meeting`, `vc.v1.meeting_list`,
`vc.v1.reserve`, and `vc.v1.meeting.recording`. Application identity can only
access resources it owns or is authorized for.

Subscribe to the recording lifecycle events:

```text
vc.meeting.recording_started_v1
vc.meeting.recording_ended_v1
vc.meeting.recording_ready_v1
```

The gateway logs lifecycle metadata, but never records sensitive recording URLs.

## Card rendering

Each agent turn produces one continuously-updated Feishu interactive card:

- **Header**: status-colored (`green`=done, `red`=failed, `blue`=streaming, `indigo`=thinking)
- **Body**: streamed answer markdown (chunked to fit the 30KB card limit)
- **Collapsible "思考与工具" panel**: reasoning timeline + tool calls with status
- **Footer**: duration · model · ↑input tokens · ↓output tokens · ctx %

The `FlushController` batches card updates on an 800ms interval (coalescing
rapid text deltas) and drains immediately on terminal events (completed/failed)
to respect Feishu's 5 QPS patch limit while still showing the final card promptly.

## Decisions (recorded)

1. **Based on Pi** - `pi/packages/{ai,agent,tui}` referenced as npm workspaces.
2. **Feishu** - first and only platform this phase. Modeled on Hermes'
   `gateway/platforms/feishu.py`: WebSocket long-connection, self-built app,
   `open_id` for routing, `union_id` preferred for cross-app stability.
3. **Local Linux deployment** - no serverless; systemd in Phase 4.
4. **Reuse pi-ai** - 60+ providers, built-in model catalog, `streamSimple`.
5. **Memory: FTS5** - SQLite only (zero extra services).
6. **Pi AgentSession** - native coding tools plus JSONL sessions stored under
   `data/agent/sessions/feishu/` by default.
7. **Web research** - provider priority is Tavily, Brave, then SearXNG. Page
   extraction blocks private/link-local/metadata addresses and validates redirects.
8. **Feishu meetings** - tenant-token VC tools support meeting detail/list,
   reservations, ending meetings and recording control. User-owned/private
   meetings require the later User OAuth layer.
9. **Security** - Feishu access defaults to deny; mutating/shell tools require
   approval, file tools stay inside `BEEMAX_CWD`, and known destructive commands
   plus common credential paths are blocked.
10. **Pure TS card pipeline** - the hermes-feishu-streaming-card rendering logic
   was ported to TypeScript rather than run as a Python sidecar, so the whole
   project is one Node.js runtime.
11. **Bounded Sub-Agents** - fresh-context, read-only child Pi sessions combine
   Hermes-style isolation with explicit OpenClaw-style task lifecycle tools.
   V0.1 is flat (depth 1) and process-local by design.

## Layout

```
packages/
  gateway/
    src/
      card/          session + timeline + render + flush + text (card pipeline)
      core/          platform abstraction + dispatcher + agent factory + session router
      platforms/
        feishu/      adapter (WSClient) + settings
  memory/           SQLite + FTS5 long-term memory
apps/
  cli/              `beemax` entrypoint (gateway / chat / model)
config/             beemax.yaml.example
pi/                 Pi source (referenced as workspaces, not modified)
```
