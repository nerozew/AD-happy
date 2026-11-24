// SPICE 仿真集成：检测本机仿真器，调用 kicad-happy 的
// `simulate_subcircuits.py` 跑检测到的子电路，并把上游结果归一化为
// AD-Happy 的 finding/coverage 结构。
//
// 上游接口（只读，以实际代码为准）：
//   python -B -X utf8 <kicad-happy>/skills/spice/scripts/simulate_subcircuits.py \
//     <analysis.json> --output <report.json> --workdir <dir> \
//     --simulator <ngspice|ltspice|xyce|auto> [--timeout <秒>]
//
// - 上游只接受一种输入：含 `findings[]` 的分析 JSON。AD-Happy 的检测器名
//   是单数（voltage_divider、rc_filter 等），上游模板注册表用复数键
//   （voltage_dividers、rc_filters 等），因此本模块负责把 detector 名映射
//   成上游 `detect_*` 名称；其余检测器字段原样透传。
// - 上游结果里的 `cir_file` 就是测试台文件；本模块保留其绝对路径，并在
//   coverage 中提供相对输出目录的路径，便于报告与复现。
// - 本模块绝不伪造仿真结果：没有仿真器、缺少上游脚本、上游失败时分别标记
//   not_evaluated / failed，并给出可执行的安装/排查说明。
import { spawnSync } from 'node:child_process'
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'

// 与 selfcheck/datasheets 保持一致的默认上游路径；可用
// KICAD_HAPPY_SPICE_SCRIPTS 或 KICAD_HAPPY_SCRIPTS 覆盖。
const DEFAULT_KICAD_HAPPY_SPICE_SCRIPTS = 'D:/Tools/kicad-happy/skills/spice/scripts'
const SCRIPT_NAME = 'simulate_subcircuits.py'
const PYTHON_TIMEOUT_MS = 120 * 1000
const DEFAULT_SIMULATION_TIMEOUT_SECONDS = 10
const MAX_BUFFER = 8 * 1024 * 1024
const VERSION_PROBE_TIMEOUT_MS = 5000

// 检测顺序与上游 spice_simulator.detect_simulator 一致：
// ngspice → LTspice → Xyce。
const SIMULATOR_ORDER = ['ngspice', 'ltspice', 'xyce']

// 上游 SimulatorBackend.find() 读取的显式路径环境变量。
const SIMULATOR_PATH_ENV = {
  ngspice: 'NGSPICE_PATH',
  ltspice: 'LTSPICE_PATH',
  xyce: 'XYCE_PATH',
}

// PATH 中可执行文件名（大小写不敏感匹配在 Windows 上由文件系统负责）。
const SIMULATOR_COMMANDS = {
  ngspice: ['ngspice'],
  ltspice: ['ltspice', 'LTspice', 'XVIIx64'],
  xyce: ['Xyce', 'xyce'],
}

// 上游 spice_simulator.py 已覆盖的 Windows 常见安装位置；这里再补上
// ADI 新版 LTspice 的 Program Files 路径，减少「装了但检测不到」。
const WINDOWS_DEFAULT_PATHS = {
  ngspice: [
    ['PROGRAMFILES', 'Spice64', 'bin', 'ngspice.exe'],
    [null, 'C:/Spice64/bin/ngspice.exe'],
  ],
  ltspice: [
    ['PROGRAMFILES', 'LTC', 'LTspiceXVII', 'XVIIx64.exe'],
    ['PROGRAMFILES(X86)', 'LTC', 'LTspiceXVII', 'XVIIx64.exe'],
    ['LOCALAPPDATA', 'Programs', 'ADI', 'LTspice', 'LTspice.exe'],
    ['PROGRAMFILES', 'ADI', 'LTspice', 'LTspice.exe'],
  ],
  xyce: [],
}

// AD-Happy 检测器名（单数）→ 上游 findings[].detector（detect_* 形式）。
// 以后新增检测器时只需在这里补映射；不支持的类型会被明确记录，
// 而不是静默交给上游后得到空结果。
const DETECTOR_TO_UPSTREAM = {
  voltage_divider: 'detect_voltage_dividers',
  rc_filter: 'detect_rc_filters',
  lc_filter: 'detect_lc_filters',
  opamp_circuit: 'detect_opamp_circuits',
  crystal_circuit: 'detect_crystal_circuits',
  feedback_network: 'detect_feedback_networks',
  transistor_circuit: 'detect_transistor_circuits',
  current_sense: 'detect_current_sense',
  protection_device: 'detect_protection_devices',
  decoupling: 'detect_decoupling',
  power_regulator: 'detect_power_regulators',
  rf_matching: 'detect_rf_matching',
  bridge_circuit: 'detect_bridge_circuits',
  bms_system: 'detect_bms_systems',
  rf_chain: 'detect_rf_chains',
  snubber_circuit: 'detect_snubber_circuits',
}

// spice_templates.TEMPLATE_REGISTRY 的键（截至上游当前版本）。只做
// findings[] 驱动的模板；inrush_analysis 位于 TOPLEVEL_REGISTRY，需要
// 顶层 `inrush_analysis.rails[]` 输入，AD-Happy 没有该结构，故不纳入。
const SUPPORTED_UPSTREAM_TYPES = new Set([
  'rc_filters',
  'lc_filters',
  'voltage_dividers',
  'opamp_circuits',
  'crystal_circuits',
  'feedback_networks',
  'transistor_circuits',
  'current_sense',
  'protection_devices',
  'decoupling_analysis',
  'power_regulators',
  'rf_matching',
  'bridge_circuits',
  'bms_systems',
  'rf_chains',
  'snubber_circuits',
])

