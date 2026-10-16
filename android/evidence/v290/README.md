# v2.9.0 真机证据（对话内图片 + 轮次导航 + 会话列表状态语言）

设备：`emulator-5554`（1080×2340，Android 14 / API 34，`sdk_gphone64_x86_64`）
包名：`com.deepseek.dshremote.debug`
APK：`android/app/build/outputs/apk/debug/app-debug.apk`（`versionCode=11 versionName=2.9.0`）
网关：本机 live-env 实例（`127.0.0.1:18087`，中继 `ws://127.0.0.1:9700`），`gatewayVersion=2.9.0`、
`capabilities` 含 `attachments` 与 `session.turnIndex`。

## 文件清单

| 文件 | 看什么 |
|---|---|
| `01-list.png` | 会话列表新状态语言：全文没有「可续聊」；35 行里恰好 1 行带「运行中」胶囊 |
| `02-list-fresh-status.png`、`03-list-with-live-chip.png` | 刷新前后（缓存渲染时**有意不显示**「运行中」，见 `SessionStatus.resolve(stale=true)`） |
| `04-scrolled.png` | 滚动后：手机发起的会话带极轻「手机」胶囊（`优化手机端 App 界面`），普通可写会话**什么都不画** |
| `05-detail-conversation.png` | **失败样本（环境接错）**：App 当时连的是生产网关（2.2.0，无 `attachments`），同一会话没有任何缩略图 |
| `06-detail-inline-image.png` | 单图轮次：缩略图在用户气泡上方（`1000000051.png`，1080×2340） |
| `07-detail-inline-two-images.png` | 助手正文下的内联截图（来自 `read_image` 结果投影） |
| `08-detail-two-image-turn.png` | 两图并排方格（`e2e-64.png` + `e2e-1400x1000.png`）+ 「2 次工具调用 · read_image×2 · 全部成功 · 5.3s」 |
| `09-image-viewer.png`、`09b-image-viewer-page2.png` | 全屏查看器：`1 / 2` → 左右滑动 → `2 / 2`，底部 `64×64 · 6 KB · png · 左右滑动切换` |
| `10-turn-nav-sheet.png` | 轮次面板：`轮次导航 / 共 4 轮`，行按轮号**倒序**（5、4、3、1 —— 该会话第 2 轮没有用户消息） |
| `11-turn-jump-highlight.png` | 点第 1 轮后滚到该轮并整轮高亮（`DshPrimary.copy(alpha=0.08f)` + 0.5dp 描边） |
| `12-turn-nav-current-fixed.png` | **修复后**：「当前」标在**第 5 轮**（修复前错标第 4 轮，因为客户端拿"轮数"当"轮号"） |
| `13-turn-nav-clean-preview.png` | 预览清洗中间态（竖线已去、`--- --- ---` 还在） |
| `14-turn-nav-preview-dashes-gone.png` | **最终态**：第 1 轮预览 = `两张图已用 read_image 读取，结果（均为归一化副本，image/png）： 文件 尺寸 字节数 e2e-64.png …` |
| `*.xml` | 对应时刻的 `uiautomator dump` 语义树（断言以它为准） |
| `capture.ps1` | 取证工具库（见下） |

## 复现步骤

```powershell
# 1) 网关：必须是带本轮能力的实例（health.capabilities 含 attachments / session.turnIndex）
& .\scripts\start-live-env.ps1            # 或 node tools\dsh-remote\gateway.mjs serve --config .runtime\live-env\config.json --home .runtime\live-env

# 2) 装 APK
adb install -r android\app\build\outputs\apk\debug\app-debug.apk

# 3) 配对（extras 只影响"填入示例（debug）"的默认值，不影响配对流程）
node tools\dsh-remote\gateway.mjs pair --port 18087      # 取 6 位配对码
adb shell pm clear com.deepseek.dshremote.debug
adb shell am start -W -n com.deepseek.dshremote.debug/com.deepseek.dshremote.MainActivity `
  --es dsh_relay_url ws://10.0.2.2:9700 --es dsh_pair_code <配对码>
