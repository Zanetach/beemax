# BeeMax 1.6 阶段发布：一键启动与智能研究黄金路径

## 目标

普通用户从一台满足依赖的 macOS 或 Ubuntu 主机开始，只执行一条安装命令，即可完成 BeeMax 安装、Profile 设置、模型凭据配置、健康检查并进入对话。随后用户可以直接说：

> 调研过去的黄金走势报告。

BeeMax 应把自然语言理解为一个低风险、需要当前外部证据的研究任务，在不削弱证据标准的前提下自主完成。

## 用户接口

1. `bootstrap-install.sh --quickstart`：安装经校验的 Release 后，通过终端继续 Profile 设置并打开本地聊天。
2. `beemax quickstart --profile <name>`：新 Profile 执行设置；已有 Profile 同步缺失的内置 Skills、执行 Doctor，并在健康时打开聊天。
3. `beemax quickstart --once "<request>"`：使用同一准备路径完成一个自然语言 Turn 后退出。

密钥不得出现在命令行参数、日志或模型上下文中。Quickstart 不得创建第二套 Agent Runtime、Memory 或权限路径。

## 黄金调研验收

对于未指定时间范围的低风险历史研究，Agent 应采用一个明确、合理且可撤销的默认范围，简短说明后继续。内置 `historical-market-research` Skill 当前采用最近 30 个日历日，并以最新可用观测为结束日期；使用独立 Skill 名称可让已有 Profile 通过“只同步缺失能力”的安全策略获得它，而不覆盖用户定制。

执行必须满足：

- 从原始自然语言任务开始，而不是要求用户选择固定工作流；
- 只加载与任务匹配的 Skill 元数据，随后通过版本锁定的 Skill 生命周期加载正文；
- 黄金历史走势请求必须优先选择 `historical-market-research`，不得只加载通用报告模板而跳过时间范围和品种一致性规则；
- 只激活当前任务需要的 Tool；
- XAU/USD 场景优先调用 `market_series`，保留品种、单位、日期、时区、来源时间和 Source Receipt；
- 至少包含一个独立交叉验证来源；
- 可重试的只读失败不得原样循环，应发现等价健康能力并继续；
- 不得把期货、ETF、本币报价或衍生参考值静默冒充 XAU/USD 现货；
- 最终结果区分事实、推断、限制和建议，并保留最小充分来源；
- 只有通过独立 Verification 的结果才能进入长期 Organization Memory；
- 后续对话可通过有界、非可执行 Context Pack 回忆已验证结果。

## 发布门禁

`npm run eval:stage` 必须覆盖：

- Quickstart 新建、复用、修复失败和拒绝启动路径；
- 普通复杂任务的 model-first admission；
- Capability 和 Skill 渐进激活；
- 结构化 XAU/USD 数据与独立来源 Receipt；
- 只读失败的安全改道和重复失败中止；
- 上下文压缩；
- 验证后记忆学习与后续回忆。

`npm run verify:release` 必须包含该门禁，并继续执行既有架构、安全、可靠性、性能、迁移和全量测试门禁。Release Workflow 随后还必须创建归档，并通过隔离安装、Quickstart 入口、Profile 重载和内置 Skill 检查后才能发布。

## 非目标

- 不宣称提供投资建议或价格预测；
- 不把黄金研究硬编码成第二套 Agent Loop；
- 不宣称任意金融品种都具有结构化行情 Provider；
- 不因 Quickstart 绕过 Tool 审批、Effect Authority、Sandbox 配置或 Profile 隔离；
- 不把 Profile 隔离描述成完整 SaaS 租户、SSO 或企业 IAM。
