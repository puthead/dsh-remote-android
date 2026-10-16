# DSH 桌面端功能全景

> **一句话**：DSH 桌面端（DeepSeek Harness，Electron）是一个**本地优先的 AI 编码智能体工作台** —— 左边是你的工作区与会话，中间是和智能体的完整对话（含思考、工具调用、diff、终端回显、Todo、审批），右边是会话详情；它把「模型 + 工具 + 沙箱 + 会话存储 + 插件运行时」全部装进一个进程，数据落在本机 `$DSH_HOME`，网络默认只绑 `127.0.0.1`。
>
> **本文档的用途**：作为**手机端（DSH Remote）的功能参照系与实现清单**。**第 12 节是逐项对照表**（桌面有 → 手机现状 → 取舍），第 13 节是建议的实现批次。
>
> **证据口径（重要）**：本文所有功能断言都标注 `路径:行号`。证据根默认是完整运行时副本
> `D:\Workspace\dsh_android\.runtime\acceptance\profiles\node_modules\@deepseek-ai\`（195 包，NTFS junction）。下文省略该前缀，只写包内相对路径，例如 `dsh-client-ui-conversation/lib/client.js:9753`。
> **但桌面安装目录的 asar 是另一套（289 包）**，两者有实质差异；凡形如 `asar:/...` 的证据属 asar 口径。**§4.2、§8.4、§8.5、§9.3、§10.1 已按 asar 口径修正或标注**，其余章节若涉及右栏停靠面板/`present`/Teams，以 §9.3 为准。

- 文档版本：v1.0
- 生成日期：2026-10-14
- 桌面端形态：Windows 11 + Electron（`D:\DSH\DeepSeek Harness.exe`），Web GUI 默认 `http://127.0.0.1:19387`
- 状态：**功能盘点完成**；手机端对标实现进行中

---

## 0. 全景速览（一屏看懂桌面端）

```
┌─────────────┬──────────────────────────────────────────────┬─────────────┐
│  sidebar    │  conversation                                │  details    │
│  264~420px  │  中栏，最小 640px                             │  300~520px  │
│             │                                              │             │
│ 工作区分组   │  [标题] [对话 | 轨迹]  [作业][子代理][预设][导出] │ 工具调用详情 │
│ ├ 会话行     │  ┌────────────────────────────────────────┐  │  输入 / 输出 │
│ │  状态点     │  │ 消息流：assistant-step / user /        │  │  运行中…    │
│ │  标题       │  │ tool-call / command / compaction /     │  │             │
│ │  相对时间   │  │ turn-error / workflow-run …            │  │  （装配后    │
│ │  ⋯ 菜单     │  └────────────────────────────────────────┘  │   无打开入口）│
│ └ 展开其余   │  输入坞：Todo 面板 / GoalBar / 附件栏 / 占用环  │             │
│ 搜索(本地+内容)│  审批面板（等待时接管输入框）                   │             │
│ 底部 cordis  │                                              │             │
└─────────────┴──────────────────────────────────────────────┴─────────────┘
让步顺序固定：先压 details → 再自动关 details → 中栏兜底；sidebar 永不退让
```

证据：`dsh-client-ui-layout/lib/types/client/index.d.ts:31-80`（三栏 slot）、`dsh-client-ui-layout/lib/types/client/columns.d.ts:1-40`（尺寸与让步链）。

---

## 1. 应用外壳与布局

| 能力 | 说明 | 证据 |
|---|---|---|
| 三栏框架 | 左 `sidebar`（single/root）、中 `conversation`（single/session-maybe）、右 `details`（single/session） | `dsh-client-ui-layout/lib/types/client/index.d.ts:31-80` |
| 全框浮层 | `shell.overlay`（list/root），click-through，条目自行开启指针事件 | 同上 |
| 列宽 | `CENTER_MIN=640`；sidebar `MIN=264 / MAX=420 / DEFAULT=280 / COLLAPSED=56`；details `MIN=300 / MAX=520 / DEFAULT=360` | `columns.d.ts:22-40` |
| 自动折叠 | 视口 ≤ `SIDEBAR_AUTO_COLLAPSE=1024` 时自动收起侧栏 | `columns.d.ts:22-40` |
| 让步链 | 先压 details → 自动关 details → 中栏兜底；**sidebar 永不退让** | `columns.d.ts:1-13` |
| 几何持久化 | **无**。列宽/折叠是瞬时状态，不写 localStorage | `dsh-client-ui-layout/README.md:7,21` |
| 无底部面板 | **没有**底部终端、底部抽屉 | 全包无对应 slot |

---

## 2. 左栏 · 工作区与会话列表

### 2.1 结构与行

| 能力 | 说明 | 证据 |
|---|---|---|
| 工作区分组 | 分组头 = folder 图标 + 标题；hover 出 chevron 与「新建」按钮；真实工作区有 hover card，可**复制完整路径** | `dsh-client-ui-workspace/lib/types/.../tree.d.ts:12-26` |
| 未分组桶 | `UNGROUPED_KEY=""`、`UNGROUPED_LABEL="Ungrouped"`，**无**行操作菜单 | 同上 |
| 会话行 | 行高 34px：状态点 + 标题 + 相对时间 + 行操作菜单 | `rows/Rows.d.ts:61-98` |
| 复制 | Workspace card 复制目录全路径；Session card 复制完整标题；空白 New Session card 只读 | `dsh-client-ui-workspace/README.zh.md` |

### 2.2 四种运行状态（**手机端最该照抄的一套语义**）

| 状态点 | 含义 | 优先级 |
|---|---|---|
| 蓝点 | 运行中 | 低 |
| **琥珀点** | **等待交互**：`等待审批` / `计划待审` / `等待回答` | **高于「运行中」** |
| 绿点 | 完成但未查看（`status.completed`） | 低 |
| 空槽 | 空闲 | 最低 |

- 子代理谱系的后代运行数会**聚合到祖先行**。
- 证据：`dsh-client-ui-workspace/README.zh.md:17,21`。

