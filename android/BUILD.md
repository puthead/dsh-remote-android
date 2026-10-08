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

| 变体 | 路径 | 大小 | sha256 |
|---|---|---|---|
| Release（已签名） | `D:\Workspace\dsh_android\android\app\build\outputs\apk\release\app-release.apk` | `11,598,083` 字节 | `3E4BF6BCE6E338BF4EDDE870D50874D2B00A384AD1677CF219F58C0AA7DA7B49` |
| Debug | `D:\Workspace\dsh_android\android\app\build\outputs\apk\debug\app-debug.apk` | `17,582,755` 字节 | `C859F0D11CFDF5583C7CC2E3BC2D4A4DBCD464591D40F4127D362A336771C3FE` |

Release 包校验结果（实测）：

```
apksigner verify --print-certs app-release.apk        -> exit 0
Signer #1 certificate DN: CN=DSH Remote
Signer #1 certificate SHA-256 digest: e2051854e02a30f2399f2b0e07b556091b886063ffa8e5232bb2eff3141a167b

aapt2 dump badging app-release.apk
package: name='com.deepseek.dshremote' versionCode='1' versionName='1.0.0'
  compileSdkVersion='34' compileSdkVersionCodename='14'
sdkVersion:'26'   targetSdkVersion:'34'
application-label:'DSH 远程'
launchable-activity: name='com.deepseek.dshremote.MainActivity'
```

单元测试（`:app:testDebugUnitTest`，`clean` 后重跑）：**75 个用例全部通过**，覆盖 SSE 分包/转义换行、
事件按 seq 去重排序、`fromSeq` 续传、退避、错误码文案、历史落库与损坏降级。

本地复算命令：

```powershell
Get-FileHash 'D:\Workspace\dsh_android\android\app\build\outputs\apk\release\app-release.apk' -Algorithm SHA256
```

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

