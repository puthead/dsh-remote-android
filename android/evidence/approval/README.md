# 手机端应答电脑端审批 —— 真·端到端证据（网关新代码 + 活环境）

> 目标（README 已知限制 U16）：电脑端会话在 `approval/policy: ask` 下触发审批时，手机端**能应答**，
> 且这个答案是**真闸门**（放行 ⇒ 越界写真的发生；拒绝 ⇒ 真的没发生）。

## 拓扑（全部本机回环，未触碰生产网关）

| 角色 | 进程/地址 | 说明 |
|---|---|---|
| 桌面端 DSH runtime | `127.0.0.1:19387` | 会话的**真值来源**；审批 waterfall 从这里发出 |
| 活环境中继 | `127.0.0.1:9700`（PID 9188） | `tools/dsh-relay`，`--tls off` |
| 活环境网关 | `127.0.0.1:18087`（PID 14712） | `tools/dsh-remote`，**本次新代码**（含 `lib/approvals.mjs`） |
| 手机侧（本证据里用无头令牌替代） | `Bearer <device token>` | `.runtime/live-env/logs/headless-device-token.txt` |
| 生产网关（**未使用**） | `127.0.0.1:8787`（PID 396） | 仍是旧代码，故意不重启 |

活环境由 live-env 队友交付：`scripts/start-live-env.ps1` / `stop-live-env.ps1`（幂等、带 PID 文件）。

## 被测链路

```
桌面端 runtime 产生 approval/request(waterfall)
   → 网关 ApprovalBridge 常驻订阅 $events 收帧、按 eventId 入未决表
   → 手机 GET /api/v2/approvals?sessionId=… 看到它（kind/toolName/reason/expiresAt）
   → 手机 POST /api/v2/approvals/{eventId} {outcome}
   → 网关 POST /api/$events/result {clientId, eventId, outcome:{kind:'result',value}}
   → 桌面端 decide() 返回结论 → 该轮继续/终止
```

触发方式（**不是自然语言命令**）：给 agent 一个真的需要越出工作区写入的任务
（写 `C:\ProgramData\dsh-approval-probe\marker.txt`），并明确允许它在被沙箱拒绝后
用「最窄的更高档位 + 真实 justification」重试。这条配方来自 `.probe/APPROVAL-TRIGGER.md`：
纯口令式要求在探针 B 里被模型识破并拒绝（150 s 无帧），只有"真需要越界"的任务才会走上升级路径。

探针脚本：`.probe/approval-gateway-e2e.mjs`（可重跑：`$env:OUTCOME='allowed-once'|'rejected'; node .probe/approval-gateway-e2e.mjs`）。
前置：会话先经桌面端 RPC 设成 `/permission workspace-write`（读回 `permissions.currentValue = "workspace-write"`），
轮次经**网关**投递（`POST /api/v2/sessions/{id}/turns`，202 → `driver:"desktop"`）。

## 用例 A：放行（`allowed-once`）—— 2026-10-14 22:5x

```
0. gateway health 200 capabilities=[…"approvals","approvals.answer"] approvals={"available":true,"connected":true,"pending":0,…}
1. 桌面端会话已建 session-d70cff77-666d-4fe8-a950-a520f32e7a0f preset=standard
1. /permission workspace-write → {"result":{"kind":"success","text":"preset workspace-write"}}
1. 读回 permissions.currentValue = "workspace-write"
2. 经网关投递轮次 202 {"accepted":true,…,"driver":"desktop","source":"computer"}
3. 手机看到审批 eventId=ccae73d6-3b9c-4899-b457-37347636c9c5 kind=approval tool=pwsh
   reason="escalate sandbox to danger-full-access: 该目标路径 C:\ProgramData\dsh-approval-probe 位于会话工作区 D:\Workspace\dsh_android 之外…"
4. 手机提交 allowed-once → HTTP 200 {"ok":true,…,"outcome":{"kind":"result","value":"allowed-once"}}
5. 标记文件存在 = true （期望 存在）
5. 桥计数器 {"asked":2,"approved":2,"rejected":0,"expired":0,"answered":2,"failed":0}
5. 未决列表（应答后）approvals=[] pending=0
RESULT: PASS
```

