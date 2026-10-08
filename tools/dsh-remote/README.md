# dsh-remote —— PC 端远程任务网关

零第三方依赖（只用 `node:` 内置模块）的 Node ESM 守护进程：把 PC 上 DSH 的 **headless** 执行能力
包装成「HTTP + SSE + 配对鉴权」的接口，供手机 App（`android/` 下的 DshRemote）远程下发任务并实时看输出。

- 接口定义以 **`docs/01-设计/API契约.md`** 为唯一准绳；本文件只描述**怎么装、怎么配、怎么排障**。
- 网关自身不调用任何模型 API：它只是 `dsh --profile headless "<任务>"` 的受控父进程。

---

## 1. 快速开始（3 步）

```powershell
# 1) 配置：复制模板并改成自己的路径（仓库只保留模板，config.json 不入库）
cd tools\dsh-remote
Copy-Item config.example.json config.json
notepad config.json          # 改 dshHome / workspaceAllowlist / dsh.node / dsh.binPath

# 2) 准备凭据目录（dshHome）：必须存在单行 .credentials.yaml
#    内容形如：DEEPSEEK_API_KEY: sk-xxxx      （UTF-8 无 BOM，只有这一行）
#    注意：不要复用 %USERPROFILE%\.dsh\.credentials.yaml（那是新格式，headless profile 解析失败）

# 3) 启动 + 生成配对码
.\dsh-remote.cmd serve
# 另开一个窗口：
.\pair.ps1
```

拿到 6 位配对码后，在手机 App 的配对页面输入即可换取长期令牌。

---

## 2. 目录结构

```
tools/dsh-remote/
├─ gateway.mjs            # 入口 + 本地 CLI（serve / pair / devices / workspaces）
├─ config.example.json    # 配置模板（仓库唯一入库的配置；config.json 由 setup-pc.ps1 生成，已被 .gitignore 忽略）
├─ config.json            # 本机运行配置（含绝对路径，不入库）
├─ dsh-remote.cmd         # Windows 启动器（优先用 DSH 自带 node.exe）
├─ pair.ps1               # 本机生成 6 位配对码
├─ install-service.ps1    # 计划任务开机自启（-Uninstall 卸载）
├─ lib/
│  ├─ config.mjs          # 配置加载/校验/home 解析
│  ├─ http.mjs            # 路由、鉴权、限速、1MB 请求体上限、SSE
│  ├─ tasks.mjs           # 任务队列、并发调度、执行、持久化
│  ├─ runner.mjs          # argv 数组 spawn、进程树终止、超时、输出聚合
│  ├─ tokens.mjs          # 设备令牌（sha256 + 恒定时间比较）与配对码
│  ├─ events.mjs          # 事件总线（seq + 最近 2000 条环形缓冲 + 断点续传）
│  ├─ workspace.mjs       # 工作区白名单校验
│  ├─ ratelimit.mjs       # 滑动窗口限速
│  └─ util.mjs            # 原子写、ULID、脱敏日志、UTF-8 安全截断
└─ test/                  # node:test 单元 + 集成测试（含 fixtures/fake-dsh.mjs 替身）
```

运行期数据全部落在 `dshHome`：

```
<dshHome>/
├─ .credentials.yaml      # 子进程 dsh 的凭据（网关只读取，不写入）
├─ devices.json           # 设备令牌库（只存 sha256，无明文）
├─ tasks/<taskId>.json    # 任务历史与输出（原子写：.tmp + rename）
└─ logs/gateway-YYYYMMDD.log
```

---

## 3. 配置项（最终键名，以此为准）

