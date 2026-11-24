// BOM（物料清单）构建、检查与采购清单导出。
//
// 数据来源：
// - snapshot.schematic.components：位号、注释/值、封装，以及 Altium 元件参数
//   （RECORD=41，见 sch.mjs 的 parameters 字段）；
// - PcbSnapshot.components：位号、注释/值、封装与显式 MPN 字段（若 PcbDoc 中有）。
//
// 全部检查离线完成，不联网、不猜测元件型号。MPN 只认元件参数中明确存在的
// 型号参数（Part Number / MPN / Manufacturer Part Number 等）；找不到任何
// 型号数据时，缺 MPN 检查标记为 not_evaluated，而不是给出「全部通过」。
import { writeFileSync } from 'node:fs'

// 型号参数的归一化名称（小写、去掉空格与标点）。按优先级排列。
const MPN_PARAMETER_NAMES = [
  'mpn',
  'manufacturerpartnumber',
  'manufacturerpartno',
  'mfrpartnumber',
  'mfrpartno',
  'manufacturerpn',
  'partnumber',
  'partno',
]

// 带进 BOM 行的附加参数。只保留对采购/核对有用的字段，避免把 Altium
// 的内部字段（PartId、Price、Supplier 链接等）全部塞进产物。
const EXTRA_PARAMETERS = [
  { key: 'manufacturer', aliases: ['manufacturer', 'mfr', '制造商', '厂商'] },
  { key: 'supplier', aliases: ['supplier1', 'supplier', '供应商1', '供应商'] },
  {
    key: 'supplierPartNumber',
    aliases: ['supplierpartnumber1', 'supplierpartnumber', '供应商料号', '供应商编号'],
  },
  { key: 'description', aliases: ['description', 'desc', '描述', '说明'] },
  { key: 'package', aliases: ['packagecase', 'devicepackage', '封装', '封装形式'] },
  { key: 'status', aliases: ['partstatus', 'lifecyclestatus', '状态'] },
]

// BOM CSV 列（中文表头，供人工与 Excel 查看）。
const BOM_HEADER = [
  '位号',
  '数量',
  '值',
  '封装',
  '型号(MPN)',
  '来源',
  '制造商',
  '供应商',
  '供应商料号',
  '描述',
]

// 采购清单固定列；不做任何联网查询，「建议渠道」留空。
const PROCUREMENT_HEADER = ['位号', '数量', '型号(MPN)', '封装', '值', '建议渠道']

const SOURCE_LABELS = {
  schematic: '原理图',
  pcb: 'PCB',
  both: '双方',
}

/**
 * 从解析数据构建 BOM。一个位号一行；重复位号合并为一行并计入 duplicate。
 *
 * @param {object} snapshot snapshot.json 内容（至少包含 schematic.components）
 * @param {object} [pcb] PcbSnapshot；省略时尝试使用 snapshot.pcb
 * @returns {{
 *   rows: object[],
 *   coverage: object,
 *   findings: object[]
 * }}
 */