### 2.3 分组、排序、分页

- 分组：`groupBy.workspace` / `groupBy.flat`。
- 排序：`orderBy.manual` / `orderBy.updated`。
- 展开：默认 5 条 + `展开其余`。

### 2.4 搜索（两级，**桌面端体验亮点**）

| 级别 | 行为 |
|---|---|
| 本地即时 | 不区分大小写匹配标题 / 工作区名，边打边出 |
| Host 内容搜索 | 250ms 防抖，带摘要片段 |

- 查询上限 500 UTF-16；结果上限 20 条并提示收窄。
- 内容搜索失败时**仍显示元数据匹配 + 警告**（优雅降级）。
- 证据：`dsh-client-ui-workspace/README.zh.md:9`。

### 2.5 会话行操作（只有三个）

| 操作 | 行为 | 注意 |
|---|---|---|
| Rename | 对话框预填当前标题 | — |
| Fork | 在**最后一个已完成轮次**处 fork；标题括号编号自增，如 ` (1)` | — |
| Archive | **无确认对话框**，非破坏性 | **无 Delete、无取消归档入口** |

证据：`dsh-client-ui-workspace/README.zh.md:11,34`。

---

## 3. 中栏 · 对话视图

### 3.1 视图页签（只有两个）

| 页签 | order | 说明 | 证据 |
|---|---|---|---|
| `对话` / Chat | 0 | 消息流 | `dsh-client-ui-conversation/lib/client.js:9753` |
| `轨迹` / Trajectory | 10 | 台账式总览（**已虚拟化**） | `dsh-client-ui-trajectory/lib/client.js:7340-7345` |

### 3.2 消息流节点类型（穷尽清单）

`assistant-step`、`user`、`steering`（插话）、`context`、`tool-call`、`command`、`manual-compaction`、`compaction`、`model-retry`、`turn-error`、`turn-max-tokens`、`turn-tail`、`unknown`；跨包的 `workflow-run`、`command-input`。

合成排序偏移：`CHAT_SYNTHETIC_SEQ_OFFSETS { interruptedAssistant:-0.9, interruptedFollowup:-0.8, maxTokensNotice:0.05, finalizedFollowup:0.1 }`。
证据：各 `conversation-nodes/*.d.ts:6-9`、`common.d.ts:9-14`。

### 3.3 思考（Reasoning）

- `ReasoningRow({text, running})`：**默认折叠**的披露行，2.6s 扫光动画。
- DOM 标记 `data-variant:"think"`，图标 `IconThinkOutline14`。
- **已知缺陷**：`title:"Think"` 硬编码未本地化（中文界面下仍是 "Think"）。
- 证据：`chat/ReasoningRow.d.ts:9`、`lib/client.js:9005,9015,9016,8948`。

### 3.4 工具调用（**信息密度最高的部分**）

| 项 | 说明 |
|---|---|
| 递归结构 | `ToolCallTree` 递归 `subCalls`（工具内嵌工具） |
| DOM 契约 | `data-chat-anchor-key="call:<id>"` |
| 状态 | `running` / `ok` / `error` / `stopped` |
| 变体 | `search` / `read` / `bash` / `write` / `edit` / `code` / `others` |
| 扩展点 | 键控 slot `tool.call.toolview`，未注册则渲染通用行 |
| 内建业务行 | `FileMutationRow`、`ReadRow`、`SearchRow`、`WebRow`、`BashRow`、`TodoRow`、`AskQuestionRow` |

证据：`dsh-client-ui-tool/README.md:11,13`；`lib/client.js:13-20`。

### 3.5 代码差异（DiffBlock）

- 行前缀 `- `/`+ `，中间折叠用 `⋯`。
- 页脚 `└ +A -R · N file(s)`。
- **默认只显示头尾 16 行**，右上角复制。
- 聊天内 diff 卡上限 `CHAT_DIFF_MAX_LINES=8`（超出折叠）。

### 3.6 终端回显（TerminalBlock）

- **明确不是终端模拟器**：保留 SGR/CR/BS，**剥离**绝对光标定位、清屏、备用屏。
- 状态胶囊：`信号 {signal}` / `退出码 {exitCode}`。

### 3.7 图片

`MessageImage`（单图大图）/ `ImageGallery`（多图 64px 缩略）/ `ImageLightbox`（Escape 或点遮罩关闭、焦点还原）。

### 3.8 流式渲染

| 项 | 实现 |
|---|---|
| 流式标记 | `data-streaming` + 仅末块 `running` |
| **无光标/闪烁/typing 指示** | 靠动画表达：turn shimmer 1.8s、reasoning 扫光 |
| 节流 | `useThrottledVisualUpdate`，`DEFAULT_INTERVAL_FRAMES=3` |
| 自动滚动 | 贴底则追加；用户上移阈值 `floor - scrollTop <= 25`；仅 `!atBottom` 时渲染 `回到底部` |
| 分页 | `加载更早`（内存内滚动锚点保位） |
| 虚拟化 | 聊天流**未虚拟化**；轨迹台账**已虚拟化** |

### 3.9 消息级操作

| 操作 | 可用条件 |
|---|---|
| Copy | 任意消息 |
| Branch（`在新对话中分支`） | 仅**已完成轮次**的最后一条；否则提示 `message.branchUnavailable` |
| Feedback 赞/踩 + 备注 | order 10，插在 Copy 与 Branch 之间 |

- 回合尾统计行：`Ran for … · TTFT … · … tok/s`。
- **不存在**：逐消息重试 / 删除 / 回滚 / 朗读。重试只有自动 `model-retry` 状态行。
- **用户消息不可编辑、不可分支**。

### 3.10 Token 与统计

| 投影 | 字段 |
|---|---|
| `TokenUsageProjection` | `uncachedInputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens` —— **无成本/货币字段** |
| `StatsLine` | `{turns} 轮 · {steps} 步`、`LLM {duration}`、`工具调用 {duration}`、`首 token 平均 {duration}`、`缓存命中 {percent}%`、`输入 {input} tok · 输出 {output} tok` |
| `ContextMeter` | 发送键旁 **14px 占用环**，点击展开构成面板：`系统提示词` / `工具` / `对话消息` |

