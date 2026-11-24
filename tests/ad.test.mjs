// tests/ad.test.mjs
// AD 原生检查：可用性探测、stdio 桥、ERC/DRC/库归一化与 CLI 开关语义。
//
// 全部测试使用 tests/fixtures/ad-mcp-stub（一个只讲 stdio 协议、返回固定
// 结果的 MCP 服务器），不需要 Altium Designer。需要真实 AD 的路径在
// docs/p6-ad-report.md 中单独记录。
import test from 'node:test'
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  detectAdAvailability,
  discoverLibraries,
  runNativeChecks,
} from '../.agents/skills/ad-happy/scripts/ad/ad.mjs'
import { parsePcb } from '../.agents/skills/ad-happy/scripts/pcb.mjs'
import { parseSch } from '../.agents/skills/ad-happy/scripts/sch.mjs'

const testsDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testsDir, '..')
const projectDir = join(testsDir, 'fixtures/Student-DCDC-Buck-Converter')
const projectPath = join(projectDir, 'DCDC Buck Converter.PrjPcb')
const boardPath = join(projectDir, 'PCB4 (Final Design).PcbDoc')
const schematicPath = join(projectDir, 'SCH1_Main.SchDoc')
const stubServer = join(testsDir, 'fixtures/ad-mcp-stub')
const bridge = join(repoRoot, '.agents/skills/ad-happy/scripts/ad/mcp_client.py')
const analyze = join(repoRoot, '.agents/skills/ad-happy/scripts/analyze.mjs')

function freshDir(prefix = 'ad-happy-ad-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function hasChinese(text) {
  return /[一-鿿]/u.test(String(text ?? ''))
}

function stubEnv(overrides = {}) {
  return {
    ...process.env,
    AD_HAPPY_AD_MCP_SERVER: stubServer,
    AD_HAPPY_AD_SKIP_PROCESS_CHECK: '1',
    ...overrides,
  }
}

function runAnalyze(args, { env = {} } = {}) {
  return spawnSync(process.execPath, [analyze, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 180000,
  })
}

function fixtures() {
  return {
    schematic: parseSch(schematicPath),
    pcbSnapshot: parsePcb(boardPath),
  }
}

// ---------------------------------------------------------------------------
// 可用性
// ---------------------------------------------------------------------------

test('detectAdAvailability：桩服务器可用，返回服务端与 Python 路径', () => {
  const availability = detectAdAvailability({ env: stubEnv() })
  assert.equal(availability.available, true, availability.reason)
  assert.equal(availability.code, 'ok')
  assert.ok(availability.serverPath.toLowerCase().includes('ad-mcp-stub'))
  assert.ok(availability.python)
  assert.equal(availability.altiumRunning, true)
  assert.equal(availability.processCheck, 'skipped')
})

test('detectAdAvailability：服务端缺失时不可用，原因与前提为中文', () => {
  const empty = freshDir('ad-happy-ad-empty-')
  const availability = detectAdAvailability({
    env: { ...process.env, AD_HAPPY_AD_MCP_SERVER: empty },
    skipProcessCheck: true,
  })
  assert.equal(availability.available, false)
  assert.equal(availability.code, 'server_missing')
  assert.ok(hasChinese(availability.reason))
  assert.ok(availability.reason.includes('server/main.py'))
  assert.ok(availability.prerequisites.some(item => hasChinese(item)))
})

test('detectAdAvailability：非 Windows 平台标记 unsupported_platform', () => {
  const availability = detectAdAvailability({
    env: stubEnv(),
    platform: 'linux',
  })
  assert.equal(availability.available, false)
  assert.equal(availability.code, 'unsupported_platform')
  assert.ok(hasChinese(availability.reason))
})

// ---------------------------------------------------------------------------
// 桥接与归一化
// ---------------------------------------------------------------------------

