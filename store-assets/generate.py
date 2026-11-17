#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Capx 商店素材生成器 —— 深色底 + 青色截图 / 橙色隐藏 双功能视觉。
用法: python3 store-assets/generate.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.dirname(os.path.abspath(__file__))

# ---------- 配色 ----------
BG       = (13, 17, 23)
BG2      = (17, 23, 31)
SURFACE  = (24, 30, 39)
SURFACE2 = (29, 36, 46)
LINE     = (42, 51, 64)
TEXT     = (230, 233, 239)
TEXT2    = (154, 164, 180)
TEXT3    = (107, 118, 134)
CYAN     = (34, 211, 238)
CYAN_DIM = (19, 120, 137)
ORANGE   = (240, 151, 107)
ORANGE_D = (140, 84, 58)
DOT      = (26, 33, 43)

SANS  = '/System/Library/Fonts/Hiragino Sans GB.ttc'
HEI_M = '/System/Library/Fonts/STHeiti Medium.ttc'

_cache = {}
def font(size, bold=False):
    key = (size, bold)
    if key not in _cache:
        _cache[key] = ImageFont.truetype(HEI_M if bold else SANS, size)
    return _cache[key]

def tw(d, text, f):
    b = d.textbbox((0, 0), text, font=f)
    return b[2] - b[0], b[3] - b[1]

def canvas(w, h):
    im = Image.new('RGB', (w, h), BG)
    d = ImageDraw.Draw(im)
    for y in range(0, h, 28):
        for x in range(0, w, 28):
            d.ellipse([x, y, x + 1, y + 1], fill=DOT)
    return im, d

def rrect(d, box, r, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)

def logo(d, x, y, accent=CYAN, scale=1.0):
    s = int(38 * scale)
    rrect(d, [x, y, x + s, y + s], int(10 * scale), fill=BG2, outline=accent, width=max(2, int(2 * scale)))
    # 四角取景框
    pad = int(9 * scale)
    arm = int(8 * scale)
    w = max(2, int(2 * scale))
    x0, y0, x1, y1 = x + pad, y + pad, x + s - pad, y + s - pad
    d.line([x0, y0, x0 + arm, y0], fill=accent, width=w)
    d.line([x0, y0, x0, y0 + arm], fill=accent, width=w)
    d.line([x1 - arm, y0, x1, y0], fill=accent, width=w)
    d.line([x1, y0, x1, y0 + arm], fill=accent, width=w)
    d.line([x0, y1, x0 + arm, y1], fill=accent, width=w)
    d.line([x0, y1 - arm, x0, y1], fill=accent, width=w)
    d.line([x1 - arm, y1, x1, y1], fill=accent, width=w)
    d.line([x1, y1 - arm, x1, y1], fill=accent, width=w)
    # 中心方块
    c = int(4 * scale)
    rrect(d, [x + s / 2 - c, y + s / 2 - c, x + s / 2 + c, y + s / 2 + c],
          int(1.5 * scale), outline=accent, width=w)

def brand(d, x, y, accent=CYAN, scale=1.0):
    logo(d, x, y, accent, scale)
    s = int(38 * scale)
    d.text((x + s + int(14 * scale), y + int(2 * scale)), 'Capx', font=font(int(23 * scale), True), fill=TEXT)

def heading(d, x, y, title, sub, accent=CYAN, title_size=40, sub_size=17):
    d.text((x, y), title, font=font(title_size, True), fill=TEXT)
    if sub:
        d.text((x, y + title_size + 14), sub, font=font(sub_size), fill=TEXT2)

def step_card(d, box, n, title, desc, accent):
    rrect(d, box, 12, fill=SURFACE, outline=LINE, width=1)
    x0, y0, x1, y1 = box
    s = 30
    bx = x0 + 18
    cy = (y0 + y1) / 2
    by = cy - s / 2 - 4
    rrect(d, [bx, by, bx + s, by + s], 8, fill=accent)
    d.text((bx + s / 2, by + s / 2 + 1), str(n), font=font(15, True), fill=BG, anchor='mm')
    d.text((bx + s + 14, by - 3), title, font=font(17, True), fill=TEXT)
    d.text((bx + s + 14, by + 27), desc, font=font(12), fill=TEXT2)

