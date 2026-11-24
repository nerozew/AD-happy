// tests/spice.test.mjs
// SPICE 仿真：仿真器检测、--spice 分支、上游调用、finding 与报告章节。
//
// 本机不需要安装任何 SPICE 仿真器：测试用一个「假 ngspice」脚本
// （Windows 为 .cmd，POSIX 为 sh 脚本）走通「仿真器可用」分支；
// 该脚本只把测试台里的预期值回写为测量结果，是明确的测试替身。
import test from 'node:test'
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  detectSimulators,
  localizeSimulationNote,
  probeSimulatorVersion,
  runSpice,
  simulatorInstallHints,
} from '../.agents/skills/ad-happy/scripts/spice.mjs'
import { renderReport } from '../.agents/skills/ad-happy/scripts/report.mjs'

const testsDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testsDir, '..')
const fixtureProject = join(testsDir, 'fixtures/Student-DCDC-Buck-Converter')
const analyze = join(repoRoot, '.agents/skills/ad-happy/scripts/analyze.mjs')
const isWindows = process.platform === 'win32'

function freshDir(prefix = 'ad-happy-spice-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function runAnalyze(args, { env = {} } = {}) {
  return spawnSync(process.execPath, [analyze, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 180000,
  })
}

// 测试替身：把上游测试台 echo 命令里的 expected 回写为测量值。
// SPICE_STUB_ERROR_PCT 可注入偏差；SPICE_STUB_FAIL=1 模拟仿真失败。
const STUB_SOURCE = `const fs = require('node:fs')
const args = process.argv.slice(2)
const version = process.env.SPICE_STUB_VERSION || 'ngspice-99-stub'
if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write(version + '\\n')
  process.exit(0)
}
if (process.env.SPICE_STUB_FAIL === '1') {
  process.stderr.write('stub: synthetic simulator failure\\n')
  process.exit(2)
}
const index = args.indexOf('-b')
if (index === -1 || !args[index + 1]) {
  process.stderr.write('stub: missing -b <netlist>\\n')
  process.exit(2)
}
const netlist = fs.readFileSync(args[index + 1], 'utf8')
const line = netlist.split(/\\r?\\n/).find(candidate => /^\\s*echo\\s+"/.test(candidate))
if (!line) {
  process.stderr.write('stub: no echo line in netlist\\n')
  process.exit(2)
}
const match = /^\\s*echo\\s+"(.*)"\\s*>\\s*(.+?)\\s*$/.exec(line)
if (!match) {
  process.stderr.write('stub: cannot parse echo line\\n')
  process.exit(2)
}
const payload = match[1]
const outPath = match[2]
const literals = {}
for (const token of payload.split(/\\s+/)) {
  const eq = token.indexOf('=')
  if (eq < 0) continue
  const key = token.slice(0, eq)
  const value = token.slice(eq + 1)
  if (!value.startsWith('$&')) literals[key] = value
}
const expected = literals.expected || '0'
const injected = process.env.SPICE_STUB_ERROR_PCT
const written = []
for (const token of payload.split(/\\s+/)) {
  const eq = token.indexOf('=')
  if (eq < 0) continue
  const key = token.slice(0, eq)
  const value = token.slice(eq + 1)
  if (!value.startsWith('$&')) {
    written.push(key + '=' + value)
    continue
  }
  if (key.toLowerCase().includes('error')) {
    written.push(key + '=' + (injected || '0'))
  } else if (injected) {
    written.push(key + '=' + (Number(expected) * (1 + Number(injected) / 100)).toPrecision(8))
  } else {
    written.push(key + '=' + expected)
  }
}
fs.writeFileSync(outPath, written.join(' ') + '\\n')
process.exit(0)
`

function writeStubSimulator(dir, name = 'ngspice') {
  mkdirSync(dir, { recursive: true })
  const stubJs = join(dir, 'stub-sim.cjs')
  writeFileSync(stubJs, STUB_SOURCE, 'utf8')
  if (isWindows) {
    const cmdPath = join(dir, `${name}.cmd`)
    writeFileSync(
      cmdPath,
      `@echo off\r\n"${process.execPath}" "%~dp0stub-sim.cjs" %*\r\n`,
      'utf8',
    )
    return cmdPath
  }
  const scriptPath = join(dir, name)
  writeFileSync(
    scriptPath,
    `#!/bin/sh\nexec "${process.execPath}" "${stubJs}" "$@"\n`,
    { mode: 0o755 },
  )
  return scriptPath
}