### 3.11 上下文注入与压缩

- 注入卡：`上下文注入` / `跨会话召回`，动作 `载入`/`新增`/`更新`/`移除`，`保留 {retained} 条 · 省略 {omitted} 条`、`已截断`。
- 压缩卡：`上下文已压缩`、`已压缩 {items} 条历史记录（约 {tokens} tokens）`。
- 错误与提示：`本轮运行失败`、`已达到输出 token 上限`（附「…发送"继续"」）、`已停止`。

### 3.12 Todo / Plan / Goal

| 组件 | 座位 | 文案 |
|---|---|---|
| `TodoPanel` | 输入坞 order 0 | `{done} 已完成 · {active} 进行中 · {pending} 待处理` |
| plan 芯片 | 输入坞 | `Plan ×`，**仅在 plan mode 生效时渲染**，点击执行 `/plan off` |
| `GoalBar` | 输入坞 order 10 | 阶段 `进行中的目标` / `已暂停的目标` / `受阻的目标` + edit / pause / resume / clear |

---

## 4. 右栏 · 详情与停靠面板

**右栏是两套东西叠在一起**：会话详情（工具输入/输出检查器）+ 可扩展的停靠面板体系。

### 4.1 会话详情（195 包口径可证）

| 能力 | 说明 | 证据 |
|---|---|---|
| Details 工具详情 | 文案 `详情`、`关闭详情`、`点击消息流中的工具行查看详情`、`该调用不在当前窗口内`、`输入`、`输出`、`运行中…` | `dsh-client-ui-conversation/lib/client.js:6047-6053` |
| 装配缺陷 | README 记录：装配后**没有打开入口** | `dsh-client-ui-conversation/README.md:60` |

### 4.2 停靠面板（**按桌面 asar 口径**，见 §9.3）

| 面板 | 能力 | 包 |
|---|---|---|
| 停靠面板本体 | 分割树 / 浮动面板 / 停靠区 / 标签条；真实 API `ctx.sidebarRightTabs.register` | `dsh-client-ui-sidebar-right` + 内联的 `dockkit` |
| 文档预览 | **Office / 表格 / Markdown / 代码 / 图片 / PDF / HTML** | `dsh-client-ui-sidebar-documentpreview` |
| 浏览器 | 沙箱浏览器标签 | `dsh-client-ui-sidebar-browser` |
| 终端 | 交互式 shell 标签 | `dsh-client-ui-sidebar-terminal` |
| 文件树 | 工作区文件浏览 | `dsh-client-ui-sidebar-files` |

> 这 5 个包**只存在于桌面 asar**，195 包副本里没有；且包内**不带 `.d.ts`**，故上表的字段级细节无法从类型定义取证（取证路径：`package.json` description + README + `lib/index.js`）。

---

## 5. 输入区 · Composer

### 5.1 附件（**只支持图片**）

| 项 | 值 |
|---|---|
| 入口 | 剪贴板粘贴 + **整页拖放**（`DropOverlay` 全屏提示、指针惰性、文本拖拽穿透） |
| 批量超限 | **整批拒绝**并提示命中的限制 |
| 锁定/繁忙 | blocked 并拒绝 |
| 单条消息图片数 | `MAX_IMAGES_PER_MESSAGE=20` |
| 单条消息总字节 | `MAX_MESSAGE_IMAGE_BYTES=104857600` |
| 单图字节 | `MAX_IMAGE_BYTES=5MiB` |
| 单图像素 | `MAX_IMAGE_PIXELS=40,000,000` |
| 类型 | 仅 PNG / JPG / WebP / GIF |
| 错误码 | `TOO_MANY_IMAGES` / `IMAGES_TOO_LARGE` |

### 5.2 触发菜单（`/` 与 `@`）

| 触发 | 源 | order | 说明 |
|---|---|---|---|
| `/` | `command` | — | 宿主命令目录（支持 matchSpace / matchEnter / warm） |
| `/` | `skill` | 2 | 技能；**非模型可调用**的标 `仅用户` |
| `@` | `cordis` | 1 | 动态 Cordis 插件 id |
| `@` | `subagent` | — | **仅正在运行的直接子代理** displayTitle |

分组标题：`命令` / `技能` / `子智能体`。渲染进 `conversation.input.overlay`。
**没有文件 @ 提及源**（相关包不存在 → 待确认）。证据：`dsh-client-ui-input-trigger`。

### 5.3 斜杠命令（**全部只有 6 条**）

| 命令 | 参数 | 说明 |
|---|---|---|
| `/compact` | — | 压缩历史 |
| `/goal` | `[<objective>\|clear\|edit <objective>\|pause\|resume]` | 目标管理 |
| `/feedback` | `<text>` | `recordInput:false` |
| `/plan` | `[off\|message]` | plan mode 开关 |
| `/permission` | `<preset>` | 切换权限档 |
| `/export` | — | 导出 Session log ZIP，**不接受路径** |

- 解析器：`/^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u`。
- **命令永不进模型历史**。
- `/model`、`/clear`、`/new`、`/help`、`/resume` **未注册**；`/model` 与 `/permission` 只是宿主命令上的 **popupSelect 装饰**（`ctx.commandUi.decorate`）。

### 5.4 键盘

| 按键 | 行为 |
|---|---|
| Shift+Enter | **恒为换行** |
| ↑ / ↓ / Enter / Escape | 交给 `arbitrate('up'\|'down'\|'enter'\|'escape')` |
| Cmd/Ctrl+Z / Shift+Cmd/Ctrl+Z / Cmd/Ctrl+Y | undo / redo |
| 空格 | `keyboard.space()` |
| Cmd/Ctrl+Enter | `steerQueue()` 或提交 |

