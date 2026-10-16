# live-env：模拟器 App「真在线」联调环境

> 任务：task-6「搭起真中继 + 新代码网关 + 配对模拟器 App（活环境）」
> 状态：**已建成并实测通过**（2026-10-14）。所有数字都来自实际运行输出，原始读数见 `api-checks.txt` / `logs-keylines.txt`，未取证的内容一律写在「已知限制」里。

## 1. 一句话

模拟器里的 DshRemote 现在连的是 **本机回环中继 + 工作区新代码网关**，「电脑会话」列表与审批状态来自**真实桌面端 runtime**（`127.0.0.1:19387` / `C:\Users\Administrator\.dsh`），不再是「电脑离线（离线快照）」。

## 2. 拓扑

```
Android 模拟器 emulator-5554
  App: com.deepseek.dshremote.debug
  中继地址 ws://10.0.2.2:9700   ← 10.0.2.2 是模拟器访问「宿主回环」的固定地址
        │
        ▼
  本机中继  tools/dsh-relay/relay.mjs serve    127.0.0.1:9700（tls=off）
            relayName=live-relay  homeId=home_X9vYLiS71C8wVol44hpn7Q
        ▲
        │ ws://127.0.0.1:9700/api/v2/tunnel/home（网关**出站**连接，公网/内网都一样）
        │
  工作区网关 tools/dsh-remote/gateway.mjs serve  127.0.0.1:18087
        ├── 只读镜像 mirror.dshHome = C:\Users\Administrator\.dsh   → 「电脑会话」列表
        └── 桌面端驱动 desktop.port  = 127.0.0.1:19387              → 实时会话 + 审批桥
```

隔离性：生产网关（8787 / PID 396，旧代码）与公网中继（`wss://123.207.183.237:9443`，已停）**没有被碰过**；本环境用 9700/18087 与独立 home。

## 3. 一键起停

```powershell
# 起（幂等：已在跑就跳过）
powershell -ExecutionPolicy Bypass -File scripts\start-live-env.ps1

# 起 + 顺带把模拟器 App 配对到本中继（adb 驱动：下滚→点「填入示例（debug）」→点「配对并连接」）
powershell -ExecutionPolicy Bypass -File scripts\start-live-env.ps1 -Pair

# 停（幂等：本来没跑也返回 0）
powershell -ExecutionPolicy Bypass -File scripts\stop-live-env.ps1
```

两个脚本都带 **UTF-8 BOM**（本机是 Windows PowerShell 5.1，无 BOM 会按 ANSI 解析直接语法错误），并已通过 `[Parser]::ParseFile` 语法检查（0 错误）。

参数：`-RelayPort`(9700) `-GatewayPort`(18087) `-RuntimeDir` `-RelayHome` `-GatewayHome` `-GatewayConfig` `-MirrorHome` `-DesktopPort`(19387) `-PublicHost`(10.0.2.2) `-DeviceSerial` `-Adb` `-Pair` `-Force`
退出码：`0` 成功 / `2` 前置缺失 / `3` 端口被别的进程占用 / `4` 启动超时 / `5` 配对失败。

启动脚本每一步打印 `[OK]/[WARN]/[ERR]`，并把机器可读状态写到 `.runtime\live-env\live-env.json`；后台进程 PID 写到 `.runtime\live-env\relay.pid` / `gateway.pid`（JSON 内容）。

**停止脚本的安全护栏**（硬约束：不能误杀生产）：只结束「PID 文件里的进程」∪「命令行同时含 `.runtime\live-env` 与 relay.mjs/gateway.mjs 的 node 进程」；命令行含 `.dsh-remote\config.json` 或生产端口 8787/9443 的进程**一律拒绝**；不碰 19387 桌面端运行时、不碰 emulator 进程、不删两个 home（所以重新 start 后 App 自动恢复，配对不失效）。

## 4. 实测验收

