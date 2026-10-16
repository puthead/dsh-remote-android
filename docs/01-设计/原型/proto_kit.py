"""
DSH Remote · 手机端高保真原型渲染器
====================================
用 Pillow 直接绘制 1080x2340 的 Android 界面位图（360dp x 780dp @3x）。
相比 AI 生图，这条路线的中文/代码是逐字精确的，可直接作为实现的视觉基线。

设计令牌与 android/app/src/main/java/.../ui/theme/DarkColors.kt 同源。
"""
from __future__ import annotations

import os
from PIL import Image, ImageDraw, ImageFont

import icons as _icons

# ---------------------------------------------------------------- 环境
OUT_DIR = os.environ.get("PROTO_OUT") or os.path.dirname(os.path.abspath(__file__))
FONT_DIR = r"C:\Windows\Fonts"
S = 3                      # device scale factor：1dp = 3px
W, H = 1080, 2340
M = 20 * S                 # 页面左右边距 20dp

# ---------------------------------------------------------------- 配色
# 方向 A「纯黑极简」（参考 ChatGPT / Claude 现行语言）—— 2025-10 用户选定
# 纯黑底 + 中性灰面板 + 白字，强调色只给「运行中」与主按钮。
# 语义色仅保留：绿=成功/在线、琥珀=等待/警告、红=失败/停止。
BG           = "#000000"
SURFACE      = "#141414"
SURFACE_VAR  = "#1C1C1E"
SURFACE_HIGH = "#242426"
OUTLINE      = "#2A2A2A"
PRIMARY      = "#D97757"
PRIMARY_CTN  = "#3A2318"
SECONDARY    = "#E08B6E"
TERTIARY     = "#E0A33E"
ON_BG        = "#ECECEC"
ON_VAR       = "#B4B4B4"
LIVE         = "#3FBF7F"
SUCCESS      = "#3FBF7F"
WARNING      = "#E0A33E"
ERROR        = "#E5484D"
CODE_FG      = "#C9C9C9"
DARK_TERM    = "#0A0A0A"
ADD_BG, ADD_FG = "#0E2A1C", "#8FE0B0"
DEL_BG, DEL_FG = "#2E1417", "#F09A9A"
HAIRLINE     = "#222222"
NEUTRAL      = "#8A8A8A"   # 中性图标色：非状态类元素一律用它，让强调色稀缺
ACCENT       = "#D97757"   # 强调色：品牌橙（同 PRIMARY）
ON_ACCENT    = "#FFFFFF"   # 强调色实心块上的文字

# ---------------------------------------------------------------- 字体
_cache: dict = {}


def _load(name: str, size: int, index: int = 0) -> ImageFont.FreeTypeFont:
    key = (name, size, index)
    if key not in _cache:
        _cache[key] = ImageFont.truetype(os.path.join(FONT_DIR, name), size, index=index)
    return _cache[key]


def f_reg(px: int):
    """正文/中文：微软雅黑 Regular"""
    return _load("msyh.ttc", px, 0)


def f_bold(px: int):
    """强调：微软雅黑 Bold"""
    return _load("msyhbd.ttc", px, 0)


def f_mono(px: int, bold: bool = False):
    """代码：Consolas（ASCII 极清晰，中文回退到雅黑）"""
    return _load("consolab.ttf" if bold else "consola.ttf", px, 0)


def _is_wide(ch: str) -> bool:
    o = ord(ch)
    return (0x2E80 <= o <= 0x9FFF) or (0xF900 <= o <= 0xFAFF) or (0xFF00 <= o <= 0xFF60) \
        or (0x3000 <= o <= 0x303F) or o in (0x2018, 0x2019, 0x201C, 0x201D, 0x2014, 0x2026, 0x00B7)


def _fp(ch: str, size: int, weight: str, mono: bool):
    if mono:
        return f_mono(size, weight in ("b", "eb")) if not _is_wide(ch) else f_reg(size)
    if weight in ("b", "eb"):
        return f_bold(size)
    return f_reg(size)