def browser_mock(d, box, accent=CYAN, erase_block=False, hide_blocks=False, badge=None, compact=False):
    x0, y0, x1, y1 = box
    rrect(d, box, 14, fill=SURFACE, outline=LINE, width=1)
    inner_l, inner_r = x0 + 22, x1 - 22
    if compact:
        cy = y0 + 16
    else:
        # 顶栏
        rrect(d, [x0, y0, x1, y0 + 36], 14, fill=SURFACE2)
        d.rectangle([x0, y0 + 24, x1, y0 + 36], fill=SURFACE2)
        for i, c in enumerate([(240, 100, 90), (240, 190, 90), (100, 200, 120)]):
            d.ellipse([x0 + 16 + i * 18, y0 + 13, x0 + 26 + i * 18, y0 + 23], fill=c)
        rrect(d, [x0 + 92, y0 + 8, x1 - 16, y0 + 28], 10, fill=BG)
        d.text((x0 + 104, y0 + 11), 'example.com/article', font=font(11), fill=TEXT3)
        cy = y0 + 54
    # 顶部三根短条
    cols = [0.30, 0.22, 0.26] if not compact else [0.34, 0.26]
    cx = inner_l
    for c in cols:
        w = int((inner_r - inner_l) * c)
        rrect(d, [cx, cy, cx + w, cy + 11], 5, fill=LINE)
        cx += w + 14
    cy += 26
    # 主块：要消除 / 已隐藏
    bh = 62
    if erase_block:
        rrect(d, [inner_l, cy, inner_r, cy + bh], 8, fill=CYAN)
        d.text(((inner_l + inner_r) / 2, cy + bh / 2), '这一块，点一下就消失',
               font=font(15, True), fill=BG, anchor='mm')
    elif hide_blocks:
        # 虚线框 + 淡底，表示“已被移走”
        rrect(d, [inner_l, cy, inner_r, cy + bh], 8, fill=(38, 30, 27))
        d.rounded_rectangle([inner_l, cy, inner_r, cy + bh], radius=8,
                            outline=ORANGE, width=2)
        d.text(((inner_l + inner_r) / 2, cy + bh / 2), '已隐藏 · 不再出现',
               font=font(15, True), fill=ORANGE, anchor='mm')
    else:
        rrect(d, [inner_l, cy, inner_r, cy + bh], 8, fill=LINE)
    cy += bh + 16
    # 正文骨架：按段落排，避免一堵墙
    bottom = y1 - 18
    para = [[0.96, 0.88, 0.72], [0.93, 0.79, 0.55], [0.90, 0.66, 0.84]]
    pi = 0
    while cy + 10 <= bottom:
        widths = para[pi % len(para)]
        for frac in widths:
            if cy + 10 > bottom:
                break
            w = int((inner_r - inner_l) * frac)
            rrect(d, [inner_l, cy, inner_l + w, cy + 9], 4, fill=LINE)
            cy += 18
        cy += 8
        pi += 1

    if badge:
        bw, _ = tw(d, badge, font(12, True))
        bx = x1 - bw - 34
        by = y1 - 40
        rrect(d, [bx - 12, by - 6, x1 - 16, by + 24], 8, fill=accent)
        d.text((bx, by), badge, font=font(12, True), fill=BG)

def arrow_right(d, x, y, color, size=42):
    d.polygon([(x, y - size * 0.5), (x, y + size * 0.5), (x + size * 0.85, y)], fill=color)

def trash_icon(d, cx, cy, color, s=9):
    """手绘垃圾桶（字体常缺 🗑 字形）"""
    w = max(1, int(s / 5))
    d.line([cx - s * 0.45, cy - s * 0.5, cx + s * 0.45, cy - s * 0.5], fill=color, width=w)
    d.line([cx - s * 0.2, cy - s * 0.72, cx + s * 0.2, cy - s * 0.72], fill=color, width=w)
    d.rectangle([cx - s * 0.34, cy - s * 0.3, cx + s * 0.34, cy + s * 0.72],
                outline=color, width=w)
    d.line([cx - s * 0.1, cy - s * 0.08, cx - s * 0.1, cy + s * 0.5], fill=color, width=w)
    d.line([cx + s * 0.1, cy - s * 0.08, cx + s * 0.1, cy + s * 0.5], fill=color, width=w)

