# Channel Instance 旧数据归属迁移

BeeMax 不会猜测旧 Memory 或 Automation 数据属于哪个机器人账号。一个 Profile 从单实例升级为同平台多实例前，管理员必须把无 `channelInstanceId` 的旧路由显式分配给唯一实例。

## 操作前提

1. 备份 Profile 配置并确认目标 Channel Instance 已配置正确。
2. 停止该 Profile Gateway。命令与 Gateway 使用同一个 Profile 进程锁；仍在运行时会直接拒绝。
3. 确认当前用户对 Profile 目录和 SQLite 数据库具有读写权限。
4. 目标 ID 必须是该 Profile 中已启用、且 adapter 与 `--platform` 一致的 Channel Instance；CLI 会拒绝拼写错误、禁用实例和跨平台实例。

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
- `<id>.json`：Profile、配置派生的数据库路径、目标实例、逐表行数、时间与迁移前后逻辑 SQLite SHA-256；
- Profile SQLite 内的 `channel_instance_migrations` 审计行。

Memory 的编码平台 scope、Automation/Initiative/Completion Notice 的 instance 列、结构化 Memory `scope_key` 和 Initiative 嵌套路由在同一事务内变更。迁移器只处理由 BeeMax 基础设施显式登记的路由表，不会因为客户扩展表碰巧存在 `platform` 列就改写它。任何冲突都会回滚整个事务。

SQLite `BEGIN IMMEDIATE` 写栅栏覆盖迁移前备份、所有更新、迁移后逻辑摘要和 `prepared` 恢复清单；清单成功 fsync 后事务才提交。因此并发写入不能落入备份与摘要之间，进程在提交前后崩溃也始终至少保留一个可判定的恢复状态。

## 安全回滚

只有迁移完成后数据库没有任何新写入时才可回滚：

```bash
beemax migration channel-instance rollback \
  ~/.beemax/profiles/personal/migrations/channel-instance/assign-company-a.json \
  --yes \
  --profile personal
```

回滚前 BeeMax 会重新计算有界内存、流式的逻辑 SQLite 摘要并核对迁移后状态。摘要不同就拒绝，不能用回滚覆盖新的消息、Task、Memory 或 Automation 写入。清单路径、数据库和 before/after 路径全部从所选 Profile 推导，不能由清单重定向到其他文件。成功回滚会保留 `<id>.after.db`，并把清单状态改为 `rolled_back`。

回滚使用持久状态机：`prepared → applied → rollback_prepared → rolled_back`。如果进程在提交前退出，数据库仍等于 before 摘要并被标记为 `aborted`；如果在数据库恢复后、状态发布前退出，重试同一 rollback 会识别 before 摘要并幂等完成，不重复覆盖数据。

## 故障处理

- `already locked`：Gateway 或另一个管理操作仍在运行；停止后重试，不要删除活跃锁文件。
- `blocked`：先处理计划列出的目标唯一键冲突或损坏 JSON；不要手工复制旧数据到多个实例。
- `database changed after migration`：不得直接回滚。保留 before/after 快照，由管理员评估新写入后制定合并迁移。
- integrity check 或 digest 失败：停止操作并保存整个 migrations 目录和数据库文件，避免再次改写。