const FINDING_STATUSES = new Set(['pass', 'warn', 'fail', 'skip'])

// 上游 subcircuit_type（单数）→ 中文名；类型标识仍保留在括号中便于追溯。
const SPICE_TYPE_LABELS = {
  rc_filter: 'RC 滤波',
  lc_filter: 'LC 滤波',
  voltage_divider: '分压器',
  opamp_circuit: '运放电路',
  crystal_circuit: '晶振电路',
  feedback_network: '反馈网络',
  transistor_circuit: '晶体管电路',
  current_sense: '电流检测',
  protection_device: '保护器件',
  decoupling: '去耦网络',
  regulator_feedback: '稳压器反馈',
  rf_matching: 'RF 匹配',
  bridge_circuit: '桥式电路',
  bms_balance: 'BMS 均衡',
  rf_chain: 'RF 链路',
  snubber_circuit: '缓冲电路',
}

// ---------------------------------------------------------------------------
// 仿真器检测
// ---------------------------------------------------------------------------

/**
 * 检测本机可用的 SPICE 仿真器。
 *
 * 查找顺序与上游一致：显式环境变量（NGSPICE_PATH / LTSPICE_PATH /
 * XYCE_PATH）→ PATH → Windows 常见安装路径；同一步内按
 * ngspice → ltspice → xyce 选择。SPICE_SIMULATOR=ngspice|ltspice|xyce
 * 时只选择指定仿真器（与上游 preference 行为一致）。
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform
 * }} [options]
 * @returns {{
 *   ngspice?: string,
 *   ltspice?: string,
 *   xyce?: string,
 *   chosen?: { name: 'ngspice'|'ltspice'|'xyce', path: string }
 * }}
 */
export function detectSimulators(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const pathEntries = splitPath(env, platform)

  const found = {}
  for (const name of SIMULATOR_ORDER) {
    const path = findSimulator(name, { env, platform, pathEntries })
    if (path) found[name] = path
  }

  const result = {}
  for (const name of SIMULATOR_ORDER) {
    if (found[name]) result[name] = found[name]
  }

  const preference = text(env.SPICE_SIMULATOR).trim().toLowerCase()
  let chosen = null
  if (SIMULATOR_ORDER.includes(preference)) {
    // 显式指定但没找到时保持未选择，让调用方给出「指定的仿真器不可用」
    // 的明确原因，而不是悄悄换成另一个仿真器。
    if (found[preference]) {
      chosen = { name: preference, path: found[preference] }
    }
  } else {
    for (const name of SIMULATOR_ORDER) {
      if (found[name]) {
        chosen = { name, path: found[name] }
        break
      }
    }
  }
  if (chosen) result.chosen = chosen
  return result
}

function findSimulator(name, { env, platform, pathEntries }) {
  // 1. 显式环境变量优先，与上游 SimulatorBackend.find() 一致。
  const explicitEnv = SIMULATOR_PATH_ENV[name]
  const explicit = text(env[explicitEnv]).trim()
  if (explicit && isExecutableFile(explicit, platform)) {
    return resolve(explicit)
  }

  // 2. PATH 查找。
  const fromPath = findInPath(SIMULATOR_COMMANDS[name], { env, platform, pathEntries })
  if (fromPath) return fromPath

  // 3. Windows 常见安装路径（仅 Windows 生效）。
  if (platform !== 'win32') return null
  for (const parts of WINDOWS_DEFAULT_PATHS[name] ?? []) {
    const candidate = buildWindowsCandidate(parts, env)
    if (candidate && isExecutableFile(candidate, platform)) {
      return resolve(candidate)
    }
  }
  return null
}

function splitPath(env, platform) {
  const raw = text(env.PATH ?? env.Path ?? env.path)
  if (!raw) return []
  return raw
    .split(delimiterFor(platform))
    .map(entry => entry.trim().replace(/^"(.*)"$/u, '$1'))
    .filter(Boolean)
}

function delimiterFor(platform) {
  // 按目标平台决定 PATH 分隔符，而不是当前进程所在的平台。
  return platform === 'win32' ? ';' : ':'
}

function findInPath(names, { env, platform, pathEntries }) {
  for (const entry of pathEntries) {
    for (const name of names) {
      for (const candidateName of executableCandidates(name, env, platform)) {
        const candidate = join(entry, candidateName)
        if (isExecutableFile(candidate, platform)) return resolve(candidate)
      }
    }
  }
  return null
}

function executableCandidates(name, env, platform) {
  if (platform !== 'win32') return [name]
  if (/\.[A-Za-z0-9]+$/u.test(name)) return [name]
  const extensions = text(env.PATHEXT)
    .split(';')
    .map(extension => extension.trim())
    .filter(Boolean)
  const list = extensions.length > 0
    ? extensions
    : ['.COM', '.EXE', '.BAT', '.CMD']
  return [name, ...list.map(extension => `${name}${extension.toLowerCase()}`)]
}

