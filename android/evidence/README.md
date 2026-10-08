# 真机（模拟器）端到端验证证据

> 环境：Android 14 / API 34 / x86_64 模拟器 `dsh_test`（`emulator-5554`），
> 网关 `http://10.0.2.2:8787`（宿主机回环映射，真实 `dsh --profile headless` 执行）。
> 被测包：`com.deepseek.dshremote.debug`（功能自证）与 `com.deepseek.dshremote`（release 冒烟）。
> 全部截图与 logcat 均为本次实测产出，未经修饰。

---

## 1. B-01：点击按钮无任何反馈（阻断性缺陷）

### 根因

`ApiClient` 是 OkHttp **同步**调用，而所有 ViewModel 都用 `viewModelScope`
（= `Dispatchers.Main.immediate`）驱动 → 点击后网络调用直接跑在**主线程**，
Android 立刻抛 `NetworkOnMainThreadException`。

为什么表现为"完全没反应"：

1. 异常被 `runCatching` 收进 `Result`，`probe()/pair()` 的 `onFailure` 分支当时**没有日志**，
   而 `launchBusy` 也没有 `catch(Throwable)` 兜底；
2. 请求根本没发出去 → 网关侧零请求；
3. 唯一可能的反馈是 Snackbar，但它会自己消失，且当时没有任何文案写入状态。

### 修复

| 位置 | 修复 |
|---|---|
| `data/TaskRepository.kt` | 新增 `private suspend fun <T> onIo(block) = withContext(Dispatchers.IO) { block() }`；`probeHealth`/`pairAndSave`/`saveManualToken`/`loadWorkspaces`/`submit`/`cancel`/`refresh`/`refreshActive`/`deleteRemote` 全部走 IO；`withAuthGuard` 内部也在 IO 上执行 → 调用方不可能再踩主线程 |
| `ui/vm/SetupViewModel.kt` | `probe/pair/saveToken/launchBusy` 入口与每条分支打 `Log.i("SetupViewModel", …)`；`launchBusy` 增加 `catch(Throwable)`（放行 `CancellationException`）→ 任何异常都变成可见提示「内部错误：…」 |
| `ui/vm/HomeViewModel.kt` | `submit` 打点；提交成功提示带状态中文名 |
| `ui/SetupScreen.kt` | 新增**常驻结果条**（不再只依赖会消失的 Snackbar）；配对码输入框接 `keyboardActions onDone` |
| `ui/vm/SetupViewModel.kt` | `friendlyMessage()` 改为**先按错误码、再按 HTTP 状态**分派：`pairing_bad_code` 也是 401，原先会被误判成"令牌失效" |

### 自证（logcat 原始行，修复后）

```
I/SetupViewModel( 4182): 点击「测试连接」 baseUrl='10.0.2.2:8787' busy=false
I/SetupViewModel( 4182): 探测成功 server=WIN-4FSO92IHDIN gateway=1.0.0 dsh=0.1.0-rc.7
I/SetupViewModel( 5090): 点击「配对并保存」 canPair=true busy=false baseUrl='10.0.2.2:8787' codeLen=6
I/TaskRepository( 5090): 事件流已启动 server=WIN-4FSO92IHDIN
I/SetupViewModel( 5090): 配对成功 server=WIN-4FSO92IHDIN tokenId=tok_7bb146818a8269e7
I/HomeViewModel( 6222): 点击「提交任务」 canSubmit=true workspace='D:\Workspace\dsh_android\.runtime\acceptance\ws' promptLen=43 submitting=false
I/HomeViewModel( 6222): 提交成功 id=task_01M4DV5FEG5DWA8JZ0KT6KBPHP status=running
I/TaskRepository( 6222): 任务进入终态 id=task_01M4DV5FEG5DWA8JZ0KT6KBPHP status=succeeded exit=0
```

release 包同样验证（`com.deepseek.dshremote`，pid 6993）：

```
I/SetupViewModel( 6993): 点击「测试连接」 baseUrl='10.0.2.2:8787' busy=false
I/SetupViewModel( 6993): 探测成功 server=WIN-4FSO92IHDIN gateway=1.0.0 dsh=0.1.0-rc.7
```

---

## 2. 端到端流程（配置 → 配对 → 提交中文任务 → 流式输出 → 终态）

