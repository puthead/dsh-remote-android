# dsh-relay —— 自建跨网络中继服务

> 契约依据：`docs/01-设计/协议契约-v2.md`（**唯一接口事实源**）§2 HTTP 端点、§3 隧道/帧/多路复用/控制面、§5 实现约束。
> 零第三方依赖：只用 Node 内置模块；WebSocket 服务端（含自签证书生成）都是自己实现的。

中继的职责就三件事：**认人**（homeToken/deviceToken）、**多路复用**（把手机的一条 HTTP 请求变成 PC 隧道上的一条流）、**转发字节**。
中继不认识业务、不落盘消息正文、不需要公网 IP 也能被 PC 反向连上（PC 只做**出站**长连接）。

```
手机 App ──wss://relay/api/v2/tunnel/device──┐
                                            ├─ 中继（本服务，TLS 终止在这里）
家里的 PC 网关 ──wss://relay/api/v2/tunnel/home──┘   ← PC 不开放任何入站端口
```

---

## 1. 快速开始

```powershell
# 1) 初始化：写 config.json、建运行目录、生成自签证书（幂等）
node relay.mjs init --home .\.relay-home --relay-name relay.example.com --tls-mode selfsigned

# 2) 给这台 PC 注册隧道凭据（明文 homeToken 只打印这一次，写进网关配置的 relay.homeToken）
node relay.mjs home-token --home .\.relay-home --name DESKTOP-XXX

# 3) 启动（stdout 只输出一行 JSON，人读日志走 stderr）
node relay.mjs serve --home .\.relay-home

# 4) 自检
curl http://127.0.0.1:9443/health
```

`serve` 的 stdout 形如（`ops` 脚本靠这一行拿真实端口，`--port 0` 时尤其重要）：

```json
{"ok":true,"pid":1234,"relayVersion":"2.0.0","apiVersion":2,"host":"0.0.0.0","port":9443,
 "tlsMode":"selfsigned","relayName":"relay.example.com",
 "tunnelUrl":"wss://relay.example.com/api/v2/tunnel/device","home":"...","configPath":"..."}
```

### CLI 一览

| 命令 | 作用 |
|---|---|
| `serve [--config <path>] [--home <dir>] [--host] [--port] [--relay-name] [--relay-secret] [--tls off\|selfsigned\|file] [--cert] [--key]` | 启动服务 |
| `init [--home <dir>] [--force] [--port] [--relay-name] [--relay-secret] [--tls-mode] [--self-signed-dir]` | 初始化运行目录/配置/证书（幂等） |
| `home-token [--home <dir>] [--name <PC 名>]` | 注册（或轮换）一台 PC 的隧道凭据，打印一次明文 `homeToken` |
| `homes [--home <dir>]` | 列出已注册 home（只有摘要与元数据，无明文） |
| `version` / `help` | 版本 / 用法 |

约定：**给了 `--home X` 就默认读 `X/config.json`**；`--key value` 与 `--key=value` 都支持。
`home-token` 与运行中的 `serve` 可以共存：relay 每 `registryReloadIntervalMs`（默认 5s）检查 `homes.json` 内容哈希，
发现被外部改写就热加载，并对在线连接**对账** —— 被轮换令牌的 home/device 连接会立刻断开（契约 §2.2/§2.3 的"旧连接被断开"）。

---

## 2. 配置（`config.example.json`）

