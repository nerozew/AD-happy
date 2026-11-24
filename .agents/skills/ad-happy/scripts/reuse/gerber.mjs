// Gerber/钻孔复用层：调用 kicad-happy 的 analyze_gerbers.py，并把上游输出
// 归一化为 AD-Happy 的 finding/coverage 结构。
//
// 上游目录只读，本模块只负责：
// 1. 目录预检：缺目录、空目录、缺少钻孔文件时明确返回 not_evaluated 或
//    partial，绝不静默当作通过；
// 2. 用当前 Python 通过 spawnSync 调用上游脚本；
// 3. finding 归一化：rule_id / severity / title / evidence / kind /
//    source='gerber'，并把上游英文文案翻译成中文（原文保留在 source_text）；
// 4. coverage：层数、钻孔数、单位、缺失层与被跳过的检查。
import { spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  statSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

// 与 selfcheck.mjs 保持一致的默认上游路径；可用 KICAD_HAPPY_SCRIPTS 覆盖。
const DEFAULT_KICAD_HAPPY_SCRIPTS = 'D:/Tools/kicad-happy/skills/kicad/scripts'
const SCRIPT_NAME = 'analyze_gerbers.py'
const PYTHON_TIMEOUT_MS = 120 * 1000
const MAX_BUFFER = 8 * 1024 * 1024
const SOURCE_PREFIX = '（检测器原文）'

// Altium 常见的输出目录名；自动发现时按此顺序优先。
export const GERBER_OUTPUT_DIR_NAMES = [
  'Gerber',
  'Outputs',
  'Project Outputs',
  'Manufacturing',
]

// 上游 analyze_gerbers.py 支持的 Gerber 扩展名（小写）。
export const GERBER_EXTENSIONS = new Set([
  '.gbr', '.gbl', '.gtl', '.gbs', '.gts', '.gbo', '.gto', '.gm1', '.gko',
  '.g1', '.g2', '.g3', '.g4',
  '.g2l', '.g3l', '.g4l', '.g5l', '.g6l',
  '.gtp', '.gbp', '.gbrjob',
])

// 钻孔扩展名：.drl / Excellon .txt 会被上游解析；.xln / .nc 只做检测，
// 上游 analyze_gerbers() 的解析循环并未读取它们，coverage 会显式说明。
const DRILL_EXTENSIONS = new Set(['.drl', '.xln', '.nc'])
const DRILL_TXT_EXTENSIONS = new Set(['.txt'])

const SEVERITIES = new Set(['error', 'warning', 'info'])

/**
 * 运行 Gerber/钻孔分析。
 *
 * @param {string|null} gerberDir Gerber 目录；null 表示未提供
 * @param {string} outDir 输出目录（写入 gerber.json）
 * @returns {{
 *   findings: object[],
 *   coverage: object,
 *   rawPath: string|null
 * }}
 */
export function runGerberAnalysis(gerberDir, outDir) {
  if (!gerberDir || !String(gerberDir).trim()) {
    return {
      findings: [],
      coverage: emptyGerberCoverage(['未提供 Gerber 目录']),
      rawPath: null,
    }
  }

  const directory = resolve(String(gerberDir))
  let directoryStat
  try {
    directoryStat = statSync(directory)
  } catch {
    const coverage = emptyGerberCoverage([`Gerber 目录不存在：${directory}`])
    coverage.directory = directory
    return { findings: [], coverage, rawPath: null }
  }
  if (!directoryStat.isDirectory()) {
    const coverage = emptyGerberCoverage([`Gerber 路径不是目录：${directory}`])
    coverage.directory = directory
    return { findings: [], coverage, rawPath: null }
  }

  let classified
  try {
    classified = classifyGerberDirectory(directory)
  } catch (error) {
    return {
      findings: [analysisErrorFinding(`无法读取 Gerber 目录：${error?.message ?? error}`)],
      coverage: failedCoverage(directory, [`无法读取 Gerber 目录：${error?.message ?? error}`], 1),
      rawPath: null,
    }
  }

  const totalEntries = classified.gerberFiles.length
    + classified.drillFiles.length
    + classified.unsupportedDrillFiles.length
  if (classified.entries === 0) {
    const coverage = emptyGerberCoverage([`Gerber 目录为空：${directory}`])
    coverage.directory = directory
    return { findings: [], coverage, rawPath: null }
  }
  if (totalEntries === 0) {
    const coverage = emptyGerberCoverage([
      `目录中没有可识别的 Gerber/钻孔文件：${directory}`,
    ])
    coverage.directory = directory
    return { findings: [], coverage, rawPath: null }
  }
  // 只有钻孔没有 Gerber 时仍交给上游：会得到「缺少所有层」的明确 finding。
  if (classified.gerberFiles.length === 0 && classified.drillFiles.length === 0) {
    const coverage = emptyGerberCoverage([
      '只检测到 .xln/.nc 钻孔文件；上游分析器仅解析 .drl 与 Excellon .txt，'
      + '无法评估层与钻孔数据',
    ])
    coverage.directory = directory
    coverage.unsupportedDrillFiles = classified.unsupportedDrillFiles.length
    return { findings: [], coverage, rawPath: null }
  }

  const scriptsDir = resolveKicadHappyScripts()
  const scriptPath = join(scriptsDir, SCRIPT_NAME)
  if (!existsSync(scriptPath)) {
    const reason = `未找到上游脚本 ${scriptPath}，请设置 KICAD_HAPPY_SCRIPTS`
    return {
      findings: [analysisErrorFinding(reason)],
      coverage: failedCoverage(directory, [reason], 1),
      rawPath: null,
    }
  }

  const resolvedOutDir = resolve(String(outDir))
  try {
    mkdirSync(resolvedOutDir, { recursive: true })
  } catch (error) {
    const reason = `无法创建输出目录 ${resolvedOutDir}：${error?.message ?? error}`
    return {
      findings: [analysisErrorFinding(reason)],
      coverage: failedCoverage(directory, [reason], 1),
      rawPath: null,
    }
  }
  const rawPath = join(resolvedOutDir, 'gerber.json')
  const python = resolvePythonCommand()
  // -B：不向只读的 kicad-happy 目录写 __pycache__；-X utf8：Windows 管道固定 UTF-8。
  const run = spawnSync(
    python,
    ['-B', '-X', 'utf8', scriptPath, directory, '--output', rawPath],
    {
      cwd: resolvedOutDir,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: MAX_BUFFER,
      timeout: PYTHON_TIMEOUT_MS,
    },
  )

  if (run.error || run.status !== 0) {
    const reason = run.error
      ? run.error.code === 'ETIMEDOUT'
        ? `Gerber 分析超时（${PYTHON_TIMEOUT_MS / 1000} 秒）`
        : `无法启动 Python（${python}）：${run.error.message}`
      : `上游 Gerber 分析退出码 ${run.status}`
    const detail = firstText(run.stderr, run.stdout)
    const message = detail ? `${reason}：${truncate(detail, 400)}` : reason
    return {
      findings: [analysisErrorFinding(message)],
      coverage: failedCoverage(directory, [message], 1),
      rawPath: existsSync(rawPath) ? rawPath : null,
    }
  }

  let raw
  try {
    raw = JSON.parse(readFileSync(rawPath, 'utf8'))
  } catch (error) {
    const reason = `无法读取上游 Gerber JSON：${error?.message ?? error}`
    return {
      findings: [analysisErrorFinding(reason)],
      coverage: failedCoverage(directory, [reason], 1),
      rawPath,
    }
  }
  if (!isPlainObject(raw) || raw.analyzer_type !== 'gerber') {
    const reason = '上游 Gerber JSON 不是有效的 gerber 信封'
    return {
      findings: [analysisErrorFinding(reason)],
      coverage: failedCoverage(directory, [reason], 1),
      rawPath,
    }
  }
  if (
    !isPlainObject(raw.statistics)
    || !isPlainObject(raw.completeness)
    || !Array.isArray(raw.gerbers)
    || !Array.isArray(raw.drills)
    || !Array.isArray(raw.findings)
  ) {
    const reason = '上游 Gerber JSON 缺少 statistics/completeness/gerbers/drills/findings 字段'
    return {
      findings: [analysisErrorFinding(reason)],
      coverage: failedCoverage(directory, [reason], 1),
      rawPath,
    }
  }

  const findings = raw.findings
    .filter(isPlainObject)
    .map(normalizeGerberFinding)
  const coverage = buildCoverage(raw, directory, classified, findings.length)
  return { findings, coverage, rawPath }
}

/**
 * 在工程目录顶层查找 Altium 常见输出目录。
 * 优先返回真正含有 Gerber/钻孔文件的候选；目录存在但为空时也返回，
 * 由调用方把 coverage 标成 not_evaluated 而不是假装通过。
 *
 * @param {string} projectDir
 * @returns {{ name: string, directory: string, hasContent: boolean } | null}
 */
export function detectGerberDirectory(projectDir) {
  let entries
  try {
    entries = readdirSync(projectDir, { withFileTypes: true })
  } catch {
    return null
  }
  const directories = new Map()
  for (const entry of entries) {
    if (entry.isDirectory()) directories.set(entry.name.toLowerCase(), entry.name)
  }
  const candidates = []
  for (const wanted of GERBER_OUTPUT_DIR_NAMES) {
    const actual = directories.get(wanted.toLowerCase())
    if (!actual) continue
    const directory = join(projectDir, actual)
    let hasContent = false
    try {
      const classified = classifyGerberDirectory(directory)
      hasContent = classified.gerberFiles.length > 0
        || classified.drillFiles.length > 0
        || classified.unsupportedDrillFiles.length > 0
    } catch {
      hasContent = false
    }
    candidates.push({ name: actual, directory, hasContent })
  }
  if (candidates.length === 0) return null
  return candidates.find(candidate => candidate.hasContent) ?? candidates[0]
}

/**
 * 生成「未评估」coverage；CLI 在自动发现失败时也复用它。
 *
 * @param {string[]} [reasons]
 * @returns {object}
 */
export function emptyGerberCoverage(reasons = []) {
  return {
    status: 'not_evaluated',
    directory: null,
    gerberFiles: 0,
    drillFiles: 0,
    unsupportedDrillFiles: 0,
    layerCount: 0,
    drillCount: 0,
    units: [],
    missingLayers: [],
    missingRequired: [],
    missingRecommended: [],
    boardDimensions: null,
    checks: {
      layer_completeness: 'not_evaluated',
      drill_data: 'not_evaluated',
      alignment: 'not_evaluated',
      board_dimensions: 'not_evaluated',
    },
    reasons: reasons.filter(Boolean),
    findings: 0,
  }
}

// ---------------------------------------------------------------------------
// 目录扫描
// ---------------------------------------------------------------------------

/**
 * 列出目录中的 Gerber/钻孔文件；无法读取时抛错，由调用方转成 failed。
 *
 * @param {string} directory
 * @returns {{
 *   entries: number,
 *   gerberFiles: string[],
 *   drillFiles: string[],
 *   unsupportedDrillFiles: string[]
 * }}
 */
export function classifyGerberDirectory(directory) {
  const entries = readdirSync(directory, { withFileTypes: true })
  const result = {
    entries: entries.length,
    gerberFiles: [],
    drillFiles: [],
    unsupportedDrillFiles: [],
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const extension = fileExtension(entry.name)
    if (GERBER_EXTENSIONS.has(extension)) {
      result.gerberFiles.push(entry.name)
    } else if (DRILL_EXTENSIONS.has(extension)) {
      // 上游解析循环只读取 .drl；.xln/.nc 仅出现在 inputs 的来源清单里。
      if (extension === '.drl') result.drillFiles.push(entry.name)
      else result.unsupportedDrillFiles.push(entry.name)
    } else if (DRILL_TXT_EXTENSIONS.has(extension)
      && isExcellonFile(join(directory, entry.name))) {
      result.drillFiles.push(entry.name)
    }
  }
  return result
}

function isExcellonFile(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(1024)
    const bytes = readSync(fd, buffer, 0, buffer.length, 0)
    const head = buffer.subarray(0, bytes).toString('utf8')
    return head.includes('M48') || /T\d+C\d/.test(head)
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // 关闭失败不影响判断结果。
      }
    }
  }
}