export function buildBom(snapshot, pcb) {
  const schematicComponents = arrayOfObjects(snapshot?.schematic?.components)
  const pcbSnapshot = pcb ?? snapshot?.pcb ?? null
  const pcbComponents = arrayOfObjects(pcbSnapshot?.components)

  const schematicState = groupByReference(schematicComponents, readSchematicComponent)
  const pcbState = groupByReference(pcbComponents, readPcbComponent)

  const references = [...new Set([
    ...schematicState.groups.keys(),
    ...pcbState.groups.keys(),
  ])].sort(naturalCompare)

  const rows = references.map(key => {
    const schematicEntries = schematicState.groups.get(key) ?? []
    const pcbEntries = pcbState.groups.get(key) ?? []
    const schematic = schematicEntries[0] ?? null
    const pcbEntry = pcbEntries[0] ?? null
    const source = schematic && pcbEntry ? 'both' : schematic ? 'schematic' : 'pcb'
    return {
      reference: firstText(schematic?.reference, pcbEntry?.reference, key),
      value: firstText(schematic?.value, pcbEntry?.value),
      footprint: firstText(schematic?.footprint, pcbEntry?.footprint),
      mpn: firstText(schematic?.mpn, pcbEntry?.mpn),
      quantity: Math.max(schematicEntries.length, pcbEntries.length, 1),
      source,
      extraParameters: {
        ...(pcbEntry?.extraParameters ?? {}),
        ...(schematic?.extraParameters ?? {}),
      },
    }
  })

  const hasMpnSource = schematicState.hasMpnSource || pcbState.hasMpnSource
  const missingMpn = rows.filter(row => !row.mpn)
  const missingFootprint = rows.filter(row => !row.footprint)

  const duplicates = []
  for (const key of references) {
    const schematicCount = schematicState.groups.get(key)?.length ?? 0
    const pcbCount = pcbState.groups.get(key)?.length ?? 0
    if (schematicCount > 1 || pcbCount > 1) {
      duplicates.push({
        reference: rows.find(row => normalizeReference(row.reference) === key)?.reference ?? key,
        schematicCount,
        pcbCount,
      })
    }
  }

  const schematicOnly = references
    .filter(key => schematicState.groups.has(key) && !pcbState.groups.has(key))
    .map(key => referenceOf(schematicState, key))
  const pcbOnly = references
    .filter(key => pcbState.groups.has(key) && !schematicState.groups.has(key))
    .map(key => referenceOf(pcbState, key))

  const componentsWithoutReference = schematicState.missingReferenceCount
    + pcbState.missingReferenceCount
  // 两侧都有位号时才做原理图↔PCB 比对；缺一侧时不能把「全都不一致」当结论。
  const canCompare = rows.length > 0
    && schematicState.groups.size > 0
    && pcbState.groups.size > 0

  const checks = {
    missing_mpn: rows.length === 0
      ? 'not_evaluated'
      : !hasMpnSource ? 'not_evaluated' : missingMpn.length > 0 ? 'found' : 'pass',
    missing_footprint: rows.length === 0
      ? 'not_evaluated'
      : missingFootprint.length > 0 ? 'found' : 'pass',
    duplicate_designator: rows.length === 0
      ? 'not_evaluated'
      : duplicates.length > 0 ? 'found' : 'pass',
    schematic_pcb_match: canCompare
      ? (schematicOnly.length + pcbOnly.length > 0 ? 'found' : 'pass')
      : 'not_evaluated',
  }

  const reasons = []
  if (rows.length === 0) {
    reasons.push('没有可检查的元件：原理图与 PCB 都没有解析到带位号的元件。')
  }
  if (checks.missing_mpn === 'not_evaluated' && rows.length > 0) {
    reasons.push('工程元件参数中没有可用的制造商型号（MPN），无法判断哪些元件缺型号。')
  }
  if (checks.schematic_pcb_match === 'not_evaluated' && rows.length > 0) {
    if (schematicState.groups.size === 0) {
      reasons.push(schematicState.missingReferenceCount > 0
        ? '原理图元件没有可用位号，无法与 PCB 比对。'
        : '未解析到原理图元件，无法与 PCB 比对。')
    } else if (pcbState.groups.size === 0) {
      reasons.push(pcbState.missingReferenceCount > 0
        ? 'PCB 元件没有可用位号，无法与原理图比对。'
        : '未解析到 PCB 元件，无法与原理图比对。')
    }
  }
  if (componentsWithoutReference > 0) {
    reasons.push(`有 ${componentsWithoutReference} 个元件没有位号，未纳入 BOM。`)
  }

  const findings = buildBomFindings({
    rows,
    missingMpn,
    missingMpnEvaluated: checks.missing_mpn !== 'not_evaluated',
    missingFootprint,
    duplicates,
    schematicOnly,
    pcbOnly,
    canCompare,
  })

  const coverage = {
    status: 'not_evaluated',
    rows: rows.length,
    components: rows.length,
    schematicComponents: schematicComponents.length,
    pcbComponents: pcbComponents.length,
    componentsWithoutReference,
    rowsWithMpn: rows.filter(row => row.mpn).length,
    rowsMissingMpn: missingMpn.length,
    rowsWithFootprint: rows.filter(row => row.footprint).length,
    rowsMissingFootprint: missingFootprint.length,
    duplicateDesignators: duplicates.map(duplicate => duplicate.reference),
    schematicOnly,
    pcbOnly,
    checks,
    reasons,
    findings: findings.length,
    imported: null,
  }
  coverage.status = recomputeBomStatus(coverage)

  return { rows, coverage, findings }
}