```json
{
  "relayName": "relay.local",          // 手机可见的主机名（也用作自签证书 CN/SAN）
  "host": "0.0.0.0",                   // 监听地址（公网部署用 0.0.0.0；本机联调可 127.0.0.1）
  "port": 9443,
  "relaySecret": "",                   // 注册口令（契约 §2.2）。为空=任何来源都能注册，仅限本机/内网调试
  "publicUrl": null,                   // 对外基址（如 https://relay.example.com）；为空时按 relayName+port 推导
  "tls": { "mode": "off", "certFile": null, "keyFile": null, "selfSignedDir": "tls", "commonName": null, "days": 825 },
  "limits": {
    "maxBodyBytes": 1048576,           // HTTP 体 / req.bodyB64 解码后上限（1 MiB，与网关 v1 一致）
    "maxStreamsPerConnection": 64,     // 契约 §3.2：单连接并发流上限
    "maxChunkBytes": 262144,           // 契约 §3.2：单条 chunk 解码后 ≤ 256 KiB
    "maxStreamBufferBytes": 1048576,   // 契约 §3.2：单个 id 缓冲上限 1 MiB
    "backpressureBytes": 4194304,      // 契约 §3.2：bufferedAmount > 4 MiB 时暂停读对端
    "maxMessageBytes": 8388608,        // WS 单条消息（分片重组后）上限
    "pairClaimPerMinute": 20,          // 每 IP 每分钟 pair/claim 上限
    "authFailPerMinute": 30,           // 每 IP 每分钟鉴权失败上限
    "helloTimeoutMs": 10000,           // 升级后多久内必须发 hello（防"连上不干活"占槽）
    "forwardTimeoutMs": 15000          // pair/claim 经隧道转发等待网关响应的上限
  },
  "heartbeat": { "intervalMs": 30000, "timeoutMs": 90000 },   // timeoutMs 必须 ≥ intervalMs×2（推荐 3×）
  "pairWindowTtlMs": 300000,           // 契约 §3.4：配对窗口 TTL 5 分钟
  "registryReloadIntervalMs": 5000,    // homes.json 热加载检查周期
  "log": { "dirName": "logs", "filePrefix": "relay", "toConsole": true }
}
```

运行目录（`--home` / `DSH_RELAY_HOME` / `config.home` / `~/.dsh-relay`）下会产生：
`homes.json`（唯一持久状态）、`logs/relay-YYYYMMDD.log`、`tls/relay.crt|relay.key`（自签模式）。

---

## 3. 对外端点（契约 §2）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 无需认证。**字段严格等于契约 §2.1**：`ok/relayVersion/apiVersion/uptimeMs/homes/devices/relayName` |
| `POST` | `/api/v2/homes` | PC 注册隧道。需带 `relaySecret`（配置为空则跳过）；返回 `{homeId, homeToken, relayName}`，**homeToken 只在这次响应出现**；同名 PC 重复注册 → 复用 homeId + 轮换令牌 + 断开旧连接 |
| `POST` | `/api/v2/pair/claim` | 手机用 6 位配对码换令牌：中继按码找到 home → 经隧道转发到网关 `POST /api/v2/pair/claim` → 结果原样返回（`relay` 块由中继补 `homeId`/`tunnelUrl`，`deviceToken` 由网关生成） |
| `WS` | `/api/v2/tunnel/home` | PC 网关出站长连接，`Authorization: Bearer <homeToken>` |
| `WS` | `/api/v2/tunnel/device` | 手机隧道，`Authorization: Bearer <deviceToken>` |

`pair/claim` 失败码（与契约 §2.3 表格一一对应）：

| HTTP | code | 场景 |
|---|---|---|
| 400 | `bad_request` | `code` 不是 6 位数字 / `deviceId` 不是小写 UUID（沿用 v1 裁定 A4） |
| 401 | `pairing_bad_code` | 网关判定码错/过期/已用（**中继原样透出网关状态码与错误体**） |
| 403 | `pairing_closed` | 网关判定 PC 未开启配对 |
| 404 | `home_not_found` | 中继侧：该码没有对应 home（PC 未连中继 / 窗口过期） |
| 503 | `home_offline` | PC 隧道不在线（含"网关响应超时"，语义都是 PC 侧暂时不可用） |
| 429 | `rate_limited` | 同 IP 超过 `limits.pairClaimPerMinute` |

其余所有路径 → `404 not_found`；方法不允许 → `405`；请求体超限 → `413 payload_too_large`。
错误体统一为 `{"error":{"code":"...","message":"..."}}`（契约 §4.4）。

---

## 4. 隧道协议（契约 §3）

### 4.1 帧类型

