// EMC 预合规分析：把 AD-Happy 的 snapshot/PCB 数据适配成 kicad-happy
// EMC 分析器读取的 schematic/pcb JSON，调用上游 `analyze_emc.py`，并把
// 上游结果归一化成 AD-Happy 的 finding/coverage 结构。
//
// 上游接口（只读，以实际代码为准）：
//   python analyze_emc.py --schematic <schematic.json> --pcb <pcb.json>
//                         --output <emc-raw.json> [--standard fcc-class-b]
//
// 关键取舍：
// - AD-Happy 的离线解析不捕获铺铜/区域填充（zones）、板框线段、层切换、
//   走线邻近度与叠层介质参数。依赖这些数据的规则一律标记 not_evaluated，
//   并把上游因此产生的占位/兜底 finding 过滤掉，绝不静默当作通过。
// - 原理图侧的稳压器、晶振、保护器件、LC/RC 滤波与差分对由
//   `emc_prepare.py` 复用 kicad-happy 的检测器生成；缺上游脚本时降级为
//   pipeline 已有的稳压器识别结果，依赖缺失检测器的类别标记 not_evaluated。
// - PCB 侧的元件、焊盘、网络、走线、过孔、层序与板框尺寸直接来自快照，
//   因此连接器滤波、去耦距离、过孔缝合、时钟/差分对走线等规则可以评估。
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PREPARE_PY = join(SCRIPT_DIR, 'emc_prepare.py')
// 优先使用随包分发的 kicad-happy 脚本（下载即用）。
const VENDORED_ROOT = join(SCRIPT_DIR, '..', '..', 'vendor', 'kicad-happy', 'skills')
const VENDORED_KICAD_SCRIPTS = join(VENDORED_ROOT, 'kicad', 'scripts')
const DEFAULT_KICAD_HAPPY_SCRIPTS = existsSync(VENDORED_KICAD_SCRIPTS)
  ? VENDORED_KICAD_SCRIPTS
  : 'D:/Tools/kicad-happy/skills/kicad/scripts'
const DEFAULT_STANDARD = 'fcc-class-b'
const PYTHON_TIMEOUT_MS = 120 * 1000
const MAX_BUFFER = 16 * 1024 * 1024
const MIL_TO_MM = 0.0254

// EMC 类别与上游规则 ID 的对应关系。报告按类别展示「已评估 / 未评估」，
// 未评估类别必须在 coverage 中给出原因。
export const EMC_RULE_CATEGORIES = [
  { key: 'ground_plane', label: '地平面完整性', rules: ['GP-001', 'GP-002', 'GP-003', 'GP-004', 'GP-005'] },
  { key: 'decoupling', label: '去耦有效性', rules: ['DC-001', 'DC-002', 'DC-003'] },
  { key: 'io_filtering', label: 'I/O 接口滤波', rules: ['IO-001', 'IO-002'] },
  { key: 'switching_emc', label: '开关稳压器 EMC', rules: ['SW-001', 'SW-002', 'SW-003'] },
  { key: 'clock_routing', label: '时钟走线质量', rules: ['CK-001', 'CK-002', 'CK-003', 'CK-004'] },
  { key: 'via_stitching', label: '接地过孔缝合', rules: ['VS-001'] },
  { key: 'stackup', label: '叠层质量', rules: ['SU-001', 'SU-002', 'SU-003'] },
  { key: 'emission_estimate', label: '发射估算', rules: ['EE-001', 'EE-002'] },
  { key: 'diff_pair', label: '差分对 EMC', rules: ['DP-001', 'DP-002', 'DP-003', 'DP-004'] },
  { key: 'board_edge', label: '板边与连接器区域', rules: ['BE-001', 'BE-002', 'BE-003'] },
  { key: 'crosstalk', label: '串扰与信号完整性', rules: ['XT-001'] },
  { key: 'emi_filter', label: 'EMI 滤波器验证', rules: ['EF-001', 'EF-002'] },
  { key: 'esd_path', label: 'ESD 保护路径', rules: ['ES-001', 'ES-002'] },
  { key: 'thermal_emc', label: '热-EMC 相互作用', rules: ['TH-001', 'TH-002'] },
  { key: 'shielding', label: '屏蔽与开口', rules: ['SH-001'] },
  { key: 'pdn', label: 'PDN 阻抗', rules: ['PD-001', 'PD-002', 'PD-003', 'PD-004'] },
  { key: 'return_path', label: '回流路径', rules: ['RP-001'] },
  { key: 'inductor_leakage', label: '电感漏磁', rules: ['ML-001'] },
]

// 这些规则输出的只是估算值/实测事实，不计入问题数量。
const FACT_RULES = new Set(['EE-001', 'EE-002', 'EF-002', 'PD-002'])

const STATUS_EVALUATED = 'evaluated'
const STATUS_PARTIAL = 'partial'
const STATUS_NOT_EVALUATED = 'not_evaluated'

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/**
 * 把 AD-Happy 的快照转换为 EMC 分析器输入。
 *
 * @param {object} snapshot snapshot.json 内容
 * @param {object} pcb pcb.json 内容（可与 snapshot.pcb 相同）
 * @param {object} pipeline pipeline-summary.json 内容
 * @param {{nets?: object, netlistComplete?: boolean}} [extras]
 *   raw.nets（可选）用于生成原理图网表；netlistComplete 表示引脚是否全部入网。
 * @returns {{schematicJson: object, pcbJson: object, coverage: object}}
 */
export function buildEmcInputs(snapshot, pcb, pipeline, extras = {}) {
  const schematicSource = isPlainObject(snapshot) && isPlainObject(snapshot.schematic)
    ? snapshot.schematic
    : null
  const pcbSource = isPlainObject(pcb) ? pcb : (isPlainObject(snapshot) ? snapshot.pcb : null)
  const findings = Array.isArray(pipeline?.findings) ? pipeline.findings : []
  const statuses = isPlainObject(pipeline?.status) ? pipeline.status : {}
  const nets = extras.nets?.nets ?? extras.nets ?? null

  const schematicJson = buildSchematicJson(schematicSource, findings, statuses, nets, extras)
  const pcbJson = buildPcbJson(isPlainObject(pcbSource) ? pcbSource : {}, schematicJson)
  const coverage = assessCoverage({
    schematicJson,
    pcbJson,
    netlistComplete: extras.netlistComplete !== false,
    upstream: null,
    requested: true,
  })
  return { schematicJson, pcbJson, coverage }
}

/**
 * 调用上游 EMC 分析器。
 *
 * @param {string} emcDir 存放 schematic.json / pcb.json / raw.json 的目录
 * @param {string} outDir 运行输出目录（用于记录产物相对路径）
 * @param {{standard?: string}} [options]
 * @returns {{findings: object[], coverage: object, rawPath: string|null}}
 */
export function runEmc(emcDir, outDir, options = {}) {
  const directory = String(emcDir ?? '')
  const standard = options.standard || DEFAULT_STANDARD
  if (!directory || !existsSync(directory)) {
    return {
      findings: [],
      coverage: unavailableEmcCoverage(
        [`EMC 输入目录不存在：${directory || '（空）'}`],
        { standard },
      ),
      rawPath: null,
    }
  }

  const schematicPath = join(directory, 'schematic.json')
  const pcbPath = join(directory, 'pcb.json')
  const rawJsonPath = join(directory, 'raw.json')
  const upstreamOut = join(directory, 'emc-raw.json')

  if (!existsSync(schematicPath) || !existsSync(pcbPath)) {
    return {
      findings: [],
      coverage: unavailableEmcCoverage(
        ['EMC 输入缺少 schematic.json 或 pcb.json'],
        { standard },
      ),
      rawPath: null,
    }
  }

  const scriptsDir = resolveEmcScriptsDir()
  if (!scriptsDir) {
    const coverage = unavailableEmcCoverage(
      [
        '未找到上游 EMC 分析脚本 analyze_emc.py；'
        + '请设置 KICAD_HAPPY_EMC_SCRIPTS，或让 KICAD_HAPPY_SCRIPTS 的同级目录包含 emc/scripts。',
      ],
      { standard },
    )
    coverage.upstream = { available: false, script: null }
    return { findings: [], coverage, rawPath: null }
  }

  // 原理图侧增强：复用 kicad-happy 检测器补齐晶振、保护器件、LC 滤波与差分对。
  // 失败不中止 EMC：基础 schematic.json 仍可运行，依赖缺失检测器的类别会在
  // coverage 中标记 not_evaluated。
  let prepareError = null
  if (existsSync(rawJsonPath) && existsSync(PREPARE_PY)) {
    const prepare = spawnSync(
      'python',
      ['-B', '-X', 'utf8', PREPARE_PY, '--raw', rawJsonPath, '--schematic', schematicPath],
      pythonOptions(directory),
    )
    if (prepare.error || prepare.status !== 0) {
      prepareError = prepare.error
        ? `无法启动原理图增强脚本：${prepare.error.message}`
        : `原理图增强脚本退出码 ${prepare.status}：${firstText(prepare.stderr, prepare.stdout)}`
    }
  }

  const run = spawnSync(
    'python',
    [
      '-B', '-X', 'utf8',
      join(scriptsDir, 'analyze_emc.py'),
      '--schematic', schematicPath,
      '--pcb', pcbPath,
      '--output', upstreamOut,
      '--severity', 'all',
      '--standard', standard,
    ],
    pythonOptions(directory),
  )

  if (run.error || run.status !== 0) {
    const reason = run.error
      ? (run.error.code === 'ETIMEDOUT'
        ? `上游 EMC 分析超时（${PYTHON_TIMEOUT_MS / 1000} 秒）`
        : `无法启动上游 EMC 分析：${run.error.message}`)
      : `上游 EMC 分析退出码 ${run.status}：${firstText(run.stderr, run.stdout)}`
    const coverage = unavailableEmcCoverage(
      [reason, ...(prepareError ? [prepareError] : [])],
      { standard, status: 'failed' },
    )
    coverage.available = true
    coverage.upstream = {
      available: true,
      script: join(scriptsDir, 'analyze_emc.py'),
      error: reason,
    }
    coverage.findings = 1
    return {
      findings: [emcExecutionErrorFinding(reason)],
      coverage,
      rawPath: existsSync(upstreamOut) ? upstreamOut : null,
    }
  }

  let upstream
  try {
    upstream = JSON.parse(readFileSync(upstreamOut, 'utf8'))
    validateUpstream(upstream)
  } catch (error) {
    const reason = `上游 EMC 输出不合法：${error?.message ?? error}`
    const coverage = unavailableEmcCoverage(
      [reason, ...(prepareError ? [prepareError] : [])],
      { standard, status: 'failed' },
    )
    coverage.available = true
    coverage.upstream = {
      available: true,
      script: join(scriptsDir, 'analyze_emc.py'),
      error: reason,
    }
    coverage.findings = 1
    return {
      findings: [emcExecutionErrorFinding(reason)],
      coverage,
      rawPath: existsSync(upstreamOut) ? upstreamOut : null,
    }
  }

  // 重新读取增强后的 schematic，获取检测器状态；增强失败时保留 buildEmcInputs
  // 写入的基础版本。
  let schematicJson = {}
  let pcbJson = {}
  try {
    schematicJson = JSON.parse(readFileSync(schematicPath, 'utf8'))
  } catch {
    schematicJson = {}
  }
  try {
    pcbJson = JSON.parse(readFileSync(pcbPath, 'utf8'))
  } catch {
    pcbJson = {}
  }

  const metadata = isPlainObject(schematicJson._ad_happy) ? schematicJson._ad_happy : {}
  const coverage = assessCoverage({
    schematicJson,
    pcbJson,
    netlistComplete: metadata.netlistComplete !== false,
    upstream,
    requested: true,
    standard,
    prepareError,
    scriptsDir,
    outDir,
  })

  const findings = normalizeUpstreamFindings(upstream.findings, coverage, standard)
  coverage.findings = findings.filter(finding => finding.kind === 'issue').length
  coverage.facts = findings.filter(finding => finding.kind === 'fact').length
  coverage.counts.issues = coverage.findings
  coverage.counts.facts = coverage.facts
  coverage.standard = standard
  coverage.artifacts = artifactPaths(directory, outDir)
  coverage.upstream = {
    available: true,
    script: join(scriptsDir, 'analyze_emc.py'),
    summary: isPlainObject(upstream.summary) ? upstream.summary : null,
    categorySummary: isPlainObject(upstream.category_summary) ? upstream.category_summary : null,
    boardInfo: isPlainObject(upstream.board_info) ? upstream.board_info : null,
    categoryChecked: numberOrNull(upstream.summary?.categories_checked),
  }
  if (metadata.detectors) coverage.detectors = metadata.detectors
  return { findings, coverage, rawPath: upstreamOut }
}

