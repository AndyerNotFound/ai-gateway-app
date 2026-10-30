import io, subprocess

# 三枚 L 的中心线。坐标从草图归一化：外框 300x283，居中于 512。
OUTER = "M 108 108 C 190 102 310 102 402 104 C 410 104 414 110 414 120 L 414 372"
SECOND = "M 108 158 C 102 210 102 300 104 380 C 104 388 110 392 120 392 L 332 389"
INNER = "M 340 166 C 346 200 348 270 348 332 C 348 340 344 344 336 344 L 168 340"

CURLS_V1 = [
    "M 108 108 C 98 104 92 96 96 86",        # 最大：左上收笔
    "M 332 389 C 344 391 352 385 354 375",   # 第二：右下收笔
    "M 168 340 C 158 338 152 330 154 320",   # 最小：左端收笔（向上，避开第二枚的底横）
]
CURLS_V2 = CURLS_V1 + [
    "M 414 372 C 418 386 426 394 438 392",   # 最大：右下
    "M 108 158 C 98 154 90 146 92 136",      # 第二：左上
    "M 340 166 C 350 160 354 150 350 140",   # 最小：上端
]

def svg(curls, dark=True):
    bg = ('<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">'
          '<stop offset="0" stop-color="#241B33"/><stop offset="0.55" stop-color="#1C1B1F"/>'
          '<stop offset="1" stop-color="#141218"/></linearGradient>') if dark else \
         ('<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">'
          '<stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#F2EDFF"/></linearGradient>')
    fg = "#EADDFF" if dark else "#1C1B1F"
    body = "\n".join('    <path d="%s"/>' % c for c in curls)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>{bg}</defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <g fill="none" stroke="{fg}" stroke-linecap="round" stroke-linejoin="round">
    <g stroke-width="19">
      <path d="{OUTER}"/>
    </g>
    <g stroke-width="18">
      <path d="{SECOND}"/>
    </g>
    <g stroke-width="17">
      <path d="{INNER}"/>
    </g>
    <g stroke-width="19">
{body}
    </g>
  </g>
</svg>
'''

io.open('design/lll-v1.svg','w',encoding='utf-8').write(svg(CURLS_V1, True))
io.open('design/lll-v2.svg','w',encoding='utf-8').write(svg(CURLS_V2, True))
io.open('design/lll-v1-light.svg','w',encoding='utf-8').write(svg(CURLS_V1, False))
print('ok')
