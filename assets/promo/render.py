"""Render a localized product film. Pillow + NumPy + resvg + FFmpeg; optional edge-tts.

python render.py --prepare-audio --render
python render.py --preview
All output frames are streamed to FFmpeg, without storing a frame directory.
"""
from __future__ import annotations

import argparse
import asyncio
import io
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from functools import lru_cache
import wave

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import resvg_py

ROOT = Path(__file__).resolve().parent
SPEC_PATH = Path(os.environ.get("PIMS_STORYBOARD", ROOT / "storyboard.json"))
SPEC = json.loads(SPEC_PATH.read_text(encoding="utf-8"))
LOCALE = SPEC.get("locale", "zh")
BUILD = Path(tempfile.gettempdir()) / f"pi-memory-promo-{LOCALE}-20261011"
BUILD.mkdir(parents=True, exist_ok=True)
W, H, FPS = SPEC["width"], SPEC["height"], SPEC["fps"]
S = W / 1280
TOTAL = SPEC["duration"]
FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")
if not FFMPEG or not FFPROBE:
    raise RuntimeError("Put ffmpeg and ffprobe on PATH before rendering.")

C = dict(bg="#101B18", panel="#1B2A24", raised="#23352C", line="#365044",
         ink="#F4F2E8", muted="#ACBFB2", subtle="#728C7D", mint="#AEEDC6",
         green="#53D494", amber="#EBC48D", blue="#ABCBDD", red="#E3A99A",
         paper="#EAE7DA", dark="#14251D")

EN = LOCALE == "en"
TRANSLATIONS = {
    "产品流程示意 · 示例数据":"Product concept · sample content",
    "事实":"Fact", "方法":"Method", "待办":"Task", "成果":"Deliverable",
    "项目背景":"Project context", "做过的决定":"Decision made", "还没做完":"Next step",
    "订单模块，我们昨天讨论过。":"We discussed the orders module yesterday.",
    "同秒创建，排序要补上 id。":"Add the ID as a same-second tiebreaker.",
    "回归用例，今天接着写。":"Pick up the regression test today.",
    "跨会话工作，总有这一刻":"A familiar moment between sessions",
    "昨天刚说清，":"Yesterday, we agreed.", "今天又要重来？":"Why start over today?",
    "背景、约定、未完事项……":"Context, decisions, unfinished work…",
    "每次重新解释，都会打断工作的连续性。":"Repeating the same details breaks your flow.",
    "让 Pi 更容易接着上次的进度工作":"Help Pi pick up where you left off",
    "昨天 · 订单项目":"Yesterday · Orders project", "用户":"You",
    "同秒创建的订单顺序不稳定。":"New orders keep changing places.",
    "修复后，补一个回归用例。":"Then add a regression test.",
    "把这次讨论沉淀下来。":"Save the useful details from this conversation.",
    "让对话，留下可用的经验。":"Turn conversations into reusable project knowledge.",
    "自动提炼有价值的信息，保存为可以独立复用的记忆。":"Save useful facts, methods, tasks, and deliverables for later.",
    "后台按阈值提取，也支持手动触发。":"Memory extraction runs in the background and can also be started manually.",
    "工作场景":"Project story", "订单列表 · 稳定排序修复":"Orders list · reliable sorting fix",
    "把相关的讨论与记忆，整理成有背景的项目经历。":"Related conversations and memories come together as a project story.",
    "发现":"Problem", "同秒创建时，列表顺序不稳定":"Orders can appear out of order when created in the same second",
    "决定":"Decision", "用 created_at 与 id 共同排序":"Sort by created_at and id",
    "下一步":"Next", "添加回归用例，验证修复":"Add a regression test to verify the fix",
    "把零散记录，整理成项目脉络。":"Bring related memories together as a project story.",
    "从独立记忆到工作场景，保留事情的来龙去脉。":"Connect individual memories and keep the context behind each project.",
    "场景用于组织与后续处理；当前不会自动注入每轮前台回答。":"Project stories help organize memories; they are not automatically added to every reply.",
    "第二天 · 一个新会话":"Next day · New session",
    "继续订单列表的排序修复，":"Let’s continue fixing the orders list.", "接下来做什么？":"What should we do next?",
    "Pi · 结合召回记录":"Pi · Related memories found",
    "沿用 created_at + id 的排序约定，":"Keep the created_at + id sorting convention.",
    "先补同秒连续创建的回归用例。":"First, add a regression test for same-second inserts.",
    "正在查找相关记忆…":"Searching related memories…",
    "换个会话，也能接着往下做。":"Pick up where you left off in a new session.",
    "按当前问题找回相关经验，让已有约定与待办参与回答。":"Bring relevant project memories and open tasks into the conversation.",
    "相关记忆 · L1":"Related memories · L1", "相关记忆 → 回答上下文":"Memory → answer context",
    "语义召回需配置 Embedding、开启向量化并建立向量；相关记录不保证每次命中。":"Semantic recall requires an embedding service, vectorization, and indexed memories. A match is not guaranteed.",
    "记忆查看器 · 操作示意":"Memory viewer · UI illustration", "记忆库":"Memory",
    "L1 记录":"L1 Records", "L2 场景":"L2 Stories", "L3 画像":"L3 Profile", "处理队列":"Queue",
    "订单项目 / 回归用例":"Orders project / Regression test", "已完成":"Done",
    "覆盖同秒连续创建，验证列表顺序稳定。":"Verify order remains stable when records share a timestamp.",
    "来源：昨天的项目对话 · 保留原始消息标识":"Source: yesterday’s project conversation · Source retained",
    "查看来源":"View source", "修正内容":"Edit memory", "删除记录":"Delete",
    "标记为已完成":"Mark as done", "已标记完成":"Marked done",
    "记录可查看、可修正；任务状态与记录删除分别管理。":"Review and edit memories. Task status and deletion are managed separately.",
    "记忆看得见，也改得动。":"Your memories are yours to review and edit.",
    "待办、已完成、已废弃，分别管理；内容不准确时，可以修正。":"Track open, done, and dropped tasks. Correct a memory when needed.",
    "把经验留下，也把决定权留给你。":"Keep the experience. Keep the choice.",
    "提议稿":"Suggested changes", "系统归纳长期偏好，等待你审阅。":"Review these suggested long-term preferences.",
    "偏好先给结论，再解释依据。":"Lead with the answer, then explain why.",
    "涉及数据变更，先做备份。":"Back up data before making changes.",
    "正式画像":"Profile", "确认并入后，供之后的新会话读取。":"Approved preferences are available in future sessions.",
    "先给结论，再解释依据。":"Lead with the answer, then explain why.",
    "数据变更前，先做备份。":"Back up data before making changes.", "等待用户确认":"Awaiting your approval",
    "确认并入选中条目":"Approve selected preferences", "已并入正式画像":"Added to your profile",
    "长期画像，由你确认。":"You review every profile update.",
    "系统提出建议，你决定哪些偏好进入正式画像。":"Review the suggestions and choose what becomes part of your profile.",
    "让每次对话，":"Make every conversation",
    "都成为下一次工作的起点。":"the starting point for your next task.",
    "提炼记忆  /  按需召回  /  由你掌控":"Keep useful memories  /  Recall when needed  /  Stay in control",
    "查看项目与安装说明":"Project and installation guide",
    "面向 Windows 上的 Pi 用户 · 语义召回需完成配置":"For Pi on Windows · Semantic recall requires setup",
    "用户靠左  ·  Pi 助手靠右":"You on the left · Pi on the right",
}


