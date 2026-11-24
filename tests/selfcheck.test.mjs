// tests/selfcheck.test.mjs
import test from 'node:test'
import assert from 'node:assert'
import { runSelfCheck } from '../.agents/skills/ad-happy/scripts/selfcheck.mjs'

test('自检返回版本与状态', () => {
  const r = runSelfCheck()
  assert.match(r.node, /^v\d+\./)
  assert.equal(r.altiumts, '0.0.95')
  assert.equal(typeof r.ok, 'boolean')
  assert.ok(Array.isArray(r.errors))
})

test('kicad-happy 路径缺失时 ok=false 且给出错误', () => {
  const r = runSelfCheck({ kicadHappyScripts: 'Z:/does-not-exist' })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => e.includes('kicad-happy')))
})
