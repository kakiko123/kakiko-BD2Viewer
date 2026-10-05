/**
 * 捏合/平移的纯计算。不启动浏览器。
 * 锁住的行为：手指底下的世界坐标在缩放和平移后仍在手指底下。
 *
 *   node _test/pinch_math.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
const m = src.match(/\/\* pinch-camera-pure:start \*\/([\s\S]*?)\/\* pinch-camera-pure:end \*\//)
if (!m) {
  console.log('FAIL  找不到 pinch-camera-pure 标记')
  process.exit(1)
}
const { cameraWorldAt, panCamera, pinchCamera, zoomAboutPoint } = new Function(
  `${m[1]}\nreturn { cameraWorldAt, panCamera, pinchCamera, zoomAboutPoint }`
)()

let pass = 0, fail = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`)
  ok ? pass++ : fail++
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps
const same = (p, q, eps = 1e-6) => near(p.x, q.x, eps) && near(p.y, q.y, eps)

const view = { w: 500, h: 1000 }
const start = { x: 0, y: 0, zoom: 2, vw: 1000, vh: 2000 }

function worldAt(cam, sx, sy) {
  return cameraWorldAt(cam.vw, cam.vh, view.w, view.h, cam, sx, sy)
}

// 偏心双指：从 (100,200)-(200,200) 张开到 (50,200)-(250,200)，中点不动，距离 ×2
{
  const f0 = { x0: 100, y0: 200, x1: 200, y1: 200 }
  const mid = worldAt(start, 150, 200)
  const under0 = worldAt(start, f0.x0, f0.y0)
  const under1 = worldAt(start, f0.x1, f0.y1)
  const next = pinchCamera(start, view,
    { dist: 100, worldX: mid.x, worldY: mid.y },
    { x0: 50, y0: 200, x1: 250, y1: 200 })
  const cam = { ...start, x: next.x, y: next.y, zoom: next.zoom }
  check('张开两倍：zoom 减半（画面放大两倍）', near(next.zoom, 1), `zoom=${next.zoom}`)
  check('张开两倍：中点下的内容不动', same(worldAt(cam, 150, 200), mid),
    `(${mid.x},${mid.y})`)
  check('张开两倍：左指底下的内容还在左指上', same(worldAt(cam, 50, 200), under0))
  check('张开两倍：右指底下的内容还在右指上', same(worldAt(cam, 250, 200), under1))
}

// 只竖着张：旧的 dy=x 笔误会让距离不变。这里必须真的放大。
{
  const mid = worldAt(start, 200, 200)
  const under0 = worldAt(start, 200, 100)
  const next = pinchCamera(start, view,
    { dist: 200, worldX: mid.x, worldY: mid.y },
    { x0: 200, y0: 0, x1: 200, y1: 400 })
  const cam = { ...start, x: next.x, y: next.y, zoom: next.zoom }
  check('竖向张开两倍：zoom 减半', next && near(next.zoom, 1), `zoom=${next && next.zoom}`)
  check('竖向张开两倍：上指底下的内容还在上指上', same(worldAt(cam, 200, 0), under0))
}

// 两指一起平移，距离不变：zoom 不变，内容跟着中点走
{
  const f0 = { x0: 100, y0: 200, x1: 200, y1: 200 }
  const mid = worldAt(start, 150, 200)
  const under0 = worldAt(start, 100, 200)
  const next = pinchCamera(start, view,
    { dist: 100, worldX: mid.x, worldY: mid.y },
    { x0: 140, y0: 180, x1: 240, y1: 180 })
  const cam = { ...start, x: next.x, y: next.y, zoom: next.zoom }
  check('双指平移：zoom 不变', near(next.zoom, start.zoom), `zoom=${next.zoom}`)
  check('双指平移：原来中点的内容跟着新中点', same(worldAt(cam, 190, 180), mid))
  check('双指平移：左指底下的内容还在左指上', same(worldAt(cam, 140, 180), under0))
}

// 连续几帧都从同一起点重算（跟手势实现一致），中间帧也不能漂
{
  const mid = worldAt(start, 150, 200)
  const pinch = { dist: 100, worldX: mid.x, worldY: mid.y }
  const frames = [
    { x0: 90, y0: 190, x1: 210, y1: 230 },
    { x0: 70, y0: 160, x1: 250, y1: 280 },
    { x0: 40, y0: 120, x1: 280, y1: 340 },
  ]
  let ok = true
  for (const f of frames) {
    const next = pinchCamera(start, view, pinch, f)
    const cam = { ...start, x: next.x, y: next.y, zoom: next.zoom }
    const midX = (f.x0 + f.x1) / 2
    const midY = (f.y0 + f.y1) / 2
    if (!same(worldAt(cam, midX, midY), mid, 1e-4)) ok = false
    const d = Math.hypot(f.x1 - f.x0, f.y1 - f.y0)
    if (!near(next.zoom, start.zoom * (100 / d), 1e-6)) ok = false
  }
  check('连续帧从起点重算：中点锚住、缩放比等于指距比', ok)
}

// 单指：手指移动后，原来手指下的内容仍在新位置
{
  const under = worldAt(start, 120, 340)
  const next = panCamera({ ...start, sx: 120, sy: 340 }, view, 180, 400)
  const cam = { ...start, x: next.x, y: next.y, zoom: next.zoom }
  check('单指平移：zoom 不变', near(next.zoom, start.zoom))
  check('单指平移：落点下的内容跟着手指', same(worldAt(cam, 180, 400), under))
  // 往右 60 CSS 像素，镜头应往左移 60/500 * 可见世界宽
  const expectX = 0 - 60 * (start.vw * start.zoom) / view.w
  check('单指平移：水平位移与像素 1:1', near(next.x, expectX), `x=${next.x} expect=${expectX}`)
}

// 滚轮：光标下的点不动，zoom 变成目标值
{
  const under = worldAt(start, 80, 700)
  const next = zoomAboutPoint(start, view, 80, 700, start.zoom / 2)
  const cam = { ...start, x: next.x, y: next.y, zoom: next.zoom }
  check('滚轮放大：光标下的内容不动', same(worldAt(cam, 80, 700), under))
  check('滚轮放大：zoom 变为目标值', near(next.zoom, 1))
}

// 两指几乎重叠：不改相机
{
  const next = pinchCamera(start, view,
    { dist: 100, worldX: 0, worldY: 0 },
    { x0: 10, y0: 10, x1: 10.2, y1: 10.2 })
  check('两指重叠：这帧跳过', next === null)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