## 用例 B：拒绝（`rejected`）—— 同批

```
1. 桌面端会话已建 session-4df789f4-4d9a-40a9-aa8d-b80b1836f0b4 preset=standard
2. 经网关投递轮次 202 {"accepted":true,…,"driver":"desktop"}
3. 手机看到审批 eventId=f0d86293-51dd-43c4-88f9-8f9395892e0d kind=approval tool=pwsh
4. 手机提交 rejected → HTTP 200 {"ok":true,…,"outcome":{"kind":"result","value":"rejected"}}
5. 标记文件存在 = false （期望 不存在）
5. 桥计数器 {"asked":3,"approved":2,"rejected":1,"expired":0,"answered":3,"failed":0}
RESULT: PASS
```

## 结论与口径

1. **答案是真闸门**：两个方向的地面真相都取自**文件系统**（`C:\ProgramData\dsh-approval-probe\marker.txt` 存在 / 不存在），
   而不是只看 HTTP 200 —— 200 只说明网关收下了答案。
2. **未决表随应答清空**（`pending=0`），计数器 `approved/rejected` 分别 +1，说明桥的记账与真实结论一致。
3. 收尾：两个用例都在结束时删掉探测目录并 `session/cancel`；未残留挂住的轮次。
4. **口径警告**：探针里 `会话记录命中 GATEWAY_APPROVAL_E2E_OK=true` 在**两个**用例里都为真 ——
   因为提示词本身就写了这个字符串。它**不能**当作"写入成功"的证据，唯一证据是文件是否存在。
5. 未覆盖：手机 **App** 上的可视化应答（审批条接管输入区）由 `android-approval` 的 task-5 交付，
   其真机取证见 `android/evidence/ui/` 与验收报告 §14；本文件只证明网关侧通道端到端可用。

---

# 二、手机 App 真机端到端（Lead 实跑，2026-10-14 22:57~23:05）

上面第一部分的「手机」是 HTTP 脚本（用 `curl` 冒充客户端）；这一部分**回答的手是模拟器上的 App 本体**。
环境：模拟器 `emulator-5554`（1080×2340 @440dpi，包 `com.deepseek.dshremote.debug`）
→ 真中继 `127.0.0.1:9700` → 真网关 `127.0.0.1:18087`（含 v2.6.0 审批桥）
→ 真桌面端 runtime `127.0.0.1:19387`（家里这台 `WIN-4FSO92IHDIN` 的 DSH）。

## 用例 C：审批（App 点「允许一次」→ 工具真的越界写入）

探针：`.probe/approval-phone-e2e.mjs`（`MODE=trigger` / `MODE=verify`）；手机侧点击：`.probe/approval-phone-steps.ps1`。