/**
 * 请求了 --emc 但无法运行（脚本缺失、输入缺失）时的覆盖：所有类别
 * 明确列为 not_evaluated，报告不能只写一句「没有类别信息」。
 */
export function unavailableEmcCoverage(reasons, {
  standard = DEFAULT_STANDARD,
  status = 'not_evaluated',
} = {}) {
  const coverage = emptyEmcCoverage({ requested: true, standard, status, reasons })
  const reason = dedupe(reasons)[0] || '输入不足或上游不可用'
  coverage.categories = EMC_RULE_CATEGORIES.map(definition => {
    const entries = definition.rules.map(rule => ({
      rule,
      status: STATUS_NOT_EVALUATED,
      reason,
    }))
    return {
      key: definition.key,
      label: definition.label,
      status: STATUS_NOT_EVALUATED,
      rules: entries,
      evaluatedRules: [],
      partiallyEvaluatedRules: [],
      notEvaluatedRules: entries.map(entry => ({ rule: entry.rule, reason: entry.reason })),
      reasons: [reason],
    }
  })
  coverage.notEvaluatedRules = coverage.categories
    .flatMap(category => category.notEvaluatedRules)
    .sort((a, b) => a.rule.localeCompare(b.rule))
  coverage.counts.notEvaluated = coverage.notEvaluatedRules.length
  return coverage
}

export function emptyEmcCoverage({
  requested = false,
  standard = DEFAULT_STANDARD,
  status = 'not_evaluated',
  reasons = [],
} = {}) {
  return {
    requested,
    status,
    standard,
    available: false,
    netlist: null,
    categories: [],
    evaluatedRules: [],
    partiallyEvaluatedRules: [],
    notEvaluatedRules: [],
    suppressedFindings: [],
    unsupportedRules: [],
    reasons: dedupe(reasons),
    counts: { evaluated: 0, partial: 0, notEvaluated: 0, issues: 0, facts: 0 },
    findings: 0,
    facts: 0,
    detectors: null,
    upstream: null,
    artifacts: null,
  }
}

// ---------------------------------------------------------------------------
// 原理图侧
// ---------------------------------------------------------------------------

const PIPELINE_DETECTORS = {
  power_regulator: 'detect_power_regulators',
  voltage_divider: 'detect_voltage_dividers',
  rc_filter: 'detect_rc_filters',
  decoupling: 'detect_decoupling',
  protection_device: 'detect_protection_devices',
  lc_filter: 'detect_lc_filters',
  crystal_circuit: 'detect_crystal_circuits',
}

function buildSchematicJson(schematic, pipelineFindings, pipelineStatus, rawNets, extras) {
  const components = Array.isArray(schematic?.components) ? schematic.components : []
  const netMap = normalizeRawNets(rawNets)
  const derivedNets = netMap ?? netsFromComponents(components)
  const statistics = {
    total_components: components.length,
    total_nets: Object.keys(derivedNets).length,
  }
  const findings = []
  const detectorStatus = {}
  for (const finding of pipelineFindings) {
    if (!isPlainObject(finding)) continue
    const upstreamDetector = PIPELINE_DETECTORS[String(finding.detector ?? '')]
    if (!upstreamDetector) continue
    findings.push({ ...finding, detector: upstreamDetector, source: 'schematic' })
  }
  for (const [pipelineKey, upstreamDetector] of Object.entries(PIPELINE_DETECTORS)) {
    detectorStatus[upstreamDetector] = pipelineDetectorStatus(pipelineStatus, pipelineKey)
  }

  return {
    analyzer_type: 'schematic',
    schema_version: '1.4.0',
    statistics,
    findings,
    design_analysis: { differential_pairs: [], buses: {} },
    components: components.map(component => ({
      reference: scalarText(component.reference),
      value: scalarText(component.comment),
      mpn: scalarText(component.mpn),
      footprint: scalarText(component.footprint),
      type: '',
    })),
    // buildEmcInputs 返回的网表只用于测试/排查；写盘时由 CLI 决定是否保留。
    nets: derivedNets,
    _ad_happy: {
      source: 'ad-happy-base',
      netlistComplete: extras.netlistComplete !== false,
      detectors: detectorStatus,
    },
  }
}

function normalizeRawNets(value) {
  if (!isPlainObject(value)) return null
  const source = isPlainObject(value.nets) ? value.nets : value
  const result = {}
  for (const [name, entries] of Object.entries(source)) {
    if (!Array.isArray(entries)) continue
    result[name] = {
      pins: entries.filter(isPlainObject).map(entry => ({
        component: scalarText(entry.reference ?? entry.component),
        pin_number: scalarText(entry.pin ?? entry.pin_number),
        pin_name: scalarText(entry.pin_name),
        pin_type: scalarText(entry.pin_type) || 'passive',
      })),
    }
  }
  return result
}

function netsFromComponents(components) {
  // 没有 raw 网表时，用 PCB 焊盘补齐（componentIndex/名称与原理图位号一致）；
  // 这只是尽力而为，缺网表时依赖网表的类别会被标记 not_evaluated。
  const result = {}
  for (const component of components) {
    const reference = scalarText(component.reference)
    if (!reference) continue
    for (const pin of Array.isArray(component.pins) ? component.pins : []) {
      const number = scalarText(pin)
      if (!number) continue
      result[`__pin_${reference}_${number}`] = {
        pins: [{ component: reference, pin_number: number, pin_name: '', pin_type: 'passive' }],
      }
    }
  }
  return result
}

function pipelineDetectorStatus(statuses, pipelineKey) {
  const status = scalarText(statuses?.[pipelineKey])
  if (status === 'found' || status === 'pass') return 'ok'
  if (status === 'failed') return 'failed'
  // pipeline 不提供逐规则状态时，无法区分「运行后为空」与「未运行」；
  // 基础版本按 not_evaluated 处理，`emc_prepare.py` 会补上真实状态。
  return 'not_evaluated'
}

// ---------------------------------------------------------------------------
// PCB 侧
// ---------------------------------------------------------------------------

function buildPcbJson(pcb, schematicJson) {
  const components = Array.isArray(pcb.components) ? pcb.components : []
  const pads = Array.isArray(pcb.pads) ? pcb.pads : []
  const netNames = Array.isArray(pcb.nets) ? pcb.nets.map(name => scalarText(name)) : []
  const netById = buildNetIdMap(netNames)
  const nameById = Object.fromEntries(Object.entries(netById).map(([id, name]) => [id, name]))
  const idByName = Object.fromEntries(Object.entries(nameById).filter(([, name]) => name).map(([id, name]) => [name, Number(id)]))

  const stack = buildLayerStack(pcb.layerStack, pcb.tracks, pcb.arcs)
  const footprints = buildFootprints(components, pads, nameById, stack)
  const tracks = buildTracks(pcb.tracks, pcb.arcs, stack)
  const vias = buildVias(pcb.vias, stack, idByName)
  const outline = buildOutline(pcb.outline)
  const statistics = buildStatistics(pcb, footprints, tracks, vias, stack)
  const controllers = Array.isArray(schematicJson?.findings) ? schematicJson.findings : []
  const switchingLoopAreas = buildSwitchingLoopAreas(controllers, footprints)
  const decouplingPlacement = analyzeDecouplingPlacement(footprints)
  const groundDomains = analyzeGroundDomains(footprints)
  const netLengths = analyzeNetLengths(tracks, vias, nameById)

  return {
    analyzer_type: 'pcb',
    schema_version: '1.4.0',
    statistics,
    layers: stack.layers,
    setup: { stackup: stack.stackup },
    board_outline: outline,
    footprints,
    tracks,
    vias,
    zones: [],
    nets: Object.fromEntries(Object.entries(nameById).filter(([, name]) => name)),
    net_name_to_id: idByName,
    net_lengths: netLengths,
    decoupling_placement: decouplingPlacement,
    ground_domains: groundDomains,
    ...(switchingLoopAreas.length > 0 ? { switching_loop_areas: switchingLoopAreas } : {}),
    _ad_happy: {
      source: 'altium-snapshot',
      zonesAvailable: false,
      boardEdgesAvailable: false,
      layerTransitionsAvailable: false,
      traceProximityAvailable: false,
      returnPathAvailable: false,
      stackupDielectricsAvailable: false,
    },
  }
}

function buildNetIdMap(netNames) {
  // 0 是「无网络」；AD-Happy 的 netIndex=-1 映射为 0。
  return Object.fromEntries(netNames.map((name, index) => [String(index + 1), name]))
}

function buildLayerStack(layerStack, tracks, arcs) {
  const entries = Array.isArray(layerStack) ? layerStack : []
  const physical = []
  const seen = new Set()
  for (const entry of entries) {
    if (!isPlainObject(entry) || entry.copper !== true) continue
    const name = scalarText(entry.name)
    const key = normalizeLayerToken(name)
    if (!name || key === 'MULTILAYER' || key === 'MULTI') continue
    if (seen.has(key)) continue
    seen.add(key)
    physical.push({ name, key })
  }
  if (physical.length === 0) {
    // 层叠缺失时按 KiCad 常见两层板兜底；这只影响层名归类，不影响几何。
    physical.push({ name: 'TOP', key: 'TOP' }, { name: 'BOTTOM', key: 'BOTTOM' })
  }
  const layerMap = new Map()
  const layers = []
  const stackup = []
  physical.forEach((entry, index) => {
    const kicadName = index === 0
      ? 'F.Cu'
      : index === physical.length - 1
        ? 'B.Cu'
        : `In${index}.Cu`
    const type = entry.key.includes('PLANE') ? 'power' : 'signal'
    layers.push({ name: kicadName, type })
    stackup.push({ name: kicadName, type: 'copper' })
    layerMap.set(entry.key, kicadName)
  })
  // 走线/圆弧使用 Altium 标准层名（TOP、BOTTOM、MID1、INTERNALPLANE1）。
  layerMap.set('TOP', 'F.Cu')
  layerMap.set('TOPLAYER', 'F.Cu')
  layerMap.set('BOTTOM', 'B.Cu')
  layerMap.set('BOTTOMLAYER', 'B.Cu')
  for (let index = 1; index <= 30; index += 1) {
    const name = `In${index}.Cu`
    layerMap.set(`MID${index}`, name)
    layerMap.set(`MIDLAYER${index}`, name)
    layerMap.set(`PLANE${index}`, name)
    layerMap.set(`INTERNALPLANE${index}`, name)
  }
  return {
    layers,
    stackup,
    map: layerMap,
    copperCount: layers.length,
  }
}