输入法守卫：`composingRef.current || isComposing || keyCode === 229`。
**没有命令面板（无 Ctrl+K）**：全包搜索 `shortcut|keybind|hotkey` 零命中，也没有 keybinding 表。
证据：`dsh-client-ui-conversation/lib/client.js:3495-3542`。

### 5.5 繁忙时的 Enter 行为（可配置）

- `ui-conversation.busyEnter ∈ {queue, steer}`，默认 `queue`。
- 文案：`繁忙时 Enter 键行为` / `排队发送` / `插话发送`。

---

## 6. 权限、审批与沙箱（**安全模型**）

### 6.1 三个沙箱档

| 档位 | 允许范围 | 证据 |
|---|---|---|
| `read-only` | 只允许 `/dev/null` 等必需 sink | `dsh-sandbox/lib/types/index.d.ts:14-21` |
| `workspace-write` | 追加工作区与后端临时区 | 同上 |
| `danger-full-access` | 绕过限制 | 同上 |

- 包默认 `read-only`（fail-safe）；随附部署覆写为 `mode: DSH_PERMISSION_MODE ?? 'workspace-write'`（`dsh-sandbox-policy/lib/types/index.d.ts:37-45`、`dsh-base/cordis.patch.yml:175-176`）。
- 生效优先级：**已批准显式 override > 会话最后一次 `sandbox/mode` 事件 > 部署默认**。
- 只能变宽：`read-only → [workspace-write, danger-full-access]`。
- 后端：Linux `bwrap`→Landlock、macOS Seatbelt、**Windows ACL restricted-token**。
- 强制完整度：`SandboxEnforcement='full'|'partial'`（**Windows ACL 与旧 Landlock 为 `partial`**）。
- **网络与进程可见性不在这个词汇内**。

### 6.2 审批策略（只有两档）

| 策略 | 注入模型的原文 |
|---|---|
| `ask` | `Approval policy: ask. …without an available answerer, the request fails closed.` |
| `never` | `Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set sandbox_permissions).` |

- `approval/policy` 是 **log-only 事件**；`never` 直接自动拒绝。
- 结果词汇：`allowed-once` / `rejected` / `cancelled` / `unavailable`；**客户端只能发前两者**。
- **无 allow-always、无记住规则、无授权存储**。
- 请求**不携带工具参数**（只有工具名、理由、可选 callId）。
- 证据：`dsh-user-approval/README.md:26,32`。

### 6.3 审批 UI

- `ApprovalPanel` 在等待期间**接管 composer**：琥珀条 + 理由标题 + **配对的命令行** + `拒绝` / `允许一次`。
- `PendingApproval { key, toolName, reason, callId, answer('allowed-once'|'rejected') }`。
- 无持久授权控件。

### 6.4 权限预设（**只有三条**）

| 预设 | 组合 |
|---|---|
| `read-only` | (read-only, ask) |
| `workspace-write` | (workspace-write, ask) |
| `danger-full-access` | (danger-full-access, never) |

- 另有只能推导、不可选的 `custom`。
- **没有** plan / default / yolo / accept-edits / bypass 预设。
- UI 上 `danger-full-access` 显示为 `Full access`，选中前强制风险确认：`确认启用 Full access？` + `我已了解风险，并愿意继续` + `取消` / `启用 Full access`。
- 设置命名空间是 **`permission`**、字段 **`defaultPreset`**（README 写的 `permissionPresets` 与代码不符）。
- 证据：`dsh-base/cordis.patch.yml:196-205`。

---

## 7. 模型、预设与会话生命周期

### 7.1 模型选择

| 项 | 说明 |
|---|---|
| 两个入口 | `/model` popupSelect **与** composer 的 `conversation.input.model` 座位，共享 per-session `ModelDirectory` |
| 读写 | 读 `session.models`、写 `session.selectModel` |
| 菜单两级 | 模型（按 provider 分组）→ 推理等级（effort 名/描述/默认由所选模型提供） |
| 契约 | `ModelSelection { provider: string; model: string; reasoningEffort?: string }` —— **camelCase**，不是 `reasoning_effort` |
| 会话模型 | `SessionModels { current, routable, groups, failures }`；`routable` **刻意不可由 groups 推导** |
| 不可用时 | `routable===false` → composer 惰性 + 提示 `当前模型不可用，请先选择模型` |

### 7.2 推理等级（effort）

| 适配器 | 取值 |
|---|---|
| DeepSeek | `off \| low \| high \| max`（`off` 不上线） |
| pi-ai 规范集 | `off \| minimal \| low \| medium \| high \| xhigh \| max` |

持久化命名空间 `agent-default-model`，字段 `provider` / `model` / `reasoningEffort?`。

### 7.3 Provider

| provider | 说明 |
|---|---|
| `deepseek-official` | `dsh-llm-deepseek`；`DEEPSEEK_API_KEY`、`https://api.deepseek.com`、`defaultContextWindow=1000000`、默认模型 `deepseek-v4-flash` / `deepseek-v4-pro` |
| `dsh-llm-pi-ai` | 默认休眠零路由；需在设置里配 `llm-pi-ai: providers.<route>`；`openai-codex` 是唯一仅 OAuth 的 |

- 凭据视图：`CredentialView {configured, source?, writable}`，source ∈ `env` / `file` / `project-env` / `user-env`。
- 优先级：**env（只读，最高）> `$DSH_HOME/.credentials.yaml` > cwd `.env` > `$DSH_HOME/.env`**。
- Models 页只让填**单个 API key**（写 `credentials.set`，文件名不落 key）。
- `自定义设置` 折叠含 baseURL / model 目录 / 协议；容量接受 `256K` / `1M`。
- `获取可用模型` 调 `llm.discoverModels`；`添加自定义 provider` 只写进 `llm-pi-ai`。

### 7.4 运行模式

- 只有**普通轮次**与 **plan mode**；**无 debug 模式**（待确认）。
- plan mode 是**软引导**，进入/退出用 `/plan [message]` 与保留参数 `off`。
- 审阅出口是始终注册的 `exit_plan_mode`：**只有经 `ctx.userQuestions` 精确批准才退出**，驳回则留在 plan mode。
- 审阅面板文案：`计划待审` / `确认执行` / `拒绝` / `去聊天里说`。

