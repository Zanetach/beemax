# Channel Instance 旧数据归属迁移

BeeMax 不会猜测旧 Memory 或 Automation 数据属于哪个机器人账号。一个 Profile 从单实例升级为同平台多实例前，管理员必须把无 `channelInstanceId` 的旧路由显式分配给唯一实例。

## 操作前提

1. 备份 Profile 配置并确认目标 Channel Instance 已配置正确。
2. 停止该 Profile Gateway。命令与 Gateway 使用同一个 Profile 进程锁；仍在运行时会直接拒绝。
3. 确认当前用户对 Profile 目录和 SQLite 数据库具有读写权限。

## 计划与执行

先查看影响表、行数和阻塞原因：

```bash
beemax migration channel-instance plan \
  --platform feishu \
  --channel-instance company-a \
  --profile personal
```

计划没有 blocker 后执行。`--migration-id` 是稳定的审计标识，只允许字母、数字、点、下划线和连字符：

```bash
beemax migration channel-instance apply \
  --platform feishu \
  --channel-instance company-a \
  --migration-id assign-company-a \
  --yes \
  --profile personal
```

BeeMax 自动在 `~/.beemax/profiles/<profile>/migrations/channel-instance/` 写入：

- `<id>.before.db`：迁移前、通过 SQLite integrity check 的备份；
- `<id>.json`：Profile、数据库路径、目标实例、逐表行数、时间与迁移前后 SHA-256；
- Profile SQLite 内的 `channel_instance_migrations` 审计行。

Memory 的编码平台 scope、Automation/Initiative/Completion Notice 的 instance 列、结构化 Memory `scope_key` 和 Initiative 嵌套路由在同一事务内变更。任何冲突都会回滚整个事务。

## 安全回滚

只有迁移完成后数据库没有任何新写入时才可回滚：

```bash
beemax migration channel-instance rollback \
  ~/.beemax/profiles/personal/migrations/channel-instance/assign-company-a.json \
  --yes \
  --profile personal
```

回滚前 BeeMax 会重新生成逻辑 SQLite 快照并核对迁移后摘要。摘要不同就拒绝，不能用回滚覆盖新的消息、Task、Memory 或 Automation 写入。成功回滚会保留 `<id>.after.db`，并把清单状态改为 `rolled_back`。

## 故障处理

- `already locked`：Gateway 或另一个管理操作仍在运行；停止后重试，不要删除活跃锁文件。
- `blocked`：先处理计划列出的目标唯一键冲突或损坏 JSON；不要手工复制旧数据到多个实例。
- `database changed after migration`：不得直接回滚。保留 before/after 快照，由管理员评估新写入后制定合并迁移。
- integrity check 或 digest 失败：停止操作并保存整个 migrations 目录和数据库文件，避免再次改写。
