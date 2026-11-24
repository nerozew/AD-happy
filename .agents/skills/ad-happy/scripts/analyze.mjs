#!/usr/bin/env node
// CLI 编排：把环境自检、工程发现、原理图/PCB 解析、连通性、Python 规则层
// 与报告渲染串成一条命令。
//
// 用法：
//   node analyze.mjs --project <工程目录> [--out <输出目录>]
//                    [--board <PcbDoc 文件名>] [--svg]
//
// 退出码：0 完成；2 输入无效；3 部分完成（文档解析失败、规则 failed、
// Python 阶段异常或报告生成失败）。
//
// 产物（写入 --out 或 %LOCALAPPDATA%\ad-happy\runs\<run-id>）：
// manifest.json、snapshot.json、raw.json、pcb.json、findings.json、
// pipeline-summary.json、summary.json、report.html。
//
// 源工程只读：--out 落在源工程目录内会被直接拒绝（退出码 2）。
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSelfCheck } from './selfcheck.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PIPELINE_PY = join(SCRIPT_DIR, 'pipeline.py')

const USAGE = `用法: node analyze.mjs --project <工程目录> [--out <输出目录>] [--board <PcbDoc 文件名>] [--svg]

  --project  包含 .PrjPcb 的工程目录
  --out     输出目录；默认 %LOCALAPPDATA%\\ad-happy\\runs\\<run-id>
  --board   指定要审查的 PcbDoc 文件名；默认文档清单中最后一块
  --svg     尝试把选中板卡渲染为 SVG 内联到报告；失败只降级，不中止分析`

// 三组规则的完整键；即使某一侧输入缺失，报告也能展示全部规则状态。
const SCH_RULES = [
  'voltage_divider',
  'rc_filter',
  'decoupling',
  'power_regulator',
  'connectivity',
  'shorted_component',
]
const PCB_RULES = ['dfm', 'pad_distance', 'current_capacity', 'decoupling_placement']
const ALL_RULES = [...SCH_RULES, ...PCB_RULES, 'pin_pad']

// 每次运行开始时清理的已知产物，避免上一次的 report.html/summary.json
// 让本次失败看起来像成功。
const ARTIFACT_FILES = [
  'manifest.json',
  'snapshot.json',
  'raw.json',
  'pcb.json',
  'findings.json',
  'pipeline-summary.json',
  'summary.json',
  'report.html',
]

const SUMMARY_LIMIT = 32 * 1024 // summary.json 必须严格小于 32KB
const TOP_FINDINGS_LIMIT = 20
const SUMMARY_TEXT_LIMIT = 400

const GROUP_RANK = { must_fix: 0, should_fix: 1, nice_to_have: 2 }

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main() {
  const startedAt = new Date()
  const runId = createRunId(startedAt)

  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    console.error(`${error.message}\n\n${USAGE}`)
    return 2
  }
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  if (!options.project) {
    console.error(`缺少 --project 参数\n\n${USAGE}`)
    return 2
  }
  if (options.board !== null && !options.board.trim()) {
    console.error(`--board 不能为空\n\n${USAGE}`)
    return 2
  }
  if (options.out !== null && !options.out.trim()) {
    console.error(`--out 不能为空\n\n${USAGE}`)
    return 2
  }

  // 输入路径：工程目录。CLI 契约是文件夹；.PrjPcb 的选择由 discover 负责。
  const inputPath = resolve(options.project)
  let inputStat
  try {
    inputStat = statSync(inputPath)
  } catch {
    console.error(`工程路径不存在或不可访问: ${inputPath}`)
    return 2
  }
  if (!inputStat.isDirectory()) {
    console.error(`--project 需要工程目录（包含 .PrjPcb）: ${inputPath}`)
    return 2
  }
  const projectDir = inputPath

  const outDir = resolve(options.out ?? defaultOutDir(runId))
  if (isInside(projectDir, outDir)) {
    // 源工程只读：此处不创建任何目录/文件。
    console.error(`输出目录不能位于源工程目录内: ${outDir}`)
    return 2
  }

  let state
  try {
    mkdirSync(outDir, { recursive: true })
    const cleanupFailures = clearArtifacts(outDir)
    state = createState({ runId, startedAt, outDir, projectDir, options })
    for (const name of cleanupFailures) {
      state.warnings.push(`无法清理旧产物 ${name}，输出目录中可能残留上次运行的文件`)
    }
    writeManifest(state)
  } catch (error) {
    console.error(`无法准备输出目录 ${outDir}: ${error?.message ?? error}`)
    return 3
  }

  return execute(state)
}

