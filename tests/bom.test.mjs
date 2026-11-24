// tests/bom.test.mjs
// BOM 构建、检查、CSV 导入/导出、报告章节与 CLI 端到端。
import test from 'node:test'
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePcb } from '../.agents/skills/ad-happy/scripts/pcb.mjs'
import { parseSch } from '../.agents/skills/ad-happy/scripts/sch.mjs'
import {
  buildBom,
  diffBom,
  exportBom,
  exportProcurement,
  importBomCsv,
} from '../.agents/skills/ad-happy/scripts/bom.mjs'
import { renderReport } from '../.agents/skills/ad-happy/scripts/report.mjs'

const testsDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testsDir, '..')
const root = join(testsDir, 'fixtures/Student-DCDC-Buck-Converter')
const analyze = join(repoRoot, '.agents/skills/ad-happy/scripts/analyze.mjs')

function freshOut(prefix = 'ad-happy-bom-') {
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

// 复制样板工程，并把 SchDoc 中所有 "Part Number" 等长替换为 "Xart Number"。
// 这样 9 个元件仍有值/封装/引脚，但工程完全没有 MPN 参数，用于验证
// 「数据不足不等于分析失败」的聚合逻辑。
function createNoMpnProject() {
  const dir = freshOut('ad-happy-bom-nompn-')
  copyFileSync(
    join(root, 'DCDC Buck Converter.PrjPcb'),
    join(dir, 'DCDC Buck Converter.PrjPcb'),
  )
  const source = readFileSync(join(root, 'SCH1_Main.SchDoc'))
  const patched = source.toString('latin1').split('Part Number').join('Xart Number')
  assert.equal(Buffer.byteLength(patched, 'latin1'), source.length, '等长替换不得改变文件大小')
  writeFileSync(join(dir, 'SCH1_Main.SchDoc'), Buffer.from(patched, 'latin1'))
  copyFileSync(
    join(root, 'PCB4 (Manual routing).PcbDoc'),
    join(dir, 'PCB4 (Manual routing).PcbDoc'),
  )
  return dir
}

function component(reference, overrides = {}) {
  return {
    reference,
    comment: '',
    footprint: 'PKG',
    parameters: {},
    ...overrides,
  }
}

test('样板工程生成 9 行 BOM，8 行有 MPN，IC1 触发 BM-001', () => {
  const schematic = parseSch(join(root, 'SCH1_Main.SchDoc'))
  const pcb = parsePcb(join(root, 'PCB4 (Manual routing).PcbDoc'))
  const result = buildBom({ schematic }, pcb)

  assert.equal(result.rows.length, 9)
  const byRef = new Map(result.rows.map(row => [row.reference, row]))
  const c2 = byRef.get('C2')
  assert.equal(c2.value, '22µF')
  assert.equal(c2.footprint, 'CAP 0805_2012')
  assert.equal(c2.mpn, 'CL21A226KOQNNNG')
  assert.equal(c2.quantity, 1)
  assert.equal(c2.source, 'both')
  assert.equal(c2.extraParameters.manufacturer, 'Samsung Electro-Mechanics')
  assert.equal(c2.extraParameters.supplierPartNumber, '1276-7092-1-ND')

  const ic1 = byRef.get('IC1')
  assert.equal(ic1.mpn, '', 'IC1 没有 Part Number 参数，不能拿 Comment 充当 MPN')

  assert.equal(result.coverage.status, 'found')
  assert.equal(result.coverage.rows, 9)
  assert.equal(result.coverage.rowsWithMpn, 8)
  assert.equal(result.coverage.rowsMissingMpn, 1)
  assert.equal(result.coverage.checks.missing_mpn, 'found')
  assert.equal(result.coverage.checks.missing_footprint, 'pass')
  assert.equal(result.coverage.checks.duplicate_designator, 'pass')
  assert.equal(result.coverage.checks.schematic_pcb_match, 'pass')

  const mpnFindings = result.findings.filter(finding => finding.rule_id === 'BM-001')
  assert.equal(mpnFindings.length, 1)
  assert.equal(mpnFindings[0].kind, 'issue')
  assert.deepEqual(mpnFindings[0].components, ['IC1'])
  assert.match(mpnFindings[0].title, /[一-鿿]/)
  assert.match(mpnFindings[0].evidence, /[一-鿿]/)
  assert.ok(!result.findings.some(finding => ['BM-002', 'BM-003', 'BM-004'].includes(finding.rule_id)))
})

test('缺少 MPN 的元件产生 BM-001，状态为 found 而不是 pass', () => {
  const result = buildBom(
    {
      schematic: {
        components: [
          component('U1', { comment: 'MCU', parameters: {} }),
          component('U2', { parameters: { MPN: 'ABC-123' } }),
        ],
      },
    },
    { components: [{ reference: 'U1', footprint: 'PKG' }, { reference: 'U2', footprint: 'PKG' }] },
  )

  assert.equal(result.coverage.checks.missing_mpn, 'found')
  assert.equal(result.coverage.status, 'found')
  assert.notEqual(result.coverage.status, 'pass')
  const finding = result.findings.find(item => item.rule_id === 'BM-001')
  assert.ok(finding)
  assert.deepEqual(finding.components, ['U1'])
})

test('完全没有 MPN 数据时缺 MPN 检查为 not_evaluated，不得算通过', () => {
  const result = buildBom(
    {
      schematic: {
        components: [
          component('U1', { parameters: { Manufacturer: 'Acme' } }),
          component('U2', { parameters: { Supplier: 'DigiKey' } }),
        ],
      },
    },
    { components: [{ reference: 'U1', footprint: 'PKG' }, { reference: 'U2', footprint: 'PKG' }] },
  )

  assert.equal(result.coverage.checks.missing_mpn, 'not_evaluated')
  assert.notEqual(result.coverage.status, 'pass')
  assert.equal(result.coverage.status, 'not_evaluated')
  assert.ok(!result.findings.some(item => item.rule_id === 'BM-001'))
  assert.ok(result.coverage.reasons.some(reason => reason.includes('型号')))
})

test('工程参数支持带序号的型号别名（Manufacturer Part Number 1 / MFR Part Number 1 / MPN1）', () => {
  const result = buildBom(
    {
      schematic: {
        components: [
          component('U1', {
            parameters: { 'Manufacturer Part Number 1': 'STM32-ABC', 'Manufacturer 1': 'ST' },
          }),
          component('U2', { parameters: { 'MFR Part Number 1': 'LDO-123' } }),
          component('U3', { parameters: { MPN1: 'MCU-456' } }),
        ],
      },
    },
    {
      components: [
        { reference: 'U1', footprint: 'PKG' },
        { reference: 'U2', footprint: 'PKG' },
        { reference: 'U3', footprint: 'PKG' },
      ],
    },
  )

  const byRef = new Map(result.rows.map(row => [row.reference, row]))
  assert.equal(byRef.get('U1').mpn, 'STM32-ABC')
  assert.equal(byRef.get('U2').mpn, 'LDO-123')
  assert.equal(byRef.get('U3').mpn, 'MCU-456')
  assert.equal(result.coverage.checks.missing_mpn, 'pass')
  assert.equal(result.coverage.status, 'pass')
  assert.ok(!result.findings.some(item => item.rule_id === 'BM-001'))
})

test('空工程 / 没有元件的工程返回 not_evaluated', () => {
  for (const [snapshot, pcb] of [
    [{ schematic: { components: [] } }, { components: [] }],
    [{}, null],
  ]) {
    const result = buildBom(snapshot, pcb)
    assert.equal(result.rows.length, 0)
    assert.equal(result.coverage.status, 'not_evaluated')
    assert.equal(result.coverage.rows, 0)
    for (const value of Object.values(result.coverage.checks)) {
      assert.equal(value, 'not_evaluated')
    }
    assert.ok(result.coverage.reasons.some(reason => reason.includes('没有可检查的元件')))
    assert.deepEqual(result.findings, [])
  }
})

test('重复位号产出 BM-003，数量合并为出现次数', () => {
  const result = buildBom(
    {
      schematic: {
        components: [
          component('R1', { comment: '10k', parameters: { MPN: 'M1' } }),
          component('R1', { comment: '10k', parameters: { MPN: 'M1' } }),
        ],
      },
    },
    { components: [{ reference: 'R1', footprint: 'PKG' }] },
  )

  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].quantity, 2)
  assert.equal(result.coverage.checks.duplicate_designator, 'found')
  assert.deepEqual(result.coverage.duplicateDesignators, ['R1'])
  assert.ok(result.findings.some(finding => finding.rule_id === 'BM-003'))
})

