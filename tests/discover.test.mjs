// tests/discover.test.mjs
import test from 'node:test'
import assert from 'node:assert'
import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverProject } from '../.agents/skills/ad-happy/scripts/discover.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/Student-DCDC-Buck-Converter')

test('样板工程发现 9 个文档', () => {
  const r = discoverProject(root)
  assert.ok(r.projectPath.endsWith('.PrjPcb'))
  assert.equal(r.documents.length, 9)
  assert.equal(r.documents.filter(d => d.kind === 'pcb').length, 5)
  assert.equal(r.documents.filter(d => d.kind === 'sch').length, 1)
})

test('没有 PrjPcb 的目录抛出 NO_PROJECT', () => {
  assert.throws(() => discoverProject('tests/fixtures'), /NO_PROJECT/)
})

test('库文档归为 lib 且路径为可用的绝对路径', () => {
  const r = discoverProject(root)
  const libs = r.documents.filter(d => d.kind === 'lib')
  assert.equal(libs.length, 3)
  assert.ok(libs.some(d => d.name === 'DCDC Buck Converter.IntLib'))
  for (const d of r.documents) {
    assert.equal(d.name, basename(d.path))
    assert.ok(isAbsolute(d.path))
    assert.ok(existsSync(d.path), `文档不存在: ${d.path}`)
  }
})
