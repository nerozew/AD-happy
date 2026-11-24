// tests/discover.test.mjs
import test from 'node:test'
import assert from 'node:assert'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverProject } from '../.agents/skills/ad-happy/scripts/discover.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/Student-DCDC-Buck-Converter')

test('样板工程发现 9 个文档', () => {
  const r = discoverProject(root)
  assert.ok(r.projectPath.endsWith('.PrjPcb'))
  assert.deepEqual(r.projectPaths, [r.projectPath])
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

test('同目录多个 PrjPcb：返回全部候选，未指定时不自动选择', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ad-happy-multi-'))
  const template = '[Design]\nVersion=1.0\n\n[Document1]\nDocumentPath=SCH1_Main.SchDoc\n'
  writeFileSync(join(dir, 'Alpha.PrjPcb'), template, 'utf8')
  writeFileSync(join(dir, 'Beta.PrjPcb'), template, 'utf8')

  const all = discoverProject(dir)
  assert.equal(all.projectPaths.length, 2)
  assert.equal(all.projectPath, null)
  assert.deepEqual(all.documents, [])
  assert.deepEqual(all.projectPaths.map(path => basename(path)), ['Alpha.PrjPcb', 'Beta.PrjPcb'])

  const selected = discoverProject(dir, { projectFile: 'Beta.PrjPcb' })
  assert.ok(selected.projectPath.endsWith('Beta.PrjPcb'))
  assert.equal(selected.documents.length, 1)

  const missing = discoverProject(dir, { projectFile: 'Nope.PrjPcb' })
  assert.equal(missing.projectPath, null)
  assert.equal(missing.projectPaths.length, 2)
})
