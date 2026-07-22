# Hermes Agent 部署与飞书接入（官方资料核查）

核查日期：2026-07-10。官方项目为 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)。本文只描述 Hermes Agent 官方能力；未检查或修改 Thruvera 代码，因此不对 Thruvera 当前是否已完成 Hermes Profile 适配作结论。

## 结论

Hermes Agent 可以作为常驻 Gateway 部署，也原生支持飞书/Lark。对一台 Linux VPS，最短且最省公网配置的路线是：安装 Hermes → 创建/配置独立 Profile → 设置 `SOUL.md`、模型与工具 → 运行 `hermes gateway setup` 配置飞书 → 使用飞书 WebSocket 长连接 → 安装并启动 systemd 服务。WebSocket 是官方推荐模式，由 Hermes 主动建立出站连接，不要求公网 webhook 或开放入站端口。[飞书官方接入文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/feishu.md)

## 安装与运行模型

- Tier 1 支持：Apple Silicon macOS 使用 Desktop 或 `install.sh`，Windows 10/11 使用 Desktop 或 `install.ps1`，Linux/WSL2 使用 `install.sh`，也可使用官方 Docker 镜像。Android/Termux 与 Nix 是 best-effort；PyPI/pip 和 Homebrew 安装明确列为不支持。[平台支持矩阵](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/getting-started/platform-support.md)
- Linux/macOS/WSL2 的官方一键安装命令是 `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`。普通用户安装把代码放在 `~/.hermes/hermes-agent/`、命令放在 `~/.local/bin/hermes`、状态放在 `~/.hermes/`；也支持 root/FHS 布局和专用无特权 service user。[安装文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/getting-started/installation.md)
- 主机常驻部署：`hermes gateway install` 安装 Linux systemd user service 或 macOS launchd service，随后 `hermes gateway start`；Linux VPS 也可用 `sudo hermes gateway install --system` 安装开机启动的 system service。WSL、Docker、Termux 更适合前台 `hermes gateway run`。[Messaging Gateway 文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/index.md)、[CLI 参考](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/cli-commands.md)
- Docker 首次配置：`docker run -it --rm -v ~/.hermes:/opt/data nousresearch/hermes-agent setup`；常驻：`docker run -d --name hermes --restart unless-stopped -v ~/.hermes:/opt/data nousresearch/hermes-agent gateway run`。官方镜像以 s6-overlay 监督 Gateway；`/opt/data` 是持久状态。仅使用飞书 WebSocket 时不需要发布 8642；该端口用于可选的 OpenAI-compatible API/health。[Docker 文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/docker.md)

## Agent Profile 是什么

Hermes Profile 不是一个单独的“Agent Profile JSON”，而是独立的 `HERMES_HOME`。每个 Profile 自带 `config.yaml`、`.env`、`SOUL.md`、memory、sessions、skills、cron、日志和 Gateway 状态；默认运行方式是一 Profile 一 Gateway 进程、一套渠道凭据。[Profiles 文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/profiles.md)

创建并配置一个名为 `beemax` 的 Profile：

```bash
hermes profile create thruvera --no-alias
hermes -p thruvera setup
hermes -p thruvera config set terminal.cwd /absolute/path/to/Thruvera-Agent
```

这里显式使用 `--no-alias`，因为 Hermes 默认生成的 `beemax` 命令别名会与本仓库自己的 Thruvera CLI 冲突。Agent 的持久身份写在 `~/.hermes/profiles/beemax/SOUL.md`；模型、工具、工作目录等放在该 Profile 的 `config.yaml`；密钥和渠道 token 放在该 Profile 的 `.env`。[SOUL.md 指南](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/guides/use-soul-with-hermes.md)、[配置文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/configuration.md)

Profile 只隔离 Hermes 状态，不是安全沙箱；本地 terminal backend 仍拥有运行用户的文件权限。生产 Gateway 应评估 Docker/remote terminal backend，并避免把不需要的宿主密钥转发给命令容器。[安全文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/security.md)、[Profiles 文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/profiles.md)