#    然后在配对页：点「填入示例（debug）」→ 点「配对并连接」→ 允许通知权限
#    成功后列表副标题变「活动环境台式机 · 已连接」

# 4) 截图 + 语义树（必须用 capture.ps1 的 Shot；直接 screencap 会被 PowerShell 重定向写坏）
cd android\evidence\v290
. .\capture.ps1
Shot -Name 'my-shot' -Tries 4 -GapSeconds 6
Get-UiTexts -Tag 'my-dump'
```

`capture.ps1` 提供 `Get-UiXml / Get-UiTexts / Get-UiDescs / Find-Node / Tap-Node / Tap-Xy / Swipe / Wait-Frame / Shot / Assert-Text`。
三个必须知道的坑（脚本里都已规避，改脚本时别绕回去）：

1. `Invoke-Adb` **只接受一个字符串**再 `-split ' '`：把 adb 参数写成 PowerShell 数组时，`-p` 会被当成 PowerShell 自己的参数名，
   报 `A parameter cannot be found that matches parameter name 'p'`，而且 screencap 静默不执行（截图根本不是新拍的）。
2. 脚本**必须保持 ASCII**：Windows PowerShell 5.1 对无 BOM 的 `.ps1` 按 ANSI 解码，中文会被写坏成语法错误。
3. `2>&1 | Out-Null` 配上 `$ErrorActionPreference='Stop'` 会把 adb 的 stderr 变成终止错误（脚本内部临时改 `SilentlyContinue`）。

## 两条环境教训（本轮各花掉一次排查）

### 1. App 连的可能是**生产网关**，不是本机 live-env

`05-detail-conversation.png` 就是那次翻车的现场：网关 API 明明返回了 `images`，App 里却一个缩略图都没有。
根因不是代码：**模拟器 App 当时配对的是用户的生产网关**（`wss://123.207.183.237:9443` → `127.0.0.1:8787`，
`gatewayVersion=2.2.0`、`capabilities=22` 无 `attachments`），而新代码跑在本机 live-env 上；转录被 API 投影时不带图片，
App 自然没得渲染。判别方法（一分钟内可做）：

```powershell
(Invoke-RestMethod http://127.0.0.1:8787/api/v1/health).gatewayVersion          # 生产实例的版本
(Invoke-RestMethod http://127.0.0.1:18087/api/v2/health).capabilities           # live-env 是否含 attachments
adb shell "run-as com.deepseek.dshremote.debug grep -c sha256 files/console-cache/transcript-session-<id>.json"
#   0 ⇒ App 拿到的转录里根本没有图片引用（旧网关），不是渲染问题
```

另外 `scripts\start-live-env.ps1 -Pair` **不可靠**：它只要看到界面文本含「已连接」就判定成功，
会在"连的是别的网关"时假通过 —— 取证时别拿它当结论。

### 2. 模拟器渲染帧滞后可达 30 秒，语义树却即时

`logcat` 里 `EGL_emulation: app_time_stats: avg=29977.53ms`：一次 `screencap` 可能拍到几十秒前的画面。
于是会出现"`uiautomator dump` 里「运行中」胶囊在 `bounds=[699,647]-[869,702]`，截图里那块却是纯背景"的假 bug
（本轮为此白查了两轮）。规矩：**动作后等 ~15–20s，且截图必须"连续两帧 SHA256 一致"**（`Shot` 已内置）。

### 3. 带中文的 `.ps1` 必须是 **UTF-8 with BOM**，而编辑工具会悄悄去掉 BOM

`android/evidence/v2|v3|v4` 里那几个断言脚本（含 `run-ui-check.ps1`）本轮被改过之后**丢了 BOM**，
于是 `powershell -File` 直接把中文按 ANSI 解码 ⇒ 满屏 `Unexpected token '澶瑰叿宸插惔鍔?…'` 的**语法错误**，
脚本一行都没跑。修法与自检：

```powershell
$f = 'android\evidence\v2\run-ui-check.ps1'
$b = [System.IO.File]::ReadAllBytes($f)
if (-not ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)) {
    [System.IO.File]::WriteAllBytes($f, ([byte[]](0xEF,0xBB,0xBF) + $b))
}
[void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $f).Path, [ref]$null, [ref]$err); $err.Count  # 必须是 0
```