function buildWindowsCandidate(parts, env) {
  const [envKey, ...rest] = parts
  if (envKey === null) {
    return rest.join('/')
  }
  const base = text(env[envKey]).trim()
  if (!base) return null
  return join(base, ...rest)
}

function isExecutableFile(path, platform) {
  let stat
  try {
    stat = statSync(path)
  } catch {
    return false
  }
  if (!stat.isFile()) return false
  if (platform === 'win32') return true
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 查询仿真器版本。只使用非 GUI 的参数；LTspice 没有可靠的命令行版本
 * 查询方式，因此返回「版本未知」而不是启动它。查询失败时 version 为
 * null，绝不猜测。
 *
 * @param {'ngspice'|'ltspice'|'xyce'} name
 * @param {string} path
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, timeoutMs?: number }} [options]
 * @returns {{ version: string|null, text: string|null, note: string|null }}
 */
export function probeSimulatorVersion(name, path, options = {}) {
  if (name === 'ltspice') {
    return {
      version: null,
      text: null,
      note: 'LTspice 没有可靠的命令行版本查询方式；版本未知。',
    }
  }
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const timeoutMs = options.timeoutMs ?? VERSION_PROBE_TIMEOUT_MS

  for (const args of [['--version'], ['-v']]) {
    const result = spawnExecutable(path, args, {
      env,
      platform,
      timeoutMs,
    })
    if (result.error || result.status !== 0) continue
    const output = firstText(result.stdout, result.stderr)
    if (!output) continue
    const parsed = parseVersionText(name, output)
    return {
      version: parsed.version,
      text: parsed.text,
      note: parsed.version ? null : '仿真器返回了输出，但无法识别版本号。',
    }
  }
  return {
    version: null,
    text: null,
    note: '无法通过命令行查询仿真器版本；版本未知。',
  }
}

function parseVersionText(name, output) {
  const lines = output
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean)
  const textLine = truncate(lines[0] ?? '', 160)
  const patterns = name === 'ngspice'
    ? [/ngspice[-\s]*([0-9][0-9A-Za-z.+\-]*)/iu, /([0-9]+\.[0-9][0-9A-Za-z.+\-]*)/u]
    : name === 'xyce'
      ? [/xyce[^0-9]*([0-9][0-9A-Za-z.+\-]*)/iu, /([0-9]+\.[0-9][0-9A-Za-z.+\-]*)/u]
      : [/([0-9]+\.[0-9][0-9A-Za-z.+\-]*)/u]
  for (const pattern of patterns) {
    const match = pattern.exec(textLine) ?? pattern.exec(output)
    if (match) return { version: match[1], text: textLine }
  }
  return { version: null, text: textLine }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 运行 SPICE 仿真。
 *
 * @param {object[]} circuits 原理图分析产出的 findings（可含非仿真类规则）
 * @param {{ name: string, path: string }|null} simulator detectSimulators().chosen
 * @param {string} outDir 输出目录（写入 spice/ 子目录）
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform,
 *   python?: string,
 *   scriptsDir?: string,
 *   timeoutMs?: number,
 *   simulationTimeoutSeconds?: number,
 *   spawn?: Function,
 *   requested?: boolean
 * }} [options]
 * @returns {{ findings: object[], coverage: object }}
 */