// ---------------------------------------------------------------------------
// coverage
// ---------------------------------------------------------------------------

function buildCoverage(raw, directory, classified, findingCount) {
  const statistics = raw.statistics
  const completeness = raw.completeness
  const gerbers = raw.gerbers.filter(isPlainObject)
  const drills = raw.drills.filter(isPlainObject)
  const gerberFiles = numberOrZero(statistics.gerber_files)
  const drillFiles = numberOrZero(statistics.drill_files)
  const drillCount = numberOrZero(statistics.total_holes)
  const layerCount = numberOrZero(raw.layer_count)
  const fromJob = completeness.source === 'gbrjob'
  const missingRequired = stringList(fromJob ? completeness.missing : completeness.missing_required)
  const missingRecommended = fromJob ? [] : stringList(completeness.missing_recommended)
  const missingLayers = [...new Set([...missingRequired, ...missingRecommended])]
  const units = [...new Set([
    ...gerbers.map(gerber => scalarText(gerber.units)),
    ...drills.map(drill => scalarText(drill.units)),
  ].filter(Boolean))]
  const boardDimensions = normalizeBoardDimensions(raw.board_dimensions)
  const parseErrors = [...gerbers, ...drills]
    .map(entry => scalarText(entry.error))
    .filter(Boolean)

  const checks = {
    layer_completeness: gerberFiles === 0
      ? 'not_evaluated'
      : missingRequired.length > 0 ? 'found' : 'pass',
    drill_data: drillFiles === 0
      ? 'not_evaluated'
      : drillCount === 0 ? 'found' : 'pass',
    alignment: gerberFiles === 0
      ? 'not_evaluated'
      : isPlainObject(raw.alignment) && raw.alignment.aligned === false
        ? 'found'
        : 'pass',
    board_dimensions: boardDimensions ? 'pass' : 'not_evaluated',
  }

  const reasons = []
  if (gerberFiles === 0) {
    reasons.push('未解析到 Gerber 层文件，层完整性与层对齐无法评估')
  }
  if (drillFiles === 0) {
    reasons.push('未找到可解析的钻孔文件（上游支持 .drl 与 Excellon .txt），钻孔数量与孔分类无法评估')
  }
  if (classified.unsupportedDrillFiles.length > 0) {
    reasons.push(
      `检测到 ${classified.unsupportedDrillFiles.length} 个 .xln/.nc 钻孔文件，`
      + '上游分析器只解析 .drl 与 Excellon .txt，未纳入本次评估',
    )
  }
  if (!boardDimensions) {
    reasons.push('所有 Gerber 层均无有效坐标，无法计算板框尺寸')
  }
  for (const error of parseErrors) {
    reasons.push(`文件解析失败：${truncate(error, 200)}`)
  }

  const values = Object.values(checks)
  let status
  if (values.every(value => value === 'not_evaluated')) {
    status = 'not_evaluated'
  } else if (
    values.includes('not_evaluated')
    || parseErrors.length > 0
    // .xln/.nc 不会被上游解析；只要存在就说明本次覆盖不完整，
    // 即使同时有可解析的 .drl 也不能给 pass。
    || classified.unsupportedDrillFiles.length > 0
  ) {
    status = 'partial'
  } else if (findingCount > 0) {
    status = 'found'
  } else {
    status = 'pass'
  }

  return {
    status,
    directory,
    gerberFiles,
    drillFiles,
    unsupportedDrillFiles: classified.unsupportedDrillFiles.length,
    layerCount,
    drillCount,
    units,
    missingLayers,
    missingRequired,
    missingRecommended,
    boardDimensions,
    checks,
    reasons,
    findings: findingCount,
  }
}