function stubEnv(stubPath, extra = {}) {
  const dir = dirname(stubPath)
  return {
    ...process.env,
    PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
    // 显式指定同一个替身，避免上游在自己的 PATH 里选到别的仿真器。
    NGSPICE_PATH: stubPath,
    SPICE_SIMULATOR: 'ngspice',
    ...extra,
  }
}

function detectionEnv(dir, extra = {}) {
  return {
    ...process.env,
    PATH: dir,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    PROGRAMFILES: dir,
    'PROGRAMFILES(X86)': dir,
    LOCALAPPDATA: dir,
    ...extra,
  }
}

function voltageDividerCircuit() {
  return {
    detector: 'voltage_divider',
    rule_id: 'VD-DET',
    components: ['R1', 'R2'],
    r_top: { ref: 'R1', ohms: 10000, value: '10k' },
    r_bottom: { ref: 'R2', ohms: 10000, value: '10k' },
    top_net: 'IN',
    mid_net: 'OUT',
    bottom_net: 'GND',
    ratio: 0.5,
    summary: '分压器 R1/R2',
  }
}

test('detectSimulators 在 PATH 中找到 ngspice 替身并优先于其他仿真器', () => {
  const dir = freshDir('ad-happy-spice-path-')
  const ngspice = writeStubSimulator(dir)
  const ltspice = writeStubSimulator(dir, 'ltspice')

  const detected = detectSimulators({
    env: detectionEnv(dir),
    platform: process.platform,
  })
  assert.equal(detected.ngspice, ngspice)
  assert.equal(detected.ltspice, ltspice)
  assert.deepEqual(detected.chosen, { name: 'ngspice', path: ngspice })

  // SPICE_SIMULATOR 显式指定时只选指定项，与上游 preference 行为一致。
  const preferred = detectSimulators({
    env: detectionEnv(dir, { SPICE_SIMULATOR: 'ltspice' }),
    platform: process.platform,
  })
  assert.deepEqual(preferred.chosen, { name: 'ltspice', path: ltspice })
})

test('detectSimulators 支持 NGSPICE_PATH 覆盖与无仿真器分支', () => {
  const dir = freshDir('ad-happy-spice-env-')
  const stub = writeStubSimulator(dir)
  const byEnv = detectSimulators({
    env: {
      ...process.env,
      PATH: '',
      NGSPICE_PATH: stub,
      SPICE_SIMULATOR: '',
      PROGRAMFILES: '',
      'PROGRAMFILES(X86)': '',
      LOCALAPPDATA: '',
    },
    platform: process.platform,
  })
  assert.equal(byEnv.ngspice, stub)
  assert.deepEqual(byEnv.chosen, { name: 'ngspice', path: stub })

  // 空 PATH + 非 Windows 平台：确定性地走「什么也没找到」分支。
  const none = detectSimulators({
    env: { PATH: '', SPICE_SIMULATOR: '' },
    platform: 'linux',
  })
  assert.deepEqual(none, {})
})

test('probeSimulatorVersion 读取替身版本；LTspice 不猜测版本', () => {
  const dir = freshDir('ad-happy-spice-version-')
  const stub = writeStubSimulator(dir)
  const version = probeSimulatorVersion('ngspice', stub, { env: stubEnv(stub) })
  assert.equal(version.version, '99-stub')
  assert.match(version.text, /ngspice-99-stub/)

  const ltspice = probeSimulatorVersion('ltspice', stub, {})
  assert.equal(ltspice.version, null)
  assert.match(ltspice.note, /版本未知/)
})