```
1. 建桌面端会话 session-45701324-5e5c-4071-8614-4de1ef6c5958（标题「测试越界写入审批重试」）
   commands/execute /permission workspace-write → {"kind":"success","text":"preset workspace-write"}
2. 经网关投递轮次 POST /api/v2/sessions/{id}/turns → 202 {"driver":"desktop","source":"computer"}
3. 电脑端 agent 写 C:\ProgramData\dsh-approval-probe\marker.txt 被拒 → 带 sandbox_permissions 重试
   → 桌面端 runtime 发 approval/request waterfall
4. 网关未决表 pending=1 eventId=1b258aa0-392e-4c31-a8bd-eb120ffb452b tool=pwsh
   理由："escalate sandbox to danger-full-access: 该任务要求在工作区之外的 C:\ProgramData 下写入探针标记文件…"
5. **App 详情页出现琥珀卡**（截图 shots/20-approval-asked.png）：
   「等待你响应 · 工具审批 · 还剩约 13 分钟 / 请求使用工具 pwsh / <理由> / 允许一次 / 拒绝 /
     取消本轮 · 无法处理 · 不在手机上答」——输入框与发送键**整格消失**（原型硬约束③）
6. 在 App 上点「允许一次」（tap @183,1926）→ POST /api/v2/approvals/{eventId} → 200 outcome allowed-once
7. **地面真相**：C:\ProgramData\dsh-approval-probe\marker.txt 出现，内容 `PHONE_APPROVED_OK`（19 B @22:58:41）
8. 未决表清空 pending=0，计数器 {"asked":4,"approved":3,"rejected":1,"expired":0,"answered":4,"failed":0}
   （相对用例 A/B 的 approved=2/answered=3 各 +1）
RESULT: PASS（截图 shots/21-after-allow.png：卡片消失、该轮继续跑完、输入区恢复）
```

## 用例 D：提问（App 选「生产」→ 答案回到电脑端那一轮）

探针：`.probe/question-phone-e2e.mjs`；手机侧点击：`.probe/question-phone-steps.ps1`。

```
1. 建桌面端会话 session-951088c1-7e04-4a08-b01b-62d6f19b72fd（标题「调用 ask_user_question 询问发布环境」）
   经网关投递轮次 → 202 driver=desktop
2. 桌面端 agent 调 ask_user_question（q1「这次发布到哪个环境？」生产/预发/本地，未传 timeout）
   → user-questions/request waterfall → 网关未决表 eventId=a16e9f8f-5a48-486b-ab3f-e765aeaf591c
3. **App 详情页出现琥珀卡**（截图 shots/30-question-asked.png）：
   「等待你响应 · 模型提问 · 还剩约 12 分钟 / 这次发布到哪个环境？ / 发布环境 / 生产·预发·本地 /
     不在手机上答（弃权会交给下一个应答者；无人应答时电脑端拿到 unable）」+ 输入区被接管
4. App 上点「生产」→ 出现「清空 / 再点一次可取消选择 / 提交回答」→ 点「提交回答」
   → POST 答案体 {"answers":[{"id":"q1","selected":["生产"]}]}
5. **同一屏立刻看到答案落地**（截图 shots/31-after-answer.png）：
   `ask_user_question | 2m54s · exit 0 | {"answers":[{"id":"q1","selected":["生产"]}]}` + 助手回「你选择的是：生产。」
6. 未决表清空 pending=0；`GET /api/v2/sessions/{id}/transcript?limit=40` 命中「生产」
RESULT: PASS
```

## 口径与坑（写给下一个人）

1. **卡片出现的前置条件**：必须是**电脑端会话**（`source=computer`）且这一轮真的挂在水落石出上；
   网关自有的 `dsh --profile sdk` 会话不在这条流上。
2. **列表要手动刷新**：新会话不会自动出现在 App 列表里（本轮靠点右上角刷新按钮），
   轨迹/详情页也只在进入时拉一次 —— 这不是缺陷，是当前轮询策略。
3. **选过的选项再点一次是取消**（「再点一次可取消选择」），自动化点击脚本重复执行会把已选答案点掉；
   写脚本时务必先判断是否已选中。
4. **别用模糊匹配点按钮**：提示行「…答完点「提交回答」…」也含「提交回答」三个字，
   模糊匹配会点到不可点的提示文字上（本轮踩过一次，改用 `text.Trim() -eq` 精确匹配 + 向上找可点祖先）。
5. **候选答案形状**：`selected` 必须是数组，自由文本键是 `custom`（`selected:[]` = 跳过该问）。
   本轮走的是纯选项题，未覆盖自由文本路径（那条路已由 `android-approval` 的真机夹具用例覆盖）。
6. 两个用例的会话都是**真桌面端会话**，跑完留在电脑端记录里（标题见上），未删除 —— 作为可复查的现场。
