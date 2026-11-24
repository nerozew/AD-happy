// tests/sch.test.mjs
import test from 'node:test'
import assert from 'node:assert'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { electricalTypeName, parseSch, readNoErcs } from '../.agents/skills/ad-happy/scripts/sch.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/Student-DCDC-Buck-Converter')
const sch = join(root, 'SCH1_Main.SchDoc')

test('位号从 RECORD=34 读出', () => {
  const s = parseSch(sch)
  assert.equal(s.components.length, 9)
  const refs = s.components.map(c => c.reference).sort()
  assert.deepEqual(refs, ['C1', 'C2', 'C3', 'IC1', 'J1', 'J2', 'L1', 'R1', 'R2'])
})

test('引脚计数与电气类型', () => {
  const s = parseSch(sch)
  assert.equal(s.pins.length, 22)
  assert.ok(s.pins.every(p => ['input', 'output', 'passive', 'power', 'bidirectional', 'open_collector', 'unspecified'].includes(p.electrical)))
})

test('电气类型按 Altium TPinElectrical 序数解码', () => {
  // 0 Input、1 IO、2 Output、3 OpenCollector、4 Passive、5 HiZ、6 OpenEmitter、7 Power、8 Power2。
  assert.equal(electricalTypeName(0), 'input')
  assert.equal(electricalTypeName(1), 'bidirectional')
  assert.equal(electricalTypeName(2), 'output')
  assert.equal(electricalTypeName(3), 'open_collector')
  assert.equal(electricalTypeName(4), 'passive')
  assert.equal(electricalTypeName(5), 'unspecified')
  assert.equal(electricalTypeName(6), 'unspecified')
  assert.equal(electricalTypeName(7), 'power')
  assert.equal(electricalTypeName(8), 'power')
  assert.equal(electricalTypeName('4'), 'passive')
  assert.equal(electricalTypeName('Open Collector'), 'open_collector')
  assert.equal(electricalTypeName(undefined), 'unspecified')

  // 样板 22 个引脚的原始 ELECTRICAL 均为 4（Passive）。
  const s = parseSch(sch)
  assert.ok(s.pins.every(p => p.electrical === 'passive'))
})

test('电源端口与导线', () => {
  const s = parseSch(sch)
  assert.equal(s.powerPorts.length, 6)
  assert.equal(s.wires.length, 15)
})

// 位号归属到元件后，每个元件应能找到自己的引脚（按位号 + 引脚号定位）。
function findPin(s, reference, number) {
  const componentIndex = s.components.findIndex(c => c.reference === reference)
  assert.notEqual(componentIndex, -1, `找不到元件 ${reference}`)
  return s.pins.find(p => p.componentIndex === componentIndex && p.number === number)
}

test('引脚方向来自 PINCONGLOMERATE 低两位，长度取 PINLENGTH', () => {
  const s = parseSch(sch)
  assert.ok(s.pins.every(p => [0, 1, 2, 3].includes(p.orientation)))

  // 实测：IC1.3 低位=0b10（左），长 15.74803 mil；C2.1 低位=0b11（下）；J1.1 低位=0b00（右）。
  const vin = findPin(s, 'IC1', '3')
  assert.equal(vin.orientation, 2)
  assert.ok(Math.abs(vin.lengthMil - 15.74803) < 1e-6)
  assert.ok(Math.abs(vin.x - 444.88212) < 1e-6)
  assert.ok(Math.abs(vin.y - 472.4412) < 1e-6)
  // 热点 = LOCATION + 长度 × 方向；向左引脚的热点 x 更小。
  assert.ok(Math.abs(vin.xHotspot - (vin.x - vin.lengthMil)) < 1e-6)
  assert.ok(Math.abs(vin.yHotspot - vin.y) < 1e-6)

  assert.equal(findPin(s, 'C2', '1').orientation, 3)
  assert.equal(findPin(s, 'J1', '1').orientation, 0)
  assert.ok(Math.abs(findPin(s, 'J1', '1').lengthMil - 30) < 1e-6)
})

test('No-ERC 记录（recordKind 22）输出坐标', () => {
  assert.deepEqual(
    readNoErcs([
      { recordKind: '22', position: { x: 1.5, y: -2 } },
      { recordKind: '34', position: { x: 9, y: 9 } },
    ]),
    [{ x: 1.5, y: -2 }],
  )
  // 样板没有 No-ERC 标记，字段仍必须存在。
  assert.deepEqual(parseSch(sch).noErcs, [])
})

test('元件注释与封装', () => {
  const s = parseSch(sch)
  const byRef = new Map(s.components.map(c => [c.reference, c]))
  assert.equal(byRef.get('IC1').comment, 'TPS561208DDCR')
  assert.equal(byRef.get('IC1').footprint, 'SOT95P280X110-6N')
  // Comment 为 "=Value" 表达式时解析到 Value 参数。
  assert.equal(byRef.get('C2').comment, '22µF')
  assert.equal(byRef.get('C2').footprint, 'CAP 0805_2012')
  assert.equal(byRef.get('J1').comment, '282834-2')
  assert.equal(byRef.get('J1').footprint, 'TE 282834-2')
})

test('多段导线保留全部顶点', () => {
  const s = parseSch(sch)
  // 样板第 1 条导线有 4 个顶点，第 3 条有 3 个；x1/y1/x2/y2 为首尾顶点。
  const four = s.wires.filter(w => w.points.length === 4)
  const three = s.wires.filter(w => w.points.length === 3)
  assert.equal(four.length, 1)
  assert.equal(three.length, 7)
  const wire = four[0]
  assert.deepEqual(wire.points.at(0), { x: wire.x1, y: wire.y1 })
  assert.deepEqual(wire.points.at(-1), { x: wire.x2, y: wire.y2 })
  assert.ok(s.wires.every(w => w.points.length >= 2))
})

test('网络标签与电源端口文本', () => {
  const s = parseSch(sch)
  const netLabels = s.labels.filter(l => l.kind === 'net').map(l => l.text).sort()
  assert.deepEqual(netLabels, ['FB', 'IN', 'OUT', 'SW'])
  assert.equal(s.labels.filter(l => l.kind === 'power').length, 6)
  assert.ok(s.powerPorts.every(p => p.text === 'GND'))
})