### 7.5 Agent preset（内置 4 个）

| id | 名称 | order |
|---|---|---|
| `standard` | 标准模式 | 1 |
| `code` | PTC 模式 | 2 |
| `minimal` | 极简模式 | 3 |
| `cordis` | 创造模式 | 4 |

- 每个 preset 就是一份 `agent.cordis.yml`（工具 / 提示词 / 委派后端）。
- 命名空间 `agent-presets` 字段 `default`。
- **会话 preset 创建时固定**，之后切换返回 `agent-preset-locked`。
- 编辑器**只能复制**，内置 preset 只读查看。

### 7.6 工具呈现模式（native / code / both）

| 模式 | 含义 |
|---|---|
| `native` | 暴露全部工具 schema（默认） |
| `code` | 只暴露 `run_code` + 生成式 TS SDK，即 **PTC**；需宿主有 `ctx.codeRuntime` |
| `both` | 两者都给 |

证据：`dsh-agent-tool-presentation`、`dsh-tools` 行字段 `mode`（默认 `native`）、`ctx.tools.presentAs(mode)`。

### 7.7 会话生命周期

| 能力 | 状态 |
|---|---|
| 新建（复用或新建该工作区空白会话） | ✅ |
| 打开 / 重命名 / fork / 归档 | ✅ |
| 工作区增删改排序、会话在工作区内排序 | ✅ |
| 搜索（本地 + 内容） | ✅ |
| `/compact` 与自动 compaction | ✅ |
| `/export`（Session log ZIP，**含子会话与附件**） | ✅ |
| 统计与投影（`sessionStats`、`turnOutline`、`contextPressure`、`contextBreakdown`、`tokenUsage`） | ✅ |
| 消息反馈 Like/Dislike + 备注（`maxNoteBytes=8192`） | ✅ |
| **Session 删除 / 取消归档** | ❌ |
| **独立全文检索页 / Markdown 导出** | ❌ |

桌面 patch 另声明 `dsh-host-open-in-app` + `dsh-client-ui-open-in-app`：Session 头部 `Open In…` 分体按钮，**仅当宿主能解析到应用时渲染**。

---

## 8. 多智能体、后台任务与工作流

### 8.1 子代理（subagent）

| 项 | 说明 |
|---|---|
| 目录树 | 座位 `.session.header.actions`，id `subagent-catalog`，可懒展开 |
| 选中动作 | `SessionRuntime.openSubagent({parentSessionId, childSessionId, mode})` |
| 模式标签 | `一次性` / `可继续` |
| 只读提示 | `一次性子代理记录`、`此子代理暂时只读` |
| 侧栏 | **子代理源会话在侧栏隐藏** |
| 模型侧工具 | `subagent`、`subagent_fork`、`send_message`、`interrupt_agent`、`list_agents`（`scope: children\|descendants`）、子→父 `report` |

### 8.2 后台任务（jobs）

| 项 | 说明 |
|---|---|
| 座位 | header 动作 id `job-list`，徽标计数 running + stopping |
| 状态 | `运行中` / `正在停止` / `已完成` / `已取消` / `已失败` |
| **限制** | **行只读，UI 不能 kill** |
| 模型工具 | `job_output` / `job_list` / `job_kill` |

### 8.3 工作流（workflow）

- 模型侧工具 `workflow`：**JS 脚本编排子代理**，UI 节点 `workflow-run`。
- 成员状态：`运行中` / `已完成` / `失败` / `已取消` / `已中断`。

### 8.4 Agent Teams（**桌面端有，但不在 195 包口径内**）

- **195 包口径**：全量零命中 —— 没有 teams / teammates / task board。
- **桌面 asar 口径**：存在 `dsh-experimental-client-ui-agent-team` 包（属实验特性目录），即 Teams（`spawn_teammate` / `team_task_*` / `wait_agent`）**确实随桌面端发布**，只是默认不在 `standard` 预设里。

**对手机端的含义**：多智能体面板的**对标对象优先是 §8.1–8.3**（子代理目录树 / 作业列表 / 工作流运行），Teams 属实验层，不建议手机端先做。

### 8.5 图像生成（**桌面端没有**）

`generate_image` / `edit_image` / `view_canvas` / `canvas_selection` 在桌面 asar **全扫 0 命中**。图像生成是**本会话宿主环境（DSH 桌面 App 的插件层）**提供的能力，不是 DSH 桌面端产品功能 —— 手机端不要把「生成图片」当成要对标的能力。

---

## 9. 设置、本地化与插件

### 9.1 设置面板分节

| 分节 | order | 行 |
|---|---|---|
| `general` | 0 | `agent-preset`(-25)、`permission`(-20)、`language`(0)、`appearance`(10)、`composer-enter`(20) |
| `models` | 10 | API key / 自定义设置 / 获取可用模型 / 添加自定义 provider |
| `plugins` | 15 | 页签 `configurable`(0) `插件配置`、`all`(10) `插件列表` |
| `agent-presets` | 20 | preset 列表（只读查看 + 复制） |

- Onboarding：`welcome-notice`(-100)、`deepseek-official`(0)。
- 插件配置卡**只覆盖三个**：`bash`（终端）、`agent-loop`（Agent 循环）、`web-search-deepseek`（网页搜索）。
- **Plugins 页是只读清单**：能搜索、显示 `已启用/已停用`、配置状态与 Cordis 状态（`未挂载/等待依赖/加载中/已挂载/挂载失败/卸载中`）——**没有安装/启用/禁用/移除 UI**。

### 9.2 其它设置相关

| 项 | 命名空间 / 取值 |
|---|---|
| 外观 | `ui-theme.preference ∈ {light, dark, system}` |
| 语言 | `locale.preference ∈ {zh, en}` |
| 权限 | `permission.defaultPreset` |
| 默认 preset | `agent-presets.default` |
| 默认模型 | `agent-default-model.{provider, model, reasoningEffort}` |
| 繁忙 Enter | `ui-conversation.busyEnter ∈ {queue, steer}` |

