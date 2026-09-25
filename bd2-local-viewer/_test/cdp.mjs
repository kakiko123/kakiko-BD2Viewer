/* 极简 CDP 客户端，用 Node 22 内置 WebSocket 驱动无头 Chrome，做端到端验证。*/
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PORT = 9333

/**
 * 找 Chrome / Chromium。**不要在这里写死某一台机器的安装路径** ——
 * 那样只有作者自己的电脑能跑测试。查找顺序：
 *   1. 环境变量 CHROME_PATH（或 CHROME_BIN）—— 装在非标准位置时用它
 *   2. 各平台的常见安装位置
 *   3. PATH 上的 chrome / chromium / chromium-browser / google-chrome / msedge
 * 都找不到就明确报错，而不是抛一个看不懂的 spawn ENOENT。
 */
function findChrome() {
  const fromEnv = process.env.CHROME_PATH || process.env.CHROME_BIN
  if (fromEnv) {
    if (fs.existsSync(fromEnv)) return fromEnv
    throw new Error(`CHROME_PATH 指向的文件不存在：${fromEnv}`)
  }

  const pf = process.env['ProgramFiles'] || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const local = process.env['LOCALAPPDATA'] || ''
  const candidates = {
    win32: [
      path.join(pf, 'Google/Chrome/Application/chrome.exe'),
      path.join(pf86, 'Google/Chrome/Application/chrome.exe'),
      local ? path.join(local, 'Google/Chrome/Application/chrome.exe') : '',
      path.join(pf, 'Microsoft/Edge/Application/msedge.exe'),
      path.join(pf86, 'Microsoft/Edge/Application/msedge.exe'),
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
  }[process.platform] || [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ]

  for (const c of candidates) { if (c && fs.existsSync(c)) return c }

  // 退回 PATH
  const names = ['chrome', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'msedge']
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE').split(';') : ['']
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    for (const n of names) {
      for (const ext of exts) {
        const p = path.join(dir, n + ext)
        if (fs.existsSync(p)) return p
      }
    }
  }

  throw new Error(
    '找不到 Chrome / Chromium。请任选一种方式指定：\n' +
    '  · 设环境变量 CHROME_PATH 指向浏览器可执行文件\n' +
    '  · 或者把 Chrome/Chromium/Edge 装到常见位置 / 放进 PATH\n' +
    `（当前平台 ${process.platform}，已尝试 ${candidates.filter(Boolean).length} 个常见路径与 PATH）`
  )
}

export class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map() }

  static async launch(opts = {}) {
    const CHROME = opts.chrome || findChrome()
    // opts.profile 传固定目录可跨「重启」保留 localStorage / IndexedDB（测缩略图持久化用）
    const profile = opts.profile || path.join(os.tmpdir(), `cdp-profile-${Date.now()}`)
    const proc = spawn(CHROME, [
      '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
      '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--hide-scrollbars', '--disable-extensions', '--no-first-run',
      `--window-size=${opts.size || '1680,950'}`,
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ], { stdio: 'ignore' })

    const deadline = Date.now() + 30000
    let target = null
    while (Date.now() < deadline) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
        target = list.find(t => t.type === 'page')
        if (target?.webSocketDebuggerUrl) break
      } catch { /* not up yet */ }
      await new Promise(r => setTimeout(r, 250))
    }
    if (!target) { proc.kill(); throw new Error('Chrome 未就绪') }

    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    const cdp = new Cdp(ws)
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data)
      if (msg.id && cdp.pending.has(msg.id)) {
        const { res, rej } = cdp.pending.get(msg.id)
        cdp.pending.delete(msg.id)
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
      }
    }
    cdp.proc = proc
    cdp.profile = profile
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    return cdp
  }

  send(method, params = {}, timeoutMs = 60000) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(`超时: ${method}`)) }
      }, timeoutMs)
    })
  }

  async evaluate(expression, timeoutMs = 60000) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true, returnByValue: true,
    }, timeoutMs)
    if (r.exceptionDetails) {
      throw new Error('JS 异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    }
    return r.result.value
  }

  async goto(url) {
    await this.send('Page.navigate', { url })
  }

  async waitFor(expression, timeout = 30000, label = '') {
    // 容错：误把 label 当第二个参数传进来时（waitFor(expr, '某个说明')），
    // 不加保护会算出 deadline=NaN 而立刻抛超时，排查起来很费劲。
    if (typeof timeout === 'string') { label = timeout; timeout = 30000 }
    const deadline = Date.now() + Number(timeout || 30000)
    while (Date.now() < deadline) {
      try { if (await this.evaluate(`return !!(${expression})`)) return true } catch { /* retry */ }
      await new Promise(r => setTimeout(r, 200))
    }
    throw new Error(`等待超时${label ? ' [' + label + ']' : ''}: ${expression}`)
  }

  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
    return file
  }

  async consoleErrors() {
    return this.evaluate(`
      const e = document.getElementById('errorBox');
      return (e && !e.hidden) ? e.textContent : null;
    `)
  }

  async close() {
    try { this.ws.close() } catch { /* ignore */ }
    try { this.proc.kill() } catch { /* ignore */ }
    try { fs.rmSync(this.profile, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}