（`capture.ps1` 走的是另一条路：**整份 ASCII-only**，所以不需要 BOM。）

### 4. 配对页比一屏高，表单控件不在语义树里

`run-ui-check.ps1` 第 2 步曾整段假红（找不到「填入示例」「配对并连接」）：配对页是
「页头 + 说明 + 二维码 + 表单 + 按钮」，Compose 不会把没进视口的控件放进语义树。
脚本现在先 `Ensure-Visible '填入示例'`（向上滑最多 3 次、每次重新 dump）再取坐标。

### 5. 模拟器上的 Gmail 首次运行向导会**抢前台**

跑 `run-ui-check.ps1` 时 Gmail 的 onboarding（`You can now add all your email addresses… TAKE ME TO GMAIL`，
包名 `com.google.android.gm`——`pm list packages | grep mail` 查不到它，因为包名里没有 "mail"）会顶到前台。
脚本后续所有"按上一份 dump 坐标"的盲点就全打在别人身上：一步失败 → 级联成几十项假红（实测 40 项，
且多张截图字节数两两相同，等于屏幕根本没换）。
现在脚本每个 `Write-Step` 开头都会 `Ensure-Foreground`（`Get-ForegroundPackage` 解析 `dumpsys window` 的
`mCurrentFocus`/`mFocusedApp`，不是本包就 `am start -n <Activity>`；3 次仍失败才记一条 FAIL）。

### 6. 「工作区 → 改动」曾必崩（上一轮遗留，v2.9.0 修掉）

`IllegalStateException: Vertically scrollable component was measured with an infinity maximum height constraints`：
改动页的 `DiffPreviewCard` 把 `DiffView`（本身是 LazyColumn，`WorkspaceBits.kt:716`）塞进外层 LazyColumn 的
`item {}` 里 ⇒ 内层量到 infinity。现在预览卡走普通 `Column` + `DiffLineText`（`WorkspaceScreen.kt:644` 附近），
守卫断言是改动页出现 `@@`（只有预览卡会出现它；`diff --git` 只在点进文件的 `DiffScreen` 里）。
崩溃报告留在设备 `files/crashes/crash-*.txt`，设置页「崩溃记录」行会显示份数——修好后该行显示「无」。

### 7. release 构建会因内存不足崩 daemon

模拟器在跑时（qemu 9.5 GB / 可用 2.42 GB）`:app:assembleRelease` 在 `lintVitalAnalyzeRelease` / `mergeDexRelease`
阶段 OOM：`hs_err_pid*.log` 写 `Native memory allocation (malloc) failed to allocate 2155376 bytes.
Error detail: Chunk::new`。先 `adb emu kill`（可用内存 2.42 → 11.77 GB）再构建即可（含 lint，`BUILD SUCCESSFUL in 50s`）。
模拟器重启用 AVD 名 **`dshr_ui`**（不是 `dshr_ui5554`）：
`…\sdk\emulator\emulator.exe -avd dshr_ui -no-boot-anim -port 5554`。
另外 `-Dorg.gradle.jvmargs=…` 经 PowerShell 传参会变成 `Task '.gradle.jvmargs=…' not found`，不要这么传。

### 8. 模拟器进程会**整体消失**，后台脚本于是"卡住"

复跑 v3 时后台任务长时间不产出，`adb devices` 为空、`adb.exe: no devices/emulators found`——模拟器进程没了。
重启命令见上面第 7 条（AVD 名 `dshr_ui`），约 **25s** 后 `sys.boot_completed=1`。
教训：判断"卡住"之前先查 `adb devices`；另外后台跑脚本时 `| Select-Object -Last N` 会缓冲全部输出，
跑完才有内容，**不能**据此判断脚本卡死（要边跑边看就 `Tee-Object` 到文件再读文件）。

### 9. 「吊销设备」走的是 **v1** 路由，不是 v2