def localized(text):
    return TRANSLATIONS.get(text, text) if EN else text


def px(x):
    return round(x * S)


@lru_cache(maxsize=64)
def font(size, kind="regular"):
    name = {"regular": "msyh.ttc", "bold": "msyhbd.ttc", "light": "msyhl.ttc",
            "mono": "consola.ttf", "latin": "segoeui.ttf"}[kind]
    return ImageFont.truetype(str(Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / name), px(size))


def rgb(c):
    return tuple(int(c[i:i+2], 16) for i in (1, 3, 5))


class Canvas:
    def __init__(self, w=1280, h=720, image=None):
        self.im = image if image is not None else Image.new("RGBA", (px(w), px(h)))
        self.d = ImageDraw.Draw(self.im)

    def rr(self, box, radius=12, fill=None, outline=None, width=1):
        self.d.rounded_rectangle(tuple(px(v) for v in box), px(radius), fill=fill,
                                 outline=outline, width=px(width))

    def line(self, points, fill, width=1):
        self.d.line([tuple(px(v) for v in p) for p in points], fill=fill, width=px(width), joint="curve")

    def ellipse(self, box, fill=None, outline=None, width=1):
        self.d.ellipse(tuple(px(v) for v in box), fill=fill, outline=outline, width=px(width))

    def txt(self, x, y, text, size=18, color=None, kind="regular", anchor=None):
        self.d.text((px(x), px(y)), localized(text), font=font(size, kind), fill=color or C["ink"], anchor=anchor)

    def center(self, y, text, size=18, color=None, kind="regular", w=1280):
        tw = self.d.textlength(localized(text), font=font(size, kind)) / S
        self.txt((w-tw)/2, y, text, size, color, kind)

    def check(self, x, y, color=None, size=14):
        self.line([(x, y+size*.48), (x+size*.33, y+size*.83), (x+size, y)], color or C["green"], 2.2)

    def pill(self, x, y, text, color=None, fill=None, size=12):
        tw = self.d.textlength(localized(text), font=font(size)) / S
        self.rr((x, y, x+tw+24, y+28), 8, fill or C["raised"])
        self.txt(x+12, y+4, text, size, color or C["mint"])
        return tw+24

    def logo(self, x, y, size=35):
        self.im.alpha_composite(logo_image(px(size)), (px(x), px(y)))