def tw(text: str, size: int, weight: str = "r", mono: bool = False) -> int:
    if not text:
        return 0
    w = 0
    for ch in text:
        w += _fp(ch, size, weight, mono).getlength(ch)
    return int(round(w))


def _shade(color: str, pct: float, bg: str) -> str:
    """把 color 以 pct 透明度合成到 bg 上（模拟 10% 透明填充）。"""
    c = tuple(int(color[i:i + 2], 16) for i in (1, 3, 5))
    b = tuple(int(bg[i:i + 2], 16) for i in (1, 3, 5))
    return "#%02X%02X%02X" % tuple(int(round(c[i] * pct + b[i] * (1 - pct))) for i in range(3))


def wrap(text: str, size: int, maxw: int, weight: str = "r", mono: bool = False,
         max_lines: int = 99) -> list[str]:
    """中英混排换行：CJK 逐字断，拉丁按词断。"""
    lines, cur, curw = [], "", 0
    last_space = -1
    for ch in text:
        cw = int(round(_fp(ch, size, weight, mono).getlength(ch)))
        if ch == "\n":
            lines.append(cur); cur, curw, last_space = "", 0, -1
            continue
        if curw + cw > maxw and cur:
            if not _is_wide(ch) and last_space > 0:
                lines.append(cur[:last_space]); cur = cur[last_space + 1:]
                curw = tw(cur, size, weight, mono)
            else:
                lines.append(cur); cur = ""
                curw = 0
            last_space = -1
        if ch == " ":
            last_space = len(cur)
        cur += ch
        curw += cw
    if cur:
        lines.append(cur)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        lines[-1] = lines[-1][:-1] + "…"
    return lines


# ---------------------------------------------------------------- 绘制原语
def text(d: ImageDraw.ImageDraw, x: int, y: int, s: str, size: int, color: str = ON_BG,
         weight: str = "r", mono: bool = False, maxw: int | None = None,
         align: str = "l") -> int:
    """在 (x,y) 左上角画一行文本，返回行高。"""
    f = _fp("中" if not mono else "a", size, weight, mono)
    asc, desc = f.getmetrics()
    if maxw:
        s = ellipsize(s, size, maxw, weight, mono)
    w = tw(s, size, weight, mono)
    px = x
    if align == "c":
        px = x - w // 2
    elif align == "r":
        px = x - w
    cx = px
    for ch in s:
        fc = _fp(ch, size, weight, mono)
        d.text((cx, y), ch, font=fc, fill=color)
        cx += fc.getlength(ch)
    return asc + desc


def ellipsize(s: str, size: int, maxw: int, weight: str = "r", mono: bool = False) -> str:
    if tw(s, size, weight, mono) <= maxw:
        return s
    out = ""
    for ch in s:
        if tw(out + ch + "…", size, weight, mono) > maxw:
            break
        out += ch
    # 结束时再核一次：截断点选出的字符可能让「…」越界，此时继续回退
    while out and tw(out + "…", size, weight, mono) > maxw:
        out = out[:-1]
    return out + "…"


def fit(s: str, x_left: int, x_right: int, size: int, weight: str = "r",
        mono: bool = False) -> str:
    """把 s 截断到 [x_left, x_right) 宽度内，超出加省略号。

    用于「右侧还有别的东西」的行（如卡片标题 + 状态 chip），避免文字压到右侧元素。
    """
    return ellipsize(s, size, max(0, x_right - x_left), weight, mono)


def para(d, x, y, s, size, color=ON_VAR, weight="r", mono=False, maxw=None,         lh=1.5, max_lines=99) -> int:
    """多行段落，返回总高。"""
    if not maxw:
        maxw = W - 2 * M
    lines = wrap(s, size, maxw, weight, mono, max_lines)
    step = int(size * lh)
    for i, ln in enumerate(lines):
        text(d, x, y + i * step, ln, size, color, weight, mono)
    return step * len(lines)