test('runNativeChecks：桩服务器返回 ERC/DRC/库结果，归一化为 AD- finding', () => {
  const outDir = freshDir('ad-happy-ad-run-')
  const { schematic, pcbSnapshot } = fixtures()
  const result = runNativeChecks({
    projectPath,
    boardPath,
    libraries: discoverLibraries(projectDir, [
      { kind: 'lib', path: join(projectDir, 'SCH_Lib.SchLib') },
      { kind: 'lib', path: join(projectDir, 'PCB_Lib.PcbLib') },
    ]),
    schematic,
    pcbSnapshot,
    outDir,
    env: stubEnv(),
  })

  assert.equal(result.coverage.status, 'found')
  assert.equal(result.coverage.available, true)
  assert.equal(result.coverage.checks.erc.status, 'found')
  assert.equal(result.coverage.checks.drc.status, 'found')
  assert.equal(result.coverage.checks.library.status, 'pass')
  assert.equal(result.coverage.erc.total, 2)
  assert.equal(result.coverage.drc.violationCount, 2)
  assert.ok(result.coverage.counts.libraries.matchedSymbols >= 1)
  assert.ok(result.coverage.counts.libraries.matchedFootprints >= 1)

  const ids = result.findings.map(finding => finding.rule_id)
  assert.ok(ids.includes('AD-ERC-001'))
  assert.ok(ids.includes('AD-ERC-002'))
  assert.equal(ids.filter(id => id === 'AD-DRC-001').length, 2)
  for (const finding of result.findings) {
    assert.match(finding.rule_id, /^AD-/u)
    assert.equal(finding.source, 'altium-native')
    assert.ok(hasChinese(finding.title), `标题不是中文：${finding.title}`)
    assert.ok(hasChinese(finding.description), `描述不是中文：${finding.description}`)
  }
  // ERC 警告的类型被翻译；详情保留原生文本。
  const ercWarning = result.findings.find(finding => finding.rule_id === 'AD-ERC-002')
  assert.ok(ercWarning.title.includes('对象未对齐网格'))
  assert.ok(ercWarning.components.includes('C1'))

  // 请求与原始结果写入输出目录的 ad/，不写源工程。
  for (const name of [
    'inventory-request.json',
    'inventory-result.json',
    'dumps-request.json',
    'dumps-result.json',
  ]) {
    assert.ok(existsSync(join(outDir, 'ad', name)), `缺少 ad/${name}`)
  }
  assert.equal(existsSync(join(projectDir, 'ad')), false, '不得向源工程写入 ad/')
})

test('runNativeChecks：DRC 未运行时不伪造违规，标记 failed 并产生 AD-DRC-000', () => {
  const outDir = freshDir('ad-happy-ad-drcfail-')
  const { schematic, pcbSnapshot } = fixtures()
  const result = runNativeChecks({
    projectPath,
    boardPath,
    libraries: [],
    schematic,
    pcbSnapshot,
    outDir,
    env: stubEnv({ STUB_AD_DRC_FAIL: '1' }),
  })

  assert.equal(result.coverage.checks.drc.status, 'failed')
  assert.equal(result.coverage.checks.drc.ran, false)
  assert.equal(result.coverage.drc.violationCount, 0)
  const ids = result.findings.map(finding => finding.rule_id)
  assert.ok(ids.includes('AD-DRC-000'))
  assert.ok(!ids.includes('AD-DRC-001'), 'DRC 未运行时不得产生违规 finding')
  // ERC 与库检查仍然保留。
  assert.ok(ids.includes('AD-ERC-001'))
  assert.equal(result.coverage.status, 'failed')
})

test('runNativeChecks：库符号缺引脚 / 封装缺焊盘时产生 AD-LIB-001/002', () => {
  const outDir = freshDir('ad-happy-ad-lib-')
  const { schematic, pcbSnapshot } = fixtures()
  const result = runNativeChecks({
    projectPath,
    boardPath,
    libraries: [
      { path: join(projectDir, 'SCH_Lib.SchLib'), kind: 'schlib' },
      { path: join(projectDir, 'PCB_Lib.PcbLib'), kind: 'pcblib' },
    ],
    schematic,
    pcbSnapshot,
    outDir,
    env: stubEnv({
      STUB_AD_MISSING_SYMBOL_PIN: '6',
      STUB_AD_MISSING_PAD: '2',
    }),
  })

  const symbol = result.findings.find(finding => finding.rule_id === 'AD-LIB-001')
  assert.ok(symbol, '缺少 AD-LIB-001')
  assert.equal(symbol.source, 'altium-native')
  assert.ok(symbol.components.includes('IC1'))
  assert.ok(symbol.pins.some(pin => pin.component === 'IC1' && pin.number === '6'))
  assert.ok(symbol.description.includes('引脚 6'))

  const footprint = result.findings.find(finding => finding.rule_id === 'AD-LIB-002')
  assert.ok(footprint, '缺少 AD-LIB-002')
  assert.ok(footprint.components.includes('IC1'))
  assert.ok(footprint.description.includes('焊盘 2'))

  assert.equal(result.coverage.checks.library.status, 'found')
  assert.equal(result.coverage.counts.libraries.mismatches >= 2, true)
})

