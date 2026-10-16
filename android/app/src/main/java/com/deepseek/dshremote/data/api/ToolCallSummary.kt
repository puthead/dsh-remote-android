package com.deepseek.dshremote.data.api

import org.json.JSONArray
import org.json.JSONObject

/**
 * 工具调用参数的"一句话摘要"。
 *
 * 折叠态只显示一行，因此必须挑最有信息量的那个参数：`command` > `path` > `file` > `query` …
 * 纯函数，可单测（工具卡片的可读性完全取决于这里）。
 */
object ToolCallSummary {

    private val PREFERRED_KEYS = listOf(
        "command", "cmd", "path", "file", "filePath", "query", "q", "pattern",
        "url", "prompt", "content", "text", "name", "id",
    )

    fun summarize(name: String, argsJson: String): String {
        val obj = runCatching { JSONObject(argsJson) }.getOrNull()
            ?: return argsJson.trim().take(120)
        if (obj.length() == 0) return name
        for (key in PREFERRED_KEYS) {
            if (obj.has(key) && !obj.isNull(key)) {
                val raw = obj.opt(key)
                val text = when (raw) {
                    is JSONArray -> raw.toString()
                    is JSONObject -> raw.toString()
                    else -> raw.toString()
                }
                if (text.isNotBlank()) return text.replace('\n', ' ').take(200)
            }
        }
        // 兜底：取第一个字段
        val firstKey = obj.keys().asSequence().firstOrNull() ?: return name
        return "${firstKey}=${obj.opt(firstKey)}".replace('\n', ' ').take(200)
    }

    /** 展开态显示：格式化后的 JSON（缩进 2 空格）。 */
    fun pretty(argsJson: String): String {
        val obj = runCatching { JSONObject(argsJson) }.getOrNull() ?: return argsJson
        return runCatching { obj.toString(2) }.getOrDefault(argsJson)
    }
}

/**
 * 从对话消息里投影"待办列表"。
 *
 * 契约的 transcript 里没有独立的 `todos` 字段（§4.2 只有 text/toolCalls/deliverables），
 * 而 todo 类工具的**参数**里就是待办本身；这里把它提出来供 UI 顶部展示。
 * 取**最后一条**含待办的调用（后面的调用是更权威的状态）。
 */
object TodoExtractor {

    private val TODO_TOOLS = setOf("todo", "todos", "todowrite", "write_todos", "update_todos", "plan")

    fun fromMessages(messages: List<ChatMessage>): List<TodoItem> {
        // 1) 优先用系统消息里的 todos（gateway-dev 确认的权威形状）
        for (message in messages.asReversed()) {
            if (message.todos.isNotEmpty()) return message.todos
        }
        // 2) 兼容"待办写在 todo 类工具调用的参数里"的形状
        for (message in messages.asReversed()) {
            for (call in message.toolCalls.asReversed()) {
                val items = fromToolCall(call)
                if (items.isNotEmpty()) return items
            }
        }
        return emptyList()
    }

    fun fromToolCall(call: ToolCall): List<TodoItem> {
        val args = call.args ?: return emptyList()
        val array = args.optJSONArray("todos")
            ?: args.optJSONArray("items")
            ?: args.optJSONArray("tasks")
            ?: return emptyList()
        val result = ArrayList<TodoItem>(array.length())
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            val text = item.optString("content", "")
                .ifEmpty { item.optString("text", "") }
                .ifEmpty { item.optString("title", "") }
                .ifEmpty { item.optString("task", "") }
            if (text.isEmpty()) continue
            val status = item.optString("status", item.optString("state", "pending"))
            result += TodoItem(text = text, status = status)
        }
        return result
    }

    /** 声明的工具名是否属于待办类（UI 用来决定要不要画勾选样式）。 */
    fun isTodoTool(name: String): Boolean = TODO_TOOLS.contains(name.lowercase())
}
