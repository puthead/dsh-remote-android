package com.deepseek.dshremote.ui.screens

import com.deepseek.dshremote.data.api.ChatMessage

/** Reading view only; the original messages and trajectory retain every tool call. */
internal fun conversationMessages(messages: List<ChatMessage>): List<ChatMessage> = messages.mapNotNull { message ->
    val readable = message.copy(
        toolCalls = emptyList(),
        images = (message.images + message.toolCalls.flatMap { it.images }).distinct(),
    )
    readable.takeUnless { it.isEmpty }
}

/** 稳定身份不含列表下标，加载历史时折叠状态仍跟随原消息。 */
internal fun conversationKeys(messages: List<ChatMessage>, streaming: Boolean): List<String> {
    val counts = mutableMapOf<String, Int>()
    return messages.mapIndexed { index, message ->
        val base = if (streaming && index == messages.lastIndex) "live" else
            "${message.role}:${message.seq}:${message.at}"
        val occurrence = counts.getOrDefault(base, 0)
        counts[base] = occurrence + 1
        "$base:$occurrence"
    }
}

/** A tool-only navigation target falls back to visible content in the same turn. */
internal fun conversationTargetIndex(
    visible: List<ChatMessage>, original: List<ChatMessage>, seq: Long,
): Int {
    val exact = visible.indexOfFirst { it.seq == seq }
    if (exact >= 0) return exact
    val target = original.firstOrNull { it.seq == seq } ?: return -1
    return target.turn?.let { turn -> visible.indexOfFirst { it.turn == turn } } ?: -1
}
