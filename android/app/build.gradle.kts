plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    // Kotlin 2.0 起 Compose 编译器以独立 Gradle 插件形式发布，必须显式启用
    // （版本目录里 alias 是 kotlin-compose，因此访问器是 libs.plugins.kotlin.compose）
    alias(libs.plugins.kotlin.compose)
}

/**
 * Release 签名口令从仓库内的 keystore.properties 或环境变量读取，不硬编码在构建脚本里。
 * 优先级：keystore.properties > 环境变量（CI/他人复现时用环境变量注入）。
 *
 * 注意两点实现约束：
 * 1) `plugins {}` 必须是脚本里的第一个语句，因此 import 只能写在其后或不写——
 *    这里刻意手写 key=value 解析，避免 `java.util.Properties` 里的裸 `java`
 *    被 Kotlin DSL 解析成 JavaPluginExtension；
 * 2) 只支持无转义的简单 key=value（口令是字母数字，够用）。
 */
val keystoreProperties: Map<String, String> = run {
    val propertiesFile = rootProject.file("keystore/keystore.properties")
    if (!propertiesFile.exists()) {
        emptyMap()
    } else {
        propertiesFile.readLines()
            .map { it.trim() }
            .filter { it.isNotEmpty() && !it.startsWith("#") && it.contains('=') }
            .associate { line ->
                val index = line.indexOf('=')
                line.substring(0, index).trim() to line.substring(index + 1).trim()
            }
    }
}

fun signingValue(key: String, env: String): String? =
    keystoreProperties[key] ?: System.getenv(env)

android {
    namespace = "com.deepseek.dshremote"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.deepseek.dshremote"
        minSdk = 26
        targetSdk = 34
        // 2.7.0：① 工具调用信息默认折叠且压缩成一行、一条助手消息里的连续成功调用合并成
        //        一行汇总行（长会话终于能往回找到上次对话交互）；② 修「工作区里的文件夹点进去
        //        报路径越界」——客户端工作区请求补上 ?workspace=（按绝对路径最长匹配反推），
        //        网关侧同步支持缺 workspace 时按 path 反推（向后兼容旧客户端）；
        //        ③ 稳定性加固：全局未捕获异常处理器 + 崩溃落盘 filesDir/crashes/ + 应用级
        //        CoroutineExceptionHandler + 设置页可见/可导出，新增 scripts/collect-crash.ps1；
        //        ④ 手机端能看到并回答 ask/审批（根因是真机网关进程跑着旧代码，需重启部署）；
        //        ⑤ 子智能体会话默认不在手机列表平铺（按 origin/delegationDepth/parentSession 判定）。
        // 2.7.1：修「刷新失败：电脑离线：中继隧道未连接…」的误报（2026-10-15 真机截图）。手机走蜂窝网时
        //        隧道每 20s~4min 被运营商掐一次（中继日志关闭原因 `code=1006 reason=socket`），
        //        恰好落在重连窗口里的那次下拉刷新会立刻拿到 home_offline 报给用户。四处修：
        //        ① 主动读操作撞上抖动时先等隧道回来（≤20s，初版 12s 经独立核验后上调）再原样重试一次
        //           （TunnelRetry/ConsoleRepository）；
        //        ② waitOnline 不再拿"状态说 Connected 但句柄已经死了"冒充可用（RelayClient 每秒复检）；
        //        ③ 在线判定补上"真的有一条开着的隧道"（relay.isConnected），不再假在线；
        //        ④ 重试成功后立刻清离线态，界面不再挂着"电脑离线"等自愈探测退避。
        // 2.10.0：新建任务不再弹对话框 —— 点「新建任务」直接进 NewTaskScreen（这一屏本身就是对话界面）：
        //        ① 第一句话在该屏底部的输入胶囊里写，写完点发送才开始（不再有「创建并开始」按钮）；
        //        ② 工作区 / 在哪执行 / 模型三段设置都在这一屏里；「仅在手机上执行」打开时才画权限档 ——
        //           旧对话框把权限档画在 host=desktop（权限根本不起作用）的那一边，这次一并纠正，
        //           电脑端执行时改成如实说明「权限跟随电脑端自己的会话设置，手机端指定不了」；
        //        ③ 新增模型选择：GET /api/v2/models 拉目录（旧网关 404 就整块不画），选中后随
        //           POST /api/v2/tasks 带 provider/model/reasoningEffort；网关回 modelApplied=false
        //           时先提示「你选的模型没有生效：<原因>」并要求确认，绝不把没生效当成跑成功。
        //        versionCode 按开发规范 §8.1 每次交付 +1
        versionCode = 12
        versionName = "2.10.0"
        // 设置页展示的协议版本（与契约 §1 的 X-Api-Version 一致）
        buildConfigField("int", "API_VERSION", "2")
    }

    signingConfigs {
        create("release") {
            // 密钥库与本工程同级：D:\Workspace\dsh_android\keystore\dshremote-release.jks
            storeFile = file("../../keystore/dshremote-release.jks")
            storePassword = signingValue("storePassword", "DSHREMOTE_STORE_PASSWORD")
            keyAlias = signingValue("keyAlias", "DSHREMOTE_KEY_ALIAS") ?: "dshremote"
            keyPassword = signingValue("keyPassword", "DSHREMOTE_KEY_PASSWORD")
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            // 用户安装包必须已签名且能通过 apksigner verify；口令来源见 android/BUILD.md
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = false
            // android.jar 是空壳实现：Logger 里的 Log.d 在 JVM 单测中会抛 "not mocked"，
            // 返回默认值即可（真正的 org.json 由 testImplementation 提供，优先级高于空壳）
            isReturnDefaultValues = true
        }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.kotlinx.coroutines.android)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.extended)
    debugImplementation(libs.androidx.compose.ui.tooling)

    implementation(libs.androidx.datastore.preferences)
    implementation(libs.okhttp)
    implementation(libs.okhttp.sse)

    // 相机照片的 EXIF 方向（TAG_ORIENTATION）。androidx.exifinterface 能把方向读出来，
    // 而 android.media.ExifInterface 在 API 28 之前只有 String 版且读不到就抛；
    // 这里直接用字面坐标而不加进 gradle/libs.versions.toml：版本目录是公共文件，
    // 本次改动只允许碰 app/build.gradle.kts，加一条 implementation 不会影响其它模块的解析结果。
    implementation("androidx.exifinterface:exifinterface:1.3.7")

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.json.refimpl)
}