/**
 * 重新计算 BOM 总状态。导入 BOM 后追加 imported_diff 检查时复用。
 * 规则：failed > 未评估/部分完成 > found > pass；未评估不等于通过。
 *
 * @param {object} coverage
 * @returns {'pass'|'found'|'partial'|'not_evaluated'|'failed'}
 */
export function recomputeBomStatus(coverage) {
  const checks = coverage?.checks && typeof coverage.checks === 'object'
    ? Object.values(coverage.checks)
    : []
  if (checks.includes('failed')) return 'failed'
  if (!(coverage?.rows > 0)) return 'not_evaluated'
  if (checks.length === 0) return 'not_evaluated'
  if (checks.every(value => value === 'not_evaluated')) return 'not_evaluated'
  const hasFound = checks.includes('found')
  const hasGap = checks.includes('not_evaluated')
  const hasUnreferenced = (coverage.componentsWithoutReference ?? 0) > 0
  if (hasFound) return hasGap || hasUnreferenced ? 'partial' : 'found'
  // 没有发现问题、但关键检查（通常是缺 MPN）因数据不足无法评估时，
  // 整体状态用 not_evaluated 表达「无法下结论」，而不是 partial。
  if (hasGap) return 'not_evaluated'
  if (hasUnreferenced) return 'partial'
  return 'pass'
}

/**
 * 导入 Altium 导出的 BOM CSV。表头大小写不敏感，支持中文表头与常见英文列名。
 *
 * 支持的列（至少需要 Designator/位号）：
 * Designator、Comment/Value、Footprint、Quantity、Description、
 * MPN/Manufacturer Part Number、Supplier Part Number、位号、注释、值、封装、数量、描述、型号。
 *
 * @param {string} text CSV 文本（可带 UTF-8 BOM）
 * @returns {{
 *   rows: Array<{reference: string, value: string, footprint: string, mpn: string, quantity: number, description: string, supplierPartNumber: string}>,
 *   coverage: object
 * }}
 */