function mapLayer(stack, name) {
  const key = normalizeLayerToken(name)
  if (stack.map.has(key)) return stack.map.get(key)
  // 形如 "Top Layer" / "Bottom Layer" 的层叠名称按 token 匹配。
  if (key.startsWith('TOP')) return 'F.Cu'
  if (key.startsWith('BOTTOM')) return 'B.Cu'
  return scalarText(name) || 'F.Cu'
}

function normalizeLayerToken(name) {
  return scalarText(name).toUpperCase().replace(/[\s_-]/gu, '')
}

function buildFootprints(components, pads, nameById, stack) {
  const byComponent = new Map()
  for (const pad of pads) {
    if (!isPlainObject(pad)) continue
    const index = pad.componentIndex
    if (!Number.isInteger(index) || index < 0 || index >= components.length) continue
    if (!byComponent.has(index)) byComponent.set(index, [])
    byComponent.get(index).push(pad)
  }
  return components.map((component, index) => {
    const componentPads = (byComponent.get(index) ?? []).map(pad => {
      const netNumber = netNumberFor(pad.netIndex)
      const netName = nameById[String(netNumber)] ?? ''
      return {
        number: scalarText(pad.name),
        net_number: netNumber,
        net_name: netName,
        abs_x: numberOrZero(pad.x),
        abs_y: numberOrZero(pad.y),
        x: numberOrZero(pad.x),
        y: numberOrZero(pad.y),
        type: scalarText(pad.type) || (numberOrZero(pad.drillMil) > 0 ? 'thru_hole' : 'smd'),
        drill: numberOrZero(pad.drillMil) * MIL_TO_MM,
        plated: pad.plated === true,
      }
    })
    const connectedNets = [...new Set(componentPads.map(pad => pad.net_name).filter(Boolean))].sort()
    const padNets = {}
    for (const pad of componentPads) {
      if (!pad.net_name) continue
      padNets[pad.number || `${Object.keys(padNets).length + 1}`] = { net: pad.net_name }
    }
    const value = scalarText(component.value)
    const footprint = scalarText(component.footprint)
    return {
      reference: scalarText(component.reference),
      value,
      library: footprint,
      lib_id: `AD:${footprint}`,
      footprint,
      mpn: scalarText(component.mpn),
      description: scalarText(component.description),
      x: numberOrZero(component.x),
      y: numberOrZero(component.y),
      angle: numberOrZero(component.angle),
      layer: mapLayer(stack, component.layer ?? (String(component.layer).toUpperCase() === 'BOTTOM' ? 'BOTTOM' : 'TOP')),
      type: componentPads.some(pad => pad.type === 'thru_hole') ? 'through_hole' : 'smd',
      pad_count: componentPads.length,
      pads: componentPads,
      pad_nets: padNets,
      connected_nets: connectedNets,
    }
  })
}

function netNumberFor(netIndex) {
  if (!Number.isInteger(netIndex) || netIndex < 0) return 0
  return netIndex + 1
}

function buildTracks(tracks, arcs, stack) {
  const segments = []
  for (const track of Array.isArray(tracks) ? tracks : []) {
    if (!isPlainObject(track)) continue
    segments.push({
      x1: numberOrZero(track.x1),
      y1: numberOrZero(track.y1),
      x2: numberOrZero(track.x2),
      y2: numberOrZero(track.y2),
      width: numberOrZero(track.widthMil) * MIL_TO_MM,
      layer: mapLayer(stack, track.layer),
      net: netNumberFor(track.netIndex),
    })
  }
  const arcEntries = []
  for (const arc of Array.isArray(arcs) ? arcs : []) {
    if (!isPlainObject(arc)) continue
    const centerX = numberOrZero(arc.x)
    const centerY = numberOrZero(arc.y)
    const radius = numberOrZero(arc.radiusMil) * MIL_TO_MM
    const start = numberOrZero(arc.startAngle)
    const end = numberOrZero(arc.endAngle)
    let sweep = end - start
    if (sweep <= 0) sweep += 360
    if (sweep <= 0 || sweep > 360) sweep = 360
    arcEntries.push({
      start: arcPoint(centerX, centerY, radius, start),
      mid: arcPoint(centerX, centerY, radius, start + sweep / 2),
      end: arcPoint(centerX, centerY, radius, start + sweep),
      width: numberOrZero(arc.widthMil) * MIL_TO_MM,
      layer: mapLayer(stack, arc.layer),
      net: netNumberFor(arc.netIndex),
      _radius_mm: radius,
      _sweep_deg: sweep,
    })
  }
  const widthDistribution = {}
  const layerDistribution = {}
  for (const entry of [...segments, ...arcEntries]) {
    widthDistribution[entry.width] = (widthDistribution[entry.width] ?? 0) + 1
    layerDistribution[entry.layer] = (layerDistribution[entry.layer] ?? 0) + 1
  }
  return {
    segment_count: segments.length,
    arc_count: arcEntries.length,
    total_count: segments.length + arcEntries.length,
    width_distribution: widthDistribution,
    layer_distribution: layerDistribution,
    segments,
    arcs: arcEntries,
  }
}

function arcPoint(centerX, centerY, radius, angleDegrees) {
  const angle = (angleDegrees * Math.PI) / 180
  return [centerX + radius * Math.cos(angle), centerY + radius * Math.sin(angle)]
}

function buildVias(vias, stack, idByName) {
  const entries = []
  for (const via of Array.isArray(vias) ? vias : []) {
    if (!isPlainObject(via)) continue
    const net = netNumberFor(via.netIndex)
    entries.push({
      x: numberOrZero(via.x),
      y: numberOrZero(via.y),
      size: numberOrZero(via.diameterMil) * MIL_TO_MM,
      drill: numberOrZero(via.drillMil) * MIL_TO_MM,
      net,
      net_name: Object.entries(idByName).find(([, id]) => id === net)?.[0] ?? '',
      type: 'through',
      // 快照不含盲埋孔层对；按通孔处理，并只用于位置/网络判断。
      layers: ['F.Cu', 'B.Cu'],
    })
  }
  const sizeDistribution = {}
  for (const entry of entries) {
    const key = `${entry.size}/${entry.drill}`
    sizeDistribution[key] = (sizeDistribution[key] ?? 0) + 1
  }
  return { count: entries.length, size_distribution: sizeDistribution, vias: entries }
}

function buildOutline(outline) {
  const width = numberOrZero(outline?.widthMm)
  const height = numberOrZero(outline?.heightMm)
  const boundingBox = width > 0 && height > 0
    ? { min_x: 0, min_y: 0, max_x: width, max_y: height, width, height }
    : null
  return {
    edge_count: 0,
    edges: [],
    bounding_box: boundingBox,
    width_mm: width || null,
    height_mm: height || null,
  }
}

function buildStatistics(pcb, footprints, tracks, vias, stack) {
  let totalLength = 0
  for (const segment of tracks.segments) {
    totalLength += Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1)
  }
  for (const arc of tracks.arcs) {
    totalLength += Math.abs(arc._radius_mm * (arc._sweep_deg * Math.PI / 180))
  }
  const width = numberOrZero(pcb.outline?.widthMm)
  const height = numberOrZero(pcb.outline?.heightMm)
  return {
    footprint_count: footprints.length,
    front_side: footprints.filter(footprint => footprint.layer === 'F.Cu').length,
    back_side: footprints.filter(footprint => footprint.layer === 'B.Cu').length,
    smd_count: footprints.filter(footprint => footprint.type === 'smd').length,
    tht_count: footprints.filter(footprint => footprint.type === 'through_hole').length,
    copper_layers_used: stack.copperCount,
    copper_layer_names: stack.layers.map(layer => layer.name),
    track_segments: tracks.total_count,
    via_count: vias.count,
    total_track_length_mm: round(totalLength, 2),
    board_width_mm: width || null,
    board_height_mm: height || null,
    board_area_mm2: width > 0 && height > 0 ? round(width * height, 1) : null,
    net_count: Object.keys(pcb.nets ?? {}).length,
  }
}

function analyzeNetLengths(tracks, vias, nameById) {
  const netData = new Map()
  const ensure = (net) => {
    if (!netData.has(net)) {
      netData.set(net, { layers: new Map(), total_length: 0, segment_count: 0, via_count: 0 })
    }
    return netData.get(net)
  }
  for (const segment of tracks.segments) {
    if (segment.net <= 0) continue
    const length = Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1)
    const data = ensure(segment.net)
    data.total_length += length
    data.segment_count += 1
    const layer = data.layers.get(segment.layer) ?? { length: 0, segments: 0 }
    layer.length += length
    layer.segments += 1
    data.layers.set(segment.layer, layer)
  }
  for (const arc of tracks.arcs) {
    if (arc.net <= 0) continue
    const length = Math.abs(arc._radius_mm * (arc._sweep_deg * Math.PI / 180))
    const data = ensure(arc.net)
    data.total_length += length
    data.segment_count += 1
    const layer = data.layers.get(arc.layer) ?? { length: 0, segments: 0 }
    layer.length += length
    layer.segments += 1
    data.layers.set(arc.layer, layer)
  }
  for (const via of vias.vias) {
    if (via.net <= 0) continue
    ensure(via.net).via_count += 1
  }
  return [...netData.entries()]
    .filter(([, data]) => data.total_length > 0)
    .sort((a, b) => b[1].total_length - a[1].total_length)
    .map(([net, data]) => ({
      net: nameById[net] ?? `net_${net}`,
      net_number: net,
      total_length_mm: round(data.total_length, 3),
      segment_count: data.segment_count,
      via_count: data.via_count,
      layers: Object.fromEntries(
        [...data.layers.entries()].map(([layer, info]) => [
          layer,
          { length_mm: round(info.length, 3), segments: info.segments },
        ]),
      ),
    }))
}

// ---------------------------------------------------------------------------
// 去耦 / 地平面域 / 开关热回路（与上游 analyze_pcb.py 的算法对齐）
// ---------------------------------------------------------------------------

const ESD_TVS_PREFIXES = ['esd', 'prtr', 'usblc', 'tpd', 'pesd', 'sp05', 'rclamp', 'nup', 'lesd', 'ip4', 'dt104']

function analyzeDecouplingPlacement(footprints) {
  const caps = footprints.filter(footprint => /^C\d/u.test(footprint.reference))
  if (caps.length === 0) return []
  const results = []
  for (const ic of footprints.filter(footprint => /^(U|IC)\d/u.test(footprint.reference))) {
    const { nearby, rejected } = nearbyDecouplingCaps(ic, caps)
    if (nearby.length === 0) continue
    const entry = {
      ic: ic.reference,
      value: ic.value,
      layer: ic.layer,
      nearby_caps: nearby,
      closest_cap_mm: nearby[0].distance_mm,
    }
    if (rejected.length > 0) entry.gnd_only_caps = rejected
    results.push(entry)
  }
  for (const ic of footprints.filter(footprint => /^(U|IC)\d/u.test(footprint.reference)
    && ESD_TVS_PREFIXES.some(prefix => String(footprint.value).toLowerCase().startsWith(prefix)))) {
    const { nearby, rejected } = nearbyDecouplingCaps(ic, caps)
    if (nearby.length === 0) continue
    const entry = {
      ic: ic.reference,
      value: ic.value,
      layer: ic.layer,
      category: 'esd_bypass',
      nearby_caps: nearby,
      closest_cap_mm: nearby[0].distance_mm,
    }
    if (rejected.length > 0) entry.gnd_only_caps = rejected
    results.push(entry)
  }
  return results
}

