// 数据手册（datasheets）覆盖检查与提取计划编排。
//
// 范围（Phase 3 明确边界）：
// - 扫描数据手册目录，按 MPN 把 PDF 匹配到 BOM 元件；
// - 对匹配到的元件调用上游 kicad-happy 的 plan_extraction.py 生成提取计划；
// - 只做确定性的覆盖/匹配/计划检查，**不解析 PDF 引脚表**，也不把正则匹配
//   当成引脚核对。引脚级核对始终标记为 not_evaluated，需要 AI 或人工依据
//   PDF 提取后完成。
//
// 上游接口（只读）：
//   python -B -X utf8 <kicad-happy>/skills/datasheets/scripts/plan_extraction.py \
//     <mpn> <pdf_path> --cache-dir <dir> --use-cached-scout [--force]
//
// 注意：上游在没有 <mpn>.scout.json 缓存时会直接报错（退出码 2），因为 scout
// 必须由 AI 子代理阅读 PDF 后产出。本模块不会伪造 scout 结果，也不会在缺少
// scout 时声称计划已生成。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
} from 'node:path'

// 元件位号前缀识别集成电路。U 是 Altium 里最常见的 IC 前缀，IC 用于
// 显式命名的元件；电阻、电容、连接器等不要求数据手册，避免产生噪音。
const IC_REFERENCE_PATTERN = /^(?:U|IC)\d/iu

// 数据手册目录递归扫描的最大深度；防止误把整个磁盘当目录扫描。
const MAX_SCAN_DEPTH = 4
// 扫描时跳过的目录：缓存目录只放 JSON，依赖目录不属于数据手册来源。
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'extracted', '.git'])
const MANIFEST_FILE = 'manifest.json'
const PLAN_TIMEOUT_MS = 60 * 1000
const MAX_VISIBLE_LIST = 50

/**
 * 扫描数据手册目录。
 *
 * @param {string} directory 数据手册目录
 * @returns {{
 *   directory: string,
 *   exists: boolean,
 *   pdfs: Array<{
 *     path: string, fileName: string, relativePath: string,
 *     inferredMpn: string, manifestMpns: string[], mpns: string[],
 *     sizeBytes: number
 *   }>,
 *   coverage: object
 * }}
 */
export function scanDatasheets(directory) {
  const target = resolve(String(directory ?? ''))
  const reasons = []
  let exists = false
  try {
    exists = statSync(target).isDirectory()
  } catch {
    exists = false
  }
  if (!exists) {
    return {
      directory: target,
      exists: false,
      pdfs: [],
      coverage: {
        status: 'not_evaluated',
        directory: target,
        exists: false,
        manifestPresent: false,
        manifestInvalid: false,
        pdfCount: 0,
        reasons: ['数据手册目录不存在或不可访问。'],
      },
    }
  }

  const manifest = readManifest(target)
  reasons.push(...manifest.reasons)

  let pdfs = []
  let scanError = null
  try {
    pdfs = collectPdfs(target, manifest)
  } catch (error) {
    scanError = error?.message ?? String(error)
    reasons.push(`数据手册目录扫描失败：${scanError}`)
  }

  if (!scanError && pdfs.length === 0) {
    reasons.push('数据手册目录中没有 PDF 文件。')
  }

  return {
    directory: target,
    exists: true,
    pdfs,
    coverage: {
      status: scanError ? 'failed' : pdfs.length > 0 ? 'pass' : 'not_evaluated',
      directory: target,
      exists: true,
      manifestPresent: manifest.present,
      manifestInvalid: manifest.invalid,
      pdfCount: pdfs.length,
      reasons,
    },
  }
}

/**
 * 把 PDF 匹配到 BOM 元件。
 *
 * 匹配规则：元件 MPN 与 PDF 的 MPN（manifest 登记优先，否则文件名推断）
 * 做大小写不敏感、忽略非字母数字字符的归一化比较，例如 LM2596-ADJ 与
 * lm2596adj 视为同一型号。没有 MPN 的元件无法匹配。
 *
 * @param {object[]} pdfs scanDatasheets 产出的 pdfs
 * @param {object[]} bomRows buildBom 产出的行
 * @returns {{
 *   matched: object[],
 *   unmatchedPdfs: object[],
 *   componentsWithoutPdf: object[],
 *   coverage: object
 * }}
 */
