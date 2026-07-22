# Ubuntu 资源高水位

首期生产资源规格为 `ubuntu-small-node22`：Ubuntu 24.04 x64、Node.js 22、至少 2 个逻辑 CPU 与 6 GiB 宿主内存。它是 Thruvera 当前唯一声明并由发布门禁验证的 Ubuntu 规格；其他机器可以运行，但不能沿用本规格的容量结论。

## 边界与高水位

| 资源 | 硬边界 | 运维高水位 | 到线动作 |
| --- | ---: | ---: | --- |
| Profile RSS | systemd `MemoryMax=2G` | 1.5 GiB | 停止新后台调查、检查大 Tool Result/附件，必要时 drain/restart |
| CPU | systemd `CPUQuota=200%` | 由持续 throttling 指标判断 | 降低 Profile task concurrency |
| OS Tasks | systemd `TasksMax=512` | 由 systemd tasks 指标判断 | 检查失控子进程，不提高上限掩盖泄漏 |
| Interaction 输入队列 | 500 条 / 2 MiB | 400 条 / 1.6 MiB | 拒绝普通新输入，保持 `/stop` 可用 |
| Profile Task | 并发 4 / 总排队 1,000 / 每 owner 排队 100 | 总排队 800 | 其余任务进入有界公平队列，Provider overload 时自适应降载 |
| Profile SQLite 家族 | 无自动删除硬上限 | 1 GiB | 告警、在线备份、评估 retention；不得直接删表或 WAL |

DB 的 1 GiB 是运维告警线，不是数据容量承诺。企业保留周期、附件规模和实际业务写入差异很大，达到高水位后必须基于备份和审计制定 retention。

## 复现

在真实 Ubuntu 24.04 x64 上：

```bash
npm ci
npm run build
mkdir -p artifacts
npm run eval:resources:ubuntu -- --write artifacts/resource-high-water-ubuntu.json
```

macOS 开发机可用仓库内的 Dockerfile 做等价 Ubuntu x64 验证：

```bash
docker build --platform linux/amd64 -f scripts/ubuntu-resource.Dockerfile -t thruvera-ubuntu-resource .
docker run --rm --platform linux/amd64 thruvera-ubuntu-resource
```

门禁会验证机器声明、systemd 默认值、进程峰值 RSS/heap、队列落盘、任务并发栅栏和真实 SQLite 增长。CI 与 tag release 都上传 `resource-high-water-ubuntu.json`，便于比较不同提交，而不是把某次 runner 延迟宣传为生产 SLA。
