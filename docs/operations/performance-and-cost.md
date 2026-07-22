# Thruvera Runtime 性能与成本门禁

Thruvera 将性能分成两层：

1. 可重复的本地 Runtime 开销：理解、Situation、Capability、Memory、Context、Planning、Initiative 与 durable state 操作。
2. 外部开销：模型和 Tool 的网络延迟、真实 token、cache token 与美元成本，由 Execution Trace 逐次记录，不能混入离线 Runtime benchmark。

这样可以判断代码回归，而不会把 provider 抖动误判成 Runtime 架构问题。离线 benchmark 不声称代表端到端用户延迟。

## 声明机器 Profile

| Profile | 用途 | 最低配置 |
| --- | --- | --- |
| `apple-m5-32gb-node22` | 当前 production development baseline | Apple M5、10 logical CPUs、30 GiB RAM、Darwin arm64、Node 22 |
| `github-actions-ubuntu-x64-node22` | CI 与 Release | Linux x64、2 logical CPUs、6 GiB RAM、Node 22 |

Profile 会在运行前校验 platform、architecture、CPU、内存和 Node major；机器不匹配时拒绝产生误导性结果。

## 三类路径

| 路径 | 真实生产接口 | 主要成本上限 |
| --- | --- | --- |
| fast | Turn Understanding、Situation、Capability Top-K、direct planning | 12K tokens、8 Tool calls、0 Sub-Agent、concurrency 1 |
| deep | Organization Memory recall、Context assembly、Situation、DAG planning | 80K tokens、40 Tool calls、5 Sub-Agent、concurrency 3 |
| background | Initiative observe-only 与 proactive investigation admission | 8K tokens、6 Tool calls、1 execution worker、concurrency 4 |

每条路径分别测 20 次 warmup 和 101 个正式样本，输出 P50/P95。门禁同时检查 Context、Token、Tool、Sub-Agent、Recall、Situation、Initiative、cache-write、concurrency 与 backpressure。

## 命令

当前 Apple M5 Profile 与相对 baseline：

```text
npm run eval:performance
```

CI/Release Profile：

```text
npm run eval:performance:ci
```

跨受支持发布机器的一键门禁：

```text
npm run eval:performance:release
```

该命令根据真实 platform、architecture、CPU、内存和 Node major 精确选择一个已提交 Profile；GitHub Actions Profile 还要求 CI、Runner OS/Arch 与 hosted image 元数据共同形成 `github-actions-hosted` runner class。零匹配或多匹配都会失败。Apple Profile 使用同机完整 baseline，GitHub Actions Profile 使用自身延迟预算并复用确定性成本 baseline。普通 Linux 主机不会被误认成 CI，也不会被降级到宽松默认值。

若要在经过审核的同一机器上更新 baseline：

```text
node scripts/evaluate-performance.mjs \
  --profile evals/performance-profiles/apple-m5-32gb.json \
  --write evals/baselines/performance-apple-m5-32gb.json
```

Baseline 更新必须与代码变更一起审查，不能由 CI 自动接受。

## 回归规则

- P50/P95 必须同时低于机器 Profile 的绝对预算。
- 同机器 baseline 比较允许有限的计时噪声，但不允许跨越绝对预算。
- Context、Token、Tool、Sub-Agent、cache-write、concurrency 或 backpressure 高于已提交 baseline 时直接失败，即使任务质量指标提高。
- CI 使用自己的延迟预算，但复用已提交的确定性成本 baseline；机器不同不能成为放宽执行成本的理由。
- External provider 延迟不进入离线 P50/P95；真实运行通过 Execution Trace 的 duration、token、cache 与 `costUsd` 单独分析。

## 当前 Apple M5 baseline

2026-07-13 的 101 样本记录：fast P50/P95 约 `0.010/0.012ms`，deep 约 `3.32/6.49ms`，background 约 `0.010/0.020ms`。deep 的最大 Organization Memory recall 约 `4.96ms`，Context 为 `2091` chars；三条路径 backpressure 均为 0。

这些数字是当前固定离线 corpus 的 Runtime overhead，不是模型首 token 延迟或端到端 SLA。