@lru_cache(maxsize=16)
def logo_image(size):
    """Use the canonical SVG at every size, with supersampling for smooth joins."""
    data = resvg_py.svg_to_bytes(
        svg_path=str(ROOT.parent / "icons" / "main-icon-d4-layer-bridges.svg"),
        width=size*3, height=size*3,
    )
    return Image.open(io.BytesIO(data)).convert("RGBA").resize((size,size),Image.Resampling.LANCZOS)


def clamp(v):
    return max(0, min(1, v))


def ease(v):
    v = clamp(v)
    return 1-(1-v)**3


def enter(t, start=0, duration=.7):
    return ease((t-start)/duration)


def paste(dst, src, x=0, y=0, alpha=1):
    if alpha <= 0:
        return
    if isinstance(src, Canvas):
        src = src.im
    if alpha < .999:
        src = src.copy()
        src.putalpha(src.getchannel("A").point(lambda a: round(a * clamp(alpha))))
    dst.alpha_composite(src, (px(x), px(y)))


def reveal(dst, src, x, y, t, start=0, duration=.7, dy=20):
    q = enter(t, start, duration)
    paste(dst, src, x, y+(1-q)*dy, q)


def surface(w, h, fill=None, outline=None, radius=16, shadow=True):
    a = Canvas(w, h)
    a.rr((1,1,w-1,h-1), radius, fill or C["panel"], outline or C["line"])
    return a


@lru_cache(maxsize=1)
def background():
    yy, xx = np.mgrid[0:H,0:W].astype(np.float32)
    r = np.exp(-(((xx-W*.78)/(W*.48))**2+((yy-H*.30)/(H*.7))**2)*2)
    base = np.array(rgb(C["bg"]), dtype=np.float32)
    arr = base + r[...,None]*np.array([7,18,10],dtype=np.float32)
    noise = np.random.default_rng(18).uniform(-.7,.7,(H,W,1))
    im = Image.fromarray(np.uint8(np.clip(arr+noise,0,255))).convert("RGBA")
    c = Canvas(image=im)
    for x in range(72,1280,64):
        for y in range(110,640,64):
            c.ellipse((x,y,x+1.4,y+1.4),fill="#284133")
    c.line([(72,76),(1208,76)],C["line"])
    c.logo(72,25,32)
    c.txt(116,27,"Pi Memory System",17,kind="latin")
    return c.im


def base(i):
    c = Canvas(image=background().copy())
    c.txt(917,31,"产品流程示意 · 示例数据",12,C["subtle"])
    c.txt(1159,29,f"{i+1:02d} / 07",13,C["muted"],"mono")
    return c


def heading(c, t, number, title, sub):
    a = Canvas(1150,112)
    a.txt(0,0,f"{number}  /  {SPEC['scenes'][int(number)-1]['label']}",12,C["mint"])
    a.txt(0,28,title,39,kind="bold")
    a.txt(0,89,sub,17,C["muted"])
    reveal(c.im,a,72,101,t,0,.65,12)


def chat_header(c, title, width):
    c.ellipse((20,21,27,28),C["red"])
    c.ellipse((35,21,42,28),C["amber"])
    c.ellipse((50,21,57,28),C["green"])
    c.txt(78,14,title,13,C["muted"])
    c.line([(1,48),(width-1,48)],C["line"])


@lru_cache(maxsize=16)
def memory_card(kind, title, body1, body2, width=260, height=136):
    accents = {"事实":C["mint"],"方法":C["amber"],"待办":C["blue"],"成果":C["paper"],
               "Fact":C["mint"],"Method":C["amber"],"Task":C["blue"],"Deliverable":C["paper"]}
    color = accents[kind]
    a = surface(width,height)
    a.rr((18,19,22,height-19),2,color)
    a.txt(35,17,kind,12,color)
    a.txt(35,41,title,19,kind="bold")
    a.txt(35,78,body1,14,C["muted"])
    if body2 and height >= 130:
        a.txt(35,102,body2,14,C["muted"])
    return a.im