# ================= 1. Hero：双功能总览 =================
def gen_hero():
    im, d = canvas(1280, 800)
    brand(d, 64, 50)
    d.text((64 + 52, 92), '先消除，再截取  ·  点一下，永久隐藏', font=font(13), fill=TEXT3)
    heading(d, 64, 150, '一个插件，两种干净', '截图：擦掉不想要的，截完自动复原    ｜    隐藏：标记一次，以后打开就清爽')
    # 双卡片
    y = 300
    ch = 340
    cw = 556
    gap = 28
    # 左：截图（青）
    x = 64
    rrect(d, [x, y, x + cw, y + ch], 16, fill=SURFACE, outline=CYAN_DIM, width=1)
    rrect(d, [x + 26, y + 26, x + 70, y + 70], 12, fill=CYAN)
    d.text((x + 48, y + 48), '1', font=font(20, True), fill=BG, anchor='mm')
    d.text((x + 88, y + 30), '截图', font=font(24, True), fill=TEXT)
    d.text((x + 88, y + 62), '临时消除 · 圈选截取 · 无痕复原', font=font(13), fill=TEXT2)
    browser_mock(d, [x + 26, y + 104, x + cw - 26, y + ch - 26], CYAN, erase_block=True)
    # 右：隐藏（橙）
    x2 = 64 + cw + gap
    rrect(d, [x2, y, x2 + cw, y + ch], 16, fill=SURFACE, outline=ORANGE_D, width=1)
    rrect(d, [x2 + 26, y + 26, x2 + 70, y + 70], 12, fill=ORANGE)
    d.text((x2 + 48, y + 48), '2', font=font(20, True), fill=BG, anchor='mm')
    d.text((x2 + 88, y + 30), '隐藏元素', font=font(24, True), fill=TEXT)
    d.text((x2 + 88, y + 62), '按站授权 · 点击即隐 · 刷新依然生效', font=font(13), fill=TEXT2)
    browser_mock(d, [x2 + 26, y + 104, x2 + cw - 26, y + ch - 26], ORANGE, hide_blocks=True)
    # 底部三条特性
    fy = 686
    feats = [
        ('零联网 · 纯本地', '规则与截图都只存在本机', CYAN),
        ('截图只需 activeTab', '安装时不索要任何网站权限', CYAN),
        ('隐藏按站授权', '同意哪个站点，就只管那个站点', ORANGE),
    ]
    fx = 64
    for title, desc, accent in feats:
        rrect(d, [fx, fy, fx + 376, fy + 76], 12, fill=SURFACE, outline=LINE, width=1)
        d.ellipse([fx + 20, fy + 30, fx + 30, fy + 40], fill=accent)
        d.text((fx + 42, fy + 18), title, font=font(15, True), fill=TEXT)
        d.text((fx + 42, fy + 44), desc, font=font(12), fill=TEXT2)
        fx += 392
    im.save(os.path.join(OUT, '01-hero.png'))

# ================= 2. 截图流程 =================
def gen_capture():
    im, d = canvas(1280, 800)
    brand(d, 64, 50)
    heading(d, 64, 150, '截图的正确姿势：先擦掉，再截取',
            '不想要的广告、价格、隐私信息——点一下真实消失，下方内容自动上移')
    browser_mock(d, [64, 300, 770, 740], CYAN, erase_block=True)
    # 箭头
    arrow_right(d, 792, 500, CYAN)
    step_card(d, [846, 300, 1216, 420], 1, '悬停就近高亮', '鼠标移到哪，就高亮最近的元素', CYAN)
    step_card(d, [846, 440, 1216, 560], 2, '滚轮调范围', '向上滚到整块容器，调好不跳', CYAN)
    step_card(d, [846, 580, 1216, 700], 3, '点击即消除', 'display:none 真实退出布局，自动复原', CYAN)
    im.save(os.path.join(OUT, '02-capture.png'))

# ================= 3. 隐藏元素流程 =================
def gen_hide():
    im, d = canvas(1280, 800)
    brand(d, 64, 50, ORANGE)
    heading(d, 64, 150, '不想看的，点一下就没了',
            '按站授权后，点击即隐藏；以后打开这个网站，它都不会再出现', ORANGE)
    browser_mock(d, [64, 300, 770, 740], ORANGE, hide_blocks=True)
    arrow_right(d, 792, 500, ORANGE)
    step_card(d, [846, 300, 1216, 420], 1, '启用本站', '只授权当前网站，不申请全部网站权限', ORANGE)
    step_card(d, [846, 440, 1216, 560], 2, '连续点，立刻消失', '可多选，点错 Ctrl+Z 或明细里逐项恢复', ORANGE)
    step_card(d, [846, 580, 1216, 700], 3, '保存一次', '刷新、下次打开都自动隐藏', ORANGE)
    im.save(os.path.join(OUT, '03-hide.png'))

