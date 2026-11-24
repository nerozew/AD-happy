// tests/datasheets.test.mjs
// 数据手册覆盖检查、MPN 匹配、提取计划编排、报告章节与 CLI 端到端。
import test from 'node:test'
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  evaluateDatasheets,
  matchToComponents,
  planExtraction,
  resolveDatasheetsScriptsDir,
  scanDatasheets,
} from '../.agents/skills/ad-happy/scripts/datasheets.mjs'
import { renderReport } from '../.agents/skills/ad-happy/scripts/report.mjs'

const testsDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testsDir, '..')
const fixtureProject = join(testsDir, 'fixtures/Student-DCDC-Buck-Converter')
const analyze = join(repoRoot, '.agents/skills/ad-happy/scripts/analyze.mjs')

function freshDir(prefix = 'ad-happy-ds-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

// 生成结构完整的最小单页 PDF（含 xref 偏移），供扫描与上游计划使用。
function minimalPdf(label = 'AD-Happy synthetic datasheet') {
  const safeLabel = label.replace(/[()\\]/gu, ' ')
  const content = `BT /F1 12 Tf 20 100 Td (${safeLabel}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R '
      + '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

function writePdf(path, label) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, minimalPdf(label))
}

function writeScout(cacheDir, mpn, overrides = {}) {
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(join(cacheDir, `${mpn}.scout.json`), JSON.stringify({
    mpn,
    metadata: { manufacturer: 'Acme', page_count: 1 },
    categories: [],
    extraction_pages: { base: [1], pinout: [1] },
    quality_verdict: { verdict: 'extractable', reason: null },
    ...overrides,
  }), 'utf8')
}

// 模拟上游成功路径：用原始 MPN 作为文件名写出 plan。
function writePlanScript(scriptsDir) {
  mkdirSync(scriptsDir, { recursive: true })
  writeFileSync(join(scriptsDir, 'plan_extraction.py'), [
    'import hashlib, json, pathlib, sys',
    'mpn, pdf, flag, cache = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]',
    'sha = "sha256:" + hashlib.sha256(open(pdf, "rb").read()).hexdigest()',
    'plan = {"mpn": mpn, "pdf_sha256": sha, "tasks": [{"task_id": "base"}]}',
    'pathlib.Path(cache, mpn + ".plan.json").write_text(json.dumps(plan))',
  ].join('\n'), 'utf8')
}

function runAnalyze(args, { env = {} } = {}) {
  return spawnSync(process.execPath, [analyze, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

function copyFixtureProject() {
  const dir = freshDir('ad-happy-ds-project-')
  cpSync(fixtureProject, dir, { recursive: true })
  return dir
}

test('scanDatasheets 扫描大小写扩展名、递归子目录与 manifest 登记', () => {
  const dir = freshDir()
  writePdf(join(dir, 'U1.pdf'), 'U1 datasheet')
  writePdf(join(dir, 'abc.PDF'), 'ABC datasheet')
  writeFileSync(join(dir, 'notes.txt'), 'not a pdf', 'utf8')
  writePdf(join(dir, 'sub', 'lm2596-adj.pdf'), 'LM2596 datasheet')
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    pdfs: {
      'sha256:0000': {
        path: 'sub/lm2596-adj.pdf',
        mpns: ['LM2596-ADJ', 'LM2596ADJ'],
      },
    },
  }), 'utf8')

  const scan = scanDatasheets(dir)
  assert.equal(scan.exists, true)
  assert.equal(scan.coverage.status, 'pass')
  assert.equal(scan.coverage.pdfCount, 3)
  assert.equal(scan.coverage.manifestPresent, true)

  const byName = new Map(scan.pdfs.map(pdf => [pdf.fileName, pdf]))
  assert.equal(byName.get('U1.pdf').inferredMpn, 'U1')
  assert.equal(byName.get('abc.PDF').inferredMpn, 'abc')
  assert.ok(!byName.has('notes.txt'), '非 PDF 文件不应被扫描')
  const lm = byName.get('lm2596-adj.pdf')
  assert.equal(lm.relativePath, 'sub/lm2596-adj.pdf')
  assert.equal(lm.inferredMpn, 'lm2596-adj')
  assert.deepEqual(lm.manifestMpns, ['LM2596-ADJ', 'LM2596ADJ'])
  // mpns 按大小写不敏感去重，文件名推断与 manifest 的 LM2596-ADJ 视为同一条。
  assert.ok(lm.mpns.some(mpn => mpn.toUpperCase() === 'LM2596-ADJ'))

  const empty = scanDatasheets(join(dir, 'missing'))
  assert.equal(empty.exists, false)
  assert.equal(empty.coverage.status, 'not_evaluated')
  assert.ok(empty.coverage.reasons.some(reason => reason.includes('不存在')))
})

test('scanDatasheets 对无效 manifest 降级为文件名推断并给出原因', () => {
  const dir = freshDir()
  writePdf(join(dir, 'PART-1.pdf'))
  writeFileSync(join(dir, 'manifest.json'), '{ not json', 'utf8')

  const scan = scanDatasheets(dir)
  assert.equal(scan.coverage.status, 'pass')
  assert.equal(scan.coverage.manifestInvalid, true)
  assert.ok(scan.coverage.reasons.some(reason => reason.includes('manifest.json')))
  assert.equal(scan.pdfs[0].inferredMpn, 'PART-1')
})

test('matchToComponents 按归一化 MPN 匹配，缺 MPN、缺 PDF 与未匹配 PDF 分别记录', () => {
  const pdfs = [
    { path: 'C:/ds/STM32F103C8T6.pdf', fileName: 'STM32F103C8T6.pdf', relativePath: 'STM32F103C8T6.pdf', inferredMpn: 'STM32F103C8T6', mpns: ['STM32F103C8T6'] },
    { path: 'C:/ds/lm2596-adj.pdf', fileName: 'lm2596-adj.pdf', relativePath: 'lm2596-adj.pdf', inferredMpn: 'lm2596-adj', mpns: ['lm2596-adj'] },
    { path: 'C:/ds/OTHER.pdf', fileName: 'OTHER.pdf', relativePath: 'OTHER.pdf', inferredMpn: 'OTHER', mpns: ['OTHER'] },
  ]
  const rows = [
    { reference: 'U1', mpn: 'STM32F103C8T6', value: 'MCU', footprint: 'LQFP48' },
    { reference: 'U2', mpn: 'LM2596ADJ', value: 'LDO', footprint: 'TO-220' },
    { reference: 'IC2', mpn: '', value: 'IC', footprint: 'SOP8' },
    { reference: 'R1', mpn: 'RC0603', value: '10k', footprint: '0603' },
  ]

  const result = matchToComponents(pdfs, rows)
  assert.deepEqual(result.matched.map(entry => entry.reference).sort(), ['U1', 'U2'])
  assert.equal(result.coverage.componentsWithPdf, 2)
  assert.equal(result.coverage.componentsWithMpn, 3)
  assert.equal(result.coverage.icComponents, 3)

  const missing = new Map(result.componentsWithoutPdf.map(entry => [entry.reference, entry]))
  assert.equal(missing.get('IC2').reason, 'no_mpn')
  assert.equal(missing.get('IC2').isIc, true)
  assert.equal(missing.get('R1').reason, 'no_pdf')
  assert.equal(missing.get('R1').isIc, false)

  assert.deepEqual(result.unmatchedPdfs.map(pdf => pdf.fileName), ['OTHER.pdf'])
})

test('数据手册目录不存在时整体 not_evaluated，不伪造通过', () => {
  const result = evaluateDatasheets({
    directory: join(freshDir(), 'datasheets'),
    bomRows: [{ reference: 'U1', mpn: 'ABC-1' }],
  })
  assert.equal(result.coverage.status, 'not_evaluated')
  assert.equal(result.coverage.checks.pin_verification, 'not_evaluated')
  assert.equal(result.coverage.findings, 0)
  assert.deepEqual(result.findings, [])
  assert.ok(result.coverage.reasons.some(reason => reason.includes('不存在')))
})

test('IC 没有数据手册 → DS-001，引脚级核对保持 not_evaluated 而不是 pass', () => {
  const dir = freshDir()
  const result = evaluateDatasheets({
    directory: dir,
    bomRows: [{ reference: 'U1', mpn: 'ABC-1', value: 'MCU', footprint: 'QFN' }],
  })

  assert.equal(result.coverage.status, 'found')
  assert.equal(result.coverage.checks.coverage, 'found')
  assert.equal(result.coverage.checks.pin_verification, 'not_evaluated')
  assert.notEqual(result.coverage.checks.coverage, 'pass')

  const finding = result.findings.find(item => item.rule_id === 'DS-001')
  assert.ok(finding)
  assert.deepEqual(finding.components, ['U1'])
  assert.equal(finding.detector, 'datasheets')
  assert.match(finding.title, /[一-鿿]/)
  assert.match(finding.evidence, /[一-鿿]/)
  assert.ok(!result.findings.some(item => item.rule_id === 'DS-002'))
})

test('PDF 存在但 MPN 不匹配 → DS-002；非 IC 缺 PDF 不产生 DS-001', () => {
  const dir = freshDir()
  writePdf(join(dir, 'OTHER-PART.pdf'), 'Other part')
  const result = evaluateDatasheets({
    directory: dir,
    bomRows: [{ reference: 'R1', mpn: 'RC0603', value: '10k', footprint: '0603' }],
  })

  const ds002 = result.findings.find(item => item.rule_id === 'DS-002')
  assert.ok(ds002)
  assert.deepEqual(ds002.components, [])
  assert.match(ds002.title, /未匹配/)
  assert.ok(!result.findings.some(item => item.rule_id === 'DS-001'), '电阻不要求数据手册')
  assert.equal(result.coverage.status, 'found')
  assert.equal(result.coverage.checks.pin_verification, 'not_evaluated')
})

test('缺少 scout 时 planExtraction 返回 not_evaluated，且不会调用 python', () => {
  const dir = freshDir()
  writePdf(join(dir, 'ABC-1.pdf'))
  mkdirSync(join(dir, 'extracted'), { recursive: true })
  const scriptsDir = freshDir('ad-happy-ds-scripts-')
  writeFileSync(join(scriptsDir, 'plan_extraction.py'), '# dummy', 'utf8')

  let spawned = false
  const result = planExtraction('ABC-1', join(dir, 'ABC-1.pdf'), join(dir, 'extracted'), {
    scriptsDir,
    spawn: () => {
      spawned = true
      throw new Error('不应在上游缺少 scout 时启动 python')
    },
  })

  assert.equal(spawned, false)
  assert.equal(result.ok, false)
  assert.equal(result.status, 'not_evaluated')
  assert.match(result.error, /scout/)
  assert.equal(result.planPath, null)
})

test('上游 plan_extraction.py + scout 缓存可以生成提取计划', (t) => {
  const scriptsDir = resolveDatasheetsScriptsDir({}, {})
  if (!existsSync(join(scriptsDir, 'plan_extraction.py'))) {
    t.skip(`未找到上游脚本：${scriptsDir}`)
    return
  }
  const dir = freshDir()
  const mpn = 'STM32F103C8T6'
  writePdf(join(dir, `${mpn}.pdf`), 'MCU datasheet')
  const cacheDir = join(dir, 'extracted')
  writeScout(cacheDir, mpn)

  const result = planExtraction(mpn, join(dir, `${mpn}.pdf`), cacheDir, { scriptsDir })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.status, 'generated')
  assert.ok(result.planPath && existsSync(result.planPath))
  assert.equal(result.taskCount, 2)

  const plan = readJson(result.planPath)
  assert.equal(plan.mpn, mpn)
  assert.deepEqual(plan.tasks.map(task => task.task_id).sort(), ['base', 'pinout'])
  assert.ok(!('pins' in plan), '计划只是提取编排，不包含引脚核对结果')

  // 第二次调用复用已有计划，不重复运行 Python。
  const second = planExtraction(mpn, join(dir, `${mpn}.pdf`), cacheDir, { scriptsDir })
  assert.equal(second.ok, true)
  assert.equal(second.status, 'existing')
})

test('上游计划生成失败 → DS-003，规则状态为 found 而不是 failed', () => {
  const dir = freshDir()
  writePdf(join(dir, 'ABC-1.pdf'))
  const cacheDir = join(dir, 'extracted')
  writeScout(cacheDir, 'ABC-1')
  const scriptsDir = freshDir('ad-happy-ds-fail-')
  writeFileSync(
    join(scriptsDir, 'plan_extraction.py'),
    'import sys\nprint("synthetic failure", file=sys.stderr)\nsys.exit(3)\n',
    'utf8',
  )

  const result = evaluateDatasheets({
    directory: dir,
    bomRows: [{ reference: 'U1', mpn: 'ABC-1', value: 'IC', footprint: 'SOP8' }],
    cacheDir,
    planOptions: { scriptsDir },
  })

  // 提取计划未生成是覆盖缺口（found + DS-003），不是规则执行失败。
  assert.equal(result.coverage.status, 'found')
  assert.equal(result.coverage.checks.extraction_plan, 'found')
  const finding = result.findings.find(item => item.rule_id === 'DS-003')
  assert.ok(finding)
  assert.deepEqual(finding.components, ['U1'])
  assert.match(finding.evidence, /synthetic failure/)
  assert.equal(result.coverage.checks.pin_verification, 'not_evaluated')
})

test('含点号的 MPN 使用上游原始文件名定位 plan（保留点号）', () => {
  const dir = freshDir()
  const mpn = 'ABM8G-106-12.000MHZ-T'
  writePdf(join(dir, `${mpn}.pdf`), 'Crystal datasheet')
  const cacheDir = join(dir, 'extracted')
  writeScout(cacheDir, mpn)
  const scriptsDir = freshDir('ad-happy-ds-dot-')
  // 模拟上游：直接用原始 MPN 写 plan，验证 wrapper 检查同一个文件名。
  writePlanScript(scriptsDir)

  const result = planExtraction(mpn, join(dir, `${mpn}.pdf`), cacheDir, { scriptsDir })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.status, 'generated')
  assert.equal(result.planPath, join(cacheDir, `${mpn}.plan.json`))
  assert.ok(existsSync(result.planPath))
  assert.equal(result.taskCount, 1)
})

test('含路径分隔符或非法文件名字符的 MPN 被拒绝，不会启动 python', () => {
  const dir = freshDir()
  writePdf(join(dir, 'PART-1.pdf'))
  const cacheDir = join(dir, 'extracted')
  const scriptsDir = freshDir('ad-happy-ds-unsafe-')
  writeFileSync(join(scriptsDir, 'plan_extraction.py'), '# stub', 'utf8')

  let spawned = false
  for (const mpn of ['A/B', 'A\\B', '..', 'A:B']) {
    const result = planExtraction(mpn, join(dir, 'PART-1.pdf'), cacheDir, {
      scriptsDir,
      spawn: () => {
        spawned = true
        return { status: 0, stdout: '', stderr: '' }
      },
    })
    assert.equal(result.ok, false, `${mpn} 应被拒绝`)
    assert.equal(result.status, 'failed')
    assert.match(result.error, /路径分隔符|非法文件名字符|MPN/)
    assert.equal(result.expectedPlanPath, null)
  }
  assert.equal(spawned, false)
})

test('报告渲染「数据手册」章节：覆盖率、缺手册元件与引脚核对未评估', () => {
  const html = renderReport({
    project: '演示工程',
    generatedAt: '2026-11-25 10:00',
    coverage: { documents: 2, parsed: 2, notEvaluated: 0 },
    findings: [],
    status: { datasheets: 'found' },
    datasheets: {
      status: 'found',
      directory: 'C:/demo/datasheets',
      pdfCount: 2,
      components: 9,
      componentsWithMpn: 8,
      componentsWithPdf: 1,
      componentsWithoutPdf: 8,
      icComponents: 1,
      icsWithoutPdf: 1,
      matched: [{
        reference: 'U1',
        mpn: 'ABC-1',
        pdfFileName: 'ABC-1.pdf',
        planStatus: 'not_evaluated',
      }],
      unmatchedPdfs: [{ fileName: 'OTHER.pdf', inferredMpn: 'OTHER' }],
      componentsWithoutPdfList: [{
        reference: 'IC1',
        mpn: '',
        isIc: true,
        reason: 'no_mpn',
        reasonText: '元件没有 MPN，无法按型号匹配数据手册。',
      }],
      plans: [{
        mpn: 'ABC-1',
        status: 'not_evaluated',
        ok: false,
        error: '需要 AI scout 先阅读 PDF。',
      }],
      checks: {
        coverage: 'found',
        pdf_match: 'found',
        extraction_plan: 'not_evaluated',
        pin_verification: 'not_evaluated',
      },
      reasons: ['引脚级核对未评估：需要 AI 或人工依据数据手册提取后核对。'],
      findings: 1,
      pinVerification: 'not_evaluated',
    },
  })

  assert.match(html, /id="datasheets"/)
  assert.match(html, /数据手册/)
  assert.match(html, /C:\/demo\/datasheets/)
  assert.match(html, /缺少数据手册的元件/)
  assert.match(html, /IC1/)
  assert.match(html, /未匹配到元件的数据手册/)
  assert.match(html, /OTHER\.pdf/)
  assert.match(html, /引脚级核对：未评估/)
  assert.match(html, /需要 AI 或人工/)
  assert.ok(!html.includes('引脚级核对：通过'), '不得声称做过引脚级核对')
})

test('报告在 failed 且无缺失列表时写「无法判断」，不写「没有缺失」', () => {
  const html = renderReport({
    project: '演示工程',
    generatedAt: '2026-11-25 10:00',
    coverage: { documents: 2, parsed: 2, notEvaluated: 0 },
    findings: [],
    status: { datasheets: 'failed' },
    datasheets: {
      status: 'failed',
      directory: 'C:/demo/datasheets',
      cacheDir: 'C:/out/datasheets',
      pdfCount: 0,
      components: 9,
      componentsWithMpn: 8,
      componentsWithPdf: 0,
      componentsWithoutPdf: 0,
      icComponents: 1,
      icsWithoutPdf: 0,
      matched: [],
      unmatchedPdfs: [],
      componentsWithoutPdfList: [],
      plans: [],
      checks: {
        coverage: 'not_evaluated',
        pdf_match: 'not_evaluated',
        extraction_plan: 'not_evaluated',
        pin_verification: 'not_evaluated',
      },
      reasons: ['数据手册目录扫描失败：拒绝访问'],
      findings: 0,
      pinVerification: 'not_evaluated',
    },
  })

  const section = html.slice(
    html.indexOf('id="datasheets"'),
    html.indexOf('id="manufacturing"'),
  )
  assert.match(section, /无法判断/)
  assert.match(section, /数据手册检查执行失败/)
  assert.ok(!section.includes('没有缺失数据手册的元件'), 'failed 时不得写成没有缺失')
})

test('CLI --datasheets 指向不存在的目录时退出码 2 且说明原因', () => {
  const out = freshDir()
  const r = runAnalyze([
    '--project', fixtureProject,
    '--out', out,
    '--datasheets', join(freshDir(), 'nope'),
  ])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /数据手册目录/)
})

test('CLI 自动查找 datasheets：缺 IC 手册产出 DS-001，但退出码仍为 0', () => {
  const projectDir = copyFixtureProject()
  writePdf(join(projectDir, 'datasheets', 'CL21A226KOQNNNG.pdf'), 'C2 capacitor')
  const out = freshDir()
  // 提供一个只用于通过存在性检查的上游占位脚本：没有 scout 时不应启动 Python，
  // 因此该测试不依赖本机是否安装 kicad-happy。
  const scriptsDir = freshDir('ad-happy-ds-stub-')
  writeFileSync(join(scriptsDir, 'plan_extraction.py'), '# stub', 'utf8')

  const r = runAnalyze(['--project', projectDir, '--out', out], {
    env: { KICAD_HAPPY_DATASHEETS_SCRIPTS: scriptsDir },
  })
  assert.equal(r.status, 0, r.stderr)

  const summary = readJson(join(out, 'summary.json'))
  assert.equal(summary.status, 'complete')
  assert.equal(summary.rules.datasheets, 'found')
  assert.equal(summary.datasheets.status, 'found')
  assert.equal(summary.datasheets.components, 9)
  assert.equal(summary.datasheets.componentsWithPdf, 1)
  assert.equal(summary.datasheets.icsWithoutPdf, 1)
  assert.equal(summary.datasheets.pinVerification, 'not_evaluated')
  assert.equal(summary.datasheets.cacheDir, join(out, 'datasheets'))
  assert.equal(summary.coverage.datasheets.checks.pin_verification, 'not_evaluated')

  const findings = readJson(join(out, 'findings.json'))
  const ds001 = findings.find(finding => finding.rule_id === 'DS-001')
  assert.ok(ds001)
  assert.equal(ds001.source, 'datasheets')
  assert.deepEqual(ds001.components, ['IC1'])
  assert.ok(!findings.some(finding => finding.rule_id === 'DS-002'), 'C2 的 PDF 已匹配')

  const artifact = readJson(join(out, 'datasheets.json'))
  assert.equal(artifact.coverage.status, 'found')
  assert.equal(artifact.coverage.cacheDir, join(out, 'datasheets'))
  assert.equal(artifact.matched.length, 1)
  assert.equal(artifact.matched[0].reference, 'C2')
  assert.equal(artifact.matched[0].planStatus, 'not_evaluated')
  assert.ok(artifact.plans.length >= 1)
  assert.equal(artifact.plans[0].status, 'not_evaluated')

  const manifest = readJson(join(out, 'manifest.json'))
  assert.equal(manifest.stages.datasheets, 'found')
  assert.equal(manifest.datasheets.requested, false)
  assert.equal(manifest.datasheets.autoDetected, true)
  assert.equal(manifest.datasheets.cacheDir, join(out, 'datasheets'))
  assert.equal(manifest.datasheets.pinVerification, 'not_evaluated')
  assert.equal(existsSync(join(projectDir, 'datasheets', 'extracted')), false, '不得写入源工程')

  const html = readFileSync(join(out, 'report.html'), 'utf8')
  const section = html.slice(
    html.indexOf('id="datasheets"'),
    html.indexOf('id="manufacturing"'),
  )
  assert.match(section, /数据手册/)
  assert.match(section, /引脚级核对：未评估/)
  assert.match(section, /需要 AI 或人工/)
  assert.ok(!section.includes('引脚级核对：通过'))
  assert.match(html, /DS-001/)
})

test('CLI 把 scout 与提取计划缓存写到 --out，不写源工程', () => {
  const projectDir = copyFixtureProject()
  writePdf(join(projectDir, 'datasheets', 'CL21A226KOQNNNG.pdf'), 'C2 capacitor')
  const out = freshDir()
  const stubScripts = freshDir('ad-happy-ds-stub-')
  writeFileSync(join(stubScripts, 'plan_extraction.py'), '# stub', 'utf8')

  // 第一次运行创建 --out 与 .ad-happy-run 标记。
  const first = runAnalyze(['--project', projectDir, '--out', out], {
    env: { KICAD_HAPPY_DATASHEETS_SCRIPTS: stubScripts },
  })
  assert.equal(first.status, 0, first.stderr)

  // AI scout 的交接位置：<out>/datasheets/<MPN>.scout.json。
  const cacheDir = join(out, 'datasheets')
  writeScout(cacheDir, 'CL21A226KOQNNNG')

  const scriptsDir = freshDir('ad-happy-ds-plan-')
  writePlanScript(scriptsDir)
  const second = runAnalyze(['--project', projectDir, '--out', out], {
    env: { KICAD_HAPPY_DATASHEETS_SCRIPTS: scriptsDir },
  })
  assert.equal(second.status, 0, second.stderr)

  const planPath = join(cacheDir, 'CL21A226KOQNNNG.plan.json')
  assert.ok(existsSync(planPath), 'plan 应写在 --out/datasheets 下')
  assert.equal(existsSync(join(projectDir, 'datasheets', 'extracted')), false, '不得写入源工程')

  const summary = readJson(join(out, 'summary.json'))
  assert.equal(summary.status, 'complete')
  assert.equal(summary.datasheets.cacheDir, cacheDir)
  assert.equal(summary.datasheets.planGenerated, 1)
  assert.equal(summary.datasheets.planNotEvaluated, 0)

  const artifact = readJson(join(out, 'datasheets.json'))
  const plan = artifact.plans.find(item => item.mpn === 'CL21A226KOQNNNG')
  assert.equal(plan.status, 'generated')
  assert.equal(plan.planPath, planPath)
  assert.equal(artifact.matched.find(item => item.reference === 'C2').planStatus, 'generated')
})

test('CLI 上游计划失败 → DS-003 但规则 found、整体 complete/exit 0', () => {
  const projectDir = copyFixtureProject()
  writePdf(join(projectDir, 'datasheets', 'CL21A226KOQNNNG.pdf'), 'C2 capacitor')
  const out = freshDir()
  const stubScripts = freshDir('ad-happy-ds-stub-')
  writeFileSync(join(stubScripts, 'plan_extraction.py'), '# stub', 'utf8')

  const first = runAnalyze(['--project', projectDir, '--out', out], {
    env: { KICAD_HAPPY_DATASHEETS_SCRIPTS: stubScripts },
  })
  assert.equal(first.status, 0, first.stderr)

  const cacheDir = join(out, 'datasheets')
  writeScout(cacheDir, 'CL21A226KOQNNNG')
  const failScripts = freshDir('ad-happy-ds-fail-cli-')
  writeFileSync(
    join(failScripts, 'plan_extraction.py'),
    'import sys\nprint("synthetic cli failure", file=sys.stderr)\nsys.exit(3)\n',
    'utf8',
  )

  const second = runAnalyze(['--project', projectDir, '--out', out], {
    env: { KICAD_HAPPY_DATASHEETS_SCRIPTS: failScripts },
  })
  assert.equal(second.status, 0, second.stderr)

  const summary = readJson(join(out, 'summary.json'))
  assert.equal(summary.status, 'complete')
  assert.equal(summary.rules.datasheets, 'found')
  assert.equal(summary.datasheets.planFailed, 1)

  const findings = readJson(join(out, 'findings.json'))
  const ds003 = findings.find(finding => finding.rule_id === 'DS-003')
  assert.ok(ds003)
  assert.match(ds003.evidence, /synthetic cli failure/)

  const manifest = readJson(join(out, 'manifest.json'))
  assert.equal(manifest.stages.datasheets, 'found')
  assert.ok(!manifest.errors.some(error => error.stage === 'datasheets'))
})

test('CLI 没有 datasheets 目录时整体 complete/exit 0，报告显式未评估', () => {
  const out = freshDir()
  const r = runAnalyze(['--project', fixtureProject, '--out', out])
  assert.equal(r.status, 0, r.stderr)

  const summary = readJson(join(out, 'summary.json'))
  assert.equal(summary.status, 'complete')
  assert.equal(summary.rules.datasheets, 'not_evaluated')
  assert.equal(summary.datasheets.status, 'not_evaluated')
  assert.equal(summary.datasheets.components, 9, '仍应展示工程规模')
  assert.ok(summary.datasheets.reasons.some(reason => reason.includes('datasheets 目录')))
  assert.equal(summary.datasheets.pinVerification, 'not_evaluated')

  const manifest = readJson(join(out, 'manifest.json'))
  assert.equal(manifest.stages.datasheets, 'skipped')
  assert.equal(manifest.datasheets.directory, null)

  const html = readFileSync(join(out, 'report.html'), 'utf8')
  const section = html.slice(
    html.indexOf('id="datasheets"'),
    html.indexOf('id="manufacturing"'),
  )
  assert.match(section, /本次未评估数据手册检查/)
  assert.match(section, /datasheets 目录/)
  assert.match(section, /引脚级核对：未评估/)
  assert.ok(!section.includes('没有缺失数据手册的元件'), '未评估时不得写成没有缺失')
})