export function importBomCsv(text) {
  const content = String(text ?? '').replace(/^﻿/u, '')
  if (!content.trim()) throw new Error('BOM 文件为空')
  const delimiter = detectDelimiter(content)
  const records = parseCsv(content, delimiter).filter(row => row.some(cell => cell.trim() !== ''))
  const headerIndex = records
    .slice(0, 30)
    .findIndex(row => row.some(cell => mapColumn(cell) === 'designator'))
  if (headerIndex === -1) {
    throw new Error('BOM 文件没有 Designator/位号 列')
  }

  const header = records[headerIndex]
  const columns = Object.create(null)
  for (const [index, cell] of header.entries()) {
    const mapped = mapColumn(cell)
    if (mapped && columns[mapped] === undefined) columns[mapped] = index
  }

  const rows = []
  for (const cells of records.slice(headerIndex + 1)) {
    const designatorCell = cellAt(cells, columns.designator)
    const designators = splitDesignators(designatorCell)
    if (designators.length === 0) continue
    const value = cellAt(cells, columns.value).trim()
    const footprint = cellAt(cells, columns.footprint).trim()
    const quantity = readQuantity(cellAt(cells, columns.quantity))
    const description = cellAt(cells, columns.description).trim()
    const supplierPartNumber = cellAt(cells, columns.supplierPartNumber).trim()
    // 「Supplier Part Number」是任务要求支持的列；在缺少独立 MPN 列时作为
    // 型号列的回退，但它仍是供应商料号，行内单独保留，避免混淆来源。
    const mpn = firstText(cellAt(cells, columns.mpn), supplierPartNumber)
    for (const reference of designators) {
      rows.push({
        reference,
        value,
        footprint,
        mpn,
        quantity,
        description,
        supplierPartNumber,
      })
    }
  }

  const duplicateDesignators = duplicateReferences(rows.map(row => row.reference))
  const missingColumns = ['value', 'footprint', 'quantity', 'description']
    .filter(key => columns[key] === undefined)
  // Supplier Part Number 可作为 MPN 的回退，两者都没有才算缺少型号列。
  if (columns.mpn === undefined && columns.supplierPartNumber === undefined) {
    missingColumns.push('mpn')
  }

  return {
    rows,
    coverage: {
      rows: rows.length,
      rawRows: records.length - headerIndex - 1,
      delimiter: delimiter === '\t' ? 'tab' : delimiter,
      columns: Object.keys(columns),
      header,
      missingColumns,
      duplicateDesignators,
    },
  }
}

/**
 * 把导入的 BOM 与工程解析结果比对。缺位号/多位号都产出 finding。
 * 工程侧没有元件时返回 not_evaluated，不把「导入文件里有内容」当成通过。
 *
 * @param {object[]} projectRows buildBom 产出的行
 * @param {object[]} importedRows importBomCsv 产出的行
 * @returns {{ findings: object[], coverage: object }}
 */
export function diffBom(projectRows, importedRows) {
  const project = Array.isArray(projectRows) ? projectRows : []
  const imported = Array.isArray(importedRows) ? importedRows : []

  const projectByKey = new Map()
  for (const row of project) {
    const key = normalizeReference(row.reference)
    if (key && !projectByKey.has(key)) projectByKey.set(key, row)
  }
  const importedByKey = new Map()
  const importedCounts = new Map()
  for (const row of imported) {
    const key = normalizeReference(row.reference)
    if (!key) continue
    importedCounts.set(key, (importedCounts.get(key) ?? 0) + 1)
    if (!importedByKey.has(key)) importedByKey.set(key, row)
  }

  const missingFromBomKeys = [...projectByKey.keys()]
    .filter(key => !importedByKey.has(key))
    .sort(naturalCompare)
  const extraInBomKeys = [...importedByKey.keys()]
    .filter(key => !projectByKey.has(key))
    .sort(naturalCompare)
  const missingFromBom = missingFromBomKeys.map(key => projectByKey.get(key).reference)
  const extraInBom = extraInBomKeys.map(key => importedByKey.get(key).reference)

  const findings = []
  // 工程侧没有元件时不做差异结论：无法区分「BOM 为空」与「工程解析缺失」。
  if (project.length > 0) {
    if (missingFromBom.length > 0) {
      findings.push(bmFinding({
        ruleId: 'BM-005',
        severity: 'warning',
        title: `导入的 BOM 缺少 ${missingFromBom.length} 个工程元件`,
        evidence: `导入文件缺少以下工程位号：${listReferences(missingFromBom)}。`,
        recommendation: '确认 BOM 导出范围与变体设置，确保覆盖工程中的全部元件。',
        components: missingFromBom,
      }))
    }
    if (extraInBom.length > 0) {
      findings.push(bmFinding({
        ruleId: 'BM-005',
        severity: 'warning',
        title: `导入的 BOM 多出 ${extraInBom.length} 个工程外元件`,
        evidence: `导入文件包含工程中不存在的位号：${listReferences(extraInBom)}。`,
        recommendation: '确认 BOM 是否来自其他工程或变体，避免采购不需要的元件。',
        components: extraInBom,
      }))
    }
    for (const entry of importedCounts) {
      const [key, count] = entry
      if (count <= 1) continue
      const reference = importedByKey.get(key)?.reference ?? key
      findings.push(bmFinding({
        ruleId: 'BM-003',
        severity: 'error',
        title: `导入的 BOM 位号重复：${reference}`,
        evidence: `导入文件中位号 ${reference} 出现 ${count} 次。`,
        recommendation: '合并重复行并确认数量，避免重复采购。',
        components: [reference],
      }))
    }
  }

  const status = project.length === 0
    ? 'not_evaluated'
    : findings.length > 0 ? 'found' : 'pass'

  return {
    findings,
    coverage: {
      status,
      rows: imported.length,
      missingFromBom,
      extraInBom,
      duplicateDesignators: duplicateReferences(imported.map(row => row.reference)),
    },
  }
}

