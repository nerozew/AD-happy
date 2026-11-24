// tests/emc.test.mjs
// EMC 预合规：适配器字段、上游实际调用、缺失数据覆盖与 CLI 开关语义。
//
// 这些测试依赖本机 kicad-happy（与现有 adapter/selfcheck 测试一致）。
// 缺少上游 EMC 脚本的分支用 KICAD_HAPPY_EMC_SCRIPTS 指向空目录模拟。
import test from 'node:test'
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
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
  buildEmcInputs,
  runEmc,
} from '../.agents/skills/ad-happy/scripts/reuse/emc.mjs'

const testsDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testsDir, '..')
const project = join(testsDir, 'fixtures/Student-DCDC-Buck-Converter')
const gerber = join(testsDir, 'fixtures/gerber-basic')
const analyze = join(repoRoot, '.agents/skills/ad-happy/scripts/analyze.mjs')

// 本仓库的离线解析无法提供这些上游输入；对应规则必须 not_evaluated，
// 不能因为上游兜底逻辑产生「无铺铜/无板框」之类的假 finding。
const NOT_EVALUATED_RULES = [
  'GP-001', 'GP-002', 'GP-003', 'GP-004',
  'CK-004', 'EE-001',
  'BE-001', 'BE-002',
  'XT-001', 'RP-001',
  'PD-003', 'PD-004',
  'SU-002', 'SU-003',
]

function freshDir(prefix = 'ad-happy-emc-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function runAnalyze(args, { env = {} } = {}) {
  return spawnSync(process.execPath, [analyze, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 180000,
  })
}

// 运行一次默认分析，取得 snapshot/pcb/raw/pipeline-summary。
function generateAnalysis() {
  const outDir = freshDir('ad-happy-emc-run-')
  const result = runAnalyze(['--project', project, '--gerber', gerber, '--out', outDir])
  assert.equal(result.status, 0, result.stderr)
  return {
    outDir,
    snapshot: readJson(join(outDir, 'snapshot.json')),
    pcb: readJson(join(outDir, 'pcb.json')),
    pipeline: readJson(join(outDir, 'pipeline-summary.json')),
    raw: readJson(join(outDir, 'raw.json')),
  }
}

function writeEmcInputs(run) {
  const inputs = buildEmcInputs(run.snapshot, run.pcb, run.pipeline, {
    nets: run.raw.nets,
    netlistComplete: true,
  })
  const emcDir = join(run.outDir, 'emc-input')
  mkdirSync(emcDir, { recursive: true })
  writeFileSync(join(emcDir, 'schematic.json'), `${JSON.stringify(inputs.schematicJson, null, 2)}\n`, 'utf8')
  writeFileSync(join(emcDir, 'pcb.json'), `${JSON.stringify(inputs.pcbJson, null, 2)}\n`, 'utf8')
  copyFileSync(join(run.outDir, 'raw.json'), join(emcDir, 'raw.json'))
  return { inputs, emcDir }
}

function hasChinese(text) {
  return /[一-鿿]/u.test(String(text ?? ''))
}

test('buildEmcInputs 生成上游 EMC 实际读取的字段', () => {
  const run = generateAnalysis()
  const inputs = buildEmcInputs(run.snapshot, run.pcb, run.pipeline, {
    nets: run.raw.nets,
    netlistComplete: true,
  })
  const { schematicJson, pcbJson } = inputs

  // 原理图侧
  assert.ok(schematicJson.statistics.total_components > 0, '缺少元件统计')
  assert.ok(schematicJson.statistics.total_nets > 0, '缺少网络统计')
  assert.ok(
    schematicJson.findings.some(finding => finding.detector === 'detect_power_regulators'),
    '缺少稳压器检测结果',
  )
  assert.ok(Object.keys(schematicJson.nets).length > 0, '缺少原理图网表')

  // PCB 侧：层、叠层、板框
  const copperNames = pcbJson.layers.map(layer => layer.name)
  assert.deepEqual(copperNames, ['F.Cu', 'B.Cu'])
  assert.ok(pcbJson.layers.every(layer => ['signal', 'power'].includes(layer.type)))
  assert.deepEqual(pcbJson.setup.stackup.map(layer => layer.name), ['F.Cu', 'B.Cu'])
  assert.ok(pcbJson.setup.stackup.every(layer => layer.type === 'copper'))
  assert.ok(pcbJson.board_outline.bounding_box.width > 0, '缺少板框宽高')
  assert.equal(pcbJson.board_outline.edge_count, 0)

  // 元件/焊盘/网络
  assert.ok(pcbJson.footprints.length > 0)
  const ic = pcbJson.footprints.find(footprint => footprint.reference === 'IC1')
  assert.ok(ic, '缺少 IC1')
  assert.ok(ic.pads.length > 0, 'IC1 缺少焊盘')
  assert.ok(Object.keys(ic.pad_nets).length > 0, 'IC1 缺少 pad_nets')
  assert.ok(ic.connected_nets.length > 0, 'IC1 缺少 connected_nets')
  assert.ok(Object.keys(pcbJson.nets).length > 0, '缺少 id→网络名映射')

  // 走线/过孔/网络长度
  assert.ok(pcbJson.tracks.segments.length > 0, '缺少走线段')
  const segment = pcbJson.tracks.segments[0]
  for (const key of ['x1', 'y1', 'x2', 'y2', 'width', 'layer', 'net']) {
    assert.ok(Object.hasOwn(segment, key), `走线缺少 ${key}`)
  }
  assert.ok(pcbJson.vias.vias.length > 0, '缺少独立过孔位置')
  assert.ok(pcbJson.vias.vias.every(via => Object.hasOwn(via, 'x') && Object.hasOwn(via, 'net')))
  assert.ok(pcbJson.net_lengths.length > 0, '缺少逐网络长度')
  assert.ok(pcbJson.net_lengths.every(entry => entry.total_length_mm > 0))

  // 去耦与地平面域（与上游算法对齐的派生数据）
  assert.ok(pcbJson.decoupling_placement.length > 0, '缺少去耦摆放结果')
  assert.ok(pcbJson.decoupling_placement[0].nearby_caps.length > 0)
  assert.ok(pcbJson.ground_domains.domain_count >= 1, '缺少地平面域统计')

  // 初步覆盖：铺铜相关类别必须未评估并给出原因
  const ground = inputs.coverage.categories.find(category => category.key === 'ground_plane')
  assert.ok(ground, '缺少地平面类别')
  assert.equal(ground.status, 'partial')
  assert.ok(ground.notEvaluatedRules.some(entry => entry.rule === 'GP-002'))
  assert.ok(ground.notEvaluatedRules.every(entry => entry.reason.length > 0))
})