export function matchToComponents(pdfs, bomRows) {
  const pdfList = Array.isArray(pdfs) ? pdfs.filter(isPlainObject) : []
  const rows = Array.isArray(bomRows) ? bomRows.filter(isPlainObject) : []

  const pdfByMpn = new Map()
  for (const pdf of pdfList) {
    const candidates = Array.isArray(pdf.mpns) && pdf.mpns.length > 0
      ? pdf.mpns
      : [pdf.inferredMpn]
    for (const mpn of candidates) {
      const key = normalizeMpn(mpn)
      if (!key) continue
      const entries = pdfByMpn.get(key) ?? []
      entries.push(pdf)
      pdfByMpn.set(key, entries)
    }
  }

  const matched = []
  const componentsWithoutPdf = []
  const usedPdfPaths = new Set()

  for (const row of rows) {
    const reference = text(row.reference)
    const mpn = text(row.mpn)
    const isIc = isIcReference(reference)
    if (!mpn) {
      componentsWithoutPdf.push({
        reference,
        mpn: '',
        value: text(row.value),
        footprint: text(row.footprint),
        isIc,
        reason: 'no_mpn',
        reasonText: '元件没有 MPN，无法按型号匹配数据手册。',
      })
      continue
    }
    const candidates = pdfByMpn.get(normalizeMpn(mpn))
    if (!candidates || candidates.length === 0) {
      componentsWithoutPdf.push({
        reference,
        mpn,
        value: text(row.value),
        footprint: text(row.footprint),
        isIc,
        reason: 'no_pdf',
        reasonText: `没有与该 MPN 匹配的 PDF 数据手册。`,
      })
      continue
    }
    // 同一 MPN 有多份 PDF 时优先用第一份（按扫描顺序稳定），但所有候选
    // 都视为已使用，避免把重复 PDF 误报成「未匹配」。
    for (const pdf of candidates) usedPdfPaths.add(resolve(text(pdf.path)))
    const chosen = candidates[0]
    matched.push({
      reference,
      mpn,
      value: text(row.value),
      footprint: text(row.footprint),
      isIc,
      pdfPath: text(chosen.path),
      pdfFileName: text(chosen.fileName),
      pdfInferredMpn: text(chosen.inferredMpn),
      matchedMpn: candidates.length > 1 ? '' : text(chosen.inferredMpn),
    })
  }

  const unmatchedPdfs = pdfList.filter(pdf => !usedPdfPaths.has(resolve(text(pdf.path))))

  return {
    matched,
    unmatchedPdfs,
    componentsWithoutPdf,
    coverage: {
      status: rows.length === 0
        ? 'not_evaluated'
        : matched.length > 0 || unmatchedPdfs.length > 0 ? 'pass' : 'not_evaluated',
      components: rows.length,
      componentsWithMpn: rows.filter(row => text(row.mpn)).length,
      componentsWithPdf: matched.length,
      componentsWithoutPdf: componentsWithoutPdf.length,
      matched: matched.length,
      unmatchedPdfs: unmatchedPdfs.length,
      icComponents: rows.filter(row => isIcReference(text(row.reference))).length,
      icsWithoutPdf: componentsWithoutPdf.filter(entry => entry.isIc).length,
    },
  }
}

/**
 * 调用上游 plan_extraction.py 生成单个 MPN 的提取计划。
 *
 * 不会伪造 scout：缓存中没有 <mpn>.scout.json 时直接返回 not_evaluated，
 * 说明需要 AI scout 先阅读 PDF。上游脚本本身是 stdlib-only，正常可直接运行。
 *
 * @param {string} mpn
 * @param {string} pdfPath
 * @param {string} cacheDir
 * @param {{
 *   scriptsDir?: string,
 *   python?: string,
 *   env?: NodeJS.ProcessEnv,
 *   spawn?: Function,
 *   force?: boolean,
 *   timeoutMs?: number
 * }} [options]
 * @returns {{
 *   planPath: string|null,
 *   expectedPlanPath: string,
 *   ok: boolean,
 *   status: string,
 *   error: string|null,
 *   exitCode: number|null,
 *   taskCount: number|null,
 *   scoutPath: string
 * }}
 */
