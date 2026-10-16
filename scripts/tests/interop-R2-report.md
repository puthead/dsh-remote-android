# R2 中继 × 网关真互操作验证报告（task-5）

> 执行者：relay-dev　|　日期：2026-10-08　|　结论：**PASS**（全部真实进程、真实 TCP/WS，无 mock）
> 脚本本体：`scripts/tests/interop-*.mjs`（用法见 `scripts/tests/interop.md`）。所有证据文件在各次运行的 `.runtime/interop/run/<label>-<ts>/` 下（`relay.stdout.txt` / `relay.stderr.txt` /
> `gateway.stdout.txt` / `boundary-evidence.txt`）。

## 0. 一句话结论

用**真实 relay 进程 + 真实 gateway 进程 + 独立实现的 WS 手机模拟器**打通了 `配对 → 设备隧道 → 业务请求 →
SSE/大响应 → 掉线 → 自愈` 全链路，并在这个过程中发现 **7 个只有真互操作/安全审计才能暴露的缺陷**
（3 个中继侧、2 个网关侧、1 个双方叠加、1 个中继侧安全绕过），全部已修复或按 lead 裁定实现，且都有回归用例/脚本固化。

| 套件 | 命令 | 结果 |
|---|---|---|
| 中继自包含单测/集成 | `node --test "test/*.test.mjs"`（tools/dsh-relay） | **93/93 PASS** |
| 互操作冒烟（明文） | `node scripts/tests/interop-smoke.mjs off` | **33/33 PASS** |
| 互操作冒烟（自签 TLS） | `node scripts/tests/interop-smoke.mjs selfsigned` | **33/33 PASS** |
| 互操作冒烟 + 真实 SDK 任务 | `node scripts/tests/interop-smoke.mjs off --with-task` | **37/37 PASS** |
| 边界/恶意输入（明文） | `node scripts/tests/interop-boundary.mjs off` | **51/51 PASS** |
| 边界/恶意输入（自签 TLS） | `node scripts/tests/interop-boundary.mjs selfsigned` | **51/51 PASS** |
| P0 hello 死锁专项 | `node scripts/tests/interop-hello-handshake.mjs` | **9/9 PASS** |
| P0 心跳误杀专项（真实网关） | `node scripts/tests/interop-heartbeat-liveness.mjs 5` | **7/7 PASS + 1 SKIP**（零重连 / 零心跳超时） |
| 路径绕过复验 | `node scripts/tests/interop-audit-path-bypass.mjs` | 全部 403（修复前 dot-segment → **200**） |
| 响应头审计（证据型） | `node scripts/tests/interop-audit-headers.mjs` | 无逐跳头透传（见 §4.4） |

## 1. 证据强度分类（lead 要求）

### 1.1 自包含用例（不与任何外部进程/端口耦合，可 CI 并发跑）
- `tools/dsh-relay/test/*.test.mjs`（88 条）：每条都自己起中继（`port: 0` 由系统分配）+ 独立临时 home 目录；
  对端网关用进程内替身（同一套 WS 客户端实现）。**不连 18787/19443，也不依赖任何队友进程。**
- 其中与本次互操作直接相关的回归用例（防止旧缺陷复发）：
  - `✔ v1 兼容性（R2 互操作回归）：/api/v1/* 业务端点必须能经隧道到达 home`
  - `✔ 服务端绝不先发 ready：未收到 hello 前，中继不得发出任何帧（P0 死锁回归）`
  - `✔ hello 超时：升级成功但迟迟不发 hello → 中继主动、有日志地关闭`
  - `✔ 经隧道配对：v1/v2 pair/claim 恒注入 relay 块，且新令牌能建立 device 隧道（lead 裁定）`
  - `✔ abort 语义保真（R2 互操作发现）：home 发 §3.3 错误码时中继原样透出，自由文本归一为 internal`

