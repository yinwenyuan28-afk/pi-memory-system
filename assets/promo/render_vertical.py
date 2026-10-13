"""Render the 30-second, 1080x1920, true 60 fps Pi Memory motion film.

python render_vertical.py --prepare-audio --preview --render
Uses the existing requirements.txt. Intermediates live in a system temp folder;
frames are streamed to FFmpeg. No frame directory or paid service is required.
"""
from __future__ import annotations

import argparse
import asyncio
from functools import lru_cache
import hashlib
import io
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import wave

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import resvg_py

ROOT = Path(__file__).resolve().parent
SPEC = json.loads((ROOT / "storyboard.vertical.zh.json").read_text(encoding="utf-8"))
W, H, FPS, TOTAL = (SPEC[k] for k in ("width", "height", "fps", "duration"))
S = W / 720
BUILD = Path(tempfile.gettempdir()) / "pi-memory-promo-vertical-zh-20261012"
BUILD.mkdir(parents=True, exist_ok=True)
FFMPEG, FFPROBE = shutil.which("ffmpeg"), shutil.which("ffprobe")
if not FFMPEG or not FFPROBE:
    raise RuntimeError("FFmpeg and FFprobe are required on PATH.")

C = {
    "bg": "#10251C", "panel": "#182F25", "raised": "#223C2F",
    "line": "#3B5848", "ink": "#F3F3EA", "muted": "#B2C4B7",
    "subtle": "#7F9A88", "brand": "#379B70", "mint": "#A9D9BD",
    "paper": "#E5EDDF", "paper_ink": "#233C2D", "warm": "#DDB993",
}

# Chat uses one quiet paper surface, content-sized bubbles, and aligned avatars.
# Memory cards keep their distinct bookmark shape so the two roles stay clear.
CHAT = {
    "surface": "#EEF3EE", "edge": "#D9E3DA", "divider": "#D8E1D8", "ink": "#243A2D",
    "muted": "#607566", "incoming": "#FFFFFF", "outgoing": "#285B43",
    "user_avatar": "#D2DED4", "agent_avatar": "#214F39",
}


def px(v):
    return round(v * S)


def clamp(v):
    return min(1.0, max(0.0, v))


def ease(v):
    v = clamp(v)
    return 1 - (1 - v) ** 3


def smooth(v):
    v = clamp(v)
    return v * v * (3 - 2 * v)


def enter(t, at=0, duration=.45):
    return ease((t - at) / duration)


def mix(a, b, v):
    return a + (b - a) * v


def rgba(c, opacity=1):
    if isinstance(c, tuple):
        return (*c[:3], round(255 * opacity))
    return (*(int(c[i:i + 2], 16) for i in (1, 3, 5)), round(255 * opacity))


@lru_cache(maxsize=64)
def font(size, kind="regular"):
    names = {"regular": "msyh.ttc", "bold": "msyhbd.ttc", "mono": "consola.ttf"}
    return ImageFont.truetype(str(Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / names[kind]), px(size))


@lru_cache(maxsize=512)
def text_sprite(text, size=28, color=C["ink"], kind="regular"):
    f = font(size, kind)
    box = f.getbbox(text)
    pad = px(3)
    result = Image.new("RGBA", (max(1, box[2] - box[0] + pad * 2), max(1, box[3] - box[1] + pad * 2)))
    ImageDraw.Draw(result).text((pad - box[0], pad - box[1]), text, font=f, fill=color)
    return result


@lru_cache(maxsize=16)
def logo(size):
    n = px(size)
    source = resvg_py.svg_to_bytes(svg_path=str(ROOT.parent / "icons" / "main-icon-d4-layer-bridges.svg"), width=n * 3, height=n * 3)
    return Image.open(io.BytesIO(source)).convert("RGBA").resize((n, n), Image.Resampling.LANCZOS)