/**
 * 导出工程 BOM CSV（中文表头）。
 *
 * @param {object[]} rows
 * @param {string} outPath
 * @returns {string} outPath
 */
export function exportBom(rows, outPath) {
  const list = Array.isArray(rows) ? rows : []
  const lines = [BOM_HEADER.map(csvCell).join(',')]
  for (const row of [...list].sort(compareRows)) {
    const extra = row.extraParameters ?? {}
    lines.push([
      row.reference,
      String(row.quantity ?? 1),
      row.value,
      row.footprint,
      row.mpn,
      SOURCE_LABELS[row.source] ?? row.source ?? '',
      extraValue(extra, 'manufacturer'),
      extraValue(extra, 'supplier'),
      extraValue(extra, 'supplierPartNumber'),
      extraValue(extra, 'description'),
    ].map(csvCell).join(','))
  }
  writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8')
  return outPath
}

/**
 * 导出采购清单 CSV：位号、数量、型号(MPN)、封装、值、建议渠道。
 * 不联网、不推测分销商；「建议渠道」一律留空。
 *
 * @param {object[]} rows
 * @param {string} outPath
 * @returns {string} outPath
 */
export function exportProcurement(rows, outPath) {
  const list = Array.isArray(rows) ? rows : []
  const lines = [PROCUREMENT_HEADER.map(csvCell).join(',')]
  for (const row of [...list].sort(compareRows)) {
    lines.push([
      row.reference,
      String(row.quantity ?? 1),
      row.mpn,
      row.footprint,
      row.value,
      '',
    ].map(csvCell).join(','))
  }
  writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8')
  return outPath
}

// ---------------------------------------------------------------------------
// 行读取
// ---------------------------------------------------------------------------

function readSchematicComponent(component) {
  const parameters = normalizeParameterMap(component?.parameters ?? component?.properties)
  return {
    reference: text(component?.reference),
    value: firstText(component?.value, component?.comment),
    footprint: text(component?.footprint),
    mpn: firstText(component?.mpn, selectMpn(parameters)),
    extraParameters: selectExtraParameters(parameters),
  }
}

function readPcbComponent(component) {
  const parameters = normalizeParameterMap(component?.parameters ?? component?.properties)
  const extraParameters = selectExtraParameters(parameters)
  if (!extraParameters.description) {
    const description = firstText(component?.description, component?.sourceDescription)
    if (description) extraParameters.description = description
  }
  return {
    reference: firstText(component?.reference, component?.designator),
    value: firstText(component?.value, component?.comment),
    footprint: text(component?.footprint),
    mpn: firstText(component?.mpn, selectMpn(parameters)),
    extraParameters,
  }
}

function normalizeParameterMap(value) {
  const parameters = Object.create(null)
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue
      const name = text(entry.name ?? entry.key)
      const content = text(entry.text ?? entry.value)
      if (name && content && parameters[name] === undefined) parameters[name] = content
    }
    return parameters
  }
  if (!value || typeof value !== 'object') return parameters
  for (const [name, content] of Object.entries(value)) {
    const key = text(name)
    const valueText = text(content)
    if (key && valueText && parameters[key] === undefined) parameters[key] = valueText
  }
  return parameters
}