| # | 判据 | 实测读数 |
|---|------|----------|
| 1 | 中继起来 | `GET http://127.0.0.1:9700/health` → `{"ok":true,"relayVersion":"2.0.1","apiVersion":2,"homes":1,"devices":1,"relayName":"live-relay"}` |
| 2 | 网关跑的是工作区新代码 | `GET /api/v1/health` → `serverName=live-env-gateway, gatewayVersion=2.1.0, dshVersion=0.1.0-rc.7, supportedApiVersions=[1,2]` |
| 3 | 中继隧道连上 | `GET /api/v2/relay/status`（Bearer）→ `connected=true, homeId=home_X9vYLiS71C8wVol44hpn7Q, relayName=live-relay, url=ws://127.0.0.1:9700, reconnects=0` |
| 4 | **审批通道可用** | `GET /api/v2/approvals`（Bearer）→ `{"ok":true,"approvals":[],"state":{"available":true,"connected":true,"pending":0}}` |
| 5 | 「电脑会话」是真会话 | `GET /api/v2/sessions`（Bearer）→ **24 条**，其中 `live=1`（「优化手机端 App 界面」`source=computer, driver=desktop, createdBy=desktop, turns=1, bytes=2033999`）；另有 aborted/completed 的真实历史会话 |
| 6 | 镜像源确实指向真实 home | `GET /api/v2/health` → `sessionMirror.roots = [{phone: .runtime\live-env\home\dsh-home, writable:true}, {computer: C:\Users\Administrator\.dsh, writable:false}]` |
| 7 | App 设置页 | 「已连接 · 活动环境台式机」/「中继地址 ws://10.0.2.2:9700」/「桌面端 live-env-gateway」/「隧道端点 ws://10.0.2.2:9700/api/v2/tunnel/device」/「配对成功：live-env-gateway · 中继 live-relay」 |
| 8 | App 首屏 | 「全部 24 / 进行中 1 / 手机发起 0 / 只读 0」，首位是「优化手机端 App 界面（运行中）」 |
| 9 | **可恢复性**（stop→start 一轮后） | App 先显示「中继重连中 / 中继中断，4s 后重连」，**4 秒内**自动回到「活动环境台式机 · 已连接 / 桌面端 DSH 在线 · 隧道正常」；中继日志出现 `device 隧道上线 deviceId=82e41b3b-… homeOnline=true` |
| 10 | 幂等 | 连续第二次 `start`：`中继已在运行，跳过启动（PID 9188）`、网关同样跳过，退出码 `0` |
| 11 | 停止脚本不误杀 | 结束 gateway PID 8884 / relay PID 11276 后 9700、18087 均已释放；19387 桌面端与 PID 396 未受影响 |

原始证据：

* `api-checks.txt` —— 各 API 的完整响应体（含 `/api/v1/health`、`/api/v2/health`、`relay/status`、`approvals`、`sessions`）
* `logs-keylines.txt` —— 网关/中继日志关键行（`中继隧道已连接`、`会话镜像 : C:\Users\Administrator\.dsh（只读，来源 config）`、`审批桥已连上桌面端事件流`、`已加载 2 个设备令牌`、`home 隧道上线`、`device 隧道上线 … homeOnline=true`）
* `shots/*.png` —— 1080×2340 截图

## 5. 截图清单（`shots/`）

| 文件 | 内容 |
|------|------|
| `00-pair-screen.png` | 2:32 配对页顶部：黄点「未连接中继」（**配对前**状态），下方是「怎么配对」三步说明与 6 位码框 |
| `00b-miss-filldemo.png` | 与 00 **逐字节相同**（SHA256 均为 `31C8A26B7B3C6905…`）：这就是「不滚屏、直接去找『填入示例（debug）』」那一刻的屏幕 —— 屏幕上根本看不到任何按钮，即坑 1 的直接证据 |
| `01-after-pair.png` | 2:32 配对页（配对码框已显示 `482913`）：二维码占满中段，底部「中继与设备 / 中继地址」被屏幕下沿切掉，仍为「未连接中继」 |
| `02-filled-demo.png` | 2:33 下滚后：可见「3. 把中继地址与 6 位码填到下面，点「配对」」以及黄色描边的**明文 ws:// 风险提示卡**（就是它把「配对并连接」二次顶出屏幕） |
| `03-after-pair.png` | 2:33 **配对成功瞬间（关键帧）**：「活动环境台式机 · 已连接」+ 绿条「桌面端 DSH 在线 · 隧道正常 已连 1.5s」，但列表 **全部 0**、空态文案「还没有电脑端会话。在电脑上开一个 DSH 会话，或点右下角加号新建。」、页面中央仍在**转圈** → 首拉尚未返回，**不能据此判失败**（坑 3） |
| `04-sessions-now.png` | 2:34（约 1 分钟后）同一页面：**全部 24 / 进行中 1**，首位「优化手机端 App 界面（运行中）」 |
| `05-settings-live-env.png` | 2:34 设置页：已连接 · 活动环境台式机 / 中继地址 `ws://10.0.2.2:9700` / 桌面端 `live-env-gateway` / 隧道端点 `ws://10.0.2.2:9700/api/v2/tunnel/device` / 配对成功：live-env-gateway · 中继 live-relay |
| `06-sessions-list.png` | 2:34 会话列表（同一已连接状态的另一帧） |
| `07-live-now-reconnected.png` | 2:38 **stop→start 复跑之后**：活动环境台式机 · 已连接 / 桌面端 DSH 在线 · 隧道正常「已连 0.0s」/ 全部 24 / 进行中 1 → 自动重连成功 |

> 截图时间取自模拟器状态栏（2:32→2:38 与 07 的「已连 0.0s」互相印证了「stop 后 4 秒内自动回连」）。

## 6. 三个坑（已写进 `start-live-env.ps1 -Pair` 的实现里）