| 方向 | `t` | 字段 | 说明 |
|---|---|---|---|
| C→S | `hello` | `proto:2`, `role`, `name?` | **必须是最先发出的帧**（超时/顺序不对 → `error{fatal:true}` 并关闭） |
| S→C | `ready` | `proto`, `role`, `homeId`（device 另含 `homeName`, `homeOnline`） | 准入成功 |
| S→C | `error` | `code`, `message`, `fatal` | 拒绝；`fatal:true` 时中继随后关闭连接 |
| C→S | `req` | `id`, `method`, `path`, `headers`, `bodyB64?` | 请求（device→中继→home；home→中继控制面） |
| S→C | `res` | `id`, `status`, `headers` | 响应头 |
| S→C | `chunk` | `id`, `dataB64` | 响应体分片（可 0 次或多次，单条解码后 ≤ 256 KiB） |
| S→C | `end` | `id` | 正常结束（SSE 可能长时间不发，直到流真正结束） |
| S→C | `abort` | `id`, `reason` | 异常终止 |
| 双向 | `ping`/`pong` | `id?` | 心跳；30s 无 `pong` 视为死链（判定依据：**任何**入站帧都算活跃） |
| C→S | `cancel` | `id` | 取消请求（SSE 客户端离开必须发；中继也会代 device 向 home 发） |
| S→C | `notice` | `kind:'home_offline'\|'home_online'\|'revoked'`, `homeId?` | 状态通知，无需请求 |

### 4.2 多路复用与 id 重映射（§3.2）

- `id` 由**发起 `req` 的一方**分配，连接内唯一；响应必须回填同一个 `id`。
- device→home 方向中继**重映射**：手机侧 `id=1` 在 home 连接上会拿到独立分配的 id，
  因此两台手机同时用 `id=1` 不会互相串（回归用例：`test/tunnel.test.mjs` "id 重映射"）。
- 帧方向由帧类型唯一决定（`req` 恒为发起方，`res/chunk/end/abort` 恒为应答方），不存在方向歧义。

### 4.3 中继补充裁定（契约 §3.5，与网关/手机三方一致）

| 场景 | 中继行为 |
|---|---|
| home 离线时 device 发 `req` | `res{503}` + `chunk({"error":{"code":"home_offline"}})` + `end`（与真实 HTTP 语义一致，TunnelHttp 不必特判）；**同时**在该 home 掉线瞬间向所有 device 推 `notice{kind:'home_offline'}` |
| 单连接在途流超过 `maxStreamsPerConnection` | `res{429}` + `{"error":{"code":"too_many_streams"}}` + `end`（不 abort，保证语义像 HTTP） |
| 单条 `chunk` 解码后 > `maxChunkBytes` | `abort{reason:'overflow'}`（res 可能已发出，只能用 abort），并向 home 发 `cancel` |
| 单个 `id` 缓冲 > `maxStreamBufferBytes` | 同上 `abort{reason:'overflow'}` |
| `bufferedAmount` > `backpressureBytes` | 暂停读取上游连接；降到 1/4 以下自动恢复（只暂停、不丢数据） |
| device 断开 / `cancel` | 代 device 向 home 发 `cancel`，让网关停掉上游工作（SSE 必须能停） |
| device 访问管理端点 | 见 §4.4 |

`abort.reason` 取值：`overflow` `peer_closed` `home_offline` `timeout` `canceled` `internal`。

> **这是枚举，不得扩展**（契约 §3.5 + lead 裁定）。语义边界：`abort.reason` 只回答「**传输层为什么断**」；
> **业务失败原因一律通过 HTTP 状态码 + 响应体表达**（例如网关自身并发上限应回 `res{429}`
> + `{"error":{"code":"too_many_streams"}}` + `end`，而不是发明一个 abort reason）——
> 这正是 §3.5「让 TunnelHttp 与真实 HTTP 语义一致」的延伸。
> 中继对 home 发来的**越界** reason（`gateway_error:*`、`bad_path`、`forbidden_target`、`gateway_not_ready`、
> `too_many_streams` 等）统一归一为 `internal`：这是**防御**（对端越界时不让协议崩、手机只需认识 6 个值），
> **不是**正常路径；发现越界 reason 说明对端实现需要修。
>
> **路径安全（R2 审计发现的真实绕过，已修）**：所有管理面判定都基于**规范化后**的 pathname
> （`new URL()` 折叠 `..` / `%2e%2e`、`\` 归一为 `/`）。修复前 `GET /x/../api/v2/relay/status`
> 经隧道能拿到 **200**（PC 的 relay 状态）—— 因为中继按字面路径判定，而网关会规范化后再打本机 HTTP。
> 推论（给所有实现者的教训）：**用前缀/包含关系做安全判定前必须先规范化**；协议相对路径（`//host/x`）直接 400。

