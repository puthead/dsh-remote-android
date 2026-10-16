"""03 执行轨迹（对应桌面端 conversation.view 的 trajectory 页签）"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from proto_kit import *  # noqa
from proto_kit import _shade, fit
import icons

img, d = canvas()
statusbar(d)

y = 58 * S
icons.icon(d, "arrow-left", M + 12 * S, y + 16 * S, int(12 * S), ON_BG, S)
text(d, M + 34 * S, y - 2 * S, "执行轨迹", 17 * S, ON_BG, "b")
text(d, M + 34 * S, y + 24 * S, "第 12–13 轮 · 共 47 步 · 6 次工具调用", 11 * S, ON_VAR)
iconbtn(d, W - M - 80 * S, y - 2 * S, "filter")
iconbtn(d, W - M - 36 * S, y - 2 * S, "download")
y += 58 * S

# 视图页签（与桌面端一致：对话 / 轨迹）
tw_ = tw("对话", 13 * S, "b") + 40 * S
rrect(d, (M, y, M + 168 * S, y + 34 * S), 17 * S, fill=SURFACE_VAR, outline=OUTLINE, width=2)
text(d, M + 20 * S, y + 8 * S, "对话", 13 * S, ON_VAR)
rrect(d, (M + 84 * S, y + 2 * S, M + 168 * S, y + 32 * S), 15 * S, fill=PRIMARY)
text(d, M + 126 * S, y + 8 * S, "轨迹", 13 * S, "#FFFFFF", "b", align="c")
y += 46 * S

# 轮次进度条
steps = 12
track_x0, track_x1 = M + 10 * S, W - M - 10 * S
vline(d, track_x0, y + 16 * S, track_x1, OUTLINE, 4)
cur = 9
d.line((track_x0, y + 16 * S, track_x0 + (track_x1 - track_x0) * cur / (steps - 1), y + 16 * S),
       fill=NEUTRAL, width=4)
for i in range(steps):
    px = int(track_x0 + (track_x1 - track_x0) * i / (steps - 1))
    if i < cur:
        dot(d, px, y + 16 * S, 5 * S, NEUTRAL)
    elif i == cur:
        dot(d, px, y + 16 * S, 8 * S, PRIMARY)
        d.ellipse((px - 13 * S, y + 3 * S, px + 13 * S, y + 29 * S), outline=PRIMARY, width=2)
    else:
        dot(d, px, y + 16 * S, 4 * S, SURFACE_HIGH)
cw_, ch_ = chip(d, M, y + 30 * S, "第 13 轮", fg="#FFFFFF", bg=PRIMARY, border=None,
                weight="b")
y += 30 * S + ch_ + 12 * S

# ---------------- 步骤时间线
STEPS = [
    ("think", "思考", "8 条分支的验收脚本对齐同一份模板", "1.2s", "1.8k tok"),
    ("pwsh", "pwsh", "./gradlew :app:testDebugUnitTest", "28.4s", "exit 0"),
    ("edit", "edit  app/build.gradle.kts", "+3 −1", "412ms", "文件已写入"),
    ("read", "read  ConsoleRepository.kt", "4.1 KB", "88ms", "48 行"),
    ("grep", "grep  \"session/prompt\"", "lib/**", "1.4s", "18 处命中"),
    ("approve", "需要批准", "pwsh  git push --force-with-lease origin main", "", ""),
    ("end", "turn ended · completed", "turns 12→13 · 解码 tokens 18.4k", "02:14", ""),
]
ICON = {"think": ("dots-grid", PRIMARY), "pwsh": ("terminal", WARNING),
        "edit": ("file", SUCCESS), "read": ("eye", NEUTRAL), "grep": ("search", NEUTRAL),
        "approve": ("warn", WARNING), "end": ("check", SUCCESS)}

rail_x = M + 20 * S
y0 = y
first = True
L, R = 6 * S, 10 * S          # 卡片与图标的水平留白（左侧）/ 右侧留白
for kind, name, detail, dur, note in STEPS:
    cardh = 44 * S if kind != "approve" else 88 * S
    if y + cardh > H - 202 - 62 * S:
        break
    ic, col = ICON[kind]
    if not first:
        vline(d, rail_x, y - 8 * S, y + 7 * S, OUTLINE, 2)
    first = False
    if kind == "approve":
        d.ellipse((rail_x - 8 * S, y + 12 * S, rail_x + 8 * S, y + 28 * S),
                  fill=_shade(WARNING, .18, BG), outline=WARNING, width=2)
    elif kind == "end":
        d.ellipse((rail_x - 8 * S, y + 12 * S, rail_x + 8 * S, y + 28 * S), fill=SUCCESS)
    else:
        d.ellipse((rail_x - 8 * S, y + 12 * S, rail_x + 8 * S, y + 28 * S),
                  fill=SURFACE_VAR, outline=OUTLINE, width=2)
    icons.icon(d, ic, rail_x, y + 20 * S, int(5 * S),
               "#06130D" if kind == "end" else col, S)

    cx0, cwid = rail_x + 18 * S, W - M - (rail_x + 18 * S)
    if kind == "approve":
        rrect(d, (cx0, y, cx0 + cwid, y + cardh), 14 * S, fill=_shade(WARNING, .10, BG),
              outline=_shade(WARNING, .45, BG), width=2)
        text(d, cx0 + 14 * S, y + 10 * S, "需要批准", 13 * S, WARNING, "b")
        text(d, cx0 + 14 * S, y + 32 * S,
             fit("pwsh · git push --force-with-lease origin main", cx0 + 14 * S,
                 cx0 + cwid - 14 * S, 11 * S, "r", True),
             11 * S, CODE_FG, "r", mono=True)
        bw = 100 * S
        rrect(d, (cx0 + 14 * S, y + 54 * S, cx0 + 14 * S + bw, y + 84 * S), 15 * S, fill=PRIMARY)
        text(d, cx0 + 14 * S + bw // 2, y + 62 * S, "允许一次", 12 * S, "#FFFFFF", "b", align="c")
        rrect(d, (cx0 + 20 * S + bw, y + 54 * S, cx0 + 20 * S + bw + 74 * S, y + 84 * S), 15 * S,
              fill=SURFACE_VAR, outline=OUTLINE, width=2)
        text(d, cx0 + 20 * S + bw + 37 * S, y + 62 * S, "拒绝", 12 * S, ON_VAR, align="c")
    else:
        card(d, cx0, y, cwid, cardh, r=14 * S)
        # 右侧数字/备注先按真实宽度定界，正文再截到它左边，避免压字
        rw = max(tw(dur, 11 * S, "r", True) if dur else 0,
                 tw(note, 11 * S, "r", True) if note else 0)
        lim = cx0 + cwid - R - rw - 6 * S
        text(d, cx0 + 14 * S, y + 8 * S,
             fit(name, cx0 + 14 * S, lim, 12.5 * S, "b",
                 mono=(kind in ("pwsh", "edit", "read", "grep"))),
             12.5 * S, ON_BG, "b", mono=(kind in ("pwsh", "edit", "read", "grep")))
        text(d, cx0 + 14 * S, y + 27 * S,
             fit(detail, cx0 + 14 * S, lim, 11 * S, "r",
                 mono=(kind in ("pwsh", "edit", "read", "grep"))),
             11 * S, ON_VAR, "r", mono=(kind in ("pwsh", "edit", "read", "grep")))
        if dur:
            text(d, cx0 + cwid - R, y + 8 * S, dur, 11 * S,
                 SUCCESS if note == "exit 0" else ON_VAR, "r", mono=True, align="r")
        if note:
            text(d, cx0 + cwid - R, y + 27 * S, note, 11 * S, ON_VAR, "r", mono=True,
                 align="r")
    y += cardh + 6 * S

# ---------------- 底部汇总条
by = H - 202 - 64 * S
rrect(d, (M, by, W - M, by + 58 * S), 18 * S, fill=SURFACE_VAR, outline=OUTLINE, width=2)
stats = (("47", "步数"), ("6", "工具调用"), ("02:14", "用时"))
sw_ = (W - 2 * M) // 3
for i, (v, k) in enumerate(stats):
    cxx = M + sw_ * i + sw_ // 2
    text(d, cxx, by + 9 * S, v, 16 * S, ON_BG, "b", align="c")
    text(d, cxx, by + 34 * S, k, 11 * S, ON_VAR, align="c")
    if i:
        vline(d, M + sw_ * i, by + 12 * S, by + 46 * S, OUTLINE, 2)

navbar(d, 0)
save(img, "03-执行轨迹.png")
print("完成 03；内容结束 y=%d，汇总条 y=%d" % (y, by))