class Canvas:
    def __init__(self, width=720, height=1280, image=None):
        self.im = image if image is not None else Image.new("RGBA", (px(width), px(height)))
        self.d = ImageDraw.Draw(self.im)

    def rr(self, box, radius=18, fill=None, outline=None, width=1):
        self.d.rounded_rectangle(tuple(px(v) for v in box), px(radius), fill, outline, px(width))

    def line(self, pts, color=C["line"], width=2):
        self.d.line([tuple(px(v) for v in p) for p in pts], fill=color, width=px(width), joint="curve")

    def ellipse(self, box, fill=None, outline=None, width=1):
        self.d.ellipse(tuple(px(v) for v in box), fill, outline, px(width))

    def text(self, x, y, value, size=28, color=C["ink"], kind="regular", anchor="left"):
        sprite = text_sprite(value, size, color, kind)
        if anchor == "center":
            x -= sprite.width / S / 2
        elif anchor == "right":
            x -= sprite.width / S
        self.im.alpha_composite(sprite, (px(x - 3), px(y - 3)))

    def paste(self, layer, x=0, y=0, alpha=1, scale=1, rotate=0):
        if alpha <= 0:
            return
        layer = layer.im if isinstance(layer, Canvas) else layer
        if scale != 1:
            layer = layer.resize((max(1, round(layer.width * scale)), max(1, round(layer.height * scale))), Image.Resampling.BICUBIC)
        if rotate:
            original = layer.size
            layer = layer.rotate(rotate, Image.Resampling.BICUBIC, expand=True)
            x -= (layer.width - original[0]) / S / 2
            y -= (layer.height - original[1]) / S / 2
        if alpha < .999:
            layer = layer.copy()
            layer.putalpha(layer.getchannel("A").point(lambda v: round(v * clamp(alpha))))
        self.im.alpha_composite(layer, (px(x), px(y)))

    def check(self, x, y, size=18, color=C["brand"]):
        self.line([(x, y + size * .45), (x + size * .36, y + size * .8), (x + size, y)], color, 3)

    def arrow(self, x, y, color=C["mint"], size=16):
        self.line([(x, y), (x + size, y)], color, 2)
        self.line([(x + size - 6, y - 6), (x + size, y), (x + size - 6, y + 6)], color, 2)


@lru_cache(maxsize=1)
def background():
    yy, xx = np.mgrid[:H, :W].astype(np.float32)
    a = np.exp(-(((xx / W - .3) / .8) ** 2 + ((yy / H - .35) / .6) ** 2))
    b = np.exp(-(((xx / W - 1) / .5) ** 2 + ((yy / H - .75) / .4) ** 2))
    image = np.stack([12 + a * 8 + b * 3, 28 + a * 15 + b * 9, 21 + a * 11 + b * 5], axis=2)
    image += np.random.default_rng(12).normal(0, .42, (H, W, 1)).astype(np.float32)
    return Image.fromarray(np.uint8(np.clip(image, 0, 255))).convert("RGBA")


@lru_cache(maxsize=32)
def panel(width, height, fill=C["panel"], border=C["line"], radius=24):
    p = Canvas(width + 24, height + 24)
    p.rr((12, 15, width + 12, height + 15), radius, rgba("#000000", .16))
    p.im = p.im.filter(ImageFilter.GaussianBlur(px(6)))
    p.d = ImageDraw.Draw(p.im)
    p.rr((12, 7, width + 12, height + 7), radius, fill, border, 1)
    return p.im


def frame_base(index, local):
    c = Canvas(image=background().copy())
    # Subtle floating punctuation provides depth without distracting from text.
    for n in range(11):
        x = 30 + (n * 61) % 660
        y = 146 + (n * 103) % 946 + math.sin(local * .6 + n) * 5
        c.ellipse((x, y, x + 2, y + 2), rgba(C["mint"], .11))
    if index >= 2:
        c.paste(logo(25), 66, 77)
        c.text(106, 82, "Pi Memory", 22, C["ink"], "bold")
    else:
        c.text(66, 82, "Pi × 你的日常", 22, C["muted"])
    return c


def heading(c, t, first, second, accent=C["mint"], size=57, kicker=None, immediate=False):
    if kicker:
        c.text(68, 146, kicker, 21, C["muted"])
    p = .9 + .1 * enter(t, 0, .42) if immediate else enter(t, 0, .42)
    layer = Canvas(590, 164)
    layer.text(0, 0, first, size, C["ink"], "bold")
    layer.text(0, 80, second, size, accent, "bold")
    c.paste(layer, 66, 195 + (1 - p) * 14, p)