export function planExtraction(mpn, pdfPath, cacheDir, options = {}) {
  const env = options.env ?? process.env
  const scriptsDir = resolveDatasheetsScriptsDir(options, env)
  const scriptPath = join(scriptsDir, 'plan_extraction.py')
  const python = options.python ?? 'python'
  const spawn = typeof options.spawn === 'function' ? options.spawn : spawnSync
  const pdf = resolve(String(pdfPath ?? ''))
  const cache = resolve(String(cacheDir ?? dirname(pdf)))
  const name = text(mpn).trim()
  const sanitized = sanitizeMpn(name)
  const expectedPlanPath = join(cache, `${sanitized}.plan.json`)
  const scoutPath = join(cache, `${sanitized}.scout.json`)

  const failure = (status, error, extra = {}) => ({
    planPath: existsSync(expectedPlanPath) ? expectedPlanPath : null,
    expectedPlanPath,
    ok: false,
    status,
    error,
    exitCode: extra.exitCode ?? null,
    taskCount: extra.taskCount ?? null,
    scoutPath,
  })

  if (!name) return failure('failed', 'MPN 为空，无法生成提取计划。')
  if (!existsSync(scriptPath)) {
    return failure(
      'failed',
      `未找到上游提取脚本：${scriptPath}；请安装 kicad-happy 或设置环境变量 `
      + 'KICAD_HAPPY_DATASHEETS_SCRIPTS 指向 skills/datasheets/scripts 目录。',
    )
  }
  if (!existsSync(pdf)) {
    return failure('failed', `PDF 文件不存在或不可访问：${pdf}`)
  }

  let pdfSha
  try {
    pdfSha = `sha256:${createHash('sha256').update(readFileSync(pdf)).digest('hex')}`
  } catch (error) {
    return failure('failed', `无法读取 PDF 以计算校验值：${error?.message ?? error}`)
  }

  // 已有计划且与当前 PDF/MPN 一致时直接复用，避免每次运行重复调用 Python。
  if (!options.force && existsSync(expectedPlanPath)) {
    const existing = readJson(expectedPlanPath)
    if (
      isPlainObject(existing)
      && text(existing.mpn) === name
      && text(existing.pdf_sha256) === pdfSha
    ) {
      return {
        planPath: expectedPlanPath,
        expectedPlanPath,
        ok: true,
        status: 'existing',
        error: null,
        exitCode: 0,
        taskCount: Array.isArray(existing.tasks) ? existing.tasks.length : 0,
        scoutPath,
      }
    }
  }

  // 上游要求先有 AI scout 产出的缓存；没有 scout 时不能伪造计划。
  if (!existsSync(scoutPath)) {
    return failure(
      'not_evaluated',
      `缓存中没有 ${sanitized}.scout.json。上游 plan_extraction.py 需要先由 AI scout `
      + '阅读 PDF 并写出 scout 结果；本工具不会伪造该步骤，提取计划标记为未评估。',
    )
  }

  try {
    mkdirSync(cache, { recursive: true })
  } catch (error) {
    return failure('failed', `无法创建数据手册缓存目录：${error?.message ?? error}`)
  }

  const args = [
    '-B',
    '-X',
    'utf8',
    scriptPath,
    name,
    pdf,
    '--cache-dir',
    cache,
    '--use-cached-scout',
  ]
  if (options.force) args.push('--force')

  const result = spawn(python, args, {
    cwd: cache,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    timeout: typeof options.timeoutMs === 'number' ? options.timeoutMs : PLAN_TIMEOUT_MS,
  })

  if (result?.error) {
    const reason = result.error.code === 'ETIMEDOUT'
      ? `提取计划生成超时（${(options.timeoutMs ?? PLAN_TIMEOUT_MS) / 1000} 秒）`
      : `无法启动 python：${result.error.message}`
    return failure('failed', reason)
  }

  const exitCode = typeof result?.status === 'number' ? result.status : null
  const detail = firstText(result?.stderr, result?.stdout)
  const taskCount = readPlanTaskCount(expectedPlanPath)
  const planExists = existsSync(expectedPlanPath)

  if (exitCode === 0) {
    if (!planExists) {
      // 上游在「提取缓存已是最新」时会返回 0 而不重写计划。
      return {
        planPath: null,
        expectedPlanPath,
        ok: true,
        status: 'up-to-date',
        error: null,
        exitCode,
        taskCount: null,
        scoutPath,
      }
    }
    return {
      planPath: expectedPlanPath,
      expectedPlanPath,
      ok: true,
      status: 'generated',
      error: null,
      exitCode,
      taskCount,
      scoutPath,
    }
  }

  if (exitCode === 1 && planExists && taskCount === 0) {
    // scout verdict=skip：上游写入空计划并以 1 退出，不是执行失败。
    return {
      planPath: expectedPlanPath,
      expectedPlanPath,
      ok: false,
      status: 'skipped',
      error: `上游 scout 判定跳过，已写入空提取计划${detail ? `：${truncate(detail, 300)}` : '。'}`,
      exitCode,
      taskCount,
      scoutPath,
    }
  }

  const message = detail ? truncate(detail, 500) : '（无错误输出）'
  return failure(
    'failed',
    `上游 plan_extraction.py 退出码 ${exitCode ?? '未知'}：${message}`,
    { exitCode, taskCount },
  )
}

