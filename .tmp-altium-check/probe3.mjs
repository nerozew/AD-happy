// 第三轮：引脚连接点几何、容差网络重建、跨域对照
import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

const LIB = "D:/NeroZe/pcb布局/AD26_PCB自动布局_工具包/03-Altium-样板/smoke-test/offline-placement/node_modules/altiumts/dist/index.js"
const BASE = "D:/NeroZe/pcb布局/AD26_PCB自动布局_工具包/03-Altium-样板/smoke-test/Student-DCDC-Buck-Converter-b19eda1250a50166996a777ce6fc12f0e5d4e36d/"
const a = await import(pathToFileURL(LIB).href)
const out = (k, v) => console.log(`\n### ${k}\n${JSON.stringify(v, null, 2)}`)
const num = (v) => { const n = Number.parseFloat(v); return Number.isFinite(n) ? n : 0 }
const pt = (r, xk = "Location.X", yk = "Location.Y") => ({ x: num(r.get(xk)) + num(r.get(xk + "_FRAC")) / 100000, y: num(r.get(yk)) + num(r.get(yk + "_FRAC")) / 100000 })

const sch = a.parseAltiumFile(new Uint8Array(await readFile(BASE + "SCH1_Main.SchDoc"))).document
const pcb = a.parseAltiumFile(new Uint8Array(await readFile(BASE + "PCB4 (Final Design).PcbDoc"))).document

// 组件位号：用 index.getParent 链
function designatorFor(record) {
  let cur = record
  for (let i = 0; i < 5 && cur; i++) {
    cur = sch.index.getParent(cur)
    if (!cur) return undefined
    if (cur.type === "schematic-component-record") {
      const des = sch.getOwnedRecords(cur).find(r => r.type === "schematic-designator-record")
      return des?.get("Text")
    }
  }
  return undefined
}
out("PARENT.pinDesignators", sch.pins.map(p => ({ pin: p.designator, name: p.name, parentType: sch.index.getParent(p)?.type, designator: designatorFor(p) })))

// 引脚几何
const pins = sch.pins.map(p => {
  const loc = pt(p)
  const len = p.pinLengthSchematicUnits
  const q = p.orientationQuarterTurns
  const conglom = p.get("PinConglomerate")
  return { rec: p, loc, len, q, conglom, designator: p.designator, name: p.name, comp: designatorFor(p) }
})
out("PIN.geometry", pins.map(p => ({ comp: p.comp, pin: p.designator, name: p.name, loc: p.loc, len: p.len, q: p.q, conglom: p.conglom })))

// 所有 wire 端点
const wires = sch.wires.map(w => {
  const p1 = pt(w, "X1", "Y1"), p2 = pt(w, "X2", "Y2")
  return { rec: w, p1, p2 }
})
out("WIRE.endpoints", wires.map(w => ({ p1: w.p1, p2: w.p2 })))

// 测试每种方向映射：对每个 pin，哪个 tip 方向最接近任一 wire 端点
const dirs = [
  { q: 0, dx: 1, dy: 0 }, { q: 1, dx: 0, dy: 1 }, { q: 2, dx: -1, dy: 0 }, { q: 3, dx: 0, dy: -1 },
]
const dirStats = { right: 0, up: 0, left: 0, down: 0 }
const tipRows = []
for (const p of pins) {
  const candidates = [
    { dir: "right", tip: { x: p.loc.x + p.len, y: p.loc.y } },
    { dir: "left", tip: { x: p.loc.x - p.len, y: p.loc.y } },
    { dir: "up", tip: { x: p.loc.x, y: p.loc.y + p.len } },
    { dir: "down", tip: { x: p.loc.x, y: p.loc.y - p.len } },
  ].map(c => {
    let best = Infinity
    for (const w of wires) best = Math.min(best, Math.hypot(c.tip.x - w.p1.x, c.tip.y - w.p1.y), Math.hypot(c.tip.x - w.p2.x, c.tip.y - w.p2.y))
    return { ...c, best }
  })
  candidates.sort((a, b) => a.best - b.best)
  dirStats[candidates[0].dir]++
  tipRows.push({ comp: p.comp, pin: p.designator, name: p.name, q: p.q, conglom: p.conglom, bestDir: candidates[0].dir, bestDist: candidates[0].best, secondDist: candidates[1].best })
}
out("PIN.bestDirectionStats", dirStats)
out("PIN.bestDirections", tipRows)