async function execute(state) {
  try {
    return await executeStages(state)
  } catch (error) {
    state.errors.push({
      stage: 'unexpected',
      message: `未预期的错误: ${error?.message ?? error}`,
      details: truncateText(error?.stack ?? '', 4000),
    })
    return finalize(state, 'failed', 3)
  }
}

async function executeStages(state) {
  // 1. 环境自检。失败时不再继续，避免产出看起来正常的空结果。
  const environment = runSelfCheck()
  state.manifest.environment = environment
  if (!environment.ok) {
    state.manifest.stages.selfcheck = 'failed'
    state.errors.push({
      stage: 'selfcheck',
      message: '环境自检未通过',
      details: environment.errors,
    })
    printErrors(state)
    return finalize(state, 'failed', 3)
  }
  state.manifest.stages.selfcheck = 'pass'

  // 2. 自检通过后再加载依赖 altiumts 的模块；缺依赖时仍能留下 manifest。
  const [{ discoverProject }, { parsePcb }, { parseSch }, { buildNets }, reportModule] =
    await Promise.all([
      import('./discover.mjs'),
      import('./pcb.mjs'),
      import('./sch.mjs'),
      import('./connectivity.mjs'),
      import('./report.mjs'),
    ])

  // 3. 工程发现。ENOENT 与 NO_PROJECT 都属于输入无效（退出码 2）。
  let discovery
  try {
    discovery = discoverProject(state.projectDir)
  } catch (error) {
    state.manifest.stages.discover = 'failed'
    const message = error?.message === 'NO_PROJECT'
      ? `目录中没有 .PrjPcb：${state.projectDir}`
      : `工程发现失败：${error?.message ?? error}`
    state.errors.push({ stage: 'discover', message })
    printErrors(state)
    return finalize(state, 'invalid_input', 2)
  }
  state.manifest.stages.discover = 'pass'
  state.manifest.project.path = state.projectDir
  state.manifest.project.projectPath = discovery.projectPath
  state.manifest.project.name = projectName(discovery.projectPath)

  state.documents = discovery.documents.map(document => ({
    name: document.name,
    path: document.path,
    kind: document.kind,
    exists: existsSync(document.path),
    status: 'not_evaluated',
    reason: documentReason(document.kind),
  }))

  // 4. 选板：默认文档清单中的最后一块 PcbDoc，--board 可按文件名指定。
  const boards = state.documents.filter(document => document.kind === 'pcb')
  const schematics = state.documents.filter(document => document.kind === 'sch')
  let selectedBoard = null
  if (state.options.board) {
    selectedBoard = findBoard(boards, state.options.board)
    if (!selectedBoard) {
      state.manifest.stages.parse = 'failed'
      state.errors.push({
        stage: 'select_board',
        message: `未找到板卡 "${state.options.board}"`,
        details: boards.length
          ? `可用板卡：${boards.map(board => board.name).join('、')}`
          : '工程文档清单中没有 .PcbDoc',
      })
      printErrors(state)
      return finalize(state, 'invalid_input', 2)
    }
  } else if (boards.length > 0) {
    selectedBoard = boards[boards.length - 1]
  }
  const selectedSchematic = schematics[0] ?? null

  state.manifest.project.selectedBoard = selectedBoard?.name ?? null
  state.manifest.project.selectedSchematic = selectedSchematic?.name ?? null
  if (!selectedBoard) {
    state.warnings.push('工程中没有 .PcbDoc，PCB 与跨域规则将标记为 not_evaluated')
  }
  if (!selectedSchematic) {
    state.warnings.push('工程中没有 .SchDoc，原理图与跨域规则将标记为 not_evaluated')
  } else if (schematics.length > 1) {
    state.warnings.push(`工程包含 ${schematics.length} 份原理图，本次仅解析 ${selectedSchematic.name}`)
  }

  // 5. 解析选中的原理图与 PCB。解析失败不中止其余阶段，但会留下错误与
  //    DET-ERR finding，并把受影响的规则标记为 failed。
  let schematic = null
  let pcbSnapshot = null
  let schematicFailed = false
  let pcbFailed = false

  if (selectedSchematic) {
    delete selectedSchematic.reason
    if (!selectedSchematic.exists) {
      schematicFailed = true
      failDocument(state, selectedSchematic, '原理图', new Error('文件不存在'))
    } else {
      try {
        schematic = parseSch(selectedSchematic.path)
        selectedSchematic.status = 'parsed'
      } catch (error) {
        schematicFailed = true
        failDocument(state, selectedSchematic, '原理图', error)
      }
    }
  }

  if (selectedBoard) {
    delete selectedBoard.reason
    if (!selectedBoard.exists) {
      pcbFailed = true
      failDocument(state, selectedBoard, 'PCB', new Error('文件不存在'))
    } else {
      try {
        pcbSnapshot = parsePcb(selectedBoard.path)
        selectedBoard.status = 'parsed'
      } catch (error) {
        pcbFailed = true
        failDocument(state, selectedBoard, 'PCB', error)
      }
    }
  }

  state.manifest.stages.parse = schematicFailed || pcbFailed
    ? 'failed'
    : (selectedBoard || selectedSchematic ? 'pass' : 'skipped')

  // 6. 连通性。
  let nets = emptyNets()
  let connectivityFailed = false
  if (schematic) {
    try {
      nets = buildNets(schematic)
      state.manifest.stages.connectivity = 'pass'
    } catch (error) {
      connectivityFailed = true
      state.manifest.stages.connectivity = 'failed'
      const message = error?.message ?? String(error)
      state.errors.push({ stage: 'connectivity', message: `原理图连通性构建失败: ${message}` })
      state.syntheticFindings.push(connectivityFailureFinding(message))
    }
  } else {
    state.manifest.stages.connectivity = 'skipped'
  }

  state.manifest.project.boards = boards.map(board => ({
    name: board.name,
    selected: board === selectedBoard,
    status: board.status,
  }))

  // 7. 写出可复现的中间数据。即使解析失败，也保留失败前的真实内容。
  const generatedAt = displayTimestamp(new Date())
  const projectMeta = {
    name: state.manifest.project.name,
    folder: state.manifest.project.folder,
    path: state.projectDir,
    projectPath: discovery.projectPath,
    selectedBoard: state.manifest.project.selectedBoard,
    selectedSchematic: state.manifest.project.selectedSchematic,
    boards: state.manifest.project.boards,
  }
  const snapshotPath = join(state.outDir, 'snapshot.json')
  const rawPath = join(state.outDir, 'raw.json')
  const pcbPath = join(state.outDir, 'pcb.json')
  writeJson(snapshotPath, {
    schemaVersion: 1,
    generatedAt,
    project: projectMeta,
    documents: state.documents,
    schematic,
    pcb: pcbSnapshot,
  })
  state.artifacts.snapshot = 'snapshot.json'
  writeJson(rawPath, {
    schematic: schematic ?? emptySchematic(),
    nets,
  })
  state.artifacts.raw = 'raw.json'
  writeJson(pcbPath, pcbSnapshot ?? {})
  state.artifacts.pcb = 'pcb.json'

  // 8. Python 侧唯一入口。非零退出或输出不合法时不得产出「0 问题」的假报告。
  //    -X utf8 保证 Windows 管道下的 stdout/stderr 是 UTF-8，Node 按 UTF-8 解码。
  const python = spawnSync(
    'python',
    ['-X', 'utf8', PIPELINE_PY, '--raw', rawPath, '--pcb', pcbPath, '--out', state.outDir],
    {
      cwd: state.outDir,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    },
  )
  if (python.error || python.status !== 0) {
    state.manifest.stages.python = 'failed'
    const reason = python.error
      ? `无法启动 python：${python.error.message}`
      : `退出码 ${python.status}`
    const detail = firstText(python.stderr, python.stdout) || '（无错误输出）'
    state.errors.push({
      stage: 'python',
      message: 'Python 分析阶段失败',
      details: `${reason}：${truncateText(detail, 4000)}`,
    })
    printErrors(state)
    return finalize(state, 'failed', 3)
  }

  let pipelineSummary
  try {
    pipelineSummary = readPipelineSummary(state.outDir)
  } catch (error) {
    state.manifest.stages.python = 'failed'
    state.errors.push({
      stage: 'python',
      message: 'Python 输出 JSON 不合法',
      details: error?.message ?? String(error),
    })
    printErrors(state)
    return finalize(state, 'failed', 3)
  }
  state.manifest.stages.python = 'pass'
  state.artifacts.findings = 'findings.json'
  state.artifacts.pipelineSummary = 'pipeline-summary.json'

  // 9. 合并状态：缺失输入对应的规则保持 Python 给出的 not_evaluated；
  //    解析/连通性失败对应的规则强制为 failed，让失败在报告里可见。
  const failedRules = new Set()
  if (schematicFailed || connectivityFailed) {
    for (const rule of SCH_RULES) failedRules.add(rule)
  }
  if (pcbFailed) {
    for (const rule of PCB_RULES) failedRules.add(rule)
  }
  if (schematicFailed || connectivityFailed || pcbFailed) failedRules.add('pin_pad')

  // 用 null 原型对象承接外部键，避免 "__proto__" 之类的键触发原型赋值。
  const ruleStatus = Object.create(null)
  for (const rule of ALL_RULES) ruleStatus[rule] = 'not_evaluated'
  for (const [rule, value] of Object.entries(pipelineSummary.status)) {
    if (typeof value === 'string') ruleStatus[rule] = value
  }
  for (const rule of failedRules) ruleStatus[rule] = 'failed'

  const findings = [
    ...state.syntheticFindings,
    ...pipelineSummary.findings.filter(isPlainObject),
  ]
  // Python 只写规则层 findings；解析/连通性失败的 DET-ERR 由 Node 补充，
  // 保证 findings.json 是完整交付物（报告与 summary 使用同一份合并结果）。
  if (state.syntheticFindings.length > 0) {
    writeJson(join(state.outDir, 'findings.json'), findings)
  }

  const parsedDocuments = state.documents.filter(document => document.status === 'parsed').length
  const coverage = {
    documents: state.documents.length,
    parsed: parsedDocuments,
    notEvaluated: state.documents.length - parsedDocuments,
  }
  const missingInputs = []
  if (!selectedBoard) missingInputs.push('pcb')
  if (!selectedSchematic) missingInputs.push('schematic')

  // 10. 可选 SVG。失败只降级为不传并记录原因，绝不让整个分析失败。
  const svgs = await renderSvg(state, pcbSnapshot, selectedBoard)

  // 11. 报告。渲染失败视为部分完成，但仍保留 findings/summary 供排查。
  const reportPath = join(state.outDir, 'report.html')
  let reportWritten = false
  try {
    const html = reportModule.renderReport({
      project: state.manifest.project.name ?? basename(state.projectDir),
      generatedAt,
      coverage,
      findings,
      status: ruleStatus,
      svgs,
    })
    writeFileSync(reportPath, html, 'utf8')
    state.artifacts.report = 'report.html'
    state.manifest.stages.report = 'pass'
    reportWritten = true
  } catch (error) {
    state.manifest.stages.report = 'failed'
    state.errors.push({
      stage: 'report',
      message: '报告渲染失败',
      details: error?.message ?? String(error),
    })
  }

  const ruleFailure = Object.values(ruleStatus).includes('failed')
  const partial = state.errors.length > 0
    || missingInputs.length > 0
    || ruleFailure
  const overallStatus = partial ? 'partial' : 'complete'

  // 12. summary.json：只放模型需要读的概览、覆盖、计数与 top findings。
  const summary = buildSummary(state, {
    coverage,
    status: ruleStatus,
    findings,
    generatedAt,
    overallStatus,
    reportPath: reportWritten ? reportPath : null,
    crossCoverage: pipelineSummary.coverage,
    severityGroup: reportModule.severityGroup,
  })
  try {
    const summaryText = fitSummaryText(summary)
    writeFileSync(join(state.outDir, 'summary.json'), summaryText, 'utf8')
    state.artifacts.summary = 'summary.json'
  } catch (error) {
    state.errors.push({
      stage: 'summary',
      message: 'summary.json 写入失败',
      details: error?.message ?? String(error),
    })
    printErrors(state)
    return finalize(state, 'failed', 3)
  }

  const exitCode = overallStatus === 'complete' ? 0 : 3
  printCompletion(state, summary, reportWritten ? reportPath : null, exitCode)
  return finalize(state, overallStatus, exitCode)
}