@lru_cache(maxsize=4)
def avatar(agent=True):
    c = Canvas(44, 44)
    c.ellipse((1, 1, 42, 42), CHAT["agent_avatar"] if agent else CHAT["user_avatar"])
    glyph = text_sprite("π" if agent else "你", 28 if agent else 23,
                        C["ink"] if agent else CHAT["ink"], "bold")
    c.im.alpha_composite(glyph, ((c.im.width - glyph.width) // 2, (c.im.height - glyph.height) // 2))
    return c.im


def bubble_surface(width, height, user=False):
    c = Canvas(width, height)
    fill = CHAT["outgoing"] if user else CHAT["incoming"]
    c.rr((0, 0, width - 1, height - 1), 15, fill,
         None if user else CHAT["edge"], 1)
    corner = (width - 25, 0, width - 1, 25) if user else (0, 0, 25, 25)
    c.rr(corner, 6, fill)
    return c


def bubble(lines, user=False, size=22):
    width = max(94, math.ceil(max(font(size).getlength(line) / S for line in lines)) + 38)
    height = 64 + (len(lines) - 1) * 38
    c = bubble_surface(width, height, user)
    for i, line in enumerate(lines):
        c.text(19, 18 + i * 38, line, size, C["ink"] if user else CHAT["ink"])
    return c.im


def message(c, t, at, y, lines, user=False):
    p = enter(t, at, .32)
    if p <= 0:
        return
    dx = (1 - p) * (22 if user else -22)
    body = bubble(lines, user)
    width = body.width / S
    x = 576 - width if user else 143
    c.paste(avatar(not user), (593 if user else 83) + dx, y + 10, p)
    c.paste(body, x + dx, y + (1 - p) * 8, p)


def session(c, label, hint=None, height=420):
    # Center the full chat panel in the 720px composition: equal 64px side margins.
    c.rr((64, 388, 656, 388 + height), 24, CHAT["surface"], CHAT["edge"], 1)
    c.text(86, 416, "Pi agent", 18, CHAT["ink"], "bold")
    c.text(633, 418, label.split(" · ")[0], 16, CHAT["muted"], anchor="right")
    c.line([(85, 456), (635, 456)], CHAT["divider"], 1)
    if hint:
        c.text(633, 418, hint, 15, CHAT["muted"], anchor="right")


@lru_cache(maxsize=32)
def method_card(width=492, compact=False):
    h = 176 if compact else 285
    c = Canvas(width + 20, h + 20)
    c.paste(panel(width, h, C["paper"], "#C8D9C6", 23), -2, 0)
    c.d.polygon([(px(width - 66), px(7)), (px(width - 36), px(7)), (px(width - 36), px(55)), (px(width - 51), px(45)), (px(width - 66), px(55))], fill=C["brand"])
    c.text(31, 28, "方法", 19, C["brand"], "bold")
    c.text(31, 69, "支付回调排查", 31 if compact else 34, C["paper_ink"], "bold")
    if compact:
        c.text(31, 119, "订单号 → 签名 → 幂等记录", 22, C["paper_ink"])
    else:
        for i, s in enumerate(["对照订单号", "检查签名", "查看幂等记录"]):
            y = 127 + i * 46
            c.ellipse((33, y + 2, 59, y + 28), "#CFDFCD")
            c.text(46, y + 2, str(i + 1), 19, C["paper_ink"], "bold", "center")
            c.text(78, y, s, 28, C["paper_ink"])
    return c.im


def scene0(t):
    c = frame_base(0, t)
    heading(c, t, "换个会话，", "又要重讲？", C["warm"], immediate=True)
    session(c, "新的会话", height=428)
    message(c, t, .12, 488, ["继续排查。"], True)
    message(c, t, .86, 605, ["之前怎么查的？"])
    message(c, t, 1.85, 720, ["……"], True)
    c.text(76, 869, "这个会话，还没带回上次的方法。", 23, C["muted"])
    return c.im


def scene1(t):
    c = frame_base(1, t)
    heading(c, t, "说过的，", "又说一遍。", C["warm"])
    labels = [("项目背景", "再讲一次"), ("执行约定", "再讲一次"), ("排查方法", "再讲一次")]
    for i, (title, sub) in enumerate(labels):
        p = enter(t, .12 + i * .24, .5)
        ticket = Canvas(506, 107)
        ticket.rr((0, 0, 503, 104), 19, C["raised"], "#5F6850", 1)
        ticket.rr((18, 26, 58, 66), 11, "#424B37")
        ticket.text(39, 33, str(i + 1), 24, C["warm"], "bold", "center")
        ticket.text(83, 33, title, 31, C["ink"], "bold")
        ticket.text(474, 40, sub, 22, C["warm"], anchor="right")
        x = [86, 100, 78][i]
        y = 451 + i * 126 + (1 - p) * 36
        rotation = [-2, 2, -1.5][i] + math.sin(t * 1.8 + i) * .2
        c.paste(ticket, x, y, p, rotate=rotation)
    typed = Canvas(548, 91)
    typed.rr((0, 0, 546, 88), 18, "#13261D", C["line"])
    typed.text(22, 29, "背景是……我们之前……", 26, C["muted"])
    if int(t * 3) % 2 == 0:
        typed.line([(355, 27), (355, 57)], C["warm"], 2)
    p = enter(t, .7, .4)
    c.paste(typed, 64, 870 + (1 - p) * 18, p)
    q = enter(t, 1.90, .36)
    if q > 0:
        pointer = Canvas(72, 83)
        pointer.d.polygon([(px(6), px(1)), (px(6), px(49)), (px(20), px(36)), (px(31), px(60)), (px(42), px(55)), (px(30), px(31)), (px(49), px(29))], fill=C["paper"], outline=C["paper_ink"], width=px(2))
        c.paste(pointer, 530 + (1 - q) * 54, 720 + (1 - q) * 34, q)
    return c.im


def scene2(t):
    c = frame_base(2, t)
    heading(c, t, "把方法，", "留下来。")
    session(c, "上一次会话", height=396)
    p = enter(t, .16, .42)
    method = "订单号 → 签名 → 幂等记录"
    width = math.ceil(font(22).getlength(method) / S) + 38
    user = bubble_surface(width, 126, True)
    user.text(19, 19, "查支付回调：", 23)
    user.text(19, 73, method, 22)
    for i, (label, prefix) in enumerate([("订单号", ""), ("签名", "订单号 → "), ("幂等记录", "订单号 → 签名 → ")]):
        q = enter(t, .35 + i * .35, .3)
        x = 19 + font(22).getlength(prefix) / S
        span = font(22).getlength(label) / S
        if q:
            user.line([(x, 108), (x + span * q, 108)], C["mint"], 2)
    c.paste(avatar(False), 593, 502, p)
    c.paste(user, 576 - width + (1 - p) * 20, 492, p)
    message(c, t, 1.35, 681, ["好，按这个顺序。"])
    c.text(78, 864, "一次讨论，留下一份可复用经验。", 23, C["muted"])
    return c.im


def scene3(t):
    c = frame_base(3, t)
    heading(c, t, "让经验，", "在后台积累。", size=54)
    # Advancing session markers explicitly communicates compressed time.
    for i in range(3):
        p = enter(t, i * .22, .3)
        box = Canvas(148, 69)
        active = min(2, int(t / .4)) == i
        box.rr((0, 0, 146, 66), 14, C["raised"], C["brand"] if active else C["line"])
        box.text(74, 22, f"会话 {i + 1:02}", 22, C["mint"] if active else C["muted"], anchor="center")
        c.paste(box, 84 + i * 175, 394, p)
        if i < 2:
            c.arrow(242 + i * 175, 427, C["subtle"], 14)
    c.text(337, 496, "累积对话 · 时间推进", 23, C["muted"], anchor="center")
    p = enter(t, .62, .55)
    card = method_card(492)
    c.paste(card, 94, 567, p * .20, rotate=-4)
    c.paste(card, 84, 562, p * .42, rotate=3)
    c.paste(card, 84, 540 + (1 - p) * 33, p)
    for i, word in enumerate(["订单号", "签名", "幂等记录"]):
        q = clamp((t - .7 - i * .36) / .6)
        if 0 < q < 1:
            x = mix(110 + i * 152, 164, ease(q))
            y = mix(471, 671 + i * 46, ease(q))
            flying = Canvas(156, 54)
            flying.rr((0, 0, 153, 51), 13, C["brand"])
            flying.text(76, 13, word, 23, C["ink"], anchor="center")
            c.paste(flying, x, y, math.sin(q * math.pi))
    done = enter(t, 2.20, .4)
    chip = Canvas(252, 58)
    chip.rr((0, 0, 250, 55), 15, C["raised"])
    chip.check(22, 17, 21, C["mint"])
    chip.text(59, 17, "方法已整理", 24, C["mint"])
    c.paste(chip, 210, 850, done)
    return c.im


def scene4(t):
    c = frame_base(4, t)
    heading(c, t, "新的会话，", "也能接着查。", size=55)
    session(c, "新的会话", height=244)
    message(c, t, .10, 488, ["又重复回调了，", "怎么查？"], True)
    # The other cards stay dim; only this method is brought forward.
    for i, label in enumerate(["项目约定", "待办进度"]):
        small = Canvas(239, 132)
        small.rr((0, 0, 235, 128), 19, "#20382C", C["line"])
        small.text(20, 30, label, 25, C["subtle"])
        small.line([(20, 77), (179, 77)], C["line"], 3)
        small.line([(20, 94), (134, 94)], C["line"], 3)
        q = enter(t, .65, .4)
        c.paste(small, 78 + i * 282, 707 + i * 9, q * .8, rotate=3 if i else -4)
    p = enter(t, 1.05, .75)
    c.paste(method_card(492, True), 83, 700 - p * 59 + math.sin(t * 1.3) * 2, p)
    q = enter(t, 2.0, .4)
    status = Canvas(406, 44)
    status.check(12, 9, 19, C["mint"])
    status.text(49, 10, "找回相关的排查方法", 24, C["mint"])
    c.paste(status, 125, 839, q)
    return c.im


def scene5(t):
    c = frame_base(5, t)
    heading(c, t, "上次的方法，", "这次用上。", size=54)
    session(c, "新的会话 · 继续排查", height=480)
    p = enter(t, .04, .40)
    c.paste(avatar(True), 83, 502, p)
    reply = bubble_surface(286, 202)
    reply.text(19, 18, "沿用之前的顺序：", 22, CHAT["ink"])
    for i, word in enumerate(["对照订单号", "检查签名", "查看幂等记录"]):
        q = enter(t, .50 + i * .75, .32)
        row = Canvas(250, 38)
        row.text(0, 3, f"{i + 1}.", 21, CHAT["muted"], "mono")
        row.text(34, 3, word, 22, CHAT["ink"])
        reply.paste(row, 20 + (1 - q) * 10, 62 + i * 39, q)
    c.paste(reply, 143 + (1 - p) * 15, 492, p)
    message(c, t, 2.7, 772, ["接着查。"], True)
    return c.im


def scene6(t):
    c = frame_base(6, t)
    heading(c, t, "带回相关的，", "把空间留给任务。", size=49)
    for i in range(4):
        faded = Canvas(196, 91)
        faded.rr((0, 0, 194, 88), 13, C["raised"], C["line"])
        faded.line([(18, 29), (151, 29)], C["subtle"], 2)
        faded.line([(18, 47), (117, 47)], C["line"], 2)
        q = smooth(t / 1.4)
        c.paste(faded, mix(76 + i * 115, -120 if i < 2 else 624, q), 445 + i * 52, .30 * (1 - q) + .06, rotate=-5 + i * 3)
    c.text(336, 406, "记忆库", 22, C["muted"], anchor="center")
    q = enter(t, .25, 1.0)
    card = method_card(492, True)
    scale = mix(.88, .75, q)
    x = mix(104, 139, q)
    y = mix(452, 548, q)
    c.paste(panel(548, 219), 52, 663, enter(t, .3, .5))
    c.text(97, 712, "当前任务", 22, C["muted"])
    c.text(97, 762, "继续排查", 40, C["ink"], "bold")
    done = enter(t, 1.35, .4)
    c.paste(card, x, y, 1, scale=scale)
    tick = Canvas(82, 82)
    tick.ellipse((1, 1, 76, 76), C["brand"])
    tick.check(22, 26, 33, C["ink"])
    c.paste(tick, 486, 753, done, scale=.9 + .1 * done)
    return c.im


def scene7(t):
    c = frame_base(7, t)
    p = enter(t, .0, .42)
    c.paste(logo(139), 291, 247 + (1 - p) * 15, p)
    # Text is fully settled by 26.5 s and held for the remaining 3.5 s.
    layer = Canvas(590, 659)
    center = 295
    layer.text(center, 0, "Pi Memory", 58, C["ink"], "bold", "center")
    layer.text(center, 110, "为 Pi 提供", 43, C["ink"], "bold", "center")
    layer.text(center, 175, "长期记忆支持", 46, C["mint"], "bold", "center")
    layer.text(center, 290, "pi-memory.com", 39, C["ink"], "mono", "center")
    layer.text(center, 372, "已有 Pi？安装扩展", 23, C["muted"], anchor="center")
    layer.rr((22, 423, 568, 498), 19, C["raised"], C["brand"], 1.2)
    layer.text(center, 449, "pi install npm:pi-memory-system", 26, C["ink"], "mono", "center")
    layer.text(center, 555, "当前支持 Windows", 22, C["muted"], anchor="center")
    layer.text(center, 595, "完整安装与向量配置见网站", 22, C["muted"], anchor="center")
    c.paste(layer, 64, 440 + (1 - p) * 8, p)
    return c.im


SCENES = [scene0, scene1, scene2, scene3, scene4, scene5, scene6, scene7]


def caption_rows():
    rows = []
    for scene in SPEC["scenes"]:
        # A single readable subtitle card is used per shot, with at most two lines.
        rows.append((scene["start"] + .12, scene["end"] - .06, scene["captions"]))
    return rows


CAPTIONS = caption_rows()


def render_frame(t, subtitles=True):
    index = max(i for i, scene in enumerate(SPEC["scenes"]) if t >= scene["start"])
    local = t - SPEC["scenes"][index]["start"]
    im = SCENES[index](local)
    # A fast gentle dissolve is part of the storyboard duration, not extra footage.
    transition = .22 if index in (1, 2, 4) else .30
    if index > 0 and local < transition:
        previous = SPEC["scenes"][index - 1]
        old = SCENES[index - 1](previous["end"] - previous["start"] - .001)
        im = Image.blend(old, im, smooth(local / transition))
    c = Canvas(image=im)
    if 4 <= index <= 5:
        c.text(336, 911, "示例：已配置 Embedding，记忆已建立向量", 20, C["muted"], anchor="center")
    if subtitles and index < 7:
        for start, end, lines in CAPTIONS:
            if start <= t < end:
                top = 1030 if 4 <= index <= 5 else 1000
                for i, text in enumerate(lines):
                    size = 30 if len(text) > 15 else 32
                    c.text(336, top + i * 42, text, size, C["ink"], anchor="center")
                break
    return c.im.convert("RGB")


def ffmpeg(args):
    subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", *map(str, args)], check=True)


def duration(path):
    return float(subprocess.check_output([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(path)], text=True).strip())


def speech_path(i, scene, rate):
    key = hashlib.sha256((scene["voice"] + SPEC["voice"] + rate).encode()).hexdigest()[:10]
    return BUILD / f"voice-{i}-{key}.mp3"


async def prepare_speech():
    import edge_tts
    semaphore = asyncio.Semaphore(2)

    async def one(i, scene):
        async with semaphore:
            rate = SPEC["voice_rate"]
            path = speech_path(i, scene, rate)
            for attempt in range(3):
                try:
                    if not path.exists() or path.stat().st_size < 1000:
                        await edge_tts.Communicate(scene["voice"], SPEC["voice"], rate=rate, pitch="-1Hz").save(str(path))
                    available = scene["end"] - scene["start"] - .32
                    seconds = duration(path)
                    if seconds > available:
                        # Regenerate at a natural speaking rate; never time-stretch speech.
                        faster = min(28, math.ceil((1.08 * seconds / available - 1) * 100) + 2)
                        rate = f"+{faster}%"
                        path = speech_path(i, scene, rate)
                        if not path.exists() or path.stat().st_size < 1000:
                            await edge_tts.Communicate(scene["voice"], SPEC["voice"], rate=rate, pitch="-1Hz").save(str(path))
                        seconds = duration(path)
                        if seconds > available + .025:
                            raise RuntimeError(f"Narration {i + 1} exceeds {available:.2f}s: {seconds:.2f}s. Shorten its text.")
                    print(f"Voice {i + 1}/8: {seconds:.2f}s, rate {rate}, window {available:.2f}s", flush=True)
                    return path
                except Exception:
                    if attempt == 2:
                        raise
                    await asyncio.sleep(1 + attempt)
    return await asyncio.gather(*(one(i, s) for i, s in enumerate(SPEC["scenes"])))


def prepare_audio(engine="edge"):
    selected_engine = engine
    try:
        if engine == "windows":
            raise ImportError("Windows speech explicitly selected")
        paths = asyncio.run(prepare_speech())
    except Exception as error:
        if os.name != "nt":
            raise
        if engine != "windows":
            print(f"Online speech unavailable ({type(error).__name__}); using installed Windows voices.", flush=True)
        selected_engine = "windows"
        speech_shell = shutil.which("pwsh.exe") or "powershell.exe"
        subprocess.run([speech_shell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ROOT / "prepare_voice_local.ps1"), "-Storyboard", str(ROOT / "storyboard.vertical.zh.json"), "-OutputDirectory", str(BUILD)], check=True)
        paths = [BUILD / f"voice-local-{i}.wav" for i in range(len(SPEC["scenes"]))]
    sr = 48000
    n = int(TOTAL * sr)
    voice = np.zeros(n, dtype=np.float64)
    activity = np.zeros(n, dtype=np.float64)
    voice_report = []
    for i, (path, scene) in enumerate(zip(paths, SPEC["scenes"])):
        wav = BUILD / f"voice-decoded-{i}.wav"
        ffmpeg(["-i", path, "-ar", sr, "-ac", 1, "-c:a", "pcm_s16le", wav])
        with wave.open(str(wav), "rb") as stream:
            pcm = np.frombuffer(stream.readframes(stream.getnframes()), dtype="<i2").astype(np.float64) / 32768
        start = int((scene["start"] + .12) * sr)
        voice[start:start + len(pcm)] += pcm * .9
        a, b = max(0, start - int(.12 * sr)), min(n, start + len(pcm) + int(.16 * sr))
        activity[a:b] = 1
        voice_report.append({"scene": i + 1, "start": start / sr, "end": (start + len(pcm)) / sr, "engine": selected_engine, "file": path.name})

    music = np.zeros(n, dtype=np.float64)
    fx = np.zeros(n, dtype=np.float64)
    rng = np.random.default_rng(20261012)

    def add(dest, at, samples):
        a = round(at * sr)
        b = min(n, a + len(samples))
        if a >= 0 and b > a:
            dest[a:b] += samples[:b - a]

    def bell(hz, length=.35, gain=.035):
        tt = np.arange(round(length * sr)) / sr
        env = (1 - np.exp(-tt * 180)) * np.exp(-tt * 9)
        return (np.sin(2 * np.pi * hz * tt) + .23 * np.sin(2 * np.pi * hz * 2.005 * tt)) * env * gain

    beat = 60 / 108
    chords = [(130.81, 164.81, 196), (110, 130.81, 164.81), (87.31, 130.81, 174.61), (98, 146.83, 196)]
    for bar in range(11):
        at = 6 + bar * beat * 4
        length = min(beat * 4 + .5, TOTAL - at)
        if length <= 0:
            break
        tt = np.arange(round(length * sr)) / sr
        env = np.minimum(1, tt / .20) * np.minimum(1, (length - tt) / .5)
        chord = sum(np.sin(2 * np.pi * hz * tt + j * .4) for j, hz in enumerate(chords[bar % 4]))
        add(music, at, chord * env * .005)
        for k in range(4):
            hit = at + k * beat
            tt = np.arange(round(.19 * sr)) / sr
            if k % 2 == 0:
                kick = np.sin(2 * np.pi * (49 * tt + 15 * (1 - np.exp(-tt * 35)))) * np.exp(-tt * 23) * .026
                add(music, hit, kick)
            else:
                click = rng.normal(0, 1, len(tt)) * np.exp(-tt * 80) * .009
                add(music, hit, click)
            melody = [523.25, 659.25, 783.99, 659.25, 587.33, 523.25, 440, 523.25]
            add(music, hit + beat / 2, bell(melody[(bar * 2 + k) % 8], .42, .010))

    for at, hz in [(0.16, 740), (.94, 600), (3.20, 430), (3.44, 430), (6.18, 740), (7.4, 660), (12.3, 880), (14.2, 740), (16.1, 880), (18.55, 660), (19.30, 740), (20.05, 880), (21.0, 1046), (24.4, 880), (26.24, 659)]:
        add(fx, at, bell(hz, .32, .028))
    for at in [6, 10, 14, 23, 26]:
        tt = np.arange(round(.33 * sr)) / sr
        noise = rng.normal(0, 1, len(tt))
        noise = np.convolve(noise, np.ones(31) / 31, mode="same")
        add(fx, at, noise * np.sin(np.pi * tt / .33) ** 2 * .024)

    tt = np.arange(n) / sr
    fade = np.minimum(1, tt / .18) * np.minimum(1, (TOTAL - tt) / .65)
    music *= (1 - activity * .5) * fade
    fx *= fade
    mono = voice + music + fx
    left = np.clip(mono + music * .12, -.96, .96)
    right = np.clip(mono - np.roll(music, 483) * .12, -.96, .96)
    with wave.open(str(BUILD / "mix.wav"), "wb") as out:
        out.setnchannels(2)
        out.setsampwidth(2)
        out.setframerate(sr)
        out.writeframes(np.int16(np.stack([left, right], axis=1) * 32767).tobytes())
    (BUILD / "voice-timing.json").write_text(json.dumps(voice_report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("Chinese narration, original music, and sound effects mixed.", flush=True)


def stamp(seconds):
    n = round(seconds * 1000)
    return f"{n // 3600000:02}:{n // 60000 % 60:02}:{n // 1000 % 60:02},{n % 1000:03}"


def write_subtitles():
    entries = [f"{i}\n{stamp(start)} --> {stamp(end)}\n" + "\n".join(lines) + "\n" for i, (start, end, lines) in enumerate(CAPTIONS, 1)]
    (ROOT / "subtitles.vertical.zh.srt").write_text("\n".join(entries), encoding="utf-8")


def previews():
    times = [2.4, 5.2, 9.0, 13.1, 17.4, 22.0, 25.5, 28.3]
    sheet = Image.new("RGB", (1080, 960), C["bg"])
    for i, t in enumerate(times):
        im = render_frame(t)
        im.save(BUILD / f"preview-{i + 1}.png")
        sheet.paste(im.resize((270, 480), Image.Resampling.LANCZOS), ((i % 4) * 270, (i // 4) * 480))
    sheet.save(BUILD / "contact-sheet.jpg", quality=94)
    poster = Canvas(image=render_frame(2.4, subtitles=False).convert("RGBA"))
    poster.paste(logo(37), 67, 985)
    poster.text(120, 994, "Pi Memory", 29, C["ink"], "bold")
    poster.im.convert("RGB").save(ROOT / "poster-vertical-zh.jpg", quality=95)
    print(f"Previews: {BUILD / 'contact-sheet.jpg'}", flush=True)


def render():
    audio = BUILD / "mix.wav"
    if not audio.exists():
        raise RuntimeError("Run --prepare-audio before the final render.")
    silent = BUILD / "silent-60fps.mp4"
    log = BUILD / "encode.log"
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "pipe:0", "-an", "-c:v", "libx264", "-preset", "fast", "-threads", "6", "-crf", "18", "-profile:v", "high", "-level:v", "4.2", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(silent)]
    started = time.monotonic()
    with log.open("w") as error_log:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=error_log)
        try:
            for i in range(round(TOTAL * FPS)):
                proc.stdin.write(render_frame(i / FPS).tobytes())
                if i % (FPS * 2) == 0:
                    elapsed = time.monotonic() - started
                    print(f"Render {i / FPS:04.1f}/{TOTAL}s, frame {i}/{TOTAL * FPS}, elapsed {elapsed:.0f}s", flush=True)
            proc.stdin.close()
            code = proc.wait()
        except BaseException:
            proc.kill()
            proc.wait()
            raise
    if code:
        raise RuntimeError(log.read_text())
    final = ROOT / "pi-memory-system-promo-vertical-zh.mp4"
    ffmpeg(["-i", silent, "-i", audio, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-af", "loudnorm=I=-16:TP=-1.5:LRA=9", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-t", str(TOTAL), "-movflags", "+faststart", final])
    print(f"Saved: {final}", flush=True)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--prepare-audio", action="store_true")
    p.add_argument("--speech-engine", choices=["edge", "windows"], default="edge")
    p.add_argument("--preview", action="store_true")
    p.add_argument("--render", action="store_true")
    args = p.parse_args()
    write_subtitles()
    if args.prepare_audio:
        prepare_audio(args.speech_engine)
    if args.preview:
        previews()
    if args.render:
        render()


if __name__ == "__main__":
    main()
