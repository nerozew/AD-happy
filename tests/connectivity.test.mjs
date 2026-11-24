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