def rrect(d, box, r, fill=None, outline=None, width=2):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def card(d, x, y, w, h, fill=SURFACE, outline=OUTLINE, r=16 * S, border=2):
    rrect(d, (x, y, x + w, y + h), r, fill=fill,
          outline=outline if border else None, width=border)


def dot(d, cx, cy, r, color):
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color)


def chip(d, x, y, label, fg=ON_VAR, bg=SURFACE_VAR, border=OUTLINE, size=11,
         padx=9, h=24, mono=False, weight="r", icon_dot=None) -> tuple[int, int]:
    """胶囊标签，返回 (宽, 高)。h/dp 单位。"""
    size *= S; padx *= S; h *= S
    dotw = 0
    if icon_dot:
        dotw = 7 * S + 5 * S
    w = padx * 2 + tw(label, size, weight, mono) + dotw
    rrect(d, (x, y, x + w, y + h), h // 2, fill=bg,
          outline=border if border else None, width=2)
    cx = x + padx
    if icon_dot:
        dot(d, cx + 4 * S, y + h // 2, 4 * S, icon_dot)
        cx += dotw
    f = _fp("中", size, weight, mono)
    asc, desc = f.getmetrics()
    th = asc + desc
    text(d, cx, y + (h - th) // 2, label, size, fg, weight, mono)
    return w, h


def chip_solid(d, x, y, label, fg="#FFFFFF", bg=PRIMARY, size=11, padx=10, h=24,
               weight="b") -> tuple[int, int]:
    size *= S; padx *= S; h *= S
    w = padx * 2 + tw(label, size, weight)
    rrect(d, (x, y, x + w, y + h), h // 2, fill=bg)
    f = _fp("中", size, weight, False)
    asc, desc = f.getmetrics()
    text(d, x + padx, y + (h - asc - desc) // 2, label, size, fg, weight)
    return w, h


def hline(d, x1, y, x2, color=OUTLINE, width=2):
    d.line((x1, y, x2, y), fill=color, width=width)


def vline(d, x, y1, y2, color=OUTLINE, width=2):
    d.line((x, y1, x, y2), fill=color, width=width)


def tool_frame(d, x, y, w, h, edge, kind_icon, name, right=None, right_color=ON_VAR,
               edge_colors=(WARNING, SUCCESS, SECONDARY)):
    """工具调用卡外壳：左侧彩色边 + 图标 + 等宽工具名 + 右侧统计。"""
    ec = {"amber": edge_colors[0], "green": edge_colors[1], "indigo": edge_colors[2]}[edge]
    rrect(d, (x, y, x + w, y + h), 14 * S, fill=SURFACE, outline=OUTLINE, width=2)
    d.rounded_rectangle((x, y + 2, x + w, y + h - 2), radius=14 * S, outline=None)
    d.rectangle((x + 1, y + 14 * S, x + 4 * S, y + h - 14 * S), fill=ec)
    _icons.icon(d, kind_icon, x + 22 * S, y + 19 * S, int(8 * S), ec, S)
    text(d, x + 36 * S, y + 10 * S, name, 12 * S, ON_BG, "b", mono=True)
    if right:
        text(d, x + w - 12 * S, y + 11 * S, right, 11 * S, right_color, "r", mono=True,
             align="r")


# ---------------------------------------------------------------- 通用骨架
def statusbar(d):
    text(d, M, 14 * S, "9:41", 12 * S, ON_BG, "b")
    # 信号 / wifi / 电量
    x = W - M
    x -= 26 * S
    rrect(d, (x, 17 * S, x + 22 * S, 31 * S), 3 * S, fill=None, outline=ON_VAR, width=2)
    d.rectangle((x + 22 * S, 21 * S, x + 24 * S, 27 * S), fill=ON_VAR)
    d.rectangle((x + 3 * S, 20 * S, x + 13 * S, 28 * S), fill=LIVE)
    x -= 20 * S
    for i, r in enumerate((3, 6, 9)):
        d.arc((x - r, 30 * S - r, x + r, 30 * S + r), 225, 315, fill=ON_VAR, width=2)
    x -= 26 * S
    for i, bh in enumerate((6, 10, 14)):
        d.rectangle((x + i * 7 * S, 30 * S - bh - 3 * S, x + i * 7 * S + 4 * S, 30 * S - 4 * S),
                    fill=ON_VAR if i < 2 else _shade(LIVE, .8, BG))
    text(d, W - M, 14 * S, "5G", 11 * S, ON_VAR, "r", align="r")


def iconbtn(d, x, y, name, size=36, color=ON_VAR, border=OUTLINE, bg=SURFACE):
    """36dp 圆形图标按钮，返回宽高。"""
    size *= S
    rrect(d, (x, y, x + size, y + size), size // 2, fill=bg,
          outline=border if border else None, width=2)
    _icons.icon(d, name, x + size // 2, y + size // 2, int(size * 0.26), color, S)
    return size, size


def navbar(d, active: int):
    y0 = H - 202
    d.rectangle((0, y0, W, H), fill=SURFACE)
    hline(d, 0, y0, W)
    tabs = (("dots-grid", "电脑会话"), ("file", "手机任务"), ("folder", "工作区"), ("gear", "设置"))
    cw = W // 4
    for i, (iconname, label) in enumerate(tabs):
        cx = cw * i + cw // 2
        on = i == active
        col = PRIMARY if on else ON_VAR
        if on:
            rrect(d, (cx - 17 * S, y0 + 12 * S, cx + 17 * S, y0 + 46 * S), 10 * S,
                  fill=_shade(PRIMARY, .18, SURFACE))
        _icons.icon(d, iconname, cx, y0 + 29 * S, int(11 * S), col, S)
        text(d, cx, y0 + 52 * S, label, 11 * S, col, "b" if on else "r", align="c")


def appbar(d, title, sub=None, actions=(), y=56 * S):
    text(d, M, y, title, 22 * S, ON_BG, "b")
    yy = y + 34 * S
    if sub:
        yy += para(d, M, yy, sub, 12 * S, ON_VAR, maxw=W - 2 * M - 130 * S, max_lines=1) - 18 * S
    ax = W - M
    for kind, name in reversed(actions):
        ax -= 36 * S
        if kind == "solid":
            iconbtn(d, ax, y + 2 * S, name, color="#FFFFFF", border=None, bg=PRIMARY)
        elif kind == "danger":
            iconbtn(d, ax, y + 2 * S, name, color=ERROR, border=ERROR, bg=SURFACE)
        else:
            iconbtn(d, ax, y + 2 * S, name)
        ax -= 6 * S
    return yy


def banner(d, x, y, w, label, right=None, tone="ok", h=42):
    h *= S
    tones = {"ok": (LIVE, .09, .28), "warn": (WARNING, .09, .28), "err": (ERROR, .09, .28),
             "info": (SECONDARY, .09, .28)}
    c, f, b = tones[tone]
    rrect(d, (x, y, x + w, y + h), 12 * S, fill=_shade(c, f, BG), outline=_shade(c, b, BG), width=2)
    dot(d, x + 17 * S, y + h // 2, 5 * S, c)
    text(d, x + 30 * S, y + 10 * S, label, 12 * S, ON_BG)
    if right:
        cw, _ = chip(d, x + w - 12 * S - tw(right, 11 * S) - 20 * S - 14 * S, y + 9 * S, right,
                     fg=c, bg=_shade(c, .10, BG), border=_shade(c, .3, BG), weight="b")
    return h


def save(img: Image.Image, name: str):
    os.makedirs(OUT_DIR, exist_ok=True)
    p = os.path.join(OUT_DIR, name)
    img.save(p, "PNG")
    print(f"  -> {p}  {img.size[0]}x{img.size[1]}")
    return p


def canvas():
    img = Image.new("RGB", (W, H), BG)
    return img, ImageDraw.Draw(img)


if __name__ == "__main__":
    print("proto_kit: 渲染原语就绪（1080x2340, 1dp=3px）")
