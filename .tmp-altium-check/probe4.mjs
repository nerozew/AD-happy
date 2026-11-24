// 第四轮：修正分数坐标 + 方向解码 + 点到线段连通
import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

const LIB = "D:/NeroZe/pcb布局/AD26_PCB自动布局_工具包/03-Altium-样板/smoke-test/offline-placement/node_modules/altiumts/dist/index.js"
const BASE = "D:/NeroZe/pcb布局/AD26_PCB自动布局_工具包/03-Altium-样板/smoke-test/Student-DCDC-Buck-Converter-b19eda1250a50166996a777ce6fc12f0e5d4e36d/"
const a = await import(pathToFileURL(LIB).href)
const out = (k, v) => console.log(`\n### ${k}\n${JSON.stringify(v, null, 2)}`)

const sch = a.parseAltiumFile(new Uint8Array(await readFile(BASE + "SCH1_Main.SchDoc"))).document
const pcb = a.parseAltiumFile(new Uint8Array(await readFile(BASE + "PCB4 (Final Design).PcbDoc"))).document

const coord = (r, key) => a.getSchematicCoordinate(r, { key, fallback: 0 })
const loc = (r) => ({ x: coord(r, "Location.X"), y: coord(r, "Location.Y") })
const seg = (r) => ({ a: { x: coord(r, "X1"), y: coord(r, "Y1") }, b: { x: coord(r, "X2"), y: coord(r, "Y2") } })
const num = (v) => { const n = Number.parseFloat(v); return Number.isFinite(n) ? n : undefined }
const d = (p, q) => Math.hypot(p.x - q.x, p.y - q.y)
function pointSegDist(p, s) {
  const vx = s.b.x - s.a.x, vy = s.b.y - s.a.y
  const wx = p.x - s.a.x, wy = p.y - s.a.y
  const L2 = vx * vx + vy * vy
  let t = L2 === 0 ? 0 : (wx * vx + wy * vy) / L2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (s.a.x + t * vx), p.y - (s.a.y + t * vy))
}

const pins = sch.pins.map(p => {
  const parent = sch.index.getParent(p)
  const des = parent && sch.getOwnedRecords(parent).find(r => r.type === "schematic-designator-record")
  return { rec: p, loc: loc(p), len: p.pinLengthSchematicUnits, conglom: p.pinConglomerate, code: (p.pinConglomerate ?? 0) & 3, designator: p.designator, name: p.name, comp: des?.get("Text") }
})
out("P4.pins", pins.map(p => ({ comp: p.comp, pin: p.designator, name: p.name, loc: p.loc, len: p.len, conglom: p.conglom, code: p.code })))
const wires = sch.wires.map(w => seg(w))
out("P4.wires", wires)

// 8 种映射 × 2 种符号约定，计算所有 pin 到最近 wire 线段的总距离
const dirSets = {
  "0R1U2L3D": ["right", "up", "left", "down"],
  "0R1D2L3U": ["right", "down", "left", "up"],
  "0L1U2R3D": ["left", "up", "right", "down"],
  "0L1D2R3U": ["left", "down", "right", "up"],
  "0U1R2D3L": ["up", "right", "down", "left"],
  "0U1L2D3R": ["up", "left", "down", "right"],
  "0D1R2U3L": ["down", "right", "up", "left"],
  "0D1L2U3R": ["down", "left", "up", "right"],
}
const vec = { right: [1, 0], left: [-1, 0], up: [0, 1], down: [0, -1] }
const evals = []
for (const [label, dirs] of Object.entries(dirSets)) {
  for (const sign of [1, -1]) {
    let total = 0
    const per = []
    for (const p of pins) {
      const [dx, dy] = vec[dirs[p.code]]
      const tip = { x: p.loc.x + sign * dx * p.len, y: p.loc.y + sign * dy * p.len }
      let best = Infinity
      for (const w of wires) best = Math.min(best, pointSegDist(tip, w))
      total += best
      per.push(best)
    }
    evals.push({ label, sign, total: Math.round(total * 1000) / 1000, within01: per.filter(x => x < 0.01).length })
  }
}
evals.sort((x, y) => x.total - y.total)
out("P4.directionMappingEval", evals)

// 采用最佳映射
const best = evals[0]
const dirs = dirSets[best.label]
function tipOf(p) {
  const [dx, dy] = vec[dirs[p.code]]
  return { x: p.loc.x + best.sign * dx * p.len, y: p.loc.y + best.sign * dy * p.len }
}
out("P4.bestTips", pins.map(p => ({ comp: p.comp, pin: p.designator, name: p.name, loc: p.loc, tip: tipOf(p), nearestWireDist: Math.min(...wires.map(w => pointSegDist(tipOf(p), w))) })))

