package com.deepseek.dshremote

import android.app.Application
import com.deepseek.dshremote.data.CrashReporter

/**
 * 应用入口。
 *
 * 在 Application 阶段就建好仓库：前台服务的 onStartCommand 可能在 Activity 之后才跑，
 * 如果仓库依赖 Activity 创建，服务重启时会拿到空状态。
 */
class DshRemoteApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // 必须排在 Graph.init 前面：依赖图构造期间的崩溃同样要能取证
        CrashReporter.install(this)
        Graph.init(this)
    }
}