/**
 * 执行完整的数据手册阶段：扫描、匹配、生成计划、汇总检查与 findings。
 *
 * @param {{
 *   directory: string,
 *   bomRows: object[],
 *   cacheDir?: string,
 *   generatedAt?: string,
 *   planOptions?: object
 * }} input
 * @returns {{
 *   directory: string,
 *   pdfs: object[],
 *   matched: object[],
 *   unmatchedPdfs: object[],
 *   componentsWithoutPdf: object[],
 *   plans: object[],
 *   coverage: object,
 *   findings: object[]
 * }}
 */
export function evaluateDatasheets({ directory, bomRows, cacheDir, planOptions } = {}) {
  const scan = scanDatasheets(directory)
  const rows = Array.isArray(bomRows) ? bomRows : []

  if (!scan.exists || scan.coverage.status === 'failed') {
    const coverage = emptyDatasheetsCoverage({
      directory: scan.directory,
      reasons: scan.coverage.reasons,
      status: scan.coverage.status === 'failed' ? 'failed' : 'not_evaluated',
      manifestPresent: scan.coverage.manifestPresent,
      ...summarizeComponents(rows),
    })
    return {
      directory: scan.directory,
      pdfs: scan.pdfs,
      matched: [],
      unmatchedPdfs: [],
      componentsWithoutPdf: [],
      plans: [],
      coverage,
      findings: scan.coverage.status === 'failed'
        ? [datasheetErrorFinding(scan.coverage.reasons.join('；') || '数据手册目录扫描失败')]
        : [],
    }
  }

  const match = matchToComponents(scan.pdfs, rows)
  const cache = resolve(
    String(cacheDir ?? join(scan.directory, 'extracted')),
  )

  // 同一 MPN 可能被多个位号共用：按 MPN + PDF 去重，只生成一次计划。
  const planKeys = new Map()
  for (const entry of match.matched) {
    const key = `${normalizeMpn(entry.mpn)}|${resolve(entry.pdfPath).toLowerCase()}`
    if (!planKeys.has(key)) {
      planKeys.set(key, {
        mpn: entry.mpn,
        pdfPath: entry.pdfPath,
        pdfFileName: entry.pdfFileName,
        references: [],
      })
    }
    planKeys.get(key).references.push(entry.reference)
  }

  const plans = []
  for (const item of planKeys.values()) {
    const result = planExtraction(item.mpn, item.pdfPath, cache, planOptions)
    plans.push({
      mpn: item.mpn,
      pdfPath: item.pdfPath,
      pdfFileName: item.pdfFileName,
      references: item.references,
      planPath: result.planPath,
      expectedPlanPath: result.expectedPlanPath,
      status: result.status,
      ok: result.ok,
      error: result.error,
      taskCount: result.taskCount,
      exitCode: result.exitCode,
    })
  }
  // 把计划结果回填到每个 matched 条目，报告里可以直接逐元件展示。
  const planByKey = new Map(plans.map(plan => [
    `${normalizeMpn(plan.mpn)}|${resolve(plan.pdfPath).toLowerCase()}`,
    plan,
  ]))
  const matched = match.matched.map(entry => {
    const plan = planByKey.get(
      `${normalizeMpn(entry.mpn)}|${resolve(entry.pdfPath).toLowerCase()}`,
    )
    return {
      ...entry,
      planStatus: plan?.status ?? 'not_evaluated',
      planPath: plan?.planPath ?? null,
      planError: plan?.error ?? null,
      planTaskCount: plan?.taskCount ?? null,
    }
  })

  const icsWithoutPdf = match.componentsWithoutPdf.filter(entry => entry.isIc)
  const checks = {
    // 覆盖检查只看集成电路：没有 IC 时「数据手册覆盖」不适用，不能算通过。
    coverage: rows.length === 0 || match.coverage.icComponents === 0
      ? 'not_evaluated'
      : icsWithoutPdf.length > 0 ? 'found' : 'pass',
    pdf_match: scan.pdfs.length === 0
      ? 'not_evaluated'
      : match.coverage.componentsWithMpn === 0
        ? 'not_evaluated'
        : match.unmatchedPdfs.length > 0 ? 'found' : 'pass',
    extraction_plan: aggregatePlanStatus(plans, match.matched.length > 0),
    // 引脚级核对永远不在本工具范围内：没有 PDF 引脚表提取，就没有核对。
    pin_verification: 'not_evaluated',
  }

  const findings = buildDatasheetFindings({
    componentsWithoutPdf: match.componentsWithoutPdf,
    icsWithoutPdf,
    unmatchedPdfs: match.unmatchedPdfs,
    plans,
  })

  const reasons = [...scan.coverage.reasons]
  if (rows.length === 0) {
    reasons.push('工程没有可核对的元件，数据手册覆盖检查未评估。')
  } else if (match.coverage.componentsWithMpn === 0) {
    reasons.push('工程元件都没有 MPN，无法按型号匹配数据手册。')
  }
  if (match.coverage.icComponents === 0 && rows.length > 0) {
    reasons.push('工程中没有识别到集成电路（U/IC 位号），集成电路数据手册覆盖检查不适用。')
  }
  const notEvaluatedPlans = plans.filter(plan => plan.status === 'not_evaluated')
  if (notEvaluatedPlans.length > 0) {
    reasons.push(
      `有 ${notEvaluatedPlans.length} 个 MPN 的提取计划未评估：需要 AI scout 先阅读 PDF `
      + '并写出 <MPN>.scout.json。',
    )
  }
  const skippedPlans = plans.filter(plan => plan.status === 'skipped')
  if (skippedPlans.length > 0) {
    reasons.push(
      `有 ${skippedPlans.length} 个 MPN 的 scout 判定跳过，未生成提取任务。`,
    )
  }
  reasons.push(
    '引脚级核对未评估：本工具不解析 PDF 引脚表，需要 AI 或人工依据数据手册提取后核对。',
  )

  const coverage = {
    status: 'not_evaluated',
    directory: scan.directory,
    exists: true,
    manifestPresent: scan.coverage.manifestPresent,
    manifestInvalid: scan.coverage.manifestInvalid,
    pdfCount: scan.pdfs.length,
    components: rows.length,
    componentsWithMpn: match.coverage.componentsWithMpn,
    componentsWithPdf: match.matched.length,
    componentsWithoutPdf: match.componentsWithoutPdf.length,
    icComponents: match.coverage.icComponents,
    icsWithoutPdf: icsWithoutPdf.length,
    matched: match.matched.length,
    unmatchedPdfs: match.unmatchedPdfs.length,
    plans: plans.length,
    planGenerated: plans.filter(plan => isPlanGenerated(plan.status)).length,
    planNotEvaluated: plans.filter(plan => plan.status === 'not_evaluated').length,
    planSkipped: skippedPlans.length,
    planFailed: plans.filter(plan => plan.status === 'failed').length,
    checks,
    reasons,
    findings: findings.length,
  }
  coverage.status = recomputeDatasheetsStatus(coverage)

  return {
    directory: scan.directory,
    pdfs: scan.pdfs,
    matched,
    unmatchedPdfs: match.unmatchedPdfs,
    componentsWithoutPdf: match.componentsWithoutPdf,
    plans,
    coverage,
    findings,
  }
}

