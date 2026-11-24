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

function normalizeFinding(finding) {
  const rawEvidence = evidenceText(finding.evidence)
  const description = scalarText(finding.description)
  return {
    ruleId: scalarText(finding.rule_id) || '（无规则 ID）',
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
    + '已按「未评估」处理，本次不能视为通过。</p>'
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

function renderFindings({ findings }) {
  const issues = findings.filter(finding => finding.kind !== 'fact')
  const counts = countFindings(issues)
  const groups = SEVERITY_GROUPS
    .map(group => renderGroup(group, issues.filter(f => f.groupKey === group.key), counts[group.key]))
    .join('\n')
  return [
    '<section class="panel" id="findings">',
    '  <h2>问题清单</h2>',
    `  <p class="hint">共 ${issues.length} 条问题；按严重度分组，组内按规则 ID 排序。实测事实单独列在下一节，不计入问题数量。部分条目的描述来自上游 kicad-happy 检测器原文（英文），本工具按原样呈现，不逐条翻译。</p>`,
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
  const lines = [
    '      <article class="finding">',
    `        <div class="finding-meta"><code class="rule-id">${escapeHtml(finding.ruleId)}</code><span class="badge badge-${badgeClass}">${escapeHtml(badgeLabel)}</span></div>`,
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
