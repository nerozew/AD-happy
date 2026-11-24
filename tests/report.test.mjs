// tests/report.test.mjs
import test from 'node:test'
import assert from 'node:assert'
import { renderReport } from '../.agents/skills/ad-happy/scripts/report.mjs'

const data = {
  project: 'Student-DCDC-Buck-Converter',
  generatedAt: '2026-11-24 10:00',
  coverage: { documents: 9, parsed: 6, notEvaluated: 3 },
  findings: [{ rule_id: 'XP-001', severity: 'must_fix', title: 'IC1 VIN 网络不一致', evidence: '原理图 IN / PCB OUT' }],
  status: { decoupling: 'not_evaluated' },
}

test('HTML 为中文且含结论', () => {
  const html = renderReport(data)
  assert.match(html, /<html/)
  assert.match(html, /结论/)
  assert.match(html, /未评估/)
})

test('未评估项单独成节', () => {
  const html = renderReport(data)
  assert.match(html, /数据覆盖/)
  assert.match(html, /decoupling/)
})

test('boards 列出全部文档并标出本次审查/解析的文档', () => {
  const html = renderReport({
    ...data,
    boards: [
      { name: 'Main.PcbDoc', kind: 'pcb', selected: true },
      { name: 'Alt.PcbDoc', kind: 'pcb', selected: false },
      { name: 'SCH1.SchDoc', kind: 'sch', selected: true },
      { name: 'SCH2.SchDoc', kind: 'sch', selected: false },
      { name: 'Lib.PcbLib', kind: 'lib', selected: false },
      { name: '<script>alert(1)</script>', kind: 'pcb', selected: false },
    ],
  })

  assert.match(html, /id="documents"/)
  assert.match(html, /板卡与文档/)
  for (const name of ['Main.PcbDoc', 'Alt.PcbDoc', 'SCH1.SchDoc', 'SCH2.SchDoc', 'Lib.PcbLib']) {
    assert.ok(html.includes(name), `应列出 ${name}`)
  }
  assert.match(html, /本次审查/)
  assert.match(html, /本次解析/)
  assert.match(html, /仅解析第一份 SchDoc/)
  assert.match(html, /库文件不做独立解析/)
  assert.ok(!html.includes('<script>alert(1)</script>'), '文档名必须转义')
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
})

test('没有 boards 时不渲染板卡小节（向后兼容）', () => {
  const html = renderReport(data)
  assert.ok(!html.includes('id="documents"'))
  assert.ok(!html.includes('板卡与文档'))
})