/**
 * 重新计算数据手册总状态。
 * failed > 发现问题 > 部分完成/未评估 > 通过；引脚级核对未完成时不得给 pass。
 *
 * @param {object} coverage
 * @returns {'pass'|'found'|'partial'|'not_evaluated'|'failed'}
 */
export function recomputeDatasheetsStatus(coverage) {
  const checks = isPlainObject(coverage?.checks) ? coverage.checks : {}
  const values = Object.values(checks).filter(value => typeof value === 'string')
  if (values.includes('failed')) return 'failed'
  if (!(coverage?.components > 0)) return 'not_evaluated'
  if ((coverage?.findings ?? 0) > 0) return 'found'
  if (values.includes('partial')) return 'partial'
  const evaluated = [checks.coverage, checks.pdf_match, checks.extraction_plan]
    .filter(value => typeof value === 'string')
  if (evaluated.length > 0 && evaluated.every(value => value === 'not_evaluated')) {
    return 'not_evaluated'
  }
  // 即使覆盖与计划都通过，引脚级核对仍未进行，只能算部分完成。
  if (checks.pin_verification !== 'pass') return 'partial'
  return 'pass'
}

/**
 * 统计 BOM 元件的总量、MPN 覆盖与集成电路数量。
 * 目录缺失时仍能展示工程规模，但覆盖检查保持未评估。
 *
 * @param {object[]} bomRows
 * @returns {{components: number, componentsWithMpn: number, icComponents: number}}
 */