test('runNativeChecks：库明细被截断时降级为 partial，不报 pass', () => {
  const outDir = freshDir('ad-happy-ad-truncated-')
  const { schematic, pcbSnapshot } = fixtures()
  const result = runNativeChecks({
    projectPath,
    boardPath,
    libraries: [
      { path: join(projectDir, 'SCH_Lib.SchLib'), kind: 'schlib' },
      { path: join(projectDir, 'PCB_Lib.PcbLib'), kind: 'pcblib' },
    ],
    schematic,
    pcbSnapshot,
    outDir,
    env: stubEnv(),
    maxLibraryDumps: 1,
  })

  assert.equal(result.coverage.checks.library.status, 'partial')
  assert.equal(result.coverage.checks.symbol_libraries.status, 'partial')
  assert.equal(result.coverage.checks.footprint_libraries.status, 'partial')
  assert.equal(result.coverage.counts.libraries.truncatedLibraries, 2)
  for (const library of result.coverage.libraries.filter(entry => entry.kind !== 'intlib')) {
    assert.equal(library.status, 'partial', `${library.name} 不应因截断而通过`)
    assert.equal(library.truncated, true)
    assert.ok(library.reasons.some(reason => reason.includes('只读取前 1 个')))
  }
  // 截断是覆盖不足，不是执行失败；不应产生 AD-LIB-000。
  assert.ok(!result.findings.some(finding => finding.rule_id === 'AD-LIB-000'))
})

test('runNativeChecks：未匹配到库符号/封装的元件计入 partial 并列出', () => {
  const outDir = freshDir('ad-happy-ad-unmatched-')
  const { schematic, pcbSnapshot } = fixtures()
  const result = runNativeChecks({
    projectPath,
    boardPath,
    libraries: [
      { path: join(projectDir, 'SCH_Lib.SchLib'), kind: 'schlib' },
      { path: join(projectDir, 'PCB_Lib.PcbLib'), kind: 'pcblib' },
    ],
    schematic,
    pcbSnapshot,
    outDir,
    env: stubEnv({
      STUB_AD_SYMBOL_EXCLUDE: '10 kOhms',
      STUB_AD_FOOTPRINT_EXCLUDE: 'CAP 0805_2012',
    }),
  })

  const symbolLibrary = result.coverage.libraries.find(library => library.kind === 'schlib')
  const footprintLibrary = result.coverage.libraries.find(library => library.kind === 'pcblib')
  assert.ok(symbolLibrary.unmatchedComponents.includes('R2'))
  assert.ok(footprintLibrary.unmatchedComponents.includes('C1'))
  assert.ok(footprintLibrary.unmatchedComponents.includes('C2'))
  assert.ok(symbolLibrary.reasons.some(reason => reason.includes('R2')))
  assert.ok(footprintLibrary.reasons.some(reason => reason.includes('C1')))
  assert.equal(symbolLibrary.status, 'partial')
  assert.equal(footprintLibrary.status, 'partial')
  assert.equal(result.coverage.counts.libraries.unmatchedSymbols, 1)
  assert.equal(result.coverage.counts.libraries.unmatchedFootprints, 2)
  assert.equal(result.coverage.checks.library.status, 'partial')
  // 未匹配是覆盖不足，不应产生引脚/焊盘不一致的 finding。
  assert.ok(!result.findings.some(finding => finding.rule_id === 'AD-LIB-001'))
  assert.ok(!result.findings.some(finding => finding.rule_id === 'AD-LIB-002'))
})

