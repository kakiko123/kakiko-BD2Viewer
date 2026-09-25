import { Cdp } from './cdp.mjs'
const BASE = 'http://127.0.0.1:8137'
const cdp = await Cdp.launch({ size: '1200,800' })
try {
  await cdp.goto(`${BASE}/?item=${encodeURIComponent('Eclipse Story effect yuk11sh1d4/illust_special6.atlas')}`)
  await cdp.waitFor(`document.getElementById('stageInner').dataset.debug`, 40000, 'init')
  await new Promise(r => setTimeout(r, 2000))

  // A. 独立小画布测试 headless 是否根本不支持 MediaRecorder 采集
  const basic = await cdp.evaluate(`
    const cv = document.createElement('canvas')
    cv.width = 128; cv.height = 128
    document.body.appendChild(cv)
    const c = cv.getContext('2d')
    let n = 0
    const timer = setInterval(() => { c.fillStyle = n % 2 ? 'red' : 'blue'; c.fillRect(0,0,128,128); n++ }, 16)
    const stream = cv.captureStream(30)
    const mime = ['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'].find(t => MediaRecorder.isTypeSupported(t))
    const rec = new MediaRecorder(stream, { mimeType: mime })
    const chunks = []
    let events = 0
    rec.ondataavailable = e => { events++; if (e.data.size) chunks.push(e.data) }
    const done = new Promise(r => rec.onstop = r)
    rec.start()
    await new Promise(r => setTimeout(r, 800))
    rec.stop()
    await done
    clearInterval(timer)
    stream.getTracks().forEach(t => t.stop())
    cv.remove()
    const blob = new Blob(chunks, { type: mime })
    return { mime, events, chunkCount: chunks.length, size: blob.size }
  `)
  console.log('A. 基础 MediaRecorder:', JSON.stringify(basic))

  // B. 用查看器真实画布
  const real = await cdp.evaluate(`
    const p = __bd2viewer.player
    const cv = p.canvas
    const stream = cv.captureStream(30)
    const mime = ['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'].find(t => MediaRecorder.isTypeSupported(t))
    const rec = new MediaRecorder(stream, { mimeType: mime })
    const chunks = []
    let events = 0
    rec.ondataavailable = e => { events++; if (e.data.size) chunks.push(e.data) }
    const done = new Promise(r => rec.onstop = r)
    rec.start()
    p.play()
    await new Promise(r => setTimeout(r, 1200))
    rec.stop()
    await done
    stream.getTracks().forEach(t => t.stop())
    const blob = new Blob(chunks, { type: mime })
    return { mime, events, chunkCount: chunks.length, size: blob.size,
             canvas: [cv.width, cv.height], paused: p.paused,
             animName: p.animationState.getCurrent(0).animation.name,
             animDur: p.animationState.getCurrent(0).animation.duration }
  `)
  console.log('B. 查看器画布:', JSON.stringify(real))

  // C. 走查看器自己的导出，看时长与状态
  const viaApp = await cdp.evaluate(`
    const st = __bd2viewer.state
    const p = st.player
    const e = p.animationState.getCurrent(0)
    const info = { name: e.animation.name, duration: e.animation.duration, speed: st.speed,
                   fps: st.fps, hasCaptureStream: typeof p.canvas.captureStream === 'function' }
    let blobs = []
    const orig = URL.createObjectURL
    URL.createObjectURL = function (b) { blobs.push(b); return orig.call(this, b) }
    const t0 = performance.now()
    await __bd2viewer.exportWebm(false)
    const ms = performance.now() - t0
    URL.createObjectURL = orig
    return { ...info, ms: Math.round(ms), blobCount: blobs.length,
             size: blobs[0] ? blobs[0].size : 0,
             err: document.getElementById('errorBox').hidden ? null : document.getElementById('errorBox').textContent }
  `, 60000)
  console.log('C. exportWebm:', JSON.stringify(viaApp))
} finally { await cdp.close() }
