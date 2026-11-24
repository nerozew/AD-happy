#!/usr/bin/env node
// CLI 编排：把环境自检、工程发现、原理图/PCB 解析、连通性、Python 规则层
// 与报告渲染串成一条命令。
//
// 用法：
//   node analyze.mjs --project <工程目录或 .PrjPcb> [--out <输出目录>]
//                    [--project-file <PrjPcb 文件名>]
//                    [--board <PcbDoc 文件名>] [--gerber <Gerber 目录>]
//                    [--bom <CSV>] [--datasheets <目录>] [--spice] [--emc] [--svg]
//
// 退出码：0 完成；2 输入无效；3 部分完成（文档解析失败、规则 failed、
// Python/Gerber 阶段异常或报告生成失败）。
//
// 产物（写入 --out 或 %LOCALAPPDATA%\ad-happy\runs\<run-id>）：
// manifest.json、snapshot.json、raw.json、pcb.json、findings.json、
// pipeline-summary.json、gerber.json、bom.csv、procurement.csv、
// datasheets.json、spice.json（仅在 --spice 时）、summary.json、report.html。
//
// 源工程只读：--out 落在源工程目录内会被直接拒绝（退出码 2）。
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
import {
  NATIVE_RULES,
  detectAdAvailability,
  discoverLibraries,
  emptyNativeCoverage,
  nativeFailureFinding,
  runNativeChecks,
} from './ad/ad.mjs'
import {
  bomErrorFinding,
  buildBom,
  dedupeBomFindings,
  diffBom,
  exportBom,
  exportProcurement,
  importBomCsv,
  recomputeBomStatus,
} from './bom.mjs'
import {
  emptyDatasheetsCoverage,
  evaluateDatasheets,
  summarizeComponents,
} from './datasheets.mjs'
import {
  buildEmcInputs,
  emptyEmcCoverage,
  runEmc,
  unavailableEmcCoverage,
} from './reuse/emc.mjs'
import {
  detectGerberDirectory,
  emptyGerberCoverage,
  runGerberAnalysis,
} from './reuse/gerber.mjs'
import { runSelfCheck } from './selfcheck.mjs'
import {
  detectSimulators,
  emptySpiceCoverage,
  runSpice,
  spiceErrorFinding,
} from './spice.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PIPELINE_PY = join(SCRIPT_DIR, 'pipeline.py')

const USAGE = `用法: node analyze.mjs --project <工程目录或 .PrjPcb> [--out <输出目录>] [--project-file <PrjPcb 文件名>] [--board <PcbDoc 文件名>] [--gerber <Gerber 目录>] [--bom <CSV>] [--datasheets <目录>] [--spice] [--emc] [--with-ad] [--svg]

  --project        包含 .PrjPcb 的工程目录，或 .PrjPcb 文件路径
  --out            输出目录；默认 %LOCALAPPDATA%\\ad-happy\\runs\\<run-id>
  --project-file   目录中有多个 .PrjPcb 时指定要审查的工程文件名（或路径）
  --board          指定要审查的 PcbDoc 文件名；默认文档清单中最后一块
  --gerber         指定 Gerber/钻孔输出目录；省略时自动查找工程下的
                   Gerber、Outputs、Project Outputs、Manufacturing 目录
  --bom            导入 Altium 导出的 BOM CSV，与解析到的元件比对；
                   省略时按解析数据生成 bom.csv 与 procurement.csv
  --datasheets     指定数据手册（PDF）目录；省略时自动查找工程下的
                   datasheets 目录。只检查覆盖与提取计划，不解析引脚表
  --spice          运行 SPICE 仿真（可选，默认关闭）。自动检测 ngspice、
                   LTspice、Xyce；找不到时标记未评估，不伪造结果
  --emc            运行 EMC 预合规分析（可选，默认关闭）。复用 kicad-happy
                   的 EMC 规则；缺少铺铜/层切换等数据时相关类别标记未评估，
                   不改变退出码
  --with-ad        深度模式：通过本机 AD-MCP 调用 Altium 原生 ERC/DRC 与
                   库符号/封装原语。需要 Altium Designer 已运行且 AD-MCP 可用；
                   不可用时退出码 2，不会静默退回离线结果
  --svg            尝试把选中板卡渲染为 SVG 内联到报告；失败只降级，不中止分析`

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
// gerber 是制造文件（Gerber/钻孔）检查，独立于原理图/PCB 解析；
// bom 是物料清单检查，datasheets 是数据手册覆盖与提取计划检查，
// spice 是可选的 SPICE 仿真检查，emc 是可选的 EMC 预合规检查；
// 它们都独立于 Python 规则层。
const ALL_RULES = [
  ...SCH_RULES,
  ...PCB_RULES,
  'pin_pad',
  'gerber',
  'bom',
  'datasheets',
  'spice',
  'emc',
  ...NATIVE_RULES,
]
// 这些规则依赖原理图网表（decoupling 还依赖可解析电容值）；引脚未全部
// 入网时，空结果不能视为通过。
const NETLIST_DEPENDENT_RULES = [
  'voltage_divider',
  'rc_filter',
  'decoupling',
  'power_regulator',
  'shorted_component',
]

// 每次运行开始时清理的已知产物，避免上一次的 report.html/summary.json
// 让本次失败看起来像成功。
const ARTIFACT_FILES = [
  'manifest.json',
  'snapshot.json',
  'raw.json',
  'pcb.json',
  'findings.json',
  'pipeline-summary.json',
  'gerber.json',
  'bom.csv',
  'procurement.csv',
  'datasheets.json',
  'spice.json',
  'emc.json',
  'ad.json',
  'capability_mode.json',
  'summary.json',
  'report.html',
]

// 本次运行会重建的目录产物；spice/ 里是上一次的测试台与日志，
// emc-input/ 里是上一次的适配输入与上游原始输出，ad/ 里是 MCP 请求、
// 原始结果与 AD-MCP 的 per-run home，不能留到下一次运行被误认成本次结果。
// datasheets/ 是跨运行缓存，不在清理范围内。
const ARTIFACT_DIRS = ['spice', 'emc-input', 'ad']

const SUMMARY_LIMIT = 32 * 1024 // summary.json 必须严格小于 32KB
const TOP_FINDINGS_LIMIT = 20
const SUMMARY_TEXT_LIMIT = 400
// 大文件与 Python 进程都需要硬边界，避免把工具拖死或写满内存。
const MAX_INPUT_BYTES = 50 * 1024 * 1024
const PYTHON_TIMEOUT_MS = 120 * 1000