export function runSpice(circuits, simulator, outDir, options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const target = resolve(String(outDir ?? ''))
  const list = Array.isArray(circuits) ? circuits.filter(isPlainObject) : []
  const mapped = mapCircuits(list)
  // 兼容直接传入 detectSimulators() 结果（含 chosen）的调用方式。
  const selectedSimulator = isPlainObject(simulator) && isPlainObject(simulator.chosen)
    ? simulator.chosen
    : simulator

  const coverage = emptySpiceCoverage({
    requested: options.requested !== false,
    reasons: [],
  })
  coverage.detectedDetectors = mapped.detected
  coverage.unsupportedDetectors = mapped.unsupported
  coverage.availableCircuits = mapped.circuits.length

  // 没有仿真器：明确未评估，给出缺失项与安装方式；不生成任何结果。
  if (!isPlainObject(selectedSimulator)
    || !text(selectedSimulator.name)
    || !text(selectedSimulator.path)) {
    coverage.reasons.push(
      '未找到可用的 SPICE 仿真器（ngspice / LTspice / Xyce）。'
      + '已检查 NGSPICE_PATH/LTSPICE_PATH/XYCE_PATH 环境变量、PATH，'
      + '以及 Windows 常见安装目录。',
    )
    const preference = text(env.SPICE_SIMULATOR).trim().toLowerCase()
    if (SIMULATOR_ORDER.includes(preference)) {
      coverage.reasons.push(
        `SPICE_SIMULATOR=${preference} 指定了仿真器，但没有找到；`
        + '按上游约定不会自动改用其他仿真器。',
      )
    }
    coverage.installHints = simulatorInstallHints()
    coverage.findings = 1
    return {
      findings: [spiceNotRunFinding(coverage)],
      coverage,
    }
  }

  if (!SIMULATOR_ORDER.includes(selectedSimulator.name)) {
    coverage.reasons.push(
      `不支持的仿真器 "${text(selectedSimulator.name)}"；仅支持 ngspice、LTspice、Xyce。`,
    )
    coverage.findings = 1
    return {
      findings: [spiceNotRunFinding(coverage)],
      coverage,
    }
  }

  const simulatorPath = resolve(text(selectedSimulator.path))
  if (!isExecutableFile(simulatorPath, platform)) {
    coverage.status = 'failed'
    coverage.checks.simulator_detection = 'failed'
    coverage.checks.simulation = 'failed'
    coverage.reasons.push(`仿真器不可执行或不存在：${simulatorPath}`)
    const finding = spiceFailureFinding(
      `仿真器不可执行或不存在：${simulatorPath}`,
      selectedSimulator,
    )
    coverage.findings = 1
    return { findings: [finding], coverage }
  }

  coverage.simulator = {
    name: selectedSimulator.name,
    path: simulatorPath,
    version: null,
    versionText: null,
    versionNote: null,
  }
  coverage.checks.simulator_detection = 'pass'

  // 没有可仿真的子电路：不调用上游，也不伪造一条「通过」。
  if (mapped.circuits.length === 0) {
    coverage.reasons.push(
      '原理图分析没有识别到可仿真的子电路'
      + `（支持：${[...SUPPORTED_UPSTREAM_TYPES].join(', ')}）。`,
    )
    if (mapped.detected.length > 0) {
      coverage.reasons.push(
        `本次检测到的规则：${mapped.detected.join('、')}；`
        + '其中没有上游 SPICE 模板支持的类型。',
      )
    }
    return { findings: [], coverage }
  }

  // 上游脚本只读；先检查，缺脚本属于执行失败而不是「未评估」。
  const scriptsDir = resolveSpiceScriptsDir(options, env)
  const scriptPath = join(scriptsDir, SCRIPT_NAME)
  if (!existsSync(scriptPath)) {
    coverage.status = 'failed'
    coverage.checks.simulation = 'failed'
    coverage.reasons.push(
      `未找到上游仿真脚本：${scriptPath}；请安装 kicad-happy，或设置环境变量 `
      + 'KICAD_HAPPY_SPICE_SCRIPTS 指向 skills/spice/scripts 目录。',
    )
    const finding = spiceFailureFinding(coverage.reasons.join('；'), selectedSimulator)
    coverage.findings = 1
    return { findings: [finding], coverage }
  }

  const versionInfo = probeSimulatorVersion(selectedSimulator.name, simulatorPath, {
    env,
    platform,
  })
  coverage.simulator.version = versionInfo.version
  coverage.simulator.versionText = versionInfo.text
  coverage.simulator.versionNote = versionInfo.note

  const spiceDir = join(target, 'spice')
  const workDir = join(spiceDir, 'work')
  try {
    // 每次运行重建 spice/，避免上次的测试台被当成本次结果。
    rmSync(spiceDir, { recursive: true, force: true })
    mkdirSync(workDir, { recursive: true })
  } catch (error) {
    return spiceStageFailure(coverage, {
      reason: `无法准备仿真输出目录 ${spiceDir}：${error?.message ?? error}`,
      simulator: selectedSimulator,
    })
  }

  const inputPath = join(spiceDir, 'analysis-input.json')
  const reportPath = join(spiceDir, 'simulation-report.json')
  coverage.artifacts = {
    directory: 'spice',
    input: 'spice/analysis-input.json',
    report: 'spice/simulation-report.json',
    workdir: 'spice/work',
  }
  try {
    writeJson(inputPath, {
      schemaVersion: 1,
      source: 'ad-happy',
      generatedAt: displayTimestamp(new Date()),
      findings: mapped.circuits,
    })
  } catch (error) {
    return spiceStageFailure(coverage, {
      reason: `无法写入仿真输入 ${inputPath}：${error?.message ?? error}`,
      simulator: selectedSimulator,
    })
  }

  // 保持调用方给的原样（可能是 PATH 中的 "python"），不要 resolve 成绝对路径。
  const python = text(options.python).trim()
    || text(env.AD_HAPPY_PYTHON).trim()
    || 'python'
  const spawn = typeof options.spawn === 'function' ? options.spawn : spawnSync
  const childEnv = {
    ...env,
    SPICE_SIMULATOR: selectedSimulator.name,
    [SIMULATOR_PATH_ENV[selectedSimulator.name]]: simulatorPath,
  }
  const timeoutSeconds = Number.isFinite(options.simulationTimeoutSeconds)
    ? Math.max(1, Math.trunc(options.simulationTimeoutSeconds))
    : DEFAULT_SIMULATION_TIMEOUT_SECONDS
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1000, Math.trunc(options.timeoutMs))
    : PYTHON_TIMEOUT_MS

  const run = spawn(
    python,
    [
      '-B',
      '-X',
      'utf8',
      scriptPath,
      inputPath,
      '--output',
      reportPath,
      '--workdir',
      workDir,
      '--simulator',
      selectedSimulator.name,
      '--timeout',
      String(timeoutSeconds),
    ],
    {
      cwd: spiceDir,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: MAX_BUFFER,
      timeout: timeoutMs,
      env: childEnv,
    },
  )

  if (run?.error || run?.status !== 0) {
    const reason = run?.error
      ? run.error.code === 'ETIMEDOUT'
        ? `SPICE 仿真超时（${Math.round(timeoutMs / 1000)} 秒）`
        : `无法启动 Python（${python}）：${run.error.message}`
      : `上游 SPICE 仿真退出码 ${run?.status}`
    const detail = firstText(run?.stderr, run?.stdout)
    const message = detail ? `${reason}：${truncate(detail, 400)}` : reason
    return spiceStageFailure(coverage, { reason: message, simulator: selectedSimulator })
  }

  let raw
  try {
    raw = JSON.parse(readFileSync(reportPath, 'utf8'))
  } catch (error) {
    return spiceStageFailure(coverage, {
      reason: `无法读取上游仿真结果 ${reportPath}：${error?.message ?? error}`,
      simulator: selectedSimulator,
    })
  }
  if (!isPlainObject(raw) || raw.analyzer_type !== 'spice'
    || !Array.isArray(raw.simulation_results)) {
    return spiceStageFailure(coverage, {
      reason: '上游 SPICE 结果不是有效的 spice 信封（缺少 analyzer_type 或 simulation_results）。',
      simulator: selectedSimulator,
    })
  }

  const results = raw.simulation_results
    .filter(isPlainObject)
    .map((item, index) => normalizeSimulationResult(item, index, {
      outDir: target,
      simulator: coverage.simulator,
    }))
  const counts = countResults(results)
  coverage.circuits = results
  coverage.counts = counts
  coverage.upstreamSummary = isPlainObject(raw.summary) ? raw.summary : null

  const findings = []
  for (const result of results) {
    if (result.status === 'fail' || result.status === 'warn') {
      findings.push(spiceMismatchFinding(result, coverage.simulator))
    } else if (result.status === 'skip') {
      findings.push(spiceSkippedFinding(result, coverage.simulator))
    }
  }

  if (counts.total === 0) {
    coverage.status = 'not_evaluated'
    coverage.checks.testbench_generation = 'not_evaluated'
    coverage.checks.simulation = 'not_evaluated'
    coverage.reasons.push(
      '上游没有返回任何仿真结果；可仿真的子电路可能在生成测试台时被跳过。',
    )
  } else if (counts.fail > 0 || counts.warn > 0) {
    coverage.status = 'found'
    coverage.checks.testbench_generation = 'pass'
    coverage.checks.simulation = 'found'
    if (counts.fail > 0) {
      coverage.reasons.push(`${counts.fail} 个子电路的仿真结果与解析值不一致。`)
    }
    if (counts.warn > 0) {
      coverage.reasons.push(`${counts.warn} 个子电路的仿真结果存在偏差警告。`)
    }
  } else if (counts.skip === counts.total) {
    coverage.status = 'not_evaluated'
    coverage.checks.testbench_generation = results.every(result => result.testbenchGenerationFailed)
      ? 'failed'
      : 'partial'
    coverage.checks.simulation = 'not_evaluated'
    coverage.reasons.push(
      '所有子电路的仿真均未产出可用测量结果；请查看各子电路的测试台与日志。',
    )
  } else if (counts.skip > 0) {
    coverage.status = 'partial'
    coverage.checks.testbench_generation = 'partial'
    coverage.checks.simulation = 'partial'
    coverage.reasons.push(
      `${counts.skip}/${counts.total} 个子电路未完成仿真；跳过项不代表通过。`,
    )
  } else {
    coverage.status = 'pass'
    coverage.checks.testbench_generation = 'pass'
    coverage.checks.simulation = 'pass'
  }

  coverage.findings = findings.length
  return { findings, coverage }
}

