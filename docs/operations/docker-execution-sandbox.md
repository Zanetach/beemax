# Docker Execution Sandbox

BeeMax 的首个生产 Execution Sandbox 是一次一容器的 Docker Adapter。`local` 是显式可信的 Host Execution Adapter，会继承 BeeMax 进程用户的宿主权限，不是 Sandbox。Profile namespace、独立进程、Execution Sandbox 和 hostile-tenant 隔离是四个不同等级。

## 启用

在 Profile `config.yaml` 中配置：

```yaml
execution:
  backend: docker
  mode: all
  workspaceAccess: none # none | ro | rw
  image: node:22.19-alpine
  timeoutMs: 180000
```

运行 `beemax doctor --profile <name>`。Docker daemon 不可用、`mode: all` 搭配 local，或配置值拼写错误都会失败，不会静默退回宿主执行。

## 强制边界

- 内置 `bash`、`read`、`write` 通过同一个 `ExecutionPort`；Pi 的宿主 `edit/grep/find/ls` 在 Sandbox 模式不可用。
- 每次执行使用随机名称和内容无关的 Profile label，结束、超时或取消后删除容器。
- `network=none`、只读 rootfs、全部 Linux capabilities 移除、`no-new-privileges`、独立 IPC、init reaping。
- 单容器上限：2 GiB memory、1 CPU、256 PIDs、256 MiB `/tmp`、1,024 open files、4 MiB stdout/stderr。
- Workspace 默认不挂载；`ro` 只能读，`rw` 才允许写。路径必须保持在配置的 workspace 内。
- 模块不传递宿主环境、Docker socket 或 Credential Secret。

Execution Sandbox 不隔离 MCP、Browser、Channel Adapter、模型 Provider 或 Gateway 本身，也不能单独构成不同客户之间的 hostile-tenant 边界。Tool Approval、Enterprise Policy、Execution Grant 与 Effect Authority 仍然在 Sandbox 之前决定动作是否允许。

## 发布验收

在 Ubuntu 24.04 x64、Linux Docker daemon 上运行：

```bash
npm ci
npm run build
mkdir -p artifacts
npm run eval:sandbox:ubuntu -- --write artifacts/docker-sandbox-ubuntu.json
```

门禁记录实际镜像 ID/digest、Docker 版本与所有内容无关的隔离观察。macOS Docker Desktop 只能用 `--allow-docker-desktop` 做开发验证，输出会明确标为 `formalEvidence: false`。
