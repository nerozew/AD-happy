// tests/pcb.test.mjs
import test from 'node:test'
import assert from 'node:assert'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parsePcb } from '../.agents/skills/ad-happy/scripts/pcb.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/Student-DCDC-Buck-Converter')
const board = join(root, 'PCB4 (Final Design).PcbDoc')

test('样板 PCB 基本计数', () => {
  const p = parsePcb(board)
  assert.equal(p.components.length, 9)
  assert.equal(p.pads.length, 22)
  assert.equal(p.nets.length, 6)
  assert.equal(p.vias.length, 19)
})

test('net index 0 是真实网络', () => {
  const p = parsePcb(board)
  assert.ok(p.nets[0])
  assert.notEqual(p.nets[0], '')
})

test('走线只保留铜层', () => {
  const p = parsePcb(board)
  assert.equal(p.tracks.length, 40)
  assert.ok(p.tracks.every(t => ['TOP', 'BOTTOM', 'F.Cu', 'B.Cu'].includes(t.layer) || /^(In\d+|Mid)/.test(t.layer)))
})

test('过孔保留外径与钻孔，焊盘保留 PTH 类型', () => {
  const p = parsePcb(board)
  assert.ok(p.vias.every(via => via.diameterMil > 0))
  // 夹具实测：外径 23.622 mil、钻孔 11.811 mil。
  assert.ok(Math.abs(p.vias[0].diameterMil - 23.622) < 1e-6)
  assert.ok(Math.abs(p.vias[0].drillMil - 11.811) < 1e-6)
  const types = new Set(p.pads.map(pad => pad.type))
  assert.deepEqual([...types].sort(), ['smd', 'thru_hole'])
  assert.ok(p.pads.every(pad => typeof pad.plated === 'boolean'))
  const thru = p.pads.filter(pad => pad.type === 'thru_hole')
  assert.equal(thru.length, 4)
  assert.ok(thru.every(pad => Math.abs(pad.drillMil - 43.3071) < 1e-6))
})

test('圆弧走线进入快照（样板无圆弧时为空数组）', () => {
  const p = parsePcb(board)
  assert.ok(Array.isArray(p.arcs))
  assert.equal(p.arcs.length, 0)
})

test('板框尺寸', () => {
  const p = parsePcb(board)
  assert.ok(Math.abs(p.outline.widthMm - 24.54) < 0.1)
  assert.ok(Math.abs(p.outline.heightMm - 12.57) < 0.1)
})

test('元件与焊盘归属完整', () => {
  const p = parsePcb(board)
  const refs = p.components.map(c => c.reference).sort()
  assert.deepEqual(refs, ['C1', 'C2', 'C3', 'IC1', 'J1', 'J2', 'L1', 'R1', 'R2'])
  assert.ok(p.pads.every(pad => pad.componentIndex >= 0 && pad.componentIndex < p.components.length))
  assert.ok(p.pads.every(pad => Number.isInteger(pad.netIndex)))
  assert.ok(p.pads.every(pad => pad.name !== ''))
})

test('规则计数与层叠铜属性', () => {
  const p = parsePcb(board)
  assert.equal(p.rules.length, 35)
  const copperByName = new Map(p.layerStack.map(l => [l.name, l.copper]))
  // 铜属性来自层 ID 语义：信号层为铜，丝印/机械层不是。
  assert.equal(copperByName.get('Top Layer'), true)
  assert.equal(copperByName.get('Bottom Layer'), true)
  assert.equal(copperByName.get('Top Overlay'), false)
  assert.equal(copperByName.get('Mechanical 13'), false)
})