function spiceStageFailure(coverage, { reason, simulator }) {
  coverage.status = 'failed'
  coverage.checks.simulation = 'failed'
  coverage.reasons.push(reason)
  const finding = spiceFailureFinding(reason, simulator)
  coverage.findings = 1
  return { findings: [finding], coverage }
}

// ---------------------------------------------------------------------------
// 输入映射
// ---------------------------------------------------------------------------

function mapCircuits(findings) {
  const circuits = []
  const detected = new Set()
  const unsupported = new Set()
  for (const finding of findings) {
    // 兼容只有 type 字段的调用方；正常原理图 findings 使用 detector。
    const detector = text(finding.detector).trim() || text(finding.type).trim()
    if (!detector) continue
    if (detector === 'spice' || detector === 'parse') continue
    const upstream = upstreamDetectorFor(detector)
    if (!upstream) {
      // 只记录看起来像电路识别的规则，避免把 connectivity / PCB 规则
      // 也算成「不支持的仿真类型」。
      if (isSimulatableDetectorName(detector)) unsupported.add(detector)
      continue
    }
    detected.add(detector)
    circuits.push({
      ...finding,
      // 上游按 detector 名选择模板；AD-Happy 的单数名在这里改名。
      detector: upstream,
      ad_happy_detector: detector,
    })
  }
  return {
    circuits,
    detected: [...detected].sort(compareText),
    unsupported: [...unsupported].sort(compareText),
  }
}

function upstreamDetectorFor(detector) {
  if (DETECTOR_TO_UPSTREAM[detector]) return DETECTOR_TO_UPSTREAM[detector]
  if (detector.startsWith('detect_')) {
    const key = detector.slice('detect_'.length)
    // detect_decoupling 由上游 _DET_KEY_OVERRIDES 映射到
    // decoupling_analysis；这里按同一规则判断。
    const mappedKey = key === 'decoupling' ? 'decoupling_analysis' : key
    return SUPPORTED_UPSTREAM_TYPES.has(mappedKey) ? detector : null
  }
  if (SUPPORTED_UPSTREAM_TYPES.has(detector)) return detector
  return null
}

