# Hermes Agent / Codex 的 Profile 作用域：Thruvera 对照研究

> 核查日期：2026-07-21
>
> Hermes 固定到官方仓库提交 [`c47b9d1`](https://github.com/NousResearch/hermes-agent/tree/c47b9d126f2f820f41059813a2c5b16ea4742bf8)。Codex 结论来自 OpenAI 官方文档，开源接口固定到提交 [`d937bfa`](https://github.com/openai/codex/tree/d937bfac84786b453ddb2d3fdb2712c1eca830ea)。
>
> 本文只把 Hermes Agent 和 Codex 作为 Thruvera Profile 的设计参考。Thruvera 生产 Runtime 仍是自身的 Pi/native composition；仓库里的 Hermes/Codex Adapter 只服务差异化评测，不建议也不设计外部执行后端适配。

## 结论

“全局安装的 Skill/工具是否自动进入隔离 Profile”不能对 Hermes 与 Codex 一概而论：

- **Hermes Profile 是独立 Home。** `config.yaml`、`.env`、Skills、MCP 配置与 OAuth token、sessions、memory、state、Gateway 都按 `HERMES_HOME` 分开。新 Profile 会播种官方 bundled Skills；默认 Profile 中后来安装的自定义 Skill 不会自动进入其他 Profile，除非 clone、逐 Profile 安装，或显式配置 `skills.external_dirs`。
- **Codex `--profile` 不是独立 Home。** 它只是把 `$CODEX_HOME/<name>.config.toml` 叠加到用户配置之上；项目配置优先级还更高，用户和系统配置仍继续生效。要拆分 Codex 自身的 config/auth/logs/sessions/package state，应给不同运行实例设置不同 `CODEX_HOME`，但 repo、`$HOME/.agents/skills`、`/etc/codex/skills` 和 system Skills 等发现源仍可能进入运行时。因此 `--profile` 或单独一个 `CODEX_HOME` 都不能独自证明租户隔离。
- **Thruvera 应把 Profile 定义为能力与状态的唯一默认根。** 默认能力包应在创建/升级 Profile 时幂等地物化到该 Profile；客户安装 Skill、MCP、Provider 时必须指定目标 Profile。运行期不应因为 Profile 缺少能力就静默回退到全局目录或环境变量。
- **Profile、workspace、session persistence、process 与 sandbox 是五个独立边界。** “用了 Profile”只表示状态和能力命名空间正确；要隔离不受信客户，还需要独立进程/容器、HOME、网络策略和 Credential scope。

## 对照表

| 维度 | Hermes Agent | Codex | Thruvera 应采用的契约 |
| --- | --- | --- | --- |
| Profile 含义 | 独立 `HERMES_HOME` | `--profile` 是命名 config overlay；`CODEX_HOME` 才是 Codex state root | 独立 Profile Home；不是后端选择器 |
| 配置 | Profile-local `config.yaml`、`.env`、`SOUL.md` | CLI > project > named profile > user > system > defaults | 明确 Profile 配置优先；长驻进程缺失/不匹配 Profile 时 fail closed |
| Skills | Profile-local 为主；bundled Skills 逐 Profile 播种；共享目录 opt-in；local 同名优先 | repo、user、admin、system 多层同时发现；named profile 不改变这些根 | `profile-only` 默认；bundled 能力逐 Profile 物化；共享根显式、可审计、最好只读 |
| MCP | 从当前 Profile config 发现；OAuth token 存在当前 Home | MCP 随 config 层叠加，用户/项目层可继续生效 | 只读目标 Profile 的 MCP manifest/token scope；不继承全局 MCP |
| 环境变量 | Profile `.env` 覆盖同名 ambient 值，但缺失键仍可能来自父进程 | 可用 `shell_environment_policy` 控制继承、排除、白名单与显式设置 | 从最小环境开始，叠加 Profile `.env` 与 server-specific allowlist；禁止秘密的 ambient fallback |
| Workspace | `terminal.cwd` 与 Profile Home 分离 | cwd 决定 project config、repo Skills 与执行目录 | 独立配置项；不得用 cwd 推断 Profile 身份 |
| 临时运行 | 可用临时 `HERMES_HOME` 构造 disposable Profile | ephemeral thread 只是不持久化会话；不会隔离 config/Skills/MCP | 临时 Session 与临时 Profile 分开建模；评测需 disposable Profile Home + workspace + sandbox |
| 安全隔离 | Profile 本身不是 sandbox；local backend 仍是同一 OS 用户 | sandbox policy 与 config profile 分开 | Profile namespace 不得被描述成 tenant sandbox；高风险 Profile 使用独立 worker/container |
| 缺失 Profile 上下文 | `HERMES_HOME` 缺失时源码告警后仍回退 `~/.hermes` | named profile 天生回落到 user/system 层 | 显式指定 Profile 的 Gateway/worker 不允许回退到 default/global |

## Hermes：值得参考的部分

Hermes 官方把 Profile 定义为独立 Home，其中包含自己的配置、API keys、memory、sessions、Skills、cron、state database 与 Gateway state。[Profile 定义](https://github.com/NousResearch/hermes-agent/blob/c47b9d126f2f820f41059813a2c5b16ea4742bf8/website/docs/user-guide/profiles.md#L5-L23) Wrapper 在进程启动前设置 `HERMES_HOME`，所有 Profile state 再从这个根解析；workspace 仍由 `terminal.cwd` 单独决定。[路径机制](https://github.com/NousResearch/hermes-agent/blob/c47b9d126f2f820f41059813a2c5b16ea4742bf8/website/docs/user-guide/profiles.md#L250-L256)

新建 Hermes Profile 时 bundled Skills 会播种到该 Profile。`--clone` 只复制 config、`.env` 与 `SOUL.md`，`--clone-all` 才复制 Skills、plugins、sessions 等完整状态；这使“初始默认能力”和“用户自定义状态”有明确迁移语义。[创建与 clone](https://github.com/NousResearch/hermes-agent/blob/c47b9d126f2f820f41059813a2c5b16ea4742bf8/website/docs/user-guide/profiles.md#L31-L61) `hermes update` 会向所有 Profile 同步新增 bundled Skills，但不覆盖用户修改过的版本。[更新语义](https://github.com/NousResearch/hermes-agent/blob/c47b9d126f2f820f41059813a2c5b16ea4742bf8/website/docs/user-guide/profiles.md#L202-L212)

Hermes 允许显式增加 `skills.external_dirs`，本地 Profile Skill 与外部 Skill 同名时本地优先。官方同时警告：外部目录不是写保护边界，Hermes 进程可修改任何可写的共享 Skill。[External Skill directories](https://github.com/NousResearch/hermes-agent/blob/c47b9d126f2f820f41059813a2c5b16ea4742bf8/website/docs/user-guide/features/skills.md#L251-L273) 对 Thruvera 的关键启示是：共享目录可以存在，但必须是显式策略，不能是一个 Profile 缺文件时的隐式 fallback。

Hermes MCP 从当前 Profile 的 `config.yaml` 中读取 `mcp_servers`，`${VAR}` 在连接时展开，OAuth token 放在 `HERMES_HOME/mcp-tokens`。[MCP 配置](https://github.com/NousResearch/hermes-agent/blob/c47b9d126f2f820f41059813a2c5b16ea4742bf8/website/docs/user-guide/features/mcp.md#L145-L151) [OAuth token scope](https://github.com/NousResearch/hermes-agent/blob/c47b9d126f2f820f41059813a2c5b16ea4742bf8/tools/mcp_oauth.py#L112-L123) Profile `.env` 以 override 模式装入进程，但父进程中未被覆盖的变量仍然存在；因此它是方便的 Profile namespace，而不是秘密的强隔离。[dotenv loader](https://github.com/NousResearch/hermes-agent/blob/c47b9d126f2f820f41059813a2c5b16ea4742bf8/hermes_cli/env_loader.py#L212-L247)

Hermes 也明确说明 Profile、workspace 与 sandbox 不同；local backend 仍有当前 OS 用户的文件权限。[Profile 与 sandbox](https://github.com/NousResearch/hermes-agent/blob/c47b9d126f2f820f41059813a2c5b16ea4742bf8/website/docs/user-guide/profiles.md#L119-L143) Docker backend 通过 `hermes-profile=<profile>` label 隔离容器复用与清理，但同一 Profile 的 sessions/subagents 默认仍共享一个持久容器。[Container lifecycle](https://github.com/NousResearch/hermes-agent/blob/c47b9d126f2f820f41059813a2c5b16ea4742bf8/website/docs/user-guide/configuration.md#L175-L201)

不应照搬的一点是：`get_hermes_home()` 在 `HERMES_HOME` 缺失、sticky active Profile 又不是 default 时，只打印告警，最终仍返回 `~/.hermes`。源码注释也承认这可能把数据写进错误 Profile。[Hermes fallback](https://github.com/NousResearch/hermes-agent/blob/c47b9d126f2f820f41059813a2c5b16ea4742bf8/hermes_constants.py#L43-L101) Thruvera 的显式 Profile Gateway/worker 应直接拒绝启动或拒绝该 Turn。

## Codex：可借鉴，但不能当作 Profile 隔离模型

Codex 有两个容易混淆的概念：

- `--profile <name>` 是命名配置层；
- `CODEX_HOME` 是 Codex state root。官方列出的范围包括 config、auth、logs、sessions、Skills 与 standalone package metadata，也建议用自定义 `CODEX_HOME` 运行项目专用 automation user。[Codex environment variables](https://developers.openai.com/codex/config-file/environment-variables#core-locations) [Custom `CODEX_HOME`](https://developers.openai.com/codex/agent-configuration/agents-md#create-global-guidance)

所以，如果只是切模型、approval 或 sandbox 预设，用 named profile；如果需要分开 Codex 登录、session 与 Codex-local state，用独立 `CODEX_HOME`。但后者仍不是完整租户边界：repo instructions/Skills 由 cwd 决定，用户、admin 与 system Skill roots 仍可参与发现，OS keyring、父进程环境和宿主文件权限也需要单独控制。

Codex 官方把 named profile 定义为“配置层”：`--profile <name>` 加载 `$CODEX_HOME/<name>.config.toml`，叠加在 base user config 上。完整优先级是 CLI override、可信项目 `.codex/config.toml`、named profile、user config、system config、built-in defaults。[Codex config precedence](https://developers.openai.com/codex/config-basic#configuration-precedence) [Advanced profiles](https://developers.openai.com/codex/config-advanced#profiles)

因此，Codex named profile 适合保存模型、approval、sandbox、MCP 等参数预设，不适合声明“这个客户看不到全局能力”。即使 project 被标为 untrusted，只是 project layer 被跳过，user/system layer 仍会加载。

Codex 官方列出的 Skill roots 包括从 cwd 到 repository root 的 `.agents/skills`、`$HOME/.agents/skills`、`/etc/codex/skills` 和内置 system Skills；这些根与 `--profile` 无关。[Codex Skill locations](https://developers.openai.com/codex/skills#where-to-save-skills) `skills.config` 可以按路径 enable/disable Skill，但这是对已发现 Skill 的配置策略，不是 Profile-private Skill store。[Codex config reference](https://developers.openai.com/codex/config-reference)

MCP 配置同样在 `config.toml` 的配置层中：默认来自用户 config，也可来自 trusted project config；CLI、IDE 与 desktop client 共享相同 host config。[Codex MCP](https://developers.openai.com/codex/mcp#connect-codex-to-an-mcp-server) 选择 named profile 能覆盖某些键，却不会天然清空 user/system/project 中的其他 server。

Codex 值得 Thruvera 借鉴的是边界拆分：

- `shell_environment_policy` 分别支持 `inherit = all|core|none`、`include_only`、`exclude` 和显式 `set`，比“把整个宿主环境传给工具”更可控。[Codex environment policy](https://developers.openai.com/codex/config-reference)
- `sandbox_mode`、workspace writable roots 与 network access 是独立于 named profile 的执行策略。[Codex sandbox config](https://developers.openai.com/codex/config-reference)
- app-server 的 ephemeral thread 明确表示 in-memory only 且 `thread.path = null`；它解决会话持久化，不解决 config、Skill 或 MCP 隔离。[Codex app-server ephemeral thread](https://github.com/openai/codex/blob/d937bfac84786b453ddb2d3fdb2712c1eca830ea/codex-rs/app-server/README.md#L303-L305)
- app-server 还能按 cwd 列出 Skills，并用 process-local extra roots 临时补充来源，说明“发现上下文”应是显式 Runtime 输入，而不是从一个模糊的 Profile 名称推导。[Codex app-server Skills API](https://github.com/openai/codex/blob/d937bfac84786b453ddb2d3fdb2712c1eca830ea/codex-rs/app-server/README.md#L1623-L1624)

## Thruvera 当前实现核查

现代 Thruvera Profile 已有正确的基础根：`THRUVERA_HOME/profiles/<profile>` 下放 `config.yaml`、`.env`、`SOUL.md` 与 data。[`profile-home.ts`](../../apps/cli/src/profile-home.ts#L27-L40) Profile 创建与同步会把缺失的 bundled Skills 安装到实际 `agentDir/skills`，并保留同名已有目录。[`profile-config.ts`](../../apps/cli/src/profile-config.ts#L117-L124) [`profile-config.ts`](../../apps/cli/src/profile-config.ts#L517-L525)

本次实现把生产 Skill discovery 收紧为 Profile-only：Runtime 不再自动加入 workspace `.agents/skills`、workspace `skills` 或用户 `~/.agents/skills`；bundled/default Skill 必须物化进目标 Profile，客户扩展也必须明确安装到该 Profile。[`agent-factory.ts`](../../apps/cli/src/agent-factory.ts) [`skill-tools.ts`](../../packages/core/src/skill-tools.ts) 这消除了“本机全局装过，所以某个客户 Profile 偶然可用”的隐式 fallback。

MCP manifest 的默认路径是 Profile-local `mcp.json`，Gateway 只加载解析后的这个路径；required server 连接失败也会让启动失败，而不是悄悄假装能力可用。[`profile-config.ts`](../../apps/cli/src/profile-config.ts) [`gateway.ts`](../../apps/cli/src/gateway.ts) [`client.ts`](../../packages/mcp-capability/src/client.ts)

本次实现同时补齐了环境边界：`loadConfig` 为目标 Profile 捕获隐藏、不可变的环境快照，MCP command、args、cwd、URL、headers 和 server `env` 都只从该快照展开；stdio 子进程只接收安全运行变量和 Server 显式映射的键，未映射 Profile Secret 不会下传，HOME/XDG state 也被重定向到当前 Profile。标准 Web Provider 使用同一快照，不再从启动进程误取另一 Profile 的搜索凭据。[`config.ts`](../../apps/cli/src/config.ts) [`client.ts`](../../packages/mcp-capability/src/client.ts) [`capability-provider-composition.ts`](../../apps/cli/src/capability-provider-composition.ts)

仓库中的 Codex/Hermes 仅是 parity benchmark adapter：benchmark 文档明确把它定义为差异诊断与 release evidence，而不是产品 backend 或 parity 声明。[`agent-parity-benchmark.md`](../operations/agent-parity-benchmark.md#L1-L15) Codex adapter 使用 ephemeral CLI run，Hermes adapter 使用 disposable `HERMES_HOME`；这两个模式可继续作为隔离评测参考，不应进入 Thruvera Profile runtime composition。[`codex-cli.mjs`](../../evals/adapters/codex-cli.mjs#L13-L32) [`hermes-cli.mjs`](../../evals/adapters/hermes-cli.mjs#L18-L47)

## 建议的 Thruvera Profile 契约

### 1. 身份与解析

每个 Turn/Task/worker 都携带不可变的 `profileId`、`profileHome` 与 Profile revision/hash。交互 CLI 可以使用 active Profile 作为便利默认值；Gateway、service、background worker 和恢复任务必须拿到显式 Profile，缺失或路径不一致时 fail closed，绝不回落 `default`。

### 2. 默认能力的安装语义

创建 Profile 时幂等物化版本化的 default capability pack：bundled Skills、内置 Tool declarations、默认 Provider/MCP descriptors 与必要的 browser/runtime state 目录。升级时只添加缺失的 managed artifact；用户修改过的文件保留并标为 `customized`，不得静默覆盖。

这能保证“每个新 Profile 默认都有三项基础能力”是 Provisioning invariant，而不是依赖某次全局安装恰好还在。状态应可由 `profile doctor` 验证并给出逐 Profile 修复命令。

### 3. 客户自行安装

所有安装命令都必须带目标 Profile 或由当前 Profile 明确解析：

```text
thruvera skill install <ref> --profile <id>
thruvera mcp add <name> ... --profile <id>
thruvera provider install <id> --profile <id>
```

安装只修改目标 Profile。共享 Skill/MCP catalog 只是发现和下载源，不是运行期自动继承源。若确需团队共享目录，配置成显式 `sharedRoots`，记录来源与 digest，并默认只读；Profile-local 同名项优先。

### 4. MCP 与环境

启动时生成一个 immutable Profile Environment Snapshot：从最小的运行环境开始，叠加目标 Profile `.env`，再叠加每个 MCP/Provider 的 allowlisted env。MCP command、args、URL、headers 与 child env 必须使用同一个 snapshot；不得直接读 ambient `process.env`。诊断只能显示 key 名、来源和 fingerprint，不能显示 secret value。

必需能力使用 `required: true`/等价 contract。缺少 key、Provider 未安装、MCP 未连接或 Tool 未发现时，错误必须指出 Profile、能力、失败阶段与修复动作；不能把它降级成“本轮没有工具，所以基于训练数据回答”。

### 5. Continuation 与能力计划

“继续”不能重新猜 Tool/Skill。Active Task 应持久化 `requiredCapabilities`、selected Skill/MCP/Provider、健康状态与可接受 fallback；恢复时先重放并复核计划，再开始模型 Turn。Profile capability revision 变化时重新 resolve，并把差异作为可见事件。

### 6. 临时运行与沙箱

`ephemeral session` 只控制 transcript/session 是否持久化。隔离评测或一次性任务还要创建 disposable Profile Home、独立 workspace、显式 capability manifest、最小 env 与 sandbox，并在结果归档后销毁。生产 Profile 的 workspace、browser profile、Caddy、Gateway/worker 与容器都应以 `profileId` 标记，避免跨 Profile 复用。

### 7. 可观测性

每次启动输出不含秘密的 Effective Capability Manifest：

- Profile identity、home 与 config digest；
- Skill 来源：`managed-profile | custom-profile | explicit-shared`；
- MCP/Provider 的 configured/required/connected/ready 状态；
- env key 的 Profile/explicit/system provenance；
- workspace、execution backend、sandbox、network 与 persistence mode。

这样“全局装了但 Profile 没有”“Profile key 没传给 MCP”“继续后计划丢失”会在执行前暴露，不再等到用户收到一张失败卡片才发现。

## 最终原则

Hermes 提供了更接近 Thruvera 目标的 Profile namespace；Codex 提供了成熟的 config layering、environment policy、sandbox 与 ephemeral session 参考。Thruvera 应组合它们的长处，但保持自己的严格定义：

```text
Profile-local by default
+ versioned defaults materialized per Profile
+ explicit, auditable shared sources
+ one Profile environment snapshot
+ fail-closed required capabilities
!= global fallback
!= backend selection
!= sandbox by itself
```