test('原理图与 PCB 位号不一致产出 BM-004（双向）', () => {
  const result = buildBom(
    {
      schematic: {
        components: [
          component('R1', { parameters: { MPN: 'M1' } }),
          component('R2', { parameters: { MPN: 'M2' } }),
        ],
      },
    },
    {
      components: [
        { reference: 'R1', footprint: 'PKG', mpn: 'M1' },
        { reference: 'R3', footprint: 'PKG', mpn: 'M3' },
      ],
    },
  )

  assert.equal(result.coverage.checks.schematic_pcb_match, 'found')
  assert.deepEqual(result.coverage.schematicOnly, ['R2'])
  assert.deepEqual(result.coverage.pcbOnly, ['R3'])
  const mismatches = result.findings.filter(finding => finding.rule_id === 'BM-004')
  assert.equal(mismatches.length, 2)
  assert.deepEqual(mismatches.map(item => item.components[0]).sort(), ['R2', 'R3'])
})

test('缺少封装产出 BM-002', () => {
  const result = buildBom(
    {
      schematic: {
        components: [component('C1', { footprint: '', parameters: { MPN: 'M1' } })],
      },
    },
    { components: [{ reference: 'C1', footprint: '' }] },
  )

  assert.equal(result.coverage.checks.missing_footprint, 'found')
  assert.equal(result.coverage.rowsMissingFootprint, 1)
  assert.ok(result.findings.some(finding => finding.rule_id === 'BM-002'))
})