### 1.2 手动互操作脚本（真实进程对话，串行跑；固定端口 19100–19700）
| 脚本 | 起什么 | 端口 |
|---|---|---|
| `scripts/tests/interop-smoke.mjs` | 真实 relay 进程 + 真实 gateway 进程 + WS 手机模拟器 | relay 19100(off)/19300(tls)，gateway 0（系统分配） |
| `scripts/tests/interop-boundary.mjs` | 同上 + 第二个真实网关（验证 A/B 互不可达） | relay 19500，gateway 0 |
| `scripts/tests/interop-hello-handshake.mjs` | 真实 relay 进程 + 裸 WS 客户端（复现网关的时序） | relay 0 |
| `scripts/tests/interop-audit-headers.mjs` | 真实 relay + 真实 gateway（打印 res 头） | relay 19700，gateway 0 |

> 端口卫生：这些固定端口只在**显式执行脚本**时占用，且与 ops-doc E2E 的 18787/19443 无交集；
> 自包含用例一律 `port: 0`。

### 1.3 独立验证（不与被测代码共用常量/假设）
- **手机模拟器**是独立实现的 RFC 6455 客户端（`tools/dsh-relay/test/ws-client.mjs`，不复用 `lib/ws.mjs` 编解码）；
  GUID 常量另有一条 RFC 6455 §1.3 官方向量测试钉死。
- **控制面越权探测**用的是**网关自己的 `RelayClient`**（`tools/dsh-remote/lib/relay-client.mjs`）而不是我自写的客户端，
  因此"home 借隧道访问中继对外端点 → 404"是拿真实客户端打出来的结论。
- **hello/ready 时序**用裸 socket + 手写帧编码复现网关的顺序，不经任何中继代码。
- 端口/进程都以真实子进程 + 真实 HTTP/WS 交互，不做任何传输层 mock。

## 2. 只有真互操作才能发现的缺陷（工程教训，lead 要求单列）

### ① 中继把整个 `/api/v1/` 对 device 拦死（中继侧，已修）
- **现象**：手机经隧道 `GET /api/v1/health` → **403**；`/api/v1/tasks`、`/api/v1/devices/{id}`（App 的"吊销本机令牌"）同样 403。
- **根因**：我的 device 管理面黑名单用了前缀 `/api/v1/`，把 v1 契约「task 端点全部保留」一起拦了。
- **为什么两侧测试都没抓到**：中继侧用例当时也按同一份错误名单写的（"共用假设自洽"）；网关侧单测不经过隧道。
- **修复**：改为精确列举管理面；新增 `v1 兼容性（R2 互操作回归）` 用例（含 query 逐字透传断言）。

### ② 网关自签中继注册失败（网关侧，gateway-dev 已修）
- **现象**：`tls.mode=selfsigned` 下 `relay/status.connected=false`，`lastError="中继注册请求失败：self-signed certificate…"`。
- **根因**：`relay-client.mjs:postJson()` 对 https 硬编码 `rejectUnauthorized: true`，`#register()` 未传 `relayCfg.tls`（WS 路径却尊重配置）。
- **修复后**：`smoke.mjs selfsigned` 从 3/12 → **33/33**。

### ③ hello/ready 互相等待（双方各一半，均已修）
- **现象**：中继日志 `心跳超时（30008ms 无任何帧）`；网关日志 `等待中继 ready 帧超时（10s）`，双方循环重连。
- **根因（两个缺陷叠加）**：
  1. **中继**在升级成功那一刻就发了 `ready`（违反 §3.1「hello 必须最先发」）；
  2. **网关**的 `once('__ready')` 在 `await connect()` **之后**才挂 → 与 101 同批到达的 ready 在"无监听器"窗口被丢掉。
- **修复（中继侧）**：升级后**一个帧都不发**，收到 hello 才 `ready`；心跳也从 hello 之后才启动；
  首帧超时独立为 `limits.helloTimeoutMs`（默认 10s，与 30s 心跳解耦）：超时 → `error{fatal:true}` + close **1008** + 日志「未收到 hello，关闭连接」。
- **验证**：`hello-handshake.mjs` 9/9（含"未收 hello 前一个帧都不发"、1211ms 关闭、日志断言）。
- **教训**：协议时序缺陷在"两侧各自 mock"时永远暴露不了；且**超时必须解耦**（用 30s 心跳兜 10s 的协议违例，会把它变成"看起来像卡死"）。

