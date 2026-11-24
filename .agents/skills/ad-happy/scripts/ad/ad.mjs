// AD 原生检查：探测 AD-MCP 可用性，调用 stdio 桥，把 ERC/DRC/库结果
// 归一化为 AD-Happy findings 与覆盖模型。
//
// 本模块只负责确定性编排与归一化：
// - 不修改 Altium 工程；所有中间产物写入 --out。
// - 工具失败/超时/返回非 JSON 时记录错误并标记 failed，不伪造结论。
// - 没有库文件或没有匹配项时标记 not_evaluated/partial 并说明原因。
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const CLIENT_PY = join(SCRIPT_DIR, 'mcp_client.py')

// 用户本机的 AD-MCP 安装位置；可通过 AD_HAPPY_AD_MCP_SERVER 覆盖。
export const DEFAULT_AD_SERVER =
  'D:/NeroZe/pcb布局/AD26_PCB自动布局_工具包/01-altium-mcp/installed-v0.7.0'

// 深度模式启用后才会加入规则表的三条规则。
export const NATIVE_RULES = ['native_erc', 'native_drc', 'native_library']

const DEFAULT_TOOL_TIMEOUT_MS = 300_000
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000
const DEFAULT_MAX_VIOLATIONS = 200
const DEFAULT_MAX_LIBRARY_DUMPS = 50
const MAX_BRIDGE_TIMEOUT_MS = 30 * 60 * 1000
const MAX_BRIDGE_STDOUT = 32 * 1024 * 1024

// ---------------------------------------------------------------------------
// 可用性探测
// ---------------------------------------------------------------------------

/**
 * 检测 --with-ad 是否可用。
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   platform?: string,
 *   serverPath?: string,
 *   python?: string,
 *   skipProcessCheck?: boolean,
 * }} [options]
 * @returns {{
 *   available: boolean,
 *   serverPath: string,
 *   python: string,
 *   code: string,
 *   reason: string,
 *   prerequisites: string[],
 *   installCommand: string | null,
 *   altiumRunning: boolean,
 *   altiumExePath: string,
 *   mcpFile: string,
 *   pythonVersion: string,
 *   processCheck: string,
 * }}
 */
export function detectAdAvailability(options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) }
  const platform = options.platform ?? process.platform
  const inputPath = resolve(
    options.serverPath
      ?? (typeof env.AD_HAPPY_AD_MCP_SERVER === 'string' && env.AD_HAPPY_AD_MCP_SERVER.trim()
        ? env.AD_HAPPY_AD_MCP_SERVER.trim()
        : DEFAULT_AD_SERVER),
  )
  const paths = resolveServerPaths(inputPath)
  const result = {
    available: false,
    serverPath: paths.serverPath,
    mainPath: paths.mainPath,
    launcherPath: paths.launcherPath,
    python: '',
    code: '',
    reason: '',
    prerequisites: [],
    installCommand: null,
    altiumRunning: false,
    altiumExePath: readConfiguredAltiumPath(paths.serverPath),
    mcpFile: '',
    pythonVersion: '',
    processCheck: 'not_checked',
  }

  if (!existsSync(paths.mainPath)) {
    result.code = 'server_missing'
    result.reason =
      `找不到 AD-MCP 服务端：${paths.mainPath}。`
      + '请设置 AD_HAPPY_AD_MCP_SERVER 指向 AD-MCP 安装目录（包含 start_server.py 与 server/main.py）。'
    result.prerequisites = [
      '安装 AD-MCP（官方安装包或仓库），并确认目录中存在 server/main.py',
      `当前查找路径：${inputPath}`,
    ]
    return result
  }
  if (!existsSync(CLIENT_PY)) {
    result.code = 'bridge_missing'
    result.reason = `AD-Happy 的 MCP 桥不存在：${CLIENT_PY}。请重新安装 ad-happy skill。`
    result.prerequisites = ['重新安装 ad-happy skill，确保 scripts/ad/mcp_client.py 存在']
    return result
  }
  if (platform !== 'win32') {
    result.code = 'unsupported_platform'
    result.reason = 'AD 原生检查只能在 Windows 上进行：Altium Designer 与 AD-MCP 都依赖 Windows。'
    result.prerequisites = ['在运行 Altium Designer 的 Windows 机器上使用 --with-ad']
    return result
  }

  const python = findPythonWithMcp({
    env,
    serverPath: paths.serverPath,
    requested: options.python,
  })
  if (!python.ok) {
    const buildCommand = existsSync(paths.launcherPath)
      ? `python "${paths.launcherPath}" --build`
      : null
    const missingModules = python.missing ?? []
    const missingMcp = missingModules.includes('mcp') || missingModules.length === 0
    result.code = missingMcp ? 'mcp_missing' : 'server_deps_missing'
    result.reason = missingMcp
      ? '没有找到已安装 Python mcp 包的解释器。'
        + `已尝试：${python.tried.join('、') || '（无）'}。`
        + 'AD-MCP 的 stdio 客户端需要 mcp 包；请安装它或把 AD_HAPPY_AD_PYTHON 指向可用解释器。'
      : `找到的解释器缺少 AD-MCP 依赖：${missingModules.join('、')}。`
        + `已尝试：${python.tried.join('、') || '（无）'}。`
        + '这些模块由 AD-MCP 的 requirements.txt 提供（mcp、pywin32、Pillow）。'
    result.installCommand = buildCommand
      ?? 'python -m pip install "mcp[cli]==1.30.0" pywin32 pillow'
    result.prerequisites = [
      'Python ≥ 3.10，且能导入 mcp、win32gui、win32ui、win32con、win32api、win32process、PIL',
      '安装命令：python -m pip install "mcp[cli]==1.30.0" pywin32 pillow',
      ...(buildCommand
        ? [`或先构建 AD-MCP 自己的 venv（只需一次）：${buildCommand}`]
        : []),
      '或设置 AD_HAPPY_AD_PYTHON 指向 AD-MCP 自带的 python.exe',
    ]
    return result
  }
  result.python = python.command
  result.mcpFile = python.mcpFile
  result.pythonVersion = python.version

  const skipProcessCheck = options.skipProcessCheck
    ?? env.AD_HAPPY_AD_SKIP_PROCESS_CHECK === '1'
  const altium = checkAltiumRunning({ platform, env, skip: skipProcessCheck })
  result.altiumRunning = altium.running
  result.processCheck = altium.check
  if (!altium.running) {
    result.code = 'ad_not_running'
    result.reason = altium.error
      ? `无法确认 Altium Designer 是否运行：${altium.error}。`
      : 'Altium Designer 未运行（未找到 X2.EXE 进程）。'
    if (!altium.error) {
      result.reason += '请先启动 Altium Designer 并打开要审查的工程，再使用 --with-ad。'
    }
    result.prerequisites = [
      '启动 Altium Designer（AD26 的进程名为 X2.EXE）',
      '在 Altium 中打开目标工程；ERC/DRC 与库读取都必须由 Altium 执行',
    ]
    return result
  }

  result.available = true
  result.code = 'ok'
  return result
}

function resolveServerPaths(inputPath) {
  let serverPath = resolve(inputPath)
  let mainPath = join(serverPath, 'server', 'main.py')
  if (!existsSync(mainPath) && existsSync(join(serverPath, 'main.py'))) {
    mainPath = join(serverPath, 'main.py')
    serverPath = dirname(serverPath)
  }
  return {
    serverPath,
    mainPath,
    launcherPath: join(serverPath, 'start_server.py'),
  }
}

function findPythonWithMcp({ env, serverPath, requested }) {
  const tried = []
  const missing = new Set()
  const candidates = []
  const push = (value) => {
    if (typeof value !== 'string' || !value.trim()) return
    if (!candidates.includes(value)) candidates.push(value)
  }
  push(requested)
  push(env.AD_HAPPY_AD_PYTHON)
  push(join(serverPath, '.venv', 'Scripts', 'python.exe'))
  push(join(serverPath, 'venv', 'Scripts', 'python.exe'))
  // start_server.py --build 把 venv 建在 per-user 的 ALTIUM_MCP_HOME 下。
  const altiumHome = env.ALTIUM_MCP_HOME || join(homedir(), '.altium-mcp')
  for (const python of listBuiltVenvPythons(altiumHome)) push(python)
  push('python')
  push('python3')

  for (const candidate of candidates) {
    // 明确的路径候选必须存在；`python` / `python3` 交给 PATH 解析。
    if (/[\\/]/u.test(candidate) && !existsSync(candidate)) {
      tried.push(`${candidate}（不存在）`)
      continue
    }
    tried.push(candidate)
    const probe = probePython(candidate, env)
    if (probe.ok) return { ...probe, tried }
    for (const module of probe.missing ?? []) missing.add(module)
  }
  return { ok: false, tried, missing: [...missing] }
}

