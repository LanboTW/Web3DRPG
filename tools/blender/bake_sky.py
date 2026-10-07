# Bakes a Poly Haven equirect HDR into an LDR sky strip for the background.
# Usage: blender -b --factory-startup --python bake_sky.py -- <in.hdr> <out.raw> <exposure>
# Writes the upper hemisphere (plus a sliver below the horizon) as raw RGB8,
# Reinhard-encoded (c / (1 + c)) so the shader can decode it back to linear HDR
# with c = s / (1 - s); prints the sun direction (brightest pixel) and strip size.
import sys
import bpy
import numpy as np

src, out, exposure = sys.argv[sys.argv.index('--') + 1:]
exposure = float(exposure)
img = bpy.data.images.load(src)
w, h = img.size
px = np.empty(w * h * 4, dtype=np.float32)
img.pixels.foreach_get(px)
px = px.reshape(h, w, 4)[::-1, :, :3]  # Blender rows are bottom-up

# Sun: brightest pixel, as azimuth/elevation (u=0.5 faces -Z in three.js).
lum = px @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
y, x = np.unravel_index(np.argmax(lum), lum.shape)
u, v = (x + 0.5) / w, (y + 0.5) / h
print(f'SUN u={u:.4f} v={v:.4f} elevation={90 - v * 180:.2f}deg peak={lum[y, x]:.1f}')
upper = lum[: h // 2]
print(f'SKY median={np.median(upper):.3f} p90={np.percentile(upper, 90):.3f}')

rows = int(h * 0.52)
c = px[:rows] * exposure
c = c / (1 + c)
c = np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)
(c * 255 + 0.5).astype(np.uint8).tofile(out)
print(f'STRIP {w}x{rows}')