test('exportProcurement 输出固定中文列，建议渠道留空', () => {
  const dir = freshOut()
  const path = join(dir, 'procurement.csv')
  exportProcurement([
    { reference: 'R10', quantity: 2, mpn: 'M,2', footprint: '0603', value: '10k' },
    { reference: 'R2', quantity: 1, mpn: '', footprint: '', value: '1k' },
  ], path)

  const lines = readFileSync(path, 'utf8').trim().split('\n')
  assert.equal(lines[0], '位号,数量,型号(MPN),封装,值,建议渠道')
  // 自然排序：R2 在 R10 前。
  assert.equal(lines[1], 'R2,1,,,1k,')
  assert.equal(lines[2], 'R10,2,"M,2",0603,10k,')
  assert.ok(!/DigiKey|Mouser|LCSC|嘉立创|立创/.test(lines.join('\n')), '不得编造分销渠道')
})

test('exportBom 输出附加参数并正确转义逗号', () => {
  const dir = freshOut()
  const path = join(dir, 'bom.csv')
  exportBom([{
    reference: 'C1',
    quantity: 1,
    value: '0.1µF',
    footprint: '0805',
    mpn: 'M1',
    source: 'both',
    extraParameters: {
      manufacturer: 'Acme',
      supplier: 'DigiKey',
      supplierPartNumber: 'S-1',
      description: 'cap, 10%',
    },
  }], path)

  const lines = readFileSync(path, 'utf8').trim().split('\n')
  assert.equal(lines[0], '位号,数量,值,封装,型号(MPN),来源,制造商,供应商,供应商料号,描述')
  assert.match(lines[1], /^C1,1,0\.1µF,0805,M1,双方,Acme,DigiKey,S-1,"cap, 10%"$/)
})

test('CSV 导入：英文表头大小写不敏感，支持 Supplier Part Number 与多值位号', () => {
  const csv = [
    'DESIGNATOR,Comment,footprint,Quantity,Description,Supplier Part Number',
    '"C1, C2",0.1uF,0603,2,Cap,SUP-1',
    'R1,10k,0402,1,Res,SUP-2',
  ].join('\n')
  const imported = importBomCsv(csv)

  assert.equal(imported.rows.length, 3)
  const c1 = imported.rows.find(row => row.reference === 'C1')
  assert.equal(c1.value, '0.1uF')
  assert.equal(c1.footprint, '0603')
  assert.equal(c1.quantity, 2)
  assert.equal(c1.description, 'Cap')
  assert.equal(c1.mpn, 'SUP-1', '缺少独立 MPN 列时用供应商料号回退')
  assert.equal(c1.supplierPartNumber, 'SUP-1')
  assert.ok(imported.coverage.columns.includes('designator'))
  assert.ok(imported.coverage.columns.includes('supplierPartNumber'))
})