### ④ 经隧道配对缺 `relay` 块（网关侧发现 → lead 裁定 → 中继侧实现）
- **现象**：老 App 经隧道 `pair/claim` 拿不到 `tunnelUrl` → 无法建立设备隧道。
- **裁定**：经隧道 v1/v2 `pair/claim` 恒注入 `{homeId, deviceToken, tunnelUrl, apiVersion:2}`；直连 v1 响应体逐字不变。
- **实现（中继）**：聚合该流的响应体后注入；绑定用**隧道身份的 deviceId**（防借他人 deviceId 覆盖绑定）；
  正在配对的连接不被自己触发的轮换踢掉；非 200/非 JSON 原样透出。
- **验证**：`smoke.mjs` 真实网关 6 条断言全过（v1/v2 各 3 条，含"新令牌真能建设备隧道"）。
- **连带**：为落实此裁定，device 黑名单**第三次**收窄（`/api/v2/pair/*` 前缀 → 精确三条）。
  **教训：管理面白名单必须精确列举，禁止前缀一把抓。**

### ⑤ 中继吞掉网关的 §3.3 abort 码（中继侧，已修）
- **现象**：网关自身入站上限被打满时发 `abort{reason:'too_many_streams'}`（§3.3 合法码），中继归一成 `internal`，手机丢失"并发超限"语义。
- **修复**：`abort.reason` 允许「§3.5 六值 ∪ §3.3 错误码」原样透出，自由文本仍归一为 `internal`。
- **端到端验证**（boundary §6b）：relay 放宽到 100、网关 `maxStreams=3` → 第 4 条收到 `{"t":"abort","id":4,"reason":"too_many_streams"}`。

### ⑥ 路径规范化绕过：device 经隧道直达 PC 的"仅回环"管理端点（中继侧，已修，**安全级**）
- **复现（修复前实测，真实链路）**：
  ```
  GET /api/v2/relay/status            → 403 （黑名单生效，基线）
  GET /x/../api/v2/relay/status       → 200 {"enabled":true,"connected":true,"homeId":"home_lPLDk9w-…", …}   ← 绕过
  GET /%2e%2e/api/v2/relay/status     → 200 （同样绕过）
  ```
- **根因**：中继按**字面路径**判定管理面黑名单，而网关用 `new URL()` 折叠 `..`/`%2e%2e` 后再打本机 HTTP；
  又因为隧道转发的来源在网关看来就是 `127.0.0.1`，§4.1 的回环检查形同虚设 —— 于是任何**已配对手机**都能调用
  `GET /api/v2/relay/status`（信息泄露）、`POST /api/v2/relay/disconnect`（可断掉 PC 隧道）、
  `POST /api/v2/pair/open`（可自行开配对窗口）等"仅回环"端点。
- **修复**：中继所有管理面判定改为基于 `normalizePathname()`（WHATWG URL 折叠点段/百分号编码、`\`→`/`），
  并对字面路径做二次判定；协议相对路径 `//host/x` 直接 400。控制面白名单同样规范化后匹配。
- **回归**：`✔ 路径规范化绕过…`（8 种写法必须 403 + "任何写法都不得把管理面路径送到 home" 不变量）+
  `✔ 控制面路径同样规范化`；脚本 `audit-path-bypass.mjs` 保留为真实链路复验。
- **给所有实现者的教训**（lead 已要求全局排查）：**用前缀/包含关系做安全判定前必须先规范化**；
  网关侧建议加纵深防御（隧道来的路径若与规范化结果不一致即拒），已报 gateway-dev。
- 本次全局排查结论：中继侧其余"包含关系"判定均无同类问题 —— header 是**白名单全匹配正则**（`^[A-Za-z0-9-]{1,64}$`）、
  回环地址是**精确枚举**、deviceId / base64 / 配对码均为**锚定全匹配**；唯一可被绕过的就是路径这一处，已修。