export function summarizeComponents(bomRows) {
  const rows = Array.isArray(bomRows) ? bomRows.filter(isPlainObject) : []
  return {
    components: rows.length,
    componentsWithMpn: rows.filter(row => text(row.mpn)).length,
    icComponents: rows.filter(row => isIcReference(text(row.reference))).length,
  }
}

/**
 * 没有数据手册目录时的空覆盖对象，保证 summary/report 能看到原因。
 *
 * @param {object} [options]
 * @returns {object}
 */
export function emptyDatasheetsCoverage(options = {}) {
  const reasons = Array.isArray(options.reasons) && options.reasons.length > 0
    ? options.reasons
    : ['工程目录中没有 datasheets 目录，数据手册检查未评估。']
  return {
    status: options.status ?? 'not_evaluated',
    directory: options.directory ?? null,
    exists: false,
    manifestPresent: options.manifestPresent === true,
    manifestInvalid: false,
    pdfCount: 0,
    components: numberOrZero(options.components),
    componentsWithMpn: numberOrZero(options.componentsWithMpn),
    componentsWithPdf: 0,
    componentsWithoutPdf: 0,
    icComponents: numberOrZero(options.icComponents),
    icsWithoutPdf: 0,
    matched: 0,
    unmatchedPdfs: 0,
    plans: 0,
    planGenerated: 0,
    planNotEvaluated: 0,
    planSkipped: 0,
    planFailed: 0,
    checks: {
      coverage: 'not_evaluated',
      pdf_match: 'not_evaluated',
      extraction_plan: 'not_evaluated',
      pin_verification: 'not_evaluated',
    },
    reasons,
    findings: 0,
  }
}

/**
 * 数据手册分析失败时的 finding（目录扫描失败、阶段异常等）。
 * @param {string} message
 * @returns {object}
 */
export function datasheetErrorFinding(message) {
  const detail = text(message) || '未知错误'
  return {
    detector: 'datasheets',
    rule_id: 'DS-ERR',
    category: 'analysis_error',
    kind: 'issue',
    severity: 'error',
    confidence: 'deterministic',
    evidence_source: 'file',
    source: 'datasheets',
    title: '数据手册分析失败',
    summary: '数据手册分析失败',
    evidence: detail,
    recommendation: '确认数据手册目录可读，且 Python 与 kicad-happy 的上游脚本可用后重试。',
    components: [],
    nets: [],
    pins: [],
  }
}

/**
 * 解析上游脚本目录。优先级：
 * 1. options.scriptsDir；
 * 2. 环境变量 KICAD_HAPPY_DATASHEETS_SCRIPTS；
 * 3. 由 KICAD_HAPPY_SCRIPTS（.../skills/kicad/scripts）推导同级 datasheets；
 * 4. 本机默认安装位置。
 *
 * @param {object} options
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolveDatasheetsScriptsDir(options = {}, env = process.env) {
  if (options.scriptsDir) return resolve(String(options.scriptsDir))
  const explicit = text(env?.KICAD_HAPPY_DATASHEETS_SCRIPTS).trim()
  if (explicit) return resolve(explicit)
  const kicadScripts = text(env?.KICAD_HAPPY_SCRIPTS).trim()
  if (kicadScripts) {
    // KICAD_HAPPY_SCRIPTS = <repo>/skills/kicad/scripts
    return join(dirname(dirname(resolve(kicadScripts))), 'datasheets', 'scripts')
  }
  return resolve('D:/Tools/kicad-happy/skills/datasheets/scripts')
}

/**
 * 上游 MPN 文件名清洗规则：只保留 [A-Za-z0-9_-]，其余字符替换为下划线。
 * @param {string} mpn
 * @returns {string}
 */