// ---------------------------------------------------------------------------
// Python 输出与状态
// ---------------------------------------------------------------------------

function readPipelineSummary(outDir) {
  const summaryPath = join(outDir, 'pipeline-summary.json')
  let summary
  try {
    summary = JSON.parse(readFileSync(summaryPath, 'utf8'))
  } catch (error) {
    throw new Error(`无法读取 ${summaryPath}: ${error?.message ?? error}`)
  }
  if (!isPlainObject(summary)) throw new Error('pipeline-summary.json 必须是对象')
  if (!Array.isArray(summary.findings)) throw new Error('pipeline-summary.json 缺少 findings 数组')
  if (!isPlainObject(summary.status)) throw new Error('pipeline-summary.json 缺少 status 对象')
  if (!isPlainObject(summary.coverage)) throw new Error('pipeline-summary.json 缺少 coverage 对象')

  const findingsPath = join(outDir, 'findings.json')
  let deliverable
  try {
    deliverable = JSON.parse(readFileSync(findingsPath, 'utf8'))
  } catch (error) {
    throw new Error(`无法读取 ${findingsPath}: ${error?.message ?? error}`)
  }
  if (!Array.isArray(deliverable)) throw new Error('findings.json 必须是数组')
  if (deliverable.length !== summary.findings.length) {
    throw new Error(
      `findings.json（${deliverable.length} 条）与 pipeline-summary.json（${summary.findings.length} 条）不一致`,
    )
  }
  return summary
}

