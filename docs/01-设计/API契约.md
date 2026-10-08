# DSH Remote API 契约 v1（冻结版）

> 本文件是 PC 网关（`dsh-remote`）与 Android 客户端（`DshRemote`）之间的**唯一接口约定**。
> 冻结日期：本仓库首次提交。**任何一方修改本契约，必须同步修改本文件并递增 `X-Api-Version`。**

## 0. 版本与约定

| 项 | 值 |
|---|---|
| API 版本 | `1`（请求头 `X-Api-Version: 1`，网关可选校验） |
| 传输 | HTTP/1.1 明文或 TLS；字符集统一 UTF-8 |
| 数据格式 | `application/json`，字段名 `camelCase` |
| 时间格式 | Unix 毫秒整数（如 `1730000000000`），字段名以 `At` 结尾 |
| 认证 | `Authorization: Bearer <token>`（除 `/api/v1/health`、`/api/v1/pair/claim`） |
| 服务默认端口 | `8787` |
| 事件流 | `GET /api/v1/events` 使用 **SSE**（`text/event-stream`） |

统一错误体（HTTP 4xx/5xx）：

```json
{ "error": { "code": "unauthorized", "message": "设备令牌无效或已吊销" } }
```

错误码枚举：`unauthorized` `forbidden` `not_found` `bad_request` `pairing_closed` `pairing_bad_code` `rate_limited` `busy` `conflict` `payload_too_large` `internal`。

### 裁定补充（v1.1，Lead 裁定，实现与文档一律以此为准）

| # | 歧义点 | 裁定 |
|---|---|---|
| A1 | `pair/open` 鉴权 | **仅接受来自 `127.0.0.1`/`::1` 的请求**，不引入"本地管理口令"配置项。非回环来源一律 `403 forbidden`。 |
| A2 | 并发满时的行为 | `maxConcurrency`（默认 2）**只限制同时 running 的任务数**；超出者进入 `queued` 队列。只有当 `queued` 长度达到 `maxQueueLength`（默认 100）时才返回 `429 busy`。即：正常情况排队，队列满才拒绝。 |
| A3 | 设备吊销 | 二者都要，且语义一致：REST `DELETE /api/v1/devices/{tokenId}`；同时网关 CLI 提供等价子命令 `node gateway.mjs devices revoke <tokenId>` 与 `node gateway.mjs devices list`。 |
| A4 | `deviceId` 格式 | 必须匹配 `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`（小写 UUID v4 文本）。不匹配 → `400 bad_request`。同一 `deviceId` 重新配对时吊销其旧令牌。 |
| A5 | `truncated` 阈值 | 单任务累计输出上限 `maxOutputBytes`（默认 1 MiB = 1048576）。超过时只保留**尾部** `maxOutputBytes` 并置 `truncated: true`；事件流中已推送的 `delta` 不回滚，客户端以详情接口的 `output` 为准。 |
| A6 | `queue`/`timeout` 上限 | `timeoutSec` 缺省 3600，上限 86400；超上限 → `400 bad_request`。 |
| A7 | 删除任务 | 仅终态可 `DELETE`；活动态 → `409 conflict`。 |

### 任务状态机

```
queued ──▶ running ──▶ succeeded
                 └───▶ failed
                 └───▶ canceled
```

`queued`/`running` 为活动态；其余为终态。状态只可单向流转。

---

## 1. 健康检查

`GET /api/v1/health` —— 无需认证（供手机在配置页探测连通性）。

```json
{
  "ok": true,
  "apiVersion": 1,
  "serverName": "DESKTOP-XXX",
  "gatewayVersion": "1.0.0",
  "dshVersion": "0.1.0-rc.7",
  "uptimeMs": 123456,
  "activeTasks": 1,
  "queuedTasks": 0,
  "pairingOpen": true,
  "authRequired": true,
  "capabilities": ["tasks", "events", "pairing", "workspaces", "cancel"]
}
```

## 2. 配对（手机上首次连接 PC）

### 2.1 PC 生成配对码（在 PC 上执行）

由 PC 端脚本/托盘调用本地回环接口完成，**不经过局域网**：

`POST http://127.0.0.1:8787/api/v1/pair/open` → **仅回环可达**（见裁定 A1）

```json
{ "code": "482913", "expiresAt": 1730000600000 }
```

- 配对码：6 位数字，默认有效期 **5 分钟**，一次性使用。
- 网关只接受来自 `127.0.0.1`/`::1` 的 `pair/open` 请求。

### 2.2 手机提交配对码换取设备令牌

`POST /api/v1/pair/claim` —— 无需认证

请求：

```json
{ "code": "482913", "deviceName": "Xiaomi 14", "deviceId": "8f3c…（客户端生成的 UUID）" }
```

成功（`200`）：

```json
{
  "token": "dshr_9f2c…（32 字节随机，Base64Url 无填充）",
  "tokenId": "tok_7a1b…",
  "serverName": "DESKTOP-XXX",
  "expiresAt": null
}
```

失败：`pairing_bad_code`（码错误/过期，`401`）、`pairing_closed`（未开启配对，`403`）。