- 本地化：**仅 `zh` 与 `en`**，无地区子标签；查找链 `ns → common → zh → key`；字典注册为 ns×locale 全双语校验；`locale/change` 事件。
- 已知缺陷：注册表持有的文案（如 `/model` 命令描述）在重注册前**不随语言切换**。
- 限制：**非 loopback 远程浏览器完全拿不到持久设置**；一次写只允许一个字段。
- **没有**：skills 设置页、MCP 设置面、遥测设置页、沙箱/审批独立设置页。

### 9.3 ⚠️ 版本差异（**不要混淆两套包**）

桌面 asar 共 **289** 个 `@deepseek-ai` 包（`sharedPackages` 列 287），195 包副本 = 195：**仅 asar 有 107 个（其中 104 个是 `dsh-*`），仅副本有 13 个**。

| | 桌面 asar 版 | 195 包 bundle |
|---|---|---|
| `dsh-client-ui-sidebar-*` 5 包 | **实际存在** | 无 |
| `dsh-tool-present` | **有**（presets 已挂载） | 无 |
| `dsh-experimental-client-ui-agent-team` | **有** | 无 |
| `dsh-client-ui-dockkit` | 无包目录，但**代码内联进前端 bundle** | 无 |
| `dsh-session-turn-outline` | 有 | 无 |
| `dsh-api-workspace-files` / `-terminal-controller` / `-settings-controller` | 有 | 无 |
| `dsh-office-to-pdf` | 有 | 无 |
| `dsh-host-open-in-app` / `dsh-client-ui-open-in-app` | 有 | 无 |
| `dsh-client-ui-brand-official` | 有 | 无 |
| `DSH_TOOLS_MODE` 环境缝 | 有 | **无** |
| `generate_image` / `edit_image` / `view_canvas` | **无（0 命中）** | 无 |
| `dsh-agent-presets` 与 4 份 preset | — | 有 |

**asar 复取证的三处关键纠正**（此前以 195 包口径推断有误）：

1. **包名是 `dsh-client-ui-sidebar-<X>`，不是 `dsh-client-ui-sidebar-right-<X>`**。5 个包全部实际存在（版本 `0.2.0-rc.2`），路径 `asar:/dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar{,-documentpreview,-browser,-terminal,-files}/`（各 7–9 个文件）。**五个包内都没有 `.d.ts`**（`files` 声明了 `lib/types/**/*.d.ts` 但 asar 内不存在），故 §4 的右栏能力需按下面重写。
2. **`dockkit` 不是缺包**：`dsh-client-ui-dockkit` 无独立目录，但 `asar:/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-5SrrfWpU.js`（633,282 B）内有 **68 处 `dockkit`**，含完整分割树/浮动面板实现（`data-dockkit-pane/-split/-divider/-float/-dock-zone/-strip`）；`dsh-web-frontend/package.json:48` 声明它是构建依赖 —— 被 Vite 内联了。真实 API 是 **`ctx.sidebarRightTabs.register`**（不是 `registerTab`）。
3. **`present` 工具存在，`generate_image` 系不存在**（见 §10.1）。

**因此 §4 右栏能力应按 asar 口径修正为**（结论来自 `package.json` description + README + `lib/index.js`）：

| 面板 | 能力 |
|---|---|
| `sidebar-right` | 右栏停靠面板本体（可扩展） |
| `sidebar-documentpreview` | 文档预览：Office / 表格 / Markdown / 代码 / 图片 / PDF / HTML |
| `sidebar-browser` | 沙箱浏览器标签 |
| `sidebar-terminal` | 交互式 shell 标签 |
| `sidebar-files` | 工作区文件树 |

**四项无法判定**（静态字节证明不了，需实际启动桌面端观测）：dockkit 的运行时 require 解析路径、桌面实际激活哪个 preset、client 插件的运行时加载链路、前端 dist 是否覆盖全部 client 包。

> **方法学警告（重要）**：早期使用的 asar 全局 grep 工具有缺陷 —— 1497 个 `unpacked:true` 节点没有 `offset` 字段，`Number(undefined)→NaN` 污染了排序比较器，二分查找会把命中归错文件；它曾**漏报** `presets/*.patch.yml` 里的 `dsh-tool-present`，足以把结论从「有」翻成「无」。已重写为 `D:\Workspace\dsh_android\.probe\agrep2.mjs`（分离 packed/unpacked，报告 `packedRaw/owned/orphan`，使「真 0」与「归因失败」可区分）。**凡是基于旧工具得出的计数都不可信，需重跑。**

---

## 10. 技术底座（手机端需要知道的「下面一层」）

### 10.1 工具目录（精确工具名）

| 组 | 工具 |
|---|---|
| 命令执行 | `bash`、`pwsh`（另有 `bash-persistent`） |
| 文件 | `read`、`write`、`edit`、`read_image`、`str_replace_editor`（`view\|create\|str_replace\|insert`） |
| 搜索 | `glob`、`grep` |
| 后台作业 | `job_output`、`job_list`、`job_kill` |
| 目标 | `get_goal`、`create_goal`、`update_goal` |
| 计划 | `todo_write`（**每次发全量**） |
| 交互 | `ask_user_question` |
| 技能 | `skill` |
| 子代理 | `subagent`、`subagent_fork`、`send_message`、`interrupt_agent`、`list_agents`、`report` |
| 网络 | `web_search`、`web_fetch` |
| 编排 | `workflow`、`ralph` |
| Cordis | `cordis_inspect_list`、`cordis_inspect_query`、`cordis_inspect_self`、`cordis_define`、`cordis_run`、`cordis_stop`、`cordis_undefine` |
| 计划模式 | `exit_plan_mode` |
| 定时 | `schedule_create`、`schedule_list`、`schedule_delete`（standard preset **未挂载**） |