// ---------------------------------------------------------------------------
// summary.json
// ---------------------------------------------------------------------------

function buildSummary(state, context) {
  const {
    coverage,
    status,
    findings,
    generatedAt,
    overallStatus,
    reportPath,
    crossCoverage,
    severityGroup,
  } = context

  const severityCounts = { must_fix: 0, should_fix: 0, nice_to_have: 0 }
  for (const finding of findings) {
    severityCounts[severityGroup(finding.severity)] += 1
  }
  const ruleCounts = Object.assign(Object.create(null), {
    pass: 0,
    found: 0,
    not_evaluated: 0,
    failed: 0,
  })
  for (const value of Object.values(status)) {
    ruleCounts[value] = (ruleCounts[value] ?? 0) + 1
  }

  const { top, omitted } = selectTopFindings(findings, severityGroup)

  return {
    schemaVersion: 1,
    project: {
      name: state.manifest.project.name ?? basename(state.projectDir),
      folder: state.manifest.project.folder,
      path: state.projectDir,
      projectPath: state.manifest.project.projectPath,
      selectedBoard: state.manifest.project.selectedBoard,
      selectedSchematic: state.manifest.project.selectedSchematic,
      boards: state.manifest.project.boards,
    },
    generatedAt,
    status: overallStatus,
    coverage: {
      ...coverage,
      crossCheck: summarizeCrossCoverage(crossCoverage),
    },
    counts: {
      must_fix: severityCounts.must_fix,
      should_fix: severityCounts.should_fix,
      nice_to_have: severityCounts.nice_to_have,
      total: findings.length,
      rules: ruleCounts,
    },
    rules: status,
    findings: top,
    findingsOmitted: omitted,
    report: reportPath,
  }
}

