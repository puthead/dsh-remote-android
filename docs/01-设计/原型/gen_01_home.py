"""01 电脑会话（配对后首页）"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from proto_kit import *  # noqa
from proto_kit import _shade
import icons

img, d = canvas()
statusbar(d)
appbar(d, "DSH 远程", "WIN-4FSO92IHDIN · 已连接",
       actions=[("icon", "refresh"), ("icon", "search")])

y = 118 * S
banner(d, M, y, W - 2 * M, "桌面端 DSH 在线 · 隧道正常", right="38 ms", tone="ok")
y += 54 * S

fx = M
for label, sel in (("全部 17", True), ("进行中 1", False), ("手机发起 4", False), ("只读 2", False)):
    cw, ch = chip_solid(d, fx, y, label) if sel else chip(d, fx, y, label)
    fx += cw + 8 * S
y += ch + 14 * S

sessions = [
    ("重构 Runner 为八条并发分支", "live", "运行中",
     "最后：已把 desktop-api.mjs 的探测改成 session/list，正在跑单测…",
     "dsh_android", "12 轮", "08:41", "main +3 −1"),
    ("网关看门狗与免管理员自启验证", "ok", "可续聊",
     "最后：杀进程 ≤20 秒自愈，verify.ps1 PASS=4 / FAIL=0",
     "dsh_remote", "7 轮", "昨天 22:14", None),
    ("DSH Remote v2.5.0 公网联调", "ok", "可续聊",
     "最后：wss://IP:9443 配对成功，探针 12/12 通过",
     "dsh_android", "23 轮", "昨天 20:52", "main +18 −4"),
    ("分析 session.v4 帧边界", "plain", "只读",
     "最后：截断帧不会抛错，必须先做结构判定再解压",
     "dsh_android", "5 轮", "10-13 17:03", None),
    ("手机端对话气泡配色微调", "plain", "只读",
     "最后：气泡改用 #3A2318，与强调色同族",
     "dsh_android", "3 轮", "10-12 11:26", None),
]

ROWH = 92 * S
listcard_y = y
cx, cw = M, W - 2 * M
total = ROWH * len(sessions) + (len(sessions) - 1) * 2
card(d, cx, listcard_y, cw, total, r=16 * S)

ry = listcard_y
for i, (title, tone, badge, preview, ws, turns, when, git) in enumerate(sessions):
    pad = 14 * S
    tx = cx + pad
    styles = {"live": (LIVE, _shade(LIVE, .10, SURFACE), _shade(LIVE, .35, SURFACE)),
              "ok": (SUCCESS, _shade(SUCCESS, .10, SURFACE), _shade(SUCCESS, .35, SURFACE)),
              "plain": (ON_VAR, SURFACE_VAR, OUTLINE)}[tone]
    bw = 20 * S + tw(badge, 11 * S) + (12 * S if tone == "live" else 0)
    text(d, tx, ry + 15 * S, ellipsize(title, 14 * S, cw - 2 * pad - bw - 10 * S, "b"),
         14 * S, ON_BG, "b")
    chip(d, cx + cw - pad - bw, ry + 14 * S, badge, fg=styles[0], bg=styles[1], border=styles[2],
         icon_dot=LIVE if tone == "live" else None)
    text(d, tx, ry + 44 * S, ellipsize(preview, 12 * S, cw - 2 * pad), 12 * S, ON_VAR)
    my = ry + 68 * S
    gw, _ = chip(d, tx, my, ws, size=10, padx=8, h=20, bg=SURFACE_VAR)
    mx = tx + gw + 8 * S
    meta = f"{turns}   ·   {when}"
    text(d, mx, my + 2 * S, meta, 11 * S, ON_VAR, "r", mono=True)
    if git:
        mx += tw(meta, 11 * S, "r", True) + 8 * S
        icons.icon(d, "branch", mx + 7 * S, my + 10 * S, int(6 * S), ON_VAR, S)
        text(d, mx + 18 * S, my + 2 * S, git, 11 * S, ON_VAR, "r", mono=True)
    ry += ROWH
    if i < len(sessions) - 1:
        hline(d, cx + pad, ry, cx + cw - pad, HAIRLINE, 2)
    ry += 2

by = listcard_y + total
if by + 12 * S + 40 * S <= H - 202 - 12 * S:
    by += 12 * S
    card(d, M, by, W - 2 * M, 40 * S, fill=SURFACE_VAR, r=12 * S)
    text(d, M + 14 * S, by + 11 * S, "已加载 5 / 17 条 · 上拉取更早", 12 * S, ON_VAR)
    text(d, W - M - 14 * S, by + 11 * S, "更新于 08:42", 12 * S, ON_VAR, align="r")
else:
    by = by - 40 * S  # 只用于诊断输出

# FAB（浮在列表右下，避开底部导航）
fab_cx, fab_cy, fab_r = W - M - 28 * S, H - 202 - 16 * S - 28 * S, 28 * S
d.ellipse((fab_cx - fab_r, fab_cy - fab_r, fab_cx + fab_r, fab_cy + fab_r), fill=PRIMARY)
icons.icon(d, "plus", fab_cx, fab_cy, int(13 * S), "#FFFFFF", S)

navbar(d, 0)
save(img, "01-电脑会话.png")
print("完成 01（内容底边 %d, 导航起始 %d）" % (by + 40 * S, H - 202))