test('runSpice 用替身跑通分压器：结果、测试台与仿真器版本可追溯', () => {
  const dir = freshDir('ad-happy-spice-run-')
  const stub = writeStubSimulator(dir)
  const out = freshDir('ad-happy-spice-out-')
  const env = stubEnv(stub)

  const result = runSpice([voltageDividerCircuit()], {
    name: 'ngspice',
    path: stub,
  }, out, { env })

  assert.equal(result.coverage.status, 'pass')
  assert.deepEqual(result.coverage.counts, {
    total: 1, pass: 1, warn: 0, fail: 0, skip: 0,
  })
  assert.equal(result.coverage.simulator.name, 'ngspice')
  assert.equal(result.coverage.simulator.version, '99-stub')
  assert.equal(result.findings.length, 0)

  const circuit = result.coverage.circuits[0]
  assert.equal(circuit.type, 'voltage_divider')
  assert.equal(circuit.status, 'pass')
  assert.equal(circuit.testbenchExists, true)
  assert.ok(circuit.testbench.endsWith('.cir'))
  assert.ok(existsSync(join(out, circuit.testbench)), '测试台应保留在输出目录')
  assert.ok(existsSync(join(out, 'spice/simulation-report.json')))

  // 输入文件确实做了 detector 名映射，且保留了检测器字段。
  const input = readJson(join(out, 'spice/analysis-input.json'))
  assert.equal(input.findings[0].detector, 'detect_voltage_dividers')
  assert.equal(input.findings[0].r_top.ohms, 10000)
  assert.equal(input.findings[0].ad_happy_detector, 'voltage_divider')

  // 结果来自上游报告，不是 Node 侧编造的。
  const upstream = readJson(join(out, 'spice/simulation-report.json'))
  assert.equal(upstream.analyzer_type, 'spice')
  assert.equal(upstream.simulation_results[0].status, 'pass')
  assert.equal(upstream.simulation_results[0].cir_file, circuit.testbenchAbsolute)
})

test('runSpice 不匹配时产生 SP-003，偏差来自替身输出', () => {
  const dir = freshDir('ad-happy-spice-warn-')
  const stub = writeStubSimulator(dir)
  const out = freshDir('ad-happy-spice-out-')
  const env = stubEnv(stub, { SPICE_STUB_ERROR_PCT: '5' })

  const result = runSpice([voltageDividerCircuit()], {
    name: 'ngspice',
    path: stub,
  }, out, { env })

  assert.equal(result.coverage.status, 'found')
  assert.equal(result.coverage.counts.fail, 1)
  const finding = result.findings.find(item => item.rule_id === 'SP-003')
  assert.ok(finding)
  assert.equal(finding.severity, 'error')
  assert.deepEqual(finding.components, ['R1', 'R2'])
  assert.ok(finding.testbench.endsWith('.cir'))
  assert.ok(finding.delta.vout_error_pct >= 4.9, '偏差应来自替身实际输出')
  assert.match(finding.description, /ngspice/)
  assert.match(finding.title, /[一-鿿]/)
})

test('runSpice 仿真失败时产生 SP-002 且不把跳过当作通过', () => {
  const dir = freshDir('ad-happy-spice-skip-')
  const stub = writeStubSimulator(dir)
  const out = freshDir('ad-happy-spice-out-')
  const env = stubEnv(stub, { SPICE_STUB_FAIL: '1' })

  const result = runSpice([voltageDividerCircuit()], {
    name: 'ngspice',
    path: stub,
  }, out, { env })

  assert.equal(result.coverage.status, 'not_evaluated')
  assert.equal(result.coverage.counts.skip, 1)
  const finding = result.findings.find(item => item.rule_id === 'SP-002')
  assert.ok(finding)
  assert.equal(finding.severity, 'warning')
  assert.match(finding.evidence, /仿真未成功完成/)
  assert.ok(!finding.evidence.includes('Simulation failed'), '可见文本不应残留上游英文')
  assert.equal(result.coverage.circuits[0].testbenchExists, true, '测试台仍应保留供排查')
})

test('runSpice 没有仿真器时 SP-001 未评估，不创建 spice/ 产物', () => {
  const out = freshDir('ad-happy-spice-out-')
  const result = runSpice([voltageDividerCircuit()], null, out)

  assert.equal(result.coverage.status, 'not_evaluated')
  assert.equal(result.coverage.requested, true)
  assert.equal(result.coverage.findings, 1)
  assert.equal(result.coverage.simulator, null)
  assert.equal(result.coverage.availableCircuits, 1)
  assert.equal(result.coverage.submittedCircuits, 0)
  assert.equal(result.coverage.missingCircuits, 1, '未提交时差额必须计入未生成结果')
  assert.equal(result.coverage.installHints.length, simulatorInstallHints().length)
  assert.equal(existsSync(join(out, 'spice')), false, '未运行的仿真不得创建测试台目录')
  const finding = result.findings.find(item => item.rule_id === 'SP-001')
  assert.ok(finding)
  assert.equal(finding.severity, 'info')
  assert.match(finding.evidence, /ngspice/)
  assert.match(finding.evidence, /NGSPICE_PATH/)
})