export function sanitizeMpn(mpn) {
  return text(mpn).trim().replace(/[^A-Za-z0-9_-]/gu, '_')
}

// ---------------------------------------------------------------------------
// 扫描辅助
// ---------------------------------------------------------------------------

function collectPdfs(directory, manifest) {
  const pdfs = []
  walk(directory, '', 0, manifest, pdfs)
  return pdfs
}

function walk(directory, relativeDir, depth, manifest, pdfs) {
  if (depth > MAX_SCAN_DEPTH) return
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => compareText(a.name, b.name))
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const fullPath = join(directory, entry.name)
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue
      walk(fullPath, relativePath, depth + 1, manifest, pdfs)
      continue
    }
    if (!entry.isFile() || !/\.pdf$/iu.test(entry.name)) continue
    const inferredMpn = entry.name.replace(/\.pdf$/iu, '').trim()
    const manifestMpns = manifest.lookup(relativePath, entry.name)
    // manifest 的 MPN 是权威登记；文件名推断仍保留，方便报告展示与回退匹配。
    const mpns = uniqueStrings([...manifestMpns, inferredMpn])
    let sizeBytes = 0
    try {
      sizeBytes = statSync(fullPath).size
    } catch {
      sizeBytes = 0
    }
    pdfs.push({
      path: fullPath,
      fileName: entry.name,
      relativePath,
      inferredMpn,
      manifestMpns,
      mpns,
      sizeBytes,
    })
  }
}

function readManifest(directory) {
  const manifestPath = join(directory, MANIFEST_FILE)
  const reasons = []
  const mappings = new Map()
  if (!existsSync(manifestPath)) {
    return {
      present: false,
      invalid: false,
      reasons,
      lookup: () => [],
    }
  }

  let data
  try {
    data = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    reasons.push(
      `manifest.json 无法解析（${truncate(error?.message ?? error, 200)}），按文件名推断 MPN。`,
    )
    return { present: true, invalid: true, reasons, lookup: () => [] }
  }

  const pdfsSection = isPlainObject(data?.pdfs) ? data.pdfs : null
  if (!pdfsSection) {
    reasons.push('manifest.json 没有 pdfs 节，按文件名推断 MPN。')
    return { present: true, invalid: false, reasons, lookup: () => [] }
  }

  for (const entry of Object.values(pdfsSection)) {
    if (!isPlainObject(entry)) continue
    const declaredPath = text(entry.path)
    const mpns = Array.isArray(entry.mpns)
      ? uniqueStrings(entry.mpns.map(text))
      : []
    if (!declaredPath || mpns.length === 0) continue
    const normalized = normalizeManifestPath(declaredPath)
    if (!normalized) continue
    const relativeKey = `rel:${normalized.toLowerCase()}`
    mappings.set(relativeKey, uniqueStrings([...(mappings.get(relativeKey) ?? []), ...mpns]))
    const baseKey = `base:${basename(normalized).toLowerCase()}`
    mappings.set(baseKey, uniqueStrings([...(mappings.get(baseKey) ?? []), ...mpns]))
  }

  const lookup = (relativePath, fileName) => {
    const relativeMpns = mappings.get(`rel:${normalizeManifestPath(relativePath).toLowerCase()}`)
    const baseMpns = mappings.get(`base:${text(fileName).toLowerCase()}`)
    return uniqueStrings([...(relativeMpns ?? []), ...(baseMpns ?? [])])
  }

  return { present: true, invalid: false, reasons, lookup }
}