// 用 PinConglomerate 解码方向的经验映射：试 4 种 q->dir 映射，统计总误差
const mappings = {
  "q0=right cw": ["right", "up", "left", "down"],
  "q0=right ccw": ["right", "down", "left", "up"],
  "q0=up cw": ["up", "right", "down", "left"],
  "q0=up ccw": ["up", "left", "down", "right"],
}
const dirVec = { right: [1, 0], left: [-1, 0], up: [0, 1], down: [0, -1] }
for (const [label, map] of Object.entries(mappings)) {
  let total = 0
  for (const p of pins) {
    const d = map[p.q & 3]
    const [dx, dy] = dirVec[d]
    const tip = { x: p.loc.x + dx * p.len, y: p.loc.y + dy * p.len }
    let best = Infinity
    for (const w of wires) best = Math.min(best, Math.hypot(tip.x - w.p1.x, tip.y - w.p1.y), Math.hypot(tip.x - w.p2.x, tip.y - w.p2.y))
    total += best
  }
  out(`MAP.${label}`, { totalDistance: Math.round(total * 1000) / 1000 })
}

// 用最佳映射重建网络（容差 0.01）
const mapQ = ["right", "up", "left", "down"] // 待确认
function tipOf(p) {
  const [dx, dy] = dirVec[mapQ[p.q & 3]]
  return { x: p.loc.x + dx * p.len, y: p.loc.y + dy * p.len }
}
const TOL = 0.01
const nodes = []
for (const w of wires) {
  nodes.push({ p: w.p1, rec: w.rec, end: 0 })
  nodes.push({ p: w.p2, rec: w.rec, end: 1 })
}
for (const p of pins) nodes.push({ p: tipOf(p), rec: p.rec })
for (const r of sch.records) {
  if (["schematic-net-label-record", "schematic-power-port-record", "schematic-junction-record"].includes(r.type)) {
    nodes.push({ p: pt(r), rec: r })
  }
}
const parent = nodes.map((_, i) => i)
const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
const union = (i, j) => { const x = find(i), y = find(j); if (x !== y) parent[y] = x }
const cellKey = (p) => `${Math.round(p.x / TOL)},${Math.round(p.y / TOL)}`
const buckets = new Map()
nodes.forEach((n, i) => { const k = cellKey(n.p); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(i) })
for (let i = 0; i < nodes.length; i++) {
  const cx = Math.round(nodes[i].p.x / TOL), cy = Math.round(nodes[i].p.y / TOL)
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    for (const j of buckets.get(`${cx + dx},${cy + dy}`) || []) {
      if (j <= i) continue
      if (Math.hypot(nodes[i].p.x - nodes[j].p.x, nodes[i].p.y - nodes[j].p.y) <= TOL) union(i, j)
    }
  }
}
const wireEnds = new Map()
nodes.forEach((n, i) => {
  if (n.rec.type === "schematic-wire-record") {
    if (!wireEnds.has(n.rec)) wireEnds.set(n.rec, [])
    wireEnds.get(n.rec)[n.end] = i
  }
})
for (const arr of wireEnds.values()) if (arr[0] !== undefined && arr[1] !== undefined) union(arr[0], arr[1])
const groups = new Map()
nodes.forEach((n, i) => { const g = find(i); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(n) })
const designatorByOwner = new Map()
for (const p of pins) designatorByOwner.set(p.rec.get("OwnerIndex"), p.comp)