function selectTopFindings(findings, severityGroup, limit = TOP_FINDINGS_LIMIT) {
  const ranked = findings.map((finding, index) => ({
    finding,
    index,
    group: severityGroup(finding.severity),
  }))
  ranked.sort((a, b) => (
    GROUP_RANK[a.group] - GROUP_RANK[b.group]
    || compareText(scalarText(a.finding.rule_id), scalarText(b.finding.rule_id))
    || a.index - b.index
  ))
  const top = ranked
    .slice(0, limit)
    .map(entry => summarizeFinding(entry.finding, entry.group))
  return { top, omitted: Math.max(findings.length - top.length, 0) }
}

function summarizeFinding(finding, group) {
  const entry = {
    rule_id: scalarText(finding.rule_id),
    severity: scalarText(finding.severity),
    group,
    title: truncateText(
      scalarText(finding.summary) || scalarText(finding.title) || scalarText(finding.description),
      300,
    ),
    evidence: truncateText(
      finding.evidence !== undefined ? evidenceText(finding.evidence) : scalarText(finding.description),
      SUMMARY_TEXT_LIMIT,
    ),
    components: locatorList(finding.components, scalarText),
    nets: locatorList(finding.nets, scalarText),
    pins: locatorList(finding.pins, pinText),
  }
  const recommendation = truncateText(
    scalarText(finding.recommendation) || scalarText(finding.advice),
    240,
  )
  if (recommendation) entry.recommendation = recommendation
  return entry
}

