# Android v2 真机证据目录

> 本目录是 `task-3`（A1 Android App：深色对话式远程控制台）的真机证据。
> **读图前请先看「数据来源」一列**：两种来源的证明力不同，混着看会误判。

## 0. 数据来源（重要）

| 前缀 | 数据来源 | 证明什么 | 不证明什么 |
|---|---|---|---|
| `00`~`21`（无 `real-relay`） | **夹具中继**（本目录 `mock-tunnel.mjs`，端口 9543） | App 的 UI / 状态机 / 隧道客户端 / SSE 增量解析 / 离线态 / 停止语义**全部真实运行**；只有"PC 侧数据"是按契约构造的夹具 | **不能**证明与真实中继/网关的互操作 |
| `real-relay-*` | **真实中继**（`tools/dsh-relay/relay.mjs`，端口 9643）+ **真实网关**（`tools/dsh-remote/gateway.mjs`，端口 8887，隔离 home） | 跨网络中继链路真的通：真实 `pair/claim` → 真实 WebSocket 隧道 → 真实网关 API → 真实 `%USERPROFILE%\.dsh` 会话镜像 | 公网部署（本轮无公网 VPS） |

夹具不是"假 UI"：手机侧走的是**真实 WS 握手、真实 `req/res/chunk/end` 帧、真实 SSE 长流**，
App 的代码路径与连真中继时完全一致（`run-ui-check.ps1` 的 46 项断言就是在这条路径上跑的）。
它存在的唯一理由是：中继/网关由其他 teammate 并行开发，App 的验收不能被别人的进度卡住。

## 1. 怎么复现

```powershell
# 夹具链路（不依赖任何外部服务，约 3 分钟）
powershell -NoProfile -ExecutionPolicy Bypass -File .\run-ui-check.ps1

# 真实链路（真实中继 + 真实网关，隔离 home，端口 9643/8887）
powershell -NoProfile -ExecutionPolicy Bypass -File .\run-e2e-real.ps1
```

两者都会输出报告：`ui-check-report.txt` / `e2e-report.txt`（含逐项 PASS/FAIL/SKIP 与实测细节）。
脚本兼容 Windows PowerShell 5.1，且**必须存成 UTF-8 with BOM**（否则 5.1 按 ANSI 解析中文会直接语法错误）。

## 2. 夹具链路截图（`shots/`，数据来源=夹具中继）

| 文件 | 画面 | 关键断言 |
|---|---|---|
| `00-pairing.png` | 配对页（未配对入口） | 「中继地址」输入、明文风险提示卡的触发条件 |
| `01-pairing-filled.png` | 填入示例后的配对页 | 明文 `ws://` 风险提示卡出现、6 位配对码就位 |
| `02-sessions-computer.png` | **电脑会话列表**（行状态语言：绿点「运行中」/ 灰「只读」/ 默认态无胶囊） | 「DSH 远程」「运行中」「只读」「7 个文件」 |
| `03-conversation.png` | **对话流**（用户气泡右 / 助手左 / 工具卡 / 交付物 / 待办 / 只读输入框） | 「该会话正由电脑端驱动…」「pwsh」 |
| `04-tool-call-expanded.png` | 展开的 **isError 工具卡**（红边 + 参数 + 结果） | 「参数」「结果（错误）」 |
| `05-conversation-todos.png` | 待办列表（todo 工具参数投影） | 「待办 3/4」 |
| `06-workspace-root.png` | 工作区根目录（文件/改动/搜索三标签） | 「README.md」「返回上级」 |
| `07-workspace-files.png` | 进入 `android/` 的目录树 | 「BUILD.md」 |
| `08-workspace-changes.png` | **改动列表**（git 徽标 M/A/D/? + 增删行数） | 「分支 main」「已跟踪改动」「RelayClient.kt」 |
| `09-diff.png` | **unified diff**（+/− 着色、行号、hunk 蓝字） | `diff --git`、`@@`、新增行 |
| `10-phone-tasks.png` | 手机任务列表（任务档位：运行中/排队中/已完成/失败） | 「手机任务：跑一遍单元测试」「已完成」 |
| `11-phone-conversation.png` | 手机任务对话流（输入框可用） | 「条消息」 |
| `12-phone-streaming.png` | **流式渲染中**（`助手 · 生成中` + 光标 + 停止按钮） | 「生成中」 |
| `13-phone-turn-done.png` | 一轮结束（工具卡带结果） | 「pwsh」「BUILD SUCCESSFUL in 25s」 |
| `14-stop-confirm.png` | **停止二次确认**（写明"停止后本会话无法继续"） | 「停止后本会话无法继续」 |
| `15-phone-task-stopped.png` | 停止后：**输入框灰化 + 不可继续横幅** | 「本会话已停止，无法继续」 |
| `16-create-phone-task.png` | **新建任务（对话式创建屏，v2.10.0 起不再是对话框）**：页头「新建任务」+ 空对话态 + 工作区/在哪执行·权限/模型 | 「新建任务」「还没有消息」「在哪执行 · 权限」「填入示例」 |
| `17-settings-top.png` | 设置页上半（中继地址/明文提示/配对） | 「中继地址」「当前中继地址是明文」 |
| `18-settings-bottom.png` | 设置页下半（账户状态/吊销/日志导出/浅色开关） | 「吊销本机令牌」「导出日志」「令牌已用 Android Keystore 加密存储」「supportedApiVersions」 |
| `19-computer-offline.png` | **电脑离线态**（收到 `notice{home_offline}`） | 「电脑离线（DESKTOP-DEV 的隧道已断开）」 |
| `20-recovered-online.png` | 恢复在线（`notice{home_online}`） | 「已连接 · DESKTOP-DEV」 |
| `21-legacy-gateway.png` | **旧网关**（响应无 `relay` 块） | 「该电脑未启用中继」 —— 契约裁定：`relay` 块是唯一判据 |