# ================= 4. 批量隐藏工具条 =================
def gen_batch():
    im, d = canvas(1280, 800)
    brand(d, 64, 50, ORANGE)
    heading(d, 64, 150, '连续点，一次保存',
            '点到的元素立刻从页面消失；顶部实时计数，错了随时撤销', ORANGE)
    # 工具条 mock
    bx, by, bw, bh = 64, 300, 1152, 62
    rrect(d, [bx, by, bx + bw, by + bh], 12, fill=SURFACE, outline=ORANGE, width=1)
    d.text((bx + 20, by + 20), '隐藏元素', font=font(16, True), fill=ORANGE)
    d.text((bx + 120, by + 22), '已隐藏 3 项 / 4 个元素 · 可继续点击', font=font(14), fill=TEXT2)
    # 按钮
    def btn(x, label, primary=False):
        w = tw(d, label, font(13, True))[0] + 28
        rrect(d, [x, by + 13, x + w, by + 49], 8,
              fill=ORANGE if primary else SURFACE2, outline=ORANGE if primary else LINE)
        d.text((x + w / 2, by + 31), label, font=font(13, True),
               fill=BG if primary else TEXT2, anchor='mm')
        return w
    x = bx + 660
    for lab, pri in [('明细', False), ('撤销', False), ('保存 3 项', True), ('清空', False), ('退出', False)]:
        x += btn(x, lab, pri) + 12
    # 明细卡片
    cx, cy = 200, 400
    rrect(d, [cx, cy, cx + 880, cy + 330], 16, fill=SURFACE, outline=LINE, width=1)
    d.text((cx + 28, cy + 24), '本次已隐藏 3 项', font=font(22, True), fill=TEXT)
    d.text((cx + 28, cy + 58), '这些元素已从页面消失。点 × 可恢复某一项；点「保存」后永久生效。', font=font(13), fill=TEXT2)
    rows = [
        ('div.card.ad-banner', '广告横幅 · 1 个元素', False),
        ('#sponsored-sidebar', '侧边推荐 · 2 个元素', True),
        ('div.notice-login', '登录提示 · 1 个元素', False),
    ]
    ry = cy + 100
    for sel, meta, multi in rows:
        rrect(d, [cx + 28, ry, cx + 852, ry + 58], 10, fill=BG2,
              outline=ORANGE if multi else LINE, width=1)
        d.text((cx + 44, ry + 9), sel, font=font(13, True), fill=CYAN)
        d.text((cx + 44, ry + 32), meta + (' · 影响多个元素' if multi else ''), font=font(11), fill=ORANGE if multi else TEXT3)
        d.text((cx + 830, ry + 28), '×', font=font(20), fill=TEXT3, anchor='mm')
        ry += 68
    im.save(os.path.join(OUT, '04-batch.png'))

# ================= 5. 规则管理 + 诊断 =================
def gen_rules():
    im, d = canvas(1280, 800)
    brand(d, 64, 50, ORANGE)
    heading(d, 64, 150, '规则清清楚楚，失效一眼看出',
            '每条规则都显示真实匹配状态；网站改版后失效？重新拾取就好', ORANGE)
    # 弹窗 mock
    px, py, pw, ph = 320, 300, 640, 440
    rrect(d, [px, py, px + pw, py + ph], 16, fill=SURFACE2, outline=LINE, width=1)
    # 切换
    rrect(d, [px + 24, py + 20, px + pw - 24, py + 62], 10, fill=BG)
    rrect(d, [px + 28, py + 24, px + 28 + 280, py + 58], 8, fill=SURFACE)
    d.text((px + 168, py + 41), '截图', font=font(14), fill=TEXT3, anchor='mm')
    rrect(d, [px + 316, py + 24, px + pw - 28, py + 58], 8,
          fill=(38, 30, 26), outline=ORANGE, width=1)
    d.text((px + 476, py + 41), '隐藏元素', font=font(14, True), fill=ORANGE, anchor='mm')
    # 本站状态
    d.text((px + 24, py + 84), '本站自动隐藏', font=font(14, True), fill=TEXT2)
    rrect(d, [px + 24, py + 110, px + pw - 24, py + 156], 10, fill=BG2, outline=ORANGE_D, width=1)
    # 手绘对勾（字体缺 ✓ 字形）
    chx, chy = px + 44, py + 128
    d.line([chx, chy + 6, chx + 5, chy + 12], fill=ORANGE, width=3)
    d.line([chx + 5, chy + 12, chx + 14, chy + 1], fill=ORANGE, width=3)
    d.text((px + 66, py + 121), '已启用 · 刷新本站依然自动隐藏', font=font(13), fill=ORANGE)
    # 规则条目
    d.text((px + 24, py + 180), '本站规则', font=font(14, True), fill=TEXT2)
    items = [
        ('div.card.ad-banner', '匹配 2 个 · 已全部隐藏', TEXT3, CYAN),
        ('#trending-sidebar', '匹配 1 个 · 靠文本匹配兜底', TEXT3, ORANGE),
        ('.old-promo', '匹配 0 个 · 选择器已失效', (248, 113, 113), (248, 113, 113)),
    ]
    ry = py + 210
    for sel, status, scol, selcol in items:
        rrect(d, [px + 24, ry, px + pw - 24, ry + 68], 10, fill=BG2, outline=LINE, width=1)
        d.text((px + 42, ry + 12), sel, font=font(13, True), fill=selcol)
        d.text((px + 42, ry + 38), status, font=font(11), fill=scol)
        trash_icon(d, px + pw - 48, ry + 34, TEXT3)
        ry += 76
    im.save(os.path.join(OUT, '05-rules.png'))