### ⑦ 心跳把健康连接当死链踢掉，且不可自愈（中继侧，P0，已修）
- **现象**：`心跳超时（3000Xms 无任何帧）→ home 隧道下线（reason=timeout）`，网关 `reconnects 0→4`；用户侧每 30s 掉一次线、SSE 被打断、`pair/claim` 偶发 503。
- **根因（非对称的 liveness 记账 + tick 顺序）**：
  1. `lastSeenAt` **只在收到 JSON 文本帧时**更新（`onHomeFrame`/`onDeviceFrame`），而真实网关的活跃信号主要是
     **RFC 6455 协议级 ping**（`relay-client` 每 30s `ws.ping()`）→ 对端明明活着却不算数；
  2. tick 顺序是"先判 idle 后发 ping"，而默认 `intervalMs === timeoutMs === 30000` → 第 1 个 tick 的 idle 就已 ≈30000ms，
     定时器晚几毫秒（实测 30008ms）就成立 → 连接被踢，而那个 JSON ping **根本没发出去** → 对端不会回 JSON pong → **不可自愈**。
- **修复**：① WS 层新增 `activity` 事件（任何入站字节，含协议级 ping/pong）+ `#trackLiveness()` 把
  `activity`/`pong`/`ping` 都接到 `lastSeenAt`；② 改为**先发 ping 再判 idle**；③ 默认
  `timeoutMs = intervalMs × 3 = 90_000`，并把"`timeoutMs < intervalMs × 2`"从软提醒改成**启动即拒绝**（ConfigError）。
- **回归**：`✔ 心跳 P0 回归：只发协议级 ping / 不回 JSON pong 的健康连接，3 个心跳周期内不得被误杀`、
  `✔ 心跳 P0 回归：完全不响应的连接仍必须在 timeoutMs 后被清理`、`✔ 配置校验：timeoutMs < intervalMs×2 必须启动即报错`；
  真实链路：`scripts/tests/interop-heartbeat-liveness.mjs`（压缩心跳 1000/3000ms 跑 5 个周期 → 7/7 PASS + 1 SKIP、零重连、零超时）。
- **教训**：liveness 记账必须是"任何入站活动"，不能只认某一种帧；探活参数必须留出"至少一个 RTT + 抖动"的余量
  （`timeoutMs ≥ 2×intervalMs`，推荐 3×），否则不是"更灵敏"而是**必然误杀**。

## 3. 功能验证明细（真实进程）

### 3.1 冒烟（smoke.mjs，33 条/模式）
- `POST /api/v2/homes` 自动注册 → 网关 `relay.enabled=true` **自动连上中继**（`homeId` 与注册一致）。
- `POST /api/v2/pair/open`（本机回环）→ 中继窗口 → **中继** `POST /api/v2/pair/claim` 转发到网关 → 返回
  `relay.{homeId(中继补), deviceToken(网关生成), tunnelUrl(中继补)}`；中继只存 `sha256`。
- device 隧道 `hello→ready`（`homeOnline=true`）→ 经隧道：
  - `GET /api/v1/health`、`GET /api/v2/health` **与直连网关逐字段一致**（仅 `uptimeMs` 与易变计数例外，已在报告中标注排除项）；
  - `GET /api/v2/sessions`（5 个真实会话）、`GET /api/v2/workspaces/files`；
  - 无令牌 → **401**（隧道没有绕过鉴权）；
  - **经隧道 v1/v2 pair/claim** → 均带完整 `relay` 块，新令牌可建立隧道。
- `--with-task`：经隧道 `POST /api/v2/tasks` → **202** `{"accepted":true,"sessionId":"session-7f55dc65-…","source":"phone","turnId":"turn_run_…"}`（1337ms），
  随后 transcript 可读（`messages=2`，首条 role=user）→ **证明真的起了 SDK 子进程并投影了会话**。