function normalizeBoardDimensions(value) {
  if (!isPlainObject(value)) return null
  const width = numberOrZero(value.width_mm)
  const height = numberOrZero(value.height_mm)
  if (width <= 0 || height <= 0) return null
  return {
    widthMm: width,
    heightMm: height,
    areaMm2: numberOrZero(value.area_mm2),
    source: scalarText(value.source),
  }
}

function failedCoverage(directory, reasons, findingCount) {
  const coverage = emptyGerberCoverage(reasons)
  coverage.status = 'failed'
  coverage.directory = directory
  coverage.findings = findingCount
  return coverage
}

// ---------------------------------------------------------------------------
// finding 归一化与中文文案
// ---------------------------------------------------------------------------

const RULE_ID_PATTERN = /^[A-Z]{2,4}-\d+$/

/**
 * 把上游 finding 转成 AD-Happy 结构。
 * 上游 GR-00x 统一映射为 GB-00x（原始 ID 保留在 source_rule_id）；
 * 其余无法识别的规则 ID 加 GB- 前缀。
 *
 * @param {object} finding
 * @returns {object}
 */
export function normalizeGerberFinding(finding) {
  const sourceRuleId = scalarText(finding.rule_id).trim()
  const ruleId = normalizeRuleId(sourceRuleId)
  // 文案模板按上游原始 ID（GR-00x）匹配；输出 rule_id 使用 GB- 前缀。
  const localized = localizeGerberText(
    sourceRuleId || ruleId,
    scalarText(finding.summary),
    scalarText(finding.description),
    scalarText(finding.recommendation),
  )
  const title = localized.summary || 'Gerber 检查发现问题'
  const evidence = localized.description || localized.summary || '上游未提供证据。'
  const result = {
    detector: 'gerber',
    rule_id: ruleId,
    category: scalarText(finding.category) || 'gerber',
    kind: 'issue',
    severity: SEVERITIES.has(scalarText(finding.severity))
      ? scalarText(finding.severity)
      : 'info',
    confidence: scalarText(finding.confidence) || 'deterministic',
    evidence_source: scalarText(finding.evidence_source) || 'topology',
    source: 'gerber',
    title,
    summary: title,
    evidence,
    description: evidence,
    components: stringList(finding.components),
    nets: stringList(finding.nets),
    pins: Array.isArray(finding.pins) ? finding.pins.filter(isPlainObject) : [],
    source_text: localized.originals,
  }
  if (localized.recommendation) result.recommendation = localized.recommendation
  if (isPlainObject(finding.report_context)) {
    result.report_context = finding.report_context
  }
  if (scalarText(finding.finding_id)) result.finding_id = scalarText(finding.finding_id)
  if (sourceRuleId) result.source_rule_id = sourceRuleId
  return result
}