function normalizeManifestPath(value) {
  let normalized = text(value).trim().replaceAll('\\', '/').replace(/^\.\//u, '')
  if (isAbsolute(normalized)) normalized = basename(normalized)
  // 上游缓存约定中 local_path 可能带 datasheets/ 前缀。
  normalized = normalized.replace(/^datasheets\//iu, '')
  return normalized
}

// ---------------------------------------------------------------------------
// 计划与 findings
// ---------------------------------------------------------------------------

function aggregatePlanStatus(plans, hasMatches) {
  if (!hasMatches || plans.length === 0) return 'not_evaluated'
  if (plans.some(plan => plan.status === 'failed')) return 'failed'
  const generated = plans.filter(plan => isPlanGenerated(plan.status)).length
  if (generated === plans.length) return 'pass'
  if (generated === 0) return 'not_evaluated'
  return 'partial'
}

function isPlanGenerated(status) {
  return status === 'generated' || status === 'existing' || status === 'up-to-date'
}

function buildDatasheetFindings({ icsWithoutPdf, unmatchedPdfs, plans }) {
  const findings = []

  if (icsWithoutPdf.length > 0) {
    const references = icsWithoutPdf.map(entry => entry.reference).filter(Boolean)
    const noMpnCount = icsWithoutPdf.filter(entry => entry.reason === 'no_mpn').length
    const evidence = `以下集成电路没有匹配到 PDF 数据手册：${listReferences(references)}。`
      + (noMpnCount > 0
        ? `其中 ${noMpnCount} 个元件没有 MPN，无法按型号匹配。`
        : '')
    findings.push(datasheetFinding({
      ruleId: 'DS-001',
      severity: 'should_fix',
      title: `缺少数据手册：${icsWithoutPdf.length} 个集成电路`,
      evidence,
      recommendation: '将对应数据手册 PDF 放入 datasheets/ 目录，文件名使用 MPN；'
        + '或在 datasheets/manifest.json 中登记 PDF 与 MPN 的对应关系。',
      components: references,
    }))
  }

  if (unmatchedPdfs.length > 0) {
    const names = unmatchedPdfs.map(pdf => pdf.fileName).filter(Boolean)
    findings.push(datasheetFinding({
      ruleId: 'DS-002',
      severity: 'nice_to_have',
      title: `有 ${unmatchedPdfs.length} 份数据手册未匹配到工程元件`,
      evidence: `以下 PDF 的登记或推断 MPN 与 BOM 不匹配：${listReferences(names)}。`,
      recommendation: '确认文件名或 manifest.json 中的 MPN 是否正确；'
        + '与当前工程无关的 PDF 可移出 datasheets/ 目录。',
      components: [],
    }))
  }

  const failedPlans = plans.filter(plan => plan.status === 'failed')
  if (failedPlans.length > 0) {
    const references = failedPlans.flatMap(plan => plan.references).filter(Boolean)
    const details = failedPlans
      .map(plan => `${plan.mpn}：${plan.error || '未知错误'}`)
      .join('；')
    findings.push(datasheetFinding({
      ruleId: 'DS-003',
      severity: 'should_fix',
      title: `数据手册提取计划未生成：${failedPlans.length} 个元件`,
      evidence: `以下 MPN 的提取计划生成失败：${details}。`,
      recommendation: '检查 Python 与上游 plan_extraction.py 是否可用；'
        + '若缺少 AI scout 结果，先由 AI 阅读 PDF 生成 <MPN>.scout.json 后重试。',
      components: references,
    }))
  }

  return findings
}

function datasheetFinding({ ruleId, severity, title, evidence, recommendation, components }) {
  return {
    detector: 'datasheets',
    rule_id: ruleId,
    category: 'datasheets',
    kind: 'issue',
    severity,
    confidence: 'deterministic',
    evidence_source: 'file',
    source: 'datasheets',
    title,
    summary: title,
    evidence,
    recommendation,
    components: Array.isArray(components) ? components.slice(0, MAX_VISIBLE_LIST) : [],
    nets: [],
    pins: [],
  }
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function isIcReference(reference) {
  return IC_REFERENCE_PATTERN.test(text(reference).trim())
}

function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function normalizeMpn(value) {
  return text(value).toUpperCase().replace(/[^A-Z0-9]/gu, '')
}

function uniqueStrings(values) {
  const seen = new Set()
  const result = []
  for (const value of values) {
    const content = text(value).trim()
    if (!content) continue
    const key = content.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(content)
  }
  return result
}

function listReferences(values, limit = MAX_VISIBLE_LIST) {
  const list = values.map(text).filter(Boolean)
  if (list.length === 0) return '（无）'
  const shown = list.slice(0, limit).join('、')
  return list.length > limit ? `${shown} 等 ${list.length} 个` : shown
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function readPlanTaskCount(planPath) {
  const plan = readJson(planPath)
  return Array.isArray(plan?.tasks) ? plan.tasks.length : null
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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

function truncate(value, limit) {
  const content = String(value ?? '')
  if (content.length <= limit) return content
  return `${content.slice(0, Math.max(limit - 1, 0))}…`
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}