### 3.2 边界/恶意输入（boundary.mjs，50 条/模式）
| 用例 | 真实结果 |
|---|---|
| 伪造 homeToken / deviceToken / 缺 Authorization | 401 ×3，响应不回显令牌；**网关 `relay.stats.requests` 不变 → 未透传** |
| 同 deviceId 再次 claim（过期语义） | 旧连接收到 `notice{kind:revoked}` 并被断开（close 1008）；旧令牌 401；新令牌可用 |
| A 的令牌访问 B | A/B 两台真实网关：`serverName` 分别为 `INTEROP-PC` / `INTEROP-PC-B`；B 访问 A 的工作区路径 → **403 workspace_outside** |
| home 经隧道访问中继对外端点（用网关自己的 RelayClient 打） | `/health`、`/api/v2/homes`、`/api/v2/pair/claim`、`/api/v2/relay/status`、`/api/v2/tasks` 全部 **404**；三条合法控制面路由 200 |
| 单条 chunk 300 KiB > 256 KiB | `abort{reason:'overflow'}` + 中继向 home 发 `cancel` |
| 单流缓冲 > 1 MiB（device 不读） | `abort{reason:'overflow'}` |
| 真实网关大响应（300 KB） | 5 个分片，`maxChunk=65536`（≤256 KiB），**与直连响应逐字节一致** |
| 并发上限 | 3 条 SSE 占满 → 第 4 条 **429 `too_many_streams`**；`cancel` 释放后可继续 |
| 网关侧并发上限（relay 放宽到 100） | 第 4 条收到 `abort{reason:'too_many_streams'}`（reason 保真） |
| 网关进程**强杀**（SIGKILL） | device 收到 `notice{kind:home_offline}`；后续请求 **503 `home_offline`** |
| relay 重启（同端口、复用 homes.json） | 网关**无人工干预**自动重连：`connected=false → true`，`reconnects 0 → 1`，`homeId` 不变，业务立即恢复 |

### 3.3 P0 hello 专项（hello-handshake.mjs，9 条）
未发 hello 的前 400ms **一个帧都没发** → 1211ms 收到 `error{fatal:true}` → close **1008** → 日志「未收到 hello，关闭连接」→ 连接清理；
按网关顺序（监听器晚于 connect）发 hello 时 `rest=0B`（中继没抢跑）→ `ready` 正常到达。

## 4. 代协议合规审计（gateway `lib/relay-client.mjs` / `lib/ws.mjs` vs 契约 §3.1/§3.2/§3.5 + 中继 README）

### 4.1 一致（逐项核对通过）
| 项 | 结论 |
|---|---|
| RFC 6455 GUID / Accept 校验 | ✅ 网关 `ws.mjs` GUID 正确（`258EAFA5-E914-47DA-95CA-C5AB0DC85B11`），客户端帧带掩码、服务端帧必须无掩码 |
| 帧类型与字段名 | ✅ `hello/ready/error/req/res/chunk/end/abort/ping/pong/cancel/notice` 与字段名（`proto/role/homeId/bodyB64/dataB64/kind`）逐项一致 |
| id 语义 | ✅ 出站 id 从 `2^40` 起（`HOME_ID_BASE`），与中继从小整数分配互不冲突；`res/chunk/end/abort` 回填同 id |
| 分片与大小 | ✅ `CHUNK_BYTES=128 KiB`（< 256 KiB 上限，实测 `maxChunk=65536`）；`maxFrameBytes` 8 MiB |
| 本机真实 HTTP（不绕鉴权） | ✅ 经隧道的请求走 `http://127.0.0.1:<port>`，401/限速/错误体全部生效（实测无令牌 401） |
| 只允许回环目标 | ✅ `allowedHosts={127.0.0.1,localhost,::1}`，防止被当中继的任意请求转发器 |
| 心跳 | ✅ 30s JSON `ping` + WS `ping` 双通道；中继两侧都应答（实测 30 分钟内连接稳定，reconnects 不增长） |
| `notice` 处理 | ✅ `home_offline/revoked` 均有处理 |
| 背压 | ✅ 网关用 `bufferedAmount` 观察；中继按 4 MiB 阈值暂停读对端（压力用例见 boundary） |