function nearbyDecouplingCaps(ic, caps) {
  const icNets = new Set(ic.pads.map(pad => pad.net_name).filter(Boolean))
  const nearby = []
  const rejected = []
  for (const cap of caps) {
    const distance = minPowerPadDistance(ic, cap)
    if (distance > 10) continue
    const capNets = new Set(cap.pads.map(pad => pad.net_name).filter(Boolean))
    const shared = [...icNets].filter(net => capNets.has(net) && !isGroundNet(net))
    if (shared.length === 0) {
      rejected.push(cap.reference)
      continue
    }
    nearby.push({
      cap: cap.reference,
      value: cap.value,
      distance_mm: round(distance, 2),
      shared_nets: shared.sort(),
      same_side: cap.layer === ic.layer,
    })
  }
  nearby.sort((a, b) => a.distance_mm - b.distance_mm || a.cap.localeCompare(b.cap))
  return { nearby, rejected: rejected.sort() }
}

function minPowerPadDistance(ic, cap) {
  const powerPads = ic.pads.filter(pad => isPowerOrGroundName(pad.net_name))
  if (powerPads.length === 0 || cap.pads.length === 0) {
    return Math.hypot(ic.x - cap.x, ic.y - cap.y)
  }
  let minimum = Number.POSITIVE_INFINITY
  for (const icPad of powerPads) {
    for (const capPad of cap.pads) {
      const distance = Math.hypot(icPad.abs_x - capPad.abs_x, icPad.abs_y - capPad.abs_y)
      if (distance < minimum) minimum = distance
    }
  }
  return minimum
}

function analyzeGroundDomains(footprints) {
  const groundNets = new Set()
  for (const footprint of footprints) {
    for (const pad of footprint.pads) {
      const upper = scalarText(pad.net_name).toUpperCase()
      if (upper && (upper.includes('GND') || upper.includes('VSS') || upper.includes('GROUND'))) {
        groundNets.add(pad.net_name)
      }
    }
  }
  if (groundNets.size === 0) {
    return { domain_count: 0, domains: [], multi_domain_components: [] }
  }
  const domainComponents = new Map([...groundNets].map(net => [net, new Set()]))
  const componentDomains = new Map()
  for (const footprint of footprints) {
    for (const pad of footprint.pads) {
      if (!groundNets.has(pad.net_name)) continue
      domainComponents.get(pad.net_name).add(footprint.reference)
      if (!componentDomains.has(footprint.reference)) componentDomains.set(footprint.reference, new Set())
      componentDomains.get(footprint.reference).add(pad.net_name)
    }
  }
  const domains = [...domainComponents.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([net, components]) => ({
      net_name: net,
      net,
      component_count: components.size,
      components: [...components].sort(),
      has_zone: false,
      zone_layers: [],
    }))
  const multi = [...componentDomains.entries()]
    .filter(([, nets]) => nets.size > 1)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([component, nets]) => ({ component, ground_nets: [...nets].sort() }))
  return { domain_count: domains.length, domains, multi_domain_components: multi }
}

function buildSwitchingLoopAreas(findings, footprints) {
  const regulators = findings.filter(finding => finding?.detector === 'detect_power_regulators')
  if (regulators.length === 0) return []
  const positions = new Map(footprints.map(footprint => [footprint.reference, [footprint.x, footprint.y]]))
  const results = []
  for (const regulator of regulators) {
    const topology = scalarText(regulator.topology).toLowerCase()
    if (['ldo', 'linear', 'unknown', 'ic_with_internal_regulator', 'load_switch', 'charge_pump'].includes(topology)) {
      continue
    }
    const ref = scalarText(regulator.ref ?? regulator.reference)
    const inductor = regulator.inductor
    const inductorRef = isPlainObject(inductor) ? scalarText(inductor.ref) : scalarText(inductor)
    const inputCaps = Array.isArray(regulator.input_capacitors) ? regulator.input_capacitors : []
    if (!inductorRef || inputCaps.length === 0) continue
    const capRef = isPlainObject(inputCaps[0]) ? scalarText(inputCaps[0].ref) : scalarText(inputCaps[0])
    const icPosition = positions.get(ref)
    const inductorPosition = positions.get(inductorRef)
    const capPosition = positions.get(capRef)
    if (!icPosition || !inductorPosition || !capPosition) continue
    if (samePoint(icPosition, [0, 0]) || samePoint(inductorPosition, [0, 0]) || samePoint(capPosition, [0, 0])) continue
    const vertices = [capPosition, icPosition, inductorPosition]
    let area = 0
    for (let index = 0; index < vertices.length; index += 1) {
      const next = (index + 1) % vertices.length
      area += vertices[index][0] * vertices[next][1]
      area -= vertices[next][0] * vertices[index][1]
    }
    results.push({
      regulator_ref: ref,
      regulator_value: scalarText(regulator.value),
      inductor_ref: inductorRef,
      cap_ref: capRef,
      area_mm2: round(Math.abs(area) / 2, 1),
      vertices_mm: vertices.map(point => [...point]),
    })
  }
  return results
}

function samePoint(a, b) {
  return a[0] === b[0] && a[1] === b[1]
}

// ---------------------------------------------------------------------------
// 覆盖评估
// ---------------------------------------------------------------------------

function assessCoverage({
  schematicJson,
  pcbJson,
  netlistComplete,
  upstream,
  requested,
  standard = DEFAULT_STANDARD,
  prepareError = null,
  scriptsDir = null,
  outDir = null,
}) {
  const metadata = isPlainObject(schematicJson?._ad_happy) ? schematicJson._ad_happy : {}
  const detectors = normalizeDetectors(metadata.detectors)
  const footprints = Array.isArray(pcbJson?.footprints) ? pcbJson.footprints : []
  const tracks = Array.isArray(pcbJson?.tracks?.segments) ? pcbJson.tracks.segments : []
  const viaEntries = Array.isArray(pcbJson?.vias?.vias) ? pcbJson.vias.vias : []
  const connectors = footprints.filter(isConnectorFootprint)
  const hasCaps = footprints.some(footprint => /^C\d/u.test(footprint.reference))
  const hasIcs = footprints.some(footprint => /^(U|IC)\d/u.test(footprint.reference))
  const copperLayers = Array.isArray(pcbJson?.layers)
    ? pcbJson.layers.filter(layer => layer.type === 'signal' || layer.type === 'power').length
    : 0
  const regulatorInfo = detectors.power_regulators ?? { status: 'not_evaluated', count: 0 }
  const powerRegulators = regulatorInfo.status === 'ok' || regulatorInfo.status === 'pipeline'
  const hasRegulators = numberOrZero(regulatorInfo.count) > 0
    || (Array.isArray(schematicJson?.findings)
      && schematicJson.findings.some(finding => finding?.detector === 'detect_power_regulators'))
  const protectionInfo = detectors.protection_devices ?? { status: 'not_evaluated', count: 0 }
  const lcInfo = detectors.lc_filters ?? { status: 'not_evaluated', count: 0, input_filters: 0 }
  const diffInfo = detectors.differential_pairs ?? { status: 'not_evaluated', count: 0 }
  const crystalInfo = detectors.crystals ?? { status: 'not_evaluated', count: 0 }
  const adcInfo = detectors.adc_circuits ?? { status: 'not_evaluated', count: 0 }
  const opampInfo = detectors.opamp_circuits ?? { status: 'not_evaluated', count: 0 }
  const rfInfo = detectors.rf_chains ?? { status: 'not_evaluated', count: 0 }
  const data = {
    hasPcb: footprints.length > 0 || tracks.length > 0,
    hasSchematic: Array.isArray(schematicJson?.components) && schematicJson.components.length > 0,
    hasCaps,
    hasIcs,
    hasConnectors: connectors.length > 0,
    hasVias: viaEntries.length > 0,
    hasTracks: tracks.length > 0,
    hasNetLengths: Array.isArray(pcbJson?.net_lengths) && pcbJson.net_lengths.length > 0,
    copperLayers,
    powerRegulators,
    hasRegulators,
    protectionDevices: protectionInfo.status === 'ok',
    lcFilters: lcInfo.status === 'ok',
    hasInputLcFilter: numberOrZero(lcInfo.input_filters) > 0,
    differentialPairs: diffInfo.status === 'ok',
    hasDifferentialPairs: numberOrZero(diffInfo.count) > 0,
    crystals: crystalInfo.status === 'ok',
    adcCircuits: adcInfo.status === 'ok',
    opampCircuits: opampInfo.status === 'ok',
    rfChains: rfInfo.status === 'ok',
    netlistComplete: netlistComplete !== false,
  }
  const rules = evaluateRuleAvailability(data)
  const categoryMap = new Map()
  for (const definition of EMC_RULE_CATEGORIES) {
    const entries = definition.rules.map(rule => ({
      rule,
      ...(rules.get(rule) ?? { status: STATUS_NOT_EVALUATED, reason: '未登记的上游规则' }),
    }))
    const evaluated = entries.filter(entry => entry.status === STATUS_EVALUATED)
    const partial = entries.filter(entry => entry.status === STATUS_PARTIAL)
    const notEvaluated = entries.filter(entry => entry.status === STATUS_NOT_EVALUATED)
    const status = evaluated.length + partial.length === 0
      ? STATUS_NOT_EVALUATED
      : notEvaluated.length > 0 || partial.length > 0
        ? STATUS_PARTIAL
        : STATUS_EVALUATED
    categoryMap.set(definition.key, {
      key: definition.key,
      label: definition.label,
      status,
      rules: entries,
      evaluatedRules: evaluated.map(entry => entry.rule),
      partiallyEvaluatedRules: partial.map(entry => entry.rule),
      notEvaluatedRules: notEvaluated.map(entry => ({ rule: entry.rule, reason: entry.reason })),
      reasons: dedupe([
        ...partial.map(entry => entry.reason),
        ...notEvaluated.map(entry => entry.reason),
      ]),
    })
  }

  const evaluatedRules = []
  const partiallyEvaluatedRules = []
  const notEvaluatedRules = []
  for (const [rule, info] of rules.entries()) {
    if (info.status === STATUS_EVALUATED) evaluatedRules.push(rule)
    else if (info.status === STATUS_PARTIAL) partiallyEvaluatedRules.push(rule)
    else notEvaluatedRules.push({ rule, reason: info.reason })
  }
  evaluatedRules.sort()
  partiallyEvaluatedRules.sort()
  notEvaluatedRules.sort((a, b) => a.rule.localeCompare(b.rule))

  const allowedRules = new Set([...evaluatedRules, ...partiallyEvaluatedRules])
  const rawFindings = Array.isArray(upstream?.findings) ? upstream.findings : []
  const suppressedFindings = []
  const unsupportedRules = new Set()
  for (const finding of rawFindings) {
    const rule = scalarText(finding?.rule_id)
    if (!rule) continue
    if (allowedRules.has(rule)) continue
    if (!rules.has(rule)) unsupportedRules.add(rule)
    const reason = rules.get(rule)?.reason ?? '上游新增规则，当前覆盖模型未登记'
    const existing = suppressedFindings.find(entry => entry.rule === rule)
    if (existing) existing.count += 1
    else suppressedFindings.push({ rule, count: 1, reason })
  }

  const keptFindings = rawFindings.filter(finding => allowedRules.has(scalarText(finding?.rule_id)))
  const prepWarnings = Array.isArray(metadata.warnings) ? metadata.warnings : []
  const detectorFailures = Object.entries(detectors)
    .filter(([, info]) => info.status === 'failed')
    .map(([name, info]) => `${name} 检测器失败：${info.reason || '未提供原因'}`)
  const reasons = dedupe([
    ...(prepareError ? [prepareError] : []),
    ...prepWarnings,
    ...detectorFailures,
    ...notEvaluatedRules.map(entry => entry.reason),
    ...partiallyEvaluatedRules.map(rule => rules.get(rule)?.reason ?? ''),
    ...suppressedFindings.map(entry => `规则 ${entry.rule} 的上游结果已排除：${entry.reason}`),
    ...[...unsupportedRules].map(rule => `上游规则 ${rule} 未登记，结果已排除并在报告中列为未评估。`),
  ])

  const usable = evaluatedRules.length + partiallyEvaluatedRules.length > 0
  let status
  if (upstream && upstream.status === 'failed') status = 'failed'
  else if (!requested && !upstream) status = 'not_evaluated'
  else if (!usable) status = 'not_evaluated'
  else if (notEvaluatedRules.length > 0 || partiallyEvaluatedRules.length > 0) status = 'partial'
  else if (keptFindings.length > 0) status = 'found'
  else status = 'pass'

  const counts = {
    evaluated: evaluatedRules.length,
    partial: partiallyEvaluatedRules.length,
    notEvaluated: notEvaluatedRules.length,
    issues: 0,
    facts: 0,
  }
  return {
    requested,
    status,
    standard,
    available: Boolean(upstream),
    netlist: { complete: netlistComplete !== false },
    categories: [...categoryMap.values()],
    evaluatedRules,
    partiallyEvaluatedRules,
    notEvaluatedRules,
    suppressedFindings,
    unsupportedRules: [...unsupportedRules].sort(),
    reasons,
    counts,
    findings: keptFindings.length,
    facts: 0,
    detectors,
    upstream: null,
    artifacts: null,
  }
}

