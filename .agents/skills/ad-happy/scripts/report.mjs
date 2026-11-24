// 报告渲染：把分析结果渲染成自包含的中文 HTML。
//
// 约束（与 Task 10 brief 一致）：
// - 不引用外部 CSS/JS/字体/图片；样式全部写在 templates/report.html 的 <style> 里；
// - 单文件 HTML，浏览器直接打开可用；SVG 由调用方传入并直接内联；
// - 按 must_fix / should_fix / nice_to_have 三组展示，组内按规则 ID 稳定排序；
// - 「未评估」与「通过」必须分开呈现，未评估规则在「数据覆盖与未评估」逐条列出；
// - 工程名、标题、网络名、元件位号等所有用户可控文本一律转义后输出。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const TEMPLATE = readFileSync(
  fileURLToPath(new URL('../templates/report.html', import.meta.url)),
  'utf8',
)

// 分组顺序固定；label 与说明用于报告展示，key 与 findings 的 severity 对应。
const SEVERITY_GROUPS = [
  { key: 'must_fix', label: '必须修复', description: '不修复会导致功能错误或可靠性风险，建议定版前处理。' },
  { key: 'should_fix', label: '建议修复', description: '存在设计风险或明显的改进空间。' },
  { key: 'nice_to_have', label: '可优化', description: '不影响当前功能，可择机优化。' },
]

// 兼容上游 finding 使用 error/warning/info 的旧严重度词汇。
const SEVERITY_ALIASES = {
  must_fix: 'must_fix',
  error: 'must_fix',
  critical: 'must_fix',
  high: 'must_fix',
  should_fix: 'should_fix',
  warning: 'should_fix',
  warn: 'should_fix',
  medium: 'should_fix',
  nice_to_have: 'nice_to_have',
  info: 'nice_to_have',
  low: 'nice_to_have',
  minor: 'nice_to_have',
}

const STATUS_LABELS = {
  pass: '通过',
  found: '发现问题',
  partial: '部分完成',
  not_evaluated: '未评估',
  failed: '失败',
}

// 规则键 → 中文名；键本身是字段名，保持英文原样输出。
const RULE_LABELS = {
  voltage_divider: '分压器识别',
  rc_filter: 'RC 滤波识别',
  decoupling: '去耦电容检查',
  power_regulator: '稳压器识别',
  connectivity: '连通性检查',
  shorted_component: '短路元件检查',
  dfm: 'DFM 制造规则检查',
  pad_distance: '焊盘间距检查',
  current_capacity: '载流能力检查',
  decoupling_placement: '去耦布局检查',
  pin_pad: '原理图与 PCB 引脚网络对照',
  gerber: '制造文件（Gerber/钻孔）检查',
  bom: '物料（BOM）检查',
  datasheets: '数据手册覆盖与提取计划检查',
  spice: 'SPICE 仿真检查',
}

// 分析来源 → 报告展示名。目前只有 Gerber 复用层需要额外标注来源。
const SOURCE_LABELS = {
  gerber: 'Gerber 分析',
  bom: 'BOM 检查',
  datasheets: '数据手册检查',
  spice: 'SPICE 仿真',
}

// 仿真结果状态 → 中文展示与徽标类别。
const SPICE_STATUS_LABELS = {
  pass: '通过',
  warn: '警告',
  fail: '失败',
  skip: '跳过',
}

const SPICE_STATUS_BADGES = {
  pass: 'pass',
  warn: 'should_fix',
  fail: 'must_fix',
  skip: 'not_evaluated',
}

// 制造文件子检查 → 中文名。
const MANUFACTURING_CHECK_LABELS = {
  layer_completeness: '层完整性',
  drill_data: '钻孔数据',
  alignment: '层对齐',
  board_dimensions: '板框尺寸',
}

// Gerber 文件里的单位枚举 → 中文展示。
const UNIT_LABELS = {
  mm: '毫米（mm）',
  inch: '英寸（inch）',
}

// 物料检查项 → 中文名。
const BOM_CHECK_LABELS = {
  missing_mpn: '缺少 MPN',
  missing_footprint: '缺少封装',
  duplicate_designator: '重复位号',
  schematic_pcb_match: '原理图与 PCB 位号一致',
  imported_diff: '导入 BOM 差异',
}

// 数据手册检查项 → 中文名。pin_verification 永远显示未评估：
// 确定性 CLI 不解析 PDF 引脚表。
const DATASHEET_CHECK_LABELS = {
  coverage: '集成电路数据手册覆盖',
  pdf_match: 'PDF 与元件 MPN 匹配',
  extraction_plan: '提取计划生成',
  pin_verification: '引脚级核对',
}

// 上游提取计划状态 → 中文展示与徽标类别。
const DATASHEET_PLAN_LABELS = {
  existing: '已存在（PDF 未变）',
  generated: '已生成',
  'up-to-date': '已是最新',
  skipped: '已跳过（scout 判定）',
  not_evaluated: '未评估（需要 AI scout）',
  failed: '生成失败',
}

const DATASHEET_PLAN_BADGES = {
  existing: 'pass',
  generated: 'pass',
  'up-to-date': 'pass',
  skipped: 'not_evaluated',
  not_evaluated: 'not_evaluated',
  failed: 'failed',
}

const DATASHEET_REASON_LABELS = {
  no_mpn: '无 MPN',
  no_pdf: '无匹配 PDF',
}

// 文档类型 → 中文名；未知类型按「其他」展示。
const DOCUMENT_KIND_LABELS = {
  pcb: 'PCB',
  sch: '原理图',
  lib: '库文件',
}

