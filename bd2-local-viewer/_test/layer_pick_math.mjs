/**
 * 连续点同一图层时往下选。不启动浏览器。
 *   node _test/layer_pick_math.mjs
 */
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
const m = src.match(/\/\* layer-pick-pure:start \*\/([\s\S]*?)\/\* layer-pick-pure:end \*\//)
if (!m) {
  console.log('FAIL  找不到 layer-pick-pure 标记')
  process.exit(1)
}
const { nextLayerPick } = new Function(`${m[1]}\nreturn { nextLayerPick }`)()

let pass = 0, fail = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`)
  ok ? pass++ : fail++
}

const layers = ['hair', 'face', 'body', 'shadow']

// 列表：点 face，再点两次
{
  let mem = null
  let selected = null
  const step = (anchor, base) => {
    const r = nextLayerPick(selected, mem, anchor, layers, base)
    mem = r.memory
    selected = r.index >= 0 ? layers[r.index] : null
    return selected
  }
  check('第一次点 face 就选中 face', step('list:face', 1) === 'face')
  check('第二次还是 face → 选中它下面的 body', step('list:face', 1) === 'body')
  check('第三次继续往下 → shadow', step('list:face', 1) === 'shadow')
  check('已经是最后一层，再点停在 shadow', step('list:face', 1) === 'shadow')
  check('换点 hair → 从 hair 重新开始', step('list:hair', 0) === 'hair')
}

// 模型：命中栈从上到下，锚点是最上层，不看像素
{
  let mem = null
  let selected = null
  const stack = ['coat', 'shirt', 'skin']
  const step = (hits) => {
    const r = nextLayerPick(selected, mem, `model:${hits[0]}`, hits, 0)
    mem = r.memory
    selected = r.index >= 0 ? hits[r.index] : null
    return selected
  }
  check('模型第一次选中最上层 coat', step(stack) === 'coat')
  check('再点同一层 → shirt', step(stack) === 'shirt')
  check('第三次 → skin', step(stack) === 'skin')
  // 手指挪开一点，栈还是同一层压着，继续从当前选中往下
  check('点在稍别处但最上层仍是 coat，停在最底', step(['coat', 'shirt', 'skin']) === 'skin')
  check('点到另一层 hat → 改选 hat', step(['hat', 'hair']) === 'hat')
}

// 记忆丢了，但当前选中的就是这次点中的层：仍往下走
{
  const r = nextLayerPick('face', null, 'list:face', layers, 1)
  check('没有记忆时再选中 face → body', r.index === 2 && layers[r.index] === 'body')
}

// 点空白
{
  const r = nextLayerPick('face', { anchor: 'list:face', index: 1 }, 'list:face', [], 0)
  check('没有命中 → 不下标', r.index === -1 && r.memory === null)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