test('候选与上游结果对账：生成器返回 None 时不得报 pass', () => {
  const dir = freshDir('ad-happy-spice-reconcile-')
  const stub = writeStubSimulator(dir)
  const out = freshDir('ad-happy-spice-out-')
  // comparator/open-loop 运放会被上游 generate_opamp_circuit 直接返回 None，
  // 既不报错也不写 simulation_results；AD-Happy 必须通过对账发现它。
  const opamp = {
    detector: 'opamp_circuit',
    rule_id: 'OA-DET',
    components: ['U1'],
    reference: 'U1',
    configuration: 'comparator_or_open_loop',
  }

  const result = runSpice([voltageDividerCircuit(), opamp], {
    name: 'ngspice',
    path: stub,
  }, out, { env: stubEnv(stub) })

  assert.equal(result.coverage.availableCircuits, 2)
  assert.equal(result.coverage.submittedCircuits, 2)
  assert.equal(result.coverage.counts.total, 1, '上游只返回分压器的结果')
  assert.equal(result.coverage.unaccountedCircuits.length, 1)
  assert.equal(result.coverage.unaccountedCircuits[0].type, 'opamp_circuit')
  assert.equal(result.coverage.missingCircuits, 1)
  assert.equal(result.coverage.status, 'partial')
  assert.notEqual(result.coverage.status, 'pass', '有候选被静默丢弃时不能报通过')

  const missing = result.findings.find(finding => (
    finding.rule_id === 'SP-002' && finding.candidate_type === 'opamp_circuit'
  ))
  assert.ok(missing)
  assert.match(missing.evidence, /没有返回该候选的仿真结果/)
  assert.equal(missing.severity, 'warning')

  const upstream = readJson(join(out, 'spice/simulation-report.json'))
  assert.equal(upstream.simulation_results.length, 1)
})

test('缺少反馈分压器的稳压器候选被预过滤并产生 SP-002', () => {
  const dir = freshDir('ad-happy-spice-pre-filter-')
  const stub = writeStubSimulator(dir)
  const out = freshDir('ad-happy-spice-out-')
  const ldo = {
    detector: 'power_regulator',
    rule_id: 'PR-DET',
    components: ['IC2'],
    ref: 'IC2',
    // 没有 feedback_divider：上游 generate_regulator_feedback 会返回 None。
  }

  const result = runSpice([voltageDividerCircuit(), ldo], {
    name: 'ngspice',
    path: stub,
  }, out, { env: stubEnv(stub) })

  assert.equal(result.coverage.availableCircuits, 2)
  assert.equal(result.coverage.submittedCircuits, 1)
  assert.equal(result.coverage.excludedCircuits.length, 1)
  assert.equal(result.coverage.unaccountedCircuits.length, 0)
  assert.match(result.coverage.excludedCircuits[0].reason, /feedback_divider/)
  assert.equal(result.coverage.counts.total, 1)
  assert.equal(result.coverage.status, 'partial')
  const missing = result.findings.find(finding => (
    finding.rule_id === 'SP-002' && finding.components.includes('IC2')
  ))
  assert.ok(missing)
  assert.match(missing.title, /稳压器反馈/)
  assert.match(missing.evidence, /feedback_divider/)

  // 全部候选都被预过滤时不调用上游，也不得报 pass。
  const onlyLdoOut = freshDir('ad-happy-spice-out-')
  const onlyLdo = runSpice([ldo], {
    name: 'ngspice',
    path: stub,
  }, onlyLdoOut, { env: stubEnv(stub) })
  assert.equal(onlyLdo.coverage.status, 'not_evaluated')
  assert.equal(onlyLdo.coverage.availableCircuits, 1)
  assert.equal(onlyLdo.coverage.submittedCircuits, 0)
  assert.equal(onlyLdo.coverage.missingCircuits, 1)
  assert.equal(onlyLdo.coverage.findings, 1)
  assert.equal(onlyLdo.findings[0].rule_id, 'SP-002')
  assert.equal(existsSync(join(onlyLdoOut, 'spice')), false, '未提交候选时不创建仿真目录')
})

test('上游备注翻译覆盖 feedback divider 与 will be wrong 变体', () => {
  assert.equal(
    localizeSimulationNote('2.00% error in feedback divider'),
    '反馈分压误差 2.00%',
  )
  assert.equal(
    localizeSimulationNote('5.0% error — regulator output voltage will be wrong'),
    '误差 5.0%：稳压器输出电压将不正确',
  )
  assert.equal(
    localizeSimulationNote('Simulation failed'),
    '仿真未成功完成',
  )
})

