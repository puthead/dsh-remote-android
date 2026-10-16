# Android 客户端构建说明（可复现）

> 本文档记录**本机实测通过**的工具链、仓库地址与完整命令，目的是让任何人（含 Lead 独立复现）
> 用一条命令重建出同一个 APK。命令里的路径都是绝对路径，可直接复制执行。

复现环境：Windows（PowerShell / pwsh 均可）、无需安装 Android Studio。

---

## 1. 工具链（绝对路径 + 版本）

| 组件 | 绝对路径 | 版本（实测） | 说明 |
|---|---|---|---|
| JDK | `D:\Workspace\dsh_android\.toolchain\android-dev\jdk17` | Amazon Corretto **17.0.20.1**（build 17.0.20.1+12-LTS） | AGP 8.7.3 要求 JDK 17 |
| Gradle | `D:\Workspace\dsh_android\.toolchain\android-dev\gradle-8.9` | **8.9**（`gradle-launcher-8.9.jar`） | 工程内另有 wrapper，版本一致 |
| Android SDK | `D:\Workspace\dsh_android\.toolchain\android-dev\sdk` | platform **android-34**（ext7_r03）、build-tools **34.0.0**、platform-tools（latest） | 由 Google 官方仓库包手工落盘，未用 sdkmanager |
| SDK 许可证 | `.toolchain\android-dev\sdk\licenses\android-sdk-license` | — | AGP 校验需要，已写入标准哈希 |

**兼容入口（junction）**：为兼容既有脚本/文档里的简写路径，已建立
`.toolchain\jdk17`、`.toolchain\sdk`、`.toolchain\gradle-8.9` 三个目录联接（junction），
分别指向上面 `android-dev\*` 的真实目录。两条路径等价，`local.properties` 用的是
`android-dev\sdk`（实际路径），脚本里用简写也能工作。

版本组合（与需求一致，不得擅自升级）：AGP **8.7.3** / Gradle **8.9** / Kotlin **2.0.21** /
Compose BOM **2024.09.00** / compileSdk **34** / minSdk **26** / targetSdk **34**。

工具链压缩包与哈希（下载源见下表，便于校验镜像未被篡改）：

| 文件 | sha256 |
|---|---|
| `jdk17-corretto.zip` | `1AC8D9DC48B170684AC6223113F524325BD842D14ED74DAC28927F8165CFFD3A` |
| `gradle-8.9-bin.zip` | `D725D707BFABD4DFDC958C624003B3C80ACCC03F7037B5122C4B1D0EF15CECAB` |
| `platform-34.zip` | `16FDB74C55E59AE3EF52DEF135AEC713508467BD56D7DABCD8C9BE31FA8B20F3` |
| `build-tools-34.zip` | `9BE665AD74EF22BF0E489B37DB465074484DF79B95F26D759945D5C25A47B326` |
| `platform-tools.zip` | `45F4D63113E895EBDE0C90F194099A4676B6AC653BD28D54314A9E022BBC1A99` |

### 下载源（services.gradle.org 在本机不可达）

| 组件 | 实际使用 URL | 备注 |
|---|---|---|
| Gradle 8.9 | `https://repo.huaweicloud.com/gradle/gradle-8.9-bin.zip` | 官方 `services.gradle.org` HEAD 超时，改用华为云镜像（已获 Lead 批准） |
| JDK 17 | `https://corretto.aws/downloads/latest/amazon-corretto-17-x64-windows-jdk.zip` | Corretto 官方下载 |
| platform-34 | `https://dl.google.com/android/repository/platform-34-ext7_r03.zip` | 注意：`platform-34_r03.zip` 不存在，正确文件名带 `ext7` |
| build-tools 34.0.0 | `https://dl.google.com/android/repository/build-tools_r34-windows.zip` | 解压后目录名是 `android-14`，需重命名为 `34.0.0` |
| platform-tools | `https://dl.google.com/android/repository/platform-tools-latest-windows.zip` | adb 等 |

### 依赖仓库（只用官方仓库）

- `google()`（https://dl.google.com/dl/android/maven2/）
- `mavenCentral()`（https://repo1.maven.org/maven2/）

`settings.gradle.kts` 里设置了 `RepositoriesMode.FAIL_ON_PROJECT_REPOS`，模块内无法再引入其它仓库。
**未**使用 aliyun 等第三方 Maven 代理，本机 mavenCentral 实测可达。

---

## 2. local.properties（必须存在）

`android/local.properties` 内容（反斜杠要转义）：

```properties
sdk.dir=D:\\Workspace\\dsh_android\\.toolchain\\android-dev\\sdk
```

---

## 3. 可复制的构建命令

先设置 `JAVA_HOME`（Gradle 启动器自身也要用 java），再执行 wrapper。

```powershell
$env:JAVA_HOME = 'D:\Workspace\dsh_android\.toolchain\android-dev\jdk17'
Set-Location 'D:\Workspace\dsh_android\android'

# 1) Debug 包
.\gradlew.bat :app:assembleDebug --no-daemon --console=plain '-Dorg.gradle.java.home=D:\Workspace\dsh_android\.toolchain\android-dev\jdk17'

# 2) Release 包（已签名，用户安装包）
.\gradlew.bat :app:assembleRelease --no-daemon --console=plain '-Dorg.gradle.java.home=D:\Workspace\dsh_android\.toolchain\android-dev\jdk17'

# 3) 单元测试
.\gradlew.bat :app:testDebugUnitTest --no-daemon --console=plain '-Dorg.gradle.java.home=D:\Workspace\dsh_android\.toolchain\android-dev\jdk17'
```

