/**
 * 把 public/ 打成单文件 HTML，供 APK 使用。
 *
 * 为什么需要它：APK 里 WebView 走 shouldInterceptRequest 托管资源，
 * 一旦这条链路在某个 WebView 版本上失效，主文档 Content-Type 不对就会被
 * 当成纯文本渲染（用户看到满屏源码）。全部内联 + loadDataWithBaseURL 注入
 * 可以让主文档和子资源都不依赖拦截，只剩 /spine/ 数据文件需要它。
 *
 * 用法: node _tools/bundle.mjs
 * 产物: public/app.bundle.html
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pub = path.join(root, 'public')

const read = f => fs.readFileSync(path.join(pub, f), 'utf8')

/** 内联进 <script> 时必须转义，否则会提前闭合标签 */
const jsInline = s =>
  s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--')

/** 内联进 <style> 时同理 */
const cssInline = s => s.replace(/<\/style/gi, '<\\/style')

let html = read('index.html')

// 去掉所有外链样式与外链脚本
html = html.replace(/[ \t]*<link[^>]*rel=["']?stylesheet["']?[^>]*>\s*/gi, '')
html = html.replace(/[ \t]*<script[^>]*\ssrc=["'][^"']*["'][^>]*>\s*<\/script>\s*/gi, '')

// 加载态提示：内联脚本执行前先给用户一个可见的反馈（防白屏）
const boot = `<div id="__boot" style="position:fixed;inset:0;display:flex;align-items:center;
justify-content:center;background:#0f1420;color:#8b98b4;font:14px system-ui;z-index:99999">
正在载入查看器…</div>`

let css = `<style>\n${cssInline(read('lib/spine-player.css'))}\n</style>\n`
css += `<style>\n${cssInline(read('styles.css'))}\n</style>\n`

let js = ''
// 顺序有讲究：spine-player.js（4.1，占全局 spine）→ spine-player-4.0.js（4.0，占全局 spine40）。
// 两份都要内联 —— APK 里 WebView 不保证能按 /lib/ 路径取到外链脚本，
// 而 4.0 那份是 NIKKE 资产必须的（见 app.js 的 spineForItem）。
for (const f of ['lib/spine-player.js', 'lib/spine-player-4.0.js', 'lib/jszip.min.js']) {
  js += `<script>\n${jsInline(read(f))}\n</script>\n`
}

// app.js 原本是 type="module"，有自己的模块作用域。内联成普通 script 后，
// 顶层声明会落到全局 —— 它的 `const spine` / `const JSZip` / `const S` 会和
// 库留在 window 上的同名绑定冲突，整个脚本在解析期就报 SyntaxError 被跳过
// （不进 window.onerror、不上控制台，表现就是页面能出但完全没反应）。
// 包一层 IIFE 把它还原成模块作用域，并显式开启严格模式与 module 保持一致。
js += `<script>\n(function () {\n'use strict';\n${jsInline(read('app.js'))}\n})();\n</script>\n`

// app.js 执行完再撤掉 boot 遮罩；如果 JS 挂了，用户至少能看到提示。
// 注意：这个 handler 会接到运行期所有 uncaught error（包括 spine-player 内部
// 异步加载抛的），所以绝不能做成挡住屏幕、永不消失的横幅 —— 2026-09-24 用户
// 实测一个坏 JSON 弹了满屏红条且点哪都没反应。现在：不拦截指针 + 10 秒自动消失。
js += `<script>
(function () {
  var el = document.getElementById('__boot')
  if (el) el.remove()
  var hideTimer = 0
  function show(msg) {
    var box = document.getElementById('__boot')
    if (!box) {
      box = document.createElement('div')
      box.id = '__boot'
      box.style.cssText = 'position:fixed;left:0;right:0;top:0;padding:12px;background:#5a1d2b;' +
        'color:#ffd9e0;font:12px monospace;z-index:99999;white-space:pre-wrap;' +
        'pointer-events:none;max-height:40vh;overflow:hidden'
      document.body.appendChild(box)
    }
    box.textContent = '脚本错误: ' + msg
    clearTimeout(hideTimer)
    hideTimer = setTimeout(function () { box.remove() }, 10000)
  }
  window.addEventListener('error', function (e) {
    show((e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0))
  })
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason
    show((r && r.message) || String(r))
  })
})()
</script>\n`

if (!html.includes('</head>')) throw new Error('index.html 缺少 </head>')
if (!html.includes('</body>')) throw new Error('index.html 缺少 </body>')

/** 只替换一次，且替换不到就直接报错。
 *
 *  2026-09-25 踩到的坑：早先这里写的是 html.replace('<body>', ...)，
 *  而 index.html 为了钉住首屏改成了 <body class="view-grid">，于是这条
 *  replace 静默失效 —— 加载遮罩再也没被插进产物，页面在慢机器上就是
 *  一片空白。String.replace 匹配不到只是原样返回，不会报错，所以
 *  这种「改动 A 悄悄弄坏 B」必须靠断言挡，不能靠肉眼。
 */
function replaceOnce(src, needle, replacement, label) {
  const parts = src.split(needle)
  if (parts.length !== 2) {
    throw new Error(`bundle: 期望 ${label} 恰好出现 1 次，实际 ${parts.length - 1} 次（needle=${needle}）`)
  }
  return parts[0] + replacement + parts[1]
}

html = replaceOnce(html, '</head>', css + '</head>', 'head 收尾')
// 注意用正则：<body> 上可能挂着 class（首屏钉子就挂在这里）
const bodyTag = html.match(/<body[^>]*>/i)
if (!bodyTag) throw new Error('index.html 缺少 <body>')
html = replaceOnce(html, bodyTag[0], bodyTag[0] + '\n' + boot, 'body 起始标签')
html = replaceOnce(html, '</body>', js + '</body>', 'body 收尾')

// 产物自检：遮罩必须在、内联必须在、外链必须不在。
if (!html.includes('id="__boot"')) throw new Error('bundle: 加载遮罩未注入')
if (!html.includes('<style>')) throw new Error('bundle: CSS 未内联')

const out = path.join(pub, 'app.bundle.html')
fs.writeFileSync(out, html, 'utf8')

const kb = n => (n / 1024).toFixed(0) + ' KB'
console.log(`已生成 ${path.relative(root, out)}  ${kb(Buffer.byteLength(html, 'utf8'))}`)

/* 残留外链统计。
   注意要点：必须先挖空 <script>/<style> 的内容再数 —— 否则内联进来的 app.js
   里凡是提到 "<link" / "<script src" 的字符串（说明文字、自检用例）都会被算成
   外链，报出一条永远消不掉的假警报（之前就一直是 1/1）。 */
const markupOnly = html
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '<script></script>')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '<style></style>')
const leftoverLinks = (markupOnly.match(/<link[^>]*>/gi) || [])
const leftoverScripts = (markupOnly.match(/<script[^>]*\ssrc=/gi) || [])
console.log(`  标记区外链 <link>: ${leftoverLinks.length}${leftoverLinks.length ? '  ' + leftoverLinks.join(' ') : ''}`)
console.log(`  标记区外链 <script src>: ${leftoverScripts.length}${leftoverScripts.length ? '  ' + leftoverScripts.join(' ') : ''}`)
if (leftoverLinks.length || leftoverScripts.length) {
  console.error('✕ 产物里仍有外链资源：APK 的 WebView 不保证能取到它们，请改为内联。')
  process.exit(1)
}
