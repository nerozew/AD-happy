// tests/gerber.test.mjs
// Gerber/钻孔复用层：上游调用、coverage 缺口、中文 finding 与报告章节。
import test from 'node:test'
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  detectGerberDirectory,
  normalizeGerberFinding,
  runGerberAnalysis,
} from '../.agents/skills/ad-happy/scripts/reuse/gerber.mjs'
import { renderReport } from '../.agents/skills/ad-happy/scripts/report.mjs'

const testsDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testsDir, '..')
const fixture = join(testsDir, 'fixtures', 'gerber-basic')
const projectRoot = join(testsDir, 'fixtures', 'Student-DCDC-Buck-Converter')
const analyze = join(repoRoot, '.agents/skills/ad-happy/scripts/analyze.mjs')

function freshOut(prefix = 'ad-happy-gerber-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

function readJson(dir, name) {
  return JSON.parse(readFileSync(join(dir, name), 'utf8'))
}

function runAnalyze(args) {
  return spawnSync(process.execPath, [analyze, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

// 复制一份完整夹具，排除钻孔文件，用于验证「缺少钻孔」不是通过。
function gerbersWithoutDrill() {
  const dir = freshOut('ad-happy-gerber-nodrill-')
  for (const name of ['board.GTL', 'board.GBL', 'board.GM1']) {
    cpSync(join(fixture, name), join(dir, name))
  }
  return dir
}

test('完整 Gerber 目录返回覆盖数据与空 findings', () => {
  const out = freshOut()
  const result = runGerberAnalysis(fixture, out)

  assert.equal(result.coverage.status, 'pass')
  assert.equal(result.coverage.layerCount, 2)
  assert.equal(result.coverage.gerberFiles, 9)
  assert.equal(result.coverage.drillFiles, 1)
  assert.equal(result.coverage.drillCount, 5)
  assert.deepEqual(result.coverage.units, ['mm'])
  assert.deepEqual(result.coverage.missingLayers, [])
  assert.equal(result.coverage.boardDimensions.widthMm, 30)
  assert.equal(result.coverage.boardDimensions.heightMm, 20)
  assert.deepEqual(result.findings, [])
  assert.ok(result.rawPath && existsSync(result.rawPath), '应写出上游原始 JSON')
  assert.ok(existsSync(join(out, 'gerber.json')))
})

test('缺失目录返回 not_evaluated coverage，而不是空成功', () => {
  const out = freshOut()
  const missing = join(freshOut('ad-happy-gerber-missing-'), 'nope')
  const result = runGerberAnalysis(missing, out)

  assert.equal(result.coverage.status, 'not_evaluated')
  assert.equal(result.coverage.directory, missing)
  assert.ok(result.coverage.reasons.some(reason => reason.includes('不存在')))
  for (const value of Object.values(result.coverage.checks)) {
    assert.equal(value, 'not_evaluated')
  }
  assert.deepEqual(result.findings, [])
  assert.equal(result.rawPath, null)
})

test('空目录返回 not_evaluated 并解释原因', () => {
  const emptyDir = freshOut('ad-happy-gerber-empty-')
  const out = freshOut()
  const result = runGerberAnalysis(emptyDir, out)

  assert.equal(result.coverage.status, 'not_evaluated')
  assert.ok(result.coverage.reasons.some(reason => reason.includes('为空')))
  assert.deepEqual(result.findings, [])
})

test('缺少钻孔文件时钻孔检查为 not_evaluated，并给出中文 GR-003', () => {
  const dir = gerbersWithoutDrill()
  const out = freshOut()
  const result = runGerberAnalysis(dir, out)

  assert.equal(result.coverage.status, 'partial')
  assert.equal(result.coverage.checks.drill_data, 'not_evaluated')
  assert.equal(result.coverage.drillFiles, 0)
  assert.ok(result.coverage.reasons.some(reason => reason.includes('钻孔')))

  const missingDrill = result.findings.find(finding => finding.rule_id === 'GR-003')
  assert.ok(missingDrill, '应报告缺少钻孔文件')
  assert.equal(missingDrill.source, 'gerber')
  assert.equal(missingDrill.kind, 'issue')
  assert.match(missingDrill.title, /[一-鿿]/)
  assert.ok(!missingDrill.title.includes('No drill file'))
  assert.match(missingDrill.evidence, /[一-鿿]/)
  assert.equal(missingDrill.source_text.summary, 'No drill file in gerber set')
})

test('上游 finding 归一化为 AD-Happy 结构并翻译为中文', () => {
  const cases = [
    {
      input: {
        rule_id: 'GR-001',
        severity: 'warning',
        summary: 'Missing layer: F.Mask',
        description: 'Expected required layer F.Mask not found in gerber set.',
        recommendation: 'Add F.Mask to gerber export.',
      },
      expected: {
        title: '缺少层：F.Mask',
        evidence: 'Gerber 文件中未找到必需层 F.Mask。',
        recommendation: '请在 Gerber 导出中加入 F.Mask。',
      },
    },
    {
      input: {
        rule_id: 'GR-002',
        severity: 'warning',
        summary: 'Alignment: Width varies by 1.5mm across copper/edge layers',
        description: 'Layer alignment issue: Width varies by 1.5mm across copper/edge layers',
        recommendation: 'Re-export gerbers to ensure consistent layer alignment.',
      },
      expected: {
        title: '层对齐问题：铜层与边框层的宽度相差 1.5mm',
        evidence: '层对齐问题：铜层与边框层的宽度相差 1.5mm',
        recommendation: '请重新导出 Gerber，确保各层坐标范围一致。',
      },
    },
    {
      input: {
        rule_id: 'GR-004',
        severity: 'warning',
        summary: 'F paste layer: 4 flashes vs 10 copper (40%)',
        description: 'F-side paste layer has significantly fewer flashes (4) than copper layer (10). This may indicate missing solder paste apertures.',
        recommendation: 'Check solder paste aperture generation — missing apertures cause assembly defects.',
      },
      expected: {
        title: 'F 面锡膏层：4 个焊盘开窗，铜层 10 个（40%）',
        evidence: 'F 面锡膏层的焊盘开窗数（4）明显少于铜层（10），可能存在锡膏开窗缺失。',
        recommendation: '检查锡膏层开窗生成；缺少开窗会导致装配缺陷。',
      },
    },
    {
      input: {
        rule_id: 'GR-005',
        severity: 'error',
        summary: 'Board outline may not be closed — only 2 draw(s)',
        description: 'Edge.Cuts layer has only 2 draw command(s). A closed rectangular outline needs at least 4. The outline may be incomplete.',
        recommendation: 'Verify board outline forms a closed shape before submitting to fab.',
      },
      expected: {
        title: '板框可能未闭合：仅有 2 条绘制线段',
        evidence: '边框层（Edge.Cuts）只有 2 条绘制命令；闭合矩形板框至少需要 4 条，板框可能不完整。',
        recommendation: '提交制造前请确认板框闭合。',
      },
    },
  ]

  for (const { input, expected } of cases) {
    const finding = normalizeGerberFinding(input)
    assert.equal(finding.source, 'gerber')
    assert.equal(finding.detector, 'gerber')
    assert.equal(finding.kind, 'issue')
    assert.equal(finding.rule_id, input.rule_id, '上游稳定规则 ID 必须保留')
    assert.equal(finding.title, expected.title)
    assert.equal(finding.evidence, expected.evidence)
    assert.equal(finding.recommendation, expected.recommendation)
    assert.equal(finding.source_text.summary, input.summary)
    assert.ok(!/Missing layer|Alignment|paste layer|Board outline/.test(finding.title))
  }
})

test('上游没有稳定规则 ID 时加 GB- 前缀', () => {
  const finding = normalizeGerberFinding({
    rule_id: 'custom check',
    severity: 'info',
    summary: 'Something to check',
  })
  assert.equal(finding.rule_id, 'GB-CUSTOM-CHECK')
  assert.ok(finding.title.includes('（检测器原文）'), '未收录英文模板必须显式标注')
})

test('detectGerberDirectory 优先选择含内容的候选目录', () => {
  const project = freshOut('ad-happy-gerber-detect-')
  mkdirSync(join(project, 'Outputs'))
  mkdirSync(join(project, 'Manufacturing'))
  cpSync(fixture, join(project, 'Manufacturing'), { recursive: true })

  const detected = detectGerberDirectory(project)
  assert.ok(detected)
  assert.equal(detected.name, 'Manufacturing')
  assert.equal(detected.hasContent, true)

  const emptyProject = freshOut('ad-happy-gerber-detect-empty-')
  assert.equal(detectGerberDirectory(emptyProject), null)
})

test('报告渲染「制造文件」章节：层数、钻孔数、缺失层、单位与来源', () => {
  const html = renderReport({
    project: '演示工程',
    generatedAt: '2026-11-24 12:00',
    coverage: { documents: 3, parsed: 2, notEvaluated: 1 },
    findings: [],
    status: { gerber: 'partial' },
    manufacturing: {
      status: 'partial',
      directory: 'C:/demo/Gerber',
      gerberFiles: 3,
      drillFiles: 0,
      layerCount: 2,
      drillCount: 0,
      units: ['mm'],
      missingLayers: ['F.Mask', 'F.SilkS'],
      missingRequired: ['F.Mask'],
      missingRecommended: ['F.SilkS'],
      boardDimensions: { widthMm: 30, heightMm: 20, areaMm2: 600 },
      checks: {
        layer_completeness: 'found',
        drill_data: 'not_evaluated',
      },
      reasons: ['未找到可解析的钻孔文件'],
      findings: [{
        rule_id: 'GR-003',
        severity: 'warning',
        title: 'Gerber 文件集中没有钻孔文件',
        evidence: '未找到 Excellon 钻孔文件；PCB 制造需要钻孔数据。',
        source: 'gerber',
      }],
    },
  })

  assert.match(html, /id="manufacturing"/)
  assert.match(html, /制造文件/)
  assert.match(html, /Gerber 分析/)
  assert.match(html, /铜层数量/)
  assert.match(html, /钻孔数量/)
  assert.match(html, /缺失层/)
  assert.match(html, /F\.Mask/)
  assert.match(html, /F\.SilkS/)
  assert.match(html, /毫米（mm）/)
  assert.match(html, /30 × 20 mm/)
  assert.match(html, /未找到可解析的钻孔文件/)
  assert.match(html, /Gerber 文件集中没有钻孔文件/)
  assert.match(html, /部分完成/)
})

test('问题清单为 Gerber finding 标注「Gerber 分析」来源', () => {
  const html = renderReport({
    project: '演示工程',
    generatedAt: '2026-11-24 12:00',
    coverage: { documents: 1, parsed: 1, notEvaluated: 0 },
    findings: [{
      rule_id: 'GR-003',
      severity: 'warning',
      title: 'Gerber 文件集中没有钻孔文件',
      evidence: '未找到 Excellon 钻孔文件。',
      source: 'gerber',
    }],
    status: { gerber: 'found' },
  })

  const findingSection = html.slice(
    html.indexOf('id="findings"'),
    html.indexOf('id="coverage"'),
  )
  assert.match(findingSection, /GR-003/)
  assert.match(findingSection, /source-tag/)
  assert.match(findingSection, /Gerber 分析/)
})

test('端到端 --gerber：报告包含制造文件章节与 Gerber 覆盖数据', () => {
  const out = freshOut()
  const r = runAnalyze([
    '--project', projectRoot,
    '--gerber', fixture,
    '--out', out,
  ])
  assert.equal(r.status, 0, r.stderr)

  const summary = readJson(out, 'summary.json')
  assert.equal(summary.rules.gerber, 'pass')
  assert.equal(summary.coverage.gerber.status, 'pass')
  assert.equal(summary.coverage.gerber.layerCount, 2)
  assert.equal(summary.coverage.gerber.drillCount, 5)
  assert.equal(summary.coverage.gerber.directory, fixture)
  assert.ok(existsSync(join(out, 'gerber.json')))
  assert.ok(existsSync(join(out, 'findings.json')))

  const manifest = readJson(out, 'manifest.json')
  assert.equal(manifest.stages.gerber, 'pass')
  assert.equal(manifest.gerber.requested, true)
  assert.equal(manifest.gerber.status, 'pass')

  const html = readFileSync(join(out, 'report.html'), 'utf8')
  assert.match(html, /制造文件/)
  assert.match(html, /Gerber 分析/)
  assert.match(html, /铜层数量/)
  assert.match(html, /钻孔数量/)
  assert.match(html, /2/)
  assert.match(html, /5/)
})

test('端到端自动发现工程下的 Gerber 目录', () => {
  const project = freshOut('ad-happy-gerber-auto-project-')
  cpSync(
    join(projectRoot, 'DCDC Buck Converter.PrjPcb'),
    join(project, 'DCDC Buck Converter.PrjPcb'),
  )
  cpSync(join(projectRoot, 'SCH1_Main.SchDoc'), join(project, 'SCH1_Main.SchDoc'))
  cpSync(
    join(projectRoot, 'PCB4 (Manual routing).PcbDoc'),
    join(project, 'PCB4 (Manual routing).PcbDoc'),
  )
  mkdirSync(join(project, 'Gerber'))
  cpSync(fixture, join(project, 'Gerber'), { recursive: true })

  const out = freshOut()
  const r = runAnalyze(['--project', project, '--out', out])
  assert.equal(r.status, 0, r.stderr)

  const summary = readJson(out, 'summary.json')
  assert.equal(summary.rules.gerber, 'pass')
  assert.ok(summary.coverage.gerber.directory.endsWith('Gerber'))
  const manifest = readJson(out, 'manifest.json')
  assert.equal(manifest.gerber.autoDetected, true)
  assert.equal(manifest.gerber.requested, false)
})

test('工程中没有 Gerber 目录时跳过并写入 manifest.warnings', () => {
  const out = freshOut()
  const r = runAnalyze(['--project', projectRoot, '--out', out])
  assert.equal(r.status, 0, r.stderr)

  const summary = readJson(out, 'summary.json')
  assert.equal(summary.rules.gerber, 'not_evaluated')
  assert.equal(summary.coverage.gerber.status, 'not_evaluated')

  const manifest = readJson(out, 'manifest.json')
  assert.equal(manifest.stages.gerber, 'skipped')
  assert.ok(
    manifest.warnings.some(warning => warning.includes('Gerber')),
    '缺少 Gerber 目录必须留下明确的 warning',
  )
  const html = readFileSync(join(out, 'report.html'), 'utf8')
  assert.match(html, /制造文件/)
  assert.match(html, /未评估/)
})

test('显式 --gerber 指向缺失目录时退出码 2', () => {
  const out = freshOut()
  const r = runAnalyze([
    '--project', projectRoot,
    '--gerber', join(out, 'nope'),
    '--out', out,
  ])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /Gerber 目录/)
})