| 键 | 默认 | 说明 |
|---|---|---|
| `host` | `0.0.0.0` | 监听地址 |
| `port` | `8787` | 监听端口；`0` = 系统分配（测试用） |
| `dshHome` | `null` | 运行时 home（凭据 + tasks + logs），同时作为子进程的 `DSH_HOME` |
| `serverName` | 主机名 | `health.serverName` |
| `authRequired` | `true` | 除 `health`/`pair/claim` 外是否强制 Bearer 令牌 |
| `maxConcurrent` | `2` | **只限制同时 running 的任务数**；超额进入 `queued` |
| `maxQueue` | `100` | 排队上限；**仅当排队数达到该值**才返回 `429 busy` |
| `defaultTimeoutSec` | `3600` | 任务默认超时 |
| `maxTimeoutSec` | `86400` | `timeoutSec` 上限 |
| `workspaceAllowlist` | `[]` | 绝对路径数组；**空数组 = 拒绝所有任务**（默认拒绝，避免忘记配置导致全盘可写） |
| `defaultWorkspace` | 白名单首项 | 请求未带 `workspace` 时的默认值 |
| `dsh.node` | `null` | DSH 自带 `node.exe` 绝对路径 |
| `dsh.binPath` | `null` | `dsh` CLI 的 `bin.js` 绝对路径 |
| `dsh.profile` | `headless` | profile 名 |
| `dsh.version` | `0.1.0-rc.7` | 仅用于 `health.dshVersion` |
| `dsh.discoverSessionId` | `true` | 是否从 `<dshHome>/sessions` 反查本次任务的 DSH sessionId |
| `dsh.launcherArgs` | `[]` | 插在 `--profile <p>` 与 prompt 之间的**启动器级**参数（如 `--patch`）；**headless 应用不认识的参数会被并入任务文本，默认必须为空** |
| `dsh.env` | `{}` | 追加到子进程的环境变量 |
| `events.bufferSize` | `2000` | 事件环形缓冲条数（断点续传窗口） |
| `events.heartbeatMs` | `15000` | SSE 心跳间隔（`: ping`） |
| `limits.maxBodyBytes` | `1048576` | 请求体上限；超限 `413 payload_too_large` |
| `limits.maxOutputBytes` | `1048576` | 单任务输出上限；超限**只保留尾部**并置 `truncated:true` |
| `limits.pairClaimPerMinute` | `10` | `pair/claim` 每 IP 每分钟请求数 |
| `limits.authFailPerMinute` | `30` | 认证失败每 IP 每分钟次数 |
| `limits.pairCodeTtlMs` | `300000` | 配对码有效期（5 分钟） |
| `limits.maxSseClients` | `16` | 并发 SSE 连接上限，超限 `429 busy` |
| `limits.requestTimeoutMs` | `30000` | 接收完整请求的超时（慢速请求 → 408/回收） |
| `limits.headersTimeoutMs` | `20000` | 接收请求头的超时 |
| `limits.outputFlushMs` | `200` | 输出增量下发节流（毫秒） |
| `limits.outputFlushBytes` | `8192` | 输出增量下发阈值（字节） |
| `tasks.dirName` | `tasks` | 任务目录名（相对 `dshHome`） |
| `log.dirName` / `log.filePrefix` / `log.toConsole` | `logs` / `gateway` / `true` | 日志目录、文件名前缀、是否同时打印到控制台 |

> 提示：`docs/` 中若出现 `maxConcurrency` / `maxQueueLength` / `bind` 等写法均为**旧草案**，
> 请以本表与 `config.example.json` 为准。

---