function normalizeRuleId(value) {
  const id = scalarText(value).trim()
  if (!id) return 'GB-UNKNOWN'
  // 上游 GR-001..GR-005 → GB-001..GB-005；原始 ID 由调用方写入 source_rule_id。
  const gerberMatch = /^GR-(\d+)$/.exec(id)
  if (gerberMatch) return `GB-${gerberMatch[1]}`
  if (RULE_ID_PATTERN.test(id)) return id
  const slug = id.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toUpperCase()
  return slug ? `GB-${slug}` : 'GB-UNKNOWN'
}

function analysisErrorFinding(message) {
  return {
    detector: 'gerber',
    rule_id: 'GB-ERR',
    category: 'analysis_error',
    kind: 'issue',
    severity: 'error',
    confidence: 'deterministic',
    evidence_source: 'file',
    source: 'gerber',
    title: 'Gerber/钻孔分析失败',
    summary: 'Gerber/钻孔分析失败',
    evidence: message,
    description: message,
    recommendation: '检查 KICAD_HAPPY_SCRIPTS、Python 环境与 Gerber 目录权限后重试。',
    components: [],
    nets: [],
    pins: [],
    source_text: {},
  }
}

const GR_TRANSLATORS = {
  'GR-001': {
    summary(text) {
      const match = /^Missing layer:\s*(?<layer>.+)$/.exec(text)
      return match ? `缺少层：${match.groups.layer}` : null
    },
    description(text) {
      const match = /^Expected (?<kind>required|recommended) layer (?<layer>.+) not found in gerber set\.$/.exec(text)
      if (!match) return null
      const kind = match.groups.kind === 'required' ? '必需' : '建议'
      return `Gerber 文件中未找到${kind}层 ${match.groups.layer}。`
    },
    recommendation(text) {
      const match = /^Add (?<layer>.+) to gerber export\.$/.exec(text)
      return match ? `请在 Gerber 导出中加入 ${match.groups.layer}。` : null
    },
  },
  'GR-002': {
    summary(text) {
      const match = /^Alignment:\s*(?<issue>.+)$/.exec(text)
      return match ? `层对齐问题：${translateAlignmentIssue(match.groups.issue)}` : null
    },
    description(text) {
      const match = /^Layer alignment issue:\s*(?<issue>.+)$/.exec(text)
      return match ? `层对齐问题：${translateAlignmentIssue(match.groups.issue)}` : null
    },
    recommendation() {
      return '请重新导出 Gerber，确保各层坐标范围一致。'
    },
  },
  'GR-003': {
    summary(text) {
      if (text === 'No drill file in gerber set') return 'Gerber 文件集中没有钻孔文件'
      if (text === 'Drill file has 0 holes') return '钻孔文件包含 0 个孔'
      return null
    },
    description(text) {
      if (text === 'No Excellon drill file found. PCB fabrication requires drill data.') {
        return '未找到 Excellon 钻孔文件；PCB 制造需要钻孔数据。'
      }
      if (text === 'Drill file present but contains no hole definitions.') {
        return '钻孔文件存在，但没有定义任何孔。'
      }
      return null
    },
    recommendation(text) {
      if (text === 'Include drill file(s) in gerber export.') {
        return '请在 Gerber 导出中包含钻孔文件。'
      }
      if (text === 'Verify drill file was exported correctly.') {
        return '请确认钻孔文件导出正确。'
      }
      return null
    },
  },
  'GR-004': {
    summary(text) {
      const match = /^(?<side>[FB]) paste layer: (?<pads>\d+) flashes vs (?<copper>\d+) copper \((?<ratio>[\d.]+)%\)$/.exec(text)
      if (!match) return null
      return `${match.groups.side} 面锡膏层：${match.groups.pads} 个焊盘开窗，`
        + `铜层 ${match.groups.copper} 个（${match.groups.ratio}%）`
    },
    description(text) {
      const match = /^(?<side>[FB])-side paste layer has significantly fewer flashes \((?<pads>\d+)\) than copper layer \((?<copper>\d+)\)\. This may indicate missing solder paste apertures\.$/.exec(text)
      if (!match) return null
      return `${match.groups.side} 面锡膏层的焊盘开窗数（${match.groups.pads}）`
        + `明显少于铜层（${match.groups.copper}），可能存在锡膏开窗缺失。`
    },
    recommendation(text) {
      if (text.startsWith('Check solder paste aperture generation')) {
        return '检查锡膏层开窗生成；缺少开窗会导致装配缺陷。'
      }
      return null
    },
  },
  'GR-005': {
    summary(text) {
      const match = /^Board outline may not be closed — only (?<draws>\d+) draw\(s\)$/.exec(text)
      return match ? `板框可能未闭合：仅有 ${match.groups.draws} 条绘制线段` : null
    },
    description(text) {
      const match = /^Edge\.Cuts layer has only (?<draws>\d+) draw command\(s\)\. A closed rectangular outline needs at least 4\. The outline may be incomplete\.$/.exec(text)
      if (!match) return null
      return `边框层（Edge.Cuts）只有 ${match.groups.draws} 条绘制命令；`
        + '闭合矩形板框至少需要 4 条，板框可能不完整。'
    },
    recommendation(text) {
      if (text === 'Verify board outline forms a closed shape before submitting to fab.') {
        return '提交制造前请确认板框闭合。'
      }
      return null
    },
  },
}