function isSimulatableDetectorName(detector) {
  return Boolean(DETECTOR_TO_UPSTREAM[detector])
    || detector.startsWith('detect_')
    || SUPPORTED_UPSTREAM_TYPES.has(detector)
}

function normalizeSimulationResult(item, index, { outDir, simulator }) {
  const status = FINDING_STATUSES.has(text(item.status))
    ? text(item.status)
    : 'skip'
  const testbenchAbsolute = resolvePathIfPossible(item.cir_file)
  const logAbsolute = resolvePathIfPossible(item.log_file)
  const testbench = testbenchAbsolute ? relativeDisplay(outDir, testbenchAbsolute) : null
  const logFile = logAbsolute ? relativeDisplay(outDir, logAbsolute) : null
  const components = Array.isArray(item.components)
    ? item.components.map(value => text(value)).filter(Boolean)
    : []
  const reference = text(item.reference) || components.join('/')
  const note = text(item.note).trim()

  const type = text(item.subcircuit_type) || 'simulation'
  return {
    index,
    type,
    typeLabel: SPICE_TYPE_LABELS[type] ?? null,
    reference,
    components,
    status,
    note: note || null,
    // noteText 是报告与 finding 使用的中文文案；note 保留上游原文供排查。
    noteText: localizeSimulationNote(note) || null,
    expected: isPlainObject(item.expected) ? item.expected : null,
    simulated: isPlainObject(item.simulated) ? item.simulated : null,
    delta: isPlainObject(item.delta) ? item.delta : null,
    elapsedSeconds: typeof item.elapsed_s === 'number' ? item.elapsed_s : null,
    testbench,
    testbenchAbsolute,
    testbenchExists: Boolean(testbenchAbsolute && existsSync(testbenchAbsolute)),
    logFile,
    logFileAbsolute: logAbsolute,
    logFileExists: Boolean(logAbsolute && existsSync(logAbsolute)),
    testbenchGenerationFailed: /testbench generation failed/iu.test(note),
    simulatorName: simulator?.name ?? null,
    simulator: {
      name: simulator?.name ?? null,
      version: simulator?.version ?? null,
    },
  }
}

function resolvePathIfPossible(value) {
  const raw = text(value).trim()
  if (!raw) return null
  return resolve(raw)
}

function relativeDisplay(baseDir, path) {
  if (!path) return null
  const relation = relative(baseDir, path)
  const display = relation === '' ? '.' : relation
  return isAbsolute(display) ? display : display.split(sep).join('/')
}

// ---------------------------------------------------------------------------
// finding 生成（全部中文，且只使用上游真实结果）
// ---------------------------------------------------------------------------

function spiceNotRunFinding(coverage) {
  const install = coverage.installHints.join(' ')
  const description = coverage.reasons.join('；')
  return {
    detector: 'spice',
    rule_id: 'SP-001',
    category: 'simulation',
    kind: 'issue',
    severity: 'info',
    confidence: 'deterministic',
    evidence_source: 'file',
    source: 'spice',
    title: '未运行 SPICE 仿真',
    summary: '未运行 SPICE 仿真',
    evidence: `${description}${install ? ` 安装方式：${install}` : ''}`,
    description,
    recommendation: '安装 ngspice、LTspice 或 Xyce 后重新运行；本次没有伪造任何仿真结果。',
    components: [],
    nets: [],
    pins: [],
    install_hints: coverage.installHints,
  }
}

/**
 * 仿真阶段异常 finding（SP-002，error）。CLI 在未预期异常时调用。
 *
 * @param {string} message
 * @returns {object}
 */
export function spiceErrorFinding(message) {
  return spiceFailureFinding(text(message) || '未知错误', null)
}

function spiceFailureFinding(message, simulator) {
  return {
    detector: 'spice',
    rule_id: 'SP-002',
    category: 'analysis_error',
    kind: 'issue',
    severity: 'error',
    confidence: 'deterministic',
    evidence_source: 'file',
    source: 'spice',
    title: 'SPICE 仿真未能执行',
    summary: 'SPICE 仿真未能执行',
    evidence: message,
    description: message,
    recommendation: '检查仿真器与 kicad-happy 的 spice 脚本是否可访问，或查看 manifest.json 中的阶段错误。',
    components: [],
    nets: [],
    pins: [],
    simulator: simulator
      ? {
        name: text(simulator.name) || null,
        path: text(simulator.path) || null,
      }
      : null,
  }
}