CARDS_ZH = [
    ("事实","订单模块的约定","新增记录按时间倒序","同秒记录用 id 区分"),
    ("方法","稳定排序的修复","created_at DESC","再加 id DESC"),
    ("待办","补上回归用例","覆盖同秒连续创建","任务状态：待办"),
    ("成果","订单接口文档","docs/orders.md","保留交付入口"),
]
CARDS_EN = [
    ("Fact","Orders module","Newest records first","Use ID to break ties"),
    ("Method","Reliable ordering","created_at DESC","then id DESC"),
    ("Task","Add regression test","Cover same-second inserts","Status: open"),
    ("Deliverable","Orders API guide","docs/orders.md","Keep a link to the deliverable"),
]
CARDS = CARDS_EN if EN else CARDS_ZH


@lru_cache(maxsize=1)
def pain_cards():
    result=[]
    stories = ([
        ("Project context","We discussed the orders module yesterday."),
        ("Decision","Use ID to sort records created at the same time."),
        ("Next step","Add the regression test today."),
    ] if EN else [
        ("项目背景","订单模块，我们昨天讨论过。"),
        ("做过的决定","同秒创建，排序要补上 id。"),
        ("还没做完","回归用例，今天接着写。")])
    for i,(title,body) in enumerate(stories):
        a=surface(430,104)
        a.pill(22,17,title,[C["mint"],C["amber"],C["blue"]][i])
        a.txt(22,60,body,17)
        result.append(a.im)
    return result


def scene0(t):
    c=base(0)
    title=Canvas(610,360)
    title.pill(0,0,"跨会话工作，总有这一刻",C["amber"])
    title.txt(0,60,"昨天刚说清，",46,kind="bold")
    title.txt(0,126,"今天又要重来？",46,kind="bold")
    title.txt(0,213,"背景、约定、未完事项……",22,C["muted"])
    title.txt(0,256,"每次重新解释，都会打断工作的连续性。",17,C["muted"])
    paste(c.im,title,72,150)
    for i,a in enumerate(pain_cards()):
        reveal(c.im,a,733-i*17,159+i*119+math.sin(t*.8+i)*3,t,.4+i*.48,.75)
    foot=Canvas(570,52)
    foot.line([(0,12),(36,12)],C["green"],2)
    foot.txt(48,0,"让 Pi 更容易接着上次的进度工作",16,C["mint"])
    reveal(c.im,foot,72,535,t,1.65,.7)
    return c.im


@lru_cache(maxsize=1)
def extraction_chat():
    a=surface(365,324)
    chat_header(a,"昨天 · 订单项目",365)
    a.pill(24,70,"用户",C["mint"])
    a.txt(24,116,"同秒创建的订单顺序不稳定。",17)
    a.txt(24,146,"修复后，补一个回归用例。",17)
    a.line([(24,194),(340,194)],C["line"])
    a.logo(24,217,27)
    a.txt(65,216,"Pi",17,C["mint"],"latin")
    a.txt(24,257,"把这次讨论沉淀下来。",18,kind="bold")
    return a.im


