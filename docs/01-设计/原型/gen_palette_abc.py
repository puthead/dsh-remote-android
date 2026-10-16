# -*- coding: utf-8 -*-
"""配色方向 A/B/C 对照表：用真实组件（会话卡 / 消息气泡 / 工具卡 / 任务清单 / 按钮）
渲染三套视觉语言，供选型。输出 .proto-out/palette-abc.png

方向 A 纯黑极简（ChatGPT / Claude 现行语言）
方向 B 近黑 + 品牌渐变（Gemini 语言）
方向 C 浅色画布（豆包 / Kimi / DeepSeek 语言）
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image, ImageDraw

from proto_kit import S, f_reg, f_bold, f_mono, tw, M
import icons as I

W = 1080
R = 14 * S
PAD = 18 * S


def __mix(a, b, t):
    ah = a.lstrip("#")
    bh = b.lstrip("#")
    return "#%02X%02X%02X" % tuple(
        int(int(ah[i:i + 2], 16) * (1 - t) + int(bh[i:i + 2], 16) * t) for i in (0, 2, 4))


DIRS = [
    dict(key="A", name="A · 纯黑极简", ref="参考 ChatGPT / Claude 现行语言",
         desc="底 #000 真黑 · 面板 #141414 · 白字 #ECECEC；强调色只给「运行中」与主按钮",
         BG="#000000", SURF="#141414", SURF2="#1C1C1E", OUT="#252525",
         FG="#ECECEC", FG2="#B4B4B4", FG3="#7A7A7A",
         ACC="#D97757", ACC2="#E26A4A", GRAD=("#D97757", "#E26A4A"),
         OK="#3FBF7F", WARN="#E0A33E", ERR="#E5484D",
         UBUB="#2A2A2C", ADD=("#0E2A1C", "#8FE0B0"), DEL=("#2E1417", "#F09A9A"),
         CODE="#C9C9C9", TERM="#0A0A0A", CARDBORDER=False),
    dict(key="B", name="B · 近黑 + 品牌渐变", ref="参考 Gemini / 新一代 AI 助手",
         desc="底 #0E0F13 略带蓝 · 品牌蓝紫渐变只出现在进度环、发送键与主按钮",
         BG="#0E0F13", SURF="#17181D", SURF2="#1F2128", OUT="#2A2D36",
         FG="#EDEFF5", FG2="#B9BDC9", FG3="#7D8290",
         ACC="#5B7CFA", ACC2="#4F6BF5", GRAD=("#4F6BF5", "#A855F7"),
         OK="#34C77B", WARN="#E8A93C", ERR="#F0575E",
         UBUB="#252B49", ADD=("#0F2A20", "#7EE2A8"), DEL=("#301519", "#FF9A9A"),
         CODE="#C7CEDA", TERM="#0B0C10", CARDBORDER=False),
    dict(key="C", name="C · 浅色画布", ref="参考 豆包 / Kimi / DeepSeek",
         desc="底 #F7F8FA 浅灰 · 白卡 + 极淡描边 · 深墨字；内容当主角，强调色收敛到一处",
         BG="#F7F8FA", SURF="#FFFFFF", SURF2="#EFF2F6", OUT="#E4E7EC",
         FG="#1A1D21", FG2="#6B7280", FG3="#9AA1AC",
         ACC="#2E6BE6", ACC2="#2E6BE6", GRAD=("#2E6BE6", "#5B8DEF"),
         OK="#18A058", WARN="#D98A00", ERR="#D93A3A",
         UBUB="#E7EFFF", ADD=("#E8F6EE", "#12784A"), DEL=("#FDECEC", "#B03030"),
         CODE="#2B3038", TERM="#F2F4F7", CARDBORDER=True),
]

img = Image.new("RGB", (W, 3080), DIRS[0]["BG"])
d = ImageDraw.Draw(img)
_h = {}


def text(x, y, s, size, color, weight="r", mono=False):
    d.text((x, y), s, font=(f_mono(size) if mono else (f_bold(size) if weight == "b" else f_reg(size))), fill=color)


def rr(box, r, fill=None, outline=None, width=2):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def chip(x, y, label, fg, bg, border=None, size=11, h=26, padx=12, weight="r", mono=False, dot=False):
    w = tw(label, size, weight, mono) + padx * 2 + (20 * S if dot else 0)
    rr((x, y, x + w, y + h), h // 2, fill=bg, outline=border, width=2)
    tx = x + padx
    if dot:
        d.ellipse((tx, y + h // 2 - 4 * S, tx + 8 * S, y + h // 2 + 4 * S), fill=fg)
        tx += 20 * S
    text(tx, y + (h - int(size * 1.32)) // 2 + 1, label, size, fg, weight, mono)
    return w


def grad_pill(x, y, w, h, c1, c2):
    """水平渐变胶囊：逐列求圆角内的 y 范围后画竖线（无需裁剪）。"""
    r = h // 2
    for i in range(w):
        t = i / max(1, w - 1)
        c = __mix(c1, c2, t)
        if i < r:
            dy = r - int((r * r - (r - i) ** 2) ** .5)
        elif i >= w - r:
            k = w - 1 - i
            dy = r - int((r * r - (r - k) ** 2) ** .5)
        else:
            dy = 0
        d.line((x + i, y + dy, x + i, y + h - dy), fill=c)


def wrap_lines(s, size, maxw, weight="r", mono=False, max_lines=2):
    """按像素宽度断行（CJK 逐字，ASCII 单词优先）。"""
    lines, cur = [], ""
    for tok in _tokens(s):
        if tw(cur + tok, size, weight, mono) <= maxw or not cur:
            cur += tok
        else:
            lines.append(cur)
            cur = tok.lstrip()
            if len(lines) == max_lines:
                break
    if cur and len(lines) < max_lines:
        lines.append(cur)
    return lines


def _tokens(s):
    out, buf = [], ""
    for c in s:
        if ord(c) < 128 and not c.isspace():
            buf += c
        else:
            if buf:
                out.append(buf)
                buf = ""
            out.append(c)
    if buf:
        out.append(buf)
    return out


def block(x, y, s, size, maxw, color, weight="r", mono=False, max_lines=3, lh=None):
    """多行文本块，返回占用高度。"""
    lh = lh or int(size * 1.55)
    for i, ln in enumerate(wrap_lines(s, size, maxw, weight, mono, max_lines)):
        text(x, y + i * lh, ln, size, color, weight, mono)
    return lh * len(wrap_lines(s, size, maxw, weight, mono, max_lines))


def section_top(P, top):
    text(M, top, P["name"], 17 * S, P["FG"], "b")
    text(M + tw(P["name"], 17 * S, "b") + 14 * S, top + 5 * S, P["ref"], 11 * S, P["FG2"])
    n = block(M, top + 26 * S, P["desc"], 11 * S, W - M * 2, P["FG3"], max_lines=2)
    return top + 26 * S + n + 24 * S


def card_bg(P, y, h):
    rr((M, y, M + W - M * 2, y + h), R, fill=P["SURF"],
       outline=(P["OUT"] if P["CARDBORDER"] else None), width=2)


def draw_dir(P, top):
    y = section_top(P, top)
    cw = W - M * 2

    # ── 会话卡 ──
    ch = 130 * S
    card_bg(P, y, ch)
    title = "重构 Runner 为八条并发分支"
    text(M + PAD, y + PAD, title, 15 * S, P["FG"], "b")
    chip(M + cw - PAD - 92 * S, y + PAD - 3 * S, "运行中", P["OK"],
         __mix(P["OK"], P["SURF"], .82), size=10, h=24, weight="b", dot=True)
    block(M + PAD, y + PAD + 30 * S, "最后：已把 desktop-api.mjs 的探测改成 session/list，12 项探针全绿",
          11 * S, cw - PAD * 2, P["FG2"], max_lines=2)
    yy = y + PAD + 78 * S
    text(M + PAD, yy, "dsh_android", 11 * S, P["FG2"], mono=True)
    text(M + PAD + 132 * S, yy, "12 轮 · 08:41 · main +3 −1", 11 * S, P["FG3"])
    y += ch + 14 * S

    # ── 用户气泡 + 助手正文 ──
    bub = "把 runner 拆成八条并发分支，各自独立验收。"
    bw, bpad = 660, 30
    blines = wrap_lines(bub, 12 * S, bw - bpad * 2, max_lines=2)
    bh = 14 * S + len(blines) * 21 * S
    rr((M + cw - bw, y, M + cw, y + bh), R, fill=P["UBUB"])
    for i, ln in enumerate(blines):
        text(M + cw - bw + bpad, y + 12 * S + i * 21 * S, ln, 12 * S,
             P["FG"] if P["key"] != "C" else "#12336E")
    y += bh + 14 * S
    apre = "我会先并行拆出八条独立分支，每条一个工作区副本，"
    text(M + PAD, y, apre, 12 * S, P["FG"])
    text(M + PAD, y + 21 * S, "再各自跑单测，最后按 report 汇总。", 12 * S, P["FG"])
    y += 21 * S + 30 * S

    # ── 工具卡：终端 ──
    th = 132 * S
    card_bg(P, y, th)
    d.rounded_rectangle((M, y + 8 * S, M + 3 * S, y + th - 8 * S), radius=2, fill=P["WARN"])
    I.icon(d, "terminal", M + 22 * S, y + 19 * S, 7 * S, P["WARN"], 2)
    text(M + 38 * S, y + 11 * S, "pwsh", 12 * S, P["FG"], "b", mono=True)
    text(M + cw - PAD - tw("28.4s · exit 0", 11 * S, mono=True), y + 13 * S, "28.4s · exit 0", 11 * S, P["OK"], mono=True)
    tr = y + 38 * S
    rr((M + 12 * S, tr, M + cw - 12 * S, tr + 82 * S), 8 * S, fill=P["TERM"])
    text(M + 24 * S, tr + 9 * S, "$ ./gradlew :app:testDebugUnitTest", 11 * S, P["CODE"], mono=True)
    text(M + 24 * S, tr + 30 * S, "> Task :app:testDebugUnitTest", 11 * S, P["CODE"], mono=True)
    text(M + 24 * S, tr + 51 * S, "BUILD SUCCESSFUL in 28s", 11 * S, P["OK"], mono=True)
    y += th + 14 * S

    # ── 工具卡：edit + diff ──
    dh = 104 * S
    card_bg(P, y, dh)
    d.rounded_rectangle((M, y + 8 * S, M + 3 * S, y + dh - 8 * S), radius=2, fill=P["OK"])
    I.icon(d, "file", M + 22 * S, y + 19 * S, 7 * S, P["OK"], 2)
    text(M + 38 * S, y + 11 * S, "edit", 12 * S, P["FG"], "b", mono=True)
    text(M + 94 * S, y + 11 * S, "app/build.gradle.kts", 12 * S, P["FG"], mono=True)
    text(M + cw - PAD - tw("+3 −1", 11 * S, mono=True), y + 13 * S, "+3 −1", 11 * S, P["FG2"], mono=True)
    dy = y + 38 * S
    text(M + 16 * S, dy, "@@ -18,7 +18,9 @@", 11 * S, P["ACC"], mono=True)
    rr((M + 12 * S, dy + 20 * S, M + cw - 12 * S, dy + 38 * S), 4, fill=P["DEL"][0])
    text(M + 24 * S, dy + 22 * S, "−  val ktor = \"2.3.4\"", 11 * S, P["DEL"][1], mono=True)
    rr((M + 12 * S, dy + 40 * S, M + cw - 12 * S, dy + 58 * S), 4, fill=P["ADD"][0])
    text(M + 24 * S, dy + 42 * S, "+  val ktor = \"2.3.7\"", 11 * S, P["ADD"][1], mono=True)
    y += dh + 14 * S

    # ── 任务清单 ──
    lh = 92 * S
    card_bg(P, y, lh)
    text(M + PAD, y + 11 * S, "任务清单", 12 * S, P["FG"], "b")
    text(M + PAD + tw("任务清单", 12 * S, "b") + 12 * S, y + 13 * S, "2/4 · 八条分支验收", 11 * S, P["FG2"])
    rows = [("把 runner 拆成 8 条分支", "ok"), ("各自跑 testDebugUnitTest", "ok"),
            ("合并 8 份 report 模板", "run"), ("跑全量回归并出结论", "wait")]
    ry = y + 36 * S
    for label, st in rows:
        cx, cy = M + PAD + 7 * S, ry + 7 * S
        if st == "ok":
            d.ellipse((cx - 7 * S, cy - 7 * S, cx + 7 * S, cy + 7 * S), fill=P["OK"])
            I.icon(d, "check", cx, cy, 4 * S, "#FFFFFF" if P["key"] == "C" else P["SURF"], 2)
        elif st == "run":
            d.ellipse((cx - 7 * S, cy - 7 * S, cx + 7 * S, cy + 7 * S), outline=P["ACC"], width=3)
            d.ellipse((cx - 3 * S, cy - 3 * S, cx + 3 * S, cy + 3 * S), fill=P["ACC"])
        else:
            d.ellipse((cx - 7 * S, cy - 7 * S, cx + 7 * S, cy + 7 * S), outline=P["FG3"], width=2)
        text(M + PAD + 24 * S, ry - 1 * S, label, 11 * S, P["FG"] if st != "wait" else P["FG3"])
        ry += 15 * S
    y += lh + 16 * S

    # ── 按钮行 ──
    bh2 = 44 * S
    if P["key"] == "B":
        grad_pill(M, y, 200 * S, bh2, P["GRAD"][0], P["GRAD"][1])
    else:
        rr((M, y, M + 200 * S, y + bh2), 10 * S, fill=P["ACC"])
    text(M + 50 * S, y + 12 * S, "提交新任务", 12 * S, "#FFFFFF", "b")
    rr((M + 212 * S, y, M + 348 * S, y + bh2), 10 * S, outline=P["OUT"], width=2)
    text(M + 236 * S, y + 12 * S, "导出轨迹", 12 * S, P["FG"])
    rr((M + 360 * S, y, M + 456 * S, y + bh2), 10 * S, outline=P["ERR"], width=2)
    text(M + 392 * S, y + 12 * S, "停止", 12 * S, P["ERR"])

    # ── 输入条 ──
    y += bh2 + 16 * S
    ih = 46 * S
    rr((M, y, M + cw, y + ih), ih // 2, fill=P["SURF"] if P["key"] == "C" else P["SURF2"],
       outline=(P["OUT"] if P["key"] != "C" else P["OUT"]), width=2)
    text(M + 26 * S, y + 13 * S, "给这个会话发一条消息…", 12 * S, P["FG3"])
    I.icon(d, "clip", M + cw - 78 * S, y + ih // 2, 8 * S, P["FG2"], 2)
    if P["key"] == "B":
        grad_pill(M + cw - 52 * S, y + 5 * S, 46 * S, ih - 10 * S, P["GRAD"][0], P["GRAD"][1])
    else:
        d.ellipse((M + cw - 52 * S, y + 5 * S, M + cw - 6 * S, y + ih - 5 * S), fill=P["ACC"])
    I.icon(d, "arrow-up", M + cw - 29 * S, y + ih // 2, 8 * S, "#FFFFFF", 2)
    return y + ih + 46 * S


# ① 选择要渲染的方向：默认三张合一；PAL_DIR=A|B|C 只渲一张手机比例图
ONLY = os.environ.get("PAL_DIR", "").strip().upper()
sel = [P for P in DIRS if (not ONLY or P["key"] == ONLY)]

# ② 干跑量高
tops = {}
yy = 116 * S
for P in sel:
    h = draw_dir(P, yy)
    tops[P["key"]] = (yy, h)
    yy = h + 46 * S
TOTAL = yy

# ③ 正式渲染：先铺底色再画内容
img = Image.new("RGB", (W, TOTAL), "#0A0A0A")
d = ImageDraw.Draw(img)
if ONLY:
    P = sel[0]
    y0, y1 = tops[P["key"]]
    d.rectangle((0, 0, W, TOTAL), fill=P["BG"])
    draw_dir(P, y0)
    img = img.crop((0, 0, W, y1 + 40 * S)).copy()
    name = "palette-%s.png" % P["key"]
else:
    text(M, 44 * S, "配色方向对照 · 三选一", 22 * S, "#FFFFFF", "b")
    text(M, 76 * S, "同一套组件骨架，三种视觉语言。选定后我据此重渲 6 张原型图。", 11 * S, "#9B9B9B")
    for P in sel:
        y0, y1 = tops[P["key"]]
        d.rectangle((0, y0 - 12 * S, W, y1 + 24 * S), fill=P["BG"])
        draw_dir(P, y0)
        d.line((0, y1 + 24 * S, W, y1 + 24 * S), fill="#2A2A2A", width=3)
    name = "palette-abc.png"

img.save(os.path.join(os.environ.get("PROTO_OUT", "."), name))
print("ok", name, img.size)
