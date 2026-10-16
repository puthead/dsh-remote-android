"""04 手机任务（远程任务提交与历史）"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from proto_kit import *  # noqa
from proto_kit import _shade
import icons

img, d = canvas()
statusbar(d)
appbar(d, "手机任务", "已发起 12 · 默认电脑端执行",
       actions=[("icon", "refresh"), ("icon", "search")])
y = 118 * S

# 新建任务输入卡（折叠态）
card(d, M, y, W - 2 * M, 62 * S, fill=SURFACE_VAR, r=16 * S)
rrect(d, (M + 14 * S, y + 15 * S, M + 46 * S, y + 47 * S), 16 * S, fill=PRIMARY)
icons.icon(d, "plus", M + 30 * S, y + 31 * S, int(9 * S), "#FFFFFF", S)
text(d, M + 58 * S, y + 13 * S, "新建任务", 14 * S, ON_BG, "b")
text(d, M + 58 * S, y + 35 * S, "写一句话，交给电脑端 DSH 执行", 11.5 * S, ON_VAR)
icons.icon(d, "chevron-right", W - M - 22 * S, y + 31 * S, int(7 * S), ON_VAR, S)
y += 74 * S

fx = M
for label, sel in (("全部 12", True), ("运行中 1", False), ("已完成 9", False), ("失败 2", False)):
    cw, ch = chip_solid(d, fx, y, label) if sel else chip(d, fx, y, label)
    fx += cw + 8 * S
y += ch + 14 * S

TASKS = [
    ("run", "运行中", "跑全量单测并汇总失败用例", "dsh_android",
     "已执行 3/8：testDebugUnitTest 进行中…", "耗时 02:14", "输出 18.4 KB", "10-14 09:12"),
    ("done", "已完成", "数据层验证", "dsh_android", "DATA-OK",
     "耗时 3.5s", "exit=0", "10-13 13:18"),
    ("queue", "排队中", "生成周报并导出 Markdown", "dsh_remote", "等待电脑端空闲…",
     "队列第 2 位", "—", "10-14 09:10"),
    ("fail", "失败", "公网联调探针 12 项", "dsh_android",
     "第 7 项超时：wss 握手 10s 未完成", "耗时 41.2s", "exit=1", "10-13 21:04"),
]
STYLE = {"run": (PRIMARY, "live"), "done": (SUCCESS, "ok"), "queue": (ON_VAR, "plain"),
         "fail": (ERROR, "err")}
ROWH = 88 * S
card(d, M, y, W - 2 * M, ROWH * len(TASKS) + (len(TASKS) - 1) * 2, r=16 * S)
ry = y
for i, (kind, badge, title, ws, preview, dur, ex, when) in enumerate(TASKS):
    fg, tone = STYLE[kind]
    pad = 14 * S
    tx = M + pad
    bw = 20 * S + tw(badge, 11 * S) + (12 * S if tone == "live" else 0)
    text(d, tx, ry + 13 * S, ellipsize(title, 14 * S, W - 2 * M - 2 * pad - bw - 10 * S, "b"),
         14 * S, ON_BG, "b")
    chip(d, W - M - pad - bw, ry + 12 * S, badge, fg=fg, bg=_shade(fg, .10, SURFACE),
         border=_shade(fg, .32, SURFACE), icon_dot=LIVE if tone == "live" else None)
    text(d, tx, ry + 40 * S, ellipsize(preview, 12 * S, W - 2 * M - 2 * pad), 12 * S,
         ERROR if kind == "fail" else ON_VAR)
    my = ry + 63 * S
    gw, _ = chip(d, tx, my, ws, size=10, padx=8, h=20, bg=SURFACE_VAR)
    mx = tx + gw + 8 * S
    meta = f"{dur}   ·   {when}"
    text(d, mx, my + 2 * S, ellipsize(meta, 10.5 * S, W - M - pad - mx - 6 * S, "r", True),
         10.5 * S, ON_VAR, "r", mono=True)
    ry += ROWH
    if i < len(TASKS) - 1:
        hline(d, M + pad, ry, W - M - pad, HAIRLINE, 2)
    ry += 2

txt_y = ry + 14 * S
if txt_y + 56 * S <= H - 202 - 12 * S:
    card(d, M, txt_y, W - 2 * M, 52 * S, fill=SURFACE_VAR, r=14 * S)
    icons.icon(d, "warn", M + 24 * S, txt_y + 26 * S, int(8 * S), WARNING, S)
    text(d, M + 42 * S, txt_y + 10 * S, "失败任务可一键重跑或把尾部输出带回会话", 12 * S, ON_BG)
    text(d, M + 42 * S, txt_y + 30 * S, "重跑会复用同一工作区，不覆盖已产生的改动", 11 * S, ON_VAR)

navbar(d, 1)
save(img, "04-手机任务.png")
print("完成 04；列表结束 y=%d" % ry)