## 4. 接口摘要

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/v1/health` | 否 | 连通性探测 |
| POST | `/api/v1/pair/open` | 否，**仅回环** | 生成 6 位配对码；非回环来源 `403 forbidden` |
| POST | `/api/v1/pair/claim` | 否 | 用配对码换设备令牌；`deviceId` 必须是**小写 UUID**，否则 `400` |
| GET | `/api/v1/tasks?status=all\|active&limit&cursor` | 是 | 任务列表（倒序 + 游标分页） |
| POST | `/api/v1/tasks` | 是 | 提交任务（`201`） |
| GET | `/api/v1/tasks/{id}` | 是 | 任务详情（`output` 为当前累计输出） |
| POST | `/api/v1/tasks/{id}/cancel` | 是 | 取消（幂等） |
| DELETE | `/api/v1/tasks/{id}` | 是 | 删除；**活动态 `409 conflict`**，终态 `204` |
| GET | `/api/v1/events?taskId&fromSeq` | 是 | SSE 事件流 |
| GET | `/api/v1/workspaces` | 是 | 工作区白名单 |
| GET | `/api/v1/devices` | 是 | 已配对设备 |
| DELETE | `/api/v1/devices/{tokenId}` | 是 | 吊销令牌（`204`） |

统一错误体：`{ "error": { "code": "...", "message": "..." } }`。
错误码：`unauthorized` `forbidden` `not_found` `bad_request` `conflict`(409) `payload_too_large`(413)
`pairing_closed` `pairing_bad_code` `rate_limited` `busy` `internal`。

### 4.1 输出截断与 SSE 拼接（重要）

- 未截断时：客户端把所有 `task.output` 事件的 `delta` 按 `seq` 拼接，**等于**详情接口的 `output`。
- 超过 `limits.maxOutputBytes` 时：**只保留尾部**，`truncated` 置 `true`；
  **已经推送的 delta 不回滚**，此时「拼接结果」会比 `output` 长，
  **客户端应以 `GET /api/v1/tasks/{id}` 的 `output` 为准**（终态时重新拉取一次即可）。

### 4.2 断点续传

- 服务端保留最近 `events.bufferSize`（2000）条事件；重连带 `fromSeq=<最后收到的 seq>`
  （或标准 `Last-Event-ID` 头）即可补齐缺失事件。
- 若请求的 `fromSeq` 早于缓冲区起点，网关会在同一条 SSE 流里补发一条注释行
  `: gap requested=… oldest=…`（注释行不影响解析）。
  此时缓冲区内的事件**不足以补齐**断点，客户端**必须**回源 `GET /api/v1/tasks/{id}`
  用详情接口的 `output` 兜底重建本地状态（Android 端已按此约定实现）。

---

## 5. 安全设计

| 项 | 做法 |
|---|---|
| 令牌存储 | 只存 `sha256(令牌)`；`devices.json` 内无明文（有单测断言文件里不含 `dshr_`） |
| 令牌比较 | `crypto.timingSafeEqual`，且遍历全部设备**不提前 break**，避免时间侧信道 |
| 令牌明文 | 只在 `pair/claim` 响应中出现一次；日志写入前统一脱敏（`sk-` / `dshr_` / `Bearer` → `***`） |
| 配对码 | `crypto` 随机数、6 位、一次性、5 分钟过期；新码使旧码立即失效；`pair/open` 仅接受回环来源 |
| 限速 | `pair/claim` 10/min/IP、认证失败 30/min/IP → `429 rate_limited`（带 `Retry-After`） |
| 命令注入 | 子进程一律 `spawn(cmd, argvArray)`、`shell:false`；prompt 作为**单个** argv 元素传递 |
| 工作区 | realpath 归一 + 白名单（含子目录）+ 默认拒绝；防 `..` 穿越与符号链接逃逸 |
| 请求体 | `Content-Length` 预检 + 流式累计上限 1MB，超限立刻 `413` 并关闭连接 |
| 防挂起 | `requestTimeout`/`headersTimeout` + 缩短巡检间隔；SSE 断开即清定时器与订阅 |

---

## 6. 运维

### 6.1 常用 CLI

```powershell
.\dsh-remote.cmd serve                     # 启动网关
.\dsh-remote.cmd pair                      # 生成配对码（走 127.0.0.1 回环）
.\dsh-remote.cmd devices list              # 列出已配对设备
.\dsh-remote.cmd devices revoke <tokenId>  # 吊销令牌（与 REST 共用同一份 devices.json）
.\dsh-remote.cmd workspaces                # 打印白名单
.\dsh-remote.cmd --help
```

### 6.2 开机自启

```powershell
powershell -ExecutionPolicy Bypass -File .\install-service.ps1            # 注册计划任务（登录时启动）
powershell -ExecutionPolicy Bypass -File .\install-service.ps1 -Uninstall # 卸载
```

### 6.3 测试

```powershell
npm test                              # 等价于下面这条
node --test "test/*.test.mjs"
```

> **Node 24 注意**：`node --test test/`（目录参数）在 Node 24.16/24.21 上会报
> `Error: Cannot find module '…\test'` —— 目录参数不再被展开。
> 请改用 `node --test "test/*.test.mjs"`，或直接 `node --test`（自动发现）。
> `package.json` 的 `test` 脚本已按可在 Windows 跑通的写法配置。

### 6.4 常见故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| **改了代码后行为没变** | **网关进程还是旧代码** | 见 §6.5：先杀旧进程再启动 |
| `任务全部 failed：无法启动 dsh 进程` | `dsh.node` / `dsh.binPath` 配错 | 用 `Test-Path` 核对两个绝对路径 |
| `plugin tree failed to load: credentials-local` | `.credentials.yaml` 格式不对（用了新格式或带 BOM） | 必须是**单行** `DEEPSEEK_API_KEY: sk-...`，UTF-8 无 BOM |
| `workspace 不在白名单内` | 白名单没配或路径不匹配 | `.\dsh-remote.cmd workspaces` 查看实际生效值 |
| 任务卡在 `queued` | 并发已满 | 看 `health.activeTasks`，或调大 `maxConcurrent` |
| 手机连不上 | 防火墙 / 地址写错 | 放开 8787 入站；先用 `http://<PC-IP>:8787/api/v1/health` 验证 |
| `429 rate_limited` | 触发限速（配对错误码多/令牌错多次） | 等 1 分钟，或检查 App 里的令牌是否正确 |
| 想清空历史 | —— | 停止网关后删除 `<dshHome>\tasks\*.json` |
| 令牌泄漏 | —— | `devices revoke <tokenId>` 后重新配对 |
| 日志里出现 `????` | 用 ANSI 代码页读取了 UTF-8 日志 | 用 `Get-Content -Encoding UTF8` 或 VS Code 打开 |
| **网关回显的 prompt 中文变成 `???`** | **客户端**（PS 5.1）用 cp936 编码了请求体，网关按 UTF-8 解码 | 见 §6.6：这不属于网关缺陷，改用显式 UTF-8 字节发送 |
| 任务 `failed`：`任务超时` | 超过 `timeoutSec`（默认 3600s） | 提交时显式给更大的 `timeoutSec` |