function selectMpn(parameters) {
  let best = ''
  let bestRank = Number.POSITIVE_INFINITY
  for (const [name, value] of Object.entries(parameters)) {
    // 真实工程常用带序号的参数名（Manufacturer Part Number 1、MPN1 等）；
    // 归一化后去掉结尾数字再匹配别名。
    const normalized = normalizeKey(name).replace(/\d+$/u, '')
    const rank = MPN_PARAMETER_NAMES.indexOf(normalized)
    if (rank === -1) continue
    if (rank < bestRank && value) {
      best = value
      bestRank = rank
    }
  }
  return best
}

function selectExtraParameters(parameters) {
  const result = Object.create(null)
  for (const spec of EXTRA_PARAMETERS) {
    const value = findParameter(parameters, spec.aliases)
    if (value) result[spec.key] = value
  }
  return result
}

function findParameter(parameters, aliases) {
  const normalizedAliases = new Set(aliases.map(normalizeKey))
  for (const [name, value] of Object.entries(parameters)) {
    if (normalizedAliases.has(normalizeKey(name)) && value) return value
  }
  return ''
}

function groupByReference(components, reader) {
  const groups = new Map()
  let missingReferenceCount = 0
  let hasMpnSource = false
  for (const component of components) {
    const item = reader(component)
    if (item.mpn) hasMpnSource = true
    const key = normalizeReference(item.reference)
    if (!key) {
      missingReferenceCount += 1
      continue
    }
    const entries = groups.get(key)
    if (entries) entries.push(item)
    else groups.set(key, [item])
  }
  return { groups, missingReferenceCount, hasMpnSource }
}

function referenceOf(state, key) {
  return state.groups.get(key)?.[0]?.reference ?? key
}

// ---------------------------------------------------------------------------
// findings
// ---------------------------------------------------------------------------

function buildBomFindings(context) {
  const {
    rows,
    missingMpn,
    missingMpnEvaluated,
    missingFootprint,
    duplicates,
    schematicOnly,
    pcbOnly,
    canCompare,
  } = context
  const findings = []

  if (rows.length > 0 && missingMpnEvaluated && missingMpn.length > 0) {
    findings.push(bmFinding({
      ruleId: 'BM-001',
      severity: 'warning',
      title: `缺少 MPN：${missingMpn.length} 个元件`,
      evidence: `以下位号在工程数据中没有可用的制造商型号（MPN）：${listReferences(missingMpn.map(row => row.reference))}。`,
      recommendation: '在 Altium 元件参数中补充型号（Part Number/MPN），或导入已有 BOM 与工程数据比对。',
      components: missingMpn.map(row => row.reference),
    }))
  }
  if (rows.length > 0 && missingFootprint.length > 0) {
    findings.push(bmFinding({
      ruleId: 'BM-002',
      severity: 'error',
      title: `缺少封装：${missingFootprint.length} 个元件`,
      evidence: `以下位号没有解析到 PCB 封装：${listReferences(missingFootprint.map(row => row.reference))}。`,
      recommendation: '在原理图或 PCB 中为这些元件指定封装，并确认库链接有效。',
      components: missingFootprint.map(row => row.reference),
    }))
  }
  for (const duplicate of duplicates) {
    findings.push(bmFinding({
      ruleId: 'BM-003',
      severity: 'error',
      title: `位号重复：${duplicate.reference}`,
      evidence: `位号 ${duplicate.reference} 在原理图中出现 ${duplicate.schematicCount} 次，在 PCB 中出现 ${duplicate.pcbCount} 次。`,
      recommendation: '为重复位号的元件分配唯一位号，避免装配与采购混淆。',
      components: [duplicate.reference],
    }))
  }
  if (canCompare) {
    for (const reference of schematicOnly) {
      findings.push(bmFinding({
        ruleId: 'BM-004',
        severity: 'error',
        title: `原理图有、PCB 未找到：${reference}`,
        evidence: `位号 ${reference} 只出现在原理图中，PCB 元件清单中没有该位号。`,
        recommendation: '在 Altium 中同步原理图与 PCB（更新 PCB 或反向标注）。',
        components: [reference],
      }))
    }
    for (const reference of pcbOnly) {
      findings.push(bmFinding({
        ruleId: 'BM-004',
        severity: 'error',
        title: `PCB 有、原理图未找到：${reference}`,
        evidence: `位号 ${reference} 只出现在 PCB 中，原理图元件清单中没有该位号。`,
        recommendation: '在 Altium 中同步原理图与 PCB（更新 PCB 或反向标注）。',
        components: [reference],
      }))
    }
  }

  return findings.sort((a, b) => (
    compareText(a.rule_id, b.rule_id)
    || naturalCompare(a.components[0] ?? '', b.components[0] ?? '')
  ))
}