test('runSpice 没有可仿真子电路时 not_evaluated，不调用上游', () => {
  const dir = freshDir('ad-happy-spice-none-')
  const stub = writeStubSimulator(dir)
  const out = freshDir('ad-happy-spice-out-')
  const result = runSpice([
    { detector: 'connectivity', rule_id: 'NT-002', components: ['IC1'] },
  ], { name: 'ngspice', path: stub }, out, { env: stubEnv(stub) })

  assert.equal(result.coverage.status, 'not_evaluated')
  assert.equal(result.coverage.findings, 0)
  assert.equal(result.coverage.availableCircuits, 0)
  assert.ok(result.coverage.reasons.some(reason => reason.includes('可仿真的子电路')))
  assert.equal(existsSync(join(out, 'spice')), false)
})

test('报告渲染「仿真」章节：仿真器、测试台、未评估与安装提示', () => {
  const notRun = renderReport({
    project: '演示工程',
    generatedAt: '2026-11-25 10:00',
    coverage: { documents: 2, parsed: 2, notEvaluated: 0 },
    findings: [],
    status: { spice: 'not_evaluated' },
    spice: {
      requested: false,
      status: 'not_evaluated',
      reasons: ['未启用 --spice：仿真为可选步骤，本次没有运行。'],
    },
  })
  const notRunSection = notRun.slice(
    notRun.indexOf('id="spice"'),
    notRun.indexOf('id="findings"'),
  )
  assert.match(notRunSection, /仿真/)
  assert.match(notRunSection, /本次未运行仿真/)
  assert.ok(!notRunSection.includes('仿真通过'), '未运行不得写成通过')

  const html = renderReport({
    project: '演示工程',
    generatedAt: '2026-11-25 10:00',
    coverage: { documents: 2, parsed: 2, notEvaluated: 0 },
    findings: [],
    status: { spice: 'pass' },
    spice: {
      requested: true,
      status: 'pass',
      simulator: {
        name: 'ngspice',
        path: 'C:/tools/ngspice.exe',
        version: '42',
      },
      availableCircuits: 1,
      circuits: [{
        type: 'voltage_divider',
        reference: 'R1/R2',
        components: ['R1', 'R2'],
        status: 'pass',
        testbench: 'spice/work/voltage-divider_R1_R2.cir',
        testbenchExists: true,
      }],
      counts: { total: 1, pass: 1, warn: 0, fail: 0, skip: 0 },
      checks: {
        simulator_detection: 'pass',
        testbench_generation: 'pass',
        simulation: 'pass',
      },
      artifacts: {
        index: 'spice.json',
        input: 'spice/analysis-input.json',
        report: 'spice/simulation-report.json',
        workdir: 'spice/work',
      },
      findings: 0,
      reasons: [],
    },
  })
  assert.match(html, /id="spice"/)
  assert.match(html, /ngspice/)
  assert.match(html, /voltage-divider_R1_R2\.cir/)
  assert.match(html, /全部 1 个子电路仿真通过/)
})

test('报告渲染 failed + simulator=null：必须写「仿真执行失败」而不是「未评估」', () => {
  const html = renderReport({
    project: '演示工程',
    generatedAt: '2026-11-25 10:00',
    coverage: { documents: 2, parsed: 2, notEvaluated: 0 },
    findings: [],
    status: { spice: 'failed' },
    spice: {
      requested: true,
      status: 'failed',
      simulator: null,
      availableCircuits: 1,
      submittedCircuits: 0,
      missingCircuits: 1,
      circuits: [],
      excludedCircuits: [],
      unaccountedCircuits: [],
      counts: { total: 0, pass: 0, warn: 0, fail: 0, skip: 0 },
      checks: {
        simulator_detection: 'failed',
        testbench_generation: 'failed',
        simulation: 'failed',
      },
      reasons: ['仿真器不可执行或不存在：C:/tools/ngspice.exe'],
      findings: 1,
    },
  })
  const start = html.indexOf('id="spice-status"')
  const end = html.indexOf('</p>', start)
  const statusText = html.slice(html.indexOf('>', start) + 1, end)
  assert.match(statusText, /仿真执行失败/)
  assert.ok(!statusText.includes('未评估'), `failed 文案不应是未评估：${statusText}`)

  const section = html.slice(html.indexOf('id="spice"'), html.indexOf('id="findings"'))
  assert.match(section, /仿真执行失败，没有可用的子电路结果/)
  assert.ok(!section.includes('未找到可用仿真器，没有生成任何子电路结果'))
})