function spiceSkippedFinding(result, simulator) {
  const label = circuitLabel(result)
  const typeText = typeTextFor(result)
  const note = result.noteText || '仿真器没有返回可用测量结果。'
  const testbench = result.testbench ? `；测试台：${result.testbench}` : ''
  return {
    detector: 'spice',
    rule_id: 'SP-002',
    category: 'simulation',
    kind: 'issue',
    severity: 'warning',
    confidence: 'deterministic',
    evidence_source: 'file',
    source: 'spice',
    title: `SPICE 仿真未完成：${typeText} ${label}`,
    summary: `SPICE 仿真未完成：${typeText} ${label}`,
    evidence: `${note}${testbench}`,
    description: `${typeText}（${label}）没有产生可用的仿真测量结果。${note}`,
    recommendation: '查看对应测试台与日志，确认仿真器可用、模型与拓扑可收敛；本次没有把跳过当作通过。',
    components: result.components,
    nets: [],
    pins: [],
    testbench: result.testbench,
    log_file: result.logFile,
    simulator: simulatorSnapshot(simulator, result),
    simulation_status: result.status,
  }
}

function spiceMismatchFinding(result, simulator) {
  const label = circuitLabel(result)
  const expected = formatMetricObject(result.expected)
  const simulated = formatMetricObject(result.simulated)
  const delta = formatMetricObject(result.delta)
  const severity = result.status === 'fail' ? 'error' : 'warning'
  const verdict = result.status === 'fail' ? '与解析值明显不一致' : '存在偏差警告'
  const testbench = result.testbench ? `测试台：${result.testbench}` : '测试台路径未记录'
  const note = result.noteText || ''
  const typeText = typeTextFor(result)
  return {
    detector: 'spice',
    rule_id: 'SP-003',
    category: 'simulation',
    kind: 'issue',
    severity,
    confidence: 'deterministic',
    evidence_source: 'topology',
    source: 'spice',
    title: `${typeText} ${label} 仿真结果${verdict}`,
    summary: `${typeText} ${label} 仿真结果${verdict}`,
    evidence: `解析值：${expected || '—'}；仿真值：${simulated || '—'}；偏差：${delta || '—'}；${testbench}`,
    description: `SPICE 仿真（${simulator.name}${simulator.version ? ` ${simulator.version}` : ''}）`
      + `对 ${typeText} ${label} 给出的结果与解析计算不一致。`
      + `${note ? ` 仿真器备注：${note}` : ''}`,
    recommendation: '核对元件值与检测到的拓扑；若检测本身有误，请同时复核原理图中的实际连接。',
    components: result.components,
    nets: [],
    pins: [],
    testbench: result.testbench,
    log_file: result.logFile,
    expected: result.expected,
    simulated: result.simulated,
    delta: result.delta,
    simulator: simulatorSnapshot(simulator, result),
    simulation_status: result.status,
  }
}

// 上游 spice_results.py 的备注是英文；报告与 finding 的可见文本必须是
// 中文。已知模板逐条翻译，未知英文备注按项目既有约定标注「（仿真器原文）」，
// 原文仍保留在 evidence 中，便于排查。
function localizeSimulationNote(rawNote) {
  const note = text(rawNote).trim()
  if (!note) return ''
  const exact = {
    'simulation failed': '仿真未成功完成',
    'ngspice operating point failed': 'ngspice 工作点分析失败',
    'ngspice could not measure -3db frequency': 'ngspice 无法测量 -3dB 频率',
    'ngspice impedance measurement failed': 'ngspice 阻抗测量失败',
    'decoupling caps present — impedance profile simulated': '去耦电容已建模，阻抗曲线已仿真',
  }
  const exactHit = exact[note.toLowerCase()]
  if (exactHit) return exactHit

  const patterns = [
    [/^testbench generation failed[:：]\s*(.+)$/iu, (_, detail) => `测试台生成失败：${detail}`],
    [/^([\d.+\-]+)% deviation\s*[—-]\s*check for loading or parallel paths$/iu, (_, pct) => `偏差 ${pct}%：请检查负载或并联路径`],
    [/^([\d.+\-]+)% deviation\s*[—-]\s*topology may differ from detection$/iu, (_, pct) => `偏差 ${pct}%：拓扑可能与检测结果不同`],
    [/^([\d.+\-]+)% error\s*[—-]\s*check for loading$/iu, (_, pct) => `误差 ${pct}%：请检查负载`],
    [/^([\d.+\-]+)% error\s*[—-]\s*significant deviation$/iu, (_, pct) => `误差 ${pct}%：显著偏差`],
    [/^([\d.+\-]+)% error\s*[—-]\s*regulator output voltage may be wrong$/iu, (_, pct) => `误差 ${pct}%：稳压器输出电压可能不正确`],
    [/^([\d.+\-]+)% error in feedback voltage$/iu, (_, pct) => `反馈电压误差 ${pct}%`],
    [/^z=([\d.]+)Ω at 1mhz$/iu, (_, value) => `1MHz 时阻抗 ${value}Ω`],
    [/^z=([\d.]+)Ω at 1mhz\s*[—-]\s*single bulk cap or high-value rail$/iu, (_, value) => `1MHz 时阻抗 ${value}Ω：可能是单个大电容或高阻值电源轨`],
  ]
  for (const [pattern, build] of patterns) {
    const match = pattern.exec(note)
    if (match) return build(...match)
  }
  if (mostlyAsciiLetters(note)) return `（仿真器原文）${note}`
  return note
}

function mostlyAsciiLetters(value) {
  const letters = [...value].filter(char => /\p{L}/u.test(char))
  if (letters.length < 4) return false
  const ascii = letters.filter(char => char.charCodeAt(0) < 128)
  return ascii.length / letters.length > 0.5
}