function normalizeDetectors(value) {
  if (!isPlainObject(value)) return {}
  const result = {}
  for (const [key, entry] of Object.entries(value)) {
    if (isPlainObject(entry)) {
      result[key] = {
        status: scalarText(entry.status) || 'not_evaluated',
        count: numberOrZero(entry.count),
        input_filters: numberOrZero(entry.input_filters),
        reason: scalarText(entry.reason),
      }
    } else {
      result[key] = { status: scalarText(entry) || 'not_evaluated', count: 0, input_filters: 0, reason: '' }
    }
  }
  return result
}

function evaluateRuleAvailability(data) {
  const rules = new Map()
  const set = (rule, status, reason = '') => rules.set(rule, { status, reason })
  const reasonPcb = '缺少可用的 PCB 快照'
  const reasonNetlist = '原理图网表匹配不完整，依赖网表的规则无法下结论'
  const reasonZones = '离线解析未捕获铺铜/区域填充形状（zones），无法评估该规则'
  const reasonEdges = '离线解析未捕获板框线段几何，只有包围盒尺寸'
  const reasonDielectric = '离线解析未捕获叠层介质厚度与介电常数（εr）；上游会用默认 εr=4.4 做近似'
  const reasonLayerTransitions = '未计算信号换层与过孔层对（layer_transitions）'
  const reasonProximity = '未计算走线邻近度（trace_proximity，需上游 --proximity 等价数据）'
  const reasonCrystals = '晶振检测器未成功运行，依赖晶振频率的规则无法下结论'
  const reasonSensitive = '敏感器件（晶振/ADC/运放/RF）检测未全部成功，无法评估电感漏磁'
  const netlistOk = data.netlistComplete === true

  set('GP-001', STATUS_NOT_EVALUATED, '缺少回流路径连续性数据（需铺铜实形与上游 --full 级分析）')
  set('GP-002', STATUS_NOT_EVALUATED, reasonZones)
  set('GP-003', STATUS_NOT_EVALUATED, reasonZones)
  set('GP-004', STATUS_NOT_EVALUATED, reasonZones)
  set('GP-005', data.hasPcb ? STATUS_EVALUATED : STATUS_NOT_EVALUATED, data.hasPcb ? '' : reasonPcb)

  if (!data.hasPcb) {
    set('DC-001', STATUS_NOT_EVALUATED, reasonPcb)
    set('DC-002', STATUS_NOT_EVALUATED, reasonPcb)
  } else if (!data.hasCaps || !data.hasIcs) {
    set('DC-001', STATUS_NOT_EVALUATED, '板上没有可识别的电容或 IC，去耦距离检查无适用对象')
    set('DC-002', STATUS_NOT_EVALUATED, '板上没有可识别的电容或 IC，去耦距离检查无适用对象')
  } else {
    set('DC-001', STATUS_EVALUATED)
    set('DC-002', STATUS_EVALUATED)
  }
  if (!data.hasPcb) {
    set('DC-003', STATUS_NOT_EVALUATED, reasonPcb)
  } else if (data.copperLayers === 2) {
    set('DC-003', STATUS_EVALUATED, '')
  } else if (data.copperLayers > 2) {
    set('DC-003', STATUS_NOT_EVALUATED, '缺少铺铜区域，无法判断电容是否被同网覆铜直接连接')
  } else {
    set('DC-003', STATUS_NOT_EVALUATED, '铜层数量未知，无法判断去耦过孔规则是否适用')
  }

  if (!data.hasPcb || !data.hasConnectors) {
    set('IO-001', STATUS_NOT_EVALUATED, data.hasPcb ? '板上没有连接器，规则无适用对象' : reasonPcb)
    set('IO-002', STATUS_NOT_EVALUATED, data.hasPcb ? '板上没有连接器，规则无适用对象' : reasonPcb)
  } else {
    set('IO-001',
      data.protectionDevices && netlistOk ? STATUS_EVALUATED : STATUS_NOT_EVALUATED,
      !data.protectionDevices
        ? '原理图保护器件识别未完成，无法判断连接器是否有 ESD/TVS 保护'
        : netlistOk ? '' : reasonNetlist)
    // IO-002 只依赖 PCB 焊盘网络，不受原理图网表完整性影响。
    set('IO-002', STATUS_EVALUATED)
  }

  for (const rule of ['SW-001', 'SW-003']) {
    if (!data.powerRegulators) set(rule, STATUS_NOT_EVALUATED, reasonNetlist)
    else if (!netlistOk) set(rule, STATUS_NOT_EVALUATED, reasonNetlist)
    else set(rule, STATUS_EVALUATED)
  }
  // SW-002 同时依赖走线铜面积与 zones 面积；缺少 zones 时无法完整评估。
  set('SW-002', STATUS_NOT_EVALUATED, reasonZones)

  if (!data.hasPcb || !data.hasNetLengths) {
    set('CK-001', STATUS_NOT_EVALUATED, data.hasPcb ? '没有可用的网络走线长度数据' : reasonPcb)
    set('CK-002', STATUS_NOT_EVALUATED, data.hasPcb ? '没有可用的网络走线长度数据' : reasonPcb)
  } else if (!data.crystals) {
    set('CK-001', STATUS_NOT_EVALUATED, reasonCrystals)
    set('CK-002', STATUS_NOT_EVALUATED, reasonCrystals)
  } else if (!netlistOk) {
    set('CK-001', STATUS_NOT_EVALUATED, reasonNetlist)
    set('CK-002', STATUS_NOT_EVALUATED, reasonNetlist)
  } else {
    set('CK-001', STATUS_EVALUATED)
    set('CK-002', STATUS_EVALUATED)
  }
  if (!data.hasPcb || !data.hasTracks || !data.hasConnectors) {
    set('CK-003', STATUS_NOT_EVALUATED, data.hasPcb ? '缺少走线段或连接器位置' : reasonPcb)
  } else {
    set('CK-003', STATUS_EVALUATED)
  }
  set('CK-004', STATUS_NOT_EVALUATED, reasonZones)

  if (!data.hasPcb) set('VS-001', STATUS_NOT_EVALUATED, reasonPcb)
  else if (!data.crystals) set('VS-001', STATUS_NOT_EVALUATED, reasonCrystals)
  else if (!netlistOk) set('VS-001', STATUS_NOT_EVALUATED, reasonNetlist)
  else set('VS-001', STATUS_EVALUATED)
  if (!data.hasPcb || data.copperLayers < 2) {
    set('SU-001', STATUS_NOT_EVALUATED, data.hasPcb ? '铜层数量不足或层叠未知' : reasonPcb)
  } else {
    set('SU-001', STATUS_EVALUATED)
  }
  set('SU-002', STATUS_NOT_EVALUATED, reasonDielectric)
  set('SU-003', STATUS_NOT_EVALUATED, reasonDielectric)
  set('EE-001', STATUS_NOT_EVALUATED, `${reasonDielectric}；未用默认值替代近似`)
  set('EE-002',
    data.powerRegulators && netlistOk ? STATUS_EVALUATED : STATUS_NOT_EVALUATED,
    data.powerRegulators ? (netlistOk ? '' : reasonNetlist) : reasonNetlist)

  if (!data.differentialPairs) {
    for (const rule of ['DP-001', 'DP-002', 'DP-003', 'DP-004']) {
      set(rule, STATUS_NOT_EVALUATED, '原理图差分对识别未完成')
    }
  } else if (!netlistOk) {
    for (const rule of ['DP-001', 'DP-002', 'DP-003', 'DP-004']) {
      set(rule, STATUS_NOT_EVALUATED, reasonNetlist)
    }
  } else {
    // DP-001/002 的 skew/共模辐射计算需要传播延时，而传播延时要 εr；
    // 快照没有介质参数，不能静默使用默认 εr=4.4。
    set('DP-001', STATUS_NOT_EVALUATED, reasonDielectric)
    set('DP-002', STATUS_NOT_EVALUATED, reasonDielectric)
    set('DP-003', data.hasDifferentialPairs ? STATUS_NOT_EVALUATED : STATUS_EVALUATED,
      data.hasDifferentialPairs ? reasonLayerTransitions : '')
    set('DP-004', STATUS_EVALUATED)
  }

  set('BE-001', STATUS_NOT_EVALUATED, reasonEdges)
  set('BE-002', STATUS_NOT_EVALUATED, reasonZones)
  if (!data.hasPcb || !data.hasConnectors) {
    set('BE-003', STATUS_NOT_EVALUATED, data.hasPcb ? '板上没有连接器，规则无适用对象' : reasonPcb)
  } else if (!data.hasVias) {
    set('BE-003', STATUS_NOT_EVALUATED, '快照没有独立过孔位置，无法评估连接器附近过孔密度')
  } else {
    set('BE-003', STATUS_EVALUATED)
  }

  set('XT-001', STATUS_NOT_EVALUATED, reasonProximity)

  if (!data.powerRegulators || !data.lcFilters) {
    set('EF-001', STATUS_NOT_EVALUATED, !data.powerRegulators ? reasonNetlist : '原理图 LC 滤波识别未完成')
    set('EF-002', STATUS_NOT_EVALUATED, !data.powerRegulators ? reasonNetlist : '原理图 LC 滤波识别未完成')
  } else if (!netlistOk) {
    set('EF-001', STATUS_NOT_EVALUATED, reasonNetlist)
    set('EF-002', STATUS_NOT_EVALUATED, reasonNetlist)
  } else if (data.hasRegulators && !data.hasInputLcFilter) {
    set('EF-001', STATUS_PARTIAL, '未检测到位于稳压器输入轨的 LC 滤波器；上游对纯电容滤波不做结论')
    set('EF-002', STATUS_PARTIAL, '未检测到位于稳压器输入轨的 LC 滤波器；上游对纯电容滤波不做结论')
  } else {
    set('EF-001', STATUS_EVALUATED)
    set('EF-002', STATUS_EVALUATED)
  }

  if (!data.protectionDevices || !data.hasPcb) {
    set('ES-001', STATUS_NOT_EVALUATED, data.hasPcb ? '原理图保护器件识别未完成' : reasonPcb)
    set('ES-002', STATUS_NOT_EVALUATED, data.hasPcb ? '原理图保护器件识别未完成' : reasonPcb)
  } else if (!netlistOk) {
    set('ES-001', STATUS_NOT_EVALUATED, reasonNetlist)
    set('ES-002', STATUS_NOT_EVALUATED, reasonNetlist)
  } else if (!data.hasConnectors) {
    set('ES-001', STATUS_EVALUATED)
    set('ES-002', STATUS_EVALUATED)
  } else if (!data.hasVias) {
    set('ES-001', STATUS_EVALUATED)
    set('ES-002', STATUS_NOT_EVALUATED, '快照没有独立过孔位置，无法评估 ESD 器件接地过孔')
  } else {
    set('ES-001', STATUS_EVALUATED)
    set('ES-002', STATUS_EVALUATED)
  }

  if (!data.powerRegulators || !netlistOk) {
    set('TH-001', STATUS_NOT_EVALUATED, reasonNetlist)
    set('TH-002', STATUS_NOT_EVALUATED, reasonNetlist)
  } else {
    set('TH-001', STATUS_EVALUATED)
    set('TH-002', data.hasPcb ? STATUS_EVALUATED : STATUS_NOT_EVALUATED, data.hasPcb ? '' : reasonPcb)
  }

  if (!data.hasPcb) set('SH-001', STATUS_NOT_EVALUATED, reasonPcb)
  else if (!data.crystals) set('SH-001', STATUS_NOT_EVALUATED, reasonCrystals)
  else if (!data.powerRegulators || !netlistOk) set('SH-001', STATUS_NOT_EVALUATED, reasonNetlist)
  else set('SH-001', STATUS_EVALUATED)

  // PD-001/002 的解析扫描需要平面间电容；缺少介质参数时上游会按 0 处理，
  // 这是近似而不是完整评估，按需求原文统一标为 not_evaluated。
  set('PD-001', STATUS_NOT_EVALUATED, reasonDielectric)
  set('PD-002', STATUS_NOT_EVALUATED, reasonDielectric)
  set('PD-003', STATUS_NOT_EVALUATED, '缺少 power_budget、负载 IC 与走线寄生参数')
  set('PD-004', STATUS_NOT_EVALUATED, '缺少 power_budget 与跨轨瞬态电流数据')
  set('RP-001', STATUS_NOT_EVALUATED, reasonLayerTransitions)
  if (!data.powerRegulators || !data.hasPcb) {
    set('ML-001', STATUS_NOT_EVALUATED, data.hasPcb ? reasonNetlist : reasonPcb)
  } else if (!netlistOk) {
    set('ML-001', STATUS_NOT_EVALUATED, reasonNetlist)
  } else if (!data.crystals || !data.adcCircuits || !data.opampCircuits || !data.rfChains) {
    const missing = [
      !data.crystals ? '晶振' : '',
      !data.adcCircuits ? 'ADC' : '',
      !data.opampCircuits ? '运放' : '',
      !data.rfChains ? 'RF' : '',
    ].filter(Boolean).join('/')
    set('ML-001', STATUS_NOT_EVALUATED, `${reasonSensitive}（缺：${missing}）`)
  } else {
    set('ML-001', STATUS_EVALUATED)
  }
  return rules
}