function summarizeCrossCoverage(coverage) {
  const source = isPlainObject(coverage) ? coverage : {}
  return {
    compared: numberOrZero(source.compared),
    exact: numberOrZero(source.exact),
    byNetName: numberOrZero(source.by_net_name),
    netAliases: Array.isArray(source.net_aliases) ? source.net_aliases.length : 0,
    skipped: Array.isArray(source.skipped) ? source.skipped.length : 0,
  }
}

// 保证 summary.json 严格小于 32KB：先按条数丢弃 top findings，再截断板卡清单。
function fitSummaryText(summary) {
  let text = serializeSummary(summary)
  while (Buffer.byteLength(text, 'utf8') >= SUMMARY_LIMIT && summary.findings.length > 0) {
    summary.findings.pop()
    summary.findingsOmitted += 1
    text = serializeSummary(summary)
  }
  if (
    Buffer.byteLength(text, 'utf8') >= SUMMARY_LIMIT
    && summary.project.boards.length > 50
  ) {
    summary.project.boardsTruncated = summary.project.boards.length - 50
    summary.project.boards = summary.project.boards.slice(0, 50)
    text = serializeSummary(summary)
  }
  if (Buffer.byteLength(text, 'utf8') >= SUMMARY_LIMIT) {
    throw new Error(
      `summary.json 无法压缩到 32KB 以内（当前 ${Buffer.byteLength(text, 'utf8')} 字节）`,
    )
  }
  return text
}