## 3. 真实链路截图（`shots/real-relay-*.png`）

数据来源：真实 `relay.mjs`（9643）+ 真实 `gateway.mjs`（8887，隔离 `--home`，镜像源为真实
`%USERPROFILE%\.dsh` 只读）。文件名统一带 `real-relay` 前缀，避免与夹具证据混淆。

| 文件 | 画面 | 说明 |
|---|---|---|
| `real-relay-01-pairing.png` | 配对页（真实网关生成的 6 位码已填入） | 码来自 `gateway.mjs relay window` |
| `real-relay-02-sessions.png` | **真实会话镜像列表（5 个会话、真实步数/改动数、live 呼吸点）** | **本轮核心证据**：跨网络镜像 PC 真实任务 |
| `real-relay-03-conversation.png` | 真实会话的对话流 | 真实 transcript 投影 + 真实工具调用卡 |
| `real-relay-05-workspace.png` | 真实工作区（本仓库） | 真实文件系统 |
| `real-relay-06-changes.png` | 真实 `git status` 改动列表 | 真实 git |
| `real-relay-07-diff.png` | 真实 unified diff | 真实 git diff |
| `real-relay-08-phone-tasks.png` | 手机任务页（网关自有 DSH_HOME） | 真实网关 home |
| `real-relay-09-create-task.png` | 新建任务对话框 | 走 `POST /api/v2/tasks` |
| `real-relay-10-phone-task-created.png` | 新建后的任务已进列表 | 真实 SDK profile 子进程已起 |
| `real-relay-11-phone-task-streaming.png` | **真实模型的回答经 SSE 流到手机** | 真实 SDK 轮次端到端 |
| `real-relay-12-computer-offline.png` | 停掉真实网关 → 电脑离线 | 契约 §6 判据 D |
| `real-relay-13-gateway-restarted.png` | 网关重启 → **手机自动回到已连接** | App 退避重连 + 离线态自愈探测 |
| `real-relay-14-relay-restarted.png` | 中继重启 → **手机与网关都自动恢复** | 契约 §6 判据 E（最终自愈） |

最终一轮：`e2e-report.txt` = **41 通过 / 0 失败 / 0 跳过**（含 3 项自愈断言全 PASS）。

> 真实链路在首次运行时一度未通，原因不在 App：网关 `lib/relay-client.mjs:532` 的
> `void err;` 引用了作用域外的标识符，导致经隧道转发的 `pair/claim` 抛 `ReferenceError`、
> 网关不回帧、中继 15s 超时、手机收到 503。该缺陷与完整证据链已报给 Lead，由 gateway-dev 修复。
> 修复前的原始报错保留在当时的报告中，便于对照。

## 3.1 并发铁律（Lead 复核后补）

两个 E2E 脚本都会**独占模拟器 + 固定端口**，因此：

1. 脚本启动时会抢 `.e2e.lock`（写入 pid/name/started/host/serial）；发现**已有实例在跑且 PID 存活**
   → 立刻 `exit 3` 并打印「已有 E2E 在运行（PID x），请等待」，**不产出误导性的失败报告**。
   陈旧锁（PID 已退出）会被接管。
2. 进程清理一律 **PID 作用域**：`Win32_Process.Create` 返回的 cmd → 认领其 node 子进程
   （`ParentProcessId`）→ 登记 `$script:OwnedPids` → 只用 `taskkill /PID /T /F` 收自己那棵树。
   **禁止**按命令行关键字（如 `relay.mjs`）全局匹配杀进程 —— 那会杀掉队友的验收进程
   （relay-dev / gateway-dev / ops-doc 都实测被误伤过）。
3. `run-e2e-safety-check.ps1` 是这条铁律的回归：起一个"同形命令行的替身 relay"，跑完整 E2E，
   断言替身仍活着。并发实测：`node scripts/tests/interop-smoke.mjs off` 与本套链同时跑，
   interop-smoke **33/33 PASS**，双方进程互不影响。

## 3.2 报告里的失败分类（Lead 要求，避免假红误伤结论）

`e2e-report.txt` / `ui-check-report.txt` 里每条非 PASS 都带分类：

