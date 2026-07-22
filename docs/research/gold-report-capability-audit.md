# Thruvera 1.5.0 真实 XAU/USD 报告能力审计

更新时间：2026-07-18（Asia/Shanghai）

## 结论

Thruvera 已经完成一次由真实配置模型、真实 Profile Runtime、真实公开网页提取、真实文件写入、真实 Chrome PDF Provider 和独立 Verification 组成的严格端到端运行。`r23` Objective 最终为 `succeeded + accepted`，不是合成 Tool 的 `0/16`，也不是只检查路由是否选对。

最终交付采用 `r24`。原因是端到端运行结束后再次调用真实 `market_series` 时，发现 2026-07-17 纽约交易时段仍未结束，日线末值从 4,009.5 变化为 4,007.8。`r24` 没有把这个仍会变化的值冒充最终收盘价，而是明确标成“抓取时点最新价，非最终结算”，并更新了涨跌计算、数据回执和 PDF。`r24` 由生产 `write`、`beemax.chrome-pdf` 和 `beemax.local-artifact-verifier` 直接产生和验收；它不是第二次完整模型 E2E，因此不能拿来虚增模型稳定率。

## 三组不能混在一起的指标

| 指标 | 真实结果 | 准确含义 |
| --- | ---: | --- |
| 严格模型 E2E（r23） | 1/1 accepted | 在最终收紧的 r23 Contract 下，模型执行、Skill 生命周期、Tool 调用、文件生成和独立 Verification 全部完成。样本只有 1，不能声称稳定率 100%。 |
| 历史研发 Objective 台账 | 4 accepted / 29 failed / 2 cancelled | 对 2026-07-17 起标题命中 `XAU`、`黄金` 或 `gold-weekly-report` 的 35 个 Objective 的原始 SQLite 统计。排除 cancelled 后为 4/33，即 12.12%。这些运行跨越多个正在修复的版本且验收口径不同，不是当前版本稳定率。 |
| 最终 r24 Artifact 验收 | HTML 4/4；PDF 5/5 | HTML 通过 existence、integrity、semantic、render；PDF 通过 existence、integrity、semantic、render、consistency。14/14 个显式语义断言命中，HTML 恰好 6 个唯一外部 URL。 |

因此：

- **成功率**：严格最终 E2E 的观测值是 1/1；历史研发台账是 4/33（12.12%），两者不能互换。
- **准确率**：最终 Artifact 的显式机器断言是 14/14，结构化市场数据 5/5 个交易日均有独立交叉观测，6/6 个最终来源 URL 在 r23 主执行和独立 verifier 中各抓取一次，合计 12/12 次 `web_extract` 成功。这不等于对报告中所有自然语言推断宣称“绝对真值 100%”。
- **稳定率**：目前没有足够的同版本、同 Contract、独立重复 E2E 样本，结论是“尚未证明”，不是 100%。

## 1.5.0 生产渐进式 Capability 门禁

2026-07-18 19:45:02（Asia/Shanghai）重新运行了当前生产组合。Capability 排名保持渐进式：明确的 metadata 命中走确定性 lexical lane，只有无法可靠确定的语义和负例才调用真实配置模型；随后 16 个交互 case 全部进入真实主模型的 model-first Pi 循环。该次基线记录的 evidence implementation digest 为 `sha256:c43e7f28c9b80f66b49d2bf7bb7d71531824250a78053b42f6abb8b2edc8b4a2`，生成门禁和独立 verifier 均通过。

| 项目 | 真实结果 |
| --- | ---: |
| 冻结语料 | 16/16 cases |
| 确定性 lexical lane | 11 cases，0 次 Provider 调用 |
| 真实 semantic lane | 5 cases，5 次 measured successful Provider 调用 |
| Top-1 / Top-K / required recall | 100% / 100% / 100% |
| forbidden / unnecessary activation | 0 / 0 |
| downstream Capability completion | 16/16 |
| 真实 Pi Tool Spec outcome | 16/16 accepted |
| Pi 交互入场 | 16/16 `model_first + raw_prompt`；Work Contract 0 次 |
| Pi Provider 回合 | 32/32 reported；16/16 cases 有 measured evidence |
| Pi 用量 | input 29,095；output 5,943；合计 35,038 tokens |
| Pi 观测耗时 | 平均 9,091.6875 ms；最大 29,159 ms |
| Skill 渐进生命周期 | 1/1 完整 `read → activate → route → resource_read → completed`；完成后 Tool Spec 收回为 0 个 Skill 控制 |
| Adaptive Admission | 6/6 正确；5 个普通交互零 Work Contract，1 个 Automation 进入 Contract，2 个 Contract Provider turns |

这些 token 和耗时是观测数据，不是任务中止预算。门禁不再因为累计 token、累计 Tool 调用、任务总时长或费用而放弃已承诺的 Objective；Provider 单次故障仍会被明确记录并进入模型 failover。最终这次 evidence 的 provider unavailable turns 为 0，fallback cases 为 0。样本仍只有一次当前摘要下的正式门禁运行，因此不能据此把生产稳定率写成 100%。