const ALIGNMENT_ISSUES = [
  [
    /^Width varies by (?<amount>[\d.]+)mm across copper\/edge layers$/,
    match => `铜层与边框层的宽度相差 ${match.groups.amount}mm`,
  ],
  [
    /^Height varies by (?<amount>[\d.]+)mm across copper\/edge layers$/,
    match => `铜层与边框层的高度相差 ${match.groups.amount}mm`,
  ],
]

function translateAlignmentIssue(issue) {
  for (const [pattern, render] of ALIGNMENT_ISSUES) {
    const match = pattern.exec(issue)
    if (match) return render(match)
  }
  return `${SOURCE_PREFIX}${issue}`
}

function localizeGerberText(ruleId, summary, description, recommendation) {
  const spec = Object.hasOwn(GR_TRANSLATORS, ruleId)
    ? GR_TRANSLATORS[ruleId]
    : null
  const originals = {}
  const translated = {}
  for (const [field, text] of Object.entries({ summary, description, recommendation })) {
    if (!text) {
      translated[field] = ''
      continue
    }
    const render = spec && Object.hasOwn(spec, field) ? spec[field] : null
    const result = render ? render(text) : null
    if (result && result !== text) {
      translated[field] = result
      originals[field] = text
    } else if (result === text) {
      translated[field] = text
    } else if (mostlyAsciiLetters(text)) {
      // 未收录译法的英文串显式标注，不静默透传。
      translated[field] = `${SOURCE_PREFIX}${text}`
      originals[field] = text
    } else {
      translated[field] = text
    }
  }
  return { ...translated, originals }
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function resolveKicadHappyScripts() {
  return resolve(
    process.env.KICAD_HAPPY_SCRIPTS?.trim() || DEFAULT_KICAD_HAPPY_SCRIPTS,
  )
}

function resolvePythonCommand() {
  return process.env.AD_HAPPY_PYTHON?.trim() || 'python'
}

function fileExtension(name) {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  return dot === -1 ? '' : lower.slice(dot)
}

function stringList(value) {
  if (!Array.isArray(value)) return []
  return value.map(scalarText).filter(Boolean)
}

function mostlyAsciiLetters(text) {
  const letters = [...text].filter(char => /\p{L}/u.test(char))
  if (letters.length < 4) return false
  const ascii = letters.filter(char => char.charCodeAt(0) < 128).length
  return ascii / letters.length >= 0.6
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function scalarText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function truncate(value, limit) {
  const text = String(value ?? '')
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(limit - 1, 0))}…`
}