test('CSV 导入：中文表头（位号/注释/封装/数量/描述/型号）', () => {
  const csv = [
    '位号,注释,封装,数量,描述,型号(MPN)',
    'C1,0.1µF,0805,1,电容,ABC-1',
    'R1,10k,0603,1,电阻,',
  ].join('\n')
  const imported = importBomCsv(`\uFEFF${csv}`)

  assert.equal(imported.rows.length, 2)
  const c1 = imported.rows.find(row => row.reference === 'C1')
  assert.equal(c1.value, '0.1µF')
  assert.equal(c1.footprint, '0805')
  assert.equal(c1.quantity, 1)
  assert.equal(c1.description, '电容')
  assert.equal(c1.mpn, 'ABC-1')
  assert.deepEqual(imported.coverage.missingColumns, [])
})

test('CSV 导入：分号分隔与缺少 Designator 列时报错', () => {
  const imported = importBomCsv('Designator;Comment;Quantity\nC1;0.1uF;1\n')
  assert.equal(imported.rows.length, 1)
  assert.equal(imported.rows[0].value, '0.1uF')
  assert.equal(imported.coverage.delimiter, ';')

  // Reference 是 Designator 的别名；分隔符探测不能只认字面量 designator/位号。
  const referenceAlias = importBomCsv('Reference;Comment;Footprint;Quantity\nC2;22uF;0805;1\n')
  assert.equal(referenceAlias.rows.length, 1)
  assert.equal(referenceAlias.rows[0].reference, 'C2')
  assert.equal(referenceAlias.rows[0].footprint, '0805')
  assert.equal(referenceAlias.coverage.delimiter, ';')

  // 单格标题行没有分隔符，不能被当成逗号表头；应继续向下找真正的分号表头。
  const titledSemicolon = importBomCsv(
    'Description\nDesignator;Comment;Footprint;Quantity\nC3;47uF;1210;1\n',
  )
  assert.equal(titledSemicolon.rows.length, 1)
  assert.equal(titledSemicolon.rows[0].reference, 'C3')
  assert.equal(titledSemicolon.coverage.delimiter, ';')

  // 标题行含逗号但只映射出一列时也不应提前返回；后续 Tab 表头仍要识别。
  const titledTab = importBomCsv(
    'Description, Rev A\nDesignator\tComment\tFootprint\tQuantity\nC4\t0.1uF\t0603\t1\n',
  )
  assert.equal(titledTab.rows.length, 1)
  assert.equal(titledTab.rows[0].reference, 'C4')
  assert.equal(titledTab.coverage.delimiter, 'tab')

  assert.throws(
    () => importBomCsv('foo,bar\n1,2\n'),
    /Designator|位号/,
  )
})

test('diffBom 报告导入 BOM 缺件与多件；工程为空时 not_evaluated', () => {
  const project = [
    { reference: 'R1', value: '1k' },
    { reference: 'R2', value: '2k' },
  ]
  const imported = [
    { reference: 'R1', value: '1k' },
    { reference: 'R3', value: '3k' },
  ]
  const diff = diffBom(project, imported)

  assert.equal(diff.coverage.status, 'found')
  assert.deepEqual(diff.coverage.missingFromBom, ['R2'])
  assert.deepEqual(diff.coverage.extraInBom, ['R3'])
  assert.equal(diff.findings.filter(finding => finding.rule_id === 'BM-005').length, 2)

  const emptyProject = diffBom([], imported)
  assert.equal(emptyProject.coverage.status, 'not_evaluated')
  assert.deepEqual(emptyProject.findings, [])
})

test('报告渲染「物料」章节：计数、未评估说明与产物路径', () => {
  const html = renderReport({
    project: '演示工程',
    generatedAt: '2026-11-25 10:00',
    coverage: { documents: 2, parsed: 2, notEvaluated: 0 },
    findings: [],
    status: { bom: 'found' },
    bom: {
      status: 'found',
      components: 9,
      rowsWithMpn: 8,
      rowsMissingMpn: 1,
      rowsMissingFootprint: 0,
      duplicateDesignators: [],
      schematicOnly: [],
      pcbOnly: [],
      checks: {
        missing_mpn: 'found',
        missing_footprint: 'pass',
        duplicate_designator: 'pass',
        schematic_pcb_match: 'pass',
      },
      reasons: [],
      findings: 1,
      bomPath: 'C:/demo/bom.csv',
      bomGenerated: true,
      procurementPath: 'C:/demo/procurement.csv',
      imported: null,
    },
  })

  assert.match(html, /id="bom"/)
  assert.match(html, /物料/)
  assert.match(html, /缺少 MPN/)
  assert.match(html, /C:\/demo\/bom\.csv/)
  assert.match(html, /C:\/demo\/procurement\.csv/)
  assert.match(html, /采购清单/)
  assert.match(html, /未发现物料问题|发现 1 条物料问题/)
})