> PowerShell 陷阱：`-Dorg.gradle.java.home=...` **必须整体加单引号**，否则 `-Dorg` 会被 PowerShell
> 拆开，Gradle 会报 `Cannot locate tasks that match '.gradle.java.home=...'`。若只想跑一次，
> 也可以只用 `JAVA_HOME`（上面的命令已经同时设置，两者一致）。

---

## 4. Release 签名

| 项 | 值 |
|---|---|
| 密钥库 | `D:\Workspace\dsh_android\keystore\dshremote-release.jks`（PKCS12，alias `dshremote`） |
| keystore sha256 | `FB8EF8AD14E1DE76F573455317A03FFF22903A77928803AD5E08A6ED3169F373` |
| 口令来源 | `android/keystore/keystore.properties`（`storePassword` / `keyPassword` / `keyAlias`），或环境变量 `DSHREMOTE_STORE_PASSWORD` / `DSHREMOTE_KEY_PASSWORD` / `DSHREMOTE_KEY_ALIAS` |
| 读取方式 | `app/build.gradle.kts` 里手工解析 properties（优先级：文件 > 环境变量），**不硬编码在构建脚本中** |

自用项目允许把口令放在 `android/keystore/keystore.properties`；对外分发前请改为仅用环境变量注入。
密钥库本体位于仓库的 `keystore/`（不在 `android/` 内），`android/.gitignore` 只忽略构建产物。

签名校验：

```powershell
& 'D:\Workspace\dsh_android\.toolchain\android-dev\sdk\build-tools\34.0.0\apksigner.bat' verify --print-certs `
  'D:\Workspace\dsh_android\android\app\build\outputs\apk\release\app-release.apk'
```

包信息校验：

```powershell
& 'D:\Workspace\dsh_android\.toolchain\android-dev\sdk\build-tools\34.0.0\aapt2.exe' dump badging `
  'D:\Workspace\dsh_android\android\app\build\outputs\apk\release\app-release.apk'
```

---

## 5. 产物（本次实测）

| 变体 | 路径 | 大小 | sha256 | 构建时间 |
|---|---|---|---|---|
| Release（已签名，**v2.9.0**） | `D:\Workspace\dsh_android\android\app\build\outputs\apk\release\app-release.apk`（归档 `deliverables/DSH-Remote-v2.9.0-release.apk`） | `12,254,192` 字节 | `7F252EF213B7E18A9FFE3AF9D37FFD0FC365AB0C13EFCCBAE6EB4038D6CAD5A3` | `2026-10-16 02:30:50` |
| Debug（**v2.9.0**） | `D:\Workspace\dsh_android\android\app\build\outputs\apk\debug\app-debug.apk`（归档 `deliverables/DSH-Remote-v2.9.0-debug.apk`） | `19,054,651` 字节 | `8C1B0A8038D6F2AE06A533CBF0A512F41A4AB1F7ACF9A9017F41ED0082A81949` | `2026-10-16 02:24:04` |
| Release（已签名，**v2.7.1**） | `D:\Workspace\dsh_android\android\app\build\outputs\apk\release\app-release.apk`（归档 `deliverables/DSH-Remote-v2.7.1-release.apk`） | `12,122,409` 字节 | `A379747FD8BAA64D4732849E92FFDCC85FAE722836CE233F977D5B198ED81F53` | `2026-10-15 08:52:13` |
| Debug（**v2.7.1**） | `D:\Workspace\dsh_android\android\app\build\outputs\apk\debug\app-debug.apk`（归档 `deliverables/DSH-Remote-v2.7.1-debug.apk`） | `18,579,119` 字节 | `9CA74D7A89C5EC3D26E4EFB1649D0D7FF6879BB6287C37C64C5C31FB74196C48` | `2026-10-15 08:52:06` |
| Release（已签名，**v2.7.0**） | `D:\Workspace\dsh_android\android\app\build\outputs\apk\release\app-release.apk`（归档 `deliverables/DSH-Remote-v2.7.0-release.apk`） | `12,122,409` 字节 | `D697C2F4F265A79A72A97CC431F5168EAD9F0F63E9A8BC243E564B6BCAB827AE` | `2026-10-15 00:59:38` |
| Debug（**v2.7.0**） | `D:\Workspace\dsh_android\android\app\build\outputs\apk\debug\app-debug.apk`（归档 `deliverables/DSH-Remote-v2.7.0-debug.apk`） | `18,498,373` 字节 | `994DB8C0043627EF761DDD38AA711FBDFA2C48955C3DAECDB2B8C776F69369B7` | `2026-10-15 00:59:32` |
| Release（已签名，**v2.6.0**） | `D:\Workspace\dsh_android\android\app\build\outputs\apk\release\app-release.apk`（归档 `deliverables/DSH-Remote-v2.6.0-release.apk`） | `12,089,641` 字节 | `907E4484C0F281CCB953522D37A0AE924BC76C1E4A48946FF7FC1BFEAFD7CBA3` | `2026-10-14 23:51:25` |
| Debug（**v2.6.0**） | `D:\Workspace\dsh_android\android\app\build\outputs\apk\debug\app-debug.apk`（归档 `deliverables/DSH-Remote-v2.6.0-debug.apk`） | `18,369,490` 字节 | `7D1F49FF55EBEC83F285229C0DF95A38DDADAD00DBB943A9879BCF35DD4311EA` | `2026-10-14 23:51:08` |
| Release（历史，v2.5.0） | `D:\Workspace\dsh_android\android\app\build\outputs\apk\release\app-release.apk` | `11,925,801` 字节 | `B600ABBE10376D1C30304B865FAD5706695A2C4E9765FCB47D92EBBCC993D61E` | `2026-10-14 21:32:34` |
| Debug（历史，v2.5.0） | `D:\Workspace\dsh_android\android\app\build\outputs\apk\debug\app-debug.apk` | `18,090,962` 字节 | `93C17EF56309F39C2293257BA3809A945627D2225448A38580E7F3F8FF58031B` | `2026-10-14 21:32:28` |
| Release（历史，v2.2.0） | `D:\Workspace\dsh_android\android\app\build\outputs\apk\release\app-release.apk` | `11,876,591` 字节 | `E6C6E722D5FDC6E800825C7F8D00C5880AB7D3C1D91072DF0504FA54B30555CB` | `2026-10-13 23:45:36` |
| Debug（历史，v2.2.0） | `D:\Workspace\dsh_android\android\app\build\outputs\apk\debug\app-debug.apk` | `18,025,426` 字节 | `B8578ABEB808589B1AB223846BDFD3A755747415981222C36F08C6837911DAE8` | `2026-10-13 23:45:28` |