test('runNativeChecks：库工具超时不会挂起，后续调用跳过并标记失败', () => {
  const outDir = freshDir('ad-happy-ad-timeout-')
  const { schematic, pcbSnapshot } = fixtures()
  const started = Date.now()
  const result = runNativeChecks({
    projectPath,
    boardPath,
    libraries: [{ path: join(projectDir, 'SCH_Lib.SchLib'), kind: 'schlib' }],
    schematic,
    pcbSnapshot,
    outDir,
    env: stubEnv({
      STUB_AD_SLEEP_MS: '5000',
      AD_HAPPY_AD_TOOL_TIMEOUT_MS: '800',
    }),
  })
  const elapsed = Date.now() - started

  assert.ok(elapsed < 30000, `超时测试耗时过长：${elapsed} ms`)
  assert.equal(result.coverage.checks.erc.status, 'failed')
  assert.ok(result.findings.some(finding => finding.rule_id === 'AD-ERC-000'))
  // 超时后不得继续产出 DRC/库结论。
  assert.ok(!result.findings.some(finding => finding.rule_id === 'AD-DRC-001'))
  assert.ok(!result.findings.some(finding => finding.rule_id === 'AD-LIB-001'))
})

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test('CLI 不带 --with-ad：AD 检查 not_evaluated、无 AD finding、报告无原生章节', () => {
  const outDir = freshDir('ad-happy-ad-offline-')
  const result = runAnalyze(['--project', projectDir, '--out', outDir])
  assert.equal(result.status, 0, result.stderr)

  const summary = readJson(join(outDir, 'summary.json'))
  assert.equal(summary.native.requested, false)
  assert.equal(summary.native.status, 'not_evaluated')
  assert.equal(summary.rules.native_erc, 'not_evaluated')
  assert.equal(summary.rules.native_drc, 'not_evaluated')
  assert.equal(summary.rules.native_library, 'not_evaluated')

  const findings = readJson(join(outDir, 'findings.json'))
  assert.ok(!findings.some(finding => String(finding.rule_id).startsWith('AD-')))
  const report = readFileSync(join(outDir, 'report.html'), 'utf8')
  assert.ok(!report.includes('id="native"'), '默认报告不应渲染 Altium 原生检查章节')
  assert.equal(existsSync(join(outDir, 'ad.json')), false)
})

test('CLI --with-ad + 桩服务器：合并 AD finding、写出 ad.json 与报告章节', () => {
  const outDir = freshDir('ad-happy-ad-cli-')
  const result = runAnalyze(
    ['--project', projectDir, '--out', outDir, '--with-ad'],
    { env: stubEnv() },
  )
  assert.equal(result.status, 0, result.stderr)

  const summary = readJson(join(outDir, 'summary.json'))
  assert.equal(summary.native.requested, true)
  assert.equal(summary.native.available, true)
  assert.equal(summary.native.status, 'found')
  assert.equal(summary.native.erc.total, 2)
  assert.equal(summary.native.drc.violationCount, 2)
  assert.equal(summary.rules.native_erc, 'found')
  assert.equal(summary.rules.native_drc, 'found')
  assert.equal(summary.rules.native_library, 'pass')
  assert.equal(summary.native.artifact, 'ad.json')

  const findings = readJson(join(outDir, 'findings.json'))
  const adFindings = findings.filter(finding => String(finding.rule_id).startsWith('AD-'))
  assert.ok(adFindings.length >= 4, '缺少 AD finding')
  for (const finding of adFindings) {
    assert.equal(finding.source, 'altium-native')
    assert.match(finding.rule_id, /^AD-/u)
    assert.ok(hasChinese(finding.title))
    assert.ok(hasChinese(finding.description))
  }

  assert.ok(existsSync(join(outDir, 'ad.json')), '缺少 ad.json')
  const ad = readJson(join(outDir, 'ad.json'))
  assert.equal(ad.requested, true)
  assert.equal(ad.coverage.status, 'found')
  assert.ok(ad.bridge.inventory.ok)
  assert.ok(ad.bridge.dumps.ok)

  const report = readFileSync(join(outDir, 'report.html'), 'utf8')
  assert.ok(report.includes('id="native"'))
  assert.ok(report.includes('Altium 原生检查'))
  assert.ok(report.includes('Altium ERC'))
  assert.ok(report.includes('Altium DRC'))
  assert.ok(report.includes('库覆盖与核对'))
  assert.ok(report.includes('AD-ERC-001'))
  assert.ok(report.includes('原生检查发现'))
  assert.ok(report.includes('Altium 原生检查'), '问题清单应显示来源标签')
})

test('CLI --with-ad 库明细截断：rules.native_library=partial 且报告提示覆盖不足', () => {
  const outDir = freshDir('ad-happy-ad-cli-truncated-')
  const result = runAnalyze(
    ['--project', projectDir, '--out', outDir, '--with-ad'],
    { env: stubEnv({ AD_HAPPY_AD_MAX_LIBRARY_DUMPS: '1' }) },
  )
  assert.equal(result.status, 3, result.stderr)

  const summary = readJson(join(outDir, 'summary.json'))
  assert.equal(summary.rules.native_library, 'partial')
  assert.equal(summary.native.checks.library.status, 'partial')
  assert.ok(summary.native.counts.libraries.truncatedLibraries >= 2)
  assert.equal(summary.status, 'partial')

  const report = readFileSync(join(outDir, 'report.html'), 'utf8')
  assert.ok(report.includes('id="native-library-coverage"'))
  assert.ok(report.includes('不能读成全部通过'))
})