test('报告在 not_evaluated 时显式写「未评估」并给出原因', () => {
  const html = renderReport({
    project: '演示工程',
    generatedAt: '2026-11-25 10:00',
    coverage: { documents: 0, parsed: 0, notEvaluated: 0 },
    findings: [],
    status: { bom: 'not_evaluated' },
    bom: {
      status: 'not_evaluated',
      components: 0,
      rowsMissingMpn: 0,
      rowsMissingFootprint: 0,
      duplicateDesignators: [],
      schematicOnly: [],
      pcbOnly: [],
      checks: {
        missing_mpn: 'not_evaluated',
        missing_footprint: 'not_evaluated',
        duplicate_designator: 'not_evaluated',
        schematic_pcb_match: 'not_evaluated',
      },
      reasons: ['没有可检查的元件：原理图与 PCB 都没有解析到带位号的元件。'],
      findings: 0,
      bomPath: '',
      bomGenerated: false,
      procurementPath: '',
      imported: null,
    },
  })

  assert.match(html, /本次未评估物料检查/)
  assert.match(html, /没有可检查的元件/)
  assert.ok(!html.includes('未发现物料问题'), '未评估不得写成未发现问题')
  assert.match(html, /未评估：缺少一侧元件清单/)
})

test('端到端：生成 bom.csv 与 procurement.csv，报告含「物料」', () => {
  const out = freshOut()
  const r = runAnalyze(['--project', root, '--out', out])
  assert.equal(r.status, 0, r.stderr)

  assert.ok(existsSync(join(out, 'bom.csv')))
  assert.ok(existsSync(join(out, 'procurement.csv')))

  const summary = readJson(out, 'summary.json')
  assert.equal(summary.rules.bom, 'found')
  assert.equal(summary.bom.status, 'found')
  assert.equal(summary.bom.components, 9)
  assert.equal(summary.bom.rowsWithMpn, 8)
  assert.equal(summary.bom.rowsMissingMpn, 1)
  assert.equal(summary.coverage.bom.checks.missing_mpn, 'found')
  assert.equal(summary.bom.bomPath, join(out, 'bom.csv'))
  assert.equal(summary.bom.procurementPath, join(out, 'procurement.csv'))

  const findings = readJson(out, 'findings.json')
  const mpnFinding = findings.find(finding => finding.rule_id === 'BM-001')
  assert.ok(mpnFinding)
  assert.equal(mpnFinding.source, 'bom')
  assert.deepEqual(mpnFinding.components, ['IC1'])

  const manifest = readJson(out, 'manifest.json')
  assert.equal(manifest.stages.bom, 'found')
  assert.equal(manifest.bom.requested, false)
  assert.equal(manifest.bom.rows, 9)
  assert.equal(manifest.bom.artifacts.bom, 'bom.csv')
  assert.equal(manifest.bom.artifacts.procurement, 'procurement.csv')

  const snapshot = readJson(out, 'snapshot.json')
  const c2 = snapshot.schematic.components.find(item => item.reference === 'C2')
  assert.equal(c2.parameters['Part Number'], 'CL21A226KOQNNNG')
  const pcbC2 = snapshot.pcb.components.find(item => item.reference === 'C2')
  assert.equal(pcbC2.mpn, '', 'PcbDoc 没有显式 MPN 字段时不能猜')

  const procurementLines = readFileSync(join(out, 'procurement.csv'), 'utf8').trim().split('\n')
  assert.equal(procurementLines[0], '位号,数量,型号(MPN),封装,值,建议渠道')
  // 夹具的 IC1 缺 MPN，采购清单中该列必须为空，且不能编造渠道。
  const ic1Line = procurementLines.find(line => line.startsWith('IC1,'))
  assert.equal(ic1Line.split(',')[2], '')
  assert.ok(procurementLines.slice(1).every(line => line.endsWith(',')))

  const html = readFileSync(join(out, 'report.html'), 'utf8')
  assert.match(html, /物料/)
  assert.match(html, /缺少 MPN/)
  assert.match(html, /BM-001/)
  assert.match(html, new RegExp(escapeRegExp(join(out, 'procurement.csv'))))
})