**本轮（v2.9.0，2026-10-16）**：`versionCode=11 / versionName=2.9.0`（上一版交付 v2.7.2 是 `versionCode=10`），`BuildConfig.API_VERSION=2`。
release 签名复核：`apksigner verify --print-certs` → `CN=DSH Remote`、证书 SHA-256 `e2051854e02a30f2399f2b0e07b556091b886063ffa8e5232bb2eff3141a167b`（**与 v2.3.0 起各版同一张证书，可在用户手机上覆盖安装**），`exit 0`；`aapt2 dump badging` 读回 `com.deepseek.dshremote` / `versionCode='11' versionName='2.9.0'`；`adb install -r -d` 到 `emulator-5554` → `Success`。
本轮能力（对话内图片 / 轮次导航 / 会话列表状态语言）见 `docs/06-项目管理/变更记录.md` §19；**装 APK 之外还要重启网关**（新端点与能力位只在重启后生效，`/api/v2/health` 的 `capabilities` 应出现 `attachments`、`session.turnIndex`）。

**上轮（v2.7.1，2026-10-15）**：`versionCode=9 / versionName=2.7.1`（`android/app/build.gradle.kts`；上一版 v2.7.0 是 `versionCode=8`），`BuildConfig.API_VERSION=2`（**接口无变更**）。
构建命令与结果：`.\gradlew.bat :app:testDebugUnitTest :app:assembleDebug :app:assembleRelease --no-daemon --console=plain '-Dorg.gradle.java.home=…jdk17'` → `BUILD SUCCESSFUL in 58s`（2026-10-15 08:52，这是含**第 5 处修复：冷启动盲区（缺陷 D-22）**的最终构建；08:44 那次构建在其之前，产物已作废）。
本轮是**用户真机诉求 m00003** 的交付：真机下拉刷新报「刷新失败：电脑离线：中继隧道未连接…」，而中继 `/health`、网关 `relay.connected=true reconnects=0`、桌面端 DSH `19387` 三方同时**都是好的**——坏的是手机自己那条隧道（中继日志里该真机每 20s~4min 掉一次，关闭原因绝大多数是 `code=1006 reason=socket error`（该真机三天 55 次下线，其中 40 次是这个取值）；复核实测重连 **8.9s / 13.4s / 13.9s / 17.6s**，50 个可配对样本里 ≤12s 仅 10 个（20%）、≤20s 13 个（26%））。
修法全在客户端（五处，见 `docs/06-项目管理/变更记录.md` §16）：隧道抖动时主读操作先等回来再重试一次（≤`TUNNEL_WAIT_MS = 20_000L`，初版 12s 经独立核验后上调：复算生产日志，该真机 50 个可配对样本里只有 10 个（20%）能在 12s 内回来、13 个（26%）在 20s 内回来）、`waitOnline` 每秒复检"句柄真的开着"、在线判定补 `relay.isConnected`、请求成功后立刻清离线态、**冷启动第一次连不上时也挂自愈探测**（原为 `if (wasOnline) startRecoveryProbe()`，冷启动必然不满足 ⇒ 界面一直挂"电脑离线"，`data/ConsoleRepository.kt` 离线分支现为无条件挂）。**服务端零改动，不需要重启网关，装 APK 即可。**
单测随本轮源码更新为 **506 用例 / 0 失败 / 0 错误 / 1 跳过（45 个测试类）**（相对 v2.7.0 交付时的 489 新增 17 条。**能自洽的分解**：`data.relay.RelayClientTest` 13→20、`data.TunnelRetryTest` 新建 0→10，其余 43 类 476 不变；v2.7.0 的 test XML 已被同目录覆盖且无归档，所以 13/0 是**反推值**，独立核验（扫 v2.7.0 release 的 dex 无 `TunnelRetry` 类）支持这一分解）。
真实链路 E2E（模拟器 `emulator-5554` → 公网中继 `wss://123.207.183.237:9443` → 真实网关 8787 → 桌面端 DSH `19387`）：用 `iptables -I OUTPUT -d 123.207.183.237 -j DROP` 只黑洞中继 IP，黑障中刷新读到 `隧道暂不可用，等待重连（最多 20000ms）后自动重试一次`，网络恢复后**不点任何按钮**、一个等待窗口内读到 `隧道已恢复，重试成功`（本次实测：08:46:40 刷新 → 08:46:58 隧道就绪 → 08:46:59 重试成功），副标题自动回到 `已发起 1 · 默认电脑端执行`（离线标记消失）；全程 `logcat` 无 `FATAL EXCEPTION`。取证脚本 `.runtime/tmp/e2e-offline3.ps1`（更早两跑 `e2e-offline{,2}.ps1`）。
**产物完整性**：`aapt2 dump badging` 复核 release = `com.deepseek.dshremote` / `versionCode='9' versionName='2.7.1'`；`apksigner verify --print-certs` 复核签名 = `CN=DSH Remote`、证书 SHA-256 `e2051854e02a30f2399f2b0e07b556091b886063ffa8e5232bb2eff3141a167b`（**与 v2.3.0 起各版同一张证书，可直接覆盖安装**），`exit 0`；`adb install -r -d` 到 `emulator-5554` → `Success`。
两个包都已归档到 `deliverables/DSH-Remote-v2.7.1-{release,debug}.apk`（大小、mtime、sha256 与上表逐位相同）。交付前由独立会话（teammate `v271-verifier`，只读）逐条核验，报告 `.runtime/verify/v271/REPORT.md`：代码五条修复与两个 APK 的身份/签名全部成立，三处文档读数（重连耗时、测试增量分解、E2E 混合读数）经复算后已按实测更正。