function serializeSummary(summary) {
  return `${JSON.stringify(summary, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// SVG（可选，失败降级）
// ---------------------------------------------------------------------------

async function renderSvg(state, pcbSnapshot, selectedBoard) {
  if (!state.options.svg) return []
  if (!selectedBoard || !pcbSnapshot) {
    state.svg.reason = '没有可渲染的板卡'
    return []
  }
  try {
    const { parseAltiumFile, serializeAltiumPcbToSvg } = await import('altiumts')
    const { document } = parseAltiumFile(new Uint8Array(readFileSync(selectedBoard.path)))
    const svg = serializeAltiumPcbToSvg(document)
    if (typeof svg !== 'string' || !svg.trim()) throw new Error('渲染结果为空')
    state.svg.rendered = true
    return [{ title: `${selectedBoard.name} 板图`, svg }]
  } catch (error) {
    state.svg.reason = error?.message ?? String(error)
    state.warnings.push(`SVG 渲染失败，已降级为不内联：${state.svg.reason}`)
    return []
  }
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

function createState({ runId, startedAt, outDir, projectDir, options }) {
  const state = {
    runId,
    startedAt,
    startedMs: Date.now(),
    outDir,
    projectDir,
    options,
    errors: [],
    warnings: [],
    documents: [],
    syntheticFindings: [],
    artifacts: { manifest: 'manifest.json' },
    svg: { requested: Boolean(options.svg), rendered: false },
    manifest: {
      schemaVersion: 1,
      run: {
        id: runId,
        startedAt: startedAt.toISOString(),
        argv: process.argv.slice(2),
        cwd: process.cwd(),
        outDir,
      },
      project: {
        name: null,
        folder: basename(projectDir),
        path: projectDir,
        projectPath: null,
        selectedBoard: null,
        selectedSchematic: null,
        boards: [],
      },
      environment: null,
      stages: {
        selfcheck: 'skipped',
        discover: 'skipped',
        parse: 'skipped',
        connectivity: 'skipped',
        python: 'skipped',
        report: 'skipped',
      },
      documents: [],
      errors: [],
      warnings: [],
      svg: null,
      artifacts: null,
      status: 'running',
      exitCode: null,
    },
  }
  state.manifest.svg = state.svg
  state.manifest.artifacts = state.artifacts
  return state
}

function writeManifest(state) {
  state.manifest.documents = state.documents
  state.manifest.errors = state.errors
  state.manifest.warnings = state.warnings
  state.manifest.svg = state.svg
  state.manifest.artifacts = state.artifacts
  writeJson(join(state.outDir, 'manifest.json'), state.manifest)
}

function finalize(state, status, exitCode) {
  state.manifest.status = status
  state.manifest.exitCode = exitCode
  state.manifest.finishedAt = new Date().toISOString()
  state.manifest.durationMs = Date.now() - state.startedMs
  state.manifest.project.boards = state.manifest.project.boards ?? []
  try {
    writeManifest(state)
  } catch (error) {
    console.error(`无法写入 manifest.json: ${error?.message ?? error}`)
    return 3
  }
  return exitCode
}

// ---------------------------------------------------------------------------
// 文档选择与失败记录
// ---------------------------------------------------------------------------

const DOCUMENT_REASONS = {
  lib: '库文件不做独立解析',
  pcb: '仅解析选中的板卡',
  sch: '仅解析第一份原理图',
}

function documentReason(kind) {
  return DOCUMENT_REASONS[kind] ?? '未参与本次分析'
}

function findBoard(boards, wanted) {
  const needle = basename(String(wanted)).toLowerCase()
  const withExtension = needle.endsWith('.pcbdoc') ? needle : `${needle}.pcbdoc`
  return boards.find(board => board.name.toLowerCase() === needle)
    ?? boards.find(board => board.name.toLowerCase() === withExtension)
    ?? null
}

function failDocument(state, document, label, error) {
  const message = error?.message ?? String(error)
  document.status = 'failed'
  document.error = truncateText(message, 1000)
  delete document.reason
  state.errors.push({
    stage: 'parse',
    message: `${label} ${document.name} 解析失败: ${message}`,
  })
  state.syntheticFindings.push({
    detector: 'parse',
    rule_id: 'DET-ERR',
    category: 'analysis_error',
    severity: 'error',
    confidence: 'deterministic',
    evidence_source: 'file',
    summary: `${label} ${document.name} 解析失败: ${truncateText(message, 300)}`,
    description: '文件读取或解析失败，相关规则已标记为 failed；其余文档不受影响。',
    recommendation: '确认文件存在且未被其他程序占用，或重新导出该文档后重试。',
    components: [],
    nets: [],
    pins: [],
    source: 'node',
  })
}

function connectivityFailureFinding(message) {
  return {
    detector: 'connectivity',
    rule_id: 'DET-ERR',
    category: 'analysis_error',
    severity: 'error',
    confidence: 'deterministic',
    evidence_source: 'topology',
    summary: `原理图连通性构建失败: ${truncateText(message, 300)}`,
    description: '无法从原理图重建网表，原理图相关规则与跨域检查已标记为 failed。',
    recommendation: '检查 SchDoc 的导线/引脚数据是否完整，或重新导出原理图后重试。',
    components: [],
    nets: [],
    pins: [],
    source: 'node',
  }
}

// ---------------------------------------------------------------------------
// 输出辅助
// ---------------------------------------------------------------------------

function emptySchematic() {
  return {
    components: [],
    pins: [],
    wires: [],
    labels: [],
    powerPorts: [],
    junctions: [],
  }
}

function emptyNets() {
  return {
    nets: {},
    pinNet: {},
    stats: { pinsMatched: 0, pinsTotal: 0, nets: 0 },
  }
}

function printErrors(state) {
  for (const error of state.errors) {
    console.error(`[${error.stage}] ${error.message}`)
    const details = Array.isArray(error.details)
      ? error.details.join('；')
      : error.details
    if (details) console.error(details)
  }
}

function printCompletion(state, summary, reportPath, exitCode) {
  const counts = summary.counts
  const env = state.manifest.environment ?? {}
  console.log(
    `AD-Happy 分析${exitCode === 0 ? '完成' : '部分完成'}（${state.runId}）`,
  )
  console.log(
    `工程：${summary.project.name}；板卡：${summary.project.selectedBoard ?? '（无）'}`,
  )
  console.log(
    `文档：${summary.coverage.documents}，已解析 ${summary.coverage.parsed}，未评估 ${summary.coverage.notEvaluated}`,
  )
  console.log(
    `问题：必须修复 ${counts.must_fix} / 建议修复 ${counts.should_fix} / 可优化 ${counts.nice_to_have}`,
  )
  if (reportPath) console.log(`报告：${reportPath}`)
  console.log(
    `版本：Node ${env.node ?? '?'} / altiumts ${env.altiumts ?? '?'} / Python ${env.python ?? '?'}`,
  )
  for (const error of state.errors) {
    console.error(`[${error.stage}] ${error.message}`)
  }
}

// ---------------------------------------------------------------------------
// CLI 参数与路径
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    project: null,
    out: null,
    board: null,
    svg: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const equals = argument.indexOf('=')
    const key = equals === -1 ? argument : argument.slice(0, equals)
    const inline = equals === -1 ? undefined : argument.slice(equals + 1)

    switch (key) {
      case '--project': {
        const taken = takeValue(key, inline, argv, index)
        options.project = taken.value
        index = taken.index
        break
      }
      case '--out': {
        const taken = takeValue(key, inline, argv, index)
        options.out = taken.value
        index = taken.index
        break
      }
      case '--board': {
        const taken = takeValue(key, inline, argv, index)
        options.board = taken.value
        index = taken.index
        break
      }
      case '--svg':
        options.svg = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new UsageError(`未知参数: ${argument}`)
    }
  }
  return options
}

function takeValue(key, inline, argv, index) {
  if (inline !== undefined) return { value: inline, index }
  if (index + 1 >= argv.length) throw new UsageError(`${key} 缺少参数`)
  return { value: argv[index + 1], index: index + 1 }
}

function defaultOutDir(runId) {
  const base = process.env.LOCALAPPDATA?.trim()
    || join(homedir(), '.local', 'share')
  return join(base, 'ad-happy', 'runs', runId)
}

function createRunId(now) {
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  ].join('')
    + '-'
    + [
      pad(now.getHours()),
      pad(now.getMinutes()),
      pad(now.getSeconds()),
    ].join('')
  const suffix = Math.random().toString(16).slice(2, 6).padEnd(4, '0')
  return `${stamp}-${suffix}`
}

function displayTimestamp(date) {
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function projectName(projectPath) {
  return basename(projectPath).replace(/\.prjpcb$/i, '')
}

function isInside(parent, child) {
  const relation = relative(resolve(parent), resolve(child))
  if (relation === '') return true
  if (isAbsolute(relation)) return false
  // 只把 ".." 与 "..<sep>..." 视为父目录；名为 "..foo" 的同级目录仍在内部。
  return relation !== '..' && !relation.startsWith(`..${sep}`)
}

function clearArtifacts(outDir) {
  const failures = []
  for (const name of ARTIFACT_FILES) {
    try {
      rmSync(join(outDir, name), { force: true })
    } catch {
      // 不静默：清理失败会写入 manifest.warnings，避免旧报告被误认为本次结果。
      failures.push(name)
    }
  }
  return failures
}

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

// ---------------------------------------------------------------------------
// 文本辅助
// ---------------------------------------------------------------------------

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

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

function truncateText(value, limit) {
  const text = String(value ?? '')
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(limit - 1, 0))}…`
}

function evidenceText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return value.map(evidenceText).filter(Boolean).join('；')
  }
  if (isPlainObject(value)) {
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

function locatorList(values, format) {
  if (!Array.isArray(values)) return []
  return values.map(format).filter(Boolean)
}

function pinText(pin) {
  if (isPlainObject(pin)) {
    const reference = scalarText(pin.component ?? pin.ref ?? pin.reference)
    const number = scalarText(pin.number ?? pin.pin ?? pin.pin_number)
    if (reference && number) return `${reference}.${number}`
    return reference || number || ''
  }
  return scalarText(pin)
}

// 作为 CLI 直接执行；返回码写入 process.exitCode，让 stdout/stderr 完整刷出。
main()
  .then(code => {
    process.exitCode = code
  })
  .catch(error => {
    console.error(error?.stack ?? error)
    process.exitCode = 3
  })
