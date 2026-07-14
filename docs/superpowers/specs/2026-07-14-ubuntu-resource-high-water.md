# Ubuntu Resource High-Water Gate

## Problem

BeeMax 已有 systemd 资源限制、内存稳定测试与延迟 Profile，但 RSS、输入队列、Profile 任务并发和 SQLite 增长没有在同一个 Ubuntu 部署规格下形成可执行合同。macOS 测量不能作为 Ubuntu 发布证据，单纯声明 `MemoryMax` 也不能证明应用层队列和并发有界。

## Solution

首期只声明 `ubuntu-small-node22`：Ubuntu 24.04 x64、Node 22、至少 2 CPU/6 GiB。规格文件分别保存 systemd/Runtime 硬边界、运维告警高水位和固定压测预算。`eval:resources:ubuntu` 在真实 Ubuntu 上对文件输入队列、ProfileTaskScheduler、SQLite MemoryStore 与进程内存执行有界负载，输出机器声明和 JSON evidence。CI 与 tag release 上传证据；macOS 不执行也不冒充 Ubuntu。ARM 构建链未通过前不列入该规格。

## Testing

- 队列写入两倍容量后仍固定为 500 条且不超过 2 MiB。
- 40 个调度任务的峰值并发必须精确为 4，其余任务进入有界队列。
- 5,000 条真实 SQLite Memory Event 的数据库家族体积不得超过 32 MiB，并报告投影到 1 GiB 告警线的记录数。
- 固定负载执行期间的峰值 RSS 不超过 512 MiB、完成并 GC 后的 heap 增量不超过 64 MiB。
- 机器不是 Ubuntu 24.04/Node 22/受支持架构或资源不足时 fail-closed。

## Out of Scope

- 不把 GitHub runner 延迟当作客户生产 SLA。
- 不声称 1 GiB DB 告警线等同数据库容量上限；达到高水位后应告警、备份和制定 retention。
- 不预设客户业务量、消息内容或业务对象。