function simulatorSnapshot(simulator, result) {
  return {
    name: result.simulator?.name ?? simulator?.name ?? null,
    version: result.simulator?.version ?? simulator?.version ?? null,
    path: simulator?.path ?? null,
  }
}

function typeTextFor(result) {
  return result.typeLabel ? `${result.typeLabel}（${result.type}）` : result.type
}

function circuitLabel(result) {
  if (result.reference) return result.reference
  if (result.components.length > 0) return result.components.join('/')
  return result.type
}

function formatMetricObject(value) {
  if (!isPlainObject(value)) return ''
  return Object.entries(value)
    .map(([key, entry]) => {
      if (typeof entry === 'number' && Number.isFinite(entry)) {
        return `${key}=${roundNumber(entry)}`
      }
      if (typeof entry === 'string' || typeof entry === 'boolean') {
        return `${key}=${entry}`
      }
      return ''
    })
    .filter(Boolean)
    .join(' / ')
}

function roundNumber(value) {
  if (Math.abs(value) >= 1000) return value.toFixed(1)
  if (Math.abs(value) >= 1) return value.toFixed(4)
  return value.toPrecision(6)
}

// ---------------------------------------------------------------------------
// coverage 构造与辅助
// ---------------------------------------------------------------------------

/**
 * 未评估/未请求时的 coverage 骨架，CLI 也复用它。
 *
 * @param {{
 *   requested?: boolean,
 *   reasons?: string[],
 *   detectedDetectors?: string[],
 *   unsupportedDetectors?: string[]
 * }} [options]
 * @returns {object}
 */
export function emptySpiceCoverage(options = {}) {
  return {
    status: 'not_evaluated',
    requested: options.requested === true,
    simulator: null,
    availableCircuits: 0,
    circuits: [],
    counts: { total: 0, pass: 0, warn: 0, fail: 0, skip: 0 },
    detectedDetectors: Array.isArray(options.detectedDetectors)
      ? [...options.detectedDetectors]
      : [],
    unsupportedDetectors: Array.isArray(options.unsupportedDetectors)
      ? [...options.unsupportedDetectors]
      : [],
    checks: {
      simulator_detection: 'not_evaluated',
      testbench_generation: 'not_evaluated',
      simulation: 'not_evaluated',
    },
    artifacts: null,
    installHints: simulatorInstallHints(),
    reasons: Array.isArray(options.reasons) ? options.reasons.filter(Boolean) : [],
    findings: 0,
    upstreamSummary: null,
  }
}

/**
 * 仿真器安装说明。静态文本，不做任何网络请求。
 *
 * @returns {string[]}
 */
export function simulatorInstallHints() {
  return [
    'ngspice：Windows 可安装官方 Spice64 包，或执行 choco install ngspice；也可设置 NGSPICE_PATH 指向 ngspice.exe。',
    'LTspice：从 analog.com/ltspice 安装；也可设置 LTSPICE_PATH 指向 LTspice.exe / XVIIx64.exe。',
    'Xyce：从 xyce.sandia.gov 安装；也可设置 XYCE_PATH 指向 Xyce 可执行文件。',
    '三个环境变量都只在本机读取路径，不会联网下载或安装软件。',
  ]
}

/**
 * 上游脚本目录解析。优先级：
 * 1. options.scriptsDir；
 * 2. KICAD_HAPPY_SPICE_SCRIPTS；
 * 3. 由 KICAD_HAPPY_SCRIPTS（.../skills/kicad/scripts）推导同级 spice/scripts；
 * 4. 本机默认安装位置。
 *
 * @param {object} options
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveSpiceScriptsDir(options = {}, env = process.env) {
  if (options.scriptsDir) return resolve(String(options.scriptsDir))
  const explicit = text(env?.KICAD_HAPPY_SPICE_SCRIPTS).trim()
  if (explicit) return resolve(explicit)
  const kicadScripts = text(env?.KICAD_HAPPY_SCRIPTS).trim()
  if (kicadScripts) {
    return join(dirname(dirname(resolve(kicadScripts))), 'spice', 'scripts')
  }
  return resolve(DEFAULT_KICAD_HAPPY_SPICE_SCRIPTS)
}

function countResults(results) {
  const counts = { total: results.length, pass: 0, warn: 0, fail: 0, skip: 0 }
  for (const result of results) {
    if (result.status in counts) counts[result.status] += 1
  }
  return counts
}

// ---------------------------------------------------------------------------
// 进程与文件辅助
// ---------------------------------------------------------------------------

function spawnExecutable(path, args, { env, platform, timeoutMs }) {
  const options = {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    env,
  }
  if (platform === 'win32' && /\.(?:cmd|bat)$/iu.test(path)) {
    // .cmd/.bat 不能由 CreateProcess 直接执行，交给 cmd.exe；参数由 Node
    // 负责加引号，路径中的空格不会把命令拆开。
    const comspec = text(env?.ComSpec).trim() || process.env.ComSpec || 'cmd.exe'
    return spawnSync(comspec, ['/d', '/c', path, ...args], options)
  }
  return spawnSync(path, args, options)
}

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function displayTimestamp(date) {
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
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
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function truncate(value, limit) {
  const textValue = String(value ?? '')
  if (textValue.length <= limit) return textValue
  return `${textValue.slice(0, Math.max(limit - 1, 0))}…`
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}
