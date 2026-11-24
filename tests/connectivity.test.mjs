// tests/connectivity.test.mjs
import test from 'node:test'
import assert from 'node:assert'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseSch } from '../.agents/skills/ad-happy/scripts/sch.mjs'
import { buildNets } from '../.agents/skills/ad-happy/scripts/connectivity.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/Student-DCDC-Buck-Converter')
const sch = parseSch(join(root, 'SCH1_Main.SchDoc'))

test('22 个引脚全部入网，共 6 个网络', () => {
  const r = buildNets(sch)
  assert.equal(r.stats.pinsMatched, 22)
  assert.equal(r.stats.pinsTotal, 22)
  assert.equal(r.stats.nets, 6)
})

test('GND 网络包含 6 个引脚', () => {
  const r = buildNets(sch)
  assert.equal(r.nets['GND'].length, 6)
})

test('FB 网络包含 R1.1、R2.2、IC1.4', () => {
  const r = buildNets(sch)
  const keys = r.nets['FB'].map(p => `${p.reference}.${p.pin}`).sort()
  assert.deepEqual(keys, ['IC1.4', 'R1.1', 'R2.2'])
})

test('pinNet 覆盖全部 22 个引脚并指向正确网络', () => {
  const r = buildNets(sch)
  const expected = sch.pins
    .map(pin => `${sch.components[pin.componentIndex].reference}.${pin.number}`)
    .sort()
  assert.deepEqual(Object.keys(r.pinNet).sort(), expected)
  assert.equal(r.pinNet['IC1.4'], 'FB')
  assert.equal(r.pinNet['J2.2'], 'GND')
  assert.equal(r.pinNet['J1.1'], 'IN')
  assert.equal(r.pinNet['C3.2'], 'OUT')
  assert.equal(r.pinNet['L1.1'], 'SW')
  // C1.1 与 IC1.6 的 VBST 网络没有标签，名称由引擎编号；只要求二者同网。
  assert.equal(r.pinNet['C1.1'], r.pinNet['IC1.6'])
})

test('导线记录顺序不影响连通性：反转 wires 后仍为 6 个网络', () => {
  const reversed = { ...sch, wires: [...sch.wires].reverse() }
  const r = buildNets(reversed)
  assert.equal(r.stats.pinsMatched, 22)
  assert.equal(r.stats.nets, 6)
  const keys = r.nets['FB'].map(p => `${p.reference}.${p.pin}`).sort()
  assert.deepEqual(keys, ['IC1.4', 'R1.1', 'R2.2'])
})

// 合成快照：只保留 buildNets 需要的字段；pins 用 [x, y, 引脚号] 元组。
function makeSch({ wires, pins = [], junctions = [] }) {
  return {
    components: [{ reference: 'R1' }],
    pins: pins.map(([x, y, number]) => ({
      componentIndex: 0,
      number,
      name: number,
      electrical: 'passive',
      x,
      y,
      orientation: 0,
      lengthMil: 0,
    })),
    wires: wires.map(points => ({ points })),
    labels: [],
    powerPorts: [],
    junctions,
  }
}

// 横线与竖线在 (5, 0) 形成 T 型：竖线端点落在横线中段，横线没有该坐标的顶点。
function tJunction(order) {
  const horizontal = [{ x: 0, y: 0 }, { x: 10, y: 0 }]
  const vertical = [{ x: 5, y: 0 }, { x: 5, y: 10 }]
  return makeSch({
    wires: order === 'horizontal-first' ? [horizontal, vertical] : [vertical, horizontal],
    pins: [[0, 0, '1'], [5, 10, '2']],
  })
}

test('T 型连接与导线记录顺序无关', () => {
  for (const order of ['horizontal-first', 'vertical-first']) {
    const r = buildNets(tJunction(order))
    assert.equal(r.stats.nets, 1, `${order} 顺序应只产生 1 个网络`)
    assert.deepEqual(Object.keys(r.pinNet).sort(), ['R1.1', 'R1.2'])
  }
})

test('十字交叉：有 junction 时导通，无 junction 时保持分离', () => {
  const wires = [
    [{ x: 0, y: 0 }, { x: 10, y: 0 }],
    [{ x: 5, y: -5 }, { x: 5, y: 5 }],
  ]
  const pins = [[0, 0, '1'], [5, 5, '2']]
  // 交点 (5, 0) 不是任何导线的顶点；无 junction 时 Altium 不导通。
  assert.equal(buildNets(makeSch({ wires, pins })).stats.nets, 2)
  const joined = buildNets(makeSch({ wires, pins, junctions: [{ x: 5, y: 0 }] }))
  assert.equal(joined.stats.nets, 1)
  assert.deepEqual(Object.keys(joined.pinNet).sort(), ['R1.1', 'R1.2'])
})

test('两个导线端点相差小于容差时导通', () => {
  const wires = [
    [{ x: 0, y: 0 }, { x: 10, y: 0 }],
    [{ x: 10.001, y: 0 }, { x: 20, y: 0 }],
  ]
  const pins = [[0, 0, '1'], [20, 0, '2']]
  assert.equal(buildNets(makeSch({ wires, pins })).stats.nets, 1)
  // 拉大到超过默认容差 0.005 后应保持两个网络。
  const far = [
    [{ x: 0, y: 0 }, { x: 10, y: 0 }],
    [{ x: 10.01, y: 0 }, { x: 20, y: 0 }],
  ]
  assert.equal(buildNets(makeSch({ wires: far, pins })).stats.nets, 2)
})
