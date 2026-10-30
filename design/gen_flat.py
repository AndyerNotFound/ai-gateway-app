import io

def path(pts):
    return "M " + " L ".join(f"{x} {y}" for x,y in pts) + " Z"

# 750x750，白形黑底
TOP    = [(150,130),(640,130),(640,188),(150,188)]
RIGHT  = [(584,188),(640,188),(640,548),(584,548)]
LEFT   = [(145,196),(200,196),(200,600),(145,600)]
BOTTOM = [(145,545),(505,545),(505,600),(145,600)]
# 左上长刃：从框外切进来，收在 (300,238)
BEAK   = [(62,88),(150,130),(150,188),(300,238)]
# 内层方框：一条 path 两条子路径，evenodd 挖空
INNER  = [(280,200),(575,200),(575,528),(280,528),
          (322,242),(322,486),(533,486),(533,242)]
# 内框左下小刺
SPIKE  = [(280,486),(208,528),(280,528)]
# 右下箭头
ARROW  = [(548,492),(700,492),(700,545),(644,545),(578,700),(540,576),(498,652),(540,545),(548,545)]

body = ""
for p in [TOP, RIGHT, LEFT, BOTTOM, BEAK, INNER, SPIKE, ARROW]:
    body += f'    <path d="{path(p)}"/>\n'

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 750" width="512" height="512">
  <rect width="750" height="750" fill="#000000"/>
  <g fill="#FFFFFF" fill-rule="evenodd">
{body}  </g>
</svg>
'''
io.open('design/icon-flat.svg','w',encoding='utf-8').write(svg)
print('ok')
