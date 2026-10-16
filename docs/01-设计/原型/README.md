# 手机端高保真原型

本目录是 **DSH Remote 手机端（Android）UI 的实现基线**：像素级原型 + 可复现的渲染脚本。

原型服务于 [DSH桌面端功能文档.md](../DSH桌面端功能文档.md) 第 12 节的「手机端对标清单」——**语义对齐桌面端，布局按手机重做**。

---

## 1. 产物

> **位置说明**：6 张 PNG 当前在**暂存目录** `D:\Workspace\dsh_android\.proto-out\`，不在本目录 —— 本会话沙箱拒绝向 `docs\01-设计\原型\` 写入二进制文件（文本可写、PNG 不可写；ACL 已按 `diagnose-windows-sandbox-acl` 修好并验证 `writeOwner: false → true`，仍被沙箱拦下，属会话写权限边界）。搬进来只需一条命令（需「完全权限」或手工拖拽）：
>
> ```powershell
> Copy-Item 'D:\Workspace\dsh_android\.proto-out\0*.png' 'D:\Workspace\dsh_android\docs\01-设计\原型\'
> ```

| 文件（位于 `.proto-out\`） | 页面 | 对标桌面端能力 |
|---|---|---|
| `01-电脑会话.png` | 会话列表首页 | 功能文档 §2 左栏：工作区分组、四种状态点、搜索 |
| `02-会话详情.png` | 对话流 + 工具卡 + diff + 待办 + 警告 | §3 中栏：消息流、思考折叠、工具调用、DiffBlock |
| `03-执行轨迹.png` | 轨迹台账（含审批卡） | §3.1「轨迹」页签、§6.3 审批面板 |
| `04-手机任务.png` | 手机任务列表 | 手机端独有：任务下发与历史 |
| `05-工作区.png` | 工作区 + git 改动 + diff 预览 | 手机端独有：工作区浏览 |
| `06-设置.png` | 分组设置页 | §9 设置面板 |

规格：**1080 × 2340（xxhdpi，3x）**，PNG，深色。

---

## 2. 设计令牌（与 Android 代码同源）

**视觉方向：A「纯黑极简」**——对标 ChatGPT / Claude 现行深色语言（用户 2025-10 于三选一中选定）。
令牌取自 `android/app/src/main/java/.../ui/theme/DarkColors.kt`，**改色请先改代码再回来改脚本**。

三条配色规则（改色前先读）：

1. **底真黑、面近黑、白字**：底 `#000000`，面 `#141414` / `#1E1E1E`，正文 `#ECECEC`。
2. **强调色只出现在「可操作」与「正在发生」两类元素上**：主按钮、发送键、FAB、导航选中态、运行中指示点。其余一律灰阶。
3. **状态色是语义色，不是装饰色**：绿=成功/运行中，琥珀=等待交互/警告，红=失败，蓝=代码 hunk 头。不要把强调色当品牌底色铺开。

| 令牌 | 色值 | 用途 |
|---|---|---|
| `BG` | `#000000` | 页面底色 |
| `SURFACE` | `#141414` | 卡片 |
| `SURFACE_VAR` | `#1E1E1E` | 次级卡片 / 输入框 |
| `SURFACE_HIGH` | `#262626` | 芯片底 |
| `OUTLINE` / `HAIRLINE` | `#2A2A2A` / `#222222` | 1px 描边 / 分隔线 |
| `PRIMARY` | `#D97757` | 强调色（选中、发送、FAB、进度） |
| `PRIMARY_CTN` | `#3A2318` | 用户气泡底 |
| `ON_BG` | `#ECECEC` | 主文字 |
| `ON_VAR` | `#9A9A9A` | 次文字 |
| `NEUTRAL` | `#8A8A8A` | 中性图标（思考/读取/检索） |
| `LIVE` / `SUCCESS` | `#4CC38A` | 在线 / 成功 / 可续聊 |
| `WARNING` | `#E0A15C` | **等待你响应**（优先级高于运行中）/ 警告 |
| `ERROR` | `#FF5A52` | 失败 / 停止 |
| `ADD_BG` / `ADD_FG` | `#0F2818` / `#7EE2A8` | diff 增行底 / 增行字 |
| `DEL_BG` / `DEL_FG` | `#33191A` / `#FF9A9A` | diff 删行底 / 删行字 |
| `HUNK` | `#6FA8FF` | diff hunk 头 / 重命名徽标 |

字体：中文 **微软雅黑 / 思源黑体**；代码 **Consolas**。
栅格：屏幕左右边距 20dp；卡片圆角 16–18dp；芯片圆角全圆；纵向节奏 8dp。

---

## 3. 复现方式

原型由 Pillow 脚本直接绘制（**不用 AI 生图**：生图模型渲染中文与代码会出错字，无法作为实现基线）。

```powershell
# Python 解释器（本机 DSH 自带，含 Pillow / numpy）
$py = "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"

# 产物先落 ASCII 路径（含中文的目标目录在沙箱下可能写入被拒），再手工搬进本目录
$env:PROTO_OUT = "D:\Workspace\dsh_android\.proto-out"

& $py .\gen_01_home.py        # 01 电脑会话
& $py .\gen_02_detail.py      # 02 会话详情
& $py .\gen_03_trajectory.py  # 03 执行轨迹
& $py .\gen_04_tasks.py       # 04 手机任务
& $py .\gen_05_workspace.py   # 05 工作区
& $py .\gen_06_settings.py    # 06 设置
```

| 脚本 | 作用 |
|---|---|
| `proto_kit.py` | 设计令牌 + 绘制原语（`canvas` / `card` / `chip` / `text` / `rrect` / `hline` / `diff_row` / `navbar` / `composer` …） |
| `icons.py` | 24 个矢量图标（矢量重绘，不依赖图标字体） |
| `gen_0*.py` | 6 张页面各自一份，互不依赖 |
| `crop_check.py` | 全分辨率抽检：`python crop_check.py <png> <y0> <y1> [out.png]`，用于确认文字/卡片真的画上去了（缩略图看不清会造成误判） |

> **验证要求**：每次改完脚本必须用 `crop_check.py` 抽检关键区域（尤其是含中文与 diff 的区域），**只看缩略图不算验收**。

---

## 4. 与实现的关系

- 原型里的**文案、字段、状态值都取自真实数据模型**（`Session` / `Turn` / `ToolCall` / `Task` 等 Kotlin 数据类），不是占位符。
- 原型里的**交互语义**必须逐字落地，尤其是三条：
  1. **琥珀色 = 等待你响应，优先级高于「运行中」**；
  2. **流式不用打字光标**，用微动效（桌面端同款做法）；
  3. **审批卡在等待时接管输入区**，不做成一条普通消息。
- 原型是**设计基线不是像素契约**：若实现时发现字段缺失，改数据模型再说，不要偷偷删掉卡片上的字段。