### 6.5 ⚠️ 改了代码后必须重启网关进程

Node 不会热加载已加载的模块：**源码改动只对新启动的进程生效**。
如果发现「代码明明改了，行为还是旧的」，请按下面两步确认并处理：

```powershell
# 1) 判断是否为旧进程：进程启动时间 早于 源文件最后修改时间 → 就是旧进程
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*gateway.mjs*' } |
  Select-Object ProcessId, CreationDate

Get-ChildItem .\lib\*.mjs, .\gateway.mjs | Select-Object Name, LastWriteTime

# 2) 停掉旧进程（只杀命令行为 gateway.mjs 的进程，不影响其它 Node 程序）
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*gateway.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 3) 重新启动
.\dsh-remote.cmd serve
```

> 血的教训：曾出现「id 里混入 `undefined`」的验收问题，根因就是**旧进程仍在跑**
> （旧代码 + 旧启动参数），而非磁盘上的源码。

### 6.6 ⚠️ PowerShell 5.1 的中文编码坑（客户端侧，非网关缺陷）

**结论先行**：网关的 UTF-8 解码是正确的；中文变 `???` 是**发送端**把请求体按
ANSI/GBK(cp936) 编码造成的。已用三组对照实验定性：

| 组 | 发送方式 | 网关收到的 prompt | 判定 |
|---|---|---|---|
| A | 显式 `[System.Text.Encoding]::UTF8.GetBytes(json)` + `charset=utf-8` | `只回复：中文正常` ✅ | 网关解码正确 |
| B | `Invoke-RestMethod -Body <string>`（PS 5.1 默认行为） | `???:????` ❌ | 发送端用 cp936 编码 |
| C | 手工发 GBK(cp936) 字节 | 非法 UTF-8 → 被替换为 `?`(0x3F) | 解释了 B 的 `???` |