### 4.3.1 心跳与"活着"的判定（P0 事故后固化）

- 中继每 `heartbeat.intervalMs`（默认 30s）向对端发 JSON `{t:'ping'}`，**先发 ping 再判 idle**；
- **存活信号 = 收到的任何入站活动**：RFC 6455 协议级 ping/pong（含自动回 pong）、任何字节、以及任意 JSON 帧。
  为什么必须这么宽：真实网关每 30s 发的是**协议级** ping（`ws.ping()`），旧实现只按 JSON 文本帧记账，
  于是把健康连接判成死链，表现为"每 30s 掉线一次且不可自愈"（因为那一次 JSON ping 还没发出去就被踢了）。
- 死链判据：连续 `heartbeat.timeoutMs`（默认 90s = 3×interval）内**没有任何入站活动** → 断开 + 清理 + 记 `heartbeatTimeouts` 计数。
- 约束：`timeoutMs` 必须 ≥ `intervalMs×2`（**推荐 3×**）；1:1 会在第一个周期就误杀，配置校验直接拒绝启动。
- 回归用例：`test/ws.test.mjs` 的「心跳 P0 回归：只发协议级 ping / 不回 JSON pong 的健康连接…」「…完全不响应的连接仍必须被清理」；
  真实链路版本：`.runtime/interop/heartbeat-liveness.mjs`（真实 relay × 真实 gateway，压缩心跳跑多个周期，断言零重连）。

### 4.3.2 Header 透传规则
device 发来的请求头会被**白名单式**透传：只保留名字匹配 `^[A-Za-z0-9-]{1,64}$` 的头，最多 64 个、总长 ≤ 16 KiB。
**非标准头（例如含下划线的 `X_Foo`）不透传**（HTTP 头名里的 `_` 本质是未定义行为，静默丢弃比透传安全）。

### 4.4 控制面：home 反向调用中继（§3.4）

`req` **不是单向的**：home 在自己的隧道连接上发 `req` 调用中继自身，中继直接应答 `res + chunk(JSON) + end`。

