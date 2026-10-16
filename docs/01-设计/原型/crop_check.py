"""验证工具：裁切渲染结果做全分辨率检查。用法:
   python crop_check.py <png> <y0> <y1> [out.png]
"""
import sys
from PIL import Image

src, y0, y1 = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
out = sys.argv[4] if len(sys.argv) > 4 else r"D:\Workspace\dsh_android\.proto-out\_crop.png"
im = Image.open(src).crop((0, y0, 1080, y1))
im.save(out)
print(f"{out}  {im.size[0]}x{im.size[1]}")