test('没有外部依赖', () => {
  const html = renderReport(data)
  assert.ok(!/src=["']https?:/.test(html))
  assert.ok(!/href=["']https?:.*\.css/.test(html))
})

test('按 must_fix / should_fix / nice_to_have 三组展示，组内按规则 ID 排序', () => {
  const html = renderReport({
    ...data,
    findings: [
      { rule_id: 'XP-001', severity: 'must_fix', title: '甲', evidence: '证据甲' },
      { rule_id: 'AM-001', severity: 'must_fix', title: '乙', evidence: '证据乙' },
      { rule_id: 'NT-002', severity: 'should_fix', title: '丙', evidence: '证据丙' },
      { rule_id: 'DC-001', severity: 'nice_to_have', title: '丁', evidence: '证据丁' },
    ],
  })

  const must = html.indexOf('id="group-must_fix"')
  const should = html.indexOf('id="group-should_fix"')
  const nice = html.indexOf('id="group-nice_to_have"')
  assert.ok(must !== -1 && should !== -1 && nice !== -1, '三组都应渲染')
  assert.ok(must < should && should < nice, '分组顺序应为必须修复、建议修复、可优化')

  // 同组内按 rule_id 稳定排序。
  assert.ok(html.indexOf('AM-001') < html.indexOf('XP-001'))
})

test('每条 finding 显示规则 ID、严重度、标题、证据、建议与定位', () => {
  const html = renderReport({
    ...data,
    findings: [{
      rule_id: 'XP-001',
      severity: 'must_fix',
      title: 'IC1 VIN 网络不一致',
      evidence: '原理图 IN / PCB OUT',
      recommendation: '以原理图为准同步 PCB。',
      components: ['IC1', 'C2'],
      nets: ['IN', 'OUT'],
      pins: ['IC1.3'],
    }],
  })

  assert.match(html, /XP-001/)
  assert.match(html, /必须修复/)
  assert.match(html, /IC1 VIN 网络不一致/)
  assert.match(html, /原理图 IN \/ PCB OUT/)
  assert.match(html, /以原理图为准同步 PCB。/)
  assert.match(html, /IC1、C2/)
  assert.match(html, /IN、OUT/)
  assert.match(html, /IC1\.3/)
})

test('兼容原始 finding 字段 title/summary、evidence/description', () => {
  const html = renderReport({
    ...data,
    findings: [{
      rule_id: 'NT-002',
      severity: 'warning',
      summary: 'Unconnected pin: IC1.4',
      description: '引脚 IC1.4 未连接，也没有 no-connect 标记。',
      recommendation: '连接或放置 no-connect 标记。',
    }],
  })

  assert.match(html, /Unconnected pin: IC1\.4/)
  assert.match(html, /引脚 IC1\.4 未连接/)
  assert.match(html, /连接或放置 no-connect 标记。/)
})

test('区分通过、未评估与失败，不把未评估当作通过', () => {
  const html = renderReport({
    ...data,
    findings: [],
    status: {
      decoupling: 'not_evaluated',
      rc_filter: 'pass',
      dfm: 'failed',
      connectivity: 'found',
    },
  })

  assert.match(html, /规则状态一览/)
  assert.match(html, /不能据此认为全部通过/)

  const notEvaluated = html.slice(
    html.indexOf('id="not-evaluated"'),
    html.indexOf('id="rules-status"'),
  )
  assert.match(notEvaluated, /decoupling/)
  assert.match(notEvaluated, /未评估/)
  assert.ok(!notEvaluated.includes('rc_filter'), '通过的规则不应出现在未评估清单')
})

test('部分完成的规则显示「部分完成」且不计入通过', () => {
  const html = renderReport({
    ...data,
    findings: [],
    status: { dfm: 'partial', decoupling: 'pass' },
  })

  assert.match(html, /部分完成/)
  const partial = html.slice(
    html.indexOf('id="partial-rules"'),
    html.indexOf('id="failed-rules"'),
  )
  assert.match(partial, /dfm/)
  assert.ok(!partial.includes('decoupling'), '通过的规则不应出现在部分完成清单')
})

test('工程名、标题、网络名等用户可控文本会被转义', () => {
  const html = renderReport({
    ...data,
    project: '<script>alert("x")</script>',
    findings: [{
      rule_id: 'XP-001',
      severity: 'must_fix',
      title: '<img src=x onerror=alert(1)>',
      evidence: '网 <b>IN</b> & "OUT"',
      recommendation: '<svg onload=alert(1)>',
      components: ['<script>'],
      nets: ['A&B'],
    }],
  })

  assert.ok(!html.includes('<script>alert'), '工程名中的脚本不得原样输出')
  assert.ok(!html.includes('<img src=x'), '标题中的标签不得原样输出')
  assert.ok(!html.includes('<svg onload'), '建议中的标签不得原样输出')
  assert.ok(html.includes('&lt;script&gt;'), '脚本应被转义')
  assert.ok(html.includes('A&amp;B'), '网络名中的 & 应被转义')
})

test('SVG 直接内联，可疑脚本与外部引用被省略', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
  const html = renderReport({ ...data, svgs: [{ title: '顶层板图', svg }] })
  assert.ok(html.includes(svg), 'SVG 应内联输出')
  assert.match(html, /顶层板图/)

  // altiumts 的板图会用 data-component= 标注元件；普通属性名里的 "onent="
  // 不能被误判成 on 事件属性（Task 11 集成 --svg 时发现的真实误报）。
  const annotated = '<svg xmlns="http://www.w3.org/2000/svg"><path data-record="ComponentBody" data-component="1" d="M0 0"/></svg>'
  const safeHtml = renderReport({ ...data, svgs: [{ title: '带标注板图', svg: annotated }] })
  assert.ok(safeHtml.includes(annotated), 'data-component 不应触发事件属性拦截')

  for (const badSvg of [
    '<svg onload="alert(1)"></svg>',
    '<svg/onload="alert(1)"></svg>',
    '<svg><image href="https://example.com/x.png"/></svg>',
  ]) {
    const unsafe = renderReport({ ...data, svgs: [{ title: '坏图', svg: badSvg }] })
    assert.ok(!unsafe.includes('onload="alert(1)"'), '带事件属性的 SVG 不得内联')
    assert.ok(!unsafe.includes('https://example.com'), '带外部引用的 SVG 不得内联')
    assert.match(unsafe, /已省略/)
  }
})

test('未知严重度归入建议修复，不泄漏原型属性', () => {
  const html = renderReport({
    ...data,
    findings: [{ rule_id: 'XX-001', severity: '__proto__', title: '未知严重度' }],
  })
  assert.match(html, /XX-001/)
  assert.ok(!html.includes('[object Object]'))
})

test('空输入也能生成完整 HTML', () => {
  const html = renderReport({})
  assert.match(html, /<html/)
  assert.match(html, /结论/)
  assert.match(html, /数据覆盖/)
  assert.match(html, /没有此类问题/)
})