// SVG 来自 altiumts 的渲染结果，正常板图不会包含脚本、事件属性或外部引用。
// 为防注入与外部请求，含这些特征时宁可不内联，也不把可疑内容写进报告。
// 事件属性要求前面是分隔符（空白、引号、斜杠或标签开头），避免把
// data-component= 这类普通属性名里的 "onent=" 误判成 on 事件。
const UNSAFE_SVG_PATTERN = /<\s*(?:script|foreignObject|iframe|object|embed)\b|(?:^|[\s"'/<])on[a-z]+\s*=|javascript:|@import|(?:href|src)\s*=\s*["']?\s*(?:https?:)?\/\//i

/**
 * 渲染完整报告 HTML。
 *
 * @param {object} [data] ReportData：
 *   project、generatedAt、coverage {documents, parsed, notEvaluated, pcb?, netlist?}、
 *   overview {schematic, pcb}（工程概览）、adRules [{kind, name}]、
 *   findings [{rule_id, severity, title, evidence, ...}]、status {[rule]: 状态}、
 *   boards [{name, kind, selected}]（可选，列出工程全部文档）、
 *   svgs [{title, svg}]
 * @returns {string} 单文件 HTML
 */
export function renderReport(data = {}) {
  const report = normalizeReport(data)
  const title = `${report.project} · AD-Happy 设计审查报告`
  const values = {
    TITLE: escapeHtml(title),
    PROJECT: escapeHtml(report.project),
    GENERATED_AT: escapeHtml(report.generatedAt),
    BODY: renderBody(report),
  }
  // 单次替换：用户数据里即使含有 {{TITLE}} 之类的字面量，也不会被二次展开。
  return TEMPLATE.replace(
    /\{\{(TITLE|PROJECT|GENERATED_AT|BODY)\}\}/g,
    (_, key) => values[key],
  )
}

// ---------------------------------------------------------------------------
// 数据归一化
// ---------------------------------------------------------------------------

function normalizeReport(data) {
  const source = data && typeof data === 'object' ? data : {}
  const findings = Array.isArray(source.findings)
    ? source.findings.filter(isPlainObject)
    : []
  return {
    project: scalarText(source.project) || '（未命名工程）',
    generatedAt: scalarText(source.generatedAt) || '—',
    coverage: isPlainObject(source.coverage) ? source.coverage : {},
    overview: normalizeOverview(source.overview),
    adRules: normalizeRules(source.adRules),
    findings: findings.map(normalizeFinding),
    status: isPlainObject(source.status) ? source.status : {},
    boards: normalizeDocuments(source.boards),
    manufacturing: normalizeManufacturing(source.manufacturing),
    bom: normalizeBom(source.bom),
    datasheets: normalizeDatasheets(source.datasheets),
    spice: normalizeSpice(source.spice),
    svgs: Array.isArray(source.svgs) ? source.svgs : [],
  }
}

function normalizeOverview(value) {
  if (!isPlainObject(value)) return null
  const schematic = isPlainObject(value.schematic) ? value.schematic : {}
  const pcb = isPlainObject(value.pcb) ? value.pcb : {}
  return {
    schematic: {
      components: countValue(schematic.components),
      pins: countValue(schematic.pins),
      nets: countValue(schematic.nets),
      pinsMatched: countValue(schematic.pinsMatched),
      pinsTotal: countValue(schematic.pinsTotal),
    },
    pcb: {
      components: countValue(pcb.components),
      pads: countValue(pcb.pads),
      nets: countValue(pcb.nets),
      tracks: countValue(pcb.tracks),
      arcs: countValue(pcb.arcs),
      vias: countValue(pcb.vias),
      rules: countValue(pcb.rules),
    },
  }
}

function normalizeRules(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter(isPlainObject)
    .map(rule => ({
      kind: scalarText(rule.kind),
      name: scalarText(rule.name),
    }))
    .filter(rule => rule.kind || rule.name)
}

function countValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function normalizeSkippedChecks(pcbCoverage) {
  if (!isPlainObject(pcbCoverage) || !Array.isArray(pcbCoverage.skippedChecks)) return []
  return pcbCoverage.skippedChecks
    .filter(isPlainObject)
    .map(check => ({
      rule: scalarText(check.rule),
      check: scalarText(check.check),
      reason: scalarText(check.reason),
    }))
    .filter(check => check.check || check.reason)
}

function normalizeDocuments(value) {
  if (!Array.isArray(value)) return []
  return value.filter(isPlainObject).map(document => ({
    name: scalarText(document.name) || '（未命名文档）',
    kind: scalarText(document.kind) || 'other',
    selected: document.selected === true,
  }))
}

function normalizeManufacturing(value) {
  if (!isPlainObject(value)) return null
  const checks = isPlainObject(value.checks) ? value.checks : {}
  return {
    status: scalarText(value.status) || 'not_evaluated',
    directory: scalarText(value.directory),
    gerberFiles: countValue(value.gerberFiles),
    drillFiles: countValue(value.drillFiles),
    layerCount: countValue(value.layerCount),
    drillCount: countValue(value.drillCount),
    units: stringList(value.units),
    missingLayers: stringList(value.missingLayers),
    missingRequired: stringList(value.missingRequired),
    missingRecommended: stringList(value.missingRecommended),
    boardDimensions: normalizeDimensions(value.boardDimensions),
    checks: Object.keys(checks)
      .map(key => ({ key, status: scalarText(checks[key]) }))
      .filter(check => check.status),
    reasons: stringList(value.reasons),
    findings: Array.isArray(value.findings)
      ? value.findings.filter(isPlainObject).map(normalizeFinding)
      : [],
  }
}

function normalizeDimensions(value) {
  if (!isPlainObject(value)) return null
  const width = countValue(value.widthMm)
  const height = countValue(value.heightMm)
  if (width <= 0 || height <= 0) return null
  return { width, height, area: countValue(value.areaMm2) }
}

function normalizeBom(value) {
  if (!isPlainObject(value)) return null
  const checks = isPlainObject(value.checks) ? value.checks : {}
  const normalizedChecks = {}
  for (const [key, status] of Object.entries(checks)) {
    const text = scalarText(status)
    if (text) normalizedChecks[key] = text
  }
  return {
    status: scalarText(value.status) || 'not_evaluated',
    components: countValue(value.components),
    schematicComponents: countValue(value.schematicComponents),
    pcbComponents: countValue(value.pcbComponents),
    rowsWithMpn: countValue(value.rowsWithMpn),
    rowsMissingMpn: countValue(value.rowsMissingMpn),
    rowsWithFootprint: countValue(value.rowsWithFootprint),
    rowsMissingFootprint: countValue(value.rowsMissingFootprint),
    duplicateDesignators: stringList(value.duplicateDesignators),
    schematicOnly: stringList(value.schematicOnly),
    pcbOnly: stringList(value.pcbOnly),
    checks: normalizedChecks,
    reasons: stringList(value.reasons),
    findings: countValue(value.findings),
    bomPath: scalarText(value.bomPath),
    bomGenerated: value.bomGenerated === true,
    procurementPath: scalarText(value.procurementPath),
    imported: normalizeImportedBom(value.imported),
  }
}

function normalizeImportedBom(value) {
  if (!isPlainObject(value)) return null
  return {
    path: scalarText(value.path),
    rows: countValue(value.rows),
    missingFromBom: stringList(value.missingFromBom),
    extraInBom: stringList(value.extraInBom),
    missingColumns: stringList(value.missingColumns),
  }
}

function normalizeDatasheets(value) {
  if (!isPlainObject(value)) return null
  const checks = isPlainObject(value.checks) ? value.checks : {}
  const normalizedChecks = {}
  for (const [key, status] of Object.entries(checks)) {
    const content = scalarText(status)
    if (content) normalizedChecks[key] = content
  }
  return {
    status: scalarText(value.status) || 'not_evaluated',
    directory: scalarText(value.directory),
    cacheDir: scalarText(value.cacheDir),
    manifestPresent: value.manifestPresent === true,
    manifestInvalid: value.manifestInvalid === true,
    pdfCount: countValue(value.pdfCount),
    components: countValue(value.components),
    componentsWithMpn: countValue(value.componentsWithMpn),
    componentsWithPdf: countValue(value.componentsWithPdf),
    componentsWithoutPdf: countValue(value.componentsWithoutPdf),
    icComponents: countValue(value.icComponents),
    icsWithoutPdf: countValue(value.icsWithoutPdf),
    matched: Array.isArray(value.matched)
      ? value.matched.filter(isPlainObject).map(entry => ({
          reference: scalarText(entry.reference),
          mpn: scalarText(entry.mpn),
          pdfFileName: scalarText(entry.pdfFileName),
          planStatus: scalarText(entry.planStatus) || 'not_evaluated',
          planPath: scalarText(entry.planPath),
          planError: scalarText(entry.planError),
        }))
      : [],
    unmatchedPdfs: Array.isArray(value.unmatchedPdfs)
      ? value.unmatchedPdfs.filter(isPlainObject).map(pdf => ({
          fileName: scalarText(pdf.fileName),
          inferredMpn: scalarText(pdf.inferredMpn),
          relativePath: scalarText(pdf.relativePath),
        }))
      : [],
    componentsWithoutPdfList: Array.isArray(value.componentsWithoutPdfList)
      ? value.componentsWithoutPdfList.filter(isPlainObject).map(entry => ({
          reference: scalarText(entry.reference),
          mpn: scalarText(entry.mpn),
          isIc: entry.isIc === true,
          reason: scalarText(entry.reason),
          reasonText: scalarText(entry.reasonText),
        }))
      : [],
    plans: Array.isArray(value.plans)
      ? value.plans.filter(isPlainObject).map(plan => ({
          mpn: scalarText(plan.mpn),
          status: scalarText(plan.status) || 'not_evaluated',
          ok: plan.ok === true,
          planPath: scalarText(plan.planPath),
          error: scalarText(plan.error),
          taskCount: countValue(plan.taskCount),
        }))
      : [],
    checks: normalizedChecks,
    reasons: stringList(value.reasons),
    findings: countValue(value.findings),
    pinVerification: scalarText(value.pinVerification) || 'not_evaluated',
  }
}

function normalizeSpice(value) {
  if (!isPlainObject(value)) return null
  const counts = isPlainObject(value.counts) ? value.counts : {}
  const checks = isPlainObject(value.checks) ? value.checks : {}
  const normalizedChecks = {}
  for (const [key, status] of Object.entries(checks)) {
    const content = scalarText(status)
    if (content) normalizedChecks[key] = content
  }
  const artifacts = isPlainObject(value.artifacts) ? value.artifacts : {}
  return {
    requested: value.requested === true,
    status: scalarText(value.status) || 'not_evaluated',
    simulator: normalizeSpiceSimulator(value.simulator),
    availableCircuits: countValue(value.availableCircuits),
    submittedCircuits: countValue(value.submittedCircuits),
    missingCircuits: countValue(value.missingCircuits),
    circuits: Array.isArray(value.circuits)
      ? value.circuits.filter(isPlainObject).map(circuit => ({
          type: scalarText(circuit.type) || 'simulation',
          typeLabel: scalarText(circuit.typeLabel),
          reference: scalarText(circuit.reference),
          components: stringList(circuit.components),
          status: SPICE_STATUS_LABELS[scalarText(circuit.status)]
            ? scalarText(circuit.status)
            : 'skip',
          note: scalarText(circuit.noteText) || scalarText(circuit.note),
          testbench: scalarText(circuit.testbench),
          testbenchExists: circuit.testbenchExists === true,
          logFile: scalarText(circuit.logFile),
          expected: isPlainObject(circuit.expected) ? circuit.expected : null,
          simulated: isPlainObject(circuit.simulated) ? circuit.simulated : null,
          delta: isPlainObject(circuit.delta) ? circuit.delta : null,
        }))
      : [],
    excludedCircuits: normalizeSpiceCandidates(value.excludedCircuits),
    unaccountedCircuits: normalizeSpiceCandidates(value.unaccountedCircuits),
    counts: {
      total: countValue(counts.total),
      pass: countValue(counts.pass),
      warn: countValue(counts.warn),
      fail: countValue(counts.fail),
      skip: countValue(counts.skip),
    },
    checks: normalizedChecks,
    artifacts: {
      index: scalarText(artifacts.index),
      input: scalarText(artifacts.input),
      report: scalarText(artifacts.report),
      workdir: scalarText(artifacts.workdir),
    },
    installHints: stringList(value.installHints),
    detectedDetectors: stringList(value.detectedDetectors),
    unsupportedDetectors: stringList(value.unsupportedDetectors),
    reasons: stringList(value.reasons),
    findings: countValue(value.findings),
  }
}

function normalizeSpiceCandidates(value) {
  if (!Array.isArray(value)) return []
  return value.filter(isPlainObject).map(candidate => ({
    type: scalarText(candidate.type) || 'simulation',
    typeLabel: scalarText(candidate.typeLabel),
    detector: scalarText(candidate.detector),
    reference: scalarText(candidate.reference),
    components: stringList(candidate.components),
    reason: scalarText(candidate.reason),
  }))
}

function normalizeSpiceSimulator(value) {
  if (!isPlainObject(value)) return null
  const name = scalarText(value.name)
  if (!name) return null
  return {
    name,
    path: scalarText(value.path),
    version: scalarText(value.version),
    versionText: scalarText(value.versionText),
    versionNote: scalarText(value.versionNote),
  }
}

function stringList(value) {
  if (!Array.isArray(value)) return []
  return value.map(scalarText).filter(Boolean)
}

function normalizeFinding(finding) {
  const rawEvidence = evidenceText(finding.evidence)
  const description = scalarText(finding.description)
  return {
    ruleId: scalarText(finding.rule_id) || '（无规则 ID）',
    source: scalarText(finding.source),
    kind: scalarText(finding.kind) === 'fact' ? 'fact' : 'issue',
    groupKey: severityGroup(finding.severity),
    title: scalarText(finding.title) || scalarText(finding.summary) || '（无标题）',
    // 兼容原始 finding：没有 evidence 时用 description 作为证据展示。
    evidence: rawEvidence || description,
    // 两者都有且内容不同时，说明单独展示，避免丢失细节。
    description: rawEvidence && description && description !== rawEvidence ? description : '',
    recommendation: scalarText(finding.recommendation) || scalarText(finding.advice),
    components: listText(finding.components, scalarText),
    nets: listText(finding.nets, scalarText),
    pins: listText(finding.pins, pinText),
  }
}

// 供上层汇总 counts / top findings 复用，避免严重度词汇表在两处漂移。
export function severityGroup(severity) {
  const key = scalarText(severity).trim().toLowerCase()
  return ownLookup(SEVERITY_ALIASES, key) || 'should_fix'
}

function groupFor(key) {
  return SEVERITY_GROUPS.find(group => group.key === key) || SEVERITY_GROUPS[1]
}

// ---------------------------------------------------------------------------
// 各章节渲染
// ---------------------------------------------------------------------------

function renderBody(report) {
  return [
    renderConclusion(report),
    renderOverview(report),
    renderDocuments(report),
    renderBom(report),
    renderDatasheets(report),
    renderManufacturing(report),
    renderSpice(report),
    renderFindings(report),
    renderFacts(report),
    renderCoverage(report),
    renderFigures(report),
  ].filter(Boolean).join('\n')
}

function renderConclusion({ findings, status, overview }) {
  const issues = findings.filter(finding => finding.kind !== 'fact')
  const facts = findings.filter(finding => finding.kind === 'fact')
  const counts = countFindings(issues)
  const notEvaluated = countStatus(status, 'not_evaluated')
  const partial = countStatus(status, 'partial')
  const failed = countStatus(status, 'failed')
  const stats = [
    stat('must_fix', counts.must_fix, '必须修复'),
    stat('should_fix', counts.should_fix, '建议修复'),
    stat('nice_to_have', counts.nice_to_have, '可优化'),
    stat('facts', facts.length, '实测事实'),
    stat('partial', partial, '部分完成规则'),
    stat('na', notEvaluated, '未评估规则'),
    stat('failed', failed, '失败规则'),
  ].join('')
  const netlistWarning = renderNetlistWarning(overview)
  return [
    '<section class="panel" id="conclusion">',
    '  <h2>结论</h2>',
    `  <p class="verdict">${escapeHtml(buildVerdict(counts, notEvaluated, partial, failed))}</p>`,
    `  <ul class="stat-grid">${stats}</ul>`,
    netlistWarning,
    '  <p class="note">「未评估」表示输入数据不足，本次没有得出通过或失败的结论；「部分完成」表示规则已运行但部分子检查被跳过。两者都不等同于「通过」。</p>',
    '</section>',
  ].filter(Boolean).join('\n')
}

function renderNetlistWarning(overview) {
  if (!overview) return ''
  const { pinsMatched, pinsTotal } = overview.schematic
  if (!(pinsTotal > 0) || pinsMatched >= pinsTotal) return ''
  return `  <p class="note note-warn">网表匹配率不足：${pinsMatched}/${pinsTotal} 个原理图引脚进入网表。`
    + '依赖网表的原理图规则（voltage_divider、rc_filter、power_regulator、shorted_component）'
    + '的空结果已按「未评估」处理，本次不能视为通过。</p>'
}

function buildVerdict(counts, notEvaluated, partial, failed) {
  const total = counts.must_fix + counts.should_fix + counts.nice_to_have
  if (failed === 0 && notEvaluated === 0 && partial === 0 && total === 0) {
    return '已评估的规则均未发现问题。'
  }

  const parts = []
  if (failed > 0) parts.push(`本次审查有 ${failed} 条规则执行失败，结论不完整`)
  if (counts.must_fix > 0) {
    parts.push(`发现 ${counts.must_fix} 项必须修复的问题，建议修复后再定版`)
  } else if (counts.should_fix > 0) {
    parts.push(`未发现必须修复的问题，有 ${counts.should_fix} 项建议修复`)
  } else if (counts.nice_to_have > 0) {
    parts.push(`未发现必须修复或建议修复的问题，有 ${counts.nice_to_have} 项可优化`)
  } else if (failed === 0) {
    parts.push('已评估的规则未发现必须修复、建议修复或可优化的问题')
  }
  if (partial > 0) {
    parts.push(`有 ${partial} 条规则只完成部分检查，跳过项不代表通过`)
  }
  if (notEvaluated > 0) {
    parts.push(`有 ${notEvaluated} 条规则未评估，不能据此认为全部通过`)
  }
  return `${parts.join('；')}。`
}

function stat(kind, value, label) {
  return `<li class="stat ${kind}"><span class="stat-value">${value}</span><span class="stat-label">${escapeHtml(label)}</span></li>`
}

// 「工程概览」：两侧规模、网表匹配率与 AD 规则清单。
// overview 缺失（旧调用方）时整节不渲染。
function renderOverview({ overview, adRules }) {
  if (!overview && adRules.length === 0) return ''
  const rows = overview
    ? [
        ['原理图元件', overview.schematic.components],
        ['原理图引脚', overview.schematic.pins],
        ['原理图网络', overview.schematic.nets],
        ['入网引脚', `${overview.schematic.pinsMatched}/${overview.schematic.pinsTotal}`],
        ['PCB 元件', overview.pcb.components],
        ['PCB 焊盘', overview.pcb.pads],
        ['PCB 网络', overview.pcb.nets],
        ['铜走线', overview.pcb.tracks],
        ['铜圆弧', overview.pcb.arcs],
        ['过孔', overview.pcb.vias],
        ['AD 规则', overview.pcb.rules],
      ]
        .map(([label, value]) => `    <div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd></div>`)
        .join('\n')
    : ''
  const matchRate = overview && overview.schematic.pinsTotal > 0
    ? `${overview.schematic.pinsMatched}/${overview.schematic.pinsTotal}`
    : '—'
  const ruleRows = adRules.length
    ? adRules.map(rule => `      <tr><th scope="row">${escapeHtml(rule.name || '（未命名规则）')}</th><td><code>${escapeHtml(rule.kind || '—')}</code></td></tr>`).join('\n')
    : '      <tr><td colspan="2">未解析到 AD 规则。</td></tr>'
  return [
    '<section class="panel" id="overview">',
    '  <h2>工程概览</h2>',
    overview ? `  <dl class="coverage-grid">\n${rows}\n  </dl>` : '',
    `  <p class="hint">原理图网表匹配率：${escapeHtml(matchRate)}；PCB 规则来自 AD 工程文件，仅展示清单，不判定对象命中关系。</p>`,
    '  <h3>AD 规则清单</h3>',
    '  <table class="status-table">',
    '    <thead><tr><th scope="col">规则名</th><th scope="col">类型</th></tr></thead>',
    '    <tbody>',
    ruleRows,
    '    </tbody>',
    '  </table>',
    '</section>',
  ].filter(Boolean).join('\n')
}

// 「板卡与文档」：列出工程全部文档并标出本次实际解析的 PCB / 原理图。
// boards 缺失或为空时整节不渲染，保持与旧调用方的兼容。
function renderDocuments({ boards }) {
  if (boards.length === 0) return ''

  const schematics = boards.filter(document => document.kind === 'sch')
  const selectedSchematic = schematics.find(document => document.selected)
  const rows = boards.map(document => {
    const kind = ownLookup(DOCUMENT_KIND_LABELS, document.kind) || '其他'
    const marker = document.selected
      ? `<span class="badge badge-pass">${document.kind === 'pcb'
        ? '本次审查'
        : document.kind === 'sch' ? '本次解析' : '已选中'}</span>`
      : '—'
    return `      <tr${document.selected ? ' class="doc-selected"' : ''}><th scope="row">${escapeHtml(document.name)}</th><td>${escapeHtml(kind)}</td><td>${marker}</td></tr>`
  }).join('\n')

  const notes = []
  if (schematics.length > 1) {
    notes.push(
      `工程包含 ${schematics.length} 份原理图，本次仅解析第一份 SchDoc`
      + `${selectedSchematic ? `（${selectedSchematic.name}）` : ''}，其余原理图未参与评估。`,
    )
  }

  return [
    '<section class="panel" id="documents">',
    '  <h2>板卡与文档</h2>',
    `  <p class="hint">共 ${boards.length} 个文档；库文件不做独立解析。</p>`,
    '  <table class="status-table doc-table">',
    '    <thead><tr><th scope="col">文档</th><th scope="col">类型</th><th scope="col">本次分析</th></tr></thead>',
    '    <tbody>',
    rows,
    '    </tbody>',
    '  </table>',
    notes.length ? `  <p class="note">${escapeHtml(notes.join(' '))}</p>` : '',
    '</section>',
  ].filter(Boolean).join('\n')
}

// 「物料」：元件数、缺 MPN/封装、重复位号、原理图↔PCB 不一致与产物路径。
// 未评估的检查显式写「未评估」，不得显示成 0 或「通过」。
function renderBom({ bom }) {
  if (!bom) return ''
  const check = key => scalarText(bom.checks[key])
  const countOrState = (key, count) => {
    const status = check(key)
    if (status === 'not_evaluated') return '未评估'
    if (status === 'failed') return '失败'
    if (status === 'partial') return '部分完成'
    return String(count)
  }
  const mismatchCount = bom.schematicOnly.length + bom.pcbOnly.length
  const imported = bom.imported
  const importedDiffCount = imported
    ? imported.missingFromBom.length + imported.extraInBom.length
    : 0

  const rows = [
    ['元件数', String(bom.components)],
    ['缺少 MPN', countOrState('missing_mpn', bom.rowsMissingMpn)],
    ['缺少封装', countOrState('missing_footprint', bom.rowsMissingFootprint)],
    ['重复位号', countOrState('duplicate_designator', bom.duplicateDesignators.length)],
    ['原理图与 PCB 不一致', countOrState('schematic_pcb_match', mismatchCount)],
  ]
  if (imported) {
    rows.push(['导入 BOM 差异', countOrState('imported_diff', importedDiffCount)])
  }
  const grid = rows
    .map(([label, value]) => `    <div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join('\n')

  let statusText
  if (bom.status === 'not_evaluated') {
    statusText = `本次未评估物料检查${bom.reasons.length ? `：${bom.reasons.join('；')}` : '。'}`
  } else if (bom.status === 'failed') {
    statusText = `物料检查执行失败${bom.reasons.length ? `：${bom.reasons.join('；')}` : '。'}`
  } else if (bom.status === 'partial') {
    statusText = '物料检查部分完成；未评估的项目不代表通过。'
  } else if (bom.findings > 0) {
    statusText = `发现 ${bom.findings} 条物料问题，详见问题清单。`
  } else {
    statusText = '未发现物料问题。'
  }

  const reasons = bom.reasons.length
    ? [
        '  <h3>未评估与限制说明</h3>',
        '  <ul class="status-list" id="bom-reasons">',
        ...bom.reasons.map(reason => `    <li><span class="detail">${escapeHtml(reason)}</span></li>`),
        '  </ul>',
      ].join('\n')
    : ''

  const duplicates = bom.duplicateDesignators.length
    ? [
        '  <h3>重复位号</h3>',
        '  <ul class="layer-list" id="bom-duplicates">',
        ...bom.duplicateDesignators.map(reference => `    <li><code>${escapeHtml(reference)}</code></li>`),
        '  </ul>',
      ].join('\n')
    : ''

  const mismatchItems = [
    ...bom.schematicOnly.map(reference => ({ reference, side: '仅原理图' })),
    ...bom.pcbOnly.map(reference => ({ reference, side: '仅 PCB' })),
  ]
  let mismatches = ''
  if (check('schematic_pcb_match') === 'not_evaluated') {
    mismatches = '  <p class="empty">未评估：缺少一侧元件清单，无法比对原理图与 PCB 位号。</p>'
  } else if (check('schematic_pcb_match') === 'failed') {
    mismatches = '  <p class="empty">检查执行失败，无法判断原理图与 PCB 位号是否一致。</p>'
  } else if (mismatchItems.length > 0) {
    mismatches = [
      '  <h3>原理图与 PCB 不一致</h3>',
      '  <ul class="status-list" id="bom-mismatches">',
      ...mismatchItems.map(item => `    <li><code>${escapeHtml(item.reference)}</code><span class="rule-name">${escapeHtml(item.side)}</span></li>`),
      '  </ul>',
    ].join('\n')
  } else {
    mismatches = '  <p class="empty">原理图与 PCB 的位号一致。</p>'
  }

  let importedSection = ''
  if (imported) {
    const lines = [
      '  <h3>导入 BOM 比对</h3>',
      `  <p class="hint">导入文件：<code>${escapeHtml(imported.path)}</code>；解析到 ${imported.rows} 行。</p>`,
    ]
    if (imported.missingColumns.length > 0) {
      lines.push(`  <p class="note">导入文件缺少列：${escapeHtml(imported.missingColumns.join('、'))}；缺失列按空值处理。</p>`)
    }
    if (imported.missingFromBom.length > 0) {
      lines.push('  <h4>工程有、BOM 没有</h4>')
      lines.push(`  <p class="detail">${escapeHtml(imported.missingFromBom.join('、'))}</p>`)
    }
    if (imported.extraInBom.length > 0) {
      lines.push('  <h4>BOM 有、工程没有</h4>')
      lines.push(`  <p class="detail">${escapeHtml(imported.extraInBom.join('、'))}</p>`)
    }
    if (imported.missingFromBom.length === 0 && imported.extraInBom.length === 0) {
      lines.push('  <p class="empty">导入 BOM 与工程解析的位号一致。</p>')
    }
    importedSection = lines.join('\n')
  }

  const bomPath = bom.bomPath
    ? `<code>${escapeHtml(bom.bomPath)}</code>`
    : '未生成'
  const procurementPath = bom.procurementPath
    ? `<code>${escapeHtml(bom.procurementPath)}</code>`
    : '未生成'
  const sourceText = bom.bomGenerated
    ? '由工程解析数据生成'
    : bom.bomPath ? '导入的 Altium BOM' : '未生成'

  return [
    '<section class="panel" id="bom">',
    '  <h2>物料</h2>',
    `  <p class="hint">来源：${escapeHtml(sourceText)}。采购清单为离线生成，不联网查询分销商库存，建议渠道留空。</p>`,
    `  <p class="note${bom.status === 'failed' || bom.status === 'not_evaluated' || bom.status === 'partial' ? ' note-warn' : ''}">${escapeHtml(statusText)}</p>`,
    '  <dl class="coverage-grid">',
    grid,
    '  </dl>',
    reasons,
    duplicates,
    mismatches,
    importedSection,
    '  <h3>产物</h3>',
    '  <table class="status-table" id="bom-paths">',
    '    <thead><tr><th scope="col">产物</th><th scope="col">路径</th></tr></thead>',
    '    <tbody>',
    `      <tr><th scope="row">BOM 文件</th><td>${bomPath}</td></tr>`,
    `      <tr><th scope="row">采购清单</th><td>${procurementPath}</td></tr>`,
    '    </tbody>',
    '  </table>',
    '</section>',
  ].filter(Boolean).join('\n')
}

function matchedEmptyText(status) {
  if (status === 'not_evaluated') {
    return '未评估：没有可用的数据手册目录，无法判断 PDF 是否与元件匹配。'
  }
  if (status === 'failed') {
    return '无法判断：数据手册检查执行失败，无法判断 PDF 是否与元件匹配。'
  }
  if (status === 'partial') {
    return '部分完成：部分输入不足，无法完整判断 PDF 与元件的匹配情况。'
  }
  return '没有 PDF 与工程元件匹配。'
}

function missingEmptyText(status) {
  if (status === 'not_evaluated') {
    return '未评估：没有数据手册目录或输入不足，无法判断哪些元件缺数据手册。'
  }
  if (status === 'failed') {
    return '无法判断：数据手册检查执行失败，无法判断哪些元件缺数据手册。'
  }
  return '部分完成：部分输入不足，无法完整判断哪些元件缺数据手册。'
}

// 「数据手册」：PDF 覆盖、MPN 匹配与提取计划状态。
// 引脚级核对始终显式标注未评估：本工具不解析 PDF 引脚表。
function renderDatasheets({ datasheets }) {
  if (!datasheets) return ''
  const status = datasheets.status
  const check = key => scalarText(datasheets.checks[key])
  const countOrState = (key, value) => {
    const state = check(key)
    if (state === 'not_evaluated') return '未评估'
    if (state === 'failed') return '失败'
    if (state === 'partial') return '部分完成'
    return String(value)
  }
  const planText = () => {
    const state = check('extraction_plan')
    if (state === 'not_evaluated') return '未评估'
    if (state === 'failed') return '失败'
    const generated = plansGenerated()
    if (state === 'partial') return `部分完成（${generated}/${datasheets.plans} 已生成）`
    return `${generated}/${datasheets.plans} 已生成`
  }
  const plansGenerated = () => datasheets.plans
    .filter(plan => ['existing', 'generated', 'up-to-date'].includes(plan.status))
    .length

  const rows = [
    ['数据手册目录', datasheets.directory
      ? `<code>${escapeHtml(datasheets.directory)}</code>`
      : '—'],
    ['提取计划缓存', datasheets.cacheDir
      ? `<code>${escapeHtml(datasheets.cacheDir)}</code>`
      : '—'],
    ['PDF 文件数', String(datasheets.pdfCount)],
    ['元件数', String(datasheets.components)],
    ['元件有 MPN', String(datasheets.componentsWithMpn)],
    ['匹配到 PDF 的元件', status === 'not_evaluated'
      ? '未评估'
      : String(datasheets.componentsWithPdf)],
    ['缺 PDF 的元件', status === 'not_evaluated'
      ? '未评估'
      : String(datasheets.componentsWithoutPdf)],
    ['集成电路（U/IC）', String(datasheets.icComponents)],
    ['缺 PDF 的集成电路', countOrState('coverage', datasheets.icsWithoutPdf)],
    ['未匹配的 PDF', countOrState('pdf_match', datasheets.unmatchedPdfs.length)],
    ['提取计划', planText()],
  ]
  const grid = rows
    .map(([label, value]) => `    <div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`)
    .join('\n')

  let statusText
  if (status === 'not_evaluated') {
    statusText = `本次未评估数据手册检查${datasheets.reasons.length
      ? `：${datasheets.reasons.join('；')}`
      : '：没有可用的数据手册目录。'}`
  } else if (status === 'failed') {
    statusText = `数据手册检查执行失败${datasheets.reasons.length
      ? `：${datasheets.reasons.join('；')}`
      : '。'}`
  } else if (status === 'partial') {
    statusText = '数据手册覆盖与提取计划检查部分完成；引脚级核对尚未进行，不能视为通过。'
  } else if (status === 'found') {
    statusText = `发现 ${datasheets.findings} 条数据手册问题，详见问题清单。`
  } else {
    statusText = '数据手册覆盖与提取计划检查完成；引脚级核对仍需 AI 或人工提取后完成。'
  }

  const checks = Object.keys(datasheets.checks).length
    ? [
        '  <h3>检查项</h3>',
        '  <table class="status-table" id="datasheets-checks">',
        '    <thead><tr><th scope="col">检查项</th><th scope="col">状态</th></tr></thead>',
        '    <tbody>',
        ...Object.entries(datasheets.checks).map(([key, value]) => {
          const label = ownLookup(DATASHEET_CHECK_LABELS, key) || key
          return `      <tr><th scope="row"><span class="rule-name">${escapeHtml(label)}</span><code>${escapeHtml(key)}</code></th><td>${statusBadgeHtml(value)}</td></tr>`
        }),
        '    </tbody>',
        '  </table>',
      ].join('\n')
    : ''

  const matched = datasheets.matched.length
    ? [
        '  <h3>已匹配的数据手册</h3>',
        '  <table class="status-table" id="datasheets-matched">',
        '    <thead><tr><th scope="col">位号</th><th scope="col">MPN</th><th scope="col">PDF</th><th scope="col">提取计划</th></tr></thead>',
        '    <tbody>',
        ...datasheets.matched.slice(0, 50).map(entry => {
          const badge = ownLookup(DATASHEET_PLAN_BADGES, entry.planStatus) || 'not_evaluated'
          const label = ownLookup(DATASHEET_PLAN_LABELS, entry.planStatus) || entry.planStatus
          return `      <tr><th scope="row"><code>${escapeHtml(entry.reference)}</code></th><td><code>${escapeHtml(entry.mpn)}</code></td><td>${escapeHtml(entry.pdfFileName)}</td><td><span class="badge badge-${badge}">${escapeHtml(label)}</span></td></tr>`
        }),
        '    </tbody>',
        '  </table>',
        datasheets.matched.length > 50
          ? `  <p class="note">仅展示前 50 个匹配元件，完整列表见 datasheets.json。</p>`
          : '',
      ].join('\n')
    : `  <h3>已匹配的数据手册</h3>\n  <p class="empty">${matchedEmptyText(status)}</p>`

  const missingItems = datasheets.componentsWithoutPdfList
  let missing
  if (status === 'not_evaluated' || status === 'failed') {
    missing = `  <p class="empty">${missingEmptyText(status)}</p>`
  } else if (missingItems.length === 0) {
    missing = status === 'partial'
      ? '  <p class="empty">部分完成：部分输入不足，无法完整判断哪些元件缺数据手册。</p>'
      : '  <p class="empty">没有缺失数据手册的元件。</p>'
  } else {
    missing = [
      '  <h3>缺少数据手册的元件</h3>',
      '  <ul class="status-list" id="datasheets-missing">',
      ...missingItems.slice(0, 50).map(entry => {
        const badge = entry.isIc ? 'should_fix' : 'not_evaluated'
        const kind = entry.isIc ? '集成电路' : '非集成电路'
        const reason = entry.reasonText || ownLookup(DATASHEET_REASON_LABELS, entry.reason) || entry.reason
        return `    <li><code>${escapeHtml(entry.reference)}</code><span class="rule-name">${escapeHtml(entry.mpn || '无 MPN')}</span><span class="badge badge-${badge}">${kind}</span><span class="detail">${escapeHtml(reason)}</span></li>`
      }),
      '  </ul>',
      missingItems.length > 50
        ? '  <p class="note">仅展示前 50 个元件，完整列表见 datasheets.json。</p>'
        : '',
    ].join('\n')
  }

  const unmatched = datasheets.unmatchedPdfs.length
    ? [
        '  <h3>未匹配到元件的数据手册</h3>',
        '  <ul class="status-list" id="datasheets-unmatched">',
        ...datasheets.unmatchedPdfs.slice(0, 50).map(pdf => {
          const detail = pdf.inferredMpn
            ? `推断 MPN：${pdf.inferredMpn}`
            : '无法从文件名推断 MPN'
          return `    <li><code>${escapeHtml(pdf.fileName)}</code><span class="detail">${escapeHtml(detail)}</span></li>`
        }),
        '  </ul>',
      ].join('\n')
    : ''

  const planIssues = datasheets.plans.filter(plan => !plan.ok)
  const plans = planIssues.length
    ? [
        '  <h3>提取计划说明</h3>',
        '  <ul class="status-list" id="datasheets-plans">',
        ...planIssues.slice(0, 50).map(plan => {
          const badge = ownLookup(DATASHEET_PLAN_BADGES, plan.status) || 'not_evaluated'
          const label = ownLookup(DATASHEET_PLAN_LABELS, plan.status) || plan.status
          return `    <li><code>${escapeHtml(plan.mpn)}</code><span class="badge badge-${badge}">${escapeHtml(label)}</span><span class="detail">${escapeHtml(plan.error || '（无错误信息）')}</span></li>`
        }),
        '  </ul>',
      ].join('\n')
    : ''

  const reasons = datasheets.reasons.length
    ? [
        '  <h3>未评估与限制说明</h3>',
        '  <ul class="status-list" id="datasheets-reasons">',
        ...datasheets.reasons.map(reason => `    <li><span class="detail">${escapeHtml(reason)}</span></li>`),
        '  </ul>',
      ].join('\n')
    : ''

  return [
    '<section class="panel" id="datasheets">',
    '  <h2>数据手册</h2>',
    '  <p class="hint">来源：扫描数据手册目录（datasheets/），按 MPN 把 PDF 匹配到元件。'
      + '本工具只检查 PDF 是否存在、能否匹配以及上游提取计划是否生成，不解析 PDF 引脚表。</p>',
    `  <p class="note${status === 'not_evaluated' || status === 'failed' ? ' note-warn' : ''}">${escapeHtml(statusText)}</p>`,
    '  <p class="note note-warn" id="datasheets-pin-verification">引脚级核对：未评估。'
      + '引脚定义必须由 AI 或人工依据数据手册 PDF 提取后核对；本次运行没有做引脚级验证，'
      + '不能用数据手册覆盖率代替引脚核对结论。</p>',
    '  <dl class="coverage-grid">',
    grid,
    '  </dl>',
    checks,
    matched,
    missing,
    unmatched,
    plans,
    reasons,
    '</section>',
  ].filter(Boolean).join('\n')
}

// 「制造文件」：Gerber/钻孔检查的层数、钻孔数、缺失层、单位与结果。
// 来源固定标注为「Gerber 分析」，复用 kicad-happy 的 analyze_gerbers.py。
function renderManufacturing({ manufacturing }) {
  if (!manufacturing) return ''
  const status = manufacturing.status
  const rows = [
    ['状态', statusBadgeHtml(status)],
    ['分析目录', manufacturing.directory
      ? `<code>${escapeHtml(manufacturing.directory)}</code>`
      : '—'],
    ['Gerber 文件', String(manufacturing.gerberFiles)],
    ['钻孔文件', String(manufacturing.drillFiles)],
    ['铜层数量', String(manufacturing.layerCount)],
    ['钻孔数量', String(manufacturing.drillCount)],
    ['单位', manufacturing.units.length
      ? escapeHtml(manufacturing.units
        .map(unit => ownLookup(UNIT_LABELS, unit) || unit)
        .join('、'))
      : '—'],
    ['板框尺寸', manufacturing.boardDimensions
      ? `${manufacturing.boardDimensions.width} × ${manufacturing.boardDimensions.height} mm`
      : '—'],
  ]
  const grid = rows
    .map(([label, value]) => `    <div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`)
    .join('\n')
  const required = new Set(manufacturing.missingRequired)
  const missing = manufacturing.missingLayers.length
    ? [
        '  <h3>缺失层</h3>',
        '  <ul class="layer-list" id="missing-layers">',
        ...manufacturing.missingLayers.map(layer => {
          const kind = required.has(layer) ? '必需' : '建议'
          const kindClass = required.has(layer) ? 'must_fix' : 'nice_to_have'
          return `    <li><code>${escapeHtml(layer)}</code><span class="badge badge-${kindClass}">${kind}</span></li>`
        }),
        '  </ul>',
      ].join('\n')
    : `  <p class="empty">${escapeHtml(missingLayersEmptyText(status))}</p>`
  const checks = manufacturing.checks.length
    ? [
        '  <h3>制造检查项</h3>',
        '  <table class="status-table" id="manufacturing-checks">',
        '    <thead><tr><th scope="col">检查项</th><th scope="col">状态</th></tr></thead>',
        '    <tbody>',
        ...manufacturing.checks.map(check => {
          const label = ownLookup(MANUFACTURING_CHECK_LABELS, check.key) || check.key
          return `      <tr><th scope="row"><span class="rule-name">${escapeHtml(label)}</span><code>${escapeHtml(check.key)}</code></th><td>${statusBadgeHtml(check.status)}</td></tr>`
        }),
        '    </tbody>',
        '  </table>',
      ].join('\n')
    : ''
  const reasons = manufacturing.reasons.length
    ? [
        '  <h3>未评估原因</h3>',
        '  <ul class="status-list" id="manufacturing-reasons">',
        ...manufacturing.reasons.map(reason => `    <li><span class="detail">${escapeHtml(reason)}</span></li>`),
        '  </ul>',
      ].join('\n')
    : ''
  const findings = manufacturing.findings.length
    ? [
        '  <h3>Gerber 分析结果</h3>',
        '  <ul class="status-list" id="manufacturing-findings">',
        ...manufacturing.findings.map(finding => {
          const group = groupFor(finding.groupKey)
          return `    <li><code>${escapeHtml(finding.ruleId)}</code><span class="source-tag">Gerber 分析</span><span class="badge badge-${group.key}">${escapeHtml(group.label)}</span><span class="rule-name">${escapeHtml(finding.title)}</span><span class="detail">${escapeHtml(finding.evidence)}</span></li>`
        }),
        '  </ul>',
      ].join('\n')
    : `  <p class="empty">${escapeHtml(manufacturingFindingsEmptyText(status))}</p>`

  return [
    '<section class="panel" id="manufacturing">',
    '  <h2>制造文件</h2>',
    '  <p class="hint">来源：Gerber 分析（复用 kicad-happy 的 Gerber/钻孔检查）。</p>',
    '  <dl class="coverage-grid">',
    grid,
    '  </dl>',
    missing,
    checks,
    reasons,
    findings,
    '</section>',
  ].filter(Boolean).join('\n')
}

// 「仿真」：仿真器、逐子电路结果与测试台路径。
// --spice 未启用时也渲染本节，明确「未运行」而不是省略后让人误以为通过。
function renderSpice({ spice }) {
  if (!spice) return ''
  const simulator = spice.simulator
  const statusText = spiceStatusText(spice)
  const warning = spice.status === 'failed'
    || spice.status === 'not_evaluated'
    || spice.status === 'partial'
    || !spice.requested
  const version = simulator
    ? simulator.version
      || simulator.versionNote
      || '版本未知'
    : '—'
  const rows = [
    ['状态', statusBadgeHtml(spice.status)],
    ['仿真器', simulator ? escapeHtml(simulator.name) : '—'],
    ['版本', escapeHtml(version)],
    ['仿真器路径', simulator?.path
      ? `<code>${escapeHtml(simulator.path)}</code>`
      : '—'],
    ['可仿真子电路', String(spice.availableCircuits)],
    ['已提交仿真', String(spice.submittedCircuits)],
    ['未生成结果', spice.missingCircuits > 0
      ? `${spice.missingCircuits} 个候选`
      : '0'],
    ['结果计数', spice.counts.total > 0
      ? `通过 ${spice.counts.pass} / 警告 ${spice.counts.warn} / 失败 ${spice.counts.fail} / 跳过 ${spice.counts.skip}`
      : '—'],
    ['测试台目录', spice.artifacts.workdir
      ? `<code>${escapeHtml(spice.artifacts.workdir)}</code>`
      : '—'],
    ['结果文件', spice.artifacts.index
      ? `<code>${escapeHtml(spice.artifacts.index)}</code>`
      : '—'],
  ]
  const grid = rows
    .map(([label, value]) => `    <div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`)
    .join('\n')

  const checks = Object.keys(spice.checks).length
    ? [
        '  <h3>检查项</h3>',
        '  <table class="status-table" id="spice-checks">',
        '    <thead><tr><th scope="col">检查项</th><th scope="col">状态</th></tr></thead>',
        '    <tbody>',
        ...Object.entries(spice.checks).map(([key, value]) => {
          const label = ownLookup(SPICE_CHECK_LABELS, key) || key
          return `      <tr><th scope="row"><span class="rule-name">${escapeHtml(label)}</span><code>${escapeHtml(key)}</code></th><td>${statusBadgeHtml(value)}</td></tr>`
        }),
        '    </tbody>',
        '  </table>',
      ].join('\n')
    : ''

  const circuits = spice.circuits.length
    ? [
        '  <h3>子电路结果</h3>',
        '  <table class="status-table" id="spice-circuits">',
        '    <thead><tr><th scope="col">类型</th><th scope="col">元件</th><th scope="col">结果</th><th scope="col">测试台</th><th scope="col">说明</th></tr></thead>',
        '    <tbody>',
        ...spice.circuits.map(circuit => {
          const badgeClass = ownLookup(SPICE_STATUS_BADGES, circuit.status) || 'not_evaluated'
          const label = ownLookup(SPICE_STATUS_LABELS, circuit.status) || circuit.status
          const components = circuit.components.length
            ? circuit.components.join('、')
            : circuit.reference || '—'
          const testbench = circuit.testbench
            ? `<code>${escapeHtml(circuit.testbench)}</code>${circuit.testbenchExists ? '' : ' <span class="detail">（文件不存在）</span>'}`
            : '未记录'
          const details = [
            circuit.note,
            formatSpiceMetrics(circuit.expected, '解析值'),
            formatSpiceMetrics(circuit.simulated, '仿真值'),
            formatSpiceMetrics(circuit.delta, '偏差'),
          ].filter(Boolean).join('；')
          const typeText = circuit.typeLabel
            ? `${circuit.typeLabel}（${circuit.type}）`
            : circuit.type
          return `      <tr><th scope="row">${escapeHtml(typeText)}</th><td>${escapeHtml(components)}</td><td><span class="badge badge-${badgeClass}">${escapeHtml(label)}</span></td><td>${testbench}</td><td><span class="detail">${escapeHtml(details || '—')}</span></td></tr>`
        }),
        '    </tbody>',
        '  </table>',
      ].join('\n')
    : `  <h3>子电路结果</h3>\n  <p class="empty">${escapeHtml(spiceCircuitsEmptyText(spice))}</p>`

  const missingCandidates = [
    ...spice.excludedCircuits.map(candidate => ({ ...candidate, kind: '预过滤' })),
    ...spice.unaccountedCircuits.map(candidate => ({ ...candidate, kind: '上游未返回' })),
  ]
  const missing = missingCandidates.length
    ? [
        '  <h3>未生成结果的候选</h3>',
        '  <p class="note note-warn">以下候选已识别，但没有产出测试台或仿真结果；'
          + '不能把它们当作通过。</p>',
        '  <ul class="status-list" id="spice-missing-candidates">',
        ...missingCandidates.slice(0, 50).map(candidate => {
          const typeText = candidate.typeLabel
            ? `${candidate.typeLabel}（${candidate.type}）`
            : candidate.type
          const label = candidate.reference || candidate.components.join('、') || candidate.detector
          return `    <li><code>${escapeHtml(typeText)}</code><span class="rule-name">${escapeHtml(label)}</span><span class="badge badge-not_evaluated">${escapeHtml(candidate.kind)}</span><span class="detail">${escapeHtml(candidate.reason || '未产出仿真结果。')}</span></li>`
        }),
        '  </ul>',
        missingCandidates.length > 50
          ? '  <p class="note">仅展示前 50 个候选，完整列表见 spice.json。</p>'
          : '',
      ].join('\n')
    : spice.missingCircuits > 0
      ? [
          '  <h3>未生成结果的候选</h3>',
          `  <p class="empty">共 ${spice.missingCircuits} 个候选未生成结果；`
            + '本次没有可用于这些候选的仿真结果，原因见上方状态与说明。</p>',
        ].join('\n')
      : ''

  const installHints = !simulator && spice.installHints.length
    ? [
        '  <h3>安装与配置</h3>',
        '  <ul class="status-list" id="spice-install-hints">',
        ...spice.installHints.map(hint => `    <li><span class="detail">${escapeHtml(hint)}</span></li>`),
        '  </ul>',
      ].join('\n')
    : ''

  const reasons = spice.reasons.length
    ? [
        '  <h3>说明与限制</h3>',
        '  <ul class="status-list" id="spice-reasons">',
        ...spice.reasons.map(reason => `    <li><span class="detail">${escapeHtml(reason)}</span></li>`),
        '  </ul>',
      ].join('\n')
    : ''

  const artifacts = spice.artifacts.input || spice.artifacts.report || spice.artifacts.workdir
    ? [
        '  <h3>仿真产物</h3>',
        '  <table class="status-table" id="spice-artifacts">',
        '    <thead><tr><th scope="col">产物</th><th scope="col">路径</th></tr></thead>',
        '    <tbody>',
        `      <tr><th scope="row">分析输入</th><td>${spice.artifacts.input ? `<code>${escapeHtml(spice.artifacts.input)}</code>` : '未生成'}</td></tr>`,
        `      <tr><th scope="row">上游仿真结果</th><td>${spice.artifacts.report ? `<code>${escapeHtml(spice.artifacts.report)}</code>` : '未生成'}</td></tr>`,
        `      <tr><th scope="row">测试台目录</th><td>${spice.artifacts.workdir ? `<code>${escapeHtml(spice.artifacts.workdir)}</code>` : '未生成'}</td></tr>`,
        '    </tbody>',
        '  </table>',
      ].join('\n')
    : ''

  return [
    '<section class="panel" id="spice">',
    '  <h2>仿真</h2>',
    '  <p class="hint">来源：kicad-happy 的 SPICE 仿真（simulate_subcircuits.py）。'
      + '仅当显式传入 --spice 时运行；没有可用仿真器时标记未评估，绝不伪造仿真结果。</p>',
    `  <p class="note${warning ? ' note-warn' : ''}" id="spice-status">${escapeHtml(statusText)}</p>`,
    '  <dl class="coverage-grid">',
    grid,
    '  </dl>',
    checks,
    circuits,
    missing,
    installHints,
    artifacts,
    reasons,
    '</section>',
  ].filter(Boolean).join('\n')
}

const SPICE_CHECK_LABELS = {
  simulator_detection: '仿真器检测',
  testbench_generation: '测试台生成',
  simulation: '仿真执行',
}

function spiceStatusText(spice) {
  if (!spice.requested) {
    return '本次未运行仿真：--spice 为可选开关，默认关闭；未运行不代表通过。'
  }
  // failed 优先于「没有仿真器」：执行失败时 simulator 可能为 null，
  // 不能把失败文案写成未评估（徽标与退出码都是失败）。
  if (spice.status === 'failed') {
    return `仿真执行失败：${spice.reasons.join('；') || '上游仿真没有正常完成。'}`
  }
  if (!spice.simulator) {
    return `未评估：${spice.reasons.join('；') || '未找到可用的 SPICE 仿真器。'}`
  }
  if (spice.status === 'not_evaluated') {
    return `未评估：${spice.reasons.join('；') || '没有子电路产出可用测量结果。'}`
  }
  if (spice.status === 'partial') {
    const missing = spice.missingCircuits > 0
      ? `${spice.missingCircuits} 个候选未生成结果`
      : `${spice.counts.skip}/${spice.counts.total} 个子电路未完成仿真`
    return `部分完成：${missing}；未生成结果或跳过的项不代表通过。`
  }
  if (spice.status === 'found') {
    return `发现 ${spice.findings} 条仿真问题，详见问题清单。`
  }
  const missingNote = spice.missingCircuits > 0
    ? `；另有 ${spice.missingCircuits} 个候选未生成结果，不能视为通过`
    : ''
  return `全部 ${spice.counts.total} 个子电路仿真通过（结果来自 ${spice.simulator.name}`
    + `${spice.simulator.version ? ` ${spice.simulator.version}` : ''}）${missingNote}。`
}

function spiceCircuitsEmptyText(spice) {
  if (!spice.requested) return '本次未运行仿真，因此没有子电路结果。'
  if (spice.status === 'failed') return '仿真执行失败，没有可用的子电路结果。'
  if (!spice.simulator) return '未找到可用仿真器，没有生成任何子电路结果。'
  return '没有可仿真的子电路。'
}

function formatSpiceMetrics(value, label) {
  if (!isPlainObject(value)) return ''
  const parts = Object.entries(value)
    .map(([key, entry]) => {
      if (typeof entry === 'number' && Number.isFinite(entry)) {
        return `${key}=${formatSpiceNumber(entry)}`
      }
      if (typeof entry === 'string' || typeof entry === 'boolean') {
        return `${key}=${entry}`
      }
      return ''
    })
    .filter(Boolean)
  if (parts.length === 0) return ''
  return `${label}：${parts.join(' / ')}`
}

function formatSpiceNumber(value) {
  if (Math.abs(value) >= 1000) return value.toFixed(1)
  if (Math.abs(value) >= 1) return value.toFixed(4)
  return value.toPrecision(6)
}

function statusBadgeHtml(value) {
  return `<span class="badge badge-${statusBadgeClass(value)}">${escapeHtml(statusLabel(value))}</span>`
}

// 未评估/失败时不能写「没有缺失层」，否则容易被读成通过。
function missingLayersEmptyText(status) {
  if (status === 'not_evaluated') return '未评估，无法判断是否缺失层。'
  if (status === 'failed') return '分析失败，无法判断是否缺失层。'
  return '没有缺失层。'
}

function manufacturingFindingsEmptyText(status) {
  if (status === 'not_evaluated') return '未评估，未生成制造文件问题结论。'
  if (status === 'failed') return '分析失败，无法生成制造文件问题结论。'
  return '未发现制造文件问题。'
}

function renderFindings({ findings }) {
  const issues = findings.filter(finding => finding.kind !== 'fact')
  const counts = countFindings(issues)
  const groups = SEVERITY_GROUPS
    .map(group => renderGroup(group, issues.filter(f => f.groupKey === group.key), counts[group.key]))
    .join('\n')
  return [
    '<section class="panel" id="findings">',
    '  <h2>问题清单</h2>',
    `  <p class="hint">共 ${issues.length} 条问题；按严重度分组，组内按规则 ID 排序。实测事实单独列在下一节，不计入问题数量。上游检测器文案已由本地化层翻译成中文；个别无法安全翻译的原文以「（检测器原文）」标注，完整原文见 findings.json 的 source_text。</p>`,
    groups,
    '</section>',
  ].join('\n')
}

// 「实测事实」：焊盘间距、载流、去耦摆放等测量结果，不参与问题计数。
function renderFacts({ findings }) {
  const facts = findings
    .filter(finding => finding.kind === 'fact')
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => compareText(a.finding.ruleId, b.finding.ruleId) || a.index - b.index)
    .map(entry => renderFindingItem(entry.finding, {
      badgeLabel: '实测事实',
      badgeClass: 'fact',
    }))
  if (facts.length === 0) return ''
  return [
    '<section class="panel" id="facts">',
    '  <h2>实测事实</h2>',
    `  <p class="hint">共 ${facts.length} 条测量结果，不计入问题计数；完整数据见 findings.json。</p>`,
    facts.join('\n'),
    '</section>',
  ].join('\n')
}

function renderGroup(group, findings, count) {
  // Array#sort 在 Node 中稳定；显式用下标兜底，保证同一规则 ID 保持输入顺序。
  const sorted = findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => compareText(a.finding.ruleId, b.finding.ruleId) || a.index - b.index)
    .map(entry => entry.finding)
  const items = sorted.length
    ? sorted.map(renderFindingItem).join('\n')
    : '      <p class="empty">没有此类问题。</p>'
  return [
    `    <section class="severity-group" id="group-${group.key}">`,
    `      <div class="group-head"><h3>${escapeHtml(group.label)}</h3><span class="group-count">${count} 条</span></div>`,
    `      <p class="group-desc">${escapeHtml(group.description)}</p>`,
    items,
    '    </section>',
  ].join('\n')
}

function renderFindingItem(finding, options = {}) {
  const group = groupFor(finding.groupKey)
  const badgeLabel = options.badgeLabel ?? group.label
  const badgeClass = options.badgeClass ?? group.key
  const sourceLabel = ownLookup(SOURCE_LABELS, finding.source)
  const sourceTag = sourceLabel
    ? `<span class="source-tag">${escapeHtml(sourceLabel)}</span>`
    : ''
  const lines = [
    '      <article class="finding">',
    `        <div class="finding-meta"><code class="rule-id">${escapeHtml(finding.ruleId)}</code><span class="badge badge-${badgeClass}">${escapeHtml(badgeLabel)}</span>${sourceTag}</div>`,
    `        <h4 class="finding-title">${escapeHtml(finding.title)}</h4>`,
  ]
  if (finding.evidence) {
    lines.push(`        <p class="finding-evidence"><span class="label">证据</span>${escapeHtml(finding.evidence)}</p>`)
  }
  if (finding.description) {
    lines.push(`        <p class="finding-description"><span class="label">说明</span>${escapeHtml(finding.description)}</p>`)
  }
  const locators = []
  if (finding.components) locators.push(`<li><span class="locator-key">元件</span>${escapeHtml(finding.components)}</li>`)
  if (finding.nets) locators.push(`<li><span class="locator-key">网络</span>${escapeHtml(finding.nets)}</li>`)
  if (finding.pins) locators.push(`<li><span class="locator-key">引脚</span>${escapeHtml(finding.pins)}</li>`)
  if (locators.length) lines.push(`        <ul class="locators">${locators.join('')}</ul>`)
  if (finding.recommendation) {
    lines.push(`        <p class="finding-advice"><span class="label">建议</span>${escapeHtml(finding.recommendation)}</p>`)
  }
  lines.push('      </article>')
  return lines.join('\n')
}

function renderCoverage({ coverage, status, overview }) {
  const entries = statusEntries(status)
  const notEvaluated = entries.filter(([, value]) => scalarText(value) === 'not_evaluated')
  const partial = entries.filter(([, value]) => scalarText(value) === 'partial')
  const failed = entries.filter(([, value]) => scalarText(value) === 'failed')
  const skippedChecks = normalizeSkippedChecks(coverage.pcb)
  const skippedSection = skippedChecks.length
    ? [
        '  <h3>DFM 被跳过的子检查</h3>',
        '  <ul class="status-list" id="skipped-checks">',
        ...skippedChecks.map(check => `    <li><code>${escapeHtml(check.rule)}</code><span class="rule-name">${escapeHtml(check.check)}</span><span class="detail">${escapeHtml(check.reason)}</span></li>`),
        '  </ul>',
      ].join('\n')
    : ''
  const netlistLine = overview && overview.schematic.pinsTotal > 0
    ? `  <p class="hint">原理图网表匹配：${overview.schematic.pinsMatched}/${overview.schematic.pinsTotal} 个引脚；`
      + `${overview.schematic.pinsMatched < overview.schematic.pinsTotal ? '匹配不完整，依赖网表的原理图规则已按「未评估」处理。' : '全部引脚已进入网表。'}</p>`
    : ''
  const statusRows = entries.map(([key, value]) => {
    const label = ruleLabel(key)
    return `      <tr><th scope="row"><span class="rule-name">${label ? escapeHtml(label) : '—'}</span><code>${escapeHtml(key)}</code></th><td><span class="badge badge-${statusBadgeClass(value)}">${escapeHtml(statusLabel(value))}</span></td></tr>`
  }).join('\n')
  const statusTable = entries.length
    ? [
        '    <table class="status-table">',
        '      <thead><tr><th scope="col">规则</th><th scope="col">状态</th></tr></thead>',
        '      <tbody>',
        statusRows,
        '      </tbody>',
        '    </table>',
      ].join('\n')
    : '    <p class="empty">没有规则状态信息。</p>'

  return [
    '<section class="panel" id="coverage">',
    '  <h2>数据覆盖与未评估</h2>',
    '  <dl class="coverage-grid">',
    `    <div><dt>文档总数</dt><dd>${coverageValue(coverage.documents)}</dd></div>`,
    `    <div><dt>已解析</dt><dd>${coverageValue(coverage.parsed)}</dd></div>`,
    `    <div><dt>未评估文档</dt><dd>${coverageValue(coverage.notEvaluated)}</dd></div>`,
    '  </dl>',
    netlistLine,
    '  <p class="hint">数据覆盖只反映本次解析的文档范围；未覆盖的文档没有参与规则评估。</p>',
    skippedSection,
    '  <h3>未评估的规则</h3>',
    '  <div id="not-evaluated">',
    renderStatusList(notEvaluated, '没有未评估的规则。', '规则所需输入不足，本次没有结论；此状态不等于「通过」。'),
    '  </div>',
    '  <h3>部分完成的规则</h3>',
    '  <div id="partial-rules">',
    renderStatusList(partial, '没有部分完成的规则。', '规则已运行，但部分子检查因输入缺失被跳过；跳过项不代表通过。'),
    '  </div>',
    '  <h3>执行失败的规则</h3>',
    '  <div id="failed-rules">',
    renderStatusList(failed, '没有执行失败的规则。', '规则执行时出错，本次结论不完整；请检查对应的 DET-ERR 问题与运行环境。'),
    '  </div>',
    '  <h3>规则状态一览</h3>',
    '  <div id="rules-status">',
    statusTable,
    '  </div>',
    '</section>',
  ].join('\n')
}

function renderStatusList(entries, emptyText, detail) {
  if (entries.length === 0) {
    return `    <p class="empty">${escapeHtml(emptyText)}</p>`
  }
  const items = entries.map(([key, value]) => {
    const label = ruleLabel(key)
    return `      <li><code>${escapeHtml(key)}</code>${label ? `<span class="rule-name">${escapeHtml(label)}</span>` : ''}<span class="badge badge-${statusBadgeClass(value)}">${escapeHtml(statusLabel(value))}</span><span class="detail">${escapeHtml(detail)}</span></li>`
  })
  return [
    '      <ul class="status-list">',
    ...items,
    '      </ul>',
  ].join('\n')
}

function renderFigures({ svgs }) {
  const figures = []
  for (const item of svgs) {
    if (!item || typeof item !== 'object') continue
    const svg = typeof item.svg === 'string' ? item.svg.trim() : ''
    if (!svg) continue
    const title = scalarText(item.title) || '设计图'
    if (!isSafeSvg(svg)) {
      figures.push([
        '    <figure class="figure">',
        `      <figcaption>${escapeHtml(title)}</figcaption>`,
        '      <p class="empty">该图包含不受支持的内容（脚本或事件属性），已省略。</p>',
        '    </figure>',
      ].join('\n'))
      continue
    }
    figures.push([
      '    <figure class="figure">',
      `      <figcaption>${escapeHtml(title)}</figcaption>`,
      `      <div class="svg-wrap">${svg}</div>`,
      '    </figure>',
    ].join('\n'))
  }
  if (figures.length === 0) return ''
  return [
    '<section class="panel" id="figures">',
    '  <h2>设计图</h2>',
    figures.join('\n'),
    '</section>',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function countFindings(findings) {
  const counts = { must_fix: 0, should_fix: 0, nice_to_have: 0 }
  for (const finding of findings) counts[finding.groupKey] += 1
  return counts
}

function countStatus(status, wanted) {
  return Object.values(status).filter(value => scalarText(value) === wanted).length
}

function statusEntries(status) {
  return Object.entries(status)
    .filter(([key]) => key !== '')
    .sort(([a], [b]) => compareText(a, b))
}

function statusLabel(value) {
  const raw = scalarText(value)
  return ownLookup(STATUS_LABELS, raw) || (raw ? `未知（${raw}）` : '未知')
}

function statusBadgeClass(value) {
  const raw = scalarText(value)
  return Object.hasOwn(STATUS_LABELS, raw) ? raw : 'unknown'
}

function ruleLabel(key) {
  return ownLookup(RULE_LABELS, key) || ''
}

// 只查自有属性，避免 "__proto__" 等键命中 Object.prototype。
function ownLookup(map, key) {
  return Object.hasOwn(map, key) ? map[key] : ''
}

function coverageValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.trim()) return escapeHtml(value)
  return '—'
}

function scalarText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

// 证据可以是字符串，也可以是对象（如 deep review 的 evidence 块）。
function evidenceText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(evidenceText).filter(Boolean).join('；')
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, entryValue]) => {
        const text = evidenceText(entryValue)
        return text ? `${key}：${text}` : ''
      })
      .filter(Boolean)
      .join('；')
  }
  return ''
}

function listText(values, format) {
  if (Array.isArray(values)) return values.map(format).filter(Boolean).join('、')
  return scalarText(values)
}

function pinText(pin) {
  if (pin && typeof pin === 'object' && !Array.isArray(pin)) {
    const ref = scalarText(pin.component ?? pin.ref ?? pin.reference)
    const number = scalarText(pin.number ?? pin.pin ?? pin.pin_number)
    if (ref && number) return `${ref}.${number}`
    return ref || number || ''
  }
  return scalarText(pin)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isSafeSvg(svg) {
  return !UNSAFE_SVG_PATTERN.test(svg)
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