function probePython(command, env) {
  // AD-MCP 的 server/main.py 除了 mcp 还导入 pywin32 与 Pillow；只检查 mcp
  // 会在系统 Python 缺 win32 模块时误报可用。
  const script = [
    'import importlib.util, sys',
    "names = ('mcp', 'win32gui', 'win32ui', 'win32con', 'win32api', 'win32process', 'PIL')",
    'missing = [name for name in names if importlib.util.find_spec(name) is None]',
    "print('MISSING:' + ','.join(missing))",
    'print(sys.version.split()[0])',
    "spec = importlib.util.find_spec('mcp')",
    "print(spec.origin if spec else '')",
    'sys.exit(0 if not missing else 2)',
  ].join('\n')
  const probe = spawnSync(
    command,
    ['-B', '-c', script],
    {
      env,
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  )
  const lines = String(probe.stdout ?? '').trim().split(/\r?\n/u)
  const missing = String(lines[0] ?? '').startsWith('MISSING:')
    ? String(lines[0]).slice('MISSING:'.length).split(',').filter(Boolean)
    : []
  if (probe.error || probe.status !== 0 || missing.length > 0) {
    return { ok: false, missing }
  }
  return {
    ok: true,
    command,
    version: lines[1] ?? '',
    mcpFile: lines[2] ?? '',
  }
}

// `python start_server.py --build` 把 venv 放在 <ALTIUM_MCP_HOME>/venvs/<hash>。
// 已构建过的解释器可以直接用来运行 server/main.py。
function listBuiltVenvPythons(altiumHome) {
  const venvsDir = join(altiumHome, 'venvs')
  let entries
  try {
    entries = readdirSync(venvsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const result = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const python = join(venvsDir, entry.name, 'Scripts', 'python.exe')
    if (existsSync(python)) result.push(python)
  }
  return result
}

function checkAltiumRunning({ platform, env, skip }) {
  if (skip) return { running: true, check: 'skipped' }
  if (platform !== 'win32') return { running: false, check: 'unsupported' }
  const probe = spawnSync(
    'tasklist',
    ['/FI', 'IMAGENAME eq X2.EXE', '/FO', 'CSV', '/NH'],
    {
      env,
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  )
  if (probe.error || probe.status !== 0) {
    return {
      running: false,
      check: 'tasklist_failed',
      error: probe.error?.message || `tasklist 退出码 ${probe.status}`,
    }
  }
  const output = String(probe.stdout ?? '')
  return {
    running: /"X2\.EXE"/iu.test(output),
    check: 'tasklist',
  }
}

function readConfiguredAltiumPath(serverPath) {
  const candidates = [
    join(serverPath, 'mcp-state', 'config.json'),
    join(serverPath, 'config.json'),
    join(homedir(), '.altium-mcp', 'config.json'),
  ]
  for (const candidate of candidates) {
    try {
      const config = JSON.parse(readFileSync(candidate, 'utf8'))
      const path = config?.altium_exe_path
      if (typeof path === 'string' && path.trim() && existsSync(path)) {
        return path.trim()
      }
    } catch {
      // 配置不存在或不可解析：交给 AD-MCP 自己从运行进程/注册表发现。
    }
  }
  return ''
}

// ---------------------------------------------------------------------------
// 库发现
// ---------------------------------------------------------------------------

/**
 * 从工程文档清单和工程目录顶层收集 `.SchLib` / `.PcbLib` / `.IntLib`。
 * `.IntLib` 不是 AD-MCP 原语工具支持的输入，只记录为未评估。
 *
 * @param {string} projectDir
 * @param {Array<{path: string, name?: string, kind?: string}>} [documents]
 * @returns {Array<{path: string, name: string, kind: 'schlib'|'pcblib'|'intlib'|'unsupported', exists: boolean}>}
 */
export function discoverLibraries(projectDir, documents = []) {
  const found = []
  const seen = new Set()
  const add = (path) => {
    if (typeof path !== 'string' || !path.trim()) return
    const resolved = resolve(path)
    const key = resolved.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    const kind = inferLibraryKind(resolved)
    if (kind === 'unsupported') return
    found.push({
      path: resolved,
      name: basename(resolved),
      kind,
      exists: existsSync(resolved),
    })
  }

  for (const document of Array.isArray(documents) ? documents : []) {
    if (document?.kind !== 'lib') continue
    add(document.path)
  }
  try {
    for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      add(join(projectDir, entry.name))
    }
  } catch {
    // 目录不可读时保留文档清单中的库；具体错误由后续文件检查暴露。
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

function inferLibraryKind(path) {
  const ext = extname(path).toLowerCase()
  if (ext === '.schlib') return 'schlib'
  if (ext === '.pcblib') return 'pcblib'
  if (ext === '.intlib') return 'intlib'
  return 'unsupported'
}

function normalizeLibraries(libraries) {
  const entries = []
  const seen = new Set()
  const add = (value, kindHint) => {
    let path = ''
    let kind = kindHint
    if (typeof value === 'string') {
      path = value
    } else if (isPlainObject(value)) {
      path = scalarText(value.path ?? value.file ?? value.libraryPath)
      kind = scalarText(value.kind) || kindHint
    }
    if (!path.trim()) return
    const resolved = resolve(path)
    const key = resolved.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    const lowered = scalarText(kind).toLowerCase()
    const inferred = isLibraryKind(lowered) ? lowered : inferLibraryKind(resolved)
    if (inferred === 'unsupported') return
    entries.push({
      path: resolved,
      name: basename(resolved),
      kind: inferred,
      exists: existsSync(resolved),
    })
  }

  if (Array.isArray(libraries)) {
    for (const value of libraries) add(value)
  } else if (isPlainObject(libraries)) {
    for (const key of ['sch', 'schlib', 'schLib', 'symbols']) {
      for (const value of arrayOf(libraries[key])) add(value, 'schlib')
    }
    for (const key of ['pcb', 'pcblib', 'pcbLib', 'footprints']) {
      for (const value of arrayOf(libraries[key])) add(value, 'pcblib')
    }
    for (const key of ['all', 'paths', 'libraries']) {
      for (const value of arrayOf(libraries[key])) add(value)
    }
  }
  return entries
}

function isLibraryKind(value) {
  return ['schlib', 'pcblib', 'intlib'].includes(String(value).toLowerCase())
}

function arrayOf(value) {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
}

// ---------------------------------------------------------------------------
// 覆盖模型
// ---------------------------------------------------------------------------

function emptyErcCoverage(reasons = []) {
  return {
    status: 'not_evaluated',
    compiled: false,
    total: 0,
    fatal: 0,
    errors: 0,
    warnings: 0,
    listed: 0,
    unsavedInAltium: 0,
    missingOnDisk: 0,
    types: {},
    reasons,
  }
}

function emptyDrcCoverage(reasons = []) {
  return {
    status: 'not_evaluated',
    ran: false,
    violationCount: 0,
    listed: 0,
    complete: null,
    byRule: {},
    board: null,
    report: null,
    reasons,
  }
}

/**
 * 未启用/不可用时的空覆盖。离线默认运行只保留一条原因，不产生 finding。
 */
export function emptyNativeCoverage({ requested = false, available = false, reasons = [] } = {}) {
  // 每个检查各自持有一份 reasons，避免 ERC/DRC 共享同一个数组后互相污染。
  const reasonList = [...reasons]
  return {
    requested,
    status: 'not_evaluated',
    available,
    serverPath: null,
    python: null,
    altium: { running: null, processCheck: null },
    checks: {
      erc: { status: 'not_evaluated', reason: reasonList[0] ?? '' },
      drc: { status: 'not_evaluated', reason: reasonList[0] ?? '' },
      symbol_libraries: { status: 'not_evaluated', reason: reasonList[0] ?? '' },
      footprint_libraries: { status: 'not_evaluated', reason: reasonList[0] ?? '' },
      library_crosscheck: { status: 'not_evaluated', reason: reasonList[0] ?? '' },
      library: { status: 'not_evaluated', reason: reasonList[0] ?? '' },
    },
    erc: emptyErcCoverage([]),
    drc: emptyDrcCoverage([]),
    libraries: [],
    counts: {
      issues: 0,
      facts: 0,
      erc: { total: 0, fatal: 0, errors: 0, warnings: 0, listed: 0 },
      drc: { violationCount: 0, listed: 0 },
      libraries: {
        total: 0,
        symbolLibraries: 0,
        footprintLibraries: 0,
        matchedSymbols: 0,
        matchedFootprints: 0,
        mismatches: 0,
        failed: 0,
      },
    },
    reasons: [...reasonList],
    findings: 0,
    artifacts: null,
  }
}

// ---------------------------------------------------------------------------
// 原生检查主流程
// ---------------------------------------------------------------------------

/**
 * 运行 AD 原生检查并归一化。
 *
 * @param {{
 *   projectPath?: string,
 *   boardPath?: string,
 *   libraries?: Array<string|object>|object,
 *   schematic?: object|null,
 *   pcbSnapshot?: object|null,
 *   outDir: string,
 *   availability?: object,
 *   env?: NodeJS.ProcessEnv,
 *   maxViolations?: number,
 *   toolTimeoutMs?: number,
 *   startupTimeoutMs?: number,
 *   maxLibraryDumps?: number,
 * }} options
 * @returns {{ findings: object[], coverage: object, bridge: object }}
 */
export function runNativeChecks(options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) }
  const outDir = options.outDir
  if (!outDir) throw new Error('runNativeChecks 需要 outDir')

  const availability = options.availability ?? detectAdAvailability({ env })
  if (!availability.available) {
    const coverage = emptyNativeCoverage({
      requested: true,
      available: false,
      reasons: [availability.reason || 'AD-MCP 不可用'],
    })
    coverage.serverPath = availability.serverPath ?? null
    coverage.python = availability.python ?? null
    coverage.status = 'failed'
    return {
      findings: [nativeFailureFinding(availability.reason || 'AD-MCP 不可用')],
      coverage,
      bridge: null,
    }
  }

  const adDir = join(outDir, 'ad')
  const altiumHome = join(adDir, 'mcp-home')
  mkdirSync(altiumHome, { recursive: true })
  writeAdMcpConfig(altiumHome, availability.altiumExePath)

  const toolTimeoutMs = positiveNumber(options.toolTimeoutMs, envInt(env, 'AD_HAPPY_AD_TOOL_TIMEOUT_MS', DEFAULT_TOOL_TIMEOUT_MS))
  const startupTimeoutMs = positiveNumber(options.startupTimeoutMs, envInt(env, 'AD_HAPPY_AD_STARTUP_TIMEOUT_MS', DEFAULT_STARTUP_TIMEOUT_MS))
  const maxViolations = positiveNumber(options.maxViolations, envInt(env, 'AD_HAPPY_AD_MAX_VIOLATIONS', DEFAULT_MAX_VIOLATIONS))
  const maxLibraryDumps = positiveNumber(options.maxLibraryDumps, envInt(env, 'AD_HAPPY_AD_MAX_LIBRARY_DUMPS', DEFAULT_MAX_LIBRARY_DUMPS))

  const coverage = emptyNativeCoverage({ requested: true, available: true })
  coverage.serverPath = availability.serverPath
  coverage.python = availability.python
  coverage.altium = {
    running: availability.altiumRunning === true,
    processCheck: availability.processCheck ?? null,
  }

  const findings = []
  const libraries = normalizeLibraries(options.libraries ?? [])
  const inventoryCalls = []
  const inventoryMeta = new Map()

  // 1) ERC：只需要工程路径。
  if (options.projectPath) {
    if (existsSync(options.projectPath)) {
      inventoryCalls.push({
        id: 'erc',
        tool: 'get_erc_violations',
        arguments: { compile: true, project_path: options.projectPath },
        timeoutMs: toolTimeoutMs,
      })
      inventoryMeta.set('erc', { kind: 'erc' })
    } else {
      coverage.checks.erc = {
        status: 'failed',
        reason: `工程文件不存在：${options.projectPath}`,
      }
      coverage.erc.reasons.push(coverage.checks.erc.reason)
      findings.push(ercFailureFinding(coverage.checks.erc.reason))
    }
  } else {
    coverage.checks.erc = { status: 'not_evaluated', reason: '没有可编译的 .PrjPcb' }
    coverage.erc.reasons.push(coverage.checks.erc.reason)
  }

  // 2) 库清单：只对受支持的 .SchLib / .PcbLib 调用原语工具。
  const libraryStates = libraries.map((library, index) => {
    const state = {
      index,
      path: library.path,
      name: library.name,
      kind: library.kind,
      exists: library.exists,
      status: 'not_evaluated',
      inventory: 'not_evaluated',
      symbolCount: 0,
      footprintCount: 0,
      matched: [],
      dumped: 0,
      mismatches: [],
      failedDumps: [],
      incompleteDumps: [],
      reasons: [],
    }
    if (library.kind === 'intlib') {
      state.reasons.push('集成库（.IntLib）不能直接交给 AD-MCP 的符号/封装原语工具读取')
      return state
    }
    if (!library.exists) {
      state.status = 'failed'
      state.inventory = 'failed'
      state.reasons.push('库文件不存在')
      return state
    }
    if (library.kind === 'schlib') {
      inventoryCalls.push({
        id: `symbol-inventory:${index}`,
        tool: 'get_symbol_primitives',
        arguments: { library_path: library.path, symbol_name: '' },
        timeoutMs: toolTimeoutMs,
      })
      inventoryMeta.set(`symbol-inventory:${index}`, { kind: 'symbol_inventory', libraryIndex: index })
    } else if (library.kind === 'pcblib') {
      inventoryCalls.push({
        id: `footprint-inventory:${index}`,
        tool: 'get_footprint_primitives',
        arguments: { library_path: library.path, footprint_name: '' },
        timeoutMs: toolTimeoutMs,
      })
      inventoryMeta.set(`footprint-inventory:${index}`, { kind: 'footprint_inventory', libraryIndex: index })
    }
    return state
  })

  // 3) DRC 放最后：它最慢，且可能被 Altium 对话框阻塞；即使超时也不影响
  //    已经拿到的 ERC 与库清单结果。
  if (options.boardPath) {
    if (existsSync(options.boardPath)) {
      inventoryCalls.push({
        id: 'drc',
        tool: 'run_drc',
        arguments: { board_path: options.boardPath, max_violations: maxViolations },
        timeoutMs: toolTimeoutMs,
      })
      inventoryMeta.set('drc', { kind: 'drc' })
    } else {
      coverage.checks.drc = {
        status: 'failed',
        reason: `PCB 文件不存在：${options.boardPath}`,
      }
      coverage.drc.reasons.push(coverage.checks.drc.reason)
      findings.push(drcFailureFinding(coverage.checks.drc.reason))
    }
  } else {
    coverage.checks.drc = { status: 'not_evaluated', reason: '没有可检查的 .PcbDoc' }
    coverage.drc.reasons.push(coverage.checks.drc.reason)
  }

  const bridgeInventory = inventoryCalls.length > 0
    ? invokeBridge({
      availability,
      calls: inventoryCalls,
      outDir,
      requestName: 'inventory-request.json',
      resultName: 'inventory-result.json',
      startupTimeoutMs,
      env,
    })
    : null

  // 4) ERC 归一化。
  if (inventoryMeta.has('erc')) {
    applyErcResult({
      call: bridgeInventory?.calls?.erc,
      coverage,
      findings,
    })
  }

  // 5) 库清单归一化并准备 dump 调用。
  const dumpCalls = []
  const dumpMeta = new Map()
  const schematicComponents = Array.isArray(options.schematic?.components)
    ? options.schematic.components
    : null
  const pcbComponents = Array.isArray(options.pcbSnapshot?.components)
    ? options.pcbSnapshot.components
    : null
  const pcbPads = Array.isArray(options.pcbSnapshot?.pads) ? options.pcbSnapshot.pads : []

  for (const state of libraryStates) {
    const inventoryId = state.kind === 'schlib'
      ? `symbol-inventory:${state.index}`
      : `footprint-inventory:${state.index}`
    if (!inventoryMeta.has(inventoryId)) {
      if (state.reasons.length > 0) {
        // 已记录具体原因（IntLib/文件不存在），维持 failed/not_evaluated。
        if (state.status === 'failed') {
          findings.push(libraryFailureFinding(state, '清单读取', state.reasons.join('；')))
        }
      }
      continue
    }
    const call = bridgeInventory?.calls?.[inventoryId]
    if (!call?.ok) {
      state.status = 'failed'
      state.inventory = 'failed'
      const reason = call?.error || bridgeInventory?.reason || '库清单读取失败'
      state.reasons.push(reason)
      findings.push(libraryFailureFinding(state, '清单读取', reason))
      continue
    }
    const result = call.result
    if (state.kind === 'schlib') {
      const names = readInventoryNames(result, 'symbols')
      if (!names) {
        state.status = 'failed'
        state.inventory = 'failed'
        state.reasons.push('符号库清单缺少 symbols 数组')
        findings.push(libraryFailureFinding(state, '清单解析', state.reasons.at(-1)))
        continue
      }
      state.inventory = 'ok'
      state.symbolCount = names.length
      const matches = matchSymbols(names, schematicComponents)
      state.matched = matches.map(match => ({
        name: match.name,
        components: match.components.map(component => component.reference).filter(Boolean),
      }))
      if (matches.length === 0) {
        state.status = 'partial'
        state.reasons.push(
          schematicComponents
            ? '库中没有符号名与原理图元件名称匹配；符号引脚核对未执行'
            : '没有原理图数据，无法匹配库符号',
        )
        continue
      }
      for (const match of matches.slice(0, maxLibraryDumps)) {
        const id = `symbol-dump:${state.index}:${dumpCalls.length}`
        dumpCalls.push({
          id,
          tool: 'get_symbol_primitives',
          arguments: { library_path: state.path, symbol_name: match.name },
          timeoutMs: toolTimeoutMs,
        })
        dumpMeta.set(id, { kind: 'symbol_dump', libraryIndex: state.index, match })
      }
      if (matches.length > maxLibraryDumps) {
        state.reasons.push(
          `匹配到 ${matches.length} 个符号，只读取前 ${maxLibraryDumps} 个的引脚明细`,
        )
      }
    } else if (state.kind === 'pcblib') {
      const names = readInventoryNames(result, 'footprints')
      if (!names) {
        state.status = 'failed'
        state.inventory = 'failed'
        state.reasons.push('封装库清单缺少 footprints 数组')
        findings.push(libraryFailureFinding(state, '清单解析', state.reasons.at(-1)))
        continue
      }
      state.inventory = 'ok'
      state.footprintCount = names.length
      const matches = matchFootprints(names, pcbComponents)
      state.matched = matches.map(match => ({
        name: match.name,
        components: match.components.map(component => component.reference).filter(Boolean),
      }))
      if (matches.length === 0) {
        state.status = 'partial'
        state.reasons.push(
          pcbComponents
            ? '库中没有封装名与 PCB 元件 footprint 匹配；焊盘核对未执行'
            : '没有 PCB 数据，无法匹配库封装',
        )
        continue
      }
      for (const match of matches.slice(0, maxLibraryDumps)) {
        const id = `footprint-dump:${state.index}:${dumpCalls.length}`
        dumpCalls.push({
          id,
          tool: 'get_footprint_primitives',
          arguments: { library_path: state.path, footprint_name: match.name },
          timeoutMs: toolTimeoutMs,
        })
        dumpMeta.set(id, { kind: 'footprint_dump', libraryIndex: state.index, match })
      }
      if (matches.length > maxLibraryDumps) {
        state.reasons.push(
          `匹配到 ${matches.length} 个封装，只读取前 ${maxLibraryDumps} 个的焊盘明细`,
        )
      }
    }
  }

  // 6) 库明细（dump）第二阶段。
  const bridgeDumps = dumpCalls.length > 0
    ? invokeBridge({
      availability,
      calls: dumpCalls,
      outDir,
      requestName: 'dumps-request.json',
      resultName: 'dumps-result.json',
      startupTimeoutMs,
      env,
    })
    : null

  for (const [id, meta] of dumpMeta.entries()) {
    const state = libraryStates[meta.libraryIndex]
    const call = bridgeDumps?.calls?.[id]
    if (!call?.ok) {
      const reason = call?.error || bridgeDumps?.reason || '库明细读取失败'
      state.failedDumps.push({ name: meta.match.name, error: reason })
      state.reasons.push(`${meta.match.name}：${reason}`)
      continue
    }
    state.dumped += 1
    if (meta.kind === 'symbol_dump') {
      applySymbolCheck({ state, match: meta.match, result: call.result, findings })
    } else {
      applyFootprintCheck({
        state,
        match: meta.match,
        result: call.result,
        pcbPads,
        findings,
      })
    }
  }

  // 7) DRC 归一化。
  if (inventoryMeta.has('drc')) {
    applyDrcResult({
      call: bridgeInventory?.calls?.drc,
      coverage,
      findings,
      maxViolations,
    })
  }

  // 8) 库状态收尾：dump 失败要把状态写回，不能让「清单成功」掩盖明细失败。
  for (const state of libraryStates) {
    if (state.status === 'failed') continue
    if (state.mismatches.length > 0) {
      state.status = 'found'
    } else if (state.failedDumps.length > 0) {
      state.status = 'partial'
      findings.push(libraryFailureFinding(
        state,
        '明细读取',
        `${state.failedDumps.length} 个条目读取失败：`
          + state.failedDumps.slice(0, 3).map(entry => `${entry.name}（${entry.error}）`).join('；'),
      ))
    } else if (state.incompleteDumps.length > 0) {
      // 工具调用成功但结果不可用（例如没有引脚/具名焊盘）：这是覆盖不足，
      // 不是执行失败，记录 partial 和原因，不产生 AD-LIB-000 执行错误。
      state.status = 'partial'
      state.reasons.push(
        ...state.incompleteDumps.map(entry => `${entry.name}：${entry.error}`),
      )
    } else if (state.status === 'not_evaluated' && state.inventory === 'ok') {
      state.status = 'pass'
    }
    if (state.reasons.length === 0 && state.status === 'pass') {
      state.reasons.push('清单、明细与离线数据一致')
    }
  }

  if (bridgeInventory && !bridgeInventory.ok && inventoryCalls.length > 0) {
    // 启动失败等整体错误：逐项调用缺失，补一条总体说明。
    findings.push(nativeFailureFinding(bridgeInventory.reason || 'AD-MCP 桥接失败'))
  }
  if (bridgeDumps && !bridgeDumps.ok && dumpCalls.length > 0) {
    findings.push(nativeFailureFinding(bridgeDumps.reason || 'AD-MCP 库明细桥接失败'))
  }

  finalizeNativeCoverage({ coverage, libraryStates, findings })

  return {
    findings,
    coverage,
    bridge: {
      inventory: bridgeInventory,
      dumps: bridgeDumps,
    },
  }
}

// ---------------------------------------------------------------------------
// ERC / DRC 归一化
// ---------------------------------------------------------------------------

function applyErcResult({ call, coverage, findings }) {
  const erc = coverage.erc
  if (!call?.ok) {
    const reason = call?.error || 'ERC 工具调用失败'
    erc.status = 'failed'
    erc.reasons.push(reason)
    coverage.checks.erc = { status: 'failed', reason }
    findings.push(ercFailureFinding(reason))
    return
  }
  const result = call.result
  if (!isPlainObject(result)) {
    const reason = 'ERC 结果不是 JSON 对象'
    erc.status = 'failed'
    erc.reasons.push(reason)
    coverage.checks.erc = { status: 'failed', reason }
    findings.push(ercFailureFinding(reason))
    return
  }

  const violations = Array.isArray(result.violations)
    ? result.violations.filter(isPlainObject)
    : []
  erc.compiled = result.compiled === true
  erc.total = numberOrZero(result.total, violations.length)
  erc.fatal = numberOrZero(result.fatal)
  erc.errors = numberOrZero(result.errors)
  erc.warnings = numberOrZero(result.warnings)
  erc.listed = violations.length
  erc.unsavedInAltium = Array.isArray(result.unsaved_in_altium)
    ? result.unsaved_in_altium.length
    : numberOrZero(result.unsaved_in_altium)
  erc.missingOnDisk = Array.isArray(result.missing_on_disk)
    ? result.missing_on_disk.length
    : numberOrZero(result.missing_on_disk)
  erc.types = countBy(violations, violation => scalarText(violation.type) || '未命名类型')

  if (erc.total > erc.listed) {
    erc.reasons.push(`Altium 报告 ${erc.total} 条违规，但只返回了 ${erc.listed} 条明细`)
  }
  if (erc.unsavedInAltium > 0) {
    erc.reasons.push(
      `${erc.unsavedInAltium} 份原理图在 Altium 中有未保存修改；本次结果可能不包含磁盘上的最新内容`,
    )
  }
  if (erc.missingOnDisk > 0) {
    erc.reasons.push(`${erc.missingOnDisk} 份工程列出的原理图在磁盘上不存在`)
  }
  if (!erc.compiled) {
    erc.reasons.push('ERC 工具报告未执行编译（compiled=false）')
  }

  for (const violation of violations) {
    findings.push(ercFinding(violation))
  }

  erc.status = erc.reasons.length > 0
    ? 'partial'
    : violations.length > 0
      ? 'found'
      : 'pass'
  coverage.checks.erc = {
    status: erc.status,
    compiled: erc.compiled,
    total: erc.total,
    fatal: erc.fatal,
    errors: erc.errors,
    warnings: erc.warnings,
    listed: erc.listed,
    unsavedInAltium: erc.unsavedInAltium,
    missingOnDisk: erc.missingOnDisk,
    reason: erc.reasons.join('；'),
  }
}

function applyDrcResult({ call, coverage, findings, maxViolations }) {
  const drc = coverage.drc
  if (!call?.ok) {
    const reason = call?.error || 'DRC 工具调用失败'
    drc.status = 'failed'
    drc.ran = false
    drc.reasons.push(reason)
    coverage.checks.drc = { status: 'failed', ran: false, reason }
    findings.push(drcFailureFinding(reason))
    return
  }
  const result = call.result
  if (!isPlainObject(result)) {
    const reason = 'DRC 结果不是 JSON 对象'
    drc.status = 'failed'
    drc.ran = false
    drc.reasons.push(reason)
    coverage.checks.drc = { status: 'failed', ran: false, reason }
    findings.push(drcFailureFinding(reason))
    return
  }
  if (result.ran !== true) {
    const reason = result.error
      || 'DRC 未实际运行（ran=false）；Altium 的 Design Rule Checker 对话框没有完成检查'
    drc.status = 'failed'
    drc.reasons.push(reason)
    coverage.checks.drc = { status: 'failed', ran: false, reason }
    findings.push(drcFailureFinding(reason))
    return
  }

  const violations = Array.isArray(result.violations)
    ? result.violations.filter(isPlainObject)
    : []
  drc.ran = true
  drc.board = scalarText(result.board)
  drc.violationCount = numberOrZero(result.violation_count, violations.length)
  drc.listed = violations.length
  drc.complete = result.complete !== false
  drc.byRule = isPlainObject(result.listed_by_rule) ? result.listed_by_rule : {}
  drc.report = isPlainObject(result.report)
    ? {
      path: scalarText(result.report.path),
      stopped: result.report.stopped === true,
    }
    : null

  if (!drc.complete) {
    drc.reasons.push('Altium 在自身的违规上限处停止了 DRC，结果可能不完整')
  }
  if (drc.violationCount > drc.listed) {
    drc.reasons.push(
      `DRC 共报告 ${drc.violationCount} 条违规，只列出前 ${drc.listed} 条`
        + (maxViolations ? `（max_violations=${maxViolations}）` : ''),
    )
  }
  for (const violation of violations) {
    findings.push(drcFinding(violation))
  }

  drc.status = drc.reasons.length > 0
    ? 'partial'
    : violations.length > 0
      ? 'found'
      : 'pass'
  coverage.checks.drc = {
    status: drc.status,
    ran: drc.ran,
    violationCount: drc.violationCount,
    listed: drc.listed,
    complete: drc.complete,
    board: drc.board,
    reason: drc.reasons.join('；'),
  }
}

// ---------------------------------------------------------------------------
// 库核对
// ---------------------------------------------------------------------------

function readInventoryNames(result, key) {
  if (!isPlainObject(result) || !Array.isArray(result[key])) return null
  const names = []
  for (const entry of result[key]) {
    if (!isPlainObject(entry)) continue
    const name = scalarText(entry.name)
    if (name) names.push(name)
  }
  return names
}

const SYMBOL_IDENTIFIER_PARAMETERS = [
  'LibReference',
  'Library Reference',
  'LibRef',
  'Design Item ID',
  'DesignItemID',
]

function symbolIdentifiers(component) {
  const parameters = isPlainObject(component?.parameters) ? component.parameters : {}
  const values = [
    component?.comment,
    ...SYMBOL_IDENTIFIER_PARAMETERS.map(key => parameters[key]),
  ]
  const seen = new Set()
  const identifiers = []
  for (const value of values) {
    const key = normalizeName(value)
    if (!key || seen.has(key)) continue
    seen.add(key)
    identifiers.push(key)
  }
  return identifiers
}

function matchSymbols(names, components) {
  if (!Array.isArray(components)) return []
  const matches = []
  for (const name of names) {
    const key = normalizeName(name)
    if (!key) continue
    const matched = components.filter(component => symbolIdentifiers(component).includes(key))
    if (matched.length > 0) {
      matches.push({ name, components: matched })
    }
  }
  return matches
}

function matchFootprints(names, components) {
  if (!Array.isArray(components)) return []
  const matches = []
  for (const name of names) {
    const key = normalizeName(name)
    if (!key) continue
    const matched = components
      .map((component, index) => ({ component, index }))
      .filter(entry => normalizeName(entry.component?.footprint) === key)
    if (matched.length > 0) {
      matches.push({
        name,
        components: matched.map(entry => entry.component),
        componentIndexes: matched.map(entry => entry.index),
      })
    }
  }
  return matches
}

function applySymbolCheck({ state, match, result, findings }) {
  if (!isPlainObject(result)) {
    state.incompleteDumps.push({ name: match.name, error: '符号明细不是 JSON 对象' })
    return
  }
  const primitives = Array.isArray(result.primitives) ? result.primitives.filter(isPlainObject) : []
  const pins = primitives
    .filter(primitive => primitive.type === 'pin' && primitive.pin_number !== undefined)
    .map(primitive => String(primitive.pin_number).trim())
    .filter(Boolean)
  if (pins.length === 0) {
    state.incompleteDumps.push({ name: match.name, error: '符号明细中没有引脚' })
    return
  }
  const libraryPins = new Set(pins)
  const missingByComponent = []
  for (const component of match.components) {
    const componentPins = Array.isArray(component.pins) ? component.pins.map(String) : []
    const missing = componentPins.filter(pin => !libraryPins.has(pin))
    if (missing.length > 0) {
      missingByComponent.push({
        reference: component.reference || '（无位号）',
        missing,
      })
    }
  }
  if (missingByComponent.length === 0) return

  state.mismatches.push({
    name: match.name,
    kind: 'symbol',
    components: missingByComponent.map(entry => entry.reference),
    missingPins: missingByComponent.flatMap(entry => entry.missing),
  })
  findings.push(symbolMismatchFinding(match.name, missingByComponent))
}

function applyFootprintCheck({ state, match, result, pcbPads, findings }) {
  if (!isPlainObject(result)) {
    state.incompleteDumps.push({ name: match.name, error: '封装明细不是 JSON 对象' })
    return
  }
  const primitives = Array.isArray(result.primitives) ? result.primitives.filter(isPlainObject) : []
  const pads = primitives
    .filter(primitive => primitive.type === 'pad')
    .map(primitive => scalarText(primitive.name).trim())
    .filter(Boolean)
  if (pads.length === 0) {
    state.incompleteDumps.push({ name: match.name, error: '封装明细中没有具名焊盘' })
    return
  }
  const libraryPads = new Set(pads)
  const missingByComponent = []
  const indexes = Array.isArray(match.componentIndexes)
    ? match.componentIndexes
    : match.components.map((_, index) => index)
  for (let position = 0; position < match.components.length; position += 1) {
    const component = match.components[position]
    const index = Number.isInteger(indexes[position]) ? indexes[position] : position
    const componentPads = pcbPads
      .filter(pad => pad?.componentIndex === index)
      .map(pad => scalarText(pad.name).trim())
      .filter(Boolean)
    if (componentPads.length === 0) continue
    const missing = [...new Set(componentPads)].filter(pad => !libraryPads.has(pad))
    if (missing.length > 0) {
      missingByComponent.push({
        reference: component?.reference || `#${index}`,
        missing,
      })
    }
  }
  if (missingByComponent.length === 0) return

  state.mismatches.push({
    name: match.name,
    kind: 'footprint',
    components: missingByComponent.map(entry => entry.reference),
    missingPads: missingByComponent.flatMap(entry => entry.missing),
  })
  findings.push(footprintMismatchFinding(match.name, missingByComponent))
}

// ---------------------------------------------------------------------------
// Finding 构造（中文）
// ---------------------------------------------------------------------------

const ERC_TYPE_LABELS = {
  'off-grid object': '对象未对齐网格',
  'floating net label': '悬空网络标签',
  'net has only one pin': '网络只有一个引脚',
  'unconnected pin': '引脚未连接',
  'pin not connected': '引脚未连接',
  'duplicate net names': '网络名称重复',
  'net not connected': '网络未连接',
  'no driving source': '网络无驱动源',
  'component has no pins': '元件没有引脚',
  'sheet has no pins': '图页没有引脚',
  'unconnected wire': '导线未连接',
  'bus not connected': '总线未连接',
}

const DRC_RULE_LABELS = {
  clearance: '电气间距',
  'short-circuit': '短路',
  shortcircuit: '短路',
  'un-routed net': '未布线网络',
  unroutednet: '未布线网络',
  width: '走线宽度',
  'hole to hole clearance': '孔到孔间距',
  holetoclearance: '孔到孔间距',
  'silk to solder mask clearance': '丝印到阻焊间距',
  'solder mask sliver': '阻焊桥',
  'paste mask sliver': '钢网桥',
  'component clearance': '元件间距',
  'courtyard clearance': '庭院间距',
}

function ercFinding(violation) {
  const level = scalarText(violation.level).toLowerCase()
  const type = scalarText(violation.type)
  const detail = scalarText(violation.detail)
  const levelInfo = ercLevelInfo(level)
  const typeLabel = ownLookup(ERC_TYPE_LABELS, type.toLowerCase())
  const title = typeLabel
    ? `Altium ERC ${levelInfo.label}：${typeLabel}`
    : `Altium ERC ${levelInfo.label}：${type || '未命名类型'}`
  const locators = extractErcLocators(detail)
  return {
    detector: 'native_erc',
    rule_id: levelInfo.ruleId,
    source_rule_id: type || null,
    category: 'altium_native',
    kind: 'issue',
    severity: levelInfo.severity,
    confidence: 'deterministic',
    evidence_source: 'erc',
    summary: title,
    title,
    description: `Altium Designer 编译工程时报告${levelInfo.label}。原生类型：${type || '未提供'}。`
      + (detail ? `详情：${detail}` : ''),
    evidence: detail || type,
    recommendation: ercRecommendation(type, level),
    components: locators.components,
    nets: locators.nets,
    pins: locators.pins,
    source: 'altium-native',
  }
}

function ercLevelInfo(level) {
  if (level === 'fatal') {
    return { label: '致命错误', severity: 'must_fix', ruleId: 'AD-ERC-001' }
  }
  if (level === 'error') {
    return { label: '错误', severity: 'must_fix', ruleId: 'AD-ERC-001' }
  }
  if (level === 'warning' || level === 'warn') {
    return { label: '警告', severity: 'should_fix', ruleId: 'AD-ERC-002' }
  }
  if (level === 'info' || level === 'note') {
    return { label: '提示', severity: 'nice_to_have', ruleId: 'AD-ERC-003' }
  }
  return { label: '违规', severity: 'should_fix', ruleId: 'AD-ERC-002' }
}

function ercRecommendation(type, level) {
  const key = String(type ?? '').toLowerCase()
  if (key.includes('off-grid') || key.includes('off grid')) {
    return '在 Altium 中把该对象对齐到网格，或调整工程的网格设置；确认不是有意偏移后重新编译。'
  }
  if (key.includes('one pin') || key.includes('unconnected') || key.includes('not connected')) {
    return '确认该引脚或网络是否应连接；若为有意悬空，请在原理图中加 No-ERC 标记，否则补全连接。'
  }
  if (key.includes('driving source')) {
    return '为该网络补充驱动源（电源端口、输出引脚或 PWR_FLAG 等价标记），避免编译告警。'
  }
  return level === 'warning'
    ? '在 Altium 中按 ERC 报告的定位处理；确认不是有意设计后修复并重新编译。'
    : '在 Altium 中按 ERC 报告的定位修复该问题，然后重新编译工程。'
}

function ercFailureFinding(reason) {
  return {
    detector: 'native_erc',
    rule_id: 'AD-ERC-000',
    source_rule_id: null,
    category: 'analysis_error',
    kind: 'issue',
    severity: 'must_fix',
    confidence: 'deterministic',
    evidence_source: 'erc',
    summary: 'Altium ERC 执行失败',
    title: 'Altium ERC 执行失败',
    description: `${reason}。这是分析执行错误，不是 ERC 设计结论。`,
    evidence: reason,
    recommendation: '确认 Altium 已运行、工程可在 AD 中编译，且 AD-MCP 未被其他会话占用；修复后重试 --with-ad。',
    components: [],
    nets: [],
    pins: [],
    source: 'altium-native',
  }
}

function drcFinding(violation) {
  const rule = scalarText(violation.rule)
  const ruleKey = normalizeRuleKey(rule)
  const ruleLabel = ownLookup(DRC_RULE_LABELS, ruleKey)
  const title = ruleLabel
    ? `Altium DRC：${ruleLabel}`
    : `Altium DRC：${rule || '未命名规则'}`
  const primitives = [violation.primitive1, violation.primitive2].filter(isPlainObject)
  const nets = [...new Set(primitives.map(primitive => scalarText(primitive.net)).filter(Boolean))]
  const objects = primitives.map(primitive => scalarText(primitive.object)).filter(Boolean)
  const description = scalarText(violation.description)
  const coords = Number.isFinite(violation.x_mils) && Number.isFinite(violation.y_mils)
    ? `坐标 ${Math.round(violation.x_mils)}, ${Math.round(violation.y_mils)} mil（相对板原点）`
    : ''
  const severity = /short.?circuit|un.?routed|unrouted/iu.test(rule)
    ? 'must_fix'
    : 'should_fix'
  const locators = extractErcLocators([description, ...objects].join('；'))
  return {
    detector: 'native_drc',
    rule_id: 'AD-DRC-001',
    source_rule_id: rule || null,
    category: 'altium_native',
    kind: 'issue',
    severity,
    confidence: 'deterministic',
    evidence_source: 'drc',
    summary: title,
    title,
    description: `Altium 批量 DRC 报告规则“${rule || '未命名'}”违规。`
      + (objects.length > 0 ? `涉及对象：${objects.join('、')}。` : '')
      + (description ? `原生描述：${description}。` : ''),
    evidence: [description, coords, objects.length ? `对象：${objects.join('、')}` : '']
      .filter(Boolean)
      .join('；'),
    recommendation: drcRecommendation(rule),
    components: locators.components,
    nets,
    pins: locators.pins,
    source: 'altium-native',
  }
}

function drcRecommendation(rule) {
  const key = normalizeRuleKey(rule)
  if (key.includes('shortcircuit')) {
    return '定位短路对象并修正铜皮/走线；短路属于必须修复项。'
  }
  if (key.includes('unrouted')) {
    return '完成该网络的布线，或确认它确实不需要连接；未布线网络会导致功能错误。'
  }
  if (key.includes('clearance')) {
    return '调整走线/焊盘间距或局部修改规则与布局，使间距满足设计规则。'
  }
  if (key.includes('width')) {
    return '按载流与工艺要求修改走线宽度，或调整规则的适用范围。'
  }
  return '在 Altium 中打开 PCB，按 DRC 报告的坐标与规则定位并修复；修复后重新运行 DRC。'
}

function drcFailureFinding(reason) {
  return {
    detector: 'native_drc',
    rule_id: 'AD-DRC-000',
    source_rule_id: null,
    category: 'analysis_error',
    kind: 'issue',
    severity: 'must_fix',
    confidence: 'deterministic',
    evidence_source: 'drc',
    summary: 'Altium DRC 未运行或执行失败',
    title: 'Altium DRC 未运行或执行失败',
    description: `${reason}。本结果不代表 PCB 通过 DRC；这是分析执行错误，不是设计结论。`,
    evidence: reason,
    recommendation: '确认 Altium 已打开目标 PCB，Design Rule Checker 对话框可正常操作且未被其他窗口阻塞；修复后重试 --with-ad。',
    components: [],
    nets: [],
    pins: [],
    source: 'altium-native',
  }
}

function libraryFailureFinding(state, phase, error) {
  const kindLabel = state.kind === 'schlib' ? '符号库' : state.kind === 'pcblib' ? '封装库' : '库'
  return {
    detector: 'native_library',
    rule_id: 'AD-LIB-000',
    source_rule_id: null,
    category: 'analysis_error',
    kind: 'issue',
    severity: 'must_fix',
    confidence: 'deterministic',
    evidence_source: 'library',
    summary: `Altium ${kindLabel}读取失败：${state.name}`,
    title: `Altium ${kindLabel}读取失败：${state.name}`,
    description: `读取 ${state.path} 的${phase}失败：${error}。该库的引脚/焊盘核对未完成，不能视为通过。`,
    evidence: error,
    recommendation: '确认库文件可在 Altium 中打开、未被占用且格式受支持；必要时在 Altium 中重新保存该库后重试。',
    components: [],
    nets: [],
    pins: [],
    source: 'altium-native',
  }
}

function symbolMismatchFinding(name, missingByComponent) {
  const components = missingByComponent.map(entry => entry.reference)
  const pins = missingByComponent.flatMap(entry => entry.missing.map(number => ({
    component: entry.reference,
    number,
  })))
  const details = missingByComponent
    .map(entry => `${entry.reference} 缺少引脚 ${entry.missing.join('、')}`)
    .join('；')
  return {
    detector: 'native_library',
    rule_id: 'AD-LIB-001',
    source_rule_id: name,
    category: 'altium_native',
    kind: 'issue',
    severity: 'must_fix',
    confidence: 'deterministic',
    evidence_source: 'library',
    summary: `库符号与原理图引脚不一致：${name}`,
    title: `库符号与原理图引脚不一致：${name}`,
    description: `AD 库符号“${name}”中没有${details}。原理图实例与库符号不一致，可能导致网表、封装映射或后续改版出错。`,
    evidence: details,
    recommendation: '在 Altium 中核对符号引脚编号，更新库或原理图实例，使引脚号完全一致后重新编译。',
    components,
    nets: [],
    pins,
    source: 'altium-native',
  }
}

function footprintMismatchFinding(name, missingByComponent) {
  const components = missingByComponent.map(entry => entry.reference)
  const details = missingByComponent
    .map(entry => `${entry.reference} 缺少焊盘 ${entry.missing.join('、')}`)
    .join('；')
  return {
    detector: 'native_library',
    rule_id: 'AD-LIB-002',
    source_rule_id: name,
    category: 'altium_native',
    kind: 'issue',
    severity: 'must_fix',
    confidence: 'deterministic',
    evidence_source: 'library',
    summary: `库封装与 PCB 焊盘不一致：${name}`,
    title: `库封装与 PCB 焊盘不一致：${name}`,
    description: `AD 封装库“${name}”中没有${details}。PCB 元件使用了该封装的焊盘编号，但库文件中不存在对应焊盘。`,
    evidence: details,
    recommendation: '在 Altium 中核对该封装的焊盘编号并更新库，或重新从库更新 PCB 元件；确认后再出制造文件。',
    components,
    nets: [],
    pins: [],
    source: 'altium-native',
  }
}

export function nativeFailureFinding(reason) {
  return {
    detector: 'native',
    rule_id: 'AD-000',
    source_rule_id: null,
    category: 'analysis_error',
    kind: 'issue',
    severity: 'must_fix',
    confidence: 'deterministic',
    evidence_source: 'native',
    summary: 'Altium 原生检查执行失败',
    title: 'Altium 原生检查执行失败',
    description: `${reason}。没有取得完整的 ERC/DRC/库结果，不能把未返回的检查视为通过。`,
    evidence: reason,
    recommendation: '确认 Altium Designer 正在运行、AD-MCP 安装完整且未被其他会话占用；修复后重试 --with-ad。',
    components: [],
    nets: [],
    pins: [],
    source: 'altium-native',
  }
}

// ---------------------------------------------------------------------------
// 覆盖收尾
// ---------------------------------------------------------------------------

function finalizeNativeCoverage({ coverage, libraryStates, findings }) {
  const schlibs = libraryStates.filter(state => state.kind === 'schlib')
  const pcblibs = libraryStates.filter(state => state.kind === 'pcblib')
  const allLibraries = libraryStates

  coverage.libraries = libraryStates.map(state => ({
    path: state.path,
    name: state.name,
    kind: state.kind,
    exists: state.exists,
    status: state.status,
    inventory: state.inventory,
    symbolCount: state.symbolCount,
    footprintCount: state.footprintCount,
    matched: state.matched,
    dumped: state.dumped,
    mismatches: state.mismatches,
    failedDumps: state.failedDumps,
    incompleteDumps: state.incompleteDumps,
    reasons: uniqueText(state.reasons),
  }))

  coverage.checks.symbol_libraries = summarizeLibraryCheck(schlibs, 'symbols')
  coverage.checks.footprint_libraries = summarizeLibraryCheck(pcblibs, 'footprints')
  coverage.checks.library_crosscheck = summarizeCrossCheck(allLibraries)

  const libraryStatus = aggregateLibraryStatus(allLibraries)
  coverage.counts.libraries = {
    total: allLibraries.length,
    symbolLibraries: schlibs.length,
    footprintLibraries: pcblibs.length,
    matchedSymbols: schlibs.reduce((sum, state) => sum + state.matched.length, 0),
    matchedFootprints: pcblibs.reduce((sum, state) => sum + state.matched.length, 0),
    mismatches: allLibraries.reduce((sum, state) => sum + state.mismatches.length, 0),
    failed: allLibraries.filter(state => state.status === 'failed').length,
  }
  coverage.counts.erc = {
    total: coverage.erc.total,
    fatal: coverage.erc.fatal,
    errors: coverage.erc.errors,
    warnings: coverage.erc.warnings,
    listed: coverage.erc.listed,
  }
  coverage.counts.drc = {
    violationCount: coverage.drc.violationCount,
    listed: coverage.drc.listed,
  }
  coverage.counts.issues = findings.filter(finding => finding.kind !== 'fact').length
  coverage.counts.facts = findings.length - coverage.counts.issues
  coverage.findings = findings.length
  coverage.checks.library = {
    status: libraryStatus,
    reason: aggregateLibraryReason(libraryStatus, allLibraries),
  }

  coverage.reasons = uniqueText([
    ...coverage.erc.reasons,
    ...coverage.drc.reasons,
    ...allLibraries.flatMap(state => state.reasons),
    ...(coverage.checks.erc.reason ? [coverage.checks.erc.reason] : []),
    ...(coverage.checks.drc.reason ? [coverage.checks.drc.reason] : []),
  ]).slice(0, 60)

  coverage.status = aggregateNativeStatus([
    coverage.checks.erc.status,
    coverage.checks.drc.status,
    libraryStatus,
  ])

  coverage.artifacts = {
    index: 'ad.json',
    inventoryRequest: 'ad/inventory-request.json',
    inventoryResult: 'ad/inventory-result.json',
    dumpsRequest: 'ad/dumps-request.json',
    dumpsResult: 'ad/dumps-result.json',
    altiumHome: 'ad/mcp-home',
  }
}

function summarizeLibraryCheck(states, key) {
  const relevant = states.filter(state => state.kind !== 'intlib')
  if (states.length === 0) {
    return {
      status: 'not_evaluated',
      reason: `没有 .SchLib/.PcbLib 路径，库${key === 'symbols' ? '符号' : '封装'}清单未评估`,
      libraries: 0,
      inventoryOk: 0,
      matched: 0,
      dumped: 0,
      failures: 0,
      reasons: [],
    }
  }
  if (relevant.length === 0) {
    return {
      status: 'not_evaluated',
      reason: '只有 .IntLib 集成库，AD-MCP 原语工具无法直接读取',
      libraries: states.length,
      inventoryOk: 0,
      matched: 0,
      dumped: 0,
      failures: 0,
      reasons: ['集成库需要先在 Altium 中拆分为 .SchLib/.PcbLib 或重新导出'],
    }
  }
  const inventoryFailed = relevant.some(state => state.inventory === 'failed')
  const dumpFailed = relevant.some(state => state.failedDumps.length > 0)
  const required = relevant.some(state => state.status === 'partial')
  const reasons = uniqueText(relevant.flatMap(state => state.reasons)).slice(0, 20)
  return {
    status: inventoryFailed
      ? 'failed'
      : dumpFailed || required ? 'partial' : 'pass',
    libraries: states.length,
    inventoryOk: relevant.filter(state => state.inventory === 'ok').length,
    matched: relevant.reduce((sum, state) => sum + state.matched.length, 0),
    dumped: relevant.reduce((sum, state) => sum + state.dumped, 0),
    failures: relevant.filter(state => state.status === 'failed').length,
    reasons,
  }
}

function summarizeCrossCheck(states) {
  const relevant = states.filter(state => state.kind !== 'intlib')
  if (relevant.length === 0) {
    return {
      status: 'not_evaluated',
      reason: '没有可用于引脚/焊盘核对的 .SchLib/.PcbLib',
      checkedSymbols: 0,
      checkedFootprints: 0,
      mismatches: 0,
      reasons: [],
    }
  }
  const mismatches = relevant.reduce((sum, state) => sum + state.mismatches.length, 0)
  const notEvaluated = relevant.filter(state => state.matched.length === 0 || state.status === 'partial')
  const reasons = uniqueText([
    ...relevant.flatMap(state => state.reasons),
    ...(notEvaluated.length > 0
      ? [`${notEvaluated.length} 个库存在未执行或未完成的核对项`]
      : []),
  ]).slice(0, 20)
  return {
    status: mismatches > 0
      ? 'found'
      : notEvaluated.length > 0
        ? 'partial'
        : 'pass',
    checkedSymbols: relevant
      .filter(state => state.kind === 'schlib')
      .reduce((sum, state) => sum + state.dumped, 0),
    checkedFootprints: relevant
      .filter(state => state.kind === 'pcblib')
      .reduce((sum, state) => sum + state.dumped, 0),
    mismatches,
    reasons,
  }
}

function aggregateLibraryStatus(states) {
  // .IntLib 只记录为未评估，不参与聚合：它常与 .SchLib/.PcbLib 同时存在，
  // 不应因为一个无法直接读取的集成库把已经完成的核对降级。
  const checkable = states.filter(state => state.kind !== 'intlib')
  if (checkable.length === 0) return 'not_evaluated'
  if (checkable.some(state => state.status === 'failed')) return 'failed'
  if (checkable.some(state => state.mismatches.length > 0)) return 'found'
  if (checkable.some(state => state.status === 'partial')) return 'partial'
  // 混有未评估的库（如未匹配项）时，整体不能算完整通过。
  if (checkable.some(state => state.status === 'not_evaluated')) return 'partial'
  return 'pass'
}

function aggregateLibraryReason(status, states) {
  if (status === 'not_evaluated') {
    return states.length === 0
      ? '没有 .SchLib/.PcbLib 路径'
      : '只有 .IntLib 集成库或没有可核对的库'
  }
  const checkable = states.filter(state => state.kind !== 'intlib')
  const reasons = uniqueText(checkable.flatMap(state => state.reasons))
  return reasons.slice(0, 6).join('；')
}

function aggregateNativeStatus(statuses) {
  if (statuses.includes('failed')) return 'failed'
  if (statuses.includes('partial')) return 'partial'
  const evaluated = statuses.filter(status => status === 'pass' || status === 'found')
  const notEvaluated = statuses.filter(status => status === 'not_evaluated')
  if (notEvaluated.length > 0 && evaluated.length > 0) return 'partial'
  if (statuses.includes('found')) return 'found'
  if (evaluated.length > 0) return 'pass'
  return 'not_evaluated'
}

// ---------------------------------------------------------------------------
// 桥接调用
// ---------------------------------------------------------------------------

function writeAdMcpConfig(altiumHome, altiumExePath) {
  if (!altiumExePath) return
  try {
    writeFileSync(
      join(altiumHome, 'config.json'),
      `${JSON.stringify({ altium_exe_path: altiumExePath }, null, 2)}\n`,
      'utf8',
    )
  } catch {
    // 配置写入失败时 AD-MCP 仍会从运行进程/注册表自动发现；不阻断分析。
  }
}

function invokeBridge({
  availability,
  calls,
  outDir,
  requestName,
  resultName,
  startupTimeoutMs,
  env,
}) {
  const adDir = join(outDir, 'ad')
  mkdirSync(adDir, { recursive: true })
  const requestPath = join(adDir, requestName)
  const resultPath = join(adDir, resultName)
  const request = {
    server: {
      python: availability.python,
      main: availability.mainPath || join(availability.serverPath, 'server', 'main.py'),
      cwd: availability.serverPath,
      altiumHome: join(adDir, 'mcp-home'),
    },
    startupTimeoutMs,
    calls,
  }
  writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, 'utf8')

  const callBudget = calls.reduce((sum, call) => sum + positiveNumber(call.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS), 0)
  const timeout = Math.min(startupTimeoutMs + callBudget + 30_000, MAX_BRIDGE_TIMEOUT_MS)
  const started = Date.now()
  const run = spawnSync(
    availability.python,
    ['-B', '-X', 'utf8', CLIENT_PY, '--request', requestPath],
    {
      cwd: outDir,
      env: { ...process.env, ...env, PYTHONIOENCODING: 'utf-8' },
      encoding: 'utf8',
      windowsHide: true,
      timeout,
      maxBuffer: MAX_BRIDGE_STDOUT,
    },
  )
  const durationMs = Date.now() - started

  if (run.error) {
    const reason = run.error.code === 'ETIMEDOUT'
      ? `AD-MCP 桥接超时（${timeout} ms），已终止等待`
      : `无法启动 AD-MCP 桥接：${run.error.message}`
    return {
      ok: false,
      phase: 'spawn',
      reason,
      calls: {},
      errors: [reason],
      requestPath,
      durationMs,
      stderr: truncate(scalarText(run.stderr), 4000),
    }
  }

  const stdout = scalarText(run.stdout).trim()
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    const reason = stdout
      ? 'AD-MCP 桥接输出不是 JSON'
      : `AD-MCP 桥接没有输出（退出码 ${run.status}）`
    return {
      ok: false,
      phase: 'protocol',
      reason,
      calls: {},
      errors: [reason],
      requestPath,
      durationMs,
      stdout: truncate(stdout, 2000),
      stderr: truncate(scalarText(run.stderr), 4000),
    }
  }
  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      phase: 'protocol',
      reason: 'AD-MCP 桥接输出不是 JSON 对象',
      calls: {},
      errors: ['AD-MCP 桥接输出不是 JSON 对象'],
      requestPath,
      durationMs,
      stderr: truncate(scalarText(run.stderr), 4000),
    }
  }
  const result = {
    ...parsed,
    ok: parsed.ok === true,
    calls: isPlainObject(parsed.calls) ? parsed.calls : {},
    errors: Array.isArray(parsed.errors) ? parsed.errors.map(scalarText) : [],
    requestPath,
    durationMs,
    stderr: truncate(scalarText(run.stderr), 4000),
  }
  try {
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  } catch {
    // 结果文件只是调试辅助；写失败不影响本次桥接结果。
  }
  return result
}

