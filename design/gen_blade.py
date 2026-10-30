import io, math

def sub(a,b): return (a[0]-b[0], a[1]-b[1])
def add(a,b): return (a[0]+b[0], a[1]+b[1])
def mul(a,k): return (a[0]*k, a[1]*k)
def norm(v):
    l=math.hypot(*v) or 1.0
    return (v[0]/l, v[1]/l)

def poly(pts, widths):
    left=[]; right=[]
    n=len(pts)
    for i,p in enumerate(pts):
        if i==0: d=norm(sub(pts[1],pts[0]))
        elif i==n-1: d=norm(sub(pts[-1],pts[-2]))
        else: d=norm(add(norm(sub(p,pts[i-1])), norm(sub(pts[i+1],p))))
        nx,ny=-d[1],d[0]
        left.append(add(p,(nx*widths[i], ny*widths[i])))
        right.append(sub(p,(nx*widths[i], ny*widths[i])))
    return left+right[::-1]

def fmt(pts):
    return "M " + " L ".join(f"{x:.1f} {y:.1f}" for x,y in pts) + " Z"

OUTER  = poly([(150,108),(386,108),(386,352)], [20,20,20])
DART   = [(368,346),(404,346),(420,412),(386,384),(352,412)]
SECOND = poly([(74,120),(100,182),(100,392),(336,392)], [0,21,20,0])
INNER  = poly([(322,196),(322,336),(196,336)], [18,18,0])

SQUARE = "".join(f'      <path d="{fmt(p)}"/>\n' for p in [OUTER, DART, SECOND, INNER])

# 下方那枚向下的箭头/尖锋（草稿下半部分）
CHEV = [
    [(118,330),(256,382),(394,330),(394,356),(256,408),(118,356)],
    [(240,402),(256,488),(272,402)],
]
CHEV_SVG = "".join(f'      <path d="{fmt(p)}"/>\n' for p in CHEV)

DEFS = '''    <linearGradient id="plate" x1="0" y1="0" x2="0.9" y2="1">
      <stop offset="0" stop-color="#46515C"/><stop offset="0.5" stop-color="#232A31"/><stop offset="1" stop-color="#0D1217"/>
    </linearGradient>
    <linearGradient id="steel" x1="0.1" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/><stop offset="0.2" stop-color="#D5DEE8"/>
      <stop offset="0.5" stop-color="#A2AEBB"/><stop offset="0.78" stop-color="#6E7986"/><stop offset="1" stop-color="#4B555F"/>
    </linearGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.75"/>
      <stop offset="0.3" stop-color="#FFFFFF" stop-opacity="0.18"/>
      <stop offset="0.65" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.45" r="0.62">
      <stop offset="0" stop-color="#3B4753" stop-opacity="0.55"/><stop offset="1" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <pattern id="brush" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(38)">
      <line x1="0" y1="0" x2="0" y2="7" stroke="#FFFFFF" stroke-opacity="0.045" stroke-width="1"/>
    </pattern>
    <filter id="drop" x="-25%" y="-25%" width="150%" height="160%">
      <feDropShadow dx="0" dy="7" stdDeviation="6" flood-color="#000000" flood-opacity="0.55"/>
    </filter>'''

def build(body):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
{DEFS}
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#plate)"/>
  <rect width="512" height="512" rx="112" fill="url(#glow)"/>
  <rect width="512" height="512" rx="112" fill="url(#brush)"/>
  <g filter="url(#drop)">
{body}
  </g>
</svg>
'''

body_square = f'''    <g fill="url(#steel)" stroke="#080A0D" stroke-width="3" stroke-linejoin="miter">
{SQUARE}    </g>
    <g fill="none" stroke="url(#rim)" stroke-width="2" stroke-linejoin="miter">
{SQUARE}    </g>'''

body_full = f'''    <g transform="translate(256 150) scale(0.56) translate(-242 -266)">
      <g fill="url(#steel)" stroke="#080A0D" stroke-width="4" stroke-linejoin="miter">
{SQUARE}      </g>
    </g>
    <g fill="url(#steel)" stroke="#080A0D" stroke-width="3" stroke-linejoin="miter">
{CHEV_SVG}    </g>
    <g fill="none" stroke="url(#rim)" stroke-width="2" stroke-linejoin="miter" opacity="0.8">
{CHEV_SVG}    </g>'''

io.open('design/icon-blade.svg','w',encoding='utf-8').write(build(body_square))
io.open('design/icon-blade-full.svg','w',encoding='utf-8').write(build(body_full))
print('ok')