- 同一 `deviceId` 重复配对：**旧令牌立即吊销**，返回新令牌（便于用户重装 App）。
- 令牌默认**永久有效**，可在 PC 上 `dsh-remote devices revoke <tokenId>` 吊销。

## 3. 任务

### 3.1 提交任务

`POST /api/v1/tasks`

```json
{
  "prompt": "帮我把 D:\\proj 的单元测试跑一遍，失败就修到通过",
  "workspace": "D:\\proj",
  "title": "跑单测",                     // 可选，缺省取 prompt 前 40 字
  "model": "deepseek-flash",             // 可选，缺省用网关默认
  "reasoningEffort": "max",              // 可选
  "timeoutSec": 3600                     // 可选，缺省 3600，上限 86400
}
```

成功（`201`）：返回完整 **Task 对象**。

```json
{
  "id": "task_01J…",
  "title": "跑单测",
  "prompt": "……",
  "workspace": "D:\\proj",
  "status": "queued",
  "createdAt": 1730000000000,
  "startedAt": null,
  "finishedAt": null,
  "exitCode": null,
  "output": "",
  "error": null,
  "truncated": false,
  "sessionId": null
}
```

错误：`bad_request`（`prompt` 为空、`workspace` 不存在）、`busy`（并发已满，`429`）。

### 3.2 任务列表

`GET /api/v1/tasks?status=active|all&limit=50&cursor=<id>`

```json
{ "tasks": [ /* Task 对象，按 createdAt 倒序 */ ], "nextCursor": null }
```

### 3.3 任务详情

`GET /api/v1/tasks/{id}` → Task 对象（`output` 为**当前累计**的完整输出）。

### 3.4 取消任务

`POST /api/v1/tasks/{id}/cancel` → Task 对象

- 活动任务：终止子进程与进程组，状态置 `canceled`；`queued` 任务直接从队列移除并置 `canceled`。
- 终态任务：幂等返回原对象。

### 3.5 删除任务记录

`DELETE /api/v1/tasks/{id}` → `204`（仅终态可删）

## 4. 事件流（SSE）

`GET /api/v1/events?taskId={id}&fromSeq={n}`

- 不带 `taskId`：订阅**所有**任务事件。
- 断线重连：客户端带 `fromSeq`（或 `Last-Event-ID`）补发缺失事件；服务端保留最近 **2000** 条事件。
- 心跳：每 **15 s** 发送注释行 `: ping`。
- 事件格式：

```
id: 42
event: task.output
data: {"seq":42,"taskId":"task_01J…","at":1730000001000,"type":"task.output","delta":"正在读取文件…\n"}

```

事件类型：

| type | 载荷字段 | 说明 |
|---|---|---|
| `task.created` | `task` | 新任务入队（完整 Task 对象） |
| `task.started` | `task` | 开始执行 |
| `task.output` | `delta` | 增量输出；客户端按序拼接为 `output` |
| `task.finished` | `task` | 进入终态（`succeeded`/`failed`/`canceled`） |
| `task.progress` | `phase`,`note` | 阶段提示（可选，如 `queued→running`） |

`data` 恒为单行 JSON（内部换行以 `\n` 转义）。客户端按 `seq` 严格排序、去重。

## 5. 工作区与元信息

`GET /api/v1/workspaces` → 网关配置中允许的工作区白名单

```json
{ "workspaces": [ { "path": "D:\\proj", "label": "proj", "exists": true } ], "default": "D:\\proj" }
```

`GET /api/v1/devices` → 已配对设备（供 PC 端管理页/CLI 使用）

```json
{ "devices": [ { "tokenId": "tok_7a1b…", "deviceName": "Xiaomi 14", "pairedAt": 1730000000000, "lastSeenAt": 1730000500000 } ] }
```

`DELETE /api/v1/devices/{tokenId}` → `204`（吊销令牌）

---

## 6. 安全要求（双方共同遵守）

1. 网关默认监听 `0.0.0.0:8787`，但**配对必须本地发起**，避免局域网内被抢注。
2. 所有 `/api/v1/*`（除 `health`、`pair/claim`）必须校验 Bearer 令牌，比较使用**恒定时间**函数。
3. 令牌只存哈希（网关侧存 `sha256(token)`），明文仅在配对响应中出现一次。
4. 失败限速：`pair/claim` 每 IP 每分钟 10 次；认证失败每 IP 每分钟 30 次，超出返回 `429 rate_limited`。
5. 外网使用必须叠加 TLS：推荐 Tailscale / frp + TLS / Cloudflare Tunnel，禁止裸端口映射到公网。
6. 任务执行的工作目录受 `workspaceAllowlist` 限制，请求中的 `workspace` 必须落在白名单内（含子目录）。

## 7. 客户端实现约束

- Android 端仅使用：`OkHttp`（HTTP+SSE 长连接）、`org.json`（解析）、`DataStore Preferences`（存 `baseUrl`/`token`/`deviceId`）。
- 客户端必须实现：指数退避重连（1s→2s→4s…上限 30s）、`fromSeq` 断点续传、终态落库（本地历史）。
- 任何 UI 状态都不得阻塞事件流消费：事件在后台线程写入内存环形缓冲 + 本地库。