`devices` / `deviceRevoke` 只在 v1 路由表里（`tools/dsh-remote/lib/http.mjs:302-303`、
`ROUTE_METHODS.deviceRevoke=['DELETE']`、case 在 `:715`）；`DELETE /api/v2/devices/{id}` 会得
`not_found 未知接口`。正确写法 `DELETE /api/v1/devices/{tokenId}`（同一 Bearer 也能吊销别的令牌，
吊销自己后立刻 401）。另外 `/api/v1/health` 的 `capabilities` 是固定的 5 项，新能力只在 **v2** health；
`sessionsCached` 在 health **顶层**，不在 `sessionMirror` 里。

### 10. `config.json` 里的 `gatewayVersion` 会**盖住**真实版本

`C:\Users\Administrator\.dsh-remote\config.json`（无 BOM）里 `gatewayVersion` 有两处；重启后 health 报的
版本号取自它而不是代码。升级网关时**先改 config 再重启**，否则 health 会一直谎报旧版本（本轮就是
`2.2.0 → 2.9.0` 手改后才对上）。

### 11. 分页/长列表的两条**度量**口径（v4 脚本踩过）

1. **粒度别拿"一整段上拉循环前后的差"量**：`Invoke-PullToTop` 是"反复拖拽直到入口可见"的循环（最多 30 次），
   量出来的是"这段循环取了几页"。正确证据是**计数时间轴**（`Observe()` 在「已加载 X/Y」每次变化时打点，
   与夹具请求同一时基）：逐页推进 = `60→120→180→220`（每次 +≤60），一次全量 = `60→220`。
2. **轨迹页没有「已加载 X/Y 条」**：那是对话页 `conversationSubtitle` 的文案；轨迹页副标题是
   `trajectorySubtitle`（「第 1–N 轮 · 共 M 步 · K 次工具调用」）⇒ 判"切视图后计数不变"必须切回「对话」再读。
   （实现侧：`ui/components/TrajectoryList.kt:121 LoadOlderOnReachTop` 的 `userDragged` 闩锁保证
   "同一次拖拽只换一页"，由 `ui/screens/SessionDetailScreen.kt:218` 的 `DragInteraction.Start` 置位。）

## 本轮断言（可复核的文本）

- 夹具 UI 回归脚本：`android/evidence/v2/run-ui-check.ps1` → **76 / 76 全绿，exit 0**
  （报告 `android/evidence/v2/ui-check-report.txt`，2026-10-16 02:50:11；修脚本前是 42 / 82）。
- 流式 Markdown 脚本：`android/evidence/v3/run-markdown-check.ps1` → **45 / 45 全绿，exit 0**
  （报告 `android/evidence/v3/markdown-check-report.txt`）。
- 分页脚本：`android/evidence/v4/run-paging-check.ps1` → **PASS=46 FAIL=0，exit 0**
  （报告 `android/evidence/v4/paging-check-report.txt`；关键行 `A3b` 时间轴增量
  `60→120（+60），120→180（+60），180→220（+40）`、`A21` 干净序列游标 `160,100,40` 各取一次）。
- 生产网关（8787）重启后：`gatewayVersion=2.9.0`、`capabilities` 24 项含 `attachments` 与
  `session.turnIndex`、relay `homeId=home_Cp6TNTbYCZRNsYR6capUfg` 未变（手机无需重新配对）；
  `GET /api/v2/attachments/<id>` → 200 / 6443 B / `image/png` / 魔数 `89504e470d0a1a0a`。

- 会话列表：`可续聊` 计数 **0**；`运行中` 恰好 1 处，且其父节点 `content-desc="电脑端正在运行这一轮"`；
  手机发起行含「手机」；缓存渲染时（`已连 …s` 出现而 `进行中 0`）不显示「运行中」。
- 会话详情：`已加载 11/11 条`；图片节点 `content-desc` = 文件名（`e2e-64.png`、`e2e-1400x1000.png`、`1000000051.png`）。
- 轮次面板：`轮次导航`、`共 4 轮`、`当前`（在第 5 轮行）、预览无 `**`、无 `|`、无 `---`。
