# Hermes Agent 与 OpenClaw：多 Profile / 多 Agent 隔离研究

> 核查日期：2026-07-14
>
> Hermes 固定到官方仓库提交 [`7f7a403`](https://github.com/NousResearch/hermes-agent/tree/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a)。
>
> OpenClaw 固定到官方仓库提交 [`c58660f`](https://github.com/openclaw/openclaw/tree/c58660fcf4cdd5aa611045d49e7b799830261385)。
> 只使用两个项目的官方源码和官方文档。

## 结论

Hermes 和 OpenClaw 选择了不同的主要隔离单元：

- Hermes 的 Profile 首先是独立 `HERMES_HOME`，默认每个 Profile 启动独立 Gateway 进程与服务。它的故障域更小，运维和凭证边界直观，但多 Agent 共用渠道宿主的资源效率较低。当前源码也提供 opt-in multiplex 模式，可由一个默认 Gateway 承载多个 Profile，但这会把故障域重新合并。
- OpenClaw 的 Agent 首先是同一 Gateway 进程内的逻辑租户：独立 workspace、`agentDir`、认证配置和 SQLite session store，通过 bindings 将 channel/account/peer 路由到 Agent。资源复用和跨 Agent 编排更自然，但一个 Gateway 崩溃、重启或被攻破会影响其内全部 Agent。

两者都不能把“目录不同”理解为强安全隔离。Hermes Profile 默认仍继承同一 OS 用户的 `HOME` 和 CLI 凭证；OpenClaw workspace 只是默认 cwd，绝对路径仍可访问宿主其他位置。需要对抗性隔离时，两者都需要容器/沙箱、不同 OS 用户或不同 Gateway/主机。

## 1. 核心模型对比

| 维度 | Hermes Profile | OpenClaw Agent |
| --- | --- | --- |
| 默认进程模型 | 每个 Profile 一个 Gateway 进程/服务 | 多 Agent 共用一个 Gateway 进程 |
| 配置根 | 每 Profile 一个 `HERMES_HOME` | Gateway 全局配置 + 每 Agent `agentDir` |
| 工作目录 | `terminal.cwd`，与 Profile 目录分离 | 每 Agent workspace，但只是默认 cwd |
| Agent 状态 | Profile 内 config、memory、skills、cron、state DB、sessions | 每 Agent workspace、auth profiles、model registry、SQLite sessions |
| 渠道路由 | 默认由各 Profile 的独立 bot token/Gateway 接入；multiplex 时 Adapter 标记 `source.profile` | bindings 按 channel/account/peer 确定 `agentId` |
| 凭证 | Profile `.env` 隔离；host 工具凭证默认共享 | 模型 auth per-agent；渠道凭证通常按 Gateway channel account 保存 |
| 故障域 | 默认 Profile 级；multiplex 时 Gateway 级 | Gateway 级 |
| 强资源隔离 | Profile 本身不提供；可使用独立容器/后端 | Agent 本身不提供；可配置 per-agent/per-session sandbox |
| 跨 Agent 协作 | 显式 Kanban/dispatcher/profile worker 等机制 | `agentToAgent`、`sessions_spawn` 等显式 allowlist 机制 |

## 2. Hermes：Profile 默认是独立部署单元

Hermes 官方把 Profile 定义为独立 home directory，包含自己的 `config.yaml`、`.env`、`SOUL.md`、memory、sessions、skills、cron jobs、logs、Gateway state 和 `state.db`。[Profiles 官方说明](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/website/docs/user-guide/profiles.md#L5-L23)

Profile wrapper 通过设置不同的 `HERMES_HOME` 运行同一套 Hermes 代码。官方说明大量路径都经 `get_hermes_home()` 解析，因此配置、session、memory、skills、数据库、Gateway PID、日志与 cron 自然落在 Profile 目录内。[Profile 路径机制](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/website/docs/user-guide/profiles.md#L270-L280)

默认情况下，每个 Profile 启动独立 Gateway 进程，并使用独立 bot token；安装为服务时也获得独立的 systemd/launchd service name。官方 Docker 镜像为每个 Profile 创建独立 s6 service slot，某个 Profile Gateway 崩溃后由 s6 单独重启。[Profile Gateway](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/website/docs/user-guide/profiles.md#L151-L186)

这意味着默认故障传播边界较清楚：

- 某个 Gateway 的 Python 崩溃、Adapter 死锁或内存泄漏不会直接终止其他 Profile 的 Gateway 进程。
- 某个 Profile 的服务可独立启停、重启和观察 PID/日志。
- 代码安装和 OS 用户仍是共享的；一次全局代码升级、宿主故障或 OS 级资源耗尽仍会影响全部 Profile。

## 3. Hermes：multiplex 是可选的共享 Gateway 模式

当前源码新增 `gateway.multiplex_profiles`，默认 `false`，明确保留“一 Profile 一 Gateway”的旧行为；开启时，默认 Profile 的 Gateway 可为主机上其他 Profile 同时服务。[配置定义](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/gateway/config.py#L699-L709)

Multiplex 模式为每个 Profile 在其 `HERMES_HOME + secret scope` 下创建 Adapter，入站事件写入 `source.profile`；整个 Agent turn 再进入对应 Profile runtime scope，使 config、skills、memory 和 credentials 从该 Profile 解析。[多 Profile Adapter 启动](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/gateway/run.py#L8512-L8527)；[Profile-scoped Agent turn](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/gateway/run.py#L17084-L17124)

它还有两项防冲突措施：

- 相同平台、相同 bot credential 不能被两个 Profile 同时消费，Gateway 对凭证做安全指纹并拒绝重复 Adapter。
- 需要绑定监听端口的平台只能由默认 Profile 拥有，其他 Profile 通过 `/p/<profile>/` 路径共享该 listener；错误配置会让 multiplexer 启动失败，而不是半连接运行。[冲突检查](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/gateway/run.py#L8581-L8637)

Multiplex 提高了资源利用率，但同一 event loop、runner、HTTP listener 和进程成为共同故障域。源码对单 Adapter 失败有隔离和重连，但进程崩溃、全局内存压力、event loop 阻塞、共享 listener 故障仍会影响所有被承载 Profile。

## 4. Hermes 的隔离不是安全沙箱

官方明确区分 Profile、workspace/cwd 和 sandbox：Profile 只隔离 Hermes 状态，不限制 Agent 对宿主文件系统的访问；本地 backend 下仍拥有当前 OS 用户的全部权限。[Profiles vs workspace vs sandbox](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/website/docs/user-guide/profiles.md#L125-L149)

默认 `terminal.home_mode=auto` 在 host 上保留真实 OS 用户 `HOME`，因此 Git、SSH、GitHub CLI、npm、云 CLI、Claude/Codex 等凭证在 Profile 间共享。需要更严格的工具凭证隔离时必须设置 `home_mode: profile`，并在 `{HERMES_HOME}/home` 内重新初始化工具凭证。[工具 HOME 策略](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/website/docs/user-guide/configuration.md#L147-L181)

Hermes 的持久 Docker backend 会用 `hermes-profile=<profile>` label 隔离容器复用与清理；切换 Profile 不会看到或误清理另一 Profile 的容器。但同一 Profile 的 sessions 与并行 delegate subagents 默认共享一个长期容器，可能发生路径写入、环境变化和后台进程冲突。[容器生命周期与 Profile label](https://github.com/NousResearch/hermes-agent/blob/7f7a40381e86d73bf69c78410e5d9bbefcca8a9a/website/docs/user-guide/configuration.md#L248-L274)

## 5. OpenClaw：Agent 是共享 Gateway 内的逻辑隔离单元

OpenClaw 官方定义可以在一个 Gateway 进程内运行多个 Agent。每个 Agent 有独立 workspace、`agentDir`、auth profiles、model registry 和 SQLite-backed session history，bindings 负责将入站消息路由到正确 Agent。[Multi-agent 定义](https://github.com/openclaw/openclaw/blob/c58660fcf4cdd5aa611045d49e7b799830261385/docs/concepts/multi-agent.md#L1-L25)

默认路径为：

- workspace：默认 Agent 使用 `~/.openclaw/workspace`，其他 Agent 使用 `workspace-<agentId>`。
- Agent state/auth：`~/.openclaw/agents/<agentId>/agent`。
- Session：每 Agent 独立 `openclaw-agent.sqlite`。

官方警告不可复用 `agentDir`，否则 auth/session 状态会冲突。[路径与碰撞说明](https://github.com/openclaw/openclaw/blob/c58660fcf4cdd5aa611045d49e7b799830261385/docs/concepts/multi-agent.md#L31-L65)

因此 OpenClaw 的隔离是“同一进程内不同命名空间与数据库”，不是进程隔离。Agent 的普通异常可以由 Gateway 的 per-run/per-session 机制控制，但 Gateway crash、升级重启、主事件循环卡死或进程 OOM 会中断全部 Agent 与全部 channel account。

## 6. OpenClaw 的状态与凭证边界并非绝对

OpenClaw 的模型 auth profiles 是 per-agent 的，但官方说明：当 secondary Agent 的本地 OAuth 过期或刷新失败时，可以读取 default/main Agent 同 profile id 的凭证并采用更新 token；若需要完全独立 OAuth 账号，必须在该 Agent 内单独登录。[Auth fallback](https://github.com/openclaw/openclaw/blob/c58660fcf4cdd5aa611045d49e7b799830261385/docs/concepts/multi-agent.md#L21-L35)

此外，某些插件存储默认是全局的，增加 Agent 不会自动拆分。例如 Memory Wiki 必须显式设置 agent-scoped vault；跨 Agent QMD collection 也能显式配置。因此“Agent state 独立”只覆盖核心声明的 workspace/auth/session，不自动扩展到每个插件。[插件与 Memory 隔离](https://github.com/openclaw/openclaw/blob/c58660fcf4cdd5aa611045d49e7b799830261385/docs/concepts/multi-agent.md#L35-L40)；[agent-scoped vault](https://github.com/openclaw/openclaw/blob/c58660fcf4cdd5aa611045d49e7b799830261385/docs/concepts/multi-agent.md#L131-L197)

Channel account 凭证属于 Gateway 的 channel/account 配置范围，并不天然是 Agent 私有。一个 WhatsApp account 可按 peer 路由给多个 Agent，但 DM allowlist 仍是该 WhatsApp account 的全局策略；回复也来自同一号码。[共享账号路由边界](https://github.com/openclaw/openclaw/blob/c58660fcf4cdd5aa611045d49e7b799830261385/docs/concepts/multi-agent.md#L199-L235)

## 7. OpenClaw 的跨 Agent 路由

Bindings 使用 `(channel, accountId, peer)` 以及可选 guild/team 条件选择 `agentId`。规则确定性匹配，最具体层级优先，同层则配置顺序在前者优先；省略 `accountId` 只匹配默认账号，而 `accountId: "*"` 才是 channel-wide fallback。[路由规则](https://github.com/openclaw/openclaw/blob/c58660fcf4cdd5aa611045d49e7b799830261385/docs/concepts/multi-agent.md#L236-L257)

跨 Agent 通信默认关闭，需要显式启用并 allowlist `tools.agentToAgent`。[agent-to-agent 配置](https://github.com/openclaw/openclaw/blob/c58660fcf4cdd5aa611045d49e7b799830261385/docs/concepts/multi-agent.md#L397-L403) `sessions_spawn` 还可通过 `subagents.allowAgents` 限制可创建的目标 Agent；沙箱中的调用可要求目标也必须沙箱化。

这比通过显示名或模型自行选择 Agent 更安全：入口 bindings 是确定性路由，跨边界操作是显式能力，二者分离。

## 8. OpenClaw 的资源与安全隔离

OpenClaw 官方明确：workspace 是默认 cwd，不是硬 sandbox；绝对路径仍可访问宿主其他位置。[Agent workspace](https://github.com/openclaw/openclaw/blob/c58660fcf4cdd5aa611045d49e7b799830261385/docs/concepts/agent-workspace.md#L10-L26)

可为每 Agent 配置独立 sandbox 和 tool policy。`sandbox.scope: "agent"` 表示每 Agent 一个容器，`"session"` 更严格，`"shared"` 则让多个 Agent 共用容器。工具 allow/deny 与 elevated gate 也能 per-agent 收紧。[Per-agent sandbox](https://github.com/openclaw/openclaw/blob/c58660fcf4cdd5aa611045d49e7b799830261385/docs/concepts/multi-agent.md#L544-L593)

但官方安全文档明确表示：一个 Gateway 是一个 operator trust domain，`sessionKey` 只是路由选择器，不是授权令牌；需要隔离相互敌对的用户时，应按 OS user/host 拆分并运行不同 Gateway。[Gateway trust boundary](https://github.com/openclaw/openclaw/blob/c58660fcf4cdd5aa611045d49e7b799830261385/docs/gateway/security/index.md#L129-L141) 即使 DM session 分开，也只是 conversation context 隔离，不是 host-admin 隔离。[DM isolation warning](https://github.com/openclaw/openclaw/blob/c58660fcf4cdd5aa611045d49e7b799830261385/docs/gateway/security/index.md#L183-L204)

## 9. 对 Thruvera 的启示

Thruvera 不应在 Hermes 与 OpenClaw 之间二选一，而应显式提供两级部署模式：

### 可信同域：共享 Gateway，多 Profile Runtime

适合一个企业/团队内部的多个专用 Agent：

```text
Gateway Process
├── ChannelHost / channel accounts
├── deterministic Route Binding
├── Profile Runtime A → own state / vault scope / sessions / workspace policy
└── Profile Runtime B → own state / vault scope / sessions / workspace policy
```

要求：

1. `profileId` 必须进入每个 session、task、effect、outbox 和 audit key，不能仅保存在进程上下文变量中。
2. Channel credential 与 Agent/Profile 分开建模：`channelInstanceId` 通过 binding 指向 Profile；共享账号时明确 access policy 属于 channel instance。
3. 跨 Profile 调用默认关闭，采用目标 allowlist、能力范围和审计记录；不能让模型仅凭名称任意切换身份。
4. 每 Profile 设置并发、队列、模型预算、内存和工具执行配额，防止一个 Profile 耗尽共享 Gateway。
5. Adapter 故障隔离到 channel instance；Profile runtime 异常隔离到 turn/worker；Gateway 进程级故障由 supervisor 恢复。

### 不同信任域：独立 Gateway/Worker

如果 Profile 属于不同客户、不同法人、相互不信任用户或拥有高风险工具，必须支持：

- 独立 Gateway 进程或容器。
- 独立 OS 用户/namespace、Credential Vault scope 和网络策略。
- 独立资源配额与 supervisor service。
- 不共享宿主 HOME、浏览器 profile、SSH/Git/cloud CLI 凭证或插件全局 store。

### 推荐最终原则

Hermes 默认的一 Profile 一进程适合强故障隔离；OpenClaw 的一 Gateway 多 Agent 适合可信域内资源复用。Thruvera 应把它们定义成两个部署等级，而不是让“Profile”一词同时暗示配置隔离和安全隔离：

```text
Profile namespace ≠ process boundary ≠ sandbox boundary ≠ tenant security boundary
```

产品 UI 和配置应分别展示这四项边界。只有在使用独立进程/容器、独立凭证域和资源策略时，才能把 Profile 宣称为强隔离租户。