若要把一个 Git 仓库“一条命令安装成 Hermes Profile”，它需要是 Profile Distribution（仓库根目录含 `distribution.yaml`，可分发 SOUL、config、skills、cron、MCP 等）；`.env`、OAuth、memory、sessions 不随分发。安装命令为 `hermes profile install <git-url> --alias`。[Profile Distributions 文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/profile-distributions.md)

## 从干净 Linux 主机到飞书可用的准确流程

1. 安装 Git、curl、xz-utils，然后运行官方 `install.sh`，重新载入 PATH，并用 `hermes doctor` 检查安装。[安装文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/getting-started/installation.md)
2. `hermes profile create thruvera --no-alias`，再运行 `hermes -p thruvera setup` 配置模型/provider 与工具；编辑 Profile 的 `SOUL.md`，必要时设置绝对路径 `terminal.cwd`。[Profiles 文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/profiles.md)
3. 运行 `hermes -p thruvera gateway setup`，选择 Feishu/Lark。官方向导支持扫码自动创建应用、配置权限并保存凭据；扫码不可用时再手工输入 App ID/App Secret。[飞书接入文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/feishu.md)
4. 手工创建飞书应用时：启用 Bot；至少授权 `im:message`、`im:message:send_as_bot`、`im:resource`、`im:chat`、`im:chat:readonly`；订阅 `im.message.receive_v1`；最后在“版本管理”发布版本，企业应用可能需要管理员批准。[飞书接入文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/feishu.md)
5. 推荐在 Profile 的 `.env` 使用：

   ```dotenv
   FEISHU_APP_ID=cli_xxx
   FEISHU_APP_SECRET=secret_xxx
   FEISHU_DOMAIN=feishu
   FEISHU_CONNECTION_MODE=websocket
   FEISHU_ALLOWED_USERS=ou_xxx,ou_yyy
   ```

   国际 Lark 使用 `FEISHU_DOMAIN=lark`。生产环境应设置 `FEISHU_ALLOWED_USERS`；群聊默认要求 @机器人，默认 group policy 为 allowlist。若留空，能接触机器人的用户可能获得使用能力。[飞书接入文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/feishu.md)、[Gateway 安全文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/index.md)
6. 先用 `hermes -p thruvera gateway run` 前台测试并从飞书私聊机器人；确认后停止前台进程，再执行 `hermes -p thruvera gateway install && hermes -p thruvera gateway start`，用 `hermes -p thruvera gateway status` 和 `hermes -p thruvera logs -f` 验证。Linux user service 若需退出 SSH 后继续运行，应启用 systemd linger；也可改用 `--system` 的系统服务。[Messaging Gateway 文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/index.md)、[多 Profile Gateway 文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/multi-profile-gateways.md)
7. 在目标飞书会话内执行 `/sethome`（飞书页面也写作 `/set-home`）以设置 cron/通知的 home chat，或预设 `FEISHU_HOME_CHANNEL=oc_xxx`。[飞书接入文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/feishu.md)

## Webhook 备选方案

只有确实需要 Feishu 主动 HTTP 推送时才选 `FEISHU_CONNECTION_MODE=webhook`。Hermes 默认监听 `/feishu/webhook`（127.0.0.1:8765），此时要提供可达的 HTTPS 入口/反向代理，并在生产环境同时配置 `FEISHU_ENCRYPT_KEY` 和 `FEISHU_VERIFICATION_TOKEN`。WebSocket 模式不需要这套公网入口。[飞书接入文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/feishu.md)

## 对 Thruvera 部署判断的边界

Hermes 侧已经具备“独立 Agent Profile + 常驻 Gateway + 原生飞书 WebSocket”的完整路径，因此渠道部署本身可行。但“当前 Thruvera 仓库能否直接执行 `hermes profile install`”必须另行检查其是否已经是合法 Profile Distribution；若不是，就应先创建 Hermes Profile 并把 Thruvera 的身份、配置、skills/MCP 逐项接入，或先制作 `distribution.yaml`。本次研究按要求没有检查 Thruvera 仓库内容。