const nets = []
for (const list of groups.values()) {
  const pinList = list.filter(n => n.rec.type === "schematic-pin-record").map(n => {
    const pp = pins.find(x => x.rec === n.rec)
    return { comp: pp.comp, pin: pp.designator, name: pp.name }
  })
  const names = [...new Set(list.filter(n => n.rec.type === "schematic-net-label-record").map(n => n.rec.get("Text")))]
  const power = [...new Set(list.filter(n => n.rec.type === "schematic-power-port-record").map(n => n.rec.get("Text") ?? n.rec.get("Name")))]
  nets.push({ names: [...new Set([...names, ...power])], pins: pinList, wires: list.filter(n => n.rec.type === "schematic-wire-record").length })
}
out("NET2.count", nets.length)
out("NET2.nets", nets.filter(n => n.pins.length > 0 || n.names.length > 0).sort((a, b) => b.pins.length - a.pins.length))
out("NET2.stats", {
  multiPinNets: nets.filter(n => n.pins.length > 1).length,
  namedNets: nets.filter(n => n.names.length > 0).length,
  singletonUnnamed: nets.filter(n => n.pins.length === 1 && n.names.length === 0).length,
  totalPinsInNets: nets.reduce((s, n) => s + n.pins.length, 0),
})

// 跨域对照：同一映射
const padNets = new Map()
for (const c of pcb.components) {
  for (const r of pcb.getRecordsOwnedByComponent(c)) {
    if (r.type !== "pad-record") continue
    const k = `${c.designator}|${r.get("NAME")}`
    if (!padNets.has(k)) padNets.set(k, [])
    padNets.get(k).push(pcb.getNetForRecord(r)?.name)
  }
}
const rows = []
for (const n of nets) for (const p of n.pins) rows.push({ comp: p.comp, pin: p.pin, pinName: p.name, schNet: n.names[0] ?? "(unnamed)", pcbNets: padNets.get(`${p.comp}|${p.pin}`) })
out("CROSS2.rows", rows)
out("CROSS2.mismatch", rows.filter(r => !r.pcbNets || !r.pcbNets.includes(r.schNet)))
out("CROSS2.coverage", { pins: rows.length, matched: rows.filter(r => r.pcbNets && r.pcbNets.includes(r.schNet)).length })

// 焊盘编号与原理图引脚号一一对应检查
out("CROSS2.padKeys", [...padNets.keys()])

// 铺铜记录详情
const pourTypes = {}
for (const pg of pcb.polygons) {
  for (const r of pcb.getRecordsForPolygon(pg)) {
    pourTypes[r.type] = (pourTypes[r.type] || 0) + 1
  }
}
out("PCB.pourRecordTypes", pourTypes)
const onePolygon = pcb.polygons.find(p => p.name.startsWith("71,78,68")) // GND...
out("PCB.onePolygonRecords", pcb.getRecordsForPolygon(onePolygon).map(r => ({ type: r.type, layer: r.get("LAYER"), net: r.get("NET"), kind: r.get("KIND"), holes: r.holeCount, points: r.geometry?.outline?.points?.length, fields: r.items.map(i => `${i.key}=${i.value}`).slice(0, 15) })))

// PCB 组件字段（comment 是否存在于原始字段）
out("PCB.componentFields", pcb.components.map(c => ({
  designator: c.designator, comment: c.comment, footprint: c.footprint,
  keys: c.items.map(i => i.key),
  selected: c.items.filter(i => ["COMMENT", "DESCRIPTION", "FOOTPRINT", "SOURCELIBREFERENCE", "SOURCELIBRARYNAME"].includes(i.key)).map(i => `${i.key}=${i.value}`),
})))

// 规则作用域表达式样本与是否可求值（仅显示）
out("PCB.ruleScopes", [...new Set(pcb.rules.map(r => r.scope1Expression))])