**不存在**（195 包口径）：`ssh_exec`/`ssh_list`/`ssh_tunnel`、`generate_image`、`edit_image`、`view_canvas`、`run_code`。

**asar 口径修正（见 §9.3 复取证）**：
- `present` **存在** —— 注册点 `asar:/dsh/node_modules/@deepseek-ai/dsh-tool-present/lib/index.js:23-24`，挂载行 `asar:/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml:142-143`（另见 `ptc.patch.yml:148-149`、`cordis.patch.yml:150-151`）。
- `generate_image` / `edit_image` / `view_canvas` / `canvas_selection` 在桌面端**全扫 0 命中** —— **图像生成不属于 DSH 桌面端能力**，手机端不要对标它。

### 10.2 传输层（手机端要对接的）

| 项 | 值 |
|---|---|
| HTTP | `POST /api/<ns>/<method>`，`API_PATH="/api"` |
| WebSocket 下行 | `/api/events.mux`、`/api/events.host`（**客户端发消息视为协议违规**） |
| 文件 | `/api/file` |
| 方法总数 | **135 个方法，约 30 个命名空间** |
| 认证 | **无 TLS / 无认证**；只有 **cookie + Host 栅栏**（防 DNS rebinding 与跨站） |
| 绑定 | `host ∈ 127.0.0.1(默认) \| 0.0.0.0`；`--trusted-host` 可重复 |
| 明确声明 | `dsh-host-webserver/README.zh.md:39,113`：服务器自身**不带** TLS / 认证 / 来源策略 |

### 10.3 会话存储

- v4 **zstd 压缩 JSONL**；7 键信封；**58 种事件类型**；surface 替换语义。
- 查询引擎带 **FTS5** 全文索引；`stats` 字段；压缩词表；`storage-json`。
- 目录：`$DSH_HOME`（默认 `%USERPROFILE%\.dsh`）。

### 10.4 三种前端形态

| 形态 | 说明 |
|---|---|
| `dsh web` | 浏览器 Web GUI（本次盘点的对象） |
| `dsh-headless` | 一次性任务；`--json` 行 JSON 事件流；`--session-id` 续跑；**不开端口** |
| `dsh-sdk-app` | **stdio JSON-RPC**；`DSH_MAX_TOKENS_AS_SUCCESS` |

### 10.5 前端资源

- `dsh-web-frontend/dist`：432KB index + 727KB vendor + KaTeX 字体 + **24 个 Shiki 语法**（c/cpp/csharp/css/go/html/ini/java/kotlin/less/lua/markdown/mdx/php/python/ruby/rust/scss/sql/swift/toml/xml/yaml）。
- PWA manifest 存在，**未见 service worker**（待确认）。
- 共享原语约 70 个图标 + Button/Modal/Toast/Tooltip/Menu/Pill/HoverCard/StateDot/JsonTree/MarkdownText/DiffBlock/ReadBlock/SearchBlock/TerminalBlock/WebBlock/OnboardingSurface/RiskConfirmation。

---

## 11. 桌面端**明确没有**的能力（避免手机端照抄幻想）

| 类别 | 不存在的具体能力 |
|---|---|
| 导航 | 命令面板、快捷键表、pin/置顶 |
| 会话 | Session 删除、取消归档、独立全文检索页、Markdown 导出 |
| 消息 | 逐消息编辑 / 重试 / 删除 / 回滚 / 朗读；用户消息分支 |
| 权限 | allow-always、记住规则、授权存储 |
| 设置 | MCP 设置页、skills 设置页、遥测设置页、插件安装/卸载 UI |
| 工作台 | canvas、图像生成工作台、画廊、studio |
| 协作 | Agent Teams、teammates、task board |
| 代码 | git 工作区 diff 视图、文件树面板、浏览器标签面板 |
| 移动 | **二维码 / 配对 / 设备管理 / 深链 / 手机端 UI**（这正是本项目要补的） |
| 其它 | `DSH_TOOLS_MODE`（本 bundle）、`cost`/货币字段、底部面板 |

---

## 12. 手机端对标清单（本文档的核心产出）

图例：`✅ 已实现` / `🟡 部分` / `⬜ 待实现` / `⏸ 不做`（并注明理由）

### 12.1 骨架与导航

| # | 桌面能力 | 手机端目标 | 状态 |
|---|---|---|---|
| 1 | 三栏布局 | 底部导航 4 tab：电脑会话 / 手机任务 / 工作区 / 设置 | ⬜ |
| 2 | 会话列表（分组 + 状态点 + 相对时间） | 首页平铺列表 + 状态芯片（运行中/可续聊/只读） | ⬜ |
| 3 | 四种运行状态语义 | 同一套语义：**琥珀=等你响应，优先级高于运行中** | ⬜ |
| 4 | 搜索（本地 + 内容两级） | 先做标题本地过滤，内容搜索接网关 | ⬜ |
| 5 | 会话行操作 Rename/Fork/Archive | 长按菜单；**不做 Delete**（对齐桌面） | ⬜ |

### 12.2 会话视图（**最高价值**）

| # | 桌面能力 | 手机端目标 | 状态 |
|---|---|---|---|
| 6 | 两个页签 对话 / 轨迹 | 顶部分段控件原地切换，不跳页 | ⬜ |
| 7 | 消息流 15 种节点 | 至少覆盖：user / assistant-step / tool-call / turn-error / compaction / workflow-run | ⬜ |
| 8 | 思考默认折叠披露行 | 可折叠「思考 · 1.2s」行 | ⬜ |
| 9 | 工具调用递归树 + 7 种变体 | 工具卡带彩色左沿 + 可折叠输出 | ⬜ |
| 10 | DiffBlock（`+/−`、`⋯`、`└ +A -R`） | 等宽 + 深绿/深红底色 + `+A −R` 统计 | ⬜ |
| 11 | TerminalBlock（非模拟器，保留 SGR） | 只回显，不解析光标控制 | ⬜ |
| 12 | 无光标指示，靠 shimmer 表达流式 | **照抄**：去掉 typing 光标，用微动效 | ⬜ |
| 13 | 自动滚动阈值 25px + 「回到底部」 | 同阈值同按钮 | ⬜ |
| 14 | 消息级 Copy / Branch / Feedback | 先做 Copy + Branch（仅在已完成轮次） | ⬜ |
| 15 | `Ran for … · TTFT … · tok/s` | 回合尾统计行 | ⬜ |
| 16 | StatsLine + ContextMeter | 顶部/底部统计条 + 上下文占用环 | ⬜ |
| 17 | TodoPanel / GoalBar / Plan 芯片 | 输入坞上方三类胶囊，可展开 | ⬜ |
| 18 | 审批面板（等待时**接管输入框**） | **同等重要**：手机端审批是杀手级场景 | ⬜ |