# ================= 小宣传图 440x280 =================
def gen_promo_small():
    im, d = canvas(440, 280)
    brand(d, 24, 20, CYAN, scale=0.7)
    d.text((24, 78), '截图 + 永久隐藏', font=font(21, True), fill=TEXT)
    d.text((24, 110), '擦掉再截，或点一下永久隐藏', font=font(11), fill=TEXT2)
    browser_mock(d, [24, 142, 416, 258], ORANGE, hide_blocks=True, compact=True)
    im.save(os.path.join(OUT, '06-promo-small.png'))

# ================= 大宣传图 1400x560 =================
def gen_promo_large():
    im, d = canvas(1400, 560)
    brand(d, 60, 46)
    d.text((60, 112), '截图 + 永久隐藏，一个插件搞定', font=font(34, True), fill=TEXT)
    d.text((60, 158), '临时擦掉再截，截完自动复原    ｜    标记一次，以后打开就自动隐藏', font=font(15), fill=TEXT2)
    # 左块
    x, y, w, h = 60, 212, 620, 312
    rrect(d, [x, y, x + w, y + h], 14, fill=SURFACE, outline=CYAN_DIM, width=1)
    d.text((x + 24, y + 20), '截图', font=font(20, True), fill=CYAN)
    browser_mock(d, [x + 24, y + 54, x + w - 24, y + h - 22], CYAN, erase_block=True)
    # 右块
    x2 = 720
    rrect(d, [x2, y, x2 + w, y + h], 14, fill=SURFACE, outline=ORANGE_D, width=1)
    d.text((x2 + 24, y + 20), '隐藏元素', font=font(20, True), fill=ORANGE)
    browser_mock(d, [x2 + 24, y + 54, x2 + w - 24, y + h - 22], ORANGE, hide_blocks=True)
    im.save(os.path.join(OUT, '07-promo-large.png'))

# ================= 图标 128x128 =================
def gen_icon():
    S = 512
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    # 圆角渐变底（用青->深蓝模拟）
    for y in range(S):
        t = y / S
        col = (int(34 - 10 * t), int(178 - 70 * t), int(207 - 60 * t), 255)
        d.line([(0, y), (S, y)], fill=col)
    mask = Image.new('L', (S, S), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, S - 1, S - 1], radius=110, fill=255)
    im.putalpha(mask)
    # 取景框（白）
    W = (255, 255, 255, 255)
    i, k, w = 130, 56, 22
    for seg in [
        (i, i + k, i, i, i + k, i),
        (S - i - k, i, S - i, i, S - i, i + k),
        (i, S - i - k, i, S - i, i + k, S - i),
        (S - i - k, S - i, S - i, S - i, S - i, S - i - k),
    ]:
        d.line(seg, fill=W, width=w, joint='curve')
    r = 58
    d.rounded_rectangle([S/2 - r, S/2 - r, S/2 + r, S/2 + r], radius=16, outline=W, width=w)
    # 右下角橙色小点：隐藏功能标识
    d.ellipse([S - 150, S - 150, S - 70, S - 70], fill=(240, 151, 107, 255))
    d.ellipse([S - 150, S - 150, S - 70, S - 70], outline=(255, 255, 255, 255), width=8)
    im = im.resize((128, 128), Image.LANCZOS)
    im.save(os.path.join(OUT, 'icon-128.png'))

if __name__ == '__main__':
    gen_hero(); gen_capture(); gen_hide(); gen_batch(); gen_rules()
    gen_promo_small(); gen_promo_large(); gen_icon()
    print('generated all store assets into', OUT)