test('报告渲染未生成结果的候选：partial 不得写成全部通过', () => {
  const html = renderReport({
    project: '演示工程',
    generatedAt: '2026-11-25 10:00',
    coverage: { documents: 2, parsed: 2, notEvaluated: 0 },
    findings: [],
    status: { spice: 'partial' },
    spice: {
      requested: true,
      status: 'partial',
      simulator: {
        name: 'ngspice',
        path: 'C:/tools/ngspice.exe',
        version: '42',
      },
      availableCircuits: 2,
      submittedCircuits: 1,
      missingCircuits: 1,
      circuits: [{
        type: 'voltage_divider',
        typeLabel: '分压器',
        reference: 'R1/R2',
        components: ['R1', 'R2'],
        status: 'pass',
        testbench: 'spice/work/voltage-divider_R1_R2.cir',
        testbenchExists: true,
      }],
      excludedCircuits: [{
        type: 'regulator_feedback',
        typeLabel: '稳压器反馈',
        detector: 'power_regulator',
        reference: 'IC2',
        components: ['IC2'],
        reason: '缺少反馈分压器（feedback_divider.r_top/r_bottom），上游生成器会返回空测试台。',
      }],
      unaccountedCircuits: [],
      counts: { total: 1, pass: 1, warn: 0, fail: 0, skip: 0 },
      checks: {
        simulator_detection: 'pass',
        testbench_generation: 'partial',
        simulation: 'partial',
      },
      artifacts: { index: 'spice.json', workdir: 'spice/work' },
      findings: 1,
      reasons: ['1 个候选子电路没有产出仿真结果；其余结果不能代表全部候选都已验证。'],
    },
  })
  const section = html.slice(html.indexOf('id="spice"'), html.indexOf('id="findings"'))
  assert.match(section, /部分完成：1 个候选未生成结果/)
  assert.match(section, /id="spice-missing-candidates"/)
  assert.match(section, /稳压器反馈/)
  assert.match(section, /feedback_divider/)
  assert.ok(!section.includes('全部 1 个子电路仿真通过'), 'partial 不得写成全部通过')
})

// ---------------------------------------------------------------------------
// CLI 端到端
// ---------------------------------------------------------------------------

const gerberFixture = join(testsDir, 'fixtures/gerber-basic')

test('CLI 不带 --spice：规则未评估、无 SP finding、报告说明可选', () => {
  const out = freshDir('ad-happy-spice-cli-off-')
  const r = runAnalyze([
    '--project', fixtureProject,
    '--gerber', gerberFixture,
    '--out', out,
  ])
  assert.equal(r.status, 0, r.stderr)

  const summary = readJson(join(out, 'summary.json'))
  assert.equal(summary.rules.spice, 'not_evaluated')
  assert.equal(summary.spice.requested, false)
  assert.equal(summary.spice.status, 'not_evaluated')
  assert.equal(summary.spice.simulator, null)
  assert.ok(summary.spice.reasons.some(reason => reason.includes('--spice')))

  const findings = readJson(join(out, 'findings.json'))
  assert.ok(!findings.some(finding => String(finding.rule_id).startsWith('SP-')))

  const manifest = readJson(join(out, 'manifest.json'))
  assert.equal(manifest.stages.spice, 'skipped')
  assert.equal(manifest.spice.requested, false)
  assert.equal(existsSync(join(out, 'spice.json')), false)

  const html = readFileSync(join(out, 'report.html'), 'utf8')
  assert.match(html, /id="spice"/)
  assert.match(html, /本次未运行仿真/)
})