// ---------------------------------------------------------------------------
// 上游结果归一化
// ---------------------------------------------------------------------------

function normalizeUpstreamFindings(findings, coverage, standard) {
  const allowed = new Set([...coverage.evaluatedRules, ...coverage.partiallyEvaluatedRules])
  const result = []
  for (const finding of Array.isArray(findings) ? findings : []) {
    if (!isPlainObject(finding)) continue
    const upstreamRule = scalarText(finding.rule_id)
    if (!allowed.has(upstreamRule)) continue
    const localized = localizeFinding(finding, standard)
    const severity = mapSeverity(finding.severity)
    result.push({
      detector: 'emc',
      rule_id: `EM-${upstreamRule}`,
      source_rule_id: upstreamRule,
      category: scalarText(finding.category) || 'emc',
      kind: FACT_RULES.has(upstreamRule) ? 'fact' : 'issue',
      severity,
      upstream_severity: scalarText(finding.severity),
      confidence: scalarText(finding.confidence) || 'heuristic',
      evidence_source: 'emc',
      summary: localized.title,
      title: localized.title,
      description: localized.description,
      evidence: localized.description,
      recommendation: localized.recommendation,
      components: stringList(finding.components),
      nets: stringList(finding.nets),
      pins: stringList(finding.pins),
      source: 'emc',
      standard,
      upstream_finding_id: scalarText(finding.finding_id),
    })
  }
  return result
}

function mapSeverity(value) {
  const severity = scalarText(value).toLowerCase()
  if (severity === 'error' || severity === 'critical' || severity === 'high') return 'must_fix'
  if (severity === 'warning' || severity === 'warn' || severity === 'medium') return 'should_fix'
  return 'nice_to_have'
}

