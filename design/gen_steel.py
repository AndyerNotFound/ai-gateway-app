import io
# 三枚 L：直角、方头、统一厚度。外 L 拐角右上，第二枚拐角左下，内 L 拐角右下。
OUTER  = "M 92 96 H 428 V 398 H 388 V 136 H 92 Z"
SECOND = "M 84 170 H 124 V 410 H 348 V 370 H 84 Z"
INNER  = "M 338 182 H 370 V 352 H 176 V 320 H 338 Z"

def svg(plate, steel):
    plate_stops = "".join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in plate)
    steel_stops = "".join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in steel)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="plate" x1="0" y1="0" x2="0.9" y2="1">{plate_stops}</linearGradient>
    <linearGradient id="steel" x1="0.1" y1="0" x2="0.35" y2="1">{steel_stops}</linearGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.72"/>
      <stop offset="0.35" stop-color="#FFFFFF" stop-opacity="0.16"/>
      <stop offset="0.7" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.45" r="0.62">
      <stop offset="0" stop-color="#3B4753" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <pattern id="brush" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(38)">
      <line x1="0" y1="0" x2="0" y2="7" stroke="#FFFFFF" stroke-opacity="0.045" stroke-width="1"/>
    </pattern>
    <filter id="drop" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="7" stdDeviation="6" flood-color="#000000" flood-opacity="0.55"/>
    </filter>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#plate)"/>
  <rect width="512" height="512" rx="112" fill="url(#glow)"/>
  <rect width="512" height="512" rx="112" fill="url(#brush)"/>
  <g filter="url(#drop)">
    <g fill="url(#steel)" stroke="#080A0D" stroke-width="3" stroke-linejoin="miter">
      <path d="{OUTER}"/><path d="{SECOND}"/><path d="{INNER}"/>
    </g>
    <g fill="none" stroke="url(#rim)" stroke-width="2" stroke-linejoin="miter">
      <path d="{OUTER}"/><path d="{SECOND}"/><path d="{INNER}"/>
    </g>
  </g>
</svg>
'''

STEEL = [("0", "#FFFFFF"), ("0.2", "#D5DEE8"), ("0.5", "#A2AEBB"), ("0.78", "#6E7986"), ("1", "#4B555F")]
io.open('design/icon-steel.svg','w',encoding='utf-8').write(
    svg([("0", "#46515C"), ("0.5", "#232A31"), ("1", "#0D1217")], STEEL))
io.open('design/icon-steel-dark.svg','w',encoding='utf-8').write(
    svg([("0", "#2C343E"), ("0.5", "#161B21"), ("1", "#080B0F")], STEEL))
print('ok')
