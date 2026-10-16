"""05 工作区（浏览电脑端目录 + git 改动 + diff）"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from proto_kit import *  # noqa
from proto_kit import _shade, fit
import icons

img, d = canvas()
statusbar(d)

y = 58 * S
text(d, M, y - 2 * S, "工作区", 22 * S, ON_BG, "b")
iconbtn(d, W - M - 36 * S, y - 4 * S, "folder")
y += 40 * S

# 目录选择器
rrect(d, (M, y, W - M, y + 40 * S), 12 * S, fill=SURFACE_VAR, outline=OUTLINE, width=2)
icons.icon(d, "folder", M + 20 * S, y + 20 * S, int(8 * S), SECONDARY, S)
text(d, M + 36 * S, y + 10 * S, "D:\\Workspace\\dsh_android", 12.5 * S, ON_BG, "r", mono=True)
icons.icon(d, "chevron-down", W - M - 20 * S, y + 20 * S, int(7 * S), ON_VAR, S)
y += 52 * S

# git 概览
card(d, M, y, W - 2 * M, 96 * S, r=16 * S)
text(d, M + 16 * S, y + 14 * S, "改动 4 个文件", 15 * S, ON_BG, "b")
icons.icon(d, "branch", W - M - 92 * S, y + 23 * S, int(7 * S), ON_VAR, S)
chip(d, W - M - 16 * S - (18 * S + tw("main", 10 * S)), y + 13 * S, "main", size=10,
     padx=9, h=20)
pills = (("修改 3", WARNING), ("新增 1", SUCCESS), ("未跟踪 0", ON_VAR))
px = M + 16 * S
for label, col in pills:
    w, _ = chip(d, px, y + 44 * S, label, fg=col, bg=_shade(col, .10, SURFACE),
                border=_shade(col, .28, SURFACE), size=10.5, padx=9, h=22)
    px += w + 7 * S
# 比例条
bar_y, bar_h = y + 76 * S, 6 * S
bw_total = W - 2 * M - 32 * S
rrect(d, (M + 16 * S, bar_y, M + 16 * S + bw_total, bar_y + bar_h), bar_h // 2,
      fill=SURFACE_HIGH)
segs = ((0.5, WARNING), (0.25, SUCCESS), (0.25, "#3A3A3A"))
sx = M + 16 * S
for frac, col in segs:
    sw_ = int(bw_total * frac)
    rrect(d, (sx, bar_y, sx + sw_ - 4, bar_y + bar_h), bar_h // 2, fill=col)
    sx += sw_
y += 108 * S

# 文件列表
FILES = [("M", WARNING, "app/build.gradle.kts", "buildscript 依赖升级"),
         ("M", WARNING, "…/dshremote/data/api/ConsoleRepository.kt", "接入 session/list 分页"),
         ("A", SUCCESS, "…/dshremote/ui/theme/DarkColors.kt", "新增设计令牌"),
         ("M", WARNING, "docs/02-接口/远程协议.md", "补充帧边界说明"),
         ("D", ERROR, "…/dshremote/data/LegacyPoller.kt", "已被 ConsoleRepository 取代")]
fh = 46 * S
card(d, M, y, W - 2 * M, fh * len(FILES) + (len(FILES) - 1) * 2, r=16 * S)
fy = y
for i, (badge, col, path, note) in enumerate(FILES):
    bx = M + 16 * S
    rrect(d, (bx, fy + 12 * S, bx + 40 * S, fy + 34 * S), 6 * S,
          fill=_shade(col, .18, SURFACE), outline=_shade(col, .5, SURFACE), width=2)
    text(d, bx + 20 * S, fy + 14 * S, badge, 12 * S, col, "b", align="c")
    sel = i == 0
    pcap = W - M - 30 * S          # 右侧给 chevron 留位
    text(d, bx + 52 * S, fy + 7 * S,
         fit(path, bx + 52 * S, pcap, 12 * S, "r", mono=True), 12 * S,
         ON_BG if sel else ON_BG, "r", mono=True)
    text(d, bx + 52 * S, fy + 25 * S, note, 11 * S, ON_VAR)
    icons.icon(d, "chevron-right", W - M - 20 * S, fy + 23 * S, int(6 * S), ON_VAR, S)
    fy += fh
    if i < len(FILES) - 1:
        hline(d, M + 16 * S, fy, W - M - 16 * S, HAIRLINE, 2)
    fy += 2
y = fy + 12 * S

# diff 预览
DLINES = [("hunk", "@@ -18,7 +18,9 @@"),
          ("del", "-    val ktor = \"2.3.4\""),
          ("add", "+    val ktor = \"2.3.7\""),
          ("add", "+    implementation(libs.okhttp.sse)")]
dh = 40 * S + len(DLINES) * int(11 * S * 1.6) + 10 * S
if y + dh <= H - 202 - 10 * S:
    rrect(d, (M, y, W - M, y + dh), 14 * S, fill=SURFACE, outline=OUTLINE, width=2)
    text(d, M + 14 * S, y + 11 * S, "app/build.gradle.kts", 12.5 * S, ON_BG, "b", mono=True)
    chip(d, W - M - 14 * S - (36 * S + tw("+3 −1", 10 * S)), y + 8 * S, "+3 −1", size=10,
         padx=8, h=20, fg=SUCCESS, bg=_shade(SUCCESS, .10, SURFACE),
         border=_shade(SUCCESS, .28, SURFACE), mono=True)
    ly = y + 38 * S
    for kind, ln in DLINES:
        lh = int(11 * S * 1.6)
        if kind == "add":
            d.rectangle((M + 6 * S, ly, W - M - 6 * S, ly + lh), fill=ADD_BG)
            text(d, M + 14 * S, ly + 1 * S, ln, 11 * S, ADD_FG, "r", mono=True)
        elif kind == "del":
            d.rectangle((M + 6 * S, ly, W - M - 6 * S, ly + lh), fill=DEL_BG)
            text(d, M + 14 * S, ly + 1 * S, ln, 11 * S, DEL_FG, "r", mono=True)
        else:
            text(d, M + 14 * S, ly + 1 * S, ln, 11 * S, SECONDARY, "r", mono=True)
        ly += lh

navbar(d, 2)
save(img, "05-工作区.png")
print("完成 05；diff 底部 y=%d" % (y + dh))