### 12.3 手机端独有（桌面没有，是本项目要补的）

> 状态列 = **手机端当前实现进度**（依据 `android/` 源码盘点，非本文档推断）。

| # | 能力 | 说明 | 手机端进度 |
|---|---|---|---|
| 19 | 配对（6 位码）与设备管理 | 桌面端完全没有，本项目自建 | ✅ 已有 PairingScreen |
| 20 | 中继连接与隧道状态 | 桌面端无此概念 | ✅ 已有 EventStream + 连接 banner |
| 21 | 手机任务（下发 + 历史） | 桌面端只有会话，无「任务」抽象 | 🟡 有 `TAB_PHONE`「手机任务」页与会话详情；**移动端看不到任务历史** |
| 22 | 后台常驻（前台服务） | 桌面端是常驻进程，天然没有 | ✅ 已有 `service/RelayForegroundService.kt` |
| 23 | 离线/弱网降级 | 桌面端本地无此需求 | ⬜ 未做 |

### 12.4 取舍原则

1. **对齐语义，不照抄布局**：状态点四态、审批优先级、流式无光标，这三条语义必须逐字一致；三栏/悬浮面板之类布局按手机重做。
2. **读多写少**：手机端优先做「看」——会话列表、轨迹、diff、统计；「写」只保留发消息 + 审批 + 停止。
3. **权限不由手机指定**：电脑端会话的权限档跟随**电脑端自己的** `DSH_PERMISSION_MODE`，手机端**不提供**权限切换（与 v2.5.0 裁定一致）。
4. **不做**：git diff 视图（桌面都没有）、文件树（桌面都没有）、canvas（桌面都没有）——除非另有需求。
5. **审批不可代答时要显式告知**：电脑端会话在需要人工审批且手机无法代答时，UI 必须明说，不能静默卡住。

---

## 13. 建议的实现批次（手机端）

| 批次 | 内容 | 对应本节条目 | 验收 |
|---|---|---|---|
| B1 | 底部导航 + 会话列表 + 四种状态点 + 搜索（本地） | 1–4 | 能列出电脑端会话并按状态排序 |
| B2 | 会话详情：消息流（user/assistant/tool-call）+ 折叠思考 + 自动滚动 | 6–9、13 | 打开会话能连续读完一轮 |
| B3 | diff / 终端回显 / Todo / Goal / 统计条 | 10–12、15–17 | 工具卡信息完整可折叠 |
| B4 | 输入坞：发消息 + 附件（图片）+ 停止 | 18 | 能真实续聊并看到流式回传 |
| B5 | 审批面板（接管输入框）+ 轨迹页签 | 18、6 | 审批能在手机上完成；轨迹可总览 |
| B6 | 手机任务 / 工作区 / 设置三页补齐 | 19–23 | 与文档 04-验收 口径一致 |

---

## 14. 附：原型图

手机端高保真原型 **6 张，1080×2340**，由 Pillow 脚本精确渲染（不用 AI 生图 —— 生图模型渲染中文与代码会出错字，无法作为实现基线）。

**当前位置**：`D:\Workspace\dsh_android\.proto-out\`（暂存目录）
**设计说明与复现方法**：[原型/README.md](原型/README.md)（渲染脚本在同目录）

| 文件 | 页面 | 对标功能 |
|---|---|---|
| `01-电脑会话.png` | 会话列表首页 | §2 左栏 |
| `02-会话详情.png` | 对话流 + 工具卡 + diff | §3 中栏 |
| `03-执行轨迹.png` | 轨迹台账 | §3.1 轨迹页签 |
| `04-手机任务.png` | 手机任务列表 | §12.3-21 |
| `05-工作区.png` | 工作区 + git + diff | §12.3-19 |
| `06-设置.png` | 分组设置页 | §9 |

> **为什么没放进本目录**：本会话的文件沙箱**拒绝向 `docs\01-设计\原型\` 写入二进制文件**（`PermissionError [Errno 13]`；文本文件可写，PNG 不可写）。已按 `diagnose-windows-sandbox-acl` 技能修好该目录的 ACL 并验证通过（`writeOwner: false → true`，报告 `.runtime\acl-repair\acl-report-bf22623d9a214477873a88f4f86cc574.jsonl`），但仍被沙箱拦下 —— 属会话写权限边界，不是文件权限缺陷。
> **搬进本目录的方式**（任选其一）：① 切到「完全权限」后执行
> `Copy-Item 'D:\Workspace\dsh_android\.proto-out\0*.png' 'D:\Workspace\dsh_android\docs\01-设计\原型\'`；
> ② 手工拖拽。
> 图本身可直接在 `.proto-out\` 打开，不影响使用。

---

## 15. 参考

| 文档 | 用途 |
|---|---|
| [协议契约-v2.md](协议契约-v2.md) | 手机端对接的**唯一事实源**（`X-Api-Version: 2`） |
| [概要设计.md](概要设计.md) | 组件边界、时序、落盘位置 |
| [需求规格说明书.md](../00-需求/需求规格说明书.md) | FR-xx / NFR-xx |
| [原型/README.md](原型/README.md) | 设计系统令牌与原型复现方法 |