// 输出目录所有权标记：只有带匹配标记的已有目录才允许清理固定产物，
// 避免 --out 指向用户自己的目录时误删同名文件。
const RUN_MARKER = '.ad-happy-run'
const RUN_MARKER_SCHEMA = 1

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
  if (options.projectFile !== null && !options.projectFile.trim()) {
    console.error(`--project-file 不能为空\n\n${USAGE}`)
    return 2
  }
  if (options.gerber !== null && !options.gerber.trim()) {
    console.error(`--gerber 不能为空\n\n${USAGE}`)
    return 2
  }
  if (options.bom !== null && !options.bom.trim()) {
    console.error(`--bom 不能为空\n\n${USAGE}`)
    return 2
  }
  if (options.datasheets !== null && !options.datasheets.trim()) {
    console.error(`--datasheets 不能为空\n\n${USAGE}`)
    return 2
  }

  // 输入路径：工程目录，或直接给 .PrjPcb 文件。
  const inputPath = resolve(options.project)
  let inputStat
  try {
    inputStat = statSync(inputPath)
  } catch {
    console.error(`工程路径不存在或不可访问: ${inputPath}`)
    return 2
  }
  let projectDir
  if (inputStat.isDirectory()) {
    projectDir = inputPath
  } else if (inputStat.isFile() && inputPath.toLowerCase().endsWith('.prjpcb')) {
    projectDir = dirname(inputPath)
    // 直接给工程文件等价于 --project-file；显式参数优先。
    if (options.projectFile === null) options.projectFile = inputPath
  } else {
    console.error(`--project 需要工程目录或 .PrjPcb 文件: ${inputPath}`)
    return 2
  }

  // 显式 --gerber 必须是已存在的目录；省略时在 executeStages 中自动发现。
  if (options.gerber !== null) {
    const gerberPath = resolve(options.gerber)
    let gerberStat
    try {
      gerberStat = statSync(gerberPath)
    } catch {
      console.error(`Gerber 目录不存在或不可访问: ${gerberPath}`)
      return 2
    }
    if (!gerberStat.isDirectory()) {
      console.error(`--gerber 需要目录: ${gerberPath}`)
      return 2
    }
    options.gerber = gerberPath
  }

  // 显式 --bom 必须是已存在的文件；格式在 BOM 阶段解析，失败不中止其余结果。
  if (options.bom !== null) {
    const bomPath = resolve(options.bom)
    let bomStat
    try {
      bomStat = statSync(bomPath)
    } catch {
      console.error(`BOM 文件不存在或不可访问: ${bomPath}`)
      return 2
    }
    if (!bomStat.isFile()) {
      console.error(`--bom 需要文件: ${bomPath}`)
      return 2
    }
    options.bom = bomPath
  }

  // 显式 --datasheets 必须是已存在的目录；省略时在阶段内自动查找
  // 工程下的 datasheets 目录，找不到时标记 not_evaluated，不静默通过。
  if (options.datasheets !== null) {
    const datasheetsPath = resolve(options.datasheets)
    let datasheetsStat
    try {
      datasheetsStat = statSync(datasheetsPath)
    } catch {
      console.error(`数据手册目录不存在或不可访问: ${datasheetsPath}`)
      return 2
    }
    if (!datasheetsStat.isDirectory()) {
      console.error(`--datasheets 需要目录: ${datasheetsPath}`)
      return 2
    }
    options.datasheets = datasheetsPath
  }

  // 深度模式：先确认 AD-MCP 与 Altium 可用，再创建输出目录。用户明确
  // 要求原生检查时，不可用必须是退出码 2，不能静默退回离线结果。
  let adAvailability = null
  if (options.withAd) {
    adAvailability = detectAdAvailability()
    if (!adAvailability.available) {
      console.error('深度模式（--with-ad）不可用，未执行分析。')
      console.error(`原因：${adAvailability.reason}`)
      for (const prerequisite of adAvailability.prerequisites ?? []) {
        console.error(`需要：${prerequisite}`)
      }
      if (adAvailability.installCommand) {
        console.error(`安装命令：${adAvailability.installCommand}`)
      }
      console.error('如果只需要离线结果，请去掉 --with-ad 重新运行。')
      return 2
    }
  }

  const outDir = resolve(options.out ?? defaultOutDir(runId))
  if (isInside(projectDir, outDir)) {
    // 源工程只读：此处不创建任何目录/文件。
    console.error(`输出目录不能位于源工程目录内: ${outDir}`)
    return 2
  }

  let state
  const outProblem = prepareOutDir(outDir)
  if (outProblem) {
    console.error(outProblem)
    return 2
  }
  try {
    const cleanupFailures = clearArtifacts(
      outDir,
      // --bom 可能指向上一次运行生成的 bom.csv：先读后清会失败，因此保留输入文件。
      new Set(options.bom ? [resolve(options.bom)] : []),
    )
    state = createState({ runId, startedAt, outDir, projectDir, options, adAvailability })
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
    discovery = discoverProject(state.projectDir, {
      projectFile: state.options.projectFile ?? undefined,
    })
  } catch (error) {
    state.manifest.stages.discover = 'failed'
    const message = error?.message === 'NO_PROJECT'
      ? `目录中没有 .PrjPcb：${state.projectDir}`
      : `工程发现失败：${error?.message ?? error}`
    state.errors.push({ stage: 'discover', message })
    printErrors(state)
    return finalize(state, 'invalid_input', 2)
  }
  if (!discovery.projectPath) {
    // 多工程且未指定：必须让用户选择，不能静默取字典序第一个。
    state.manifest.stages.discover = 'failed'
    const candidates = discovery.projectPaths.map(path => basename(path))
    const requested = state.options.projectFile
    state.errors.push({
      stage: 'discover',
      message: requested
        ? `未找到指定的工程文件 "${requested}"`
        : `目录中有 ${candidates.length} 个 .PrjPcb，请用 --project-file 指定`,
      details: `候选：${candidates.join('、')}`,
    })
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
        checkInputSize(selectedSchematic.path, '原理图')
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
        checkInputSize(selectedBoard.path, 'PCB')
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

  // 工程概览：两侧的规模与原理图引脚入网率。引脚未全部入网时，
  // 依赖网表的原理图规则不能当作「通过」。
  const netStats = nets.stats ?? { pinsMatched: 0, pinsTotal: 0, nets: 0 }
  const pinsTotal = netStats.pinsTotal || schematic?.pins?.length || 0
  const pinsMatched = netStats.pinsMatched || 0
  const overview = {
    schematic: {
      components: schematic?.components?.length ?? 0,
      pins: schematic?.pins?.length ?? 0,
      nets: Object.keys(nets.nets ?? {}).length,
      pinsMatched,
      pinsTotal,
      pinsMatchRate: pinsTotal > 0
        ? Number((pinsMatched / pinsTotal).toFixed(4))
        : null,
    },
    pcb: {
      components: pcbSnapshot?.components?.length ?? 0,
      pads: pcbSnapshot?.pads?.length ?? 0,
      nets: pcbSnapshot?.nets?.length ?? 0,
      tracks: pcbSnapshot?.tracks?.length ?? 0,
      arcs: pcbSnapshot?.arcs?.length ?? 0,
      vias: pcbSnapshot?.vias?.length ?? 0,
      rules: pcbSnapshot?.rules?.length ?? 0,
    },
  }
  const netlistIncomplete = Boolean(schematic)
    && !connectivityFailed
    && pinsTotal > 0
    && pinsMatched < pinsTotal
  if (netlistIncomplete) {
    state.warnings.push(
      `原理图网表匹配不完整：${pinsMatched}/${pinsTotal} 个引脚入网，`
      + '依赖网表的原理图规则已降级为 not_evaluated',
    )
  }

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
  const snapshotData = {
    schemaVersion: 1,
    generatedAt,
    project: projectMeta,
    documents: state.documents,
    schematic,
    pcb: pcbSnapshot,
  }
  writeJson(snapshotPath, snapshotData)
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
    // -B：不向只读的 kicad-happy 目录写 __pycache__；-X utf8：Windows 管道固定 UTF-8。
    ['-B', '-X', 'utf8', PIPELINE_PY, '--raw', rawPath, '--pcb', pcbPath, '--out', state.outDir],
    {
      cwd: state.outDir,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      timeout: PYTHON_TIMEOUT_MS,
    },
  )
  if (python.error || python.status !== 0) {
    state.manifest.stages.python = 'failed'
    const reason = python.error
      ? python.error.code === 'ETIMEDOUT'
        ? `Python 分析阶段超时（${PYTHON_TIMEOUT_MS / 1000} 秒）`
        : `无法启动 python：${python.error.message}`
      : `退出码 ${python.status}`
    const detail = firstText(python.stderr, python.stdout) || '（无错误输出）'
    state.errors.push({
      stage: 'python',
      message: python.error?.code === 'ETIMEDOUT'
        ? 'Python 分析阶段超时'
        : 'Python 分析阶段失败',
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

  // 8.5 BOM（物料清单）检查。独立于 Python 规则层；导入 BOM 解析失败只把
  //     rules.bom 记为 failed 并产出 BM-ERR，不中止其余结论与报告。
  const bomStage = runBomStage(state, { snapshot: snapshotData, pcbSnapshot })

  // 8.6 数据手册覆盖与提取计划。只做确定性检查（PDF 存在、MPN 匹配、
  //     上游提取计划生成）；引脚级核对始终为 not_evaluated。
  //     数据手册缺口不改变整体退出码，只有执行失败（failed）参与聚合。
  const datasheetStage = runDatasheetStage(state, {
    bomRows: bomStage.rows,
    generatedAt,
  })

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
  ruleStatus.bom = bomStage.coverage.status
  ruleStatus.datasheets = datasheetStage.coverage.status
  if (netlistIncomplete) {
    for (const rule of NETLIST_DEPENDENT_RULES) {
      if (ruleStatus[rule] === 'pass') ruleStatus[rule] = 'not_evaluated'
    }
  }

  // 9.5 Gerber/钻孔（制造文件）分析。独立于原理图/PCB 解析；缺目录、
  //     空目录或缺少钻孔文件时写入 not_evaluated/partial，绝不静默通过。
  const gerberStage = runGerberStage(state, ruleStatus)
  const gerberFindings = gerberStage.findings

  // 9.6 SPICE 仿真（可选）。只有显式 --spice 才检测/运行仿真器；
  //     没有仿真器时保持 not_evaluated，不改变退出码，也绝不伪造结果。
  const spiceStage = runSpiceStage(state, {
    ruleStatus,
    detectedFindings: pipelineSummary.findings,
    generatedAt,
  })
  const spiceFindings = spiceStage.findings

  // 9.7 EMC 预合规（可选）。只有显式 --emc 才调用上游 analyze_emc.py；
  //     缺少铺铜/层切换等数据时相关类别保持 not_evaluated，不改变退出码。
  const emcStage = runEmcStage(state, {
    ruleStatus,
    snapshot: snapshotData,
    pcbSnapshot,
    pipelineSummary,
    nets,
    netlistComplete: !netlistIncomplete,
    generatedAt,
  })
  const emcFindings = emcStage.findings

  // 9.8 AD 原生检查（可选，深度模式）。只有显式 --with-ad 才调用 AD-MCP；
  //     不可用时 main 已以退出码 2 结束。工具失败/超时保持 failed，
  //     不把未返回的检查当作通过。
  const nativeStage = runNativeStage(state, {
    projectPath: discovery.projectPath,
    boardPath: selectedBoard?.path ?? '',
    libraries: discoverLibraries(state.projectDir, state.documents),
    schematic,
    pcbSnapshot,
    generatedAt,
  })
  const nativeFindings = nativeStage.findings

  const findings = [
    ...state.syntheticFindings,
    ...pipelineSummary.findings.filter(isPlainObject),
    ...gerberFindings,
    ...bomStage.findings,
    ...datasheetStage.findings,
    ...spiceFindings,
    ...emcFindings,
    ...nativeFindings,
  ]
  // Python 只写规则层 findings；解析/连通性失败的 DET-ERR、Gerber、BOM 与
  // 数据手册结果由 Node 补充，保证 findings.json 是完整交付物
  // （报告与 summary 使用同一份合并结果）。
  if (
    state.syntheticFindings.length > 0
    || gerberFindings.length > 0
    || bomStage.findings.length > 0
    || datasheetStage.findings.length > 0
    || spiceFindings.length > 0
    || emcFindings.length > 0
    || nativeFindings.length > 0
  ) {
    writeJson(join(state.outDir, 'findings.json'), findings)
  }

  const parsedDocuments = state.documents.filter(document => document.status === 'parsed').length
  const coverage = {
    documents: state.documents.length,
    parsed: parsedDocuments,
    notEvaluated: state.documents.length - parsedDocuments,
  }
  // PCB 侧被跳过的子检查（如缺少过孔外径导致环宽未评估）与网表匹配率
  // 一并写入 coverage，供 summary 与报告展示。
  const pcbCoverage = pipelineSummary.coverage?.pcb
  coverage.pcb = {
    skippedChecks: Array.isArray(pcbCoverage?.skippedChecks)
      ? pcbCoverage.skippedChecks.filter(isPlainObject).map(check => ({
        rule: scalarText(check.rule),
        check: scalarText(check.check),
        reason: scalarText(check.reason),
      }))
      : [],
  }
  coverage.netlist = {
    pinsMatched,
    pinsTotal,
    complete: !netlistIncomplete,
  }
  coverage.gerber = gerberStage.coverage
  coverage.bom = bomStage.coverage
  coverage.datasheets = datasheetStage.coverage
  coverage.spice = spiceStage.coverage
  coverage.emc = emcStage.coverage
  coverage.native = nativeStage.coverage
  // 深度模式的三个规则状态来自实际工具结果；离线时保持 not_evaluated。
  ruleStatus.native_erc = nativeStage.coverage.checks.erc.status
  ruleStatus.native_drc = nativeStage.coverage.checks.drc.status
  ruleStatus.native_library = nativeStage.coverage.checks.library.status
  const missingInputs = []
  if (!selectedBoard) missingInputs.push('pcb')
  if (!selectedSchematic) missingInputs.push('schematic')
  // 显式请求了 --gerber 却拿不到结论时，本次运行属于部分完成；
  // 自动发现不到 Gerber 目录只记为 not_evaluated，不改变退出码。
  if (state.options.gerber !== null && ruleStatus.gerber === 'not_evaluated') {
    missingInputs.push('gerber')
  }
  const manufacturing = buildManufacturing(gerberStage.coverage, gerberFindings)

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
      overview,
      adRules: pcbSnapshot?.rules ?? [],
      findings,
      status: ruleStatus,
      boards: state.documents.map(document => ({
        name: document.name,
        kind: document.kind,
        selected: document === selectedBoard || document === selectedSchematic,
      })),
      manufacturing,
      bom: bomStage.report,
      datasheets: datasheetStage.report,
      spice: spiceStage.report,
      emc: emcStage.report,
      native: nativeStage.report,
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
  // BOM、数据手册、SPICE 仿真与 EMC 预合规的 partial/not_evaluated 只表示
  // 「输入数据不足」或「需要 AI/人工/外部工具继续」，不是分析失败；用户没有
  // 要求这些检查时不应因此把整次运行降级为 partial。它们的执行失败（failed）
  // 仍参与聚合。
  const rulePartial = Object.entries(ruleStatus)
    .some(([rule, value]) => (
      rule !== 'bom'
      && rule !== 'datasheets'
      && rule !== 'spice'
      && rule !== 'emc'
      && value === 'partial'
    ))
  const partial = state.errors.length > 0
    || missingInputs.length > 0
    || ruleFailure
    || rulePartial
  const overallStatus = partial ? 'partial' : 'complete'

  // 12. summary.json：只放模型需要读的概览、覆盖、计数与 top findings。
  const summary = buildSummary(state, {
    coverage,
    overview,
    status: ruleStatus,
    findings,
    generatedAt,
    overallStatus,
    reportPath: reportWritten ? reportPath : null,
    crossCoverage: pipelineSummary.coverage,
    bom: bomStage.summary,
    datasheets: datasheetStage.summary,
    spice: spiceStage.summary,
    emc: emcStage.summary,
    native: nativeStage.summary,
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
// Gerber / 制造文件
// ---------------------------------------------------------------------------

function runGerberStage(state, ruleStatus) {
  const requested = state.options.gerber !== null
  let directory = state.options.gerber
  if (!directory) {
    const detected = detectGerberDirectory(state.projectDir)
    if (detected) directory = detected.directory
  }

  if (!directory) {
    const reason = '工程目录中未找到 Gerber 输出目录'
      + '（Gerber、Outputs、Project Outputs、Manufacturing）'
    const coverage = emptyGerberCoverage([reason])
    ruleStatus.gerber = 'not_evaluated'
    state.manifest.stages.gerber = 'skipped'
    state.manifest.gerber = {
      requested,
      autoDetected: true,
      directory: null,
      status: coverage.status,
      findings: 0,
    }
    state.warnings.push(`${reason}，制造文件检查标记为 not_evaluated`)
    return { findings: [], coverage }
  }

  const result = runGerberAnalysis(directory, state.outDir)
  const coverage = result.coverage
  ruleStatus.gerber = coverage.status
  if (coverage.status === 'failed') {
    state.manifest.stages.gerber = 'failed'
    state.errors.push({
      stage: 'gerber',
      message: 'Gerber/钻孔分析失败',
      details: coverage.reasons.join('；') || '（无错误输出）',
    })
  } else if (coverage.status === 'not_evaluated') {
    state.manifest.stages.gerber = 'not_evaluated'
    state.warnings.push(
      `制造文件检查未评估：${coverage.reasons.join('；') || '输入不足'}`,
    )
  } else if (coverage.status === 'partial') {
    // stage 与 rules 状态保持一致，避免外部仅看 stage 时把部分完成读成通过。
    state.manifest.stages.gerber = 'partial'
    state.warnings.push(
      `制造文件检查部分完成：${coverage.reasons.join('；') || '部分检查被跳过'}`,
    )
  } else {
    state.manifest.stages.gerber = coverage.status
  }
  state.manifest.gerber = {
    requested,
    autoDetected: !requested,
    directory: coverage.directory,
    status: coverage.status,
    findings: result.findings.length,
  }
  return { findings: result.findings, coverage }
}

function buildManufacturing(coverage, findings) {
  return {
    ...coverage,
    source: 'gerber',
    findings,
  }
}

// ---------------------------------------------------------------------------
// BOM / 物料清单
// ---------------------------------------------------------------------------

function runBomStage(state, { snapshot, pcbSnapshot }) {
  const requested = state.options.bom !== null
  const importedPath = requested ? state.options.bom : null
  let project
  try {
    project = buildBom(snapshot, pcbSnapshot)
  } catch (error) {
    return bomFailure(state, {
      requested,
      importedPath,
      message: `BOM 构建失败：${error?.message ?? error}`,
    })
  }

  let findings = [...project.findings]
  const coverage = project.coverage
  let bomPath = null
  let bomGenerated = false
  let procurementPath = null

  if (requested) {
    try {
      const text = readFileSync(importedPath, 'utf8')
      const imported = importBomCsv(text)
      const diff = diffBom(project.rows, imported.rows)
      findings = dedupeBomFindings([...findings, ...diff.findings])
      coverage.checks.imported_diff = diff.coverage.status
      coverage.imported = {
        path: importedPath,
        rows: imported.coverage.rows,
        header: imported.coverage.header,
        columns: imported.coverage.columns,
        missingColumns: imported.coverage.missingColumns,
        duplicateDesignators: imported.coverage.duplicateDesignators,
        missingFromBom: diff.coverage.missingFromBom,
        extraInBom: diff.coverage.extraInBom,
      }
      if (diff.coverage.status === 'not_evaluated') {
        coverage.reasons.push('工程没有可核对的元件，导入 BOM 未做差异比对。')
      }
      coverage.status = recomputeBomStatus(coverage)
      bomPath = importedPath
    } catch (error) {
      const message = `BOM 导入失败：${truncateText(error?.message ?? error, 400)}`
      coverage.checks.imported_diff = 'failed'
      coverage.status = 'failed'
      coverage.reasons.push(message)
      findings.push(bomErrorFinding(message))
      bomPath = importedPath
    }
  } else {
    try {
      exportBom(project.rows, join(state.outDir, 'bom.csv'))
      bomPath = join(state.outDir, 'bom.csv')
      bomGenerated = true
      state.artifacts.bom = 'bom.csv'
    } catch (error) {
      const message = `BOM 文件写入失败：${truncateText(error?.message ?? error, 400)}`
      coverage.status = 'failed'
      coverage.reasons.push(message)
      findings.push(bomErrorFinding(message))
    }
  }

  // 采购清单始终基于工程解析结果；导入的 BOM 只用于差异比对，不覆盖工程数据。
  try {
    const path = join(state.outDir, 'procurement.csv')
    exportProcurement(project.rows, path)
    procurementPath = path
    state.artifacts.procurement = 'procurement.csv'
  } catch (error) {
    const message = `采购清单写入失败：${truncateText(error?.message ?? error, 400)}`
    coverage.status = 'failed'
    coverage.reasons.push(message)
    findings.push(bomErrorFinding(message))
  }

  coverage.findings = findings.length
  state.manifest.stages.bom = coverage.status
  state.manifest.bom = {
    requested,
    importedPath,
    status: coverage.status,
    findings: findings.length,
    rows: coverage.rows,
    missingMpn: coverage.rowsMissingMpn,
    missingFootprint: coverage.rowsMissingFootprint,
    duplicates: coverage.duplicateDesignators.length,
    mismatches: coverage.schematicOnly.length + coverage.pcbOnly.length,
    artifacts: {
      bom: bomGenerated ? 'bom.csv' : null,
      procurement: procurementPath ? 'procurement.csv' : null,
    },
  }

  if (coverage.status === 'failed') {
    if (!state.errors.some(error => error.stage === 'bom')) {
      state.errors.push({
        stage: 'bom',
        message: '物料清单检查失败',
        details: coverage.reasons.join('；') || '（无错误输出）',
      })
    }
  } else if (coverage.status === 'not_evaluated') {
    state.warnings.push(
      `物料检查未评估：${coverage.reasons.join('；') || '没有可检查的元件'}`,
    )
  } else if (coverage.status === 'partial') {
    state.warnings.push(
      `物料检查部分完成：${coverage.reasons.join('；') || '部分检查被跳过'}`,
    )
  }

  return {
    findings,
    rows: project.rows,
    coverage,
    report: buildBomReport(coverage, {
      findings,
      bomPath,
      bomGenerated,
      procurementPath,
    }),
    summary: buildBomSummary(coverage, { bomPath, procurementPath }),
  }
}

function bomFailure(state, { requested, importedPath, message }) {
  const finding = bomErrorFinding(message)
  const coverage = {
    status: 'failed',
    rows: 0,
    components: 0,
    schematicComponents: 0,
    pcbComponents: 0,
    componentsWithoutReference: 0,
    rowsWithMpn: 0,
    rowsMissingMpn: 0,
    rowsWithFootprint: 0,
    rowsMissingFootprint: 0,
    duplicateDesignators: [],
    schematicOnly: [],
    pcbOnly: [],
    checks: {
      missing_mpn: 'failed',
      missing_footprint: 'failed',
      duplicate_designator: 'failed',
      schematic_pcb_match: 'failed',
    },
    reasons: [message],
    findings: 1,
    imported: null,
  }
  state.manifest.stages.bom = 'failed'
  state.manifest.bom = {
    requested,
    importedPath,
    status: 'failed',
    findings: 1,
    rows: 0,
    missingMpn: 0,
    missingFootprint: 0,
    duplicates: 0,
    mismatches: 0,
    artifacts: { bom: null, procurement: null },
  }
  state.errors.push({ stage: 'bom', message: '物料清单检查失败', details: message })
  return {
    findings: [finding],
    rows: [],
    coverage,
    report: buildBomReport(coverage, {
      findings: [finding],
      bomPath: requested ? importedPath : null,
      bomGenerated: false,
      procurementPath: null,
    }),
    summary: buildBomSummary(coverage, { bomPath: null, procurementPath: null }),
  }
}

function buildBomReport(coverage, { findings, bomPath, bomGenerated, procurementPath }) {
  return {
    status: coverage.status,
    components: coverage.rows,
    schematicComponents: coverage.schematicComponents,
    pcbComponents: coverage.pcbComponents,
    rowsWithMpn: coverage.rowsWithMpn,
    rowsMissingMpn: coverage.rowsMissingMpn,
    rowsWithFootprint: coverage.rowsWithFootprint,
    rowsMissingFootprint: coverage.rowsMissingFootprint,
    duplicateDesignators: coverage.duplicateDesignators,
    schematicOnly: coverage.schematicOnly,
    pcbOnly: coverage.pcbOnly,
    checks: coverage.checks,
    reasons: coverage.reasons,
    findings: findings.length,
    bomPath,
    bomGenerated,
    procurementPath,
    imported: coverage.imported,
  }
}

function buildBomSummary(coverage, { bomPath, procurementPath }) {
  return {
    status: coverage.status,
    components: coverage.rows,
    rowsWithMpn: coverage.rowsWithMpn,
    rowsMissingMpn: coverage.rowsMissingMpn,
    rowsMissingFootprint: coverage.rowsMissingFootprint,
    duplicateDesignators: coverage.duplicateDesignators.length,
    schematicOnly: coverage.schematicOnly.length,
    pcbOnly: coverage.pcbOnly.length,
    bomPath,
    procurementPath,
    imported: coverage.imported
      ? {
        path: coverage.imported.path,
        rows: coverage.imported.rows,
        missingFromBom: coverage.imported.missingFromBom.length,
        extraInBom: coverage.imported.extraInBom.length,
      }
      : null,
  }
}

// ---------------------------------------------------------------------------
// 数据手册 / datasheets
// ---------------------------------------------------------------------------

function runDatasheetStage(state, { bomRows, generatedAt }) {
  const requested = state.options.datasheets !== null
  let directory = state.options.datasheets
  let autoDetected = false
  if (!directory) {
    const candidate = join(state.projectDir, 'datasheets')
    if (isDirectory(candidate)) {
      directory = candidate
      autoDetected = true
    }
  }

  // 提取计划与 scout 缓存只写 --out，不写源工程（只读硬规则）。
  const cacheDir = join(state.outDir, 'datasheets')

  if (!directory) {
    const reason = '工程目录中没有 datasheets 目录，未找到可用的 PDF 数据手册'
    const stats = summarizeComponents(bomRows)
    const coverage = emptyDatasheetsCoverage({
      reasons: [reason],
      cacheDir,
      ...stats,
    })
    state.manifest.stages.datasheets = 'skipped'
    state.manifest.datasheets = {
      requested,
      autoDetected: true,
      directory: null,
      cacheDir,
      status: coverage.status,
      pdfs: 0,
      components: coverage.components,
      componentsWithMpn: coverage.componentsWithMpn,
      componentsWithPdf: 0,
      icsWithoutPdf: 0,
      plans: 0,
      findings: 0,
    }
    state.warnings.push(`${reason}，数据手册检查标记为 not_evaluated`)
    return {
      findings: [],
      coverage,
      report: buildDatasheetReport(null, coverage, []),
      summary: buildDatasheetSummary(coverage),
    }
  }

  const result = evaluateDatasheets({
    directory,
    bomRows: Array.isArray(bomRows) ? bomRows : [],
    cacheDir,
  })
  const coverage = result.coverage

  // 可复现产物：扫描列表、匹配结果与计划状态完整写入 datasheets.json。
  try {
    writeJson(join(state.outDir, 'datasheets.json'), {
      schemaVersion: 1,
      generatedAt,
      directory: result.directory,
      coverage,
      pdfs: result.pdfs,
      matched: result.matched,
      unmatchedPdfs: result.unmatchedPdfs,
      componentsWithoutPdf: result.componentsWithoutPdf,
      plans: result.plans,
    })
    state.artifacts.datasheets = 'datasheets.json'
  } catch (error) {
    state.warnings.push(`数据手册检查产物写入失败：${error?.message ?? error}`)
  }

  if (coverage.status === 'failed') {
    state.manifest.stages.datasheets = 'failed'
    state.errors.push({
      stage: 'datasheets',
      message: '数据手册检查失败',
      details: coverage.reasons.join('；') || '（无错误输出）',
    })
  } else if (coverage.status === 'not_evaluated') {
    state.manifest.stages.datasheets = 'not_evaluated'
    state.warnings.push(
      `数据手册检查未评估：${coverage.reasons.join('；') || '输入不足'}`,
    )
  } else if (coverage.status === 'partial') {
    state.manifest.stages.datasheets = 'partial'
    state.warnings.push(
      `数据手册检查部分完成：${coverage.reasons.join('；') || '引脚级核对未进行'}`,
    )
  } else {
    state.manifest.stages.datasheets = coverage.status
  }

  state.manifest.datasheets = {
    requested,
    autoDetected,
    directory: coverage.directory,
    cacheDir: coverage.cacheDir,
    status: coverage.status,
    pdfs: coverage.pdfCount,
    components: coverage.components,
    componentsWithMpn: coverage.componentsWithMpn,
    componentsWithPdf: coverage.componentsWithPdf,
    componentsWithoutPdf: coverage.componentsWithoutPdf,
    icsWithoutPdf: coverage.icsWithoutPdf,
    plans: coverage.plans,
    planGenerated: coverage.planGenerated,
    planNotEvaluated: coverage.planNotEvaluated,
    planFailed: coverage.planFailed,
    pinVerification: 'not_evaluated',
    findings: result.findings.length,
    artifacts: state.artifacts.datasheets ? { index: 'datasheets.json' } : null,
  }

  return {
    findings: result.findings,
    coverage,
    report: buildDatasheetReport(result, coverage, result.findings),
    summary: buildDatasheetSummary(coverage),
  }
}

function buildDatasheetReport(result, coverage, findings) {
  return {
    status: coverage.status,
    directory: coverage.directory,
    cacheDir: coverage.cacheDir,
    manifestPresent: coverage.manifestPresent,
    manifestInvalid: coverage.manifestInvalid,
    pdfCount: coverage.pdfCount,
    components: coverage.components,
    componentsWithMpn: coverage.componentsWithMpn,
    componentsWithPdf: coverage.componentsWithPdf,
    componentsWithoutPdf: coverage.componentsWithoutPdf,
    icComponents: coverage.icComponents,
    icsWithoutPdf: coverage.icsWithoutPdf,
    matched: result?.matched ?? [],
    unmatchedPdfs: result?.unmatchedPdfs ?? [],
    componentsWithoutPdfList: result?.componentsWithoutPdf ?? [],
    plans: result?.plans ?? [],
    checks: coverage.checks,
    reasons: coverage.reasons,
    findings: findings.length,
    pinVerification: 'not_evaluated',
  }
}

function buildDatasheetSummary(coverage) {
  return {
    status: coverage.status,
    directory: coverage.directory,
    cacheDir: coverage.cacheDir,
    pdfCount: coverage.pdfCount,
    manifestPresent: coverage.manifestPresent,
    components: coverage.components,
    componentsWithMpn: coverage.componentsWithMpn,
    componentsWithPdf: coverage.componentsWithPdf,
    componentsWithoutPdf: coverage.componentsWithoutPdf,
    icComponents: coverage.icComponents,
    icsWithoutPdf: coverage.icsWithoutPdf,
    plans: coverage.plans,
    planGenerated: coverage.planGenerated,
    planNotEvaluated: coverage.planNotEvaluated,
    planSkipped: coverage.planSkipped,
    planFailed: coverage.planFailed,
    // 引脚级核对永远不在确定性 CLI 的能力范围内。
    pinVerification: 'not_evaluated',
    reasons: Array.isArray(coverage.reasons) ? coverage.reasons.slice(0, 20) : [],
  }
}

// summary.json 有 32KB 硬上限：数据手册覆盖只保留计数与截断后的原因，
// 逐元件/逐 PDF 明细在 datasheets.json 与 report.html 中。
const DATASHEETS_SUMMARY_REASON_LIMIT = 20

function compactDatasheetsCoverage(coverage) {
  if (!isPlainObject(coverage)) return coverage ?? null
  const reasons = Array.isArray(coverage.reasons)
    ? coverage.reasons.slice(0, DATASHEETS_SUMMARY_REASON_LIMIT)
    : []
  return {
    ...coverage,
    reasons: reasons.map(reason => truncateText(reason, 300)),
    reasonCount: Array.isArray(coverage.reasons) ? coverage.reasons.length : 0,
  }
}

// ---------------------------------------------------------------------------
// SPICE 仿真 / spice
// ---------------------------------------------------------------------------

function runSpiceStage(state, { ruleStatus, detectedFindings, generatedAt }) {
  const requested = state.options.spice === true

  // 未显式请求：只记录「可选、未运行」，不产生 SP finding，也不检测仿真器。
  if (!requested) {
    const coverage = emptySpiceCoverage({
      requested: false,
      reasons: ['未启用 --spice：仿真为可选步骤，本次没有运行。'],
    })
    state.manifest.stages.spice = 'skipped'
    state.manifest.spice = buildSpiceManifest({
      requested: false,
      detection: null,
      coverage,
    })
    return {
      findings: [],
      coverage,
      report: buildSpiceReport(coverage, []),
      summary: buildSpiceSummary(coverage),
    }
  }

  const detection = detectSimulators()
  let result
  try {
    result = runSpice(
      Array.isArray(detectedFindings) ? detectedFindings : [],
      detection.chosen ?? null,
      state.outDir,
      { requested: true },
    )
  } catch (error) {
    // 未预期异常也必须可见：failed + SP-002，而不是让报告静默缺一节。
    const coverage = emptySpiceCoverage({
      requested: true,
      reasons: [`SPICE 仿真阶段异常：${error?.message ?? error}`],
    })
    coverage.status = 'failed'
    coverage.checks.simulation = 'failed'
    coverage.findings = 1
    result = {
      findings: [spiceErrorFinding(coverage.reasons[0])],
      coverage,
    }
  }

  const coverage = result.coverage
  ruleStatus.spice = coverage.status

  // spice.json 是本次仿真的可审计产物：输入、检测到的仿真器、测试台路径
  // 与逐电路结果都在里面；summary 只保留压缩后的概览。
  try {
    coverage.artifacts = {
      ...(isPlainObject(coverage.artifacts) ? coverage.artifacts : {}),
      index: 'spice.json',
    }
    writeJson(join(state.outDir, 'spice.json'), {
      schemaVersion: 1,
      generatedAt,
      requested: true,
      detection,
      coverage,
    })
    state.artifacts.spice = 'spice.json'
  } catch (error) {
    coverage.artifacts = isPlainObject(coverage.artifacts)
      ? { ...coverage.artifacts, index: null }
      : null
    const message = `仿真结果写入失败：${error?.message ?? error}`
    coverage.reasons.push(message)
    state.warnings.push(message)
  }

  if (coverage.status === 'failed') {
    state.manifest.stages.spice = 'failed'
    state.errors.push({
      stage: 'spice',
      message: 'SPICE 仿真失败',
      details: coverage.reasons.join('；') || '（无错误输出）',
    })
  } else if (coverage.status === 'not_evaluated') {
    state.manifest.stages.spice = 'not_evaluated'
    state.warnings.push(
      `SPICE 仿真未评估：${coverage.reasons.join('；') || '仿真器不可用或输入不足'}`,
    )
  } else if (coverage.status === 'partial') {
    state.manifest.stages.spice = 'partial'
    state.warnings.push(
      `SPICE 仿真部分完成：${coverage.reasons.join('；') || '部分子电路被跳过'}`,
    )
  } else {
    state.manifest.stages.spice = coverage.status
  }

  state.manifest.spice = buildSpiceManifest({
    requested: true,
    detection,
    coverage,
  })

  return {
    findings: result.findings,
    coverage,
    report: buildSpiceReport(coverage, result.findings),
    summary: buildSpiceSummary(coverage),
  }
}

function buildSpiceManifest({ requested, detection, coverage }) {
  return {
    requested,
    status: coverage.status,
    simulator: coverage.simulator,
    detection: detection ?? null,
    availableCircuits: coverage.availableCircuits,
    submittedCircuits: coverage.submittedCircuits,
    missingCircuits: coverage.missingCircuits,
    counts: coverage.counts,
    findings: coverage.findings,
    artifacts: coverage.artifacts ?? null,
    reasons: coverage.reasons,
  }
}

function buildSpiceReport(coverage, findings) {
  return {
    requested: coverage.requested,
    status: coverage.status,
    simulator: coverage.simulator,
    availableCircuits: coverage.availableCircuits,
    submittedCircuits: coverage.submittedCircuits,
    missingCircuits: coverage.missingCircuits,
    circuits: coverage.circuits,
    excludedCircuits: coverage.excludedCircuits,
    unaccountedCircuits: coverage.unaccountedCircuits,
    counts: coverage.counts,
    checks: coverage.checks,
    artifacts: coverage.artifacts ?? null,
    installHints: coverage.installHints,
    detectedDetectors: coverage.detectedDetectors,
    unsupportedDetectors: coverage.unsupportedDetectors,
    reasons: coverage.reasons,
    findings: findings.length,
  }
}

function buildSpiceSummary(coverage) {
  return {
    requested: coverage.requested,
    status: coverage.status,
    simulator: coverage.simulator
      ? {
        name: coverage.simulator.name,
        path: coverage.simulator.path,
        version: coverage.simulator.version,
        versionNote: coverage.simulator.versionNote,
      }
      : null,
    circuits: coverage.counts.total,
    availableCircuits: coverage.availableCircuits,
    submittedCircuits: coverage.submittedCircuits,
    excludedCircuits: Array.isArray(coverage.excludedCircuits)
      ? coverage.excludedCircuits.length
      : 0,
    unaccountedCircuits: Array.isArray(coverage.unaccountedCircuits)
      ? coverage.unaccountedCircuits.length
      : 0,
    missingCircuits: coverage.missingCircuits,
    counts: coverage.counts,
    findings: coverage.findings,
    artifact: coverage.artifacts?.index ?? null,
    workdir: coverage.artifacts?.workdir ?? null,
    reasons: Array.isArray(coverage.reasons)
      ? coverage.reasons.slice(0, 10)
      : [],
  }
}

// ---------------------------------------------------------------------------
// EMC 预合规 / emc
// ---------------------------------------------------------------------------

function runEmcStage(state, {
  ruleStatus,
  snapshot,
  pcbSnapshot,
  pipelineSummary,
  nets,
  netlistComplete,
  generatedAt,
}) {
  const requested = state.options.emc === true

  // 未显式请求：只记录「可选、未运行」，不产生 EM finding，也不调用上游。
  if (!requested) {
    const coverage = emptyEmcCoverage({
      requested: false,
      reasons: ['未启用 --emc：EMC 预合规分析为可选步骤，本次没有运行。'],
    })
    ruleStatus.emc = 'not_evaluated'
    state.manifest.stages.emc = 'skipped'
    state.manifest.emc = buildEmcManifest({ requested: false, coverage })
    return {
      findings: [],
      coverage,
      report: buildEmcReport(coverage, []),
      summary: buildEmcSummary(coverage),
    }
  }

  if (!snapshot?.schematic && !pcbSnapshot) {
    const coverage = unavailableEmcCoverage([
      '没有可用的原理图或 PCB 数据，EMC 分析未评估。',
    ])
    ruleStatus.emc = 'not_evaluated'
    state.manifest.stages.emc = 'not_evaluated'
    state.manifest.emc = buildEmcManifest({ requested: true, coverage })
    state.warnings.push('EMC 预合规分析未评估：没有可用的原理图或 PCB 数据')
    return {
      findings: [],
      coverage,
      report: buildEmcReport(coverage, []),
      summary: buildEmcSummary(coverage),
    }
  }

  const emcDir = join(state.outDir, 'emc-input')
  let result
  let coverage
  try {
    mkdirSync(emcDir, { recursive: true })
    const inputs = buildEmcInputs(snapshot, pcbSnapshot, pipelineSummary, {
      nets,
      netlistComplete,
    })
    writeJson(join(emcDir, 'schematic.json'), inputs.schematicJson)
    writeJson(join(emcDir, 'pcb.json'), inputs.pcbJson)
    const rawSource = join(state.outDir, 'raw.json')
    if (existsSync(rawSource)) {
      copyFileSync(rawSource, join(emcDir, 'raw.json'))
    }
    result = runEmc(emcDir, state.outDir)
    coverage = result.coverage
    if (!coverage.artifacts) {
      coverage.artifacts = {
        schematic: 'emc-input/schematic.json',
        pcb: 'emc-input/pcb.json',
        raw: result.rawPath ? 'emc-input/emc-raw.json' : null,
        inputRaw: existsSync(join(emcDir, 'raw.json')) ? 'emc-input/raw.json' : null,
      }
    }
    coverage.artifacts.index = 'emc.json'
  } catch (error) {
    const message = `EMC 预合规阶段异常：${error?.message ?? error}`
    coverage = emptyEmcCoverage({
      requested: true,
      status: 'failed',
      reasons: [message],
    })
    coverage.upstream = { available: false, script: null, error: message }
    coverage.findings = 1
    result = { findings: [emcStageFailureFinding(message)], coverage, rawPath: null }
  }

  const findings = Array.isArray(result.findings) ? result.findings : []
  ruleStatus.emc = coverage.status
  state.manifest.stages.emc = coverage.status
  state.manifest.emc = buildEmcManifest({ requested: true, coverage })

  // 可复现产物：类别覆盖、检测器状态、上游摘要与归一化 finding 都写入 emc.json；
  // 上游原始输出保留在 emc-input/emc-raw.json。
  try {
    writeJson(join(state.outDir, 'emc.json'), {
      schemaVersion: 1,
      generatedAt,
      requested: true,
      standard: coverage.standard,
      coverage,
      findings,
    })
    state.artifacts.emc = 'emc.json'
  } catch (error) {
    const message = `EMC 结果写入失败：${error?.message ?? error}`
    coverage.reasons = [...(coverage.reasons ?? []), message]
    state.warnings.push(message)
  }

  if (coverage.status === 'failed') {
    state.errors.push({
      stage: 'emc',
      message: 'EMC 预合规分析失败',
      details: coverage.reasons.join('；') || '（无错误输出）',
    })
  } else if (coverage.status === 'not_evaluated') {
    state.warnings.push(
      `EMC 预合规分析未评估：${coverage.reasons.join('；') || '输入不足'}`,
    )
  } else if (coverage.status === 'partial') {
    state.warnings.push(
      `EMC 预合规分析部分完成：${coverage.reasons.slice(0, 6).join('；') || '部分类别未评估'}`,
    )
  }

  return {
    findings,
    coverage,
    report: buildEmcReport(coverage, findings),
    summary: buildEmcSummary(coverage),
  }
}

function emcStageFailureFinding(message) {
  return {
    detector: 'emc',
    rule_id: 'EM-000',
    source_rule_id: null,
    category: 'analysis_error',
    kind: 'issue',
    severity: 'must_fix',
    confidence: 'deterministic',
    evidence_source: 'emc',
    summary: 'EMC 预合规阶段执行失败',
    title: 'EMC 预合规阶段执行失败',
    description: `${message}。这是分析执行错误，不是 EMC 设计结论。`,
    evidence: message,
    recommendation: '检查 --out 目录权限与 kicad-happy 安装；修复后重跑 --emc。',
    components: [],
    nets: [],
    pins: [],
    source: 'emc',
  }
}

function buildEmcManifest({ requested, coverage }) {
  const categories = Array.isArray(coverage.categories) ? coverage.categories : []
  return {
    requested,
    status: coverage.status,
    standard: coverage.standard,
    available: coverage.available === true,
    netlistComplete: coverage.netlist?.complete ?? null,
    script: coverage.upstream?.script ?? null,
    categories: {
      total: categories.length,
      evaluated: categories.filter(category => category.status === 'evaluated').length,
      partial: categories.filter(category => category.status === 'partial').length,
      notEvaluated: categories.filter(category => category.status === 'not_evaluated').length,
    },
    rules: {
      evaluated: coverage.evaluatedRules?.length ?? 0,
      partial: coverage.partiallyEvaluatedRules?.length ?? 0,
      notEvaluated: coverage.notEvaluatedRules?.length ?? 0,
      suppressedFindings: coverage.suppressedFindings?.length ?? 0,
    },
    findings: coverage.findings ?? 0,
    facts: coverage.facts ?? 0,
    artifacts: coverage.artifacts ?? null,
    reasons: coverage.reasons ?? [],
  }
}

function buildEmcReport(coverage, findings) {
  const categories = Array.isArray(coverage.categories) ? coverage.categories : []
  return {
    requested: coverage.requested === true,
    status: coverage.status,
    standard: coverage.standard,
    available: coverage.available === true,
    netlistComplete: coverage.netlist?.complete ?? null,
    script: coverage.upstream?.script ?? null,
    upstream: coverage.upstream ?? null,
    detectors: coverage.detectors ?? null,
    categories,
    evaluatedRules: coverage.evaluatedRules ?? [],
    partiallyEvaluatedRules: coverage.partiallyEvaluatedRules ?? [],
    notEvaluatedRules: coverage.notEvaluatedRules ?? [],
    suppressedFindings: coverage.suppressedFindings ?? [],
    unsupportedRules: coverage.unsupportedRules ?? [],
    counts: coverage.counts ?? {},
    reasons: coverage.reasons ?? [],
    findings: findings.filter(finding => finding.kind !== 'fact').length,
    facts: findings.filter(finding => finding.kind === 'fact').length,
    items: findings.map(finding => ({
      ruleId: finding.rule_id,
      sourceRuleId: finding.source_rule_id,
      severity: finding.severity,
      kind: finding.kind,
      title: finding.title,
      description: finding.description,
      components: finding.components,
      nets: finding.nets,
    })),
    artifacts: coverage.artifacts ?? null,
  }
}

function buildEmcSummary(coverage) {
  const categories = Array.isArray(coverage.categories) ? coverage.categories : []
  return {
    requested: coverage.requested === true,
    status: coverage.status,
    standard: coverage.standard,
    available: coverage.available === true,
    netlistComplete: coverage.netlist?.complete ?? null,
    script: coverage.upstream?.script ?? null,
    // 32KB 限制下不在顶层重复类别内的规则列表；逐规则原因保留前 2 条。
    categories: categories.map(category => ({
      key: category.key,
      label: category.label,
      status: category.status,
      evaluatedRules: category.evaluatedRules ?? [],
      partiallyEvaluatedRules: category.partiallyEvaluatedRules ?? [],
      notEvaluatedRules: (category.notEvaluatedRules ?? []).map(entry => entry.rule),
      reasons: (category.reasons ?? []).slice(0, 2).map(reason => truncateText(reason, 200)),
    })),
    counts: coverage.counts ?? {},
    notEvaluatedRules: (coverage.notEvaluatedRules ?? []).map(entry => entry.rule),
    suppressedFindings: coverage.suppressedFindings ?? [],
    unsupportedRules: coverage.unsupportedRules ?? [],
    findings: coverage.findings ?? 0,
    facts: coverage.facts ?? 0,
    artifact: coverage.artifacts?.index ?? null,
    reasons: (coverage.reasons ?? []).slice(0, 8).map(reason => truncateText(reason, 240)),
  }
}

// summary.json 的 coverage.emc 只保留状态与计数；类别/规则明细在顶层 emc，
// 避免同一份覆盖信息在 32KB 限制内重复占位。
function compactEmcCoverage(emc) {
  if (!isPlainObject(emc)) return null
  return {
    requested: emc.requested === true,
    status: scalarText(emc.status) || 'not_evaluated',
    standard: scalarText(emc.standard),
    available: emc.available === true,
    netlistComplete: emc.netlistComplete ?? null,
    counts: isPlainObject(emc.counts) ? emc.counts : {},
    categories: Array.isArray(emc.categories)
      ? emc.categories.map(category => ({
        key: scalarText(category.key),
        status: scalarText(category.status),
      }))
      : [],
    findings: numberOrZero(emc.findings),
    facts: numberOrZero(emc.facts),
    artifact: emc.artifact ?? null,
    reasons: Array.isArray(emc.reasons)
      ? emc.reasons.slice(0, 5).map(reason => truncateText(reason, 240))
      : [],
  }
}

// ---------------------------------------------------------------------------
// AD 原生检查 / native
// ---------------------------------------------------------------------------

function runNativeStage(state, {
  projectPath,
  boardPath,
  libraries,
  schematic,
  pcbSnapshot,
  generatedAt,
}) {
  const requested = state.options.withAd === true

  // 未显式请求：只记录「可选、未运行」，不产生 AD finding，也不探测 AD。
  if (!requested) {
    const coverage = emptyNativeCoverage({
      requested: false,
      available: false,
      reasons: ['未启用 --with-ad：AD 原生检查为可选深度模式，本次没有运行。'],
    })
    state.manifest.stages.native = 'skipped'
    state.manifest.native = buildNativeManifest({
      requested: false,
      availability: null,
      coverage,
    })
    return {
      findings: [],
      coverage,
      report: buildNativeReport(coverage, []),
      summary: buildNativeSummary(coverage),
    }
  }

  const availability = state.adAvailability ?? detectAdAvailability()
  let result
  try {
    result = runNativeChecks({
      projectPath,
      boardPath,
      libraries,
      schematic,
      pcbSnapshot,
      outDir: state.outDir,
      availability,
      env: process.env,
    })
  } catch (error) {
    const message = `AD 原生检查阶段异常：${error?.message ?? error}`
    const coverage = emptyNativeCoverage({
      requested: true,
      available: availability.available === true,
      reasons: [message],
    })
    coverage.status = 'failed'
    coverage.serverPath = availability.serverPath ?? null
    coverage.python = availability.python ?? null
    coverage.findings = 1
    result = {
      findings: [nativeFailureFinding(message)],
      coverage,
      bridge: null,
    }
  }

  const coverage = result.coverage
  const findings = Array.isArray(result.findings) ? result.findings : []
  state.manifest.stages.native = coverage.status
  state.manifest.native = buildNativeManifest({
    requested: true,
    availability,
    coverage,
  })

  // ad.json 是本次原生检查的可审计产物：可用性、覆盖、逐库结果、
  // 归一化 finding 与桥接原始返回都在里面。
  try {
    writeJson(join(state.outDir, 'ad.json'), {
      schemaVersion: 1,
      generatedAt,
      requested: true,
      availability,
      coverage,
      findings,
      bridge: result.bridge ?? null,
    })
    state.artifacts.ad = 'ad.json'
  } catch (error) {
    const message = `AD 原生检查结果写入失败：${error?.message ?? error}`
    coverage.reasons = [...(coverage.reasons ?? []), message]
    if (isPlainObject(coverage.artifacts)) coverage.artifacts.index = null
    state.warnings.push(message)
  }

  if (coverage.status === 'failed') {
    state.errors.push({
      stage: 'native',
      message: 'AD 原生检查失败',
      details: coverage.reasons.join('；') || '（无错误输出）',
    })
  } else if (coverage.status === 'partial') {
    state.warnings.push(
      `AD 原生检查部分完成：${coverage.reasons.slice(0, 4).join('；') || '部分检查未完成'}`,
    )
  } else if (coverage.status === 'not_evaluated') {
    state.warnings.push(
      `AD 原生检查未评估：${coverage.reasons.slice(0, 4).join('；') || '输入不足'}`,
    )
  }

  return {
    findings,
    coverage,
    report: buildNativeReport(coverage, findings),
    summary: buildNativeSummary(coverage),
  }
}

function buildNativeManifest({ requested, availability, coverage }) {
  return {
    requested,
    status: coverage.status,
    available: coverage.available === true,
    serverPath: coverage.serverPath ?? availability?.serverPath ?? null,
    python: coverage.python ?? availability?.python ?? null,
    altium: coverage.altium ?? null,
    checks: coverage.checks,
    erc: {
      status: coverage.erc?.status,
      compiled: coverage.erc?.compiled === true,
      total: coverage.erc?.total ?? 0,
      fatal: coverage.erc?.fatal ?? 0,
      errors: coverage.erc?.errors ?? 0,
      warnings: coverage.erc?.warnings ?? 0,
    },
    drc: {
      status: coverage.drc?.status,
      ran: coverage.drc?.ran === true,
      violationCount: coverage.drc?.violationCount ?? 0,
      listed: coverage.drc?.listed ?? 0,
      complete: coverage.drc?.complete ?? null,
    },
    libraries: coverage.counts?.libraries ?? null,
    counts: coverage.counts,
    findings: coverage.findings ?? 0,
    artifacts: coverage.artifacts ?? null,
    reasons: coverage.reasons ?? [],
  }
}

function buildNativeReport(coverage, findings) {
  return {
    requested: coverage.requested === true,
    status: coverage.status,
    available: coverage.available === true,
    serverPath: coverage.serverPath ?? null,
    python: coverage.python ?? null,
    altium: coverage.altium ?? null,
    checks: coverage.checks,
    erc: coverage.erc,
    drc: coverage.drc,
    libraries: coverage.libraries ?? [],
    counts: coverage.counts,
    reasons: coverage.reasons ?? [],
    findings: findings.filter(finding => finding.kind !== 'fact').length,
    facts: findings.filter(finding => finding.kind === 'fact').length,
    items: findings.map(finding => ({
      ruleId: finding.rule_id,
      source: finding.source,
      severity: finding.severity,
      kind: finding.kind,
      title: finding.title,
      description: finding.description,
      components: finding.components,
      nets: finding.nets,
    })),
    artifacts: coverage.artifacts ?? null,
  }
}

function buildNativeSummary(coverage) {
  return {
    requested: coverage.requested === true,
    status: coverage.status,
    available: coverage.available === true,
    serverPath: coverage.serverPath ?? null,
    python: coverage.python ?? null,
    altium: coverage.altium ?? null,
    checks: coverage.checks,
    erc: {
      status: coverage.erc?.status,
      compiled: coverage.erc?.compiled === true,
      total: coverage.erc?.total ?? 0,
      fatal: coverage.erc?.fatal ?? 0,
      errors: coverage.erc?.errors ?? 0,
      warnings: coverage.erc?.warnings ?? 0,
      listed: coverage.erc?.listed ?? 0,
      unsavedInAltium: coverage.erc?.unsavedInAltium ?? 0,
      missingOnDisk: coverage.erc?.missingOnDisk ?? 0,
    },
    drc: {
      status: coverage.drc?.status,
      ran: coverage.drc?.ran === true,
      violationCount: coverage.drc?.violationCount ?? 0,
      listed: coverage.drc?.listed ?? 0,
      complete: coverage.drc?.complete ?? null,
      board: coverage.drc?.board ?? null,
    },
    counts: coverage.counts ?? {},
    findings: coverage.findings ?? 0,
    artifact: coverage.artifacts?.index ?? null,
    reasons: (coverage.reasons ?? []).slice(0, 8).map(reason => truncateText(reason, 240)),
  }
}

// summary.json 的 coverage.native 只保留状态与计数；逐库明细在顶层 native
// 与 ad.json 中，避免在 32KB 限额内重复占位。
function compactNativeCoverage(native) {
  if (!isPlainObject(native)) return null
  const checks = isPlainObject(native.checks) ? native.checks : {}
  return {
    requested: native.requested === true,
    status: scalarText(native.status) || 'not_evaluated',
    available: native.available === true,
    checks: Object.fromEntries(
      Object.entries(checks).map(([key, value]) => [
        key,
        isPlainObject(value) ? {
          status: scalarText(value.status) || 'not_evaluated',
          reason: truncateText(scalarText(value.reason), 200),
        } : { status: scalarText(value) || 'not_evaluated' },
      ]),
    ),
    counts: isPlainObject(native.counts) ? native.counts : {},
    findings: numberOrZero(native.findings),
    artifact: native.artifacts?.index ?? null,
    reasons: Array.isArray(native.reasons)
      ? native.reasons.slice(0, 5).map(reason => truncateText(reason, 240))
      : [],
  }
}

function nativeCompletionLine(native) {
  if (!native.requested) return 'AD 原生：未启用（--with-ad 可选）'
  if (!native.available) {
    return `AD 原生：不可用（${native.reasons?.[0] ?? 'AD-MCP 不可用'}）`
  }
  const erc = native.erc ?? {}
  const drc = native.drc ?? {}
  const libs = native.counts?.libraries ?? {}
  return `AD 原生：${native.status}；ERC ${erc.total ?? 0} 条`
    + `（错误 ${erc.errors ?? 0} / 警告 ${erc.warnings ?? 0}）`
    + `；DRC ${drc.ran ? `${drc.violationCount ?? 0} 条` : '未运行'}`
    + `；库 ${libs.matchedSymbols ?? 0} 符号 / ${libs.matchedFootprints ?? 0} 封装，`
    + `不一致 ${libs.mismatches ?? 0}`
}

// summary.json 只保留前 50 个子电路的概览；完整测试台与结果在 spice.json。
const SPICE_SUMMARY_CIRCUIT_LIMIT = 50
const SPICE_SUMMARY_CANDIDATE_LIMIT = 20
const SPICE_SUMMARY_REASON_LIMIT = 10

function compactSpiceCandidates(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, SPICE_SUMMARY_CANDIDATE_LIMIT).map(candidate => ({
    type: scalarText(candidate.type),
    typeLabel: scalarText(candidate.typeLabel),
    detector: scalarText(candidate.detector),
    reference: scalarText(candidate.reference),
    components: Array.isArray(candidate.components)
      ? candidate.components.slice(0, 10).map(scalarText)
      : [],
    reason: truncateText(scalarText(candidate.reason), 200),
  }))
}

function compactSpiceCoverage(coverage) {
  if (!isPlainObject(coverage)) return coverage ?? null
  const circuits = Array.isArray(coverage.circuits) ? coverage.circuits : []
  return {
    status: coverage.status,
    requested: coverage.requested === true,
    simulator: coverage.simulator
      ? {
        name: coverage.simulator.name,
        path: coverage.simulator.path,
        version: coverage.simulator.version,
        versionNote: coverage.simulator.versionNote,
      }
      : null,
    availableCircuits: numberOrZero(coverage.availableCircuits),
    submittedCircuits: numberOrZero(coverage.submittedCircuits),
    missingCircuits: numberOrZero(coverage.missingCircuits),
    counts: isPlainObject(coverage.counts) ? coverage.counts : null,
    checks: isPlainObject(coverage.checks) ? coverage.checks : null,
    circuitCount: circuits.length,
    circuits: circuits.slice(0, SPICE_SUMMARY_CIRCUIT_LIMIT).map(circuit => ({
      type: scalarText(circuit.type),
      typeLabel: scalarText(circuit.typeLabel),
      reference: scalarText(circuit.reference),
      components: Array.isArray(circuit.components) ? circuit.components.slice(0, 10) : [],
      status: scalarText(circuit.status),
      testbench: scalarText(circuit.testbench),
      testbenchExists: circuit.testbenchExists === true,
    })),
    excludedCircuitCount: Array.isArray(coverage.excludedCircuits)
      ? coverage.excludedCircuits.length
      : 0,
    unaccountedCircuitCount: Array.isArray(coverage.unaccountedCircuits)
      ? coverage.unaccountedCircuits.length
      : 0,
    excludedCircuits: compactSpiceCandidates(coverage.excludedCircuits),
    unaccountedCircuits: compactSpiceCandidates(coverage.unaccountedCircuits),
    reasons: (Array.isArray(coverage.reasons) ? coverage.reasons : [])
      .slice(0, SPICE_SUMMARY_REASON_LIMIT)
      .map(reason => truncateText(reason, 300)),
    artifacts: isPlainObject(coverage.artifacts) ? coverage.artifacts : null,
  }
}

// ---------------------------------------------------------------------------
// summary.json
// ---------------------------------------------------------------------------

function buildSummary(state, context) {
  const {
    coverage,
    overview,
    status,
    findings,
    generatedAt,
    overallStatus,
    reportPath,
    crossCoverage,
    bom,
    datasheets,
    spice,
    emc,
    native,
    severityGroup,
  } = context

  const severityCounts = { must_fix: 0, should_fix: 0, nice_to_have: 0 }
  let factCount = 0
  for (const finding of findings) {
    if (findingKind(finding) === 'fact') {
      factCount += 1
    } else {
      severityCounts[severityGroup(finding.severity)] += 1
    }
  }
  const issueCount = severityCounts.must_fix
    + severityCounts.should_fix
    + severityCounts.nice_to_have
  const ruleCounts = Object.assign(Object.create(null), {
    pass: 0,
    found: 0,
    partial: 0,
    not_evaluated: 0,
    failed: 0,
  })
  for (const value of Object.values(status)) {
    ruleCounts[value] = (ruleCounts[value] ?? 0) + 1
  }

  const { top, omitted } = selectTopFindings(findings, severityGroup, status)

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
    schematic: overview.schematic,
    pcb: overview.pcb,
    bom: bom ?? null,
    datasheets: datasheets ?? null,
    spice: spice ?? null,
    emc: emc ?? null,
    native: native ?? null,
    coverage: {
      ...coverage,
      // summary.json 有 32KB 硬上限：BOM 明细列表必须截断，只保留计数与样本；
      // 完整列表在 report.html / findings.json 中。数据手册与仿真覆盖只保留
      // 计数、状态与原因，测试台明细在 spice.json 中。
      bom: compactBomCoverage(coverage.bom),
      datasheets: compactDatasheetsCoverage(coverage.datasheets),
      spice: compactSpiceCoverage(coverage.spice),
      // EMC 覆盖在 coverage 中只保留状态与计数；类别/规则明细在顶层 emc。
      emc: compactEmcCoverage(emc),
      // AD 原生覆盖同样只保留状态、计数与原因；逐库明细在 native 与 ad.json。
      native: compactNativeCoverage(coverage.native),
      crossCheck: summarizeCrossCoverage(crossCoverage),
    },
    counts: {
      must_fix: severityCounts.must_fix,
      should_fix: severityCounts.should_fix,
      nice_to_have: severityCounts.nice_to_have,
      // total 只统计问题；实测事实单独计数，不挤占问题数量。
      total: issueCount,
      facts: factCount,
      rules: ruleCounts,
    },
    rules: status,
    findings: top,
    findingsOmitted: omitted,
    report: reportPath,
  }
}

function selectTopFindings(findings, severityGroup, status, limit = TOP_FINDINGS_LIMIT) {
  const ranked = findings.map((finding, index) => ({
    finding,
    index,
    group: severityGroup(finding.severity),
    kind: findingKind(finding),
    ruleKey: statusKeyForFinding(finding),
  }))
  ranked.sort(compareRankedFindings)

  const selected = []
  const seen = new Set()
  const take = (entry) => {
    if (seen.has(entry.index)) return false
    seen.add(entry.index)
    selected.push(entry)
    return true
  }

  // 第一轮：每个 found 规则至少保留一条。优先非事实项，保证识别结果
  // 不会被大量实测事实挤出 top-N。
  const foundRules = Object.entries(status ?? {})
    .filter(([, value]) => value === 'found')
    .map(([rule]) => rule)
  for (const rule of foundRules) {
    const preferred = ranked.find(entry => (
      entry.ruleKey === rule && entry.kind !== 'fact'
    ))
    const fallback = ranked.find(entry => entry.ruleKey === rule)
    const entry = preferred ?? fallback
    if (entry) take(entry)
  }

  // 第二轮：其余问题按严重度/规则 ID 排序补齐；第三轮才轮到事实。
  for (const entry of ranked) {
    if (selected.length >= limit) break
    if (entry.kind !== 'fact') take(entry)
  }
  for (const entry of ranked) {
    if (selected.length >= limit) break
    take(entry)
  }

  const top = selected
    .slice(0, limit)
    .map(entry => summarizeFinding(entry.finding, entry.group))
  return { top, omitted: Math.max(findings.length - top.length, 0) }
}

function compareRankedFindings(a, b) {
  // 问题优先于事实，其次按严重度、规则 ID 与输入顺序稳定排序。
  if (a.kind !== b.kind) return a.kind === 'fact' ? 1 : -1
  return GROUP_RANK[a.group] - GROUP_RANK[b.group]
    || compareText(scalarText(a.finding.rule_id), scalarText(b.finding.rule_id))
    || a.index - b.index
}

function findingKind(finding) {
  return scalarText(finding.kind) === 'fact' ? 'fact' : 'issue'
}

// pipeline 的 status 以规则名为键；跨域检查的 finding detector 是 crosscheck，
// 对应状态键 pin_pad。
function statusKeyForFinding(finding) {
  const detector = scalarText(finding.detector)
  return detector === 'crosscheck' ? 'pin_pad' : detector
}

function summarizeFinding(finding, group) {
  const source = scalarText(finding.source)
  const entry = {
    rule_id: scalarText(finding.rule_id),
    detector: scalarText(finding.detector),
    kind: findingKind(finding),
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
  if (source) entry.source = source
  const sourceRuleId = scalarText(finding.source_rule_id)
  if (sourceRuleId) entry.source_rule_id = sourceRuleId
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

// summary.json 的 BOM 覆盖只保留前 50 个位号作为样本，并记录完整数量。
const BOM_SUMMARY_LIST_LIMIT = 50

function compactBomCoverage(coverage) {
  if (!isPlainObject(coverage)) return coverage ?? null
  const cap = value => (Array.isArray(value)
    ? value.slice(0, BOM_SUMMARY_LIST_LIMIT)
    : [])
  const total = value => (Array.isArray(value) ? value.length : 0)
  const imported = isPlainObject(coverage.imported)
    ? {
        ...coverage.imported,
        missingFromBom: cap(coverage.imported.missingFromBom),
        extraInBom: cap(coverage.imported.extraInBom),
        duplicateDesignators: cap(coverage.imported.duplicateDesignators),
        totals: {
          missingFromBom: total(coverage.imported.missingFromBom),
          extraInBom: total(coverage.imported.extraInBom),
          duplicateDesignators: total(coverage.imported.duplicateDesignators),
        },
      }
    : null
  return {
    ...coverage,
    duplicateDesignators: cap(coverage.duplicateDesignators),
    schematicOnly: cap(coverage.schematicOnly),
    pcbOnly: cap(coverage.pcbOnly),
    reasons: cap(coverage.reasons)
      .map(reason => truncateText(reason, 300)),
    totals: {
      duplicateDesignators: total(coverage.duplicateDesignators),
      schematicOnly: total(coverage.schematicOnly),
      pcbOnly: total(coverage.pcbOnly),
    },
    imported,
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

function createState({ runId, startedAt, outDir, projectDir, options, adAvailability }) {
  const state = {
    runId,
    startedAt,
    startedMs: Date.now(),
    outDir,
    projectDir,
    options,
    adAvailability,
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
        gerber: 'skipped',
        bom: 'skipped',
        datasheets: 'skipped',
        spice: 'skipped',
        emc: 'skipped',
        native: 'skipped',
        report: 'skipped',
      },
      documents: [],
      errors: [],
      warnings: [],
      gerber: null,
      bom: null,
      datasheets: null,
      spice: null,
      emc: null,
      native: null,
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

function checkInputSize(path, label) {
  let size
  try {
    size = statSync(path).size
  } catch (error) {
    throw new Error(`无法读取${label}文件大小: ${error?.message ?? error}`)
  }
  if (size > MAX_INPUT_BYTES) {
    const megabytes = (size / (1024 * 1024)).toFixed(1)
    throw new Error(
      `${label}文件过大：${megabytes} MB，超过 ${MAX_INPUT_BYTES / (1024 * 1024)} MB 上限；`
      + '请先在 Altium 中精简文档或拆分工程后重试',
    )
  }
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
    kind: 'issue',
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
    kind: 'issue',
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

function spiceCompletionLine(spice) {
  if (!spice.requested) return '仿真：未启用（--spice 可选）'
  if (!spice.simulator) {
    return `仿真：未评估（${spice.reasons?.[0] ?? '未找到可用仿真器'}）`
  }
  const version = spice.simulator.version ? ` ${spice.simulator.version}` : ''
  const counts = spice.counts ?? {}
  if (spice.status === 'failed') {
    return `仿真：失败（${spice.simulator.name}${version}）`
  }
  return `仿真：${spice.status}；${counts.pass ?? 0} 通过 / ${counts.warn ?? 0} 警告 / `
    + `${counts.fail ?? 0} 失败 / ${counts.skip ?? 0} 跳过（${spice.simulator.name}${version}）`
}

function emcCompletionLine(emc) {
  if (!emc.requested) return 'EMC：未启用（--emc 可选）'
  if (!emc.available) {
    return `EMC：未评估（${emc.reasons?.[0] ?? '上游不可用'}）`
  }
  const counts = emc.counts ?? {}
  return `EMC：${emc.status}；问题 ${emc.findings ?? 0} / 事实 ${emc.facts ?? 0}；`
    + `已评估规则 ${counts.evaluated ?? 0} + 部分 ${counts.partial ?? 0} / `
    + `未评估 ${counts.notEvaluated ?? 0}（标准 ${emc.standard}）`
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
  if (summary.bom) {
    console.log(
      `物料：${summary.bom.components} 个元件；缺 MPN ${summary.bom.rowsMissingMpn}；`
      + `缺封装 ${summary.bom.rowsMissingFootprint}；状态 ${summary.bom.status}`,
    )
  }
  if (summary.datasheets) {
    console.log(
      `数据手册：PDF ${summary.datasheets.pdfCount} 份；匹配 ${summary.datasheets.componentsWithPdf}`
      + `/${summary.datasheets.components} 个元件；缺手册 IC ${summary.datasheets.icsWithoutPdf} 个；`
      + `状态 ${summary.datasheets.status}（引脚级核对未评估）`,
    )
  }
  if (summary.spice) {
    console.log(spiceCompletionLine(summary.spice))
  }
  if (summary.emc?.requested) {
    console.log(emcCompletionLine(summary.emc))
  }
  if (summary.native) {
    console.log(nativeCompletionLine(summary.native))
  }
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
    projectFile: null,
    board: null,
    gerber: null,
    bom: null,
    datasheets: null,
    spice: false,
    emc: false,
    withAd: false,
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
      case '--project-file': {
        const taken = takeValue(key, inline, argv, index)
        options.projectFile = taken.value
        index = taken.index
        break
      }
      case '--board': {
        const taken = takeValue(key, inline, argv, index)
        options.board = taken.value
        index = taken.index
        break
      }
      case '--gerber': {
        const taken = takeValue(key, inline, argv, index)
        options.gerber = taken.value
        index = taken.index
        break
      }
      case '--bom': {
        const taken = takeValue(key, inline, argv, index)
        options.bom = taken.value
        index = taken.index
        break
      }
      case '--datasheets': {
        const taken = takeValue(key, inline, argv, index)
        options.datasheets = taken.value
        index = taken.index
        break
      }
      case '--spice':
        options.spice = true
        break
      case '--emc':
        options.emc = true
        break
      case '--with-ad':
        options.withAd = true
        break
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

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isInside(parent, child) {
  const relation = relative(resolve(parent), resolve(child))
  if (relation === '') return true
  if (isAbsolute(relation)) return false
  // 只把 ".." 与 "..<sep>..." 视为父目录；名为 "..foo" 的同级目录仍在内部。
  return relation !== '..' && !relation.startsWith(`..${sep}`)
}

function prepareOutDir(outDir) {
  const markerPath = join(outDir, RUN_MARKER)
  if (existsSync(outDir)) {
    let entries
    try {
      entries = readdirSync(outDir)
    } catch (error) {
      return `无法读取输出目录 ${outDir}: ${error?.message ?? error}`
    }
    if (entries.length > 0) {
      if (!existsSync(markerPath)) {
        return `输出目录非空且没有 ${RUN_MARKER} 标记，拒绝清理: ${outDir}\n`
          + '请换一个空目录，或删除该目录中的旧文件后重试。'
      }
      if (!isOwnRunMarker(markerPath)) {
        return `输出目录的 ${RUN_MARKER} 标记无效，拒绝清理: ${outDir}`
      }
    }
  }
  try {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(
      markerPath,
      `${JSON.stringify({ tool: 'ad-happy', schemaVersion: RUN_MARKER_SCHEMA })}\n`,
      'utf8',
    )
  } catch (error) {
    return `无法准备输出目录 ${outDir}: ${error?.message ?? error}`
  }
  return null
}

function isOwnRunMarker(markerPath) {
  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
    return isPlainObject(marker)
      && marker.tool === 'ad-happy'
      && marker.schemaVersion === RUN_MARKER_SCHEMA
  } catch {
    return false
  }
}

function clearArtifacts(outDir, preserve = new Set()) {
  const failures = []
  for (const name of ARTIFACT_FILES) {
    const path = join(outDir, name)
    if (preserve.has(resolve(path))) continue
    try {
      rmSync(path, { force: true })
    } catch {
      // 不静默：清理失败会写入 manifest.warnings，避免旧报告被误认为本次结果。
      failures.push(name)
    }
  }
  for (const name of ARTIFACT_DIRS) {
    try {
      rmSync(join(outDir, name), { recursive: true, force: true })
    } catch {
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
