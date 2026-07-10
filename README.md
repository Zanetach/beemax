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
- [x] `beemax doctor` readiness diagnostics
- [x] Deny-by-default Feishu user/chat allowlists
- [x] Text approval for `bash/edit/write`: allow once / allow for session / deny
- [x] Workspace boundary, sensitive credential path, and destructive-command hard blocks
- [x] Deterministic Pi JSONL persistence/resume per Feishu chat + stable user identity
- [ ] Feishu User OAuth for private calendar/doc resources
- [ ] Attachment/image/audio ingestion

## Architecture

```
Feishu ──WS──▶ FeishuAdapter ──▶ Dispatcher ──▶ AgentSession (Pi SDK) ──▶ pi-ai ──▶ LLM
                   ▲                   │
                   │                   ▼
                   │             CardSession.apply(event)
                   │                   │
                   │             renderCard() ──▶ FlushController (throttle)
                   │                   │
                   └── sendCard / updateCard (lark SDK) ──┘
                                       │
                            MemoryStore (FTS5) ◀── recall / remember
```

**Pure TypeScript.** The card rendering (ported from the
hermes-feishu-streaming-card design) lives in `packages/gateway/src/card/`.
BeeMax drives a full Pi `AgentSession` in-process, renders the card itself, and
sends/updates it directly via `@larksuiteoapi/node-sdk`. AgentSession supplies
Pi's coding tools, extensions/skills, compaction and JSONL persistence. No
second runtime is required.

## Quick start

### Install and configure an Agent

On Linux or macOS with Node.js 22.19 or newer:

```bash
./scripts/install.sh

beemax init --profile personal
beemax model set anthropic claude-sonnet-4-5 --profile personal
beemax channel add feishu --profile personal
beemax channel test --profile personal
beemax doctor --profile personal
```

The model and Feishu setup commands prompt for missing secrets without writing
them to YAML. Secrets are stored in `config/profiles/<name>.env` with mode
`0600`, ignored by Git, and loaded automatically for foreground and service
runs.

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

Use `beemax service install --system` as root only when a machine-wide service
is required. On macOS, WSL without systemd, or containers without a supervisor,
keep using the foreground `gateway` command.

Each profile has its own gateway process, model, Feishu application, secrets,
memory, sessions, Skills, MCP servers, and automation state. Useful management
commands are:

```text
beemax agent create <name>
beemax agent list
beemax agent delete <name> --yes
beemax channel list --profile <name>
beemax channel remove --profile <name> --yes
beemax stop|restart|status|logs <name>
```

### Source-only quick start

```bash
npm install --ignore-scripts
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
and enable "长连接" (WebSocket long-connection). No public HTTPS endpoint needed.

## Profiles: one Agent per process

A named profile loads `config/profiles/<name>.yaml` and defaults its runtime
state to `data/profiles/<name>/`. Each profile independently selects its model
provider/model, Feishu application, API key environment, system prompt, SQLite,
Pi auth/session state, Skills, MCP servers, workspace, schedules, and heartbeat.

```bash
cp config/profiles/personal.yaml.example config/profiles/personal.yaml
beemax profile list
beemax profile doctor personal
beemax profile start personal
# equivalent: npm run gateway -- --profile personal
```

Different profiles can use different models:

```yaml
# config/profiles/personal.yaml
model: { provider: anthropic, model: claude-sonnet-4-5 }

# config/profiles/work.yaml
model: { provider: openrouter, model: openai/gpt-5.2 }
```

Under systemd, place per-profile secrets in `/etc/beemax/<profile>.env` and use
`deploy/systemd/beemax@.service`:

```bash
sudo systemctl enable --now beemax@personal beemax@work
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

## Codex image generation

Image generation is configured independently per profile and does not require
that profile's chat model to be Codex. For example, an Anthropic chat Agent can
still use its own profile-local Codex OAuth for `image_generate`.

```yaml
imageGeneration:
  enabled: true
  provider: openai-codex
  quality: medium # low | medium | high
  outputDir: data/profiles/personal/cache/images
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

BeeMax automatically recalls relevant prior exchanges and exposes explicit
personal-memory tools:

```text
memory_remember  memory_recall  memory_list  memory_forget
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