## r23 真实模型端到端证据

- Objective：`objective:73017f77-bd4b-4d86-b949-464616ff5d90`
- Execution：`execution:7692feb6-f49c-4929-a7a6-30e8eeec265e`
- Task Run：`5b048feb-86a2-4f82-9ecd-08a85d16f696`
- Planning：`direct`，`maxSubagents=0`，实际 `task_spawn` 调用为 0。
- 最终状态：normal execution `succeeded`，independent Verification `accepted`。
- 墙钟时间：364,381 ms，即 6 分 04.381 秒；包含 Work Contract、主执行和独立 Verification。
- 模型调用：19 个 settled turns；input 111,381、output 14,777、cache read 308,160、cache write 0。Provider 记录的 `costUsd` 为 0，只表示 Provider 没有上报费用，不代表任务是免费的。
- Tool 结果：`read` 1/1、`write` 1/1、`artifact_render` 1/1、`artifact_verify` 2/2、`web_extract` 12/12、`verification_submit` 1/1 成功；`artifact_inspect` 4 次成功、3 次中间失败，失败被真实记录后经修正收敛。
- Skill：按需读取、激活并完成 `business-report` 生命周期，没有把整个 Skill 库一次性塞进上下文。

r23 的独立 verifier 对四个 Contract criterion 均给出 accepted，并重新读取 Artifact、重新抓取 6 个 URL，而不是接受候选模型自述。r23 原始 HTML 为 23,571 bytes，sha256 `7df11091533de62c26c6fb5d0dd83488da3bb2f17398abd7474497c81f9e152e`；原始 PDF 为 1,279,173 bytes，sha256 `255e994f6ec2bc5a2f0e0fb0e705043748e4c841a2bb97c23260f4d26dfa2da6`。

## r24 最终交付证据

最新真实 `market_series` 调用返回：

- Market receipt：`market-series:sha256:4e8a2d2cdcaf1b409327a52c04da775168847699c9f559fe330c7d80cf24938f`
- Source receipt：`source-receipt:sha256:dc001050adab56d92b0b71d681e013a6c06bb685ce5a6b9974fefec0baa1ebe7`
- Source timestamp：2026-07-17T19:37:00Z，即 2026-07-18 05:37 AEST。
- 5 个日度 observation；周期开盘 4,111.4、抓取时点末值 4,007.8、区间高点 4,113、区间低点 3,961.8。
- 开盘至抓取时点变化 -103.60 美元/盎司，-2.519823%，报告展示为 -2.52%。
- Twelve Data 主源与 NBP 官方金价/USD 换算的 5 个重叠 observation 均存在；最大绝对差异 2.803579%，在声明的 5% 容差内，crosscheck 为 accepted。

最终文件：

| Artifact | 大小 | SHA-256 | 验收 |
| --- | ---: | --- | --- |
| `gold-weekly-report-r24-2026-07-17.html` | 24,347 bytes | `a1f95d79d9dc06ff72c109a8831402ba66f7c0fa85b28ac292744cb6b06c902e` | 4/4 dimensions accepted；14/14 text assertions；恰好 6 个唯一 URL |
| `gold-weekly-report-r24-2026-07-17.pdf` | 1,283,910 bytes | `383b019bc62a41e9f082a064603396de9052885a6cef534f91b2178e0e82c3c2` | 5/5 dimensions accepted；7 页；HTML/PDF consistency retained 957,912 ppm |

PDF Provider 是 `beemax.chrome-pdf`，版本 `Google Chrome 150.0.7871.115`；独立 verifier 是 `beemax.local-artifact-verifier`。最终 PDF 的浏览器页眉/页脚与临时 `file://` 路径匹配数为 0。程序渲染抽样覆盖全部 7 页；人工查看了更新最集中的第 1、2 页和最终来源页，确认中文、表格、长回执换行和来源列表可读。

## 本轮找到并修复的问题

