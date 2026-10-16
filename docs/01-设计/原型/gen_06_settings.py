"""06 设置（连接 / 外观 / 后台 / 安全 / 关于）"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from proto_kit import *  # noqa
from proto_kit import _shade
import icons

img, d = canvas()
statusbar(d)
text(d, M, 56 * S, "设置", 22 * S, ON_BG, "b")
y = 118 * S


def section(label, rows, height_fn=None):
    """rows: (kind, label, value, extra)；返回新 y。"""
    global y
    text(d, M + 4 * S, y, label, 11 * S, ON_VAR, "b")
    y += 15 * S
    rowh = 45 * S
    h = rowh * len(rows) + (len(rows) - 1) * 2
    card(d, M, y, W - 2 * M, h, r=16 * S)
    if os.environ.get("PROTO_TRACE"):
        print("  CARD y=%d h=%d rows=%d rowh=%d" % (y, h, len(rows), rowh))
    ry = y
    for i, row in enumerate(rows):
        kind = row[0]
        pad = 14 * S
        icons.icon(d, row[3], M + pad + 9 * S, ry + rowh // 2, int(9 * S), SECONDARY, S)
        col = ERROR if kind == "danger" else ON_BG
        text(d, M + pad + 26 * S, ry + 14 * S, row[1], 13.5 * S, col)
        if kind == "toggle":
            on = row[2]
            tx = W - M - pad - 40 * S
            rrect(d, (tx, ry + rowh // 2 - 11 * S, tx + 40 * S, ry + rowh // 2 + 11 * S), 11 * S,
                  fill=_shade(PRIMARY, .45, SURFACE) if on else SURFACE_HIGH,
                  outline=PRIMARY if on else OUTLINE, width=2)
            knob_x = tx + (22 * S if on else 2 * S)
            dot(d, knob_x + 9 * S, ry + rowh // 2, 9 * S, PRIMARY if on else ON_VAR)
        elif kind == "slider":
            tx = W - M - pad - 74 * S
            text(d, W - M - pad, ry + 15 * S, "14sp", 12.5 * S, ON_VAR, align="r")
            sx = tx - 14 * S
            rrect(d, (sx, ry + rowh // 2 - 3 * S, tx, ry + rowh // 2 + 3 * S), 3 * S,
                  fill=SURFACE_HIGH)
            rrect(d, (sx, ry + rowh // 2 - 3 * S, sx + 42 * S, ry + rowh // 2 + 3 * S), 3 * S,
                  fill=PRIMARY)
            dot(d, sx + 42 * S, ry + rowh // 2, 8 * S, PRIMARY)
        elif kind == "chevron":
            text(d, W - M - pad - 16 * S, ry + 15 * S, row[2], 12.5 * S, ON_VAR, align="r")
            icons.icon(d, "chevron-right", W - M - pad + 2 * S, ry + rowh // 2, int(6 * S),
                       ON_VAR, S)
        else:
            text(d, W - M - pad, ry + 15 * S, row[2], 12.5 * S, ON_VAR, align="r")
        ry += rowh
        if i < len(rows) - 1:
            hline(d, M + pad, ry, W - M - pad, HAIRLINE, 2)
        ry += 2
    y += h + 14 * S


section("连接", [
    ("plain", "中继地址", "wss://relay.example.com", "folder"),
    ("status", "连接状态", "已连接 · 38 ms", "dots-grid"),
    ("plain", "本机设备", "Xiaomi 14 · Android 15", "file"),
    ("plain", "桌面端", "WIN-4FSO92IHDIN · 在线", "cpu"),
])
section("外观", [
    ("toggle", "深色模式", True, "eye"),
    ("toggle", "跟随系统", False, "eye"),
    ("slider", "代码字号", "14sp", "file"),
])
section("通知与后台", [
    ("toggle", "保持隧道常驻（前台服务）", True, "dots-grid"),
])
section("安全", [
    ("chevron", "重新配对（6 位配对码）", "已配对 3 台", "cpu"),
    ("danger", "吊销本机令牌", "", "warn"),
])
section("关于", [
    ("plain", "版本", "v2.5.0 (build 241014)", "file"),
    ("chevron", "导出自检日志", "", "download"),
    ("chevron", "开源许可", "", "file"),
])

navbar(d, 3)
save(img, "06-设置.png")
print("完成 06；内容结束 y=%d" % y)