test('CLI --spice 无仿真器：未评估、退出码 0、原因与安装提示可见', (t) => {
  if (detectSimulators().chosen) {
    t.skip('本机已安装 SPICE 仿真器，无法确定性复现「无仿真器」分支')
    return
  }
  const out = freshDir('ad-happy-spice-cli-nosim-')
  const r = runAnalyze([
    '--project', fixtureProject,
    '--gerber', gerberFixture,
    '--out', out,
    '--spice',
  ])
  assert.equal(r.status, 0, r.stderr)

  const summary = readJson(join(out, 'summary.json'))
  assert.equal(summary.rules.spice, 'not_evaluated')
  assert.equal(summary.spice.requested, true)
  assert.equal(summary.spice.simulator, null)
  assert.equal(summary.spice.submittedCircuits, 0, '没有仿真器时不得记为已提交')
  assert.equal(summary.spice.availableCircuits, 2, '仍应展示识别到的候选数')
  assert.equal(
    summary.spice.missingCircuits,
    summary.spice.availableCircuits,
    '未提交时 available - submitted 必须由 missingCircuits 解释',
  )
  assert.ok(summary.spice.reasons.some(reason => reason.includes('SPICE 仿真器')))
  assert.ok(summary.spice.reasons.some(reason => reason.includes('ngspice')))

  const findings = readJson(join(out, 'findings.json'))
  const sp001 = findings.find(finding => finding.rule_id === 'SP-001')
  assert.ok(sp001)
  assert.equal(sp001.source, 'spice')
  assert.equal(sp001.severity, 'info')
  // 「没装仿真器」是环境事实，不计入问题数。
  assert.equal(sp001.kind, 'fact')
  const issueCount = findings.filter(finding => finding.kind !== 'fact').length
  assert.equal(summary.counts.total, issueCount, 'SP-001 不得计入问题总数')
  assert.equal(
    summary.counts.facts,
    findings.filter(finding => finding.kind === 'fact').length,
  )
  assert.ok(!findings.some(finding => ['SP-002', 'SP-003'].includes(finding.rule_id)))

  assert.ok(existsSync(join(out, 'spice.json')))
  const artifact = readJson(join(out, 'spice.json'))
  assert.equal(artifact.requested, true)
  assert.equal(artifact.coverage.status, 'not_evaluated')
  assert.equal(artifact.coverage.installHints.length, simulatorInstallHints().length)

  const manifest = readJson(join(out, 'manifest.json'))
  assert.equal(manifest.stages.spice, 'not_evaluated')
  assert.deepEqual(manifest.errors, [])
  assert.equal(manifest.spice.detection.chosen, undefined)

  const html = readFileSync(join(out, 'report.html'), 'utf8')
  assert.match(html, /id="spice-install-hints"/)
  assert.match(html, /SPICE 仿真器/)
  assert.match(html, /未评估/)
  const section = html.slice(html.indexOf('id="spice"'), html.indexOf('id="findings"'))
  assert.match(section, /未生成结果的候选/)
  assert.match(section, /共 2 个候选未生成结果/)
})

test('CLI --spice + 仿真器替身：产出结果并记录测试台路径', () => {
  const stubDir = freshDir('ad-happy-spice-cli-stub-')
  const stub = writeStubSimulator(stubDir)
  const out = freshDir('ad-happy-spice-cli-on-')
  const r = runAnalyze([
    '--project', fixtureProject,
    '--gerber', gerberFixture,
    '--out', out,
    '--spice',
  ], { env: stubEnv(stub) })
  assert.equal(r.status, 0, r.stderr)

  const summary = readJson(join(out, 'summary.json'))
  assert.equal(summary.status, 'complete')
  assert.equal(summary.rules.spice, 'pass')
  assert.equal(summary.spice.requested, true)
  assert.equal(summary.spice.simulator.name, 'ngspice')
  assert.match(summary.spice.simulator.version, /99-stub/)
  assert.equal(summary.spice.counts.total, 2)
  assert.equal(summary.spice.counts.pass, 2)
  assert.equal(summary.spice.availableCircuits, 2)
  assert.equal(summary.spice.submittedCircuits, 2)
  assert.equal(summary.spice.missingCircuits, 0)
  assert.equal(summary.spice.excludedCircuits, 0)
  assert.equal(summary.spice.unaccountedCircuits, 0)
  assert.equal(summary.spice.findings, 0)

  const findings = readJson(join(out, 'findings.json'))
  assert.ok(!findings.some(finding => String(finding.rule_id).startsWith('SP-')))

  const artifact = readJson(join(out, 'spice.json'))
  assert.equal(artifact.coverage.status, 'pass')
  assert.equal(artifact.coverage.simulator.version, '99-stub')
  assert.equal(artifact.coverage.circuits.length, 2)
  for (const circuit of artifact.coverage.circuits) {
    assert.ok(circuit.testbench)
    assert.equal(circuit.testbenchExists, true)
    assert.ok(existsSync(join(out, circuit.testbench)))
    assert.equal(circuit.simulator.name, 'ngspice')
    assert.match(circuit.simulator.version, /99-stub/)
  }
  // 测试台来自上游实际生成的文件，只记录路径，不伪造结果。
  const upstream = readJson(join(out, 'spice/simulation-report.json'))
  assert.equal(upstream.analyzer_type, 'spice')
  assert.equal(upstream.simulation_results.length, artifact.coverage.circuits.length)
  const input = readJson(join(out, 'spice/analysis-input.json'))
  assert.ok(input.findings.every(finding => finding.detector.startsWith('detect_')))

  const manifest = readJson(join(out, 'manifest.json'))
  assert.equal(manifest.stages.spice, 'pass')
  assert.equal(manifest.spice.detection.chosen.name, 'ngspice')
  assert.ok(!manifest.errors.some(error => error.stage === 'spice'))

  const html = readFileSync(join(out, 'report.html'), 'utf8')
  const section = html.slice(html.indexOf('id="spice"'), html.indexOf('id="findings"'))
  assert.match(section, /ngspice/)
  assert.match(section, /99-stub/)
  assert.match(section, /voltage-divider_R1_R2\.cir/)
  assert.match(section, /全部 2 个子电路仿真通过/)
})