function bmFinding({ ruleId, severity, title, evidence, recommendation, components }) {
  return {
    detector: 'bom',
    rule_id: ruleId,
    category: 'bom',
    kind: 'issue',
    severity,
    confidence: 'deterministic',
    evidence_source: 'file',
    source: 'bom',
    title,
    summary: title,
    evidence,
    recommendation,
    // 组件列表只保留前 50 个，避免大工程把 summary.json 撑爆；完整数量写在证据里。
    components: Array.isArray(components) ? components.slice(0, 50) : [],
    nets: [],
    pins: [],
  }
}

/**
 * BOM 分析失败时使用的 finding（导入解析失败、写文件失败等）。
 * @param {string} message
 * @returns {object}
 */
export function bomErrorFinding(message) {
  const detail = text(message) || '未知错误'
  return {
    detector: 'bom',
    rule_id: 'BM-ERR',
    category: 'analysis_error',
    kind: 'issue',
    severity: 'error',
    confidence: 'deterministic',
    evidence_source: 'file',
    source: 'bom',
    title: 'BOM 分析失败',
    summary: 'BOM 分析失败',
    evidence: detail,
    recommendation: '检查 BOM 文件格式（至少需要 Designator/位号 列）与输出目录权限后重试。',
    components: [],
    nets: [],
    pins: [],
  }
}

/**
 * 按规则 ID + 元件列表去重，避免工程侧与导入侧重复报告同一位号。
 * @param {object[]} findings
 * @returns {object[]}
 */