根因：中文区域设置下 Windows PowerShell 5.1 会把 `-Body <string>` 按 **cp936** 编码后发送，
而契约规定请求体为 UTF-8，网关按 UTF-8 解码 → 多字节字符被替换为 `?`。

```powershell
# ❌ 错误：PS 5.1 会用 cp936 编码字符串体，中文变 ???
Invoke-RestMethod -Uri $u -Method Post -ContentType 'application/json' `
  -Body (@{ prompt = '只回复：中文正常' } | ConvertTo-Json)

# ✅ 正确：自己编码成 UTF-8 字节再发送
$json  = @{ prompt = '只回复：中文正常'; workspace = 'D:\proj' } | ConvertTo-Json -Compress
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
$req   = [System.Net.HttpWebRequest]::Create($u)
$req.Method      = 'POST'
$req.ContentType = 'application/json; charset=utf-8'
$req.ContentLength = $bytes.Length
$req.Headers.Add('Authorization', "Bearer $token")
$stream = $req.GetRequestStream()
$stream.Write($bytes, 0, $bytes.Length)   # ← 写字节，不写字符串
$stream.Close()
$resp = $req.GetResponse()
$body = (New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)).ReadToEnd()
$body | ConvertFrom-Json
```

其他可选的正确姿势：

- 用 `curl.exe`（Windows 自带）并把 JSON 存成 UTF-8 无 BOM 文件：
  `curl.exe -s -X POST -H "Content-Type: application/json" --data-binary "@task.json" $u`
- 用 PowerShell 7+（`pwsh`）：其 `Invoke-RestMethod` 对 `-Body <string>` 默认按 UTF-8 发送。
- **手机 App 不受影响**：OkHttp 默认按 UTF-8 编码请求体。

> 排障提示：若怀疑是编码问题，先看网关回显的 `prompt` 字段是否与你发送的一致 ——
> 网关不做任何转码，收到什么字节就按 UTF-8 解出什么字符串。

---

## 7. 已知限制与设计取舍

1. **`model` / `reasoningEffort` 暂不生效（只记录不转发）**：`dsh --profile headless --help` 表明
   当前 headless profile **只接受「任务文本」一个位置参数**；追加 `--model` 会被并入任务文本、
   污染 prompt，因此网关把这两个字段保存在任务内部元数据里（不影响契约字段），**不会**传给 CLI。
   如需切换模型，请改 `dsh.launcherArgs`（**只放启动器级参数**，如 `--patch <file>`）
   或通过 `dsh.env` 注入环境变量；**不要**把 `--model` 直接塞进 `launcherArgs`——
   headless 应用不认识它，同样会被当成任务文本的一部分。
2. **`busy` 的触发条件**：契约 §3.1 写「并发已满 → 429 busy」，而需求又要求超出并发要排队。
   二者兼容的实现是：并发满 → 进 `queued`；**只有 `queued` 达到 `maxQueue` 才 429 busy**
   （`maxQueue=0` 表示不允许排队）。
3. **`DELETE` 活动任务返回 409 `conflict`**、**请求体超限返回 413 `payload_too_large`**：
   这两个错误码已作为**契约 v1.1 §0 枚举的正式成员**（裁定补充表 A7/A5），不再是临时扩展。
4. **`sessionId` 是「尽力而为」**：headless CLI 不打印 session id，网关通过
   `<dshHome>/sessions/<cwd 编码目录>/session-<uuid>/` 的**新增条目**反查；
   若并发导致候选不唯一，则返回 `null`（宁可缺失也不写错）。
5. **`config.json` 不入库**：仓库只保留 `config.example.json`；`config.json` 含本机绝对路径，
   由 `scripts/setup-pc.ps1` 生成并被 `.gitignore` 忽略。
6. **网关重启会中断运行中的任务**：重启后 `queued`/`running` 任务统一标记为
   `failed`（`网关重启，任务执行已中断`），不会留下永远 running 的僵尸任务。
7. **明文 HTTP**：默认监听 `0.0.0.0:8787` 且为明文，只适合家庭内网；
   外网必须叠加 TLS（Tailscale / frp+TLS / Cloudflare Tunnel），**禁止裸端口映射到公网**。