**只允许以下三条路由，未命中一律 `res{404}` + `{"error":{"code":"not_found"}}`**：

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/v2/pair/window` | 声明配对窗口 `{code, expiresAt?}`；TTL 默认 5 分钟，`expiresAt` 会被夹紧到 `(now, now+TTL]`；与**其他 home 的有效码**撞号 → `409 code_conflict`（网关换码重试，最多 5 次）；同一 home 重复声明则覆盖自己的旧码 |
| `GET` | `/api/v2/pair/window` | 查询 `{open, expiresAt}`（**不回显配对码本身**） |
| `POST` | `/api/v2/pair/close` | 关闭窗口 → `{open:false}` |

**home 不得借隧道访问中继的对外管理端点**（`/health`、`/api/v2/homes`、`/api/v2/pair/claim` 等一律 404）。
回归用例：`test/tunnel.test.mjs` 的「控制面 §3.4：home 反向调用只允许三条路由，未命中一律拒绝」。
配对窗口**只存在内存**（5 分钟生命周期的秘密不落盘），relay 重启后由网关重新声明。

### 4.5 device 只能访问自己绑定的 home

- device 隧道的身份在握手时由 `sha256(deviceToken)` 唯一确定 → **结构上**只能访问该 home；
- 额外门禁（防御纵深）：device 经隧道访问**管理面**一律 `res{403}` + `forbidden`，**请求不会被转发到 home**：
  - 中继自身端点：`/health`、`/api/v2/homes`、`/api/v2/tunnel/*`；
  - 契约 §4.1 明确「仅回环」的网关管理端点：`/api/v2/relay/*`、`/api/v2/pair/open`、`/api/v2/pair/window`、`/api/v2/pair/close`、`/api/v1/pair/open`。
  为什么必须由中继挡：经隧道转发时网关看到的来源就是 `127.0.0.1`，**网关自身无法区分**（网关仍应做自己的授权）。
- **其余全部放行**，包括：
  - v1 的**全部业务端点**（`/api/v1/health`、`/api/v1/tasks*`、`/api/v1/events`、`/api/v1/workspaces`、`/api/v1/devices/{id}` 等；
    契约头表要求「v1 的 task 端点全部保留」）；
  - **经隧道的配对** `/api/v1/pair/claim` 与 `/api/v2/pair/claim`（见 §4.6，响应恒注入 `relay` 块）。
  > 教训：这份名单被真互操作纠正过两次 —— 第一版拦了整个 `/api/v1/`（破坏 v1 兼容），
  > 第二版拦了整个 `/api/v2/pair/`（与 lead 裁定冲突）。两次都是两侧各自测试"自洽通过"。
  > 回归用例：`test/tunnel.test.mjs` 的「越权拒绝」「v1 兼容性」「经隧道配对」三条。

### 4.6 经隧道配对：响应恒注入 `relay` 块（契约 §2.3，lead 裁定）

| 路径 | `relay` 块 | 说明 |
|---|---|---|
| 直连 `POST /api/v2/pair/claim`（手机→中继 HTTP） | 恒有 | §2.3 主路径（`lib/http.mjs` 处理） |
| 经隧道 `POST /api/v1/pair/claim` | **恒有** | 老 App 靠它拿 `tunnelUrl`；v1 直连响应体不受影响（那条路径不经过中继） |
| 经隧道 `POST /api/v2/pair/claim` | **恒有** | |
| 直连 `POST /api/v1/pair/claim`（手机→网关，局域网） | 无 | 中继不参与该路径；v1 响应体逐字不变 |

注入内容：`{ homeId, deviceToken, tunnelUrl, apiVersion: 2 }`（`deviceToken` 仍由网关生成，中继只叠加并只存 `sha256`）。
非 200 / 非 JSON 响应**原样透出**，不注入、不绑定。中继绑定 token 时用的是**隧道身份的 deviceId**（不是请求体里的值），
防止设备借别人的 deviceId 覆盖绑定；正在配对的这条连接不会被自己的轮换踢掉。

> 为什么必须由中继做：v1 网关响应体里没有 `relay` 块（v1 兼容铁律），而经隧道的老 App 需要它才能建设备隧道 ——
> 这是 gateway-dev 在真互操作里发现的缺陷。

---

## 5. 安全

1. **只存 sha256**：`homes.json` 里只有 `homeTokenHash` / `deviceTokenHash`（+ homeName/deviceId/tokenId/时间戳）。
   明文 `homeToken`/`deviceToken` 只在生成它的那一次响应（或 CLI stdout）出现。被拖库也无法冒充 PC 或手机。
2. **日志脱敏**：`homeToken`/`deviceToken`/`pairCode`/`Authorization` 一律按「前 4 位 + `****`」处理，
   且在日志器内部统一执行（调用方无法漏掉）。令牌脱敏规则见 `lib/util.mjs:redactToken`。
3. **不落盘消息正文**：中继只持有内存里的连接/流表；`homes.json` 不含任何请求内容。
4. **`relaySecret` 为空 = 开放注册**：启动时打印明确警告。公网部署**必须**设置 `relaySecret`。
5. **配对码**：6 位数字用 `crypto` 拒绝采样生成（无模偏置），窗口 5 分钟、只存内存、不回显。
6. **TLS**：`off`（开发）/ `selfsigned`（自签，`node:crypto` 生成 DER 落盘）/ `file`（正式证书，含无域名的
   **Let's Encrypt IP 地址证书**）。
   **生产必须用 `file` + 系统信任链可校验的正式证书**：App **没有**"信任自签证书"开关（需求 FR-15 / O8，
   只认系统信任链），所以 `selfsigned` 形态手机侧一律连不上，仅用于本机/内网与 PC 侧联调。
   IP 证书的 `subject` 为空、身份全在 SAN（`X509v3 Subject Alternative Name: critical`）——`lib/tls.mjs` 的
   `describeCertificateSubject()` 专门处理这种合法证书，否则启动日志会对 `undefined` 调 `.replace()` 直接崩。
   证书 6 天寿命的续期钩子写法见 `docs/05-运维/中继部署手册.md` §5.1。
7. **限速**：`pair/claim` 与鉴权失败都按 IP 限速（`429` + `Retry-After`）。
8. **防挂起**：`hello` 超时、心跳判死链、HTTP `requestTimeout`/`headersTimeout`、close 握手超时强断、优雅关闭强制回收升级 socket。

---

## 6. 测试

```powershell
# 必须在 tools/dsh-relay 目录下、用 DSH 自带 node（v24.21.0）
& 'D:\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe' --test "test/*.test.mjs"
```

覆盖矩阵（task-1 §8 全部场景；**自包含**：每条自己起中继 `port:0` + 独立临时 home，不依赖外部进程/端口）：

| 文件 | 覆盖 |
|---|---|
| `test/ws.test.mjs` | RFC 6455 §1.3 官方向量、握手 101/401/404/426、分片重组、WS ping/pong/close、掩码 1002、binary 1003、消息上限 1009、JSON 心跳、死链判死、首帧必须 hello、hello 超时、role/proto 不符、**心跳 P0 回归（只发协议级 ping 也不得误杀 / 静默必须被清理 / `timeoutMs < intervalMs×2` 启动即拒）** |
| `test/tunnel.test.mjs` | id 重映射、20 并发流、大响应字节一致、chunk 上限 abort、单流缓冲 abort、背压暂停/恢复、流数上限 429、home 掉线（notice + abort + 503）、home 恢复、越权 403、**v1 兼容性回归（含 query 逐字透传）**、**路径规范化绕过回归**、cancel 传播、控制面三条路由 + 404 拒绝 + 路径规范化、码冲突 409、homeToken 轮换、**经隧道配对注入 relay 块** |
| `test/http.test.mjs` | `/health` 形状、注册/口令/轮换、pair/claim 全失败码、deviceToken 轮换与吊销、错误体、限速、homes.json 热加载、端到端串联 |
| `test/tls.test.mjs` | 自签证书解析/SAN/自验签、HTTPS+WSS 端到端、严格校验必须拒绝自签、证书复用、file 模式、off 模式 |
| `test/persistence.test.mjs` | 并发 flush 不丢记录、只存 sha256、损坏隔离、热加载、重启后令牌仍有效 |
| `test/cli.test.mjs` | `serve/init/home-token/homes/version` 真实子进程、stdout 单行 JSON、退出码 |
| `test/unit.test.mjs` | 脱敏、原子写、配置校验、地址推导、注册表/配对窗口语义 |

**测试透明原则**：`test/ws-client.mjs` 是**独立实现**的 WS 客户端（不复用 `lib/ws.mjs` 的编解码），
且 GUID 常量取自实现 + RFC 官方向量双重钉死 —— 曾经两侧共用一个写错的常量导致"测试全绿但所有标准客户端连不上"，
这条原则就是为了防止同类事故再发生。

**反向用例给统计字段上锁**：P0 心跳修复时新增的 `heartbeatTimeouts` 计数器第一次忘了在 `counters` 里初始化 →
值变成 `NaN`，被同一批新增的**反向用例**当场抓住（「零误杀」断言它等于 0、「静默必须被清理」断言它 ≥1）。
经验：凡是"用计数/台账断言行为"的地方，**同时要有正向与反向两条用例**，否则未初始化/恒零的字段会静默通过。

### 6.1 真互操作脚本（手动，不入自包含套件）

上面 90+ 条是**自包含**用例；真正证明"跨网络链路可用"的是 `scripts/tests/interop-*.mjs`
（真实 relay 进程 × 真实 gateway 进程 × 独立 WS 手机模拟器，**不 mock 传输层**）。
用法与期望输出见 **`scripts/tests/interop.md`**，完整结论文档见 **`scripts/tests/interop-R2-report.md`**。

| 脚本 | 覆盖 | 期望 |
|---|---|---|
| `interop-smoke.mjs [off\|selfsigned\|both] [--with-task]` | 健康面逐字段一致、会话/工作区、经隧道 v1/v2 配对注入、鉴权未被绕过、真实 SDK 任务 | 33/33（37/37 带任务） |
| `interop-boundary.mjs [off\|selfsigned]` | 伪造/轮换令牌、跨 home、控制面越权、overflow、429、强杀掉线、relay 重启自愈 | 51/51 |
| `interop-hello-handshake.mjs` | P0 hello 时序（未发 hello 前零帧 + 1008 关闭 + 日志） | 9/9 |
| `interop-heartbeat-liveness.mjs [cycles]` | P0 心跳误杀（压缩心跳跑多周期，零重连/零超时） | 7/7 |
| `interop-audit-path-bypass.mjs` | 路径规范化绕过回归（8 种写法必须 403/400） | 9/9 |
| `interop-audit-headers.mjs` | 响应头逐跳头审计（证据型，不做断言） | 采集完成 |

---

## 7. 排障

| 现象 | 排查 |
|---|---|
| 网关报"Sec-WebSocket-Accept 不匹配" | 客户端用了非 RFC 6455 的 GUID（中继侧已由官方向量钉死）；请检查客户端实现 |
| 手机一直"电脑离线" | `/health` 看 `homes` 是否为 0；PC 侧 `relay/status` 看 lastError；确认 `homeToken` 未被轮换（轮换会断开旧连接） |
| `pair/claim` 返回 `home_not_found` | PC 没连上中继，或配对窗口已过期（网关需重新 `pair/open` → 中继 `pair/window`） |
| `pair/claim` 返回 `503` | 隧道断了；看 relay 日志的 `home 隧道下线`，或网关在 `forwardTimeoutMs` 内没回 |
| **隧道每 30s 左右掉一次、`reconnects` 持续增长** | 心跳被误判死链。检查 `heartbeat.timeoutMs` 是否 ≥ `intervalMs×2`（**推荐 3×**；1:1 的组合已由配置校验直接拒绝）；relay 日志里若有 `心跳超时（…无任何入站活动）` 即是此类。注意 `lastSeenAt` 由**任何入站活动**推进（含 RFC 6455 协议级 ping/pong），只回协议级 pong 的客户端同样算活着 |
| `home-token` 后网关仍 401 | 等一个热加载周期（默认 5s）；或确认 `--home` 指向同一个运行目录 |
| 流被 `abort overflow` | 对端发送的单条 chunk > 256 KiB，或消费者太慢导致单流缓冲 > 1 MiB；检查网关的分片大小与手机端读取速度 |
| 大量 `too_many_streams` | 手机端并发请求超过 64；SSE 长连接会长期占用一个流，需在客户端离开时发 `cancel` |

---

## 8. 部署形态

- **公网 VPS**：`node relay.mjs serve`（systemd 或 Windows 服务），只暴露 9443；建议 `tls.mode=selfsigned`（配合手机端信任开关）或 `file`（正式域名证书）。
  一键脚本见 `scripts/deploy-relay.ps1`、手册见 `docs/05-运维/中继部署手册.md`。
- **本机联调**：`tls.mode=off` + `host=127.0.0.1` + `relaySecret` 可空，配合 `scripts/e2e-crossnetwork.ps1` 的等价拓扑验证（契约 §6 判据 A~E）。
- **资源占用**：单进程、无数据库；内存与在线连接数/流数成正比，配置上限即内存上限（默认 ~4 MiB/连接级缓冲 + 1 MiB/流）。
