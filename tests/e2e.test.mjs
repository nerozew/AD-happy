// tests/e2e.test.mjs
// CLI 编排端到端测试：验证 analyze.mjs 的产物、退出码与失败可见性。
import test from 'node:test'
import assert from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const testsDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testsDir, '..')
const root = join(testsDir, 'fixtures/Student-DCDC-Buck-Converter')
const analyze = join(repoRoot, '.agents/skills/ad-happy/scripts/analyze.mjs')
const out = mkdtempSync(join(tmpdir(), 'ad-happy-'))

// 用绝对路径调用，避免测试运行目录影响脚本定位；--project 仍按调用方的
// 当前目录解析，因此显式使用绝对路径。
function runAnalyze(args, { env = {}, cwd = repoRoot } = {}) {
  return spawnSync(process.execPath, [analyze, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

function freshOut(prefix = 'ad-happy-e2e-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

function readJson(dir, name) {
  return JSON.parse(readFileSync(join(dir, name), 'utf8'))
}

test('端到端产出全部文件', () => {
  execFileSync('node', ['.agents/skills/ad-happy/scripts/analyze.mjs', '--project', root, '--out', out], { stdio: 'pipe' })
  for (const f of ['manifest.json', 'snapshot.json', 'raw.json', 'findings.json', 'summary.json', 'report.html']) {
    assert.ok(existsSync(join(out, f)), `缺少 ${f}`)
  }
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'))
  assert.ok(summary.coverage)
  assert.ok(summary.counts)
  assert.ok(summary.report)
})

test('无效路径退出码 2', () => {
  try {
    execFileSync('node', ['.agents/skills/ad-happy/scripts/analyze.mjs', '--project', 'Z:/nope'], { stdio: 'pipe' })
    assert.fail('应当失败')
  } catch (e) {
    assert.equal(e.status, 2)
  }
})

test('summary 满足 32KB 约束并记录覆盖、计数与全部板卡', () => {
  const outDir = freshOut()
  const r = runAnalyze(['--project', root, '--out', outDir])
  assert.equal(r.status, 0, r.stderr)

  const summaryText = readFileSync(join(outDir, 'summary.json'), 'utf8')
  assert.ok(Buffer.byteLength(summaryText, 'utf8') < 32 * 1024, 'summary.json 必须 < 32KB')
  const summary = JSON.parse(summaryText)

  assert.deepEqual(summary.coverage.documents, 9)
  assert.deepEqual(summary.coverage.parsed, 2)
  assert.deepEqual(summary.coverage.notEvaluated, 7)
  assert.equal(summary.project.selectedBoard, 'PCB4 (Manual routing).PcbDoc')
  assert.equal(summary.project.boards.length, 5)
  assert.equal(summary.project.boards.filter(board => board.selected).length, 1)
  assert.ok(summary.report.endsWith('report.html'))
  assert.ok(existsSync(summary.report))

  const findings = readJson(outDir, 'findings.json')
  assert.ok(Array.isArray(findings) && findings.length > 0)
  assert.equal(summary.counts.total, findings.length)
  assert.ok(summary.findings.length > 0)
  assert.ok(summary.findings.length <= findings.length)

  const manifest = readJson(outDir, 'manifest.json')
  assert.equal(manifest.status, 'complete')
  assert.equal(manifest.exitCode, 0)
  assert.equal(manifest.environment.altiumts, '0.0.95')
  assert.equal(manifest.documents.filter(doc => doc.status === 'parsed').length, 2)
  assert.ok(manifest.documents.some(doc => doc.name === 'SCH_Lib.SchLib' && doc.status === 'not_evaluated'))

  const snapshot = readJson(outDir, 'snapshot.json')
  assert.equal(snapshot.schematic.components.length, 9)
  assert.equal(snapshot.pcb.components.length, 9)

  const raw = readJson(outDir, 'raw.json')
  assert.equal(raw.schematic.components.length, 9)
  assert.equal(raw.nets.stats.pinsMatched, 22)

  const html = readFileSync(join(outDir, 'report.html'), 'utf8')
  assert.match(html, /结论/)
  assert.match(html, /未评估/)
  assert.match(html, /板卡与文档/)
  for (const name of [
    'PCB1 (First design).PcbDoc',
    'PCB2 (Failed design).PcbDoc',
    'PCB3 (Failed design).PcbDoc',
    'PCB4 (Final Design).PcbDoc',
    'PCB4 (Manual routing).PcbDoc',
    'SCH1_Main.SchDoc',
    'SCH_Lib.SchLib',
  ]) {
    assert.ok(html.includes(name), `报告应列出文档 ${name}`)
  }
  assert.match(html, /本次审查/)
  assert.match(html, /本次解析/)
  assert.ok(!/src=["']https?:/.test(html), '报告不应引用外部资源')
})

test('--board 指定板卡，报告中列出全部板卡清单', () => {
  const outDir = freshOut()
  const r = runAnalyze(['--project', root, '--out', outDir, '--board', 'PCB4 (Final Design).PcbDoc'])
  assert.equal(r.status, 0, r.stderr)

  const summary = readJson(outDir, 'summary.json')
  assert.equal(summary.project.selectedBoard, 'PCB4 (Final Design).PcbDoc')
  const selected = summary.project.boards.filter(board => board.selected)
  assert.equal(selected.length, 1)
  assert.equal(selected[0].name, 'PCB4 (Final Design).PcbDoc')
})

test('--board 不存在时退出码 2', () => {
  const outDir = freshOut()
  const r = runAnalyze(['--project', root, '--out', outDir, '--board', 'Nope.PcbDoc'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /板卡|PCB/i)
  const manifest = readJson(outDir, 'manifest.json')
  assert.equal(manifest.status, 'invalid_input')
})

test('没有 .PrjPcb 的目录退出码 2 且 manifest 说明原因', () => {
  const projectDir = freshOut('ad-happy-empty-project-')
  const outDir = freshOut()
  const r = runAnalyze(['--project', projectDir, '--out', outDir])
  assert.equal(r.status, 2)
  const manifest = readJson(outDir, 'manifest.json')
  assert.equal(manifest.status, 'invalid_input')
  assert.ok(manifest.errors.some(error => /PrjPcb|工程/i.test(error.message)))
})

test('拒绝把输出写进源工程目录', () => {
  const outDir = join(root, 'should-not-exist')
  const before = readdirSync(root).sort()
  const r = runAnalyze(['--project', root, '--out', outDir])
  assert.equal(r.status, 2)
  assert.equal(existsSync(outDir), false, '不得在源工程目录创建输出')
  assert.deepEqual(readdirSync(root).sort(), before, '源工程目录不得被修改')
})

test('--out 指向无 marker 的非空目录时拒绝且不删除无关文件', () => {
  const outDir = freshOut('ad-happy-user-dir-')
  const unrelated = join(outDir, 'manifest.json')
  const content = '{"owner":"user","note":"not ad-happy"}'
  writeFileSync(unrelated, content, 'utf8')

  const r = runAnalyze(['--project', root, '--out', outDir])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /ad-happy-run|非空/)
  // 用户的 manifest.json 必须原样保留。
  assert.equal(readFileSync(unrelated, 'utf8'), content)
  assert.equal(existsSync(join(outDir, 'report.html')), false)
})

test('同一输出目录可被后续运行安全复用（marker 匹配后清理旧产物）', () => {
  const outDir = freshOut('ad-happy-reuse-')
  const first = runAnalyze(['--project', root, '--out', outDir])
  assert.equal(first.status, 0, first.stderr)
  assert.ok(existsSync(join(outDir, '.ad-happy-run')))

  const second = runAnalyze(['--project', root, '--out', outDir])
  assert.equal(second.status, 0, second.stderr)
  assert.ok(existsSync(join(outDir, 'summary.json')))
})

test('Python 阶段失败时退出码 3，写 manifest 错误且不产出假报告', () => {
  const fakeKicad = freshOut('ad-happy-fake-kicad-')
  // selfcheck 只检查文件存在；空模块会让 Python import 失败，模拟 Python 阶段异常。
  writeFileSync(join(fakeKicad, 'kicad_types.py'), '', 'utf8')
  writeFileSync(join(fakeKicad, 'finding_schema.py'), '', 'utf8')

  const outDir = freshOut()
  const r = runAnalyze(['--project', root, '--out', outDir], {
    env: { KICAD_HAPPY_SCRIPTS: fakeKicad },
  })
  assert.equal(r.status, 3)

  const manifest = readJson(outDir, 'manifest.json')
  assert.equal(manifest.status, 'failed')
  assert.equal(manifest.exitCode, 3)
  assert.ok(manifest.errors.some(error => error.stage === 'python'), 'manifest 应记录 Python 阶段错误')
  for (const name of ['findings.json', 'summary.json', 'report.html']) {
    assert.equal(existsSync(join(outDir, name)), false, `Python 失败时不应产出 ${name}`)
  }
  // 失败前已经解析出的真实数据仍保留，便于排查；raw.json 不是「假报告」。
  assert.ok(existsSync(join(outDir, 'raw.json')))
  assert.ok(existsSync(join(outDir, 'snapshot.json')))
})

test('文档解析失败时退出码 3，规则 failed 且失败在报告中可见', () => {
  // 只复制 PrjPcb + 原理图，把默认选中的板卡换成非法内容：
  // 其余引用的库/板卡不存在只记为 not_evaluated，不应干扰本测试。
  const projectDir = freshOut('ad-happy-broken-project-')
  copyFileSync(
    join(root, 'DCDC Buck Converter.PrjPcb'),
    join(projectDir, 'DCDC Buck Converter.PrjPcb'),
  )
  copyFileSync(join(root, 'SCH1_Main.SchDoc'), join(projectDir, 'SCH1_Main.SchDoc'))
  writeFileSync(
    join(projectDir, 'PCB4 (Manual routing).PcbDoc'),
    'this is not an Altium PcbDoc',
    'utf8',
  )

  const outDir = freshOut()
  const r = runAnalyze(['--project', projectDir, '--out', outDir])
  assert.equal(r.status, 3, r.stderr)

  const manifest = readJson(outDir, 'manifest.json')
  assert.equal(manifest.status, 'partial')
  assert.equal(manifest.exitCode, 3)
  const board = manifest.documents.find(doc => doc.name === 'PCB4 (Manual routing).PcbDoc')
  assert.equal(board.status, 'failed')
  assert.ok(board.error)

  const summary = readJson(outDir, 'summary.json')
  assert.equal(summary.rules.dfm, 'failed')
  assert.equal(summary.rules.pad_distance, 'failed')
  assert.equal(summary.rules.pin_pad, 'failed')
  assert.ok(summary.counts.must_fix >= 1, '解析失败必须作为必须修复问题出现')

  const findings = readJson(outDir, 'findings.json')
  assert.ok(findings.some(finding => finding.rule_id === 'DET-ERR'))

  const html = readFileSync(join(outDir, 'report.html'), 'utf8')
  assert.match(html, /DET-ERR/)
  assert.match(html, /失败/)
})

test('没有 PcbDoc 时标记 not_evaluated 而不是伪造通过', () => {
  const projectDir = freshOut('ad-happy-only-sch-')
  writeFileSync(
    join(projectDir, 'OnlySch.PrjPcb'),
    '[Design]\nVersion=1.0\n\n[Document1]\nDocumentPath=SCH1_Main.SchDoc\n',
    'utf8',
  )
  copyFileSync(join(root, 'SCH1_Main.SchDoc'), join(projectDir, 'SCH1_Main.SchDoc'))

  const outDir = freshOut()
  const r = runAnalyze(['--project', projectDir, '--out', outDir])
  assert.equal(r.status, 3, r.stderr)

  const summary = readJson(outDir, 'summary.json')
  assert.equal(summary.status, 'partial')
  assert.equal(summary.project.selectedBoard, null)
  for (const rule of ['dfm', 'pad_distance', 'current_capacity', 'decoupling_placement', 'pin_pad']) {
    assert.equal(summary.rules[rule], 'not_evaluated', `${rule} 必须是 not_evaluated`)
  }
  assert.equal(summary.counts.rules.failed, 0, '缺少板卡不是规则执行失败')
  assert.ok(existsSync(join(outDir, 'report.html')), '仍应产出报告说明覆盖缺口')
})

test('--svg 成功时内联到报告，失败也只降级不中止', () => {
  const outDir = freshOut()
  const r = runAnalyze(['--project', root, '--out', outDir, '--svg'])
  assert.equal(r.status, 0, r.stderr)

  const manifest = readJson(outDir, 'manifest.json')
  assert.equal(manifest.svg.requested, true)
  if (manifest.svg.rendered) {
    assert.match(readFileSync(join(outDir, 'report.html'), 'utf8'), /<svg/)
  } else {
    assert.ok(manifest.svg.reason, '降级时必须记录原因')
  }
  assert.equal(manifest.status, 'complete')
})

test('默认输出到 LOCALAPPDATA/ad-happy/runs/<run-id>', () => {
  const localAppData = freshOut('ad-happy-localappdata-')
  const r = runAnalyze(['--project', root], { env: { LOCALAPPDATA: localAppData } })
  assert.equal(r.status, 0, r.stderr)

  const runsDir = join(localAppData, 'ad-happy', 'runs')
  const runs = readdirSync(runsDir)
  assert.equal(runs.length, 1)
  const manifest = readJson(join(runsDir, runs[0]), 'manifest.json')
  assert.equal(manifest.status, 'complete')
  assert.equal(manifest.run.outDir, join(runsDir, runs[0]))
})
