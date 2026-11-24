// 第六轮：完整原理图网络重建（多段 wire + 引脚尖端 + 名称归并），对照 PCB 焊盘网络
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
const vec = { right: [1, 0], left: [-1, 0], up: [0, 1], down: [0, -1] }
const dirs = ["right", "up", "left", "down"] // code 0..3，实测最佳映射
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
  const code = (p.pinConglomerate ?? 0) & 3
  const len = p.pinLengthSchematicUnits ?? 0
  const [dx, dy] = vec[dirs[code]]
  const l = loc(p)
  return { rec: p, loc: l, tip: { x: l.x + dx * len, y: l.y + dy * len }, len, code, pin: p.designator, name: p.name, comp: des?.get("Text") }
})

const wirePoints = sch.wires.map(w => a.getSchematicRecordPoints(w))
const wireSegs = []
for (const pts of wirePoints) for (let i = 1; i < pts.length; i++) wireSegs.push({ a: pts[i - 1], b: pts[i] })
out("P6.wireVertexCounts", wirePoints.map(p => p.length))
out("P6.pinTipDistances", pins.map(p => ({
  comp: p.comp, pin: p.pin, tip: p.tip,
  minDistToWire: Math.min(...wireSegs.map(s => pointSegDist(p.tip, s))),
  nearestVertex: Math.min(...wirePoints.flat().map(v => d(p.tip, v))),
})))

// 连通：wire 段共享顶点、pin/label/power/junction 点落在段上或顶点
const TOL = 0.01
const items = []
wireSegs.forEach((s, i) => items.push({ kind: "seg", id: `seg${i}`, s }))
pins.forEach(p => items.push({ kind: "pin", p: p.tip, pin: p }))
const labels = sch.netLabels.map(r => ({ kind: "label", p: loc(r), name: r.get("Text"), rec: r }))
const powers = sch.powerPorts.map(r => ({ kind: "power", p: loc(r), name: r.get("Text") ?? r.get("Name"), rec: r }))
const junctions = sch.records.filter(r => r.type === "schematic-junction-record").map(r => ({ kind: "junction", p: loc(r), rec: r }))
items.push(...labels, ...powers, ...junctions)

const parent = items.map((_, i) => i)
const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
const union = (i, j) => { const x = find(i), y = find(j); if (x !== y) parent[y] = x }

function segsTouch(A, B) {
  // 端点重合或 T 形相接
  return d(A.a, B.a) <= TOL || d(A.a, B.b) <= TOL || d(A.b, B.a) <= TOL || d(A.b, B.b) <= TOL ||
    pointSegDist(A.a, B) <= TOL || pointSegDist(A.b, B) <= TOL || pointSegDist(B.a, A) <= TOL || pointSegDist(B.b, A) <= TOL
}
function pointOnSeg(p, s) { return pointSegDist(p, s) <= TOL }
for (let i = 0; i < items.length; i++) {
  for (let j = i + 1; j < items.length; j++) {
    const A = items[i], B = items[j]
    if (A.kind === "seg" && B.kind === "seg") { if (segsTouch(A.s, B.s)) union(i, j) }
    else if (A.kind === "seg" && B.p) { if (pointOnSeg(B.p, A.s)) union(i, j) }
    else if (B.kind === "seg" && A.p) { if (pointOnSeg(A.p, B.s)) union(i, j) }
    else if (A.p && B.p) { if (d(A.p, B.p) <= TOL) union(i, j) }
  }
}
// 按组汇总
const groups = new Map()
items.forEach((it, i) => { const g = find(i); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(it) })
const rawNets = []
for (const list of groups.values()) {
  const pinList = list.filter(x => x.kind === "pin").map(x => ({ comp: x.pin.comp, pin: x.pin.pin, name: x.pin.name }))
  const names = [...new Set(list.filter(x => x.kind === "label" || x.kind === "power").map(x => x.name).filter(Boolean))]
  rawNets.push({ names, pins: pinList })
}
// 同名网络归并（同一原理图页内）
const nameToIdx = new Map()
const merged = []
for (const n of rawNets) {
  const key = n.names.sort().join("|")
  if (key && nameToIdx.has(key)) {
    const target = merged[nameToIdx.get(key)]
    for (const p of n.pins) if (!target.pins.some(q => q.comp === p.comp && q.pin === p.pin)) target.pins.push(p)
  } else {
    const entry = { names: n.names, pins: n.pins }
    merged.push(entry)
    if (key) nameToIdx.set(key, merged.length - 1)
  }
}
out("P6.mergedNetCount", merged.length)
out("P6.mergedNets", merged.filter(n => n.pins.length > 0 || n.names.length > 0).sort((x, y) => y.pins.length - x.pins.length))
out("P6.pinCoverage", {
  totalPins: pins.length,
  pinsInNamedNet: merged.filter(n => n.names.length > 0).reduce((s, n) => s + n.pins.length, 0),
  pinsInUnnamedNet: merged.filter(n => n.names.length === 0).reduce((s, n) => s + n.pins.length, 0),
  unnamedPinNets: merged.filter(n => n.names.length === 0 && n.pins.length > 0).map(n => n.pins),
})

// PCB 焊盘网络
const padNets = new Map()
for (const c of pcb.components) {
  for (const r of pcb.getRecordsOwnedByComponent(c)) {
    if (r.type !== "pad-record") continue
    const k = `${c.designator}|${r.get("NAME")}`
    if (!padNets.has(k)) padNets.set(k, new Set())
    padNets.get(k).add(pcb.getNetForRecord(r)?.name)
  }
}
const rows = []
for (const n of merged) for (const p of n.pins) rows.push({
  comp: p.comp, pin: p.pin, pinName: p.name,
  schNets: n.names, pcbNets: [...(padNets.get(`${p.comp}|${p.pin}`) ?? [])],
})
out("P6.crossRows", rows)
const c1 = rows.filter(r => r.schNets.length > 0 && r.pcbNets.some(n => r.schNets.includes(n)))
const c2 = rows.filter(r => r.schNets.length === 0 && r.pcbNets.length > 0)
out("P6.crossStats", {
  totalPins: rows.length,
  exactNameMatch: c1.length,
  unnamedSchematicPins: c2.map(r => `${r.comp}.${r.pin} pcb=${r.pcbNets.join(",")}`),
  noPcbPad: rows.filter(r => r.pcbNets.length === 0).map(r => `${r.comp}.${r.pin}`),
  wrong: rows.filter(r => r.schNets.length > 0 && !r.pcbNets.some(n => r.schNets.includes(n))).map(r => `${r.comp}.${r.pin} sch=${r.schNets.join(",")} pcb=${r.pcbNets.join(",")}`),
})

// 把未命名单网络与 PCB 网络比对，验证结构是否一致（集合形状）
out("P6.unnamedNetSignatures", merged.filter(n => n.names.length === 0 && n.pins.length > 0).map(n => ({
  pins: n.pins.map(p => `${p.comp}.${p.pin}`),
  pcbNetsSeen: [...new Set(n.pins.flatMap(p => [...(padNets.get(`${p.comp}.${p.pin}`) ?? [])]))],
})))

// 网络名与 PCB 网络集合比较
out("P6.nameSets", {
  schNames: [...new Set(merged.flatMap(n => n.names))].sort(),
  pcbNames: pcb.nets.map(n => n.name).sort(),
})
