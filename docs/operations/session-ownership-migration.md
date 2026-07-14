# Session Ownership Migration 运维指南

BeeMax 的共享群 Conversation 不再按当前 Actor 分割 Session。旧版本可能为同一个群或 Thread 留下多个 Actor-scoped Pi transcript；这些文件不能自动合并或任选，否则会制造错误历史或披露不属于共享 Session 的上下文。

## 原则

- 迁移只支持 Group/Thread，不迁移 DM。
- 管理员必须明确提供 legacy Actor，并从 `plan` 输出中选择一个准确的 legacy Session ID。
- 只复制一个 transcript 为 canonical Session；不修改、合并或删除任何 legacy transcript。
- legacy transcript 不设置自动过期时间。企业需要删除时，应由未来独立的 retention policy 与审计动作处理。
- `apply`、`rollback` 与 Gateway 使用同一个 Profile 进程锁；运行中的 Profile 会使命令失败。
- canonical transcript 或 canonical Session Catalog 只要出现迁移后的变化，`rollback` 就拒绝，避免抹掉新工作。

## 操作流程

先停止 Profile Gateway，然后列出候选：

```bash
beemax migration session plan \
  --platform feishu \
  --channel-instance company-a \
  --chat-id group-a \
  --legacy-user alice \
  --profile personal
```

Thread 需要同时提供 `--chat-type thread --thread <thread-id>`。如果同一 legacy Session ID 出现多个文件，计划会标记 `BLOCKED`，系统不会按时间或文件名猜测。

确认候选后应用：

```bash
beemax migration session apply \
  --platform feishu \
  --channel-instance company-a \
  --chat-id group-a \
  --legacy-user alice \
  --legacy-session-id <plan 输出的 id> \
  --migration-id group-a-history \
  --yes \
  --profile personal
```

BeeMax 以流式方式重写 Pi JSONL header 中的 Session ID，其余 transcript 字节保持不变。源 transcript 在校验、复制和摘要期间固定到同一个 regular-file descriptor，拒绝软链接、路径替换、写入竞态和超过 64 KiB 的异常 header；候选扫描有界，不会把任意数量的同名文件载入内存。canonical 文件通过临时文件、fsync 和 no-clobber hard link 发布；Session Catalog 只迁移 owner、Thread、时间与显示偏好，不复制消息内容。清单保存在：

```text
~/.beemax/profiles/<profile>/migrations/session-ownership/<migration-id>.json
```

## 回滚

```bash
beemax migration session rollback \
  ~/.beemax/profiles/personal/migrations/session-ownership/group-a-history.json \
  --yes \
  --profile personal
```

回滚会校验 legacy source digest、canonical target digest、文件身份、Profile 路径和 Catalog receipt。canonical 文件先进入同目录 quarantine，在 Catalog 收敛前后都通过固定 descriptor 复验，删除前再次确认未收到新工作。no-clobber 恢复在创建 hard link 后和移除 quarantine 后分别 fsync 目录；若进程在两步之间崩溃，重试会识别两个路径指向同一 inode 并继续。成功后只移除该迁移创建且从未改变的 canonical transcript，并恢复迁移前 Catalog 状态；legacy 文件始终保留。

状态机为 `prepared → applied → rollback_prepared → rolled_back`。apply 在 canonical 文件发布前先持久化 `prepared` 清单；进程中断后，rollback 接受 Catalog 仍处于迁移前或已处于迁移后这两种合法崩溃状态，并根据目标文件与 Catalog 的实际状态完成 `aborted` 或 `rolled_back` 收敛。若发现另一个 canonical transcript、文件身份变化或内容变化，操作均 fail-closed，需要管理员检查，而不是覆盖文件。

## 不应执行的操作

- 不要手工把多个 transcript 拼接成一个 JSONL。
- 不要把一个 Profile 的 Session 文件复制给另一个 Profile。
- 不要在 Gateway 运行时移动或修改 Session 文件。
- 不要因为迁移完成就删除 legacy 文件；迁移和 retention 是不同权限、不同审计目的的动作。
