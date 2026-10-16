"""02 会话详情 · 实时对话流"""
import sys, os, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from proto_kit import *  # noqa
from proto_kit import _shade, fit
import icons

img, d = canvas()
statusbar(d)

# ---------------- 顶部：返回 + 两行标题 + 动作
y = 54 * S
icons.icon(d, "arrow-left", M + 12 * S, y + 15 * S, int(11 * S), ON_BG, S)
# 停止按钮
sw = 30 * S + tw("停止", 11.5 * S, "b")
sx = W - M - 34 * S - 8 * S - sw
rrect(d, (sx, y + 1 * S, sx + sw, y + 31 * S), 15 * S, fill=_shade(ERROR, .12, BG),
      outline=ERROR, width=2)
icons.icon(d, "stop", sx + 15 * S, y + 16 * S, int(5 * S), ERROR, S)
text(d, sx + 25 * S, y + 6 * S, "停止", 11.5 * S, ERROR, "b")
iconbtn(d, W - M - 34 * S, y - 1 * S, "more")
tx = M + 32 * S
cap = sx - tx - 10 * S            # 标题/副标题可用的右边界（停止按钮左侧）
text(d, tx, y - 2 * S, fit("重构 Runner 为八条并发分支", tx, tx + cap, 15 * S, "b"),
     15 * S, ON_BG, "b")
text(d, tx, y + 21 * S, fit("dsh_android · ⑂ main +3 −1", tx, tx + cap, 10.5 * S, "r"),
     10.5 * S, ON_VAR)

y += 46 * S
# ---------------- 实时状态条
rrect(d, (M, y, W - M, y + 34 * S), 10 * S, fill=_shade(LIVE, .09, BG),
      outline=_shade(LIVE, .28, BG), width=2)
dot(d, M + 15 * S, y + 17 * S, 5 * S, LIVE)
text(d, M + 27 * S, y + 8 * S, "正在执行第 13 轮 · 已用 02:14", 12 * S, ON_BG)
chip(d, W - M - 12 * S - (18 * S + tw("工具 pwsh", 10 * S)), y + 7 * S, "工具 pwsh",
     size=10, padx=9, h=20, bg=SURFACE_VAR)
y += 40 * S

# ---------------- 流式渲染器：只画放得下的节点
PIPE_TOP = y
PIPE_BOTTOM = H - 202 - 66 * S   # 输入区（60dp）+ 6dp 间隙 之上
dropped = []


def draw(fn, height):
    """height 为 dp 数；放不下则记入 dropped 并跳过（模拟滚动裁切）。"""
    global y
    h = height * S
    if y + h > PIPE_BOTTOM:
        dropped.append(fn)
        return False
    fn(y)
    y += h
    return True


def node_user(yy):
    bubble = "把 runner 拆成八条并发分支，各自独立验收，最后合并成一份报告。"
    bw = 250 * S
    h = 10 * S + para(d, 0, 0, bubble, 13 * S, maxw=bw - 26 * S) + 10 * S
    bx = W - M - bw
    rrect(d, (bx, yy, W - M, yy + h), 16 * S, fill=PRIMARY_CTN,
          outline=_shade(PRIMARY, .45, BG), width=2)
    para(d, bx + 13 * S, yy + 10 * S, bubble, 13 * S, ON_BG, maxw=bw - 26 * S)
    return h


def node_ai(yy):
    txt = "我会拆出八条独立分支，每条一个工作区副本，跑完单测后按 report 汇总。"
    return para(d, M, yy, txt, 12.5 * S, ON_BG, maxw=W - 2 * M, lh=1.34) + 8 * S