**上一轮（v2.7.0，2026-10-15）**：`versionCode=8 / versionName=2.7.0`（`android/app/build.gradle.kts`；上一版 v2.6.0 是 `versionCode=7`），`BuildConfig.API_VERSION=2`。
构建命令与结果：`.\gradlew.bat :app:testDebugUnitTest :app:assembleDebug :app:assembleRelease --offline` → `BUILD SUCCESSFUL in 14s`（`dexBuilderDebug`/`dexBuilderRelease` 均执行）；
上一轮同命令在根面包屑修复前跑过一次（`BUILD SUCCESSFUL in 21s`），两轮的聚合单测读数一致。
本轮是**五项真机诉求**的修复交付（工具卡折叠 / 工作区越界误拒 / 崩溃可观测 / ask 应答 / 子代理会话过滤），
逐条取证见 `docs/04-验收/验收报告.md` §15 与 `docs/06-项目管理/变更记录.md` §15，
真机（emulator-5554 → 公网中继 → 真实网关 8787）截图 16 张在 `android/evidence/v2.7.0/shots/`。
单测随本轮源码更新为 **489 用例 / 0 失败 / 0 错误 / 1 跳过（44 个测试类）**（相对 v2.6.0 交付时的 397 新增 92）。
**产物完整性**：v2.7.0 两个包都是 14 dex；`adb install -r -d` 到 `emulator-5554` → `Success`，`versionName=2.7.0`，
启动与四项 E2E 全程 `logcat` 无 `FATAL EXCEPTION`（判据是 `AndroidRuntime` 的崩溃栈；`logcat` 里出现 `AndroidRuntime` 普通启动行不算）。
两个包与 `deliverables/` 里的归档副本**大小、mtime、sha256 逐位一致**。