test('CLI --spice 结果不匹配：SP-003 计入问题，但不改变退出码', () => {
  const stubDir = freshDir('ad-happy-spice-cli-bad-')
  const stub = writeStubSimulator(stubDir)
  const out = freshDir('ad-happy-spice-cli-bad-out-')
  const r = runAnalyze([
    '--project', fixtureProject,
    '--gerber', gerberFixture,
    '--out', out,
    '--spice',
  ], { env: stubEnv(stub, { SPICE_STUB_ERROR_PCT: '5' }) })
  assert.equal(r.status, 0, r.stderr)

  const summary = readJson(join(out, 'summary.json'))
  assert.equal(summary.rules.spice, 'found')
  assert.equal(summary.spice.counts.fail, 2)
  assert.equal(summary.status, 'complete')

  const findings = readJson(join(out, 'findings.json'))
  const sp003 = findings.filter(finding => finding.rule_id === 'SP-003')
  assert.equal(sp003.length, 2)
  for (const finding of sp003) {
    assert.equal(finding.severity, 'error')
    assert.equal(finding.source, 'spice')
    assert.ok(finding.testbench)
    assert.ok(finding.delta.vout_error_pct >= 4.9 || finding.delta.vfb_error_pct >= 4.9)
  }

  const html = readFileSync(join(out, 'report.html'), 'utf8')
  assert.match(html, /发现 2 条仿真问题/)
})

test('CLI --spice 上游脚本缺失：rules.spice=failed 且退出码 3', () => {
  const stubDir = freshDir('ad-happy-spice-cli-miss-')
  const stub = writeStubSimulator(stubDir)
  const emptyScripts = freshDir('ad-happy-spice-empty-scripts-')
  const out = freshDir('ad-happy-spice-cli-miss-out-')
  const r = runAnalyze([
    '--project', fixtureProject,
    '--gerber', gerberFixture,
    '--out', out,
    '--spice',
  ], {
    env: stubEnv(stub, { KICAD_HAPPY_SPICE_SCRIPTS: emptyScripts }),
  })
  assert.equal(r.status, 3)

  const summary = readJson(join(out, 'summary.json'))
  assert.equal(summary.rules.spice, 'failed')
  assert.equal(summary.spice.status, 'failed')
  assert.equal(summary.spice.submittedCircuits, 0, '脚本缺失时尚未提交候选')
  assert.equal(
    summary.spice.missingCircuits,
    summary.spice.availableCircuits,
    '脚本缺失时差额必须计入未生成结果',
  )
  assert.ok(summary.spice.reasons.some(reason => reason.includes('simulate_subcircuits.py')))

  const findings = readJson(join(out, 'findings.json'))
  const sp002 = findings.find(finding => finding.rule_id === 'SP-002')
  assert.ok(sp002)
  assert.equal(sp002.severity, 'error')

  const manifest = readJson(join(out, 'manifest.json'))
  assert.equal(manifest.stages.spice, 'failed')
  assert.ok(manifest.errors.some(error => error.stage === 'spice'))

  // failed 且 simulator=null 时，报告状态文案必须是「仿真执行失败」，
  // 不能因为拿不到 simulator 就写成「未评估」。
  const html = readFileSync(join(out, 'report.html'), 'utf8')
  const start = html.indexOf('id="spice-status"')
  const end = html.indexOf('</p>', start)
  const statusText = html.slice(html.indexOf('>', start) + 1, end)
  assert.match(statusText, /仿真执行失败/)
  assert.ok(!statusText.includes('未评估'), `failed 文案不应是未评估：${statusText}`)
})
