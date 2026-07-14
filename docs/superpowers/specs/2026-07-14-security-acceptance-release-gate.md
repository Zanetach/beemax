# Security Acceptance Release Gate

## Problem

多渠道 PRD 把三项安全行为列为正式发布阻塞：群聊不得披露 Private Memory、不同 Profile 不得打开或召回彼此 Memory、相同幂等 Effect 不得重复执行。代码库已有分散测试，但 `verify:release` 没有一个可单独运行、可审计且与 PRD 一一对应的安全验收入口，因此普通全量测试通过不能清晰证明三项阻塞条件同时成立。

## Solution

新增 `npm run eval:security`，用一个 release-gate 测试文件直接执行三个真实持久化边界：Private DM Claim 在群聊 recall 中不可见但在原 DM 可见；绑定 Profile A 的 SQLite Memory authority 无法由 Profile B 打开；两个 Effect Journal 实例用同一 idempotency key 重试时只有一个 committed mutation。该命令进入 `verify:release`，同时登记到 P10 验收证据。

## Public Test Seams

- `npm run eval:security`
- `apps/cli/test/security-acceptance-release-gate.test.mjs`

## Testing

- 测试使用真实临时 SQLite 和 Effect Journal 文件，不 mock Scope 或幂等权威。
- 三个断言必须可独立失败，并由 Node test 退出码阻止发布。
- `npm run verify:release` 必须显式执行安全门禁；全量测试继续覆盖同一文件，防止测试选择器漂移。

## Out of Scope

- 不声称替代渗透测试、组织 Policy 审核或真实租户红队。
- 不建立固定客户业务规则或业务对象。
- 不修改 Memory Store、Effect authority 或 Profile 模型；本切片只把已有强语义提升为正式发布证据。