| 分类 | 含义 |
|---|---|
| `FAIL(产品缺陷)` | App / 网关 / 中继的功能问题 |
| `FAIL(环境或夹具)` | SDK、凭据、端口、模拟器 NAT、前台被抢等环境问题 |
| `FAIL(测试断言)` | 脚本自身时序/取词问题（**不能**记成产品缺陷） |
| `SKIP(environment)` | 环境不满足、**未验证**（**不得**用于"实现了但没通过"） |

报告里还记录 `前台恢复次数`（App 掉前台后被自动拉回的次数）与重复截图警告，
用来区分"功能坏了"和"脚本找错了屏幕"。本轮曾因并发 + 取词过宽出现过 38 项级联假红，
修法与教训见下面 §5.7。


## 4. 目录内容

| 文件 | 作用 |
|---|---|
| `mock-tunnel.mjs` | 夹具中继 + 网关替身（按契约 §2/§3/§4 的帧与端点实现，零依赖） |
| `run-ui-check.ps1` | 夹具链路自动化：安装 → 配对 → 列表 → 对话流 → 工作区/diff → 续聊/流式/停止 → 设置 → 离线 → 旧网关提示 |
| `run-e2e-real.ps1` | 真实链路自动化：起真实中继/网关（隔离 home）→ 真实配对 → 真实镜像/工作区/改动 → 真实 SDK 任务 → 离线 → 自愈 |
| `run-e2e-safety-check.ps1` | **清理安全性回归**：起"同形命令行"的替身 relay，跑完整 E2E 后断言替身仍活着（证明不误杀队友进程） |
| `probe-upgrade-head.mjs` | 协议排障工具：验证"中继把 `ready` 与 101 写在同一个 TCP 段"，即 WS 客户端必须处理 `upgrade` 事件的 `head` 参数 |
| `ui-check-report.txt` / `e2e-report.txt` / `cleanup-safety-report.txt` | 三份逐项报告（PASS/FAIL/SKIP + 分类 + 实测字节数/耗时/原始报错） |
| `.e2e.lock` | 两个 E2E 的互斥锁（pid/name/started/host/serial）；已有实例在跑时新实例立刻退出 |
| `fixture-tunnel.log` | 夹具侧请求日志（脱敏） |
| `interop-smoke-concurrent.log` | 与队友脚本并发跑时的互操作结果（33/33 PASS，双方互不影响） |
| `e2e-runtime/` | 真实联调的隔离运行目录（relay home、gateway home、配置、日志、decoy 替身） |
| `raw/` | `uiautomator dump` 的原始 XML（断言依据，便于人工复核） |

## 5. 本机特有坑（复现时注意）

1. **模拟器只能用 `10.0.2.2` 访问宿主机**：中继的 `relayName`/`publicUrl` 必须是 `10.0.2.2`，
   否则 App 会"配对成功但立刻掉线"（`Unable to resolve host`）。App 侧也做了兜底：
   中继宣告的 `tunnelUrl` 若解析不了，回退到刚配对成功的中继地址
   （`RelayUrls.pickTunnelEndpoint`，有单测；设置页会显示"实际隧道端点"及来源）。
2. **夹具固定用 9543**：真实中继默认 9443（relay-dev 的服务可能正在占用），不要复用。
3. **uiautomator dump 是 UTF-8**，PowerShell 5.1 必须用
   `[System.IO.File]::ReadAllText($p, [System.Text.UTF8Encoding]::new($false))` 读，否则中文断言全落空。
4. **明文提示卡会把控件顶下去约 280px**：每一步都要重新 dump 取坐标，复用旧坐标会点到文字上。
5. **`adb shell input keyevent 4` 在列表页会直接退出 App**：所有返回动作都要先确认屏幕上
   真的有返回箭头（`Ensure-TabScreen` / `Back-IfPossible`）。
6. **中文输入**：模拟器没有中文输入法，中文文本一律用应用内「填入示例」按钮写入
   （debug 变体提供，`DebugSeeds` 支持 `--es dsh_relay_url / dsh_pair_code / dsh_task_prompt` 注入）。
7. **`Task` 形式的坑（本轮踩了两个，都很贵）**：
   - PowerShell 变量名**大小写不敏感**：UI 循环里的 `$node` 会覆盖工具链路径 `$Node` →
     进程启动莫名失败。现在统一叫 `$NodeExe` / `$uiNode`。
   - PowerShell **块注释是 `<# #>`**：写成 `/** */` 会语法错误；块内也不能再出现结束标记。
   - `Invoke-Adb shell am start -W ...` 里的 `-W` 会被解析成 `-WarningAction`（ambiguous）→
     含这类选项的 adb 调用必须显式传数组（`Invoke-AdbArgs @('shell','am','start','-W',...)`）。
   - 原生命令 stderr 在 `ErrorActionPreference=Stop` 下会变成终止性错误（adb pull 的进度行、
     `taskkill` 对已退出 PID 的报错）→ 包一层局部 `Continue` + 先查存在性。