test('端到端 --bom：中文表头 BOM 可回读，缺件产出 BM-005', () => {
  const first = freshOut()
  const firstRun = runAnalyze(['--project', root, '--out', first])
  assert.equal(firstRun.status, 0, firstRun.stderr)

  // 用本工具生成的 bom.csv（中文表头）作为导入文件，应无差异。
  const importedPath = join(first, 'bom.csv')
  const second = freshOut()
  const secondRun = runAnalyze(['--project', root, '--out', second, '--bom', importedPath])
  assert.equal(secondRun.status, 0, secondRun.stderr)

  const summary = readJson(second, 'summary.json')
  assert.equal(summary.rules.bom, 'found', '工程本身仍有一个缺 MPN 的元件')
  assert.equal(summary.bom.imported.missingFromBom, 0)
  assert.equal(summary.bom.imported.extraInBom, 0)
  assert.equal(summary.coverage.bom.checks.imported_diff, 'pass')
  let findings = readJson(second, 'findings.json')
  assert.ok(!findings.some(finding => finding.rule_id === 'BM-005'))

  // 删掉 IC1 行后重新导入：BM-005 必须指出缺件。
  const lines = readFileSync(importedPath, 'utf8').trim().split(/\r?\n/)
  const missingPath = join(freshOut(), 'missing-ic1.csv')
  writeFileSync(missingPath, `${lines.filter(line => !line.startsWith('IC1,')).join('\n')}\n`, 'utf8')
  const third = freshOut()
  const thirdRun = runAnalyze(['--project', root, '--out', third, '--bom', missingPath])
  assert.equal(thirdRun.status, 0, thirdRun.stderr)

  const thirdSummary = readJson(third, 'summary.json')
  assert.equal(thirdSummary.bom.imported.missingFromBom, 1)
  assert.equal(thirdSummary.coverage.bom.imported.missingFromBom[0], 'IC1')
  findings = readJson(third, 'findings.json')
  const diffFinding = findings.find(finding => finding.rule_id === 'BM-005')
  assert.ok(diffFinding)
  assert.deepEqual(diffFinding.components, ['IC1'])

  const html = readFileSync(join(third, 'report.html'), 'utf8')
  assert.match(html, /导入 BOM 比对/)
  assert.match(html, /工程有、BOM 没有/)
})

test('端到端 --bom：格式无效时 rules.bom=failed 且产出 BM-ERR', () => {
  const badCsv = join(freshOut(), 'bad.csv')
  writeFileSync(badCsv, 'foo,bar\n1,2\n', 'utf8')
  const out = freshOut()
  const r = runAnalyze(['--project', root, '--out', out, '--bom', badCsv])
  assert.equal(r.status, 3, r.stderr)

  const summary = readJson(out, 'summary.json')
  assert.equal(summary.rules.bom, 'failed')
  assert.equal(summary.status, 'partial')
  const findings = readJson(out, 'findings.json')
  assert.ok(findings.some(finding => finding.rule_id === 'BM-ERR'))
  const manifest = readJson(out, 'manifest.json')
  assert.equal(manifest.stages.bom, 'failed')
  assert.ok(manifest.errors.some(error => error.stage === 'bom'))
  assert.ok(existsSync(join(out, 'report.html')))
})

test('端到端 --bom 指向同一输出目录上一次生成的 bom.csv 时不会被先清理', () => {
  const out = freshOut()
  const first = runAnalyze(['--project', root, '--out', out])
  assert.equal(first.status, 0, first.stderr)
  const bomPath = join(out, 'bom.csv')
  assert.ok(existsSync(bomPath))

  const second = runAnalyze(['--project', root, '--out', out, '--bom', bomPath])
  assert.equal(second.status, 0, second.stderr)
  const summary = readJson(out, 'summary.json')
  assert.equal(summary.rules.bom, 'found')
  assert.equal(summary.bom.imported.missingFromBom, 0)
  assert.equal(summary.bom.imported.extraInBom, 0)
})

test('端到端 --bom 指向不存在的文件时退出码 2', () => {
  const out = freshOut()
  const r = runAnalyze(['--project', root, '--out', out, '--bom', join(out, 'nope.csv')])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /BOM 文件/)
})

