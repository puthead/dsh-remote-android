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
        versionCode = 1
        versionName = "1.0.0"
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

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.json.refimpl)
}