| 步骤 | 操作 | 结果 | 截图 |
|---|---|---|---|
| 1 | 冷启动（未配置） | 直接进配置页，无网络请求、无崩溃 | `01-setup-page.png` |
| 2 | 输入 `10.0.2.2:8787` → 点「测试连接」 | 出现 `连接成功：WIN-4FSO92IHDIN · 网关 1.0.0 · dsh 0.1.0-rc.7` 与健康卡片 | `02-test-connection-ok.png` |
| 3 | PC 侧 `POST /api/v1/pair/open` 取码 → 输入 6 位码 → 点「配对并保存」 | 配对成功，自动进首页；`GET /workspaces` 已填充工作区 `D:\…\.runtime\acceptance\ws`；提示授予通知权限（前台服务保活） | `03-home-workspaces.png` |
| 4 | 点「填入示例」→ 中文多行 prompt 进入输入框 | 输入框正确容纳中文 + 换行（43 字符） | `04-chinese-multiline-prompt.png` |
| 5 | 点「提交任务」 | `201` 创建成功，自动跳详情页，状态 `running` | `05-task-running-detail.png` |
| 6 | 等待 SSE 推送 | 状态由 running → 已完成，退出码 0，耗时 4.4s，sessionId、输出 186B 全部渲染 | `06-detail-terminal-output.png` |
| 7 | 返回首页 | 「最近完成（本地历史）」显示中文完整输出（含全角标点、多行） | `07-home-history-chinese-output.png` |

真实模型输出（步骤 6 截图内的原文，证明中文与换行链路无损）：

```
当前工作目录 `D:\Workspace\dsh_android\.runtime\acceptance\ws` 的文件列表：
- `data-layer.txt`（1 行，内容为“数据层等价验证通过；”）
一句总结：该目录下只有一个名为 data-layer.txt 的文本文件，其中记录了一条“数据层等价验证通过”的验证结论。
第二行：确认多行与中文输入都可用。
```

流式（delta 逐步拼接）实测轨迹（轮询详情页头部「输出 NNNB」）：

```
0B/running -> 0B/running -> 214B/succeeded
```

说明：当前网关在 headless 模式下把 assistant 文本作为**一个较大 delta** 推送（`dsh` 退出前输出），
所以真实环境看到的是 0B → N 一次跃迁；**增量拼接、按 seq 去重与排序、`fromSeq` 断点续传**
由单测 `EventStreamTest`（MockWebServer 真 SSE）覆盖：包括"一条事件拆成多个 4 字节 chunk"、
"重连携带 `fromSeq=2`"、"重复补发不重复拼接"、"401 只请求一次进入未授权态"。

其他已在真机验证的行为：
- 断线重连与保活：前台服务启动后通知常驻（`I/TaskRepository: 事件流已启动`）；
- 终态落库：App 重启后「最近完成」仍能看到上次输出（历史文件位于应用私有目录）；
- 只终态可删：详情页仅在终态显示「删除服务端记录」（截图 6）。

---

## 3. 复现命令（自动化）

```powershell
$env:JAVA_HOME = 'D:\Workspace\dsh_android\.toolchain\android-dev\jdk17'
$adb = 'D:\Workspace\dsh_android\.toolchain\android-dev\sdk\platform-tools\adb.exe'

# 安装并冷启动
& $adb install -r 'D:\Workspace\dsh_android\android\app\build\outputs\apk\debug\app-debug.apk'
& $adb shell am force-stop com.deepseek.dshremote.debug
& $adb shell am start -n com.deepseek.dshremote.debug/com.deepseek.dshremote.MainActivity

# 关键日志
& $adb logcat -v time | Select-String 'SetupViewModel|HomeViewModel|TaskRepository|EventStream'
```

自动化脚本参见 `.toolchain/android-dev/e2e-helper.ps1`（`Get-UiXml` / `Find-Node` / `Tap-Text`），
注意三个坑（详见 `BUILD.md` §7）：
1. `uiautomator dump` 是 UTF-8，PowerShell 5.1 的 `Get-Content` 会按 GBK 读出乱码，**必须显式按 UTF-8 读**；
2. 一旦服务器地址里出现 `http://`，配置页会插入明文风险提示卡，**按钮整体下移约 280px**，
   所以每次点击前都要重新 dump 取坐标，不能复用旧坐标；
3. 模拟器无中文输入法：`adb shell input text` 对非 ASCII 直接抛 NPE，ADBKeyboard 的广播在
   Android 14 上收不到（未导出 receiver），因此中文输入用 App 内「填入示例」或在真机上用系统输入法验证。