test('runEmc 实际调用上游；缺少铺铜/层切换的类别未评估，不产生假 finding', () => {
  const run = generateAnalysis()
  const { emcDir } = writeEmcInputs(run)
  const result = runEmc(emcDir, run.outDir)

  assert.ok(result.rawPath, '没有生成上游原始输出')
  assert.ok(existsSync(result.rawPath), '上游原始输出不存在')
  const upstream = readJson(result.rawPath)
  assert.equal(upstream.analyzer_type, 'emc')
  assert.ok(Array.isArray(upstream.findings))
  assert.ok(result.coverage.available, '上游应可用')
  assert.notEqual(result.coverage.status, 'failed')

  const upstreamRules = new Set(upstream.findings.map(finding => finding.rule_id))
  for (const finding of result.findings) {
    assert.match(finding.rule_id, /^EM-/u)
    assert.ok(finding.source_rule_id, `${finding.rule_id} 缺少 source_rule_id`)
    assert.ok(
      upstreamRules.has(finding.source_rule_id),
      `${finding.rule_id} 不在上游原始结果中，可能是伪造的 finding`,
    )
    assert.ok(hasChinese(finding.title), `标题不是中文：${finding.title}`)
    assert.ok(hasChinese(finding.description), `描述不是中文：${finding.description}`)
  }

  const keptRules = new Set(result.findings.map(finding => finding.source_rule_id))
  for (const rule of NOT_EVALUATED_RULES) {
    assert.ok(
      !keptRules.has(rule),
      `规则 ${rule} 依赖缺失数据，不应保留上游结果`,
    )
    assert.ok(
      result.coverage.notEvaluatedRules.some(entry => entry.rule === rule),
      `规则 ${rule} 应列在 notEvaluatedRules`,
    )
  }
  // 上游在 zones=[] 时会给出 GP-002（error）；必须被覆盖模型排除并记录原因。
  assert.ok(
    result.coverage.suppressedFindings.some(entry => entry.rule === 'GP-002'),
    'GP-002 兜底结果应被排除并记录',
  )
  for (const key of ['ground_plane', 'board_edge', 'crosstalk', 'return_path']) {
    const category = result.coverage.categories.find(entry => entry.key === key)
    assert.ok(category, `缺少类别 ${key}`)
    assert.ok(
      category.status === 'partial' || category.status === 'not_evaluated',
      `${key} 不应被视为完整评估`,
    )
    assert.ok(category.reasons.length > 0, `${key} 缺少未评估原因`)
  }
})