function localizeFinding(finding, standard) {
  const rule = scalarText(finding.rule_id)
  const title = scalarText(finding.title)
  const description = scalarText(finding.description)
  const recommendation = scalarText(finding.recommendation)
  const components = stringList(finding.components)
  const nets = stringList(finding.nets)
  const refs = components.join('、')
  const netText = nets.join('、')
  const value = scalarText(finding.value)
  const numberFrom = (pattern, source = description) => {
    const match = pattern.exec(source)
    return match ? Number(match[1]) : null
  }
  const textFrom = (pattern, source = description) => {
    const match = pattern.exec(source)
    return match ? String(match[1]) : ''
  }
  const component = refs || '相关元件'
  const netLabel = netText || '相关网络'
  const standardLabel = standard === 'fcc-class-b' ? 'FCC Part 15 Class B' : standard
  const generic = (ruleName) => ({
    title: ruleName,
    description: `${ruleName}：上游规则 ${rule} 判定存在风险；涉及元件：${component}；网络：${netLabel}。`,
    recommendation: '',
  })

  switch (rule) {
    case 'GP-001':
      return {
        title: '缺少回流路径连续性数据',
        description: '本次 PCB 数据不含参考平面覆盖率，无法评估信号回流路径连续性。',
        recommendation: '补充铺铜实形与回流路径分析后重跑。',
      }
    case 'GP-002':
      return {
        title: '未检测到接地平面',
        description: '上游规则未在板卡上检测到接地平面覆铜区域。',
        recommendation: '在至少一个内层或外层增加完整接地覆铜。',
      }
    case 'GP-003':
      return {
        title: '接地平面碎裂',
        description: `接地平面被分割成多个孤岛（${component}），会形成缝隙天线并破坏回流路径。`,
        recommendation: '用走线或过孔连接各接地孤岛，并检查分割平面的布线通道。',
      }
    case 'GP-004':
      return {
        title: '接地平面填充率低',
        description: `接地平面填充率偏低（${component}），可能由布线过密或热焊盘隔离造成。`,
        recommendation: '降低该层布线密度或把信号移到其他层。',
      }
    case 'GP-005': {
      const count = numberFrom(/(\d+)\s+ground domains/i) ?? numberFrom(/(\d+)\s*个/, title)
      return {
        title: `检测到 ${count ?? '多'} 个地平面域`,
        description: `板上存在 ${count ?? '多'} 个独立地平面域${netText ? `（${netText}）` : ''}。多个地平面域需要谨慎的单点连接，避免地环路与共模辐射。`,
        recommendation: '确认各接地域只在预定点连接（通常在 ADC 附近），且没有信号跨域布线。',
      }
    }
    case 'DC-001': {
      const distance = numberFrom(/([\d.]+)\s*mm away/i)
      const ic = components[0] || textFrom(/from\s+(\S+)/i) || component
      return {
        title: `去耦电容距 ${ic} 过远`,
        description: `离 ${ic} 最近的去耦电容约 ${distance ?? '?'} mm${value ? `（${value}）` : ''}。每毫米走线约增加 0.3–0.8 nH 回路电感，高频去耦效果下降。`,
        recommendation: `把去耦电容移到 ${ic} 电源引脚 2–3 mm 范围内。`,
      }
    }
    case 'DC-002': {
      const ic = components[0] || textFrom(/near\s+(\S+)/i) || component
      return {
        title: `${ic} 附近缺少去耦电容`,
        description: `${ic} 周围 10 mm 内没有去耦电容。每个带电源引脚的 IC 至少需要一个去耦电容。`,
        recommendation: `在 ${ic} 电源引脚附近放置 100 nF X7R + 1 µF X5R，并缩短到过孔的距离。`,
      }
    }
    case 'DC-003': {
      const cap = components[0] || component
      const distance = numberFrom(/([\d.]+)\s*mm from the nearest via/i)
      const inductance = numberFrom(/~([\d.]+)\s*nH/i)
      return {
        title: `去耦电容 ${cap} 距过孔过远`,
        description: `${cap} 距最近过孔约 ${distance ?? '?'} mm${inductance ? `（约 ${inductance} nH 连接电感）` : ''}，会降低高频去耦效果。`,
        recommendation: `把过孔放在 ${cap} 焊盘旁边，并用短而宽的走线连接。`,
      }
    }
    case 'IO-001': {
      const ref = components[0] || component
      const powerOnly = /power-only/i.test(`${description} ${recommendation}`)
      if (powerOnly) {
        return {
          title: `连接器 ${ref} 附近无 EMI 滤波（电源专用）`,
          description: `${ref} 看起来是电源专用接口，25 mm 内没有磁珠、共模扼流圈或 ESD 保护。板级磁珠在较大直流电流下可能饱和。`,
          recommendation: '如需抑制线缆辐射，使用系统级共模扼流圈或屏蔽线，并保留 ESD 保护。',
        }
      }
      return {
        title: `连接器 ${ref} 附近缺少 EMI 滤波`,
        description: `${ref} 周围 25 mm 内未发现磁珠、共模扼流圈或 ESD 保护。未滤波的 I/O 线缆是辐射发射的主要来源。`,
        recommendation: `在 ${ref} 的信号线增加磁珠或共模扼流圈，并补充 ESD/TVS 保护。`,
      }
    }
    case 'IO-002': {
      const ref = components[0] || component
      const groundPins = numberFrom(/(\d+)\s+ground pin/i)
      const signalPins = numberFrom(/for\s+(\d+)\s+signal pins/i)
      return {
        title: `连接器 ${ref} 接地引脚不足`,
        description: `${ref} 只有 ${groundPins ?? '?'} 个接地引脚，对应 ${signalPins ?? '?'} 个信号引脚，回流与屏蔽能力不足。`,
        recommendation: `为 ${ref} 增加接地引脚，并把它们分散在信号引脚之间。`,
      }
    }
    case 'SW-001': {
      const ref = components[0] || component
      const frequency = numberFrom(/([\d.]+)\s*MHz/i)
      const harmonics = numberFrom(/(\d+)\s+harmonics/i)
      const band = textFrom(/(?:in the|in)\s+([\d\-]+\s*MHz)\s+band/i)
      return {
        title: `稳压器 ${ref} 的开关谐波落入测试频段`,
        description: `${ref}${value ? `（${value}）` : ''}开关频率约 ${frequency ?? '?'} MHz，在 ${band || '测试'} 频段内有 ${harmonics ?? '多'} 个谐波。开关节点与热回路会把谐波辐射到空间。`,
        recommendation: `缩小 ${ref} 的开关热回路面积，把输入电容紧贴 IC 放置；如器件支持，可启用扩频。`,
      }
    }
    case 'SW-002': {
      const ref = components[0] || component
      const swNet = nets[0] || textFrom(/net\s+(\S+)\s+has/i)
      const area = numberFrom(/([\d.]+)\s*mm²\s+total/i)
      return {
        title: `开关节点 ${swNet || ''} 铜面积过大`,
        description: `${ref} 的开关节点 ${swNet || ''} 铜面积约 ${area ?? '?'} mm²（本次只统计了走线铜面积，铺铜区域未计入）。大面积铜会像天线一样辐射开关噪声。`,
        recommendation: `把 ${swNet || '开关节点'} 的铜限制在连接 IC 与电感所需的最小范围，移除该网络的覆铜。`,
      }
    }
    case 'SW-003': {
      const ref = components[0] || component
      const area = numberFrom(/loop area\s*≈\s*([\d.]+)\s*mm²/i)
      return {
        title: `稳压器 ${ref} 输入热回路面积过大`,
        description: `${ref}${value ? `（${value}）` : ''}的输入热回路面积约 ${area ?? '?'} mm²，建议控制在 25 mm² 以内。回路越大，开关辐射越强。`,
        recommendation: '把输入电容、IC 与电感摆成紧凑三角形，缩短三者之间的走线。',
      }
    }
    case 'CK-001': {
      const net = nets[0] || component
      const percent = numberFrom(/([\d.]+)%\s+routed on outer/i)
      return {
        title: `时钟网络 ${net} 走在外层`,
        description: `时钟网络 ${net} 有 ${percent ?? '较大比例'}% 的走线在外层（微带），外层屏蔽不如内层带状线。`,
        recommendation: '条件允许时把时钟改到内层带状线。',
      }
    }
    case 'CK-002': {
      const net = nets[0] || component
      const length = numberFrom(/([\d.]+)\s*mm long/i)
      return {
        title: `时钟网络 ${net} 走线过长`,
        description: `时钟网络 ${net} 的走线长度约 ${length ?? '?'} mm。长时钟走线更容易把谐波辐射出去。`,
        recommendation: '缩短时钟走线，把时钟源靠近负载放置。',
      }
    }
    case 'CK-003': {
      const net = nets[0] || component
      const ref = components[0] || '连接器'
      const distance = numberFrom(/within\s+([\d.]+)\s*mm/i)
      return {
        title: `时钟网络 ${net} 靠近连接器 ${ref}`,
        description: `时钟网络 ${net} 经过 ${ref} 附近（约 ${distance ?? '?'} mm），谐波可能耦合到线缆并增加辐射。`,
        recommendation: `让 ${net} 远离 ${ref}，或在两者之间增加接地保护走线。`,
      }
    }
    case 'CK-004':
      return generic('晶振附近缺少接地覆铜')
    case 'VS-001': {
      const vias = numberFrom(/Board has\s+(\d+)\s+vias/i)
      const area = numberFrom(/across\s+([\d.]+)\s*mm²/i)
      const spacing = numberFrom(/~([\d.]+)\s*mm avg spacing/i)
      const required = numberFrom(/≤\s*([\d.]+)\s*mm spacing/i)
      const frequency = numberFrom(/\(([\d.]+)\s*MHz\)/i)
      return {
        title: '接地过孔缝合可能不足',
        description: `板上有 ${vias ?? '?'} 个过孔、面积约 ${area ?? '?'} mm²${spacing ? `（平均间距约 ${spacing} mm）` : ''}。对最高频率 ${frequency ?? '?'} MHz，λ/20 要求间距不超过 ${required ?? '?'} mm。`,
        recommendation: '在板边与连接器附近按 λ/20 间距增加接地缝合过孔。',
      }
    }
    case 'SU-001': {
      const match = /Adjacent signal layers:\s*([^,]+),\s*(\S+)/i.exec(title)
        || /Signal layers\s+(\S+)\s+and\s+(\S+)\s+are adjacent/i.exec(description)
      return {
        title: '相邻信号层之间缺少参考平面',
        description: `信号层 ${match?.[1] ?? '?'} 与 ${match?.[2] ?? '?'} 相邻且中间没有参考平面，会带来串扰和回流路径问题。`,
        recommendation: '在下一版考虑四层叠层，或调整层序，让每对信号层之间都有参考平面。',
      }
    }
    case 'SU-002':
      return {
        title: '信号层距参考平面过远',
        description: '信号层与最近参考平面的介质厚度偏大，耦合变弱、回路面积变大。',
        recommendation: '调整叠层，缩短信号层到参考平面的介质厚度。',
      }
    case 'SU-003':
      return {
        title: '电源/地平面间距过大',
        description: '电源平面与地平面之间的介质较厚，平面间电容偏小，高频去耦能力下降。',
        recommendation: '在电源/地平面之间使用更薄的介质。',
      }
    case 'EE-001':
      return {
        title: '板腔谐振频率估算',
        description: '板卡尺寸会形成 cavity 谐振，PDN 阻抗可能在这些频率附近升高。',
        recommendation: '在这些频率附近检查去耦电容的自谐振频率。',
      }
    case 'EE-002': {
      const ref = components[0] || component
      const frequency = numberFrom(/switching at\s+([\d.]+)\s*MHz/i)
      const duty = numberFrom(/duty\s*≈\s*([\d.]+)%/i)
      const flat = numberFrom(/flat to\s+([\d.]+)\s*MHz/i)
      const corner = numberFrom(/-20 dB\/dec to\s+([\d.]+)\s*MHz/i)
      return {
        title: `稳压器 ${ref} 谐波包络估算`,
        description: `${ref}${value ? `（${value}）` : ''}开关频率约 ${frequency ?? '?'} MHz、占空比约 ${duty ?? '?'}%。谐波包络在 ${flat ?? '?'} MHz 以下平坦，之后 -20 dB/dec，到 ${corner ?? '?'} MHz 以上变为 -40 dB/dec。`,
        recommendation: '缩小输入热回路面积可降低谐波包络；这是估算值，不是实测结果。',
      }
    }
    case 'DP-001': {
      const delta = numberFrom(/([\d.]+)\s*mm\s+length mismatch/i)
      const skew = numberFrom(/\(([\d.]+)\s*ps skew\)/i)
      const limit = numberFrom(/limit of\s+(\d+)\s*ps/i)
      return {
        title: '差分对长度失配',
        description: `差分对 ${netLabel} 长度失配约 ${delta ?? '?'} mm（约 ${skew ?? '?'} ps）${limit ? `，超过 ${limit} ps 限值` : ''}。失配会把差模信号转成共模辐射。`,
        recommendation: '用蛇形绕线把两条差分线长度匹配到限值以内。',
      }
    }
    case 'DP-002': {
      const skew = numberFrom(/([\d.]+)ps skew/i)
      const cm = numberFrom(/([\d.]+)mV CM voltage/i)
      const emission = numberFrom(/([\d.]+)\s*dBµV\/m/i)
      const limit = numberFrom(/limit:\s*([\d.]+)\s*dBµV\/m/i)
      const margin = numberFrom(/margin:\s*(-?[\d.]+)\s*dB/i)
      return {
        title: '差分对共模辐射风险',
        description: `差分对 ${netLabel} 的 ${skew ?? '?'} ps 失配产生约 ${cm ?? '?'} mV 共模电压，估算辐射 ${emission ?? '?'} dBµV/m${limit ? `（限值 ${limit} dBµV/m，余量 ${margin ?? '?'} dB）` : ''}。`,
        recommendation: '减小长度失配，或在连接器处增加共模扼流圈。',
      }
    }
    case 'DP-003':
      return {
        title: '差分对换层',
        description: `差分对 ${netLabel} 发生换层，换层处可能发生差模到共模转换。`,
        recommendation: '尽量让差分对在同一层走完；必须换层时在信号过孔附近增加接地缝合过孔。',
      }
    case 'DP-004': {
      const percent = numberFrom(/([\d.]+)%\s+routed on outer/i)
      return {
        title: '差分对走在外层',
        description: `差分对 ${netLabel} 有 ${percent ?? '?'}% 的走线在外层，外层屏蔽不如内层带状线。`,
        recommendation: '条件允许时把差分对改到内层。',
      }
    }
    case 'BE-001':
      return {
        title: '信号走线靠近板边',
        description: `网络 ${netLabel} 的走线距板边过近，板边缺少完整参考平面，容易形成缝隙天线。`,
        recommendation: '让信号走线远离板边，或在板边补充接地覆铜。',
      }
    case 'BE-002':
      return {
        title: '板边接地覆铜不完整',
        description: '接地覆铜没有连续覆盖板边，边缘辐射抑制不足。',
        recommendation: '在板边增加连续接地保护环，并用过孔缝合。',
      }
    case 'BE-003': {
      const ref = components[0] || component
      const vias = numberFrom(/area has\s+(\d+)\s+vias/i)
      const spacing = numberFrom(/~([\d.]+)\s*mm avg spacing/i)
      const frequency = numberFrom(/up to\s+([\d.]+)\s*MHz/i)
      return {
        title: `连接器 ${ref} 附近过孔缝合不足`,
        description: `${ref} 周围 10 mm 内约 ${vias ?? '?'} 个过孔${spacing ? `（平均间距约 ${spacing} mm）` : ''}。对最高频率 ${frequency ?? '?'} MHz，λ/20 要求的间距更小。`,
        recommendation: `在 ${ref} 周围按 λ/20 间距增加接地缝合过孔。`,
      }
    }
    case 'XT-001':
      return {
        title: '走线间距不满足 3H 规则',
        description: `网络 ${netLabel} 的走线间距小于 3 倍介质厚度，近端串扰可能增加。`,
        recommendation: '增大走线间距或插入接地保护走线。',
      }
    case 'EF-001': {
      const ref = components[0] || component
      const fsw = numberFrom(/switching at\s+([\d.]+)\s*MHz/i)
      const fc = numberFrom(/fc=\s*([\d.]+)\s*MHz/i)
      const ratio = numberFrom(/=\s*([\d.]+)×/i)
      return {
        title: `EMI 滤波器截止频率距 ${ref} 开关频率过近`,
        description: `${ref}${value ? `（${value}）` : ''}开关频率约 ${fsw ?? '?'} MHz，输入 LC 滤波器截止频率约 ${fc ?? '?'} MHz（比值约 ${ratio ?? '?'}×）。建议截止频率不高于开关频率的 1/5。`,
        recommendation: '增大滤波电感或电容，把截止频率降到开关频率的 1/5 以下。',
      }
    }
    case 'EF-002': {
      const ref = components[0] || component
      const fc = numberFrom(/fc=\s*([\d.]+)\s*MHz/i)
      const ratio = numberFrom(/ratio\s+([\d.]+)×/i)
      return {
        title: `EMI 输入滤波器验证通过（${ref}）`,
        description: `${ref} 的输入 LC 滤波器截止频率约 ${fc ?? '?'} MHz，相对开关频率约 ${ratio ?? '?'}×，衰减余量充足。`,
        recommendation: '输入 EMI 滤波器看起来足够，无需额外调整。',
      }
    }
    case 'ES-001': {
      const ref = components[0] || component
      const conn = components[1] || '连接器'
      const distance = numberFrom(/([\d.]+)\s*mm from/i)
      const overshoot = numberFrom(/~([\d.]+)V overshoot/i)
      return {
        title: `ESD 器件 ${ref} 距连接器 ${conn} 过远`,
        description: `${ref} 距 ${conn} 约 ${distance ?? '?'} mm${overshoot ? `，8 kV 静电放电时预 TVS 走线电感可能产生约 ${overshoot} V 过冲` : ''}。建议小于 10 mm。`,
        recommendation: `把 ${ref} 移近 ${conn}，缩短 ESD 电流路径。`,
      }
    }
    case 'ES-002': {
      const ref = components[0] || component
      const count = numberFrom(/(\d+)\s+ground via/i)
      return {
        title: `ESD 器件 ${ref} 附近接地过孔不足`,
        description: `${ref} 周围 3 mm 内只有 ${count ?? '0'} 个接地过孔。接地路径电感是 ESD 保护中最关键的寄生参数。`,
        recommendation: `在 ${ref} 的接地焊盘旁增加多个接地过孔。`,
      }
    }
    case 'TH-001': {
      const cap = components[0] || component
      const percent = numberFrom(/([\d.]+)%\s+effective capacitance/i)
      return {
        title: `输出电容 ${cap} 可能存在直流偏置降容`,
        description: `${cap} 在直流偏置下有效容量约为标称值的 ${percent ?? '?'}%，可能让去耦网络出现缺口。`,
        recommendation: '改用更大封装、更高耐压或 C0G/NP0 介质，或并联更多电容。',
      }
    }
    case 'TH-002': {
      const ref = components[0] || component
      const reg = components[1] || '开关稳压器'
      const distance = numberFrom(/([\d.]+)\s*mm from/i)
      return {
        title: `磁珠 ${ref} 靠近 ${reg}`,
        description: `${ref} 距 ${reg} 约 ${distance ?? '?'} mm。磁珠磁导率随温度下降，高温下滤波阻抗可能降低 30–50%。`,
        recommendation: '确认磁珠的温度额定值，或把它移离热源。',
      }
    }
    case 'SH-001': {
      const ref = components[0] || component
      const aperture = numberFrom(/~(\d+)mm aperture/i)
      const slot = numberFrom(/resonance at\s+([\d.]+)\s*GHz/i)
      const frequencies = textFrom(/sources at\s+([^.]*)\./i)
      return {
        title: `连接器 ${ref} 开口谐振与辐射源重合`,
        description: `${ref} 的开口约 ${aperture ?? '?'} mm，对应谐振频率约 ${slot ?? '?'} GHz${frequencies ? `，与板上辐射源 ${frequencies} 接近` : ''}。开口可能成为有效辐射源。`,
        recommendation: '加强该连接器周围的屏蔽，或使用带屏蔽的连接器。',
      }
    }
    case 'PD-001': {
      const ref = components[0] || component
      const rail = nets[0] || component
      const target = numberFrom(/target impedance\s+([\d.]+)Ω/i)
      const peak = numberFrom(/([\d.]+)\s*MHz\s*\(([\d.]+)Ω\)/i)
      return {
        title: `${rail} PDN 反谐振超过目标阻抗`,
        description: `${ref} 的 ${rail} 电源网络目标阻抗 ${target ?? '?'} Ω，但反谐振峰超过目标${peak ? `（约 ${peak} MHz）` : ''}，可能引起电源噪声。`,
        recommendation: '增加靠近负载的去耦电容，或调整电容组合以压低反谐振峰。',
      }
    }
    case 'PD-002': {
      const rail = nets[0] || components[0] || component
      const target = numberFrom(/target impedance\s+([\d.]+)Ω/i)
      return {
        title: `${rail} PDN 反谐振在目标内`,
        description: `${rail} 电源网络的反谐振均在目标阻抗 ${target ?? '?'} Ω 以内。`,
        recommendation: '当前去耦网络满足解析目标阻抗，无需调整。',
      }
    }
    case 'PD-003':
      return {
        title: '分布式 PDN 阻抗超标',
        description: `负载 IC 处的 PDN 阻抗因走线寄生而升高，可能超过目标。`,
        recommendation: '在负载 IC 附近增加局部去耦电容。',
      }
    case 'PD-004':
      return {
        title: '上游 PDN 受下游开关瞬态影响',
        description: '下游开关稳压器会在上游电源轨上产生反射瞬态，增加电源纹波。',
        recommendation: '在下游稳压器输入端增加 10–22 µF 体电容与 100 nF MLCC。',
      }
    case 'RP-001':
      return {
        title: '换层处缺少接地缝合过孔',
        description: `网络 ${netLabel} 换层时附近没有接地缝合过孔，回流电流需要绕行，形成回路天线。`,
        recommendation: '在每个信号过孔旁增加接地缝合过孔。',
      }
    case 'ML-001': {
      const ind = components[0] || component
      const sensitive = components[1] || '敏感电路'
      const distance = numberFrom(/([\d.]+)mm from/i)
      return {
        title: `开关电感 ${ind} 漏磁靠近 ${sensitive}`,
        description: `开关电感 ${ind} 距 ${sensitive} 约 ${distance ?? '?'} mm，未屏蔽电感的漏磁可能把开关噪声注入高阻抗模拟电路。`,
        recommendation: '改用屏蔽电感，或把电感与敏感电路拉开到 15 mm 以上。',
      }
    }
    default:
      return {
        title: `EMC 规则 ${rule} 发现问题`,
        description: `上游 EMC 规则 ${rule} 判定存在风险；涉及元件：${component}；网络：${netLabel}；适用标准：${standardLabel}。`,
        recommendation: '请结合完整报告与原始上游结果人工复核。',
      }
  }
}

