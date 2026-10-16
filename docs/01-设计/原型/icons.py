"""矢量图标库：全部用几何原语绘制，避免字体缺字（豆腐块）。"""
from PIL import ImageDraw

LW = 2  # 描边宽度（缩放后）


def _lw(s):
    return max(2, int(round(1.8 * s)))


def icon(d: ImageDraw.ImageDraw, name: str, cx: int, cy: int, r: int, color: str, s: int):
    """在 (cx,cy) 为中心、半径 r 的方框内绘制图标。s 为缩放系数。"""
    w = _lw(s)
    if name == "search":
        rr = int(r * 0.62)
        d.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), outline=color, width=w)
        d.line((cx + rr * 0.7, cy + rr * 0.7, cx + r * 0.95, cy + r * 0.95), fill=color, width=w)
    elif name == "refresh":
        rr = int(r * 0.72)
        d.arc((cx - rr, cy - rr, cx + rr, cy + rr), 40, 320, fill=color, width=w)
        ax, ay = cx + rr * 0.78, cy - rr * 0.62
        d.polygon([(ax, ay - int(r * .34)), (ax + int(r * .36), ay - int(r * .04)),
                   (ax - int(r * .06), ay + int(r * .1))], fill=color)
    elif name == "filter":
        d.line((cx - r * .8, cy - r * .55, cx + r * .8, cy - r * .55), fill=color, width=w)
        d.line((cx - r * .45, cy, cx + r * .45, cy), fill=color, width=w)
        d.line((cx - r * .18, cy + r * .55, cx + r * .18, cy + r * .55), fill=color, width=w)
    elif name == "download":
        d.line((cx, cy - r * .85, cx, cy + r * .25), fill=color, width=w)
        d.polygon([(cx - r * .42, cy - r * .05), (cx + r * .42, cy - r * .05), (cx, cy + r * .5)],
                  fill=color)
        d.line((cx - r * .8, cy + r * .8, cx + r * .8, cy + r * .8), fill=color, width=w)
    elif name == "stop":
        rr = int(r * .62)
        d.rounded_rectangle((cx - rr, cy - rr, cx + rr, cy + rr), radius=int(r * .18), fill=color)
    elif name == "more":
        for dx in (-r * .55, 0, r * .55):
            d.ellipse((cx + dx - w, cy - w, cx + dx + w, cy + w), fill=color)
    elif name == "chevron-right":
        d.line((cx - r * .28, cy - r * .55, cx + r * .3, cy), fill=color, width=w)
        d.line((cx + r * .3, cy, cx - r * .28, cy + r * .55), fill=color, width=w)
    elif name == "chevron-down":
        d.line((cx - r * .55, cy - r * .25, cx, cy + r * .3), fill=color, width=w)
        d.line((cx, cy + r * .3, cx + r * .55, cy - r * .25), fill=color, width=w)
    elif name == "branch":
        d.line((cx - r * .5, cy - r * .7, cx - r * .5, cy + r * .2), fill=color, width=w)
        d.line((cx - r * .5, cy - r * .1, cx + r * .45, cy - r * .1), fill=color, width=w)
        d.line((cx + r * .45, cy - r * .1, cx + r * .45, cy + r * .35), fill=color, width=w)
        d.ellipse((cx - r * .72, cy - r * .95, cx - r * .28, cy - r * .51), outline=color, width=w)
        d.ellipse((cx + r * .23, cy - r * .35, cx + r * .67, cy + r * .09), outline=color, width=w)
        d.ellipse((cx - r * .72, cy + r * .25, cx - r * .28, cy + r * .69), outline=color, width=w)
    elif name == "terminal":
        d.rounded_rectangle((cx - r * .9, cy - r * .7, cx + r * .9, cy + r * .7),
                            radius=int(r * .3), outline=color, width=w)
        d.line((cx - r * .45, cy - r * .22, cx - r * .12, cy + r * .06), fill=color, width=w)
        d.line((cx - r * .12, cy + r * .06, cx - r * .45, cy + r * .34), fill=color, width=w)
        d.line((cx + r * .02, cy + r * .34, cx + r * .42, cy + r * .34), fill=color, width=w)
    elif name == "file":
        d.rounded_rectangle((cx - r * .62, cy - r * .8, cx + r * .62, cy + r * .8),
                            radius=int(r * .22), outline=color, width=w)
        for dy in (-r * .3, 0, r * .3):
            d.line((cx - r * .3, cy + dy, cx + r * .3, cy + dy), fill=color, width=w)
    elif name == "image":
        d.rounded_rectangle((cx - r * .85, cy - r * .68, cx + r * .85, cy + r * .68),
                            radius=int(r * .24), outline=color, width=w)
        d.ellipse((cx - r * .5, cy - r * .42, cx - r * .2, cy - r * .12), fill=color)
        d.polygon([(cx - r * .6, cy + r * .48), (cx - r * .05, cy - r * .12),
                   (cx + r * .62, cy + r * .48)], fill=color)
    elif name == "folder":
        d.rounded_rectangle((cx - r * .9, cy - r * .55, cx + r * .9, cy + r * .62),
                            radius=int(r * .22), outline=color, width=w)
        d.line((cx - r * .9, cy - r * .3, cx - r * .22, cy - r * .3), fill=color, width=w)
        d.line((cx - r * .22, cy - r * .55, cx - r * .22, cy - r * .3), fill=color, width=w)
    elif name == "plus":
        d.line((cx - r * .7, cy, cx + r * .7, cy), fill=color, width=w + 1)
        d.line((cx, cy - r * .7, cx, cy + r * .7), fill=color, width=w + 1)
    elif name == "arrow-up":
        d.line((cx, cy + r * .6, cx, cy - r * .45), fill=color, width=w + 1)
        d.line((cx - r * .5, cy - r * .05, cx, cy - r * .62), fill=color, width=w + 1)
        d.line((cx + r * .5, cy - r * .05, cx, cy - r * .62), fill=color, width=w + 1)
    elif name == "arrow-left":
        d.line((cx + r * .6, cy, cx - r * .55, cy), fill=color, width=w + 1)
        d.line((cx - r * .05, cy - r * .5, cx - r * .62, cy), fill=color, width=w + 1)
        d.line((cx - r * .05, cy + r * .5, cx - r * .62, cy), fill=color, width=w + 1)
    elif name == "clip":
        d.arc((cx - r * .55, cy - r * .9, cx + r * .45, cy + r * .1), 180, 360, fill=color, width=w)
        d.arc((cx - r * .55, cy - r * .35, cx + r * .45, cy + r * .65), 180, 360, fill=color, width=w)
        d.line((cx - r * .55, cy - r * .4, cx - r * .55, cy + r * .15), fill=color, width=w)
        d.line((cx + r * .45, cy - r * .4, cx + r * .45, cy + r * .2), fill=color, width=w)
    elif name == "camera":
        d.rounded_rectangle((cx - r * .9, cy - r * .58, cx + r * .9, cy + r * .68),
                            radius=int(r * .24), outline=color, width=w)
        d.rounded_rectangle((cx - r * .35, cy - r * .85, cx + r * .35, cy - r * .55),
                            radius=int(r * .12), outline=color, width=w)
        rr = int(r * .34)
        d.ellipse((cx - rr, cy - rr + r * .05, cx + rr, cy + rr + r * .05), outline=color, width=w)
    elif name == "check":
        d.line((cx - r * .55, cy + r * .02, cx - r * .14, cy + r * .45), fill=color, width=w + 1)
        d.line((cx - r * .14, cy + r * .45, cx + r * .6, cy - r * .45), fill=color, width=w + 1)
    elif name == "warn":
        d.polygon([(cx, cy - r * .8), (cx + r * .86, cy + r * .62), (cx - r * .86, cy + r * .62)],
                  outline=color, width=w)
        d.line((cx, cy - r * .3, cx, cy + r * .18), fill=color, width=w)
        d.ellipse((cx - w, cy + r * .36, cx + w, cy + r * .36 + 2 * w), fill=color)
    elif name == "eye":
        d.arc((cx - r * .95, cy - r * .62, cx + r * .95, cy + r * .62), 200, 340, fill=color, width=w)
        d.arc((cx - r * .95, cy - r * .62, cx + r * .95, cy + r * .62), 20, 160, fill=color, width=w)
        rr = int(r * .3)
        d.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), outline=color, width=w)
    elif name == "dots-grid":
        rr = max(2, int(r * .16))
        for dx in (-r * .5, r * .5):
            for dy in (-r * .5, r * .5):
                d.ellipse((cx + dx - rr, cy + dy - rr, cx + dx + rr, cy + dy + rr), fill=color)
    elif name == "cpu":
        side = int(r * 1.15)
        d.rounded_rectangle((cx - side, cy - side, cx + side, cy + side),
                            radius=int(r * .28), outline=color, width=w)
        d.rectangle((cx - r * .34, cy - r * .34, cx + r * .34, cy + r * .34), fill=color)
        for k in (-r * .5, 0, r * .5):
            d.line((cx + k, cy - side, cx + k, cy - side - r * .3), fill=color, width=w)
            d.line((cx + k, cy + side, cx + k, cy + side + r * .3), fill=color, width=w)
    elif name == "gear":
        rr = int(r * .38)
        d.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), outline=color, width=w)
        for k in range(6):
            import math
            a = math.radians(k * 60)
            x1, y1 = cx + math.cos(a) * r * .62, cy + math.sin(a) * r * .62
            x2, y2 = cx + math.cos(a) * r * .95, cy + math.sin(a) * r * .95
            d.line((x1, y1, x2, y2), fill=color, width=w)
