/* 原生清单的静态回归：屏幕方向必须尊重系统的「旋转锁定」。
 *
 * 背景（2026-09-25 用户报障）：清单里原来写的是 android:screenOrientation="fullSensor"，
 * 而 sensor / fullSensor 的官方语义是
 *   「The sensor is used even if the user locked sensor-based rotation」
 * —— 手机全局开了竖屏/方向锁定，App 里照样跟着重力转，躺着刷的时候画面乱翻。
 *
 * 正确值是 fullUser（API 18+）：锁定时等价于 user（跟随用户当前首选方向），
 * 没锁定时等价于 fullSensor（允许 4 个方向，横屏看 L2D 才有反向横屏/倒置竖屏）。
 *
 * 这是纯文本校验，不用装 Android SDK 也不用起模拟器，改完清单跑一下就行。
 *   node _test/manifest_check.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..', 'bd2-android')
const MANIFEST = path.join(ROOT, 'app', 'src', 'main', 'AndroidManifest.xml')
const GRADLE = path.join(ROOT, 'app', 'build.gradle')

const results = []
let failed = 0
const check = (n, ok, d = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  →  ' + d : ''}`); if (!ok) failed++ }

/** 去掉 XML 注释，免得注释里提到的 bad 值把断言带偏 */
const stripComments = s => s.replace(/<!--[\s\S]*?-->/g, '')

let raw = ''
try {
  raw = fs.readFileSync(MANIFEST, 'utf8')
} catch (e) {
  check('AndroidManifest.xml 可读', false, e.message)
}

const xml = stripComments(raw)

// 取 <activity ...> 起始标签（清单里只有一个 activity）
const activityTag = (xml.match(/<activity\b[^>]*>/i) || [''])[0]
check('清单里能找到 <activity> 声明', activityTag.length > 0, MANIFEST)

const attrOf = (tag, name) => {
  const m = tag.match(new RegExp(`android:${name}\\s*=\\s*"([^"]*)"`, 'i'))
  return m ? m[1] : null
}
const orientation = attrOf(activityTag, 'screenOrientation')

// 1) 核心断言：必须是 fullUser。sensor / fullSensor 会无视用户的旋转锁定。
check('screenOrientation = fullUser（锁定旋转时不再跟着重力转）',
  orientation === 'fullUser', `实际值 = ${orientation}`)
check('没有用会无视系统旋转锁定的 sensor / fullSensor',
  !/^(sensor|fullSensor|userLandscape|userPortrait|sensorLandscape|sensorPortrait)$/i.test(orientation || ''),
  `实际值 = ${orientation}`)

// 2) 转屏不能让 Activity 重建：重建会丢掉播放状态、重扫一遍资产
const cc = attrOf(activityTag, 'configChanges') || ''
const needChanges = ['orientation', 'screenSize', 'screenLayout', 'smallestScreenSize']
const missing = needChanges.filter(k => !cc.split('|').includes(k))
check('configChanges 覆盖转屏所需的四个维度（转屏不重建 Activity）',
  missing.length === 0, `缺失 = ${missing.length ? missing.join(', ') : '无'} · ${cc}`)

// 3) fullUser 是 API 18 引入的，minSdk 必须够
let minSdk = null
try {
  const g = fs.readFileSync(GRADLE, 'utf8')
  const m = g.match(/minSdk\s+(\d+)/)
  if (m) minSdk = Number(m[1])
} catch { /* 下面统一报错 */ }
check('minSdk >= 18（fullUser 自 API 18 起支持）',
  minSdk !== null && minSdk >= 18, `minSdk = ${minSdk}`)

// 4) 「只在 APK 里显示」的那套手机布局依赖 is-touch，而 is-touch 由原生桥决定 ——
//    桥的名字写错了整套手机 UI 都不会出现，顺手守一下。
check('原生桥类名与前端约定一致（NativeBridge）',
  /NativeBridge/.test(fs.readFileSync(path.join(ROOT, 'app', 'src', 'main', 'java', 'com', 'kkk', 'bd2viewer', 'MainActivity.java'), 'utf8')),
  'MainActivity.java')

console.log(results.join('\n'))
console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 失败 ' + failed}  （共 ${results.length} 项）`)
process.exit(failed ? 1 : 0)