test('端到端：无 MPN 工程整体 complete/exit 0，rules.bom=not_evaluated', () => {
  const projectDir = createNoMpnProject()
  const out = freshOut()
  const r = runAnalyze(['--project', projectDir, '--out', out])
  assert.equal(r.status, 0, r.stderr)

  const summary = readJson(out, 'summary.json')
  assert.equal(summary.status, 'complete')
  assert.equal(summary.rules.bom, 'not_evaluated')
  assert.equal(summary.bom.status, 'not_evaluated')
  assert.equal(summary.bom.rowsMissingMpn, 9, '9 个元件都没有型号数据')
  assert.equal(summary.coverage.bom.checks.missing_mpn, 'not_evaluated')
  assert.equal(summary.coverage.bom.checks.missing_footprint, 'pass')
  assert.equal(summary.coverage.bom.checks.schematic_pcb_match, 'pass')

  const manifest = readJson(out, 'manifest.json')
  assert.equal(manifest.status, 'complete')
  assert.equal(manifest.exitCode, 0)
  assert.equal(manifest.stages.bom, 'not_evaluated')

  const html = readFileSync(join(out, 'report.html'), 'utf8')
  assert.match(html, /物料/)
  assert.match(html, /未评估/)
  assert.match(html, /没有可用的制造商型号/)
})

test('端到端：大量导入差异被截断，summary 仍小于 32KB', () => {
  const projectRows = [
    'C1', 'C2', 'C3', 'IC1', 'J1', 'J2', 'L1', 'R1', 'R2',
  ]
  const lines = ['Designator,Comment,Footprint,Quantity']
  for (const reference of projectRows) lines.push(`${reference},,PKG,1`)
  for (let index = 0; index < 3000; index += 1) {
    lines.push(`X${String(index).padStart(4, '0')},Extra,0603,1`)
  }
  const csvPath = join(freshOut('ad-happy-bom-huge-'), 'huge.csv')
  writeFileSync(csvPath, `${lines.join('\n')}\n`, 'utf8')

  const out = freshOut()
  const r = runAnalyze(['--project', root, '--out', out, '--bom', csvPath])
  assert.equal(r.status, 0, r.stderr)

  const summaryText = readFileSync(join(out, 'summary.json'), 'utf8')
  assert.ok(Buffer.byteLength(summaryText, 'utf8') < 32 * 1024, 'summary 必须 <32KB')
  const summary = JSON.parse(summaryText)
  assert.equal(summary.rules.bom, 'found')
  assert.equal(summary.bom.imported.extraInBom, 3000)
  assert.ok(summary.coverage.bom.imported.extraInBom.length <= 50, 'summary 中列表必须截断')
  assert.equal(summary.coverage.bom.imported.totals.extraInBom, 3000)
  assert.ok(statSync(join(out, 'summary.json')).size < 32 * 1024)

  const findings = readJson(out, 'findings.json')
  const extraFinding = findings.find(
    finding => finding.rule_id === 'BM-005' && finding.title.includes('多出'),
  )
  assert.ok(extraFinding)
  assert.ok(extraFinding.components.length <= 50, 'finding 组件列表也要有上限')
})

test('端到端：没有元件的工程 rules.bom=not_evaluated，报告不得写通过', () => {
  const projectDir = freshOut('ad-happy-bom-empty-project-')
  writeFileSync(join(projectDir, 'Empty.PrjPcb'), '[Design]\nVersion=1.0\n', 'utf8')
  const out = freshOut()
  const r = runAnalyze(['--project', projectDir, '--out', out])
  assert.equal(r.status, 3, r.stderr)

  const summary = readJson(out, 'summary.json')
  assert.equal(summary.rules.bom, 'not_evaluated')
  assert.equal(summary.bom.components, 0)
  assert.equal(summary.coverage.bom.checks.missing_mpn, 'not_evaluated')
  assert.ok(summary.coverage.bom.reasons.some(reason => reason.includes('没有可检查的元件')))

  const html = readFileSync(join(out, 'report.html'), 'utf8')
  const section = html.slice(html.indexOf('id="bom"'), html.indexOf('id="manufacturing"'))
  assert.match(section, /物料/)
  assert.match(section, /未评估/)
  assert.ok(!section.includes('未发现物料问题'))
})

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
