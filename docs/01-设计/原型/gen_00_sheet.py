"""把 6 张原型图拼成一张交付用总览图（3 列 × 2 行，带标题）。

用法：python gen_00_sheet.py        # 输出到 PROTO_OUT 下的 00-总览.png
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image, ImageDraw  # noqa: E402

from proto_kit import BG, ON_BG, ON_VAR, S, f_bold, save  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.environ.get("PROTO_OUT", r"D:\Workspace\dsh_android\.proto-out")

PAGES = [
    "01-电脑会话.png", "02-会话详情.png", "03-执行轨迹.png",
    "04-手机任务.png", "05-工作区.png", "06-设置.png",
]
CAPS = ["01 电脑会话", "02 会话详情", "03 执行轨迹",
        "04 手机任务", "05 工作区", "06 设置"]

COLS, PAD, GAP, TOP = 3, 24 * S, 20 * S, 96 * S
TH = 2340 // 2          # 缩略图高度（保持 1080:2340 比例）
TW = 1080 // 2

W = PAD * 2 + COLS * TW + (COLS - 1) * GAP
H = TOP + 2 * (TH + 34 * S) + GAP + PAD

sheet = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(sheet)
d.text((PAD, 28 * S), "DSH 远程 · 手机端原型（方向 A 纯黑极简）", font=f_bold(20 * S),
       fill=ON_BG)
d.text((PAD, 62 * S), "1080×2340 · 3x · 设计令牌与 Android 代码同源",
       font=f_bold(11 * S), fill=ON_VAR)

for i, (fn, cap) in enumerate(zip(PAGES, CAPS)):
    col, row = i % COLS, i // COLS
    x = PAD + col * (TW + GAP)
    y = TOP + row * (TH + 34 * S)
    src = os.path.join(SRC, fn)
    im = Image.open(src).convert("RGB").resize((TW, TH), Image.LANCZOS)
    sheet.paste(im, (x, y))
    d.text((x, y + TH + 8 * S), cap, font=f_bold(12 * S), fill=ON_BG)

save(sheet, "00-总览.png")
print("完成 00；尺寸 %dx%d" % (W, H))