def scene1(t):
    c=base(1)
    heading(c,t,"02","让对话，留下可用的经验。","自动提炼有价值的信息，保存为可以独立复用的记忆。")
    reveal(c.im,extraction_chat(),72,245,t,.15)
    flow=Canvas(91,120)
    flow.line([(0,58),(68,58)],C["green"],2)
    flow.line([(60,50),(68,58),(60,66)],C["green"],2)
    for j in range(3):
        xx=10+((t*32+j*26)%52)
        flow.ellipse((xx,54,xx+7,61),C["mint"])
    reveal(c.im,flow,455,330,t,.4)
    for i,row in enumerate(CARDS):
        x=557+(i%2)*291
        y=245+(i//2)*164
        reveal(c.im,memory_card(*row,width=279,height=146),x,y,t,.7+i*.42)
    foot=Canvas(1000,35)
    foot.txt(0,0,"后台按阈值提取，也支持手动触发。",14,C["muted"])
    reveal(c.im,foot,72,595,t,2.6)
    return c.im


@lru_cache(maxsize=1)
def project_scene():
    a=surface(594,317)
    if EN:
        a.pill(24,22,"Project story",C["mint"])
        a.txt(24,72,"Orders list · reliable sorting fix",24,kind="bold")
        a.txt(24,120,"Related conversations and memories, organized with project context.",14,C["muted"])
        steps = [
            ("Problem","Same-second inserts can appear out of order",C["amber"]),
            ("Decision","Sort by created_at, then by id",C["mint"]),
            ("Next","Add a regression test to verify the fix",C["blue"]),
        ]
    else:
        a.pill(24,22,"工作场景",C["mint"])
        a.txt(24,72,"订单列表 · 稳定排序修复",25,kind="bold")
        a.txt(24,120,"把相关的讨论与记忆，整理成有背景的项目经历。",15,C["muted"])
        steps = [
            ("发现","同秒创建时，列表顺序不稳定",C["amber"]),
            ("决定","用 created_at 与 id 共同排序",C["mint"]),
            ("下一步","添加回归用例，验证修复",C["blue"]),
        ]
    a.line([(40,184),(40,264)],C["line"],2)
    for i,(k,txt,color) in enumerate(steps):
        y=176+i*43
        a.ellipse((34,y+7,46,y+19),color)
        a.txt(64,y,k,14,color)
        a.txt(131,y,txt,16)
    return a.im


def scene2(t):
    c=base(2)
    heading(c,t,"03","把零散记录，整理成项目脉络。","从独立记忆到工作场景，保留事情的来龙去脉。")
    for i,row in enumerate(CARDS[:3]):
        a=memory_card(*row,width=335,height=112)
        reveal(c.im,a,72+i*12,242+i*117,t,.2+i*.3)
    wire=Canvas(143,299)
    wire.line([(0,31),(55,31),(55,253),(0,253)],C["line"],2)
    wire.line([(55,145),(119,145)],C["green"],2)
    wire.line([(110,137),(119,145),(110,153)],C["green"],2)
    reveal(c.im,wire,444,270,t,.8)
    reveal(c.im,project_scene(),614,252,t,1.15)
    note=Canvas(1050,36)
    note.txt(0,0,"场景用于组织与后续处理；当前不会自动注入每轮前台回答。",14,C["muted"])
    reveal(c.im,note,72,595,t,1.75)
    return c.im


@lru_cache(maxsize=2)
def recall_chat(recalled=False):
    a=surface(647,342)
    chat_header(a,"第二天 · 一个新会话",647)
    a.pill(24,66,"用户",C["mint"])
    a.txt(24,105,"继续订单列表的排序修复，",21,kind="bold")
    a.txt(24,143,"接下来做什么？",21,kind="bold")
    a.line([(24,193),(623,193)],C["line"])
    a.logo(24,214,26)
    if recalled:
        a.txt(65,213,"Pi · 结合召回记录",14,C["mint"])
        a.txt(24,254,"沿用 created_at + id 的排序约定，",18)
        a.txt(24,288,"先补同秒连续创建的回归用例。",18)
    else:
        a.txt(65,213,"正在查找相关记忆…",14,C["muted"])
        a.rr((24,265,411,276),5,C["raised"])
        a.rr((24,298,302,309),5,C["raised"])
    return a.im


def scene3(t):
    c=base(3)
    heading(c,t,"04","换个会话，也能接着往下做。","按当前问题找回相关经验，让已有约定与待办参与回答。")
    reveal(c.im,recall_chat(t>=3.65),72,243,t,.15)
    label=Canvas(410,36)
    label.txt(0,0,"相关记忆 · L1",14,C["mint"])
    reveal(c.im,label,779,245,t,.8)
    for i,row in enumerate(CARDS[1:3]):
        reveal(c.im,memory_card(*row,width=429,height=132),779,286+i*151,t,1.1+i*.7,dy=-18)
    q=enter(t,3.15,.9)
    connector=Canvas(61,222)
    connector.line([(60,39),(28,39),(28,171),(0,171)],C["green"],2)
    connector.line([(8,163),(0,171),(8,179)],C["green"],2)
    paste(c.im,connector,718,326,q)
    if 2.3<t<3.65:
        travel=enter(t,2.3,1.35)
        chip=Canvas(189,37)
        chip.rr((1,1,188,36),8,C["mint"])
        chip.txt(13,6,"相关记忆 → 回答上下文",12,C["dark"])
        paste(c.im,chip,785-365*travel,420+58*travel,math.sin(math.pi*travel)*.95)
    if t>3.8:
        glow=Canvas(647,136)
        glow.rr((1,1,646,135),12,None,C["green"],2)
        paste(c.im,glow,72,449,.28+.2*math.sin(t*1.3))
    note=Canvas(1140,42)
    note.txt(0,0,"语义召回需配置 Embedding、开启向量化并建立向量；相关记录不保证每次命中。",13,C["muted"])
    reveal(c.im,note,72,605,t,1.4)
    return c.im


@lru_cache(maxsize=2)
def viewer(done=False):
    a=surface(1136,330)
    chat_header(a,"记忆查看器 · 操作示意",1136)
    a.rr((1,49,210,329),0,"#16231D")
    a.txt(24,71,"记忆库",13,C["muted"])
    for i,name in enumerate(["L1 记录","L2 场景","L3 画像","处理队列"]):
        y=112+i*45
        if i==0:
            a.rr((16,y-4,194,y+31),7,C["raised"])
        a.txt(28,y,name,15,C["mint"] if i==0 else C["muted"])
    a.txt(238,73,"订单项目 / 回归用例",23,kind="bold")
    a.pill(928,72,"已完成" if done else "待办",C["mint"] if done else C["blue"])
    a.txt(238,126,"覆盖同秒连续创建，验证列表顺序稳定。",21)
    a.txt(238,169,"来源：昨天的项目对话 · 保留原始消息标识",14,C["muted"])
    a.line([(238,209),(1110,209)],C["line"])
    for i,txt in enumerate(["查看来源","修正内容","删除记录"]):
        x=238+i*140
        a.rr((x,232,x+123,272),8,C["raised"],C["line"])
        a.txt(x+24,241,txt,14,C["red"] if i==2 else C["muted"])
    a.rr((898,232,1109,277),9,C["mint"] if done else C["raised"],C["green"])
    if done:
        a.check(917,247,C["dark"],13)
    a.txt(944 if done else 931,242,"已标记完成" if done else "标记为已完成",15,C["dark"] if done else C["mint"],"bold")
    a.txt(238,292,"记录可查看、可修正；任务状态与记录删除分别管理。",13,C["muted"])
    return a.im


def cursor(c,x,y,click=0):
    c.d.polygon([(px(x),px(y)),(px(x+3),px(y+24)),(px(x+10),px(y+17)),(px(x+18),px(y+17))], fill=C["ink"],outline=C["dark"])
    if click>0:
        r=11+click*24
        c.ellipse((x-r,y-r,x+r,y+r),outline=(*rgb(C["mint"]),round(180*(1-click))),width=1.6)


def scene4(t):
    c=base(4)
    heading(c,t,"05","记忆看得见，也改得动。","待办、已完成、已废弃，分别管理；内容不准确时，可以修正。")
    reveal(c.im,viewer(t>=2.85),72,247,t,.2)
    if 1.2<t<4.4:
        q=enter(t,1.2,1.4)
        cursor(c,760+q*309,602-q*95,clamp((t-2.85)/.55) if 2.85<t<3.4 else 0)
    note=Canvas(1070,34)
    note.check(0,6,C["mint"],14)
    note.txt(27,0,"把经验留下，也把决定权留给你。",17,C["mint"])
    reveal(c.im,note,72,598,t,3.5)
    return c.im


@lru_cache(maxsize=2)
def proposal(selected=False):
    a=surface(527,288)
    a.pill(24,19,"提议稿",C["amber"])
    a.txt(24,65,"USER-temp.md",23,kind="mono")
    a.txt(24,103,"系统归纳长期偏好，等待你审阅。",15,C["muted"])
    for i,line in enumerate(["偏好先给结论，再解释依据。","涉及数据变更，先做备份。"]):
        y=157+i*45
        a.rr((24,y,43,y+19),4,C["mint"] if selected else C["panel"],C["mint"] if selected else C["subtle"])
        if selected:
            a.check(28,y+4,C["dark"],11)
        a.txt(57,y-3,line,16)
    return a.im


@lru_cache(maxsize=2)
def profile(merged=False):
    a=surface(527,288,fill="#1C3025",outline=C["line"])
    a.pill(24,19,"正式画像",C["mint"])
    a.txt(24,65,"USER.md",23,kind="mono")
    a.txt(24,103,"确认并入后，供之后的新会话读取。",15,C["muted"])
    if merged:
        for i,line in enumerate(["先给结论，再解释依据。","数据变更前，先做备份。"]):
            y=157+i*45
            a.check(24,y+4,C["mint"],14)
            a.txt(57,y-3,line,16)
    else:
        a.txt(24,172,"等待用户确认",21,C["subtle"])
    return a.im


def scene5(t):
    c=base(5)
    heading(c,t,"06","长期画像，由你确认。","系统提出建议，你决定哪些偏好进入正式画像。")
    reveal(c.im,proposal(t>=1.7),72,248,t,.2)
    reveal(c.im,profile(t>=3.4),681,248,t,.45)
    flow=Canvas(82,84)
    flow.line([(0,30),(63,30)],C["green"],2)
    flow.line([(55,22),(63,30),(55,38)],C["green"],2)
    reveal(c.im,flow,608,365,t,.7)
    btn=Canvas(290,50)
    btn.rr((1,1,289,49),11,C["mint"] if t>=3.4 else C["raised"],C["green"])
    btn.center(10,"已并入正式画像" if t>=3.4 else "确认并入选中条目",17,C["dark"] if t>=3.4 else C["mint"],"bold",290)
    reveal(c.im,btn,444,556,t,1.25)
    if t>2.15:
        q=enter(t,2.15,.95)
        cursor(c,841-q*176,621-q*39,clamp((t-3.4)/.45) if 3.4<t<3.85 else 0)
    return c.im


def scene6(t):
    c=base(6)
    hero=Canvas(1280,469)
    hero.logo(596,0,88)
    hero.center(114,"让每次对话，",44,kind="bold")
    hero.center(176,"都成为下一次工作的起点。",44,C["mint"],"bold")
    hero.center(259,"pi-memory-system",26,C["ink"],"latin")
    hero.center(309,"提炼记忆  /  按需召回  /  由你掌控",19,C["muted"])
    hero.rr((413,364,867,419),12,C["mint"])
    hero.center(376,"查看项目与安装说明",20,C["dark"],"bold")
    reveal(c.im,hero,0,115,t,0,.8,16)
    footer=Canvas(1280,58)
    footer.center(0,"github.com/yinwenyuan28-afk/pi-memory-system",15,C["muted"],"mono")
    footer.center(31,"面向 Windows 上的 Pi 用户 · 语义召回需完成配置",14,C["subtle"])
    reveal(c.im,footer,0,567,t,.5,.7)
    return c.im


SCENES=[scene0,scene1,scene2,scene3,scene4,scene5,scene6]


def stamp(seconds):
    ms=round(seconds*1000)
    return f"{ms//3600000:02d}:{ms//60000%60:02d}:{ms//1000%60:02d},{ms%1000:03d}"


def captions():
    data=[]
    for scene in SPEC["scenes"]:
        count=sum(len(v) for v in scene["captions"])
        start=scene["start"]+.18
        usable=scene["end"]-start-.14
        for text in scene["captions"]:
            end=start+usable*len(text)/count
            data.append((start,end,text))
            start=end
    return data


CAPTIONS=captions()


def render_frame(t, subtitles=True):
    idx=max(i for i,s in enumerate(SPEC["scenes"]) if t>=s["start"])
    local=t-SPEC["scenes"][idx]["start"]
    im=SCENES[idx](local)
    duration=.34
    if idx and local<duration:
        old=SCENES[idx-1](SPEC["scenes"][idx-1]["end"]-SPEC["scenes"][idx-1]["start"])
        im=Image.blend(old,im,ease(local/duration))
    c=Canvas(image=im)
    if subtitles:
        for start,end,text in CAPTIONS:
            if start<=t<end:
                size=21
                tw=c.d.textlength(text,font=font(size))/S
                x=(1280-tw)/2
                c.rr((x-22,650,x+tw+22,697),11,"#0D1714")
                c.txt(x,658,text,size)
                break
    return im.convert("RGB")


def media_duration(path):
    return float(subprocess.check_output([FFPROBE,"-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",str(path)],text=True).strip())


def ffmpeg(args):
    subprocess.run([FFMPEG,"-hide_banner","-loglevel","error","-y",*map(str,args)],check=True)


async def speech():
    import edge_tts
    async def one(i, scene):
        dest=BUILD/f"voice-{i}.mp3"
        if dest.exists() and dest.stat().st_size>1000:
            return
        await edge_tts.Communicate(scene["voice"],SPEC["voice"],rate="+8%",pitch="-1Hz").save(str(dest))
        print(f"Voice {i+1}/7 ready",flush=True)
    await asyncio.gather(*(one(i,s) for i,s in enumerate(SPEC["scenes"])))


def prepare_audio():
    asyncio.run(speech())
    rate=48000
    n=int(TOTAL*rate)
    narrator=np.zeros(n,dtype=np.float64)
    for i,scene in enumerate(SPEC["scenes"]):
        mp3=BUILD/f"voice-{i}.mp3"
        duration=media_duration(mp3)
        available=scene["end"]-scene["start"]-.60
        speed=max(1,duration/available)
        wav=BUILD/f"voice-{i}.wav"
        ffmpeg(["-i",mp3,"-af",f"atempo={speed:.5f}","-ar",rate,"-ac",1,"-c:a","pcm_s16le",wav])
        with wave.open(str(wav),"rb") as stream:
            pcm=np.frombuffer(stream.readframes(stream.getnframes()),dtype="<i2").astype(np.float64)/32768
        start=int((scene["start"]+.24)*rate)
        length=min(len(pcm),n-start)
        narrator[start:start+length]+=pcm[:length]*.98
        print(f"Voice {i+1}: original {duration:.2f}s, fit speed {speed:.3f}, window {available:.2f}s",flush=True)

    # Original, procedurally composed music. Gentle pad progression + bell notes.
    time=np.arange(n)/rate
    music=np.zeros(n,dtype=np.float64)
    chords=[(130.81,164.81,196.00),(110,130.81,164.81),(87.31,130.81,174.61),(98,146.83,196)]
    for k in range(8):
        start=k*6
        end=min(TOTAL,start+8)
        if start>=TOTAL:
            break
        a,b=int(start*rate),int(end*rate)
        tt=np.arange(b-a)/rate
        env=np.minimum(1,tt/1.1)*np.minimum(1,(end-start-tt)/1.7)
        for j,hz in enumerate(chords[k%4]):
            osc=np.sin(2*np.pi*hz*tt+j*.7)+.25*np.sin(2*np.pi*hz*2.002*tt)
            music[a:b]+=osc*env*.007
    melody=[523.25,659.25,783.99,659.25,587.33,523.25,440,523.25]
    for k in range(22):
        start=1.1+k*2
        a=int(start*rate)
        b=min(n,a+int(2.6*rate))
        tt=np.arange(b-a)/rate
        hz=melody[k%len(melody)]
        env=(1-np.exp(-tt*50))*np.exp(-tt*2.4)
        music[a:b]+=(np.sin(2*np.pi*hz*tt)+.28*np.sin(2*np.pi*hz*2.001*tt))*env*.022
    for scene in SPEC["scenes"][1:]:
        a=int(scene["start"]*rate)
        b=min(n,a+int(.55*rate))
        tt=np.arange(b-a)/rate
        music[a:b]+=np.sin(2*np.pi*(660*tt+180*tt**2))*np.sin(np.pi*tt/.55)**2*.012
    fade=np.minimum(1,time/1.2)*np.minimum(1,(TOTAL-time)/1.7)
    music*=fade
    mixed=np.clip(narrator+music,-.97,.97)
    with wave.open(str(BUILD/"mix.wav"),"wb") as out:
        out.setnchannels(2)
        out.setsampwidth(2)
        out.setframerate(rate)
        # Stereo width stays subtle to keep the narration centered.
        left=np.clip(mixed+music*.11,-.98,.98)
        right=np.clip(mixed-np.roll(music,713)*.11,-.98,.98)
        out.writeframes(np.int16(np.stack([left,right],axis=1)*32767).tobytes())
    print("Narration and original music mixed.",flush=True)


def previews():
    tiles=[]
    for i,scene in enumerate(SPEC["scenes"]):
        t=scene["start"]+(scene["end"]-scene["start"])*.72
        frame=render_frame(t)
        frame.save(BUILD/f"preview-{i+1}.png")
        tile=frame.resize((640,360),Image.Resampling.LANCZOS)
        tiles.append(tile)
    sheet=Image.new("RGB",(1280,1440),C["bg"])
    for i,tile in enumerate(tiles):
        sheet.paste(tile,(i%2*640,i//2*360))
    sheet.save(BUILD/"contact-sheet.jpg",quality=93)
    render_frame(43.4,subtitles=False).save(ROOT/SPEC.get("output_poster","poster.jpg"),quality=96)
    print(BUILD/"contact-sheet.jpg",flush=True)


def render():
    video=BUILD/"silent.mp4"
    log=BUILD/"encode.log"
    cmd=[FFMPEG,"-hide_banner","-loglevel","error","-y","-f","rawvideo","-pix_fmt","rgb24",
         "-s",f"{W}x{H}","-r",str(FPS),"-i","pipe:0","-an","-c:v","libx264","-preset","fast",
         "-crf","18","-pix_fmt","yuv420p","-movflags","+faststart",str(video)]
    with log.open("w") as err:
        proc=subprocess.Popen(cmd,stdin=subprocess.PIPE,stderr=err)
        try:
            for i in range(int(TOTAL*FPS)):
                proc.stdin.write(render_frame(i/FPS).tobytes())
                if i%(FPS*3)==0:
                    print(f"Rendering {i/FPS:05.1f}s / {TOTAL}s",flush=True)
            proc.stdin.close()
            code=proc.wait()
        except BaseException:
            proc.kill()
            proc.wait()
            raise
    if code:
        raise RuntimeError(log.read_text())
    final=ROOT/SPEC.get("output_mp4","pi-memory-system-promo-zh.mp4")
    mix=BUILD/"mix.wav"
    if mix.exists():
        ffmpeg(["-i",video,"-i",mix,"-c:v","copy","-af","loudnorm=I=-16:TP=-1.5:LRA=9",
                "-c:a","aac","-ar","48000","-b:a","192k","-t",TOTAL,"-movflags","+faststart",final])
    else:
        shutil.copy2(video,final)
    print(f"Saved {final}",flush=True)


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--prepare-audio",action="store_true")
    p.add_argument("--preview",action="store_true")
    p.add_argument("--render",action="store_true")
    args=p.parse_args()
    srt=[]
    for i,(start,end,text) in enumerate(CAPTIONS,1):
        srt.append(f"{i}\n{stamp(start)} --> {stamp(end)}\n{text}\n")
    (ROOT/SPEC.get("output_subtitles","subtitles.zh.srt")).write_text("\n".join(srt),encoding="utf-8")
    if args.prepare_audio:
        prepare_audio()
    if args.preview:
        previews()
    if args.render:
        render()


if __name__=="__main__":
    main()
