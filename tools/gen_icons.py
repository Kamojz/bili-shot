"""生成 BiliShot 扩展图标（16/32/48/128）。

用法： python tools/gen_icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT_DIR = Path(__file__).resolve().parent.parent / "extension" / "icons"
SCALE = 8  # 超采样倍数
TOP = (251, 114, 153)      # B站 粉
BOTTOM = (255, 158, 185)
WHITE = (255, 255, 255, 255)


def rounded_rect(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def make_icon(size: int) -> Image.Image:
    s = size * SCALE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))

    # 渐变背景
    gradient = Image.new("RGBA", (s, s))
    gd = ImageDraw.Draw(gradient)
    for y in range(s):
        t = y / max(1, s - 1)
        color = tuple(int(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)) + (255,)
        gd.line([(0, y), (s, y)], fill=color)

    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.23), fill=255)
    img.paste(gradient, (0, 0), mask)

    draw = ImageDraw.Draw(img)

    # 相机机身
    body_w, body_h = int(s * 0.62), int(s * 0.42)
    body_x, body_y = (s - body_w) // 2, int(s * 0.42)
    rounded_rect(draw, [body_x, body_y, body_x + body_w, body_y + body_h], int(s * 0.10), WHITE)

    # 顶部取景凸起
    bump_w, bump_h = int(s * 0.22), int(s * 0.10)
    bump_x, bump_y = int(body_x + body_w * 0.50), body_y - bump_h
    rounded_rect(draw, [bump_x, bump_y, bump_x + bump_w, bump_y + bump_h + int(s * 0.06)], int(s * 0.045), WHITE)

    # 镜头（粉色圆 + 白色播放三角，暗示视频）
    lens_r = int(s * 0.155)
    cx, cy = s // 2, body_y + body_h // 2
    draw.ellipse([cx - lens_r, cy - lens_r, cx + lens_r, cy + lens_r], fill=TOP + (255,))

    tri = int(lens_r * 0.68)
    draw.polygon(
        [(cx - int(tri * 0.42), cy - tri), (cx - int(tri * 0.42), cy + tri), (cx + int(tri * 0.86), cy)],
        fill=WHITE,
    )

    return img.resize((size, size), Image.LANCZOS)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        icon = make_icon(size)
        icon.save(OUT_DIR / f"icon{size}.png")
        print(f"wrote icons/icon{size}.png")


if __name__ == "__main__":
    main()
