package com.deepseek.dshremote

import android.app.Application

/**
 * 应用入口。
 *
 * 在 Application 阶段就建好仓库：前台服务的 onStartCommand 可能在 Activity 之后才跑，
 * 如果仓库依赖 Activity 创建，服务重启时会拿到空状态。
 */
class DshRemoteApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Graph.init(this)
    }
}