// 连通重建：wire 线段 + pin tip + label/power/junction 位置
const TOL = 0.01
const items = []
for (const w of sch.wires) items.push({ kind: "wire", rec: w, s: seg(w) })
for (const p of pins) items.push({ kind: "pin", rec: p.rec, p: tipOf(p), pin: p })
for (const r of sch.records) {
  if (r.type === "schematic-net-label-record" || r.type === "schematic-power-port-record" || r.type === "schematic-junction-record") {
    items.push({ kind: r.type, rec: r, p: loc(r) })
  }
}
const parent = items.map((_, i) => i)
const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
const union = (i, j) => { const x = find(i), y = find(j); if (x !== y) parent[y] = x }

function wireConnects(w, p) { return pointSegDist(p, w) <= TOL }
for (let i = 0; i < items.length; i++) {
  for (let j = i + 1; j < items.length; j++) {
    const A = items[i], B = items[j]
    if (A.kind === "wire" && B.kind === "wire") {
      if (d(A.s.a, B.s.a) <= TOL || d(A.s.a, B.s.b) <= TOL || d(A.s.b, B.s.a) <= TOL || d(A.s.b, B.s.b) <= TOL) union(i, j)
    } else if (A.kind === "wire" && B.p) {
      if (wireConnects(A.s, B.p)) union(i, j)
    } else if (A.p && B.kind === "wire") {
      if (wireConnects(B.s, A.p)) union(i, j)
    } else if (A.p && B.p) {
      if (d(A.p, B.p) <= TOL) union(i, j)
    }
  }
}
const groups = new Map()
items.forEach((it, i) => { const g = find(i); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(it) })
const nets = []
for (const list of groups.values()) {
  const pinList = list.filter(x => x.kind === "pin").map(x => ({ comp: x.pin.comp, pin: x.pin.designator, name: x.pin.name }))
  const labelNames = list.filter(x => x.kind === "schematic-net-label-record").map(x => x.rec.get("Text")).filter(Boolean)
  const powerNames = list.filter(x => x.kind === "schematic-power-port-record").map(x => x.rec.get("Text") ?? x.rec.get("Name")).filter(Boolean)
  const wireCount = list.filter(x => x.kind === "wire").length
  const junctionCount = list.filter(x => x.kind === "schematic-junction-record").length
  nets.push({ names: [...new Set([...labelNames, ...powerNames])], pins: pinList, wires: wireCount, junctions: junctionCount })
}
out("P4.netCount", nets.length)
out("P4.nets", nets.filter(n => n.pins.length > 0 || n.names.length > 0).sort((x, y) => y.pins.length - x.pins.length))
out("P4.stats", {
  pinsInNets: nets.reduce((s, n) => s + n.pins.length, 0),
  multiPin: nets.filter(n => n.pins.length > 1).length,
  named: nets.filter(n => n.names.length > 0).length,
  unconnected: nets.filter(n => n.pins.length === 1 && n.names.length === 0).length,
})

// 与 PCB 对照
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
for (const n of nets) for (const p of n.pins) rows.push({ comp: p.comp, pin: p.pin, pinName: p.name, schNets: n.names, pcbNets: padNets.get(`${p.comp}|${p.pin}`) })
out("P4.crossRows", rows)
const matched = rows.filter(r => r.schNets.length > 0 && r.pcbNets && r.pcbNets.some(n => r.schNets.includes(n)))
out("P4.crossStats", { totalPins: rows.length, matchedNamed: matched.length, rowsWithoutPcbPad: rows.filter(r => !r.pcbNets).length })

// 电源端口记录样本
out("P4.powerPortRecords", sch.powerPorts.map(p => ({ text: p.get("Text"), style: p.get("Style"), loc: loc(p), fields: p.items.map(i => `${i.key}=${i.value}`).slice(0, 20) })))
out("P4.netLabelRecords", sch.netLabels.map(p => ({ text: p.get("Text"), loc: loc(p) })))

// PcbDoc: 铺铜记录类型与多边形引用
const pourTypes = {}
for (const pg of pcb.polygons) for (const r of pcb.getRecordsForPolygon(pg)) pourTypes[r.type] = (pourTypes[r.type] || 0) + 1
out("P4.pourRecordTypes", pourTypes)
const gndPoly = pcb.polygons.find(p => (p.name.startsWith("71,78,68,95")))
out("P4.polygonNameDecoded", { raw: gndPoly?.name, decoded: gndPoly ? String.fromCharCode(...gndPoly.name.split(",").map(Number)) : null })
out("P4.polygonRecords", pcb.getRecordsForPolygon(gndPoly).map(r => ({ type: r.type, layer: r.get("LAYER"), kind: r.get("KIND"), netIndex: r.get("NET"), holes: r.holeCount, geometryPoints: r.geometry?.outline?.points?.length, geometryHoles: r.geometry?.holes?.length })))

// 走线网络解析率按层
const trackLayers = {}
for (const t of pcb.tracks) {
  const L = t.get("LAYER")
  trackLayers[L] = trackLayers[L] || { total: 0, withNet: 0 }
  trackLayers[L].total++
  if (pcb.getNetForRecord(t)) trackLayers[L].withNet++
}
out("P4.trackNetByLayer", trackLayers)