test('CLI --with-ad 工具失败：退出码 3，失败可见且不伪造 DRC 违规', () => {
  const outDir = freshDir('ad-happy-ad-cli-drcfail-')
  const result = runAnalyze(
    ['--project', projectDir, '--out', outDir, '--with-ad'],
    { env: stubEnv({ STUB_AD_DRC_FAIL: '1' }) },
  )
  assert.equal(result.status, 3, result.stderr)

  const summary = readJson(join(outDir, 'summary.json'))
  assert.equal(summary.rules.native_drc, 'failed')
  assert.equal(summary.native.status, 'failed')
  const findings = readJson(join(outDir, 'findings.json'))
  const ids = findings.map(finding => finding.rule_id)
  assert.ok(ids.includes('AD-DRC-000'))
  assert.ok(!ids.includes('AD-DRC-001'))
  const manifest = readJson(join(outDir, 'manifest.json'))
  assert.equal(manifest.stages.native, 'failed')
  assert.ok(manifest.errors.some(error => error.stage === 'native'))
})

test('CLI --with-ad 不可用：退出码 2、中文原因、不创建输出目录', () => {
  const emptyServer = freshDir('ad-happy-ad-empty-server-')
  const parent = freshDir('ad-happy-ad-unavailable-')
  const outDir = join(parent, 'run')
  const result = runAnalyze(
    ['--project', projectDir, '--out', outDir, '--with-ad'],
    { env: { ...process.env, AD_HAPPY_AD_MCP_SERVER: emptyServer } },
  )

  assert.equal(result.status, 2)
  assert.match(result.stderr, /深度模式/)
  assert.match(result.stderr, /AD-MCP/)
  assert.ok(hasChinese(result.stderr))
  assert.equal(existsSync(outDir), false, 'AD 不可用时不得创建输出目录')
})

test('MCP 桥：请求 JSON 不合法时返回结构化失败而不是挂起', () => {
  const result = spawnSync(
    'python',
    ['-B', '-X', 'utf8', bridge],
    {
      cwd: repoRoot,
      input: 'not json',
      encoding: 'utf8',
      timeout: 30000,
    },
  )
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.ok, false)
  assert.equal(payload.phase, 'request')
  assert.ok(payload.reason.includes('JSON'))
  assert.deepEqual(payload.calls, {})
})

test('MCP 桥：服务端入口缺失时返回结构化失败', () => {
  const outDir = freshDir('ad-happy-ad-bridge-')
  const requestPath = join(outDir, 'request.json')
  writeFileSync(requestPath, `${JSON.stringify({
    server: {
      python: 'python',
      main: join(outDir, 'missing-main.py'),
    },
    calls: [{ id: 'erc', tool: 'get_erc_violations', arguments: {} }],
  }, null, 2)}\n`, 'utf8')

  const result = spawnSync(
    'python',
    ['-B', '-X', 'utf8', bridge, '--request', requestPath],
    { cwd: repoRoot, encoding: 'utf8', timeout: 30000 },
  )
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.ok, false)
  assert.equal(payload.phase, 'request')
  assert.ok(payload.reason.includes('不存在'))
})

test('discoverLibraries：只把 .SchLib/.PcbLib/.IntLib 纳入清单，并去重', () => {
  const libraries = discoverLibraries(projectDir, [
    { kind: 'lib', path: join(projectDir, 'SCH_Lib.SchLib') },
    { kind: 'lib', path: join(projectDir, 'PCB_Lib.PcbLib') },
    { kind: 'lib', path: join(projectDir, 'DCDC Buck Converter.IntLib') },
    { kind: 'lib', path: join(projectDir, 'SCH_Lib.SchLib') },
  ])
  const names = libraries.map(library => library.name).sort()
  assert.deepEqual(names, [
    'DCDC Buck Converter.IntLib',
    'PCB_Lib.PcbLib',
    'SCH_Lib.SchLib',
  ])
  assert.ok(libraries.every(library => library.exists))
  assert.ok(libraries.every(library => resolve(library.path).startsWith(resolve(projectDir))))
})