function emcExecutionErrorFinding(reason) {
  return {
    detector: 'emc',
    rule_id: 'EM-000',
    source_rule_id: null,
    category: 'analysis_error',
    kind: 'issue',
    severity: 'must_fix',
    confidence: 'deterministic',
    evidence_source: 'emc',
    summary: 'EMC 上游分析执行失败',
    title: 'EMC 上游分析执行失败',
    description: `上游 analyze_emc.py 未能完成：${reason}。这是分析执行错误，不是 EMC 设计结论。`,
    evidence: `上游 analyze_emc.py 未能完成：${reason}。`,
    recommendation: '检查 Python 环境与 KICAD_HAPPY_EMC_SCRIPTS；修复后重跑 --emc。',
    components: [],
    nets: [],
    pins: [],
    source: 'emc',
  }
}

// ---------------------------------------------------------------------------
// 上游定位与辅助
// ---------------------------------------------------------------------------

function resolveEmcScriptsDir() {
  // 显式 KICAD_HAPPY_EMC_SCRIPTS 优先且不回退：用户指定了错误位置时
  // 必须得到明确的 not_evaluated，而不是悄悄使用另一份上游脚本。
  const explicit = process.env.KICAD_HAPPY_EMC_SCRIPTS?.trim()
  if (explicit) {
    const resolved = explicit.replace(/[\\/]+$/u, '')
    return existsSync(join(resolved, 'analyze_emc.py')) ? resolved : null
  }
  const candidates = []
  const kicadScripts = process.env.KICAD_HAPPY_SCRIPTS?.trim() || DEFAULT_KICAD_HAPPY_SCRIPTS
  candidates.push(join(kicadScripts, '..', '..', 'emc', 'scripts'))
  candidates.push(join(VENDORED_ROOT, 'emc', 'scripts'))
  candidates.push('D:/Tools/kicad-happy/skills/emc/scripts')
  for (const candidate of candidates) {
    try {
      const resolved = candidate.replace(/[\\/]+$/u, '')
      if (existsSync(join(resolved, 'analyze_emc.py'))) return resolved
    } catch {
      // 继续尝试下一个候选路径
    }
  }
  return null
}

function pythonOptions(cwd) {
  return {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: MAX_BUFFER,
    timeout: PYTHON_TIMEOUT_MS,
  }
}

function validateUpstream(value) {
  if (!isPlainObject(value)) throw new Error('输出必须是对象')
  if (value.analyzer_type !== 'emc') throw new Error('缺少 analyzer_type=emc')
  if (!Array.isArray(value.findings)) throw new Error('缺少 findings 数组')
  if (!isPlainObject(value.summary)) throw new Error('缺少 summary 对象')
}

function artifactPaths(emcDir, outDir) {
  const relative = (path) => {
    if (!path) return null
    const base = outDir && path.startsWith(outDir) ? outDir : null
    if (!base) return path
    return path.slice(base.length).replace(/^[\\/]+/u, '').replace(/\\/gu, '/')
  }
  return {
    schematic: relative(join(emcDir, 'schematic.json')),
    pcb: relative(join(emcDir, 'pcb.json')),
    raw: relative(join(emcDir, 'emc-raw.json')),
    inputRaw: relative(join(emcDir, 'raw.json')),
  }
}

function isConnectorFootprint(footprint) {
  const ref = scalarText(footprint.reference)
  const value = scalarText(footprint.value).toLowerCase()
  const library = `${scalarText(footprint.library)} ${scalarText(footprint.lib_id)}`.toLowerCase()
  if (/^(J|P|CN)\d/u.test(ref)) {
    if (['test', 'tp', 'jumper', 'solder'].some(keyword => value.includes(keyword))) return false
    if (ref.toUpperCase().startsWith('JP') || ref.toUpperCase().startsWith('SJ')) return false
    return true
  }
  return library.includes('connector') || library.includes('conn_') || library.includes('usb')
}

function isGroundNet(name) {
  if (!name) return false
  let net = String(name)
  if (net.includes('/')) net = net.split('/').pop()
  const upper = net.toUpperCase()
  if (['GND', 'VSS', 'AGND', 'DGND', 'PGND', 'GNDPWR', 'GNDA', 'GNDD', 'SGND', 'COM', '0V'].includes(upper)) return true
  if (/^\+?0+V(?!\d)([A-Z_][A-Z0-9_]*)?$/u.test(upper)) return true
  return upper.startsWith('GND') || upper.endsWith('GND') || upper.startsWith('VSS')
}

function isPowerOrGroundName(name) {
  if (!name) return false
  const upper = String(name).toUpperCase()
  if (['GND', 'VSS', 'AGND', 'DGND', 'PGND', 'VCC', 'VDD', 'AVCC', 'AVDD', 'DVCC', 'DVDD'].includes(upper)) return true
  return upper.startsWith('GND') || upper.startsWith('VSS') || upper.startsWith('VCC')
    || upper.startsWith('VDD') || upper.startsWith('+') || upper.endsWith('GND')
    || upper.endsWith('VSS') || (upper.includes('V') && /\d/u.test(upper))
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

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function stringList(value) {
  if (!Array.isArray(value)) return []
  return value.map(scalarText).filter(Boolean)
}

function dedupe(values) {
  return [...new Set(values.map(value => String(value ?? '').trim()).filter(Boolean))]
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}
