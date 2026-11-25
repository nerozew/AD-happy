// summary.json 的硬上限与压缩策略。
//
// 32KB 是模型读取 summary.json 的硬边界；一旦超限，宁可裁剪覆盖明细
// （完整信息在 report.html / emc.json / findings.json / manifest.json），
// 也不能让整次运行因为写不进 summary 而失败。
export const SUMMARY_LIMIT = 32 * 1024

export function serializeSummary(summary) {
  return `${JSON.stringify(summary, null, 2)}\n`
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function minimalEmc(emc) {
  if (!isPlainObject(emc)) return null
  return {
    requested: emc.requested === true,
    status: emc.status ?? 'not_evaluated',
    standard: emc.standard ?? null,
    available: emc.available === true,
    netlistComplete: emc.netlistComplete ?? null,
    counts: isPlainObject(emc.counts) ? emc.counts : {},
    findings: count(emc.findings),
    facts: count(emc.facts),
    artifact: emc.artifact ?? null,
  }
}

function minimalEmcCoverage(emc) {
  return minimalEmc(emc)
}

function buildMinimalSummary(summary) {
  const coverage = isPlainObject(summary.coverage) ? summary.coverage : {}
  return {
    schemaVersion: summary.schemaVersion ?? 1,
    project: {
      name: summary.project?.name ?? '（未命名工程）',
      folder: summary.project?.folder ?? null,
      path: summary.project?.path ?? null,
      projectPath: summary.project?.projectPath ?? null,
      selectedBoard: summary.project?.selectedBoard ?? null,
      selectedSchematic: summary.project?.selectedSchematic ?? null,
      boards: [],
    },
    generatedAt: summary.generatedAt ?? null,
    status: summary.status ?? null,
    schematic: summary.schematic ?? null,
    pcb: summary.pcb ?? null,
    bom: null,
    datasheets: null,
    spice: null,
    emc: minimalEmc(summary.emc),
    coverage: {
      documents: count(coverage.documents),
      parsed: count(coverage.parsed),
      notEvaluated: count(coverage.notEvaluated),
      netlist: isPlainObject(coverage.netlist) ? coverage.netlist : null,
      emc: minimalEmcCoverage(coverage.emc),
    },
    counts: summary.counts ?? {},
    rules: summary.rules ?? {},
    findings: [],
    findingsOmitted: count(summary.findingsOmitted) + (Array.isArray(summary.findings) ? summary.findings.length : 0),
    report: summary.report ?? null,
    summaryTruncated: true,
  }
}

function buildUltraMinimalSummary(summary) {
  return {
    schemaVersion: summary.schemaVersion ?? 1,
    generatedAt: summary.generatedAt ?? null,
    status: summary.status ?? null,
    counts: summary.counts ?? {},
    emc: minimalEmc(summary.emc),
    coverage: { emc: minimalEmcCoverage(summary.coverage?.emc) },
    report: summary.report ?? null,
    summaryTruncated: true,
  }
}

/**
 * 把 summary 压到 limit 以下。
 *
 * 裁剪顺序：top findings → boards → EMC 类别/规则明细 → EMC 原因与抑制列表
 * → 其他可选阶段覆盖 → 仅保留关键计数。所有阶段都保留 status 与关键计数。
 * 最后仍超限时返回极简信封，不抛异常（写不进 summary 比裁剪更糟）。
 */
export function fitSummaryText(summary, limit = SUMMARY_LIMIT) {
  const target = Number.isFinite(limit) && limit > 0 ? limit : SUMMARY_LIMIT
  let text = serializeSummary(summary)
  const over = () => byteLength(text) >= target
  const refresh = () => {
    text = serializeSummary(summary)
  }

  // 1. top findings 逐条丢弃。
  while (over() && Array.isArray(summary.findings) && summary.findings.length > 0) {
    summary.findings.pop()
    summary.findingsOmitted = count(summary.findingsOmitted) + 1
    refresh()
  }

  // 2. boards 先截到 50，再清空。
  if (over() && Array.isArray(summary.project?.boards) && summary.project.boards.length > 50) {
    summary.project.boardsTruncated = summary.project.boards.length - 50
    summary.project.boards = summary.project.boards.slice(0, 50)
    refresh()
  }
  if (over() && Array.isArray(summary.project?.boards) && summary.project.boards.length > 0) {
    summary.project.boardsTruncated = (summary.project.boardsTruncated ?? 0) + summary.project.boards.length
    summary.project.boards = []
    refresh()
  }

  // 3. EMC 覆盖明细：先保 10 条规则 ID + 计数，再只保计数。
  if (over() && isPlainObject(summary.emc)) {
    const rules = Array.isArray(summary.emc.notEvaluatedRules) ? summary.emc.notEvaluatedRules : []
    if (rules.length > 10) {
      summary.emc.notEvaluatedRulesOmitted = (summary.emc.notEvaluatedRulesOmitted ?? 0) + rules.length - 10
      summary.emc.notEvaluatedRules = rules.slice(0, 10)
      refresh()
    }
  }
  if (over() && isPlainObject(summary.emc) && Array.isArray(summary.emc.categories)) {
    summary.emc.categories = summary.emc.categories.map(category => ({
      key: category?.key ?? '',
      status: category?.status ?? 'not_evaluated',
      evaluated: count(category?.evaluated ?? category?.evaluatedRules?.length),
      partial: count(category?.partial ?? category?.partiallyEvaluatedRules?.length),
      notEvaluated: count(category?.notEvaluated ?? category?.notEvaluatedRules?.length),
    }))
    summary.emc.categoriesCompacted = true
    refresh()
  }
  if (over() && isPlainObject(summary.emc)) {
    const remaining = Array.isArray(summary.emc.notEvaluatedRules)
      ? summary.emc.notEvaluatedRules.length
      : 0
    summary.emc.notEvaluatedRules = []
    summary.emc.notEvaluatedRulesOmitted = count(summary.emc.notEvaluatedRulesOmitted) + remaining
    summary.emc.reasons = []
    summary.emc.suppressedFindings = []
    summary.emc.unsupportedRules = []
    summary.emc.script = null
    refresh()
  }

  // 4. EMC 只保留关键计数。
  if (over() && isPlainObject(summary.emc)) {
    summary.emc = minimalEmc(summary.emc)
    refresh()
  }

  // 5. coverage.emc 只保留关键计数。
  if (over() && isPlainObject(summary.coverage?.emc)) {
    summary.coverage.emc = minimalEmcCoverage(summary.coverage.emc)
    refresh()
  }

  // 6. 其他可选阶段的覆盖明细（Gerber/BOM/数据手册/SPICE/AD 原生）超限时也让位。
  if (over() && isPlainObject(summary.coverage)) {
    for (const key of ['gerber', 'bom', 'datasheets', 'spice', 'native', 'pcb', 'crossCheck']) {
      if (key in summary.coverage) {
        const value = summary.coverage[key]
        summary.coverage[key] = isPlainObject(value)
          ? { status: value.status ?? null }
          : null
      }
    }
    if ('native' in summary) summary.native = null
    refresh()
  }

  // 7. 顶层可选阶段概览也丢明细，保留 emc 计数与 rules。
  if (over()) {
    summary.bom = null
    summary.datasheets = null
    summary.spice = null
    summary.native = null
    if (isPlainObject(summary.coverage)) {
      summary.coverage = {
        documents: count(summary.coverage.documents),
        parsed: count(summary.coverage.parsed),
        notEvaluated: count(summary.coverage.notEvaluated),
        netlist: isPlainObject(summary.coverage.netlist) ? summary.coverage.netlist : null,
        emc: minimalEmcCoverage(summary.coverage.emc),
      }
    }
    summary.findings = []
    summary.project = { ...(summary.project ?? {}), boards: [] }
    refresh()
  }

  if (!over()) return text

  // 8. 最后兜底：极简信封；仍保留 status / counts / emc 关键计数。
  text = serializeSummary(buildMinimalSummary(summary))
  if (byteLength(text) < target) return text
  return serializeSummary(buildUltraMinimalSummary(summary))
}
