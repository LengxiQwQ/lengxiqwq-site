import ctypes, os
from ctypes import wintypes
from PIL import Image, ImageFilter

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

ani_dir = 'E:/新整理/美化/鼠标指针/Miku 完整版'
files = [
    ('Normal Select.ani', 'normal'),
    ('Link.ani', 'pointer'),
    ('Text Select.ani', 'text'),
    ('Unavailable.ani', 'not-allowed'),
    ('Help Select.ani', 'help'),
    ('Busy.ani', 'wait'),
    ('Work.ani', 'progress'),
    ('Move.ani', 'move'),
    ('Precision Select.ani', 'crosshair'),
    ('Horizontal Resize.ani', 'ew-resize'),
    ('Vertical Resize.ani', 'ns-resize'),
    ('Diagonal Resize 1.ani', 'nwse-resize'),
    ('Diagonal Resize 2.ani', 'nesw-resize'),
]

dirs = [
    'd:/Projects/lengxiqwq-site/public/assets/cursors',
    'd:/Projects/lengxiqwq-site-content/public/assets/cursors'
]

for d in dirs:
    os.makedirs(os.path.join(d, 'noshadow'), exist_ok=True)

hdc_screen = user32.GetDC(0)

class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ('biSize', wintypes.DWORD),
        ('biWidth', wintypes.LONG),
        ('biHeight', wintypes.LONG),
        ('biPlanes', wintypes.WORD),
        ('biBitCount', wintypes.WORD),
        ('biCompression', wintypes.DWORD),
        ('biSizeImage', wintypes.DWORD),
        ('biXPelsPerMeter', wintypes.LONG),
        ('biYPelsPerMeter', wintypes.LONG),
        ('biClrUsed', wintypes.DWORD),
        ('biClrImportant', wintypes.DWORD)
    ]

class BITMAPINFO(ctypes.Structure):
    _fields_ = [('bmiHeader', BITMAPINFOHEADER), ('bmiColors', wintypes.DWORD * 3)]

def render_win_cursor(hCursor, size):
    w, h = size
    hdc_mem = gdi32.CreateCompatibleDC(hdc_screen)
    bmi = BITMAPINFO()
    bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bmi.bmiHeader.biWidth = w
    bmi.bmiHeader.biHeight = -h
    bmi.bmiHeader.biPlanes = 1
    bmi.bmiHeader.biBitCount = 32
    bmi.bmiHeader.biCompression = 0
    pBits = ctypes.c_void_p()
    hbmp = gdi32.CreateDIBSection(hdc_mem, ctypes.byref(bmi), 0, ctypes.byref(pBits), None, 0)
    gdi32.SelectObject(hdc_mem, hbmp)
    
    user32.DrawIconEx(hdc_mem, 0, 0, hCursor, w, h, 0, None, 3)
    
    buf = (ctypes.c_byte * (w * h * 4)).from_address(pBits.value)
    raw_bytes = bytes(buf)
    img = Image.frombytes('RGBA', (w, h), raw_bytes, 'raw', 'BGRA')
    
    gdi32.DeleteObject(hbmp)
    gdi32.DeleteDC(hdc_mem)
    return img

def add_directional_shadow(img_rgba, offset, blur_radius, shadow_alpha, pad):
    w, h = img_rgba.size
    pad_x, pad_y = pad
    new_w = w + pad_x
    new_h = h + pad_y
    
    alpha = img_rgba.getchannel('A')
    black = Image.new('L', (w, h), 0)
    silhouette = Image.merge('RGBA', (black, black, black, alpha))
    
    shadow_canvas = Image.new('RGBA', (new_w, new_h), (0, 0, 0, 0))
    ox, oy = int(round(offset[0])), int(round(offset[1]))
    shadow_canvas.paste(silhouette, (ox, oy))
    
    blurred = shadow_canvas.filter(ImageFilter.GaussianBlur(blur_radius))
    r, g, b, a = blurred.split()
    a = a.point(lambda p: int(p * shadow_alpha))
    shadow = Image.merge('RGBA', (r, g, b, a))
    
    out = Image.new('RGBA', (new_w, new_h), (0, 0, 0, 0))
    out.paste(shadow, (0, 0), shadow)
    out.paste(img_rgba, (0, 0), img_rgba)
    return out

configs = [
    ('', 32, (2.8, 0.0), 1.4, 0.62, (10, 6)),
    ('@1.5x', 48, (4.0, 0.0), 2.0, 0.62, (14, 8)),
    ('@2x', 64, (5.2, 0.0), 2.6, 0.62, (18, 10))
]

for fname, key in files:
    path = os.path.join(ani_dir, fname)
    if not os.path.exists(path):
        print('Not found:', path)
        continue
    hCursor = user32.LoadCursorFromFileW(path)
    
    for suffix, sz, offset, blur, alpha, pad in configs:
        win_base = render_win_cursor(hCursor, (sz, sz))
        
        # Save Windows native unshadowed backup
        for d in dirs:
            win_base.save(os.path.join(d, 'noshadow', f'{key}{suffix}.png'))
            
        # Add shadow
        shadowed = add_directional_shadow(win_base, offset, blur, alpha, pad)
        for d in dirs:
            shadowed.save(os.path.join(d, f'{key}{suffix}.png'))
            
    user32.DestroyCursor(hCursor)
    print(f'Processed {key} with Windows Native Renderer!')

user32.ReleaseDC(0, hdc_screen)
print('All 39 cursors rendered with 100% Windows Native Sharpness + Shadow!')