test('CLI --emc：合并 EM finding，产物只写输出目录，退出码与默认一致', () => {
  const baselineDir = freshDir('ad-happy-emc-base-')
  const baseline = runAnalyze(['--project', project, '--gerber', gerber, '--out', baselineDir])
  assert.equal(baseline.status, 0, baseline.stderr)
  const baseSummary = readJson(join(baselineDir, 'summary.json'))
  assert.equal(baseSummary.rules.emc, 'not_evaluated')
  const baseFindings = readJson(join(baselineDir, 'findings.json'))
  assert.ok(!baseFindings.some(finding => String(finding.rule_id).startsWith('EM-')))
  const baseReport = readFileSync(join(baselineDir, 'report.html'), 'utf8')
  assert.ok(!baseReport.includes('id="emc"'), '默认报告不应渲染 EMC 章节')

  const emcDir = freshDir('ad-happy-emc-cli-')
  const result = runAnalyze(['--project', project, '--gerber', gerber, '--out', emcDir, '--emc'])
  assert.equal(result.status, baseline.status, result.stderr)

  const summary = readJson(join(emcDir, 'summary.json'))
  assert.equal(summary.emc.requested, true)
  assert.notEqual(summary.emc.status, 'failed')
  assert.notEqual(summary.rules.emc, 'failed')
  assert.ok(summary.emc.counts.evaluated > 0, '没有评估任何 EMC 规则')

  const findings = readJson(join(emcDir, 'findings.json'))
  const emcFindings = findings.filter(finding => String(finding.rule_id).startsWith('EM-'))
  assert.ok(emcFindings.length > 0, '缺少 EM finding')
  for (const finding of emcFindings) {
    assert.equal(finding.source, 'emc')
    assert.match(finding.rule_id, /^EM-/u)
    assert.ok(finding.source_rule_id)
    assert.ok(hasChinese(finding.title))
    assert.ok(hasChinese(finding.description))
  }

  // 中间产物只在 --out 下，且报告包含 EMC 章节。
  for (const name of ['schematic.json', 'pcb.json', 'raw.json', 'emc-raw.json']) {
    assert.ok(existsSync(join(emcDir, 'emc-input', name)), `缺少 emc-input/${name}`)
  }
  assert.ok(existsSync(join(emcDir, 'emc.json')), '缺少 emc.json')
  assert.ok(!existsSync(join(project, 'emc-input')), '不得向源工程写入 emc-input')

  const report = readFileSync(join(emcDir, 'report.html'), 'utf8')
  assert.ok(report.includes('id="emc"'))
  assert.ok(report.includes('EMC 预合规'))
  assert.ok(report.includes('FCC Part 15 Class B'))
  assert.ok(report.includes('未评估原因'))
  assert.ok(report.includes('EMC 预合规检查'), '规则状态表缺少 emc 行')
})

test('CLI --emc 上游执行失败：rules.emc=failed、EM-000 可见且退出码 3', () => {
  const brokenDir = freshDir('ad-happy-emc-broken-')
  writeFileSync(
    join(brokenDir, 'analyze_emc.py'),
    'import sys\nprint("stub: synthetic EMC failure", file=sys.stderr)\nsys.exit(2)\n',
    'utf8',
  )
  const outDir = freshDir('ad-happy-emc-failed-')
  const result = runAnalyze(
    ['--project', project, '--gerber', gerber, '--out', outDir, '--emc'],
    { env: { KICAD_HAPPY_EMC_SCRIPTS: brokenDir } },
  )
  assert.equal(result.status, 3, result.stderr)

  const summary = readJson(join(outDir, 'summary.json'))
  assert.equal(summary.rules.emc, 'failed')
  assert.equal(summary.emc.status, 'failed')
  const manifest = readJson(join(outDir, 'manifest.json'))
  assert.equal(manifest.stages.emc, 'failed')
  assert.ok(manifest.errors.some(error => error.stage === 'emc'))

  const findings = readJson(join(outDir, 'findings.json'))
  const errorFinding = findings.find(finding => finding.rule_id === 'EM-000')
  assert.ok(errorFinding, '缺少 EM-000 执行失败说明')
  assert.equal(errorFinding.kind, 'issue')
  assert.ok(errorFinding.description.includes('分析执行错误'))
})

test('CLI --emc 缺少上游脚本：not_evaluated，退出码不变，不伪造 EM finding', () => {
  const baselineDir = freshDir('ad-happy-emc-nodeps-base-')
  const baseline = runAnalyze(['--project', project, '--gerber', gerber, '--out', baselineDir])
  assert.equal(baseline.status, 0, baseline.stderr)

  const missingDir = freshDir('ad-happy-emc-missing-')
  const outDir = freshDir('ad-happy-emc-nodeps-')
  const result = runAnalyze(
    ['--project', project, '--gerber', gerber, '--out', outDir, '--emc'],
    { env: { KICAD_HAPPY_EMC_SCRIPTS: missingDir } },
  )
  assert.equal(result.status, baseline.status, result.stderr)

  const summary = readJson(join(outDir, 'summary.json'))
  assert.equal(summary.rules.emc, 'not_evaluated')
  assert.equal(summary.emc.requested, true)
  assert.equal(summary.emc.available, false)
  assert.ok(summary.emc.reasons.some(reason => reason.includes('analyze_emc.py')))

  const findings = readJson(join(outDir, 'findings.json'))
  assert.ok(!findings.some(finding => String(finding.rule_id).startsWith('EM-')))

  const manifest = readJson(join(outDir, 'manifest.json'))
  assert.equal(manifest.stages.emc, 'not_evaluated')
  assert.ok(manifest.warnings.some(warning => warning.includes('EMC')))

  const report = readFileSync(join(outDir, 'report.html'), 'utf8')
  assert.ok(report.includes('EMC 预合规'))
  assert.ok(report.includes('未找到上游 EMC 分析脚本'))
})