**上一轮（v2.6.0）**：`versionCode=7 / versionName=2.6.0`（`android/app/build.gradle.kts`；上一版 v2.5.0 是 `versionCode=6`），`BuildConfig.API_VERSION=2`。
构建命令与结果：`.\gradlew.bat :app:assembleDebug :app:assembleRelease --no-daemon --console=plain '-Dorg.gradle.java.home=…jdk17'`
→ `BUILD SUCCESSFUL in 1m 10s`（87 tasks：37 executed / 50 up-to-date）。
`aapt2 dump badging` 复核（2026-10-14 23:5x）：release `com.deepseek.dshremote`、debug `com.deepseek.dshremote.debug`，两者均 `versionCode='7' versionName='2.6.0'`；
`apksigner verify --print-certs` 复核 release 签名 = `CN=DSH Remote`、证书 SHA-256 `e2051854e02a30f2399f2b0e07b556091b886063ffa8e5232bb2eff3141a167b`（**与 v2.3.0/v2.5.0 同一张证书，可直接覆盖安装**），`exit 0`。
本轮新增能力：① **手机端 UI 全面对标原型**（令牌层／外壳原语／常驻底栏／六屏重排／真黑窗口 + 画稿三条交互语义）；
② **手机端可直接应答电脑端发起的审批与提问**（`GET /api/v2/approvals`、`POST /api/v2/approvals/{eventId}` + 三个 SSE 事件 +
详情页审批卡在等待时接管输入区）。
单测随本轮源码更新为 **397 用例 / 0 失败 / 0 错误 / 1 跳过（35 个测试类）**（相对 v2.5.0 交付时的 343 新增 54），见 `docs/06-项目管理/变更记录.md` §13/§14。
**最终源码复跑（交付口径，2026-10-14 23:08）**：`:app:testDebugUnitTest :app:assembleDebug --rerun-tasks --console=plain` → `BUILD SUCCESSFUL in 29s`、`43 actionable tasks: 43 executed`，聚合 `classes=35 tests=397 failures=0 errors=0 skipped=1`（唯一跳过是刻意保留的 `TranscriptPagerTest` 空槽）。
**产物完整性**：v2.6.0 的两个包都在其 `classes*.dex` 里检索到 `approval.asked` / `/api/v2/approvals` / `submitApproval` /
`DshNavBar` / `DshPageHeader` / `DshFilterChip` / `DshRadius` / `等待你响应` / `允许一次` 九个常量，而
`deliverables/DSH-Remote-v2.5.0-release.apk` 这九个**全部缺失**（两者都能检索到 `DshRemoteApp`，证明检索方法有效）。
早前一个只含 4 个 dex、**搜不到 `DshRemoteApp`** 的残缺 debug 包（多写者并发构建所致，症状是启动即
`ClassNotFoundException: com.deepseek.dshremote.DshRemoteApp`）已定位并在 `--rerun-tasks` 全量重跑后修复，现为 14 dex。
两个包都已归档到 `deliverables/DSH-Remote-v2.6.0-{release,debug}.apk`（sha256 与上表逐位相同）。

上表 v2.2.0 两行为历史构建：`versionCode=4 / versionName=2.2.0`（Markdown 渲染交付，见 `docs/06-项目管理/变更记录.md` v2.2.0 行），
同一构建的两个包也已归档到 `deliverables/DSH-Remote-v2.2.0-{release,debug}.apk`（sha256 与上表逐位相同）。

> 历史构建（v2.0.0，`2026-10-09`）：release `11,827,439` 字节 / `D77B56864C61C9C52312EABF742CD8E2738465761FF89E32067208E88AEB8092`。
> v2.1.0 交付包（`2026-10-13 22:00`，`versionCode=3`）见 `deliverables/DSH-Remote-v2.1.0-release.apk`。

> **APK 数字会随后续构建变化，交接前请以 `pwsh -File scripts/verify.ps1` 的实测输出为准。**

两个包都**包含本轮全部源码修复**（离线态自愈探测、会话 `writable` 门控、系统消息待办、
SSE 总线游标与事件序号分离）。核对方式不是看时间戳，而是直接在 dex 里查字符串常量：
在 `classes*.dex` 中能检索到 `启动自愈探测`（`ConsoleRepository.startRecoveryProbe()` 的日志文案），
且检索不到 v1 遗留文案 `明文 HTTP`（v1 文案已重写）。Release 里存在该常量 ⇒ 修复确实进了装机包。

Release 包校验结果（实测）：

```
apksigner verify --print-certs app-release.apk        -> exit 0
Signer #1 certificate DN: CN=DSH Remote
Signer #1 certificate SHA-256 digest: e2051854e02a30f2399f2b0e07b556091b886063ffa8e5232bb2eff3141a167b

aapt2 dump badging app-release.apk
package: name='com.deepseek.dshremote' versionCode='4' versionName='2.2.0'   # v2.2.0 当时实测；v2.5.0 实测为 versionCode='6' versionName='2.5.0'
  compileSdkVersion='34'
sdkVersion:'26'   targetSdkVersion:'34'
application-label:'DSH 远程'
launchable-activity: name='com.deepseek.dshremote.MainActivity'
```

**网络安全配置（契约 §5.6 实测核对）**：release 的 manifest **没有** `usesCleartextTraffic`，
`main/res/xml/network_security_config.xml` 里 `cleartextTrafficPermitted="false"`、`<certificates src="system" />`；
`cleartextTrafficPermitted="true"` 只存在于 `debug/` 变体（**仅明文联调用**）。
两个变体都**只信任系统证书链**：App **没有**"信任自签证书/自签 CA"开关（需求 FR-15 / O8），
所以 release 只能连系统信任链可校验的 `wss://` 正式证书（无域名用 Let's Encrypt IP 地址证书，
见 `docs/05-运维/中继部署手册.md` §5.1）。自签证书**任何变体都连不上**（debug 只是额外放开明文 `ws://`）。
用 `aapt2 dump xmltree` 对两个 APK 逐个核对过。

单元测试（`:app:testDebugUnitTest`）：**397 个用例全部通过、0 失败、0 错误、1 跳过（35 个测试类）**。
该数字以 `--rerun-tasks`（下文的真跑命令）在**当前源码**上复算过一次，两次结果一致（exit 0）。

计数口径与历史差异（如实记录，不掩盖）：

