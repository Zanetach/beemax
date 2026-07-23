# Software delivery Agent

BeeMax 的软件交付模式把一个普通 Profile 配置为受治理的软件工程数字员工。它复用同一个 Pi Agent Runtime、Memory、Session、Tool Policy、Effect、Approval 和飞书 Gateway，不引入第二套“编码 Agent”。

## 首次使用

```bash
beemax quickstart --profile personal
```

首次向导按以下顺序工作：

1. 准备独立 Profile 与 `workspace/`。
2. 选择模型并安全保存 API Key。
3. 询问是否启用软件交付模式。
4. 询问是否连接飞书或 Lark，并验证应用身份和访问白名单。
5. 运行 Doctor；配置了渠道时直接进入 Gateway，否则进入本地聊天。

非交互部署可以显式使用：

```bash
beemax setup --profile personal --software-agent --with-feishu
beemax gateway run --profile personal
```

## 自然语言任务

用户不需要学习专用命令。下面的消息会进入与 CLI 相同的 Profile Runtime：

> 开发一个可以本地运行的 CRM，包含客户、联系人、销售机会，写好测试；如果构建或测试失败，自己定位并修复，全部通过后告诉我怎么运行。

运行时会先用 Capability metadata 发现 `software-delivery`，之后才读取 Skill 本体。它再选择 `implement` 路由并加载 `modules/implement.md`，同时只激活该路由声明的工作区读写能力。没有命中的普通问答不会加载这套说明。

## 完成契约

软件任务遵循一个父 Agent 所有的闭环：

```text
inspect → acceptance criteria → implement → test
                                      ↑          ↓
                                   repair ← diagnose
```

- 先检查现有说明、源码、测试、依赖和 Git 状态；
- 保留用户已有改动，只做满足目标的最小相关变更；
- 对普通框架和命名做可撤销假设，只在产品结果、成本、授权或不可逆动作会改变时提问；
- 每次失败都读取 stderr、堆栈、退出码和相关源码，形成一个可检验原因；
- 修改后重新运行受影响检查，不重复没有变化的失败命令；
- 最终运行最广的相关测试、构建、lint、类型检查或可执行 smoke；
- 只交付工具确认的文件、功能、命令、检查结果和真实限制。

代码草稿、脚手架、首次失败和“看起来正确”都不是完成证据。

## 权限边界

`--software-agent` 会设置：

```yaml
agent:
  toolset: standard
execution:
  workspaceWritePolicy: allow-within-workspace
  taskGrantCapabilities:
    - edit
```

这让每个新任务可以在 Profile 工作区内写入或编辑文件。路径逃逸和凭据文件访问仍由 Core 硬阻断。

Shell 没有被预授权。它可以访问宿主程序、网络和工作区以外的位置，所以第一次调用会要求审批。用户在飞书回复“本任务允许”后，当前任务可以继续构建、测试和修复；新任务不会继承该授权。

以下动作仍需要各自的明确权限：

- 部署到生产、推送 Git、创建 Release 或发送外部消息；
- 使用、创建或回显密钥；
- 修改企业系统或生产数据；
- 高风险、不可逆或 Effect 状态不确定的操作。

生产环境建议把命令执行切到 Docker Execution Sandbox，并只挂载需要的工作区。

## Memory 与上下文

Pi Session 保存当前开发对话并在接近上下文窗口时压缩；Core 的 Task、Checkpoint、Effect 和 Verification 不依赖聊天摘要作为唯一事实来源。稳定偏好和通过验证的工作 Episode 才能进入长期 Memory，失败日志、密钥和瞬时细节不会被当成永久事实。

当前普通交互式编码 Turn 会持续运行到结果、取消或可见的不可恢复失败。需要跨进程恢复的工作必须具备持久 Objective/Task、幂等执行范围和可对账 Effect；BeeMax 不会无条件重放任意中断命令。

## 验收

Stage gate `apps/cli/test/software-agent-stage.test.mjs` 覆盖：

- Profile 软件模式只预授权工作区写入和编辑，不预授权 Shell；
- 中文 CRM 开发意图命中一个 `software-delivery` Skill；
- Skill 通过 manifest 渐进加载唯一 `implement` 路由；
- 真实临时工作区先执行出失败测试，再修复代码并重新验证通过；
- 主 Agent 系统契约禁止停在计划、脚手架或第一次失败。

完整发布仍需通过 `npm run verify:release`。