1. **`uiautomator dump` 只包含可见节点**。配对页很长（带二维码），「填入示例（debug）」「配对并连接」初始都在屏幕外 → 必须先 `input swipe` 下滚再 dump，不能按「控件不存在」处理。
2. **点「填入示例」后插入「明文 ws:// 风险提示卡」**，把「配对并连接」**再次**顶出屏幕 → 必须用「下滚 → 找控件 → 再下滚」的循环（脚本里 `Tap-ByText -Scrolls N`），滚一次不够。
3. **配对成功后列表首拉未回时是「全部 0」**，还会显示「还没有电脑端会话。在电脑上开一个 DSH 会话…」——见 `shots/03-after-pair.png`：已经「已连接 · 已连 1.5s / 隧道正常」，但列表仍是 0 且中央在转圈；到 2:34 的 `04-sessions-now.png` 才变成 24 条（间隔约 1 分钟）→ **断言会话列表必须轮询等待**，不能 sleep 一次就判失败。

各坑的证据对应：坑 1 → `shots/00-pair-screen.png` 与 `shots/00b-miss-filldemo.png`（同一帧，按钮不在可视区）；坑 2 → `shots/02-filled-demo.png`（黄色明文 ws:// 卡）；坑 3 → `shots/03-after-pair.png` → `shots/04-sessions-now.png`。自动重连 → `shots/07-live-now-reconnected.png`。

附带：脚本/取证里读中文必须显式 UTF-8（`[System.IO.File]::ReadAllText(path, UTF8Encoding($false))` 或 `Get-Content -Encoding UTF8`），PS 5.1 默认按 ANSI 读会让中文关键字全部落空；截图必须走 `cmd /c "adb … exec-out screencap -p > file"`。
另外：**正在运行的进程独占日志文件**，`[IO.File]::ReadAllText` 读 `.runtime\live-env\logs\*.log` 会报「正由另一进程使用」，取证时用 `Get-Content -Encoding UTF8`。

## 7. 给其他 teammate 的无头用法（不需要模拟器）

```powershell
$t = (Get-Content .runtime\live-env\logs\headless-device-token.txt -Raw).Trim()
$h = @{ Authorization = "Bearer $t" }

Invoke-RestMethod 'http://127.0.0.1:18087/api/v2/health'      -Headers $h
Invoke-RestMethod 'http://127.0.0.1:18087/api/v2/approvals'   -Headers $h   # state.connected 就是审批 e2e 的判据
Invoke-RestMethod 'http://127.0.0.1:18087/api/v2/sessions?limit=200' -Headers $h
Invoke-RestMethod 'http://127.0.0.1:18087/api/v2/relay/status' -Headers $h
```

* 令牌：`deviceId=11111111-2222-4333-8444-555566667777`、`deviceName=live-env-headless`，写入网关 home 的 `devices.json` → **重启网关后仍有效**（start 脚本会先复用它，不重复配对，devices.json 不膨胀）。
* 配对码（一次性、5 分钟）：`node tools\dsh-remote\gateway.mjs pair --port 18087`。

## 8. 文件清单与写范围

| 路径 | 说明 |
|------|------|
| `scripts/start-live-env.ps1` | 起中继+网关（幂等、参数化、写 PID/状态文件、可选 `-Pair`） |
| `scripts/stop-live-env.ps1` | 停本夹具（幂等、按命令行证据识别、拒绝生产实例） |
| `.runtime/live-env/config.json` | 网关配置（每次 start 按参数重写；`mirror`/`desktop` 指向真实桌面端） |
| `.runtime/live-env/relay-home/` | 中继 home（含 `config.json` 与 relaySecret；**只在缺失时 init**） |
| `.runtime/live-env/home/` | 网关运行 home（凭据 `devices.json`/`relay.json`/`tasks/`） |
| `.runtime/live-env/logs/` | `relay.out/err.log`、`gateway.out/err.log`、`headless-device-token.txt` |
| `.runtime/live-env/{relay.pid,gateway.pid,live-env.json}` | 进程 PID 与状态（stop 时删除） |
| `android/evidence/live-env/`（本目录） | 截图 + API 读数 + 日志摘录 |

两个脚本**刻意不 dot-source `scripts/_common.ps1`**：那套公共库归生产脚本所有且仍在被并行修改，夹具脚本自包含可避免跨改动耦合，也把写范围限制在各自一个文件里。

## 9. 已知限制 / 未取证

* 中继 `tls=off`（回环联调专用）：App 设置页会显示「当前中继地址是明文 ws://…可被同网络设备嗅探」的提示卡；仅适用于本机回环/可信内网，**不是生产配置**。
* 桌面端 runtime 若不在跑（19387 不可达），手机仍能连上，但「电脑会话」为空、审批桥不可用；启动脚本会打 `[WARN]`。
* 无头令牌（`1111…667777`）与 App 设备（中继日志里的 `deviceId=82e41b3b-2595-4d23-be77-5087382ca6df`）是两台不同「设备」，都在 `devices.json` 里；原始 deviceToken 只在配对响应里出现一次（PC 侧只存 sha256），无法从 PC 反查 App 的令牌。
* 未做：真机（非模拟器）联调、中继 TLS（`selfsigned`/`file`）、`-Pair` 在「App 未安装/未启动」设备上的表现、把 live-env 接进 gradle 构建。