| 阶段 | 用例数 | 测试类 | 说明 |
|---|---|---|---|
| v2.0.0 基线（本文档旧记录） | 214 | 24 | 旧记录数字；与当时的实测差 2，无法追溯，按实测口径废弃 |
| v2.1.0 交付（[变更记录](../docs/06-项目管理/变更记录.md) §9 记载） | 216 | 24 | 新增权限档用例；**以 216 作为 v2.2.0 之前的实测基线** |
| **v2.2.0（历史交付）** | **249** | **26** | 新增 33 项：`ui.markdown.MarkdownInlineTest` 14、`ui.markdown.MarkdownParserTest` 18、`data.api.WorkspacePathsTest` 的 Markdown 扩展名识别 1 |
| **v2.5.0（历史交付）** | **343** | **32** | **两个基线口径（勿再当成矛盾）**：相对**本轮改造前基线 325** 新增 **18** 条；相对 **v2.3.0 交付时的 291** 新增 **52** 条（v2.3.0 交付的分页 42 项之后，本轮补齐双向能力适配：`createdBy` 解析与派生、`TaskHost`/`accessForHost`、`placementNote`、错误码文案等）。计数 = `android\app\build\test-results\testDebugUnitTest\*.xml` 聚合行 `TOTAL classes=32 tests=343 fail=0 err=0 skip=1`；**交付口径 = Lead 在最终交付源码上复跑（2026-10-14 21:40:20，`BUILD SUCCESSFUL in 17s`，聚合一致；`VcsBadgeTest` 6/0/0）** —— 早前 20:21 的绿测（`BUILD SUCCESSFUL in 19s`）早于 21:26 的调色板改动，21:39 用最终源码复跑曾抓到 `VcsBadgeTest.kt:45` 的过期断言（已修正后转绿）。唯一跳过是刻意保留的 `TranscriptPagerTest` 空槽 |
| **v2.6.0（本次交付）** | **397** | **35** | 相对 v2.5.0 交付时的 343 新增 **54** 条，全部落在本轮新能力上：`data.api.WireApprovalsTest` 33（审批/提问的线协议解析与答案编码）、`data.api.TunnelApiApprovalsTest` 9（两个新端点的隧道调用与错误映射）、`ui.vm.SessionDetailUiStateTest2` 12（未决审批进 VM 状态、动作分派、提交后收敛）。计数 = `android\app\build\test-results\testDebugUnitTest\*.xml` 聚合行 `TOTAL classes=35 tests=397 failures=0 errors=0 skipped=1`；**交付口径 = Lead 在最终交付源码上 `--rerun-tasks` 全量复跑（2026-10-14 23:08，`BUILD SUCCESSFUL in 29s`，`43 actionable tasks: 43 executed`）**。唯一跳过仍是 `TranscriptPagerTest` 空槽 |
| **v2.7.1（本次交付）** | **506** | **45** | 相对 v2.7.0 交付时的 489 新增 **17** 条，全部落在本轮误报修复上。**分解（独立核验更正）**：`data.relay.RelayClientTest` **13→20**（新增「waitOnline 不会拿已经死掉的句柄冒充可用」等）、`data.TunnelRetryTest` **新建 0→10**（新增"重试成功回调 / 重试仍失败不给回调 / 第一次就成功不算恢复"三条），其余 43 类合计 476 不变 —— 早前写的"18→20 / 7→10"合计只有 +5，与 +17 矛盾，已更正；v2.7.0 的 test XML 已被覆盖，13/0 属反推值。计数 = `android\app\build\test-results\testDebugUnitTest\*.xml` 45 个文件聚合 `classes=45 tests=506 failures=0 errors=0 skipped=1`（**注意 XML 的属性顺序是 `tests/skipped/failures/errors`，按固定顺序写的正则会把 skipped 读成 0**）；唯一跳过仍是 `data.api.TranscriptPagerTest` 空槽。**交付口径 = Lead 在最终交付源码上 `:app:testDebugUnitTest :app:assembleDebug :app:assembleRelease --no-daemon`（2026-10-15 08:52，`BUILD SUCCESSFUL in 58s`，45 个 XML 全部 08:52:05 重写；更早的 08:44 构建产物已作废）+ 该源码产出的 APK 装到模拟器上跑通黑障 E2E（含冷启动盲区 D-22 的第 4 跑）** |
| **v2.7.0（上一轮交付）** | **489** | **44** | 相对 v2.6.0 交付时的 397 新增 **92** 条，落点都是本轮真机诉求：工具卡分组与汇总纯函数（`ui.components.ToolGroupingTest` 24）、崩溃兜底与报告生成（`data.CrashReporterTest`）、流式 UTF-8 增量解码（`data.api.StreamTextTest`）、SSE 分帧（`data.api.SseStreamFramingTest`）、坏帧容错（`data.relay.FrameDecodeResilienceTest`）、中继连接容错（`data.relay.RelayConnectResilienceTest`）、会话派生判定（`data.api.SessionDerivationTest`）。计数 = `android\app\build\test-results\testDebugUnitTest\*.xml` 聚合行 `TOTAL classes=44 tests=489 failures=0 errors=0 skipped=1`；**交付口径 = Lead 在最终交付源码上 `:app:testDebugUnitTest :app:assembleDebug :app:assembleRelease --offline`（2026-10-15 00:59，`BUILD SUCCESSFUL in 14s`）**。唯一跳过仍是 `TranscriptPagerTest` 空槽 |