def node_think(yy):
    h = 30 * S
    rrect(d, (M, yy, W - M, yy + h), 12 * S, fill=SURFACE_VAR, outline=OUTLINE, width=2)
    icons.icon(d, "chevron-right", M + 14 * S, yy + h // 2, int(6 * S), ON_VAR, S)
    text(d, M + 28 * S, yy + 7 * S, "思考 · 1.2s", 12 * S, ON_VAR, "b")
    text(d, W - M - 14 * S, yy + 7 * S, "已折叠 · 点击展开", 11 * S, ON_VAR, align="r")
    return h


def node_pwsh(yy):
    lines = ["$ ./gradlew :app:testDebugUnitTest", "> Task :app:testDebugUnitTest",
             "BUILD SUCCESSFUL in 28s"]
    inner = sum(int(11.5 * S * 1.5) for _ in lines) + 12 * S
    h = 34 * S + inner + 8 * S
    tool_frame(d, M, yy, W - 2 * M, h, "amber", "terminal", "pwsh",
               right="28.4s · exit 0", right_color=SUCCESS)
    ty = yy + 34 * S + 6 * S
    for i, ln in enumerate(lines):
        col = SUCCESS if ln.startswith("BUILD") else (ON_VAR if ln.startswith(">") else CODE_FG)
        text(d, M + 12 * S, ty, ln, 11.5 * S, col, "r", mono=True)
        ty += int(11.5 * S * 1.5)
    return h


def node_diff(yy):
    lines = [("hunk", "@@ -18,7 +18,9 @@"), ("del", "-    val ktor = \"2.3.4\""),
             ("add", "+    val ktor = \"2.3.7\""),
             ("add", "+    implementation(libs.okhttp.sse)")]
    inner = len(lines) * int(11 * S * 1.55)
    h = 34 * S + inner + 8 * S
    tool_frame(d, M, yy, W - 2 * M, h, "green", "file", "edit  app/build.gradle.kts",
               right="+3 −1", right_color=SUCCESS)
    ly = yy + 34 * S + 5 * S
    for kind, ln in lines:
        lh = int(11 * S * 1.55)
        if kind == "add":
            d.rectangle((M + 6 * S, ly, W - M - 6 * S, ly + lh), fill=ADD_BG)
            text(d, M + 14 * S, ly + 2 * S, ln, 11 * S, ADD_FG, "r", mono=True)
        elif kind == "del":
            d.rectangle((M + 6 * S, ly, W - M - 6 * S, ly + lh), fill=DEL_BG)
            text(d, M + 14 * S, ly + 2 * S, ln, 11 * S, DEL_FG, "r", mono=True)
        elif kind == "hunk":
            text(d, M + 14 * S, ly + 2 * S, ln, 11 * S, PRIMARY, "r", mono=True)
        else:
            text(d, M + 14 * S, ly + 2 * S, ln, 11 * S, ON_VAR, "r", mono=True)
        ly += lh
    return h


def node_todo(yy):
    todos = [("done", "拆出 8 条分支并建副本"), ("now", "分支 4–6 并发执行中"),
             ("todo", "合并并生成报告")]
    h = 30 * S + len(todos) * 20 * S + 6 * S
    rrect(d, (M, yy, W - M, yy + h), 14 * S, fill=SURFACE, outline=OUTLINE, width=2)
    text(d, M + 14 * S, yy + 9 * S, "任务清单", 12 * S, ON_BG, "b")
    text(d, W - M - 14 * S, yy + 10 * S, "2/4 · 八条分支验收", 11 * S, ON_VAR, align="r")
    ty = yy + 30 * S
    for state, label in todos:
        if state == "done":
            d.ellipse((M + 14 * S, ty + 2 * S, M + 26 * S, ty + 14 * S), fill=SUCCESS)
            icons.icon(d, "check", M + 20 * S, ty + 8 * S, int(4.5 * S), ON_ACCENT, S)
            text(d, M + 34 * S, ty, label, 12 * S, ON_VAR)
        elif state == "now":
            d.ellipse((M + 14 * S, ty + 2 * S, M + 26 * S, ty + 14 * S), outline=PRIMARY, width=2)
            d.arc((M + 17 * S, ty + 5 * S, M + 23 * S, ty + 11 * S), 30, 300, fill=PRIMARY, width=2)
            text(d, M + 34 * S, ty, label, 12 * S, ON_BG)
        else:
            d.ellipse((M + 14 * S, ty + 2 * S, M + 26 * S, ty + 14 * S), outline=OUTLINE, width=2)
            text(d, M + 34 * S, ty, label, 12 * S, ON_VAR)
        ty += 20 * S
    return h


def node_warn(yy):
    h = 36 * S
    rrect(d, (M, yy, W - M, yy + h), 12 * S, fill=_shade(WARNING, .10, BG),
          outline=_shade(WARNING, .30, BG), width=2)
    d.rectangle((M, yy + 8 * S, M + 3 * S, yy + h - 8 * S), fill=WARNING)
    icons.icon(d, "warn", M + 22 * S, yy + h // 2, int(8 * S), WARNING, S)
    text(d, M + 38 * S, yy + 9 * S, "git push 被拒绝：non-fast-forward，需要先 pull", 12 * S,
         ON_BG)
    return h


def node_ai2(yy):
    para(d, M, yy, "八条分支里 3 条已完成，我先修掉推送冲突再继续。", 13 * S, ON_BG,
         maxw=W - 2 * M)
    return 0


# 节点顺序即真实会话流；受一屏高度所限，任务清单/警告条会落到滚动区外（见注释）
for fn, h in ((node_user, 72), (node_ai, 84), (node_think, 30), (node_pwsh, 107),
              (node_diff, 98)):
    if not draw(fn, h):
        break
    y += 6 * S   # 节点间距

# 滚动裁切：把用户气泡溢出到上方的部分清掉（更明显的「已在会话中段」暗示）
d.rectangle((0, PIPE_TOP - 1, W, PIPE_TOP + 18 * S), fill=BG)

# 流末端：正在生成提示
if y + 24 * S + 7 * S <= PIPE_BOTTOM:
    y += 5 * S
    w = 96 * S
    rrect(d, (M, y, M + w, y + 24 * S), 12 * S, fill=SURFACE_VAR, outline=OUTLINE, width=2)
    dot(d, M + 13 * S, y + 12 * S, 3 * S, PRIMARY)
    text(d, M + 21 * S, y + 5 * S, "第 14 轮进行中", 11 * S, ON_VAR)
    y += 24 * S

print("   PIPE_TOP=%d PIPE_BOTTOM=%d 结束 y=%d, 未放下=%d" % (PIPE_TOP, PIPE_BOTTOM, y, len(dropped)))

# ---------------- 底部输入区（紧贴导航栏上方）
cy = H - 202 - 66 * S
d.rectangle((0, cy, W, H - 202), fill=BG)
hline(d, 0, cy, W, OUTLINE)
text(d, M, cy + 8 * S, "发送到电脑端执行 · 权限跟随电脑端（workspace-write · ask）", 11 * S,
     ON_VAR)
by, bh = cy + 28 * S, 34 * S
rrect(d, (M, by, W - M, by + bh), bh // 2, fill=SURFACE_VAR, outline=OUTLINE, width=2)
text(d, M + 16 * S, by + 8 * S, "给这个会话发一条消息…", 13 * S, ON_VAR)
icons.icon(d, "clip", W - M - 66 * S, by + bh // 2, int(8 * S), ON_VAR, S)
icons.icon(d, "camera", W - M - 40 * S, by + bh // 2, int(8 * S), ON_VAR, S)
d.ellipse((W - M - 30 * S, by + 1 * S, W - M - 2 * S, by + 29 * S), fill=PRIMARY)
icons.icon(d, "arrow-up", W - M - 16 * S, by + bh // 2, int(8 * S), "#FFFFFF", S)

navbar(d, 0)
save(img, "02-会话详情.png")
print("完成 02；未放下的节点数 = %d" % len(dropped))
print("   PIPE_TOP=%d PIPE_BOTTOM=%d 结束 y=%d" % (PIPE_TOP, PIPE_BOTTOM, y))