export function dedupeBomFindings(findings) {
  const seen = new Set()
  const result = []
  for (const finding of findings) {
    if (!finding || typeof finding !== 'object') continue
    const key = `${text(finding.rule_id)}|${(finding.components ?? []).map(text).join('|')}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(finding)
  }
  return result
}

// ---------------------------------------------------------------------------
// CSV 导入
// ---------------------------------------------------------------------------

// 表头归一化：小写、去掉空白/标点/括号，保留中文字符。
function normalizeHeader(value) {
  return String(value ?? '')
    .replace(/^﻿/u, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-./\\()（）[\]【】]/gu, '')
}

const COLUMN_ALIASES = {
  designator: [
    'designator', 'designators', 'ref', 'refs', 'reference', 'references',
    '位号', '元件位号', '位号列表',
  ],
  value: ['comment', 'comments', 'value', '注释', '值', '元件值', '规格'],
  footprint: ['footprint', 'footprints', 'package', '封装', '封装形式'],
  quantity: ['quantity', 'qty', 'count', '数量'],
  description: ['description', 'desc', '描述', '说明'],
  mpn: [
    'mpn', 'manufacturerpartnumber', 'manufacturerpartnumber1',
    'mfrpartnumber', 'mfrpartnumber1', 'partnumber', 'partno',
    '型号', '型号mpn', '制造商料号', '物料编号',
  ],
  supplierPartNumber: [
    'supplierpartnumber', 'supplierpartnumber1', 'supplierpartno',
    'supplierpn', '供应商料号', '供应商编号',
  ],
}

const COLUMN_LOOKUP = (() => {
  const lookup = new Map()
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) lookup.set(normalizeHeader(alias), key)
  }
  return lookup
})()

function mapColumn(header) {
  return COLUMN_LOOKUP.get(normalizeHeader(header)) ?? ''
}

function detectDelimiter(content) {
  const lines = content.split(/\r?\n/u).slice(0, 30)
  for (const line of lines) {
    if (!line.trim()) continue
    let best = ','
    let bestScore = 0
    // 不靠字面量 "designator" / "位号" 判断表头：Ref/Reference 等别名也要覆盖。
    // 对每个候选分隔符实际拆一次，能映射出最多已知列的胜出。
    for (const candidate of [',', ';', '\t']) {
      const cells = parseCsv(line, candidate)[0] ?? []
      const score = cells.filter(cell => mapColumn(cell) !== '').length
      if (score > bestScore) {
        best = candidate
        bestScore = score
      }
    }
    if (bestScore > 0) return best
  }
  return ','
}

function parseCsv(content, delimiter) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]
    if (inQuotes) {
      if (char === '"') {
        if (content[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      inQuotes = true
    } else if (char === delimiter) {
      row.push(field)
      field = ''
    } else if (char === '\r') {
      if (content[index + 1] === '\n') index += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function cellAt(cells, index) {
  if (index === undefined || index === null || index < 0) return ''
  return text(cells[index])
}

function splitDesignators(value) {
  return text(value)
    .split(/[\s,;，；、]+/u)
    .map(item => item.trim())
    .filter(Boolean)
}

function readQuantity(value) {
  const parsed = Number.parseInt(text(value).replace(/[^\d-]/gu, ''), 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1
}

function duplicateReferences(references) {
  const counts = new Map()
  for (const reference of references) {
    const key = normalizeReference(reference)
    if (!key) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key)
    .sort(naturalCompare)
}

// ---------------------------------------------------------------------------
// 输出辅助
// ---------------------------------------------------------------------------

function compareRows(a, b) {
  return naturalCompare(a?.reference ?? '', b?.reference ?? '')
}

function extraValue(extra, key) {
  return text(extra?.[key])
}

function csvCell(value) {
  const content = text(value)
  if (!/[",\r\n]/u.test(content)) return content
  return `"${content.replaceAll('"', '""')}"`
}

function listReferences(references, limit = 40) {
  const list = references.map(text).filter(Boolean)
  if (list.length === 0) return '（无）'
  const shown = list.slice(0, limit).join('、')
  return list.length > limit ? `${shown} 等 ${list.length} 个` : shown
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function normalizeReference(value) {
  return text(value).trim().toUpperCase()
}

function normalizeKey(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9一-鿿]/gu, '')
}

function naturalCompare(a, b) {
  const left = String(a ?? '')
  const right = String(b ?? '')
  const leftParts = left.match(/\d+|\D+/gu) ?? []
  const rightParts = right.match(/\d+|\D+/gu) ?? []
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index]
    const rightPart = rightParts[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const leftNumber = /^\d+$/u.test(leftPart)
    const rightNumber = /^\d+$/u.test(rightPart)
    if (leftNumber && rightNumber) {
      const difference = Number(leftPart) - Number(rightPart)
      if (difference !== 0) return difference
    } else {
      const comparison = compareText(leftPart.toUpperCase(), rightPart.toUpperCase())
      if (comparison !== 0) return comparison
    }
  }
  return 0
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

function text(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function firstText(...values) {
  for (const value of values) {
    const content = text(value).trim()
    if (content) return content
  }
  return ''
}

function arrayOfObjects(value) {
  return Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : []
}