新增用例覆盖 Markdown 行内（强调/删除线/代码 span/链接/图片/自动链接/反斜杠转义/Windows 路径不被吃掉）、
块级（ATX 与 Setext 标题/围栏与**未闭合**围栏/嵌套列表/任务项/引用/分隔线/GFM 表格与对齐）、
病态输入（`*`×500、`` ` ``×300、括号×200、`\`×200 不抛异常）以及**无 Markdown 语法的文本逐字符往返**（渲染不得改动纯文本）。
解析层是自研纯 Kotlin（无第三方 Markdown 依赖，也没有 Android/Compose 依赖），所以能全部落在 JVM 单测里。

真跑命令（避免误读成"复用缓存"）：

```powershell
cd D:\Workspace\dsh_android\android
.\gradlew.bat :app:testDebugUnitTest --rerun-tasks --no-build-cache --no-daemon --console=plain `
  '-Dorg.gradle.java.home=D:\Workspace\dsh_android\.toolchain\android-dev\jdk17'
```

统计命令（结论数字就是从这里来的）：

```powershell
$xml = Get-ChildItem 'D:\Workspace\dsh_android\android\app\build\test-results\testDebugUnitTest' -Filter '*.xml'
($xml | ForEach-Object { [xml]$x=[System.IO.File]::ReadAllText($_.FullName); [int]$x.testsuite.tests } | Measure-Object -Sum).Sum
```

本地复算命令：

```powershell
Get-FileHash 'D:\Workspace\dsh_android\android\app\build\outputs\apk\release\app-release.apk' -Algorithm SHA256
```

---

## 5.1 v2 真机证据与自动化（`android/evidence/v2/`）

| 入口 | 用途 |
|---|---|
| `run-ui-check.ps1` | 夹具链路：**脚本自计 69/69 全 PASS**（含截图断言；历史文档写作「46 项断言 + 22 张截图」），22 张截图（`00-…21-legacy-gateway`）。夹具中继端口 **9543**（真实中继默认 9443 会被队友占用）。数据是夹具，**App 的状态机/隧道/SSE 全是真的**。本文件所在轮次（v2.2.0）已用最终 APK 复跑：**69/69 无回归**，旧报告备份 `evidence/v2/ui-check-report-baseline-v2.1.1.txt` |
| `run-e2e-real.ps1` | 真实链路：真实 `relay.mjs`（**9643**）+ 真实 `gateway.mjs`（**8887**，隔离 `--home`），最终 **41 通过 / 0 失败 / 0 跳过**；截图前缀 `real-relay-*` |
| `run-e2e-safety-check.ps1` | 清理安全性回归：起"同形命令行"的替身 relay，跑完整 E2E 后断言替身仍活着 |
| `probe-upgrade-head.mjs` | 协议排障：验证 WS 客户端必须处理 `upgrade` 事件的 `head` 参数 |

两条铁律（Lead 复核后定）：

1. **两个 E2E 不能并发**：它们独占模拟器 + 固定端口。启动时抢 `.e2e.lock`，发现存活实例立刻
   `exit 3` 并打印「已有 E2E 在运行（PID x），请等待」。
2. **进程清理只用 PID 作用域**：`Win32_Process.Create` → 认领 `ParentProcessId` 的 node 子进程 →
   登记 → `taskkill /PID /T /F`。**禁止**按命令行关键字（`relay.mjs`/`gateway.mjs`）全局匹配杀进程。

debug 变体支持注入（联调用，release 不含）：

```powershell
adb shell am start -n com.deepseek.dshremote.debug/com.deepseek.dshremote.MainActivity `
  --es dsh_relay_url ws://10.0.2.2:9643 --es dsh_pair_code 123456 --es dsh_task_prompt 'reply OK'
```

---

## 5.2 v2.2.0 Markdown 渲染证据（`android/evidence/v3/`）

| 入口 | 用途 |
|---|---|
| `run-markdown-check.ps1` | Markdown 渲染链路：**44/44 全 PASS**，6 张截图。夹具中继端口 **9544**（避让 v2 的 9543 与真实中继 9443），夹具脚本**复用** `evidence/v2/mock-tunnel.mjs`（不复制，避免两份夹具漂移） |
| `markdown-check-report.txt` | 断言明细（`通过 44 / 共 44`），UTF-8 无 BOM |
| `shots/` | `00-phone-streaming`（流式未闭合围栏）、`01-phone-markdown-bottom`、`02-phone-markdown-top`、`03-file-preview-top`、`04-file-preview-table`、`05-file-source`（切回源码后 `#`/`##` 原文回来） |

跑法（**要求模拟器已启动**、且**不得与 v2 脚本并发**）：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
& 'D:\Workspace\dsh_android\android\evidence\v3\run-markdown-check.ps1'
# 可选：-SkipInstall（跳过装包）/ -Port 9544 / -Serial emulator-5554
```

覆盖点：流式期间部分 Markdown（未闭合 ``` 围栏）不崩且标题已按标题渲染；轮次结束后
`**粗体**`、`## 标题`、表格分隔行、`> 引用`、任务项 `- [x]`、围栏 ``` 等**原始标记不出现在界面上**；
表格单元格、引用正文、任务项文本、链接标签按渲染结果出现；工作区 `README.md` 默认走预览（不带 `## 能力`），
点「查看源码」后原文与行号回来、按钮变回「预览 Markdown」。

脚本约定：与 v2 同一套清理铁律（PID 作用域杀进程、`.e2e.lock` 互斥、`uiautomator dump` 取坐标后再点）；
报告与截图落在 `evidence/v3/`。**截图 01/02 与 03/04 逐字节相同是预期**：这两段内容都在一屏内完整可见，
没有产生滚动位移（长文滚动未单独取证，见变更记录 §10 待验证项）。