// ---------------------------------------------------------------------------
// 文本与工具
// ---------------------------------------------------------------------------

function extractErcLocators(detail) {
  const text = scalarText(detail)
  const components = new Set()
  const nets = new Set()
  const pins = []
  const NET_NAME_STOPWORDS = new Set([
    'has', 'have', 'is', 'are', 'not', 'only', 'one', 'pin', 'pins', 'net', 'nets',
  ])
  const pinPattern = /\bPin\s+([A-Za-z]{1,4}\d{1,5})-(\d+)\b/giu
  let match
  while ((match = pinPattern.exec(text)) !== null) {
    components.add(match[1])
    pins.push({ component: match[1], number: match[2] })
  }
  // DRC 的 primitive.object 常写成 "Pad R1-1" / "Via V2" 等。
  const objectPattern = /\b(?:Pad|Track|Via|Component|Footprint)\s+([A-Za-z]{1,4}\d{1,5})(?:-(\d+))?\b/giu
  while ((match = objectPattern.exec(text)) !== null) {
    components.add(match[1])
    if (match[2]) pins.push({ component: match[1], number: match[2] })
  }
  const componentPattern = /\b([A-Za-z]{1,4}\d{1,5})\s+at\b/gu
  while ((match = componentPattern.exec(text)) !== null) {
    components.add(match[1])
  }
  const netPattern = /\bNet\s+['"]?([A-Za-z0-9_+\-/]+)['"]?/giu
  while ((match = netPattern.exec(text)) !== null) {
    // "Net has only one pin" 里的 has 不是网络名。
    if (NET_NAME_STOPWORDS.has(match[1].toLowerCase())) continue
    nets.add(match[1])
  }
  return {
    components: [...components],
    nets: [...nets],
    pins,
  }
}

function normalizeName(value) {
  return scalarText(value).trim().toLowerCase()
}

function normalizeRuleKey(value) {
  return scalarText(value).trim().toLowerCase().replace(/[\s_-]+/gu, '')
}

function countBy(items, keyFor) {
  const counts = {}
  for (const item of items) {
    const key = keyFor(item)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

function envInt(env, name, fallback) {
  const raw = env?.[name]
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}

function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback
}

function numberOrZero(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return fallback
}

function uniqueText(values) {
  const seen = new Set()
  const result = []
  for (const value of values ?? []) {
    const text = scalarText(value)
    if (!text || seen.has(text)) continue
    seen.add(text)
    result.push(text)
  }
  return result
}

function truncate(value, limit) {
  const text = scalarText(value)
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(limit - 1, 0))}…`
}

function scalarText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function ownLookup(map, key) {
  return Object.hasOwn(map, key) ? map[key] : ''
}

// 保留导出，供测试与报告诊断使用。
export const __internal = {
  emptyNativeCoverage,
  normalizeLibraries,
  matchSymbols,
  matchFootprints,
  aggregateNativeStatus,
  ercFinding,
  drcFinding,
  extractErcLocators,
}
