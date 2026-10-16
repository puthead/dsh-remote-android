package com.deepseek.dshremote

/**
 * **仅 debug 变体使用**的自动化种子。
 *
 * 存在的理由：真机 UI 自动化必须能指定"中继地址"，而模拟器没有中文输入法、
 * `adb shell input text` 对 `://` 这类字符也不可靠（BUILD.md §7.3）。
 * 于是允许通过启动参数注入一个默认值：
 *
 * ```
 * adb shell am start -n <pkg>/com.deepseek.dshremote.MainActivity \
 *     --es dsh_relay_url ws://10.0.2.2:9543
 * ```
 *
 * 它只影响"填入示例"按钮的默认值，**配对流程本身没有任何特殊路径**：
 * 用户仍然要点「配对并连接」，仍然走 `POST /api/v2/pair/claim` 与真实 WebSocket 握手。
 * release 变体不会读这个 extra（见 MainActivity 的 BuildConfig.DEBUG 判断）。
 */
object DebugSeeds {

    @Volatile
    var relayUrl: String? = null

    @Volatile
    var pairCode: String? = null

    /**
     * "新建任务"对话框里「填入示例」要写的内容。
     *
     * 真机联调时需要**便宜的 prompt**（ASCII 可输入、不触发长时间工具调用），
     * 例如 `--es dsh_task_prompt "reply OK"`。
     */
    @Volatile
    var taskPrompt: String? = null

    fun reset() {
        relayUrl = null
        pairCode = null
        taskPrompt = null
    }
}