### 4.2 已修复项（本轮）
| 项 | 位置 | 状态 |
|---|---|---|
| `postJson` 不支持 `relay.tls`（自签注册失败） | `relay-client.mjs:831-840`（原 `:768-798`） | ✅ gateway-dev 已修（`:249` 传入 `relayCfg.tls`） |
| `close` 事件可能重复 emit | `ws.mjs:380-390`（新增 `#emitClose` 守卫） | ✅ gateway-dev 已修 |
| hello/ready 时序 | `relay-client.mjs:294-339`（`helloSent` + ready 先挂载 + `client.on('open')` 内同步发 hello） | ✅ 双方已修 |

### 4.3 观察项（低风险，建议但不阻塞）
1. **自由文本 abort reason**：网关仍会发 `gateway_error:ECONNREFUSED`、`upstream_error:*`、`bad_path`、`forbidden_target`、`gateway_not_ready`
   （`relay-client.mjs:448/478/484/:abort/upstream`）。中继按裁定归一为 `internal`（§3.5 六值 ∪ §3.3 码之外的都不透出）。
   若希望手机能区分"目标非法"这类情形，建议网关改发 §3.3 码（如 `forbidden` / `bad_request`）。
2. **中继 header 过滤**：`sanitizeHeaders` 会丢弃不匹配 `/^[A-Za-z0-9-]{1,64}$/` 的头（含下划线的非标准头会被静默丢掉）。
   当前 api 面不依赖此类头，记录备查。

### 4.4 逐跳头透传：审计未复现（证据型）
`audit-headers.mjs` 打印经隧道回来的 `res` 头，三类代表响应**都没有逐跳头**：
```
GET /api/v2/health            → content-type, content-length, x-api-version, date   （逐跳头：无）
GET /api/v2/workspaces/file   → content-type, content-length(300372), x-api-version, date（逐跳头：无）
GET /api/v2/sessions/stream   → content-type: text/event-stream, cache-control, x-accel-buffering, date（逐跳头：无）
```
因此 `relay-client.mjs:503 flattenHeaders(res.headers)` 虽然形式上会把逐跳头带出来，**实际未发生**。
建议保留一条防御性过滤（成本极低），但不列为缺陷。

## 5. 未覆盖 / 已知限制
1. **公网真链路**：本报告全部在 `127.0.0.1`（等价拓扑），当时没有公网 VPS。
   **2026-10-13 补记**：公网形态已实测通过（Let's Encrypt IP 地址证书 + `wss://123.207.183.237:9443`，
   手机模拟器经公网配对 200 / 真实任务 202 / 探针 12/12；同日 22:14 入口从 80 迁到 9443，
   并修掉「停服卡 90 秒被 SIGKILL」缺陷，见《中继部署手册》§9.2/§9.3/§9.4 与《验收报告》§8.9/§10）；
   本报告的等价拓扑结论由此获得外部有效性证据。
2. **Android 真机经中继**：本报告只覆盖"手机模拟器"；android-dev 的端到端由其 UI 脚本覆盖。
3. **长稳**：最长单次运行约 10 分钟；30 分钟以上的心跳/内存趋势未做（建议在验收阶段补一次长稳）。
4. **多设备并发**：验证了 2 台设备 + 2 台 PC；64 台量级未压测（单连接 64 流上限已逐条验证）。
5. **中继侧**：`limits.maxMessageBytes`（8 MiB）只在单测覆盖，互操作未构造超大帧。

## 6. 本轮改动清单（全部在 relay-dev 写作用域内）
- `tools/dsh-relay/lib/tunnel.mjs`：
  - hello 门控（收到 hello 前不发任何帧）+ `helloTimeoutMs` 与心跳解耦（close 1008 + 明确日志）；
  - 经隧道 v1/v2 pair/claim 响应注入 `relay` 块 + 绑定 deviceToken（用隧道身份 deviceId、`exceptKey` 保留当前连接）；
  - `abort.reason` 保真（§3.3 ∪ 六值）；管理面黑名单精确化；统计新增 `helloTimeouts` / `pairClaimInjected`。
- `tools/dsh-relay/README.md`：§4.3 abort 取值补充、§4.5 管理面白名单（含两次事故记录）、新增 §4.6 经隧道配对注入。
- `tools/dsh-relay/test/*`：+5 条回归用例（88/88）。
- `.runtime/interop/**`：4 个互操作脚本 + 本报告。