---

## 6. 已知环境坑（排障用）

1. `services.gradle.org` 不可达 → wrapper 的 `distributionUrl` 指向华为云镜像（版本仍是 8.9）。
   首次构建会下载 Gradle 发行包；之后走本地缓存。
2. `local.properties` 缺失或路径未转义 → AGP 报 `SDK location not found`。
3. `-Dorg.gradle.java.home` 未加引号 → 见 §3 的 PowerShell 陷阱。
4. 单元测试里用到 `org.json` 与 `android.util.Log`：前者通过 `testImplementation("org.json:json:20240303")`
   提供真实实现，后者靠 `testOptions.unitTests.isReturnDefaultValues = true` 返回默认值。
5. build-tools 压缩包解压后目录名是平台代号（`android-14`），必须改名成 `34.0.0` 才能被 AGP 识别。

---

## 7. 真机 / UI 自动化注意事项（踩过的坑）

1. **明文提示卡会把按钮顶下去约 280px**：配置页的服务器地址一旦填入 `http://` 开头的地址，
   会插入「明文 HTTP 风险提示」卡片，其下方所有控件（包括「测试连接」）整体下移。
   自动化脚本**必须每次重新 `uiautomator dump` 取坐标**，复用旧坐标会点到说明文字上，
   表现为"点了没反应"。
2. **`uiautomator dump` 是 UTF-8**：Windows PowerShell 5.1 的 `Get-Content` 默认按 ANSI/GBK 读，
   中文关键字匹配会全部落空。请用
   `[System.IO.File]::ReadAllText($path, [System.Text.UTF8Encoding]::new($false))` 读取。
3. **中文输入**：模拟器通常没有中文输入法，`adb shell input text '中文'` 会直接抛
   `NullPointerException … InputShellCommand.sendText`；ADBKeyboard 的 `ADB_INPUT_B64` 广播在
   Android 14 上因 receiver 未导出而收不到。因此 E2E 用应用内「填入示例」写入中文多行 prompt
   （真机上用系统输入法同样可用）；多行输入可用 `input text a` + `keyevent 66` + `input text b` 验证。
4. **两个包并存**：debug 变体带 `.debug` 后缀（`com.deepseek.dshremote.debug`），release 是
   `com.deepseek.dshremote`，可以同时安装；并行测试时注意 `am force-stop` 另一个包，避免互相打断。
5. **网络调用必须在 IO 线程**：`viewModelScope` 是 `Dispatchers.Main.immediate`，
   `ApiClient` 是同步 OkHttp —— 仓库层已统一 `withContext(Dispatchers.IO)`，
   新增网络入口时请沿用 `TaskRepository` 的 `onIo { }`，否则会抛 `NetworkOnMainThreadException`
   （表现为"点击毫无反应、网关零请求"）。
6. 前台服务在 Android 13+ 需要 `POST_NOTIFICATIONS` 才能显示通知；**拒绝授权不影响 SSE 保活**，
   只是没有通知（优雅降级）。
7. **模拟器 AVD 是现建的**（`%USERPROFILE%\.android\avd` 原本为空，`emulator -list-avds` 无输出）：
   ```powershell
   $env:JAVA_HOME='D:\Workspace\dsh_android\.toolchain\android-dev\jdk17'
   'no' | & 'D:\Workspace\dsh_android\.toolchain\android-dev\sdk\cmdline-tools\latest\bin\avdmanager.bat' `
     create avd -n dshr_ui -k 'system-images;android-34;google_apis;x86_64' -d pixel_5 --force
   # 无窗口启动（本机 WHPX 可用：emulator -accel-check → WHPX … is installed and usable）
   & 'D:\Workspace\dsh_android\.toolchain\android-dev\sdk\emulator\emulator.exe' `
     -avd dshr_ui -no-snapshot -no-audio -no-boot-anim -no-window -gpu swiftshader_indirect -port 5554
   ```
   启动后 `adb wait-for-device` + 轮询 `getprop sys.boot_completed` 为 `1`，再
   `settings put global window_animation_scale 0`（关闭动画，坐标点击更稳）。AVD 创建时
   `avdmanager` 会报 `SDK XML version 4` 警告，属噪音，不影响创建。
8. **v2 证据脚本的夹具路径由 `-OutDir` 推导**（`$Fixture = Join-Path $OutDir 'mock-tunnel.mjs'`）：
   想把报告输出到别的目录，必须把夹具一起复制过去，否则第一项检查就 `[FAIL] 夹具脚本存在`。
   v3 脚本改为显式参数（默认仍指向 `evidence\v2\mock-tunnel.mjs`），换输出目录不受影响。
9. 脚本中文乱码：仓库里带中文的 `*.ps1`（`run-ui-check.ps1` / `run-markdown-check.ps1`）必须存成
   **UTF-8 with BOM**，否则 PowerShell 5.1 按 ANSI 解析会直接语法错误；`.md` 文档用
   `Get-Content` 读同样会整篇乱码，读文档请用编辑器的 UTF-8 模式或
   `[System.IO.File]::ReadAllText($p, [System.Text.UTF8Encoding]::new($false))`。