1. 显式“不启用子任务”被融合进 constraint 后未被 planner 识别；现在 constraints 与 prohibitions 都走同一个 delegation-boundary 判断。
2. “独立验证”被误判为并行/委派信号；现在只有明确并行执行表达才触发并行计划。
3. “读取现有 HTML 并必要时修正”只激活 read、漏掉 write；现在复合文件边界会确定性补齐 read + write。
4. 失败的 delegated Task 曾让父任务等待；现在 terminal failed 可被父执行识别并进入直接 fallback。
5. Artifact 的唯一外部 URL、来源 evidence refs 和 verifier 的 `web_extract` 没有形成强闭环；现在支持 min/max 唯一 URL 和逐 URL 独立读取。
6. Chrome 150 忽略旧式 `--print-to-pdf-no-header`，PDF 泄露临时 `file://` 路径；现在同时传入当前 `--no-pdf-header-footer`，并有真实 PDF 文本回归测试。
7. 抓取时点末值被写成最终收盘；最新市场复核发现数据仍在变化后，r24 改为明确的非最终结算快照，并把 source timestamp 和两个内容寻址回执写入报告。
8. semantic Capability identity 曾被实际可执行 Tool 名覆盖，导致 `file_read` 决策与 `read` 执行回执无法闭环；现在保留语义 identity，同时单独记录 executable source Tool。
9. “检索来源并分析结构化数据”曾被模型融合或漏掉一个原子边界；现在 Work Contract 会从原始 Objective/验收 span 确定性恢复 retrieval 与 analysis 两个要求，并清理连接词前缀。
10. 旧 live gate 强制每个 case 都调用模型，与生产渐进式路由不一致；现在 11 个明确 case 必须证明零 Provider 调用，5 个语义 case 必须证明至少一次真实、可计量成功。
11. 旧 Pi gate 把 token/耗时上限和失败尝试的用量缺失当作任务失败；现在资源只观测，每个 case 的真实 Provider 成功证据与最终验收才是完成门槛。当前正式基线使用两路并发，保持证据归属不变并把评测控制在分钟级。
12. 独立 verifier 曾要求预期失败的 threshold trial 也必须产生 Verification 事件；现在接受严格的 downstream/terminal outcome 顺序，并新增“当前 live baseline 必须正向通过独立 verifier”的回归测试，防止只靠负向 mutation 测试掩盖过期基线。
13. model-first 切换后，旧 Pi gate 仍把 16 个普通交互 case 的完成权绑定到 durable Objective Verification，造成路由和 Tool 回执正确却显示 0/16。现在交互 case 由内容无关的系统守卫从 Execution Trace 独立重算 required/forbidden Capability、Tool Spec、Provider Turn、Tool/Skill 回执、Skill 生命周期和终态文本；Automation 的 Work Contract 门禁由独立的 Adaptive Turn Admission 基线继续验证。
14. 第一版 model-first Skill gate 只证明 `skill_read → skill_complete`，会漏掉 activate、route 和 resource 阶段。现在真实 Pi 必须按唯一收据完成五阶段，producer 与独立 verifier 分别重算严格顺序。
15. 第一次五阶段真实重跑把后续 Skill 控制从 Agent 工具库存中删掉，导致无法渐进提升；改为保留完整不可变库存、首轮只暴露 read/activate，并由前一阶段收据提升 route、resource 和 complete。
16. 第二次五阶段真实重跑发现模型完成后还能重复调用 `skill_read`；现在最后一个 admitted Skill 完成时，Runtime 会立即从 Tool Spec 收回全部 Skill 生命周期控制，同轮和下一轮重入都会被阻止。

## 测试 harness 与生产边界

`scripts/capability-outcome-harness.mjs` 和其他 evaluation harness 只能证明测试场景，不进入发布归档，也不属于 Thruvera 生产 Runtime。当前 `live Pi 16/16` 证明真实模型、model-first 生产入场和真实 Thruvera Runtime 走通 16 个冻结的 Capability/Tool 控制场景；实际业务 Tool 仍是隔离的 evaluation implementation，它没有生成真实黄金 HTML/PDF，所以不能作为本任务端到端成功率。Automation/Objective 的真实 Work Contract 由单独的 Adaptive Turn Admission 基线验证，不能偷换到普通交互 case 上。

1.5.0 发布包已排除 evaluation scripts、`evals`、tests、docs、`.scratch`、`tmp` 和根目录 core dump，且保留生产 `packages/core`，只包含安装所需的四个 release scripts，并对完整归档做路径与内容扫描。`beemax-v1.5.0.tar.gz` 共 780 个归档条目、2,299,372 bytes，SHA-256 为 `a5eb12b4d7280822f91ed2a5039b130713929510981c5c96d2974f33a59b7652`。checksum、源码布局、版本一致性、禁止品牌边界、隔离安装、全量构建、Profile 重载和打包 Skill smoke test 全部通过；最终 `verify:release` 也完整通过，全量测试为 1,466 项、1,465 passed、0 failed、1 个环境条件 skip。生产归档不包含测试 harness、内部规划草稿、崩溃转储或其运行入口。

## 仍然存在的边界

- 当前 live Pi 16/16 只证明真实 Provider 的正向 model-first Capability/Tool/系统守卫链路；durable `verification_unavailable`、`in_progress`、`rejected`、`cancelled` 以及 CLI/飞书终态展示由 Runtime/Interaction/Presenter 集成测试覆盖，尚未作为真实 Provider 成功率样本。
- r24 是截至 2026-07-18 05:37 AEST 的快照；2026-07-17 纽约交易时段当时尚未结束。若需求是“最终周收盘报告”，必须在交易时段结束后重新拉取结构化行情并重算，不能把当前快照继续沿用。
- NBP 是独立换算参考，不是盘中 XAU/USD 收盘；2.80% 最大差异虽在声明容差内，但不等于交易级行情一致。
- 当前只有一次严格模型 E2E。发布可以说明“已完成一次真实验收”，不能说明“生产稳定率 100%”。
- verifier 硬化后的第一次并发全量测试曾报告 1 个未复现失败；随后独立全量复跑和最终完整 `verify:release` 均为 0 failed。该波动没有被改写成成功样本，也是不能宣称稳定率 100% 的附加理由。
