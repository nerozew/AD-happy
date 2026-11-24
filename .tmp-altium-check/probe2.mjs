// 第二轮：原理图容差连通重建 + 引脚/焊盘网表对照 + PCB 几何/规则细节
import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

const LIB = "D:/NeroZe/pcb布局/AD26_PCB自动布局_工具包/03-Altium-样板/smoke-test/offline-placement/node_modules/altiumts/dist/index.js"
const BASE = "D:/NeroZe/pcb布局/AD26_PCB自动布局_工具包/03-Altium-样板/smoke-test/Student-DCDC-Buck-Converter-b19eda1250a50166996a777ce6fc12f0e5d4e36d/"
const a = await import(pathToFileURL(LIB).href)
const out = (k, v) => console.log(`\n### ${k}\n${JSON.stringify(v, null, 2)}`)
const round = (v) => Math.round(v * 10000) / 10000

const sch = a.parseAltiumFile(new Uint8Array(await readFile(BASE + "SCH1_Main.SchDoc"))).document
const pcb = a.parseAltiumFile(new Uint8Array(await readFile(BASE + "PCB4 (Final Design).PcbDoc"))).document

// ---- 1. 组件身份：位号/注释/MPN/封装 ----
const components = sch.components.map(c => {
  const owned = sch.getOwnedRecords(c)
  const des = owned.find(r => r.type === "schematic-designator-record")
  const params = owned.filter(r => r.type === "schematic-parameter-record")
  const commentParam = params.find(r => r.get("Name") === "Comment")
  const implRecords = sch.records.filter(r => /implementation/i.test(r.type))
  return {
    uniqueId: c.uniqueId,
    designatorFromGetter: c.designator,
    designatorFromOwned: des?.get("Text"),
    commentFromGetter: c.comment,
    commentFromOwned: commentParam?.get("Text"),
    mpnDesignItemId: c.designItemId,
    libRef: c.libraryReference,
    currentPartId: c.currentPartId,
    paramNames: params.map(p => p.get("Name")),
  }
})
out("SCH.components", components)
out("SCH.implRecords", sch.records.filter(r => /implementation/i.test(r.type)).map(r => ({
  type: r.type, ownerIndex: r.get("OwnerIndex"),
  items: r.items.map(i => `${i.key}=${i.value}`).slice(0, 24),
})))
out("SCH.allRecordTypesWithImpl", [...new Set(sch.records.filter(r => /implementation|map/i.test(r.type)).map(r => r.type))])

// ---- 2. 用容差自建原理图连通性 ----
function coord(record, keys) {
  // keys: [[xKey,yKey]]
  for (const [xk, yk] of keys) {
    const x = a.getSchematicCoordinate ? null : null
  }
}
function pointOf(record, xk = "Location.X", yk = "Location.Y") {
  const xi = Number.parseFloat(record.get(xk) ?? "NaN")
  const xf = Number.parseFloat(record.get(xk + "_FRAC") ?? "0")
  const yi = Number.parseFloat(record.get(yk) ?? "NaN")
  const yf = Number.parseFloat(record.get(yk + "_FRAC") ?? "0")
  if (!Number.isFinite(xi) || !Number.isFinite(yi)) return undefined
  return { x: xi + xf / 100000, y: yi + yf / 100000 }
}
function num(v) { const n = Number.parseFloat(v); return Number.isFinite(n) ? n : undefined }
function recPoints(r) {
  if (r.type === "schematic-wire-record") {
    return [
      { x: num(r.get("X1")) + (num(r.get("X1_FRAC")) ?? 0) / 100000, y: num(r.get("Y1")) + (num(r.get("Y1_FRAC")) ?? 0) / 100000 },
      { x: num(r.get("X2")) + (num(r.get("X2_FRAC")) ?? 0) / 100000, y: num(r.get("Y2")) + (num(r.get("Y2_FRAC")) ?? 0) / 100000 },
    ]
  }
  if (r.type === "schematic-pin-record" || r.type === "schematic-net-label-record" || r.type === "schematic-power-port-record" || r.type === "schematic-junction-record") {
    const p = pointOf(r)
    return p ? [p] : []
  }
  return []
}

const TOL = 0.01
const nodes = []  // {p, rec}
const add = (p, rec) => { if (p) nodes.push({ p, rec }) }
for (const r of sch.records) {
  if (r.type === "schematic-wire-record") {
    const pts = recPoints(r)
    nodes.push({ p: pts[0], rec: r, end: 0 })
    nodes.push({ p: pts[1], rec: r, end: 1 })
  } else if (["schematic-pin-record", "schematic-net-label-record", "schematic-power-port-record", "schematic-junction-record"].includes(r.type)) {
    for (const p of recPoints(r)) nodes.push({ p, rec: r })
  }
}
// 空间分桶做并查集
const parent = nodes.map((_, i) => i)
function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
function union(i, j) { const a1 = find(i), b1 = find(j); if (a1 !== b1) parent[b1] = a1 }
const cell = new Map()
const keyOf = (x, y) => `${Math.round(x / TOL)},${Math.round(y / TOL)}`
for (let i = 0; i < nodes.length; i++) {
  const k = keyOf(nodes[i].p.x, nodes[i].p.y)
  if (!cell.has(k)) cell.set(k, [])
  cell.get(k).push(i)
}
for (let i = 0; i < nodes.length; i++) {
  const cx = Math.round(nodes[i].p.x / TOL), cy = Math.round(nodes[i].p.y / TOL)
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const arr = cell.get(`${cx + dx},${cy + dy}`) || []
    for (const j of arr) {
      if (j <= i) continue
      if (Math.hypot(nodes[i].p.x - nodes[j].p.x, nodes[i].p.y - nodes[j].p.y) <= TOL) {
        // 同一 wire 的两端不并（wire 本身就是连接），但同点不同 wire 要并
        union(i, j)
      }
    }
  }
}
// wire 两端自身并起来（若同一 wire 两端相距 > TOL）
const nodeIdxByWireEnd = new Map()
nodes.forEach((n, i) => {
  if (n.rec.type === "schematic-wire-record") {
    if (!nodeIdxByWireEnd.has(n.rec)) nodeIdxByWireEnd.set(n.rec, [])
    nodeIdxByWireEnd.get(n.rec)[n.end] = i
  }
})
for (const arr of nodeIdxByWireEnd.values()) if (arr[0] !== undefined && arr[1] !== undefined) union(arr[0], arr[1])

const groups = new Map()
for (let i = 0; i < nodes.length; i++) {
  const g = find(i)
  if (!groups.has(g)) groups.set(g, [])
  groups.get(g).push(nodes[i])
}
const designatorByOwnerIndex = new Map()
for (const c of sch.components) {
  const des = sch.getOwnedRecords(c).find(r => r.type === "schematic-designator-record")
  const idx = Number.parseInt(c.get("OwnerIndex") ?? "", 10)
  designatorByOwnerIndex.set(Number.isFinite(idx) ? idx : c.get("OwnerIndex"), des?.get("Text"))
}
// ownerIndex 是 record 的字段（OwnedBy 索引）
out("SCH.designatorMap", [...designatorByOwnerIndex.entries()])

const nets = []
for (const [g, list] of groups) {
  const pins = list.filter(n => n.rec.type === "schematic-pin-record").map(n => {
    const owner = n.rec.get("OwnerIndex")
    return { comp: designatorByOwnerIndex.get(owner) ?? `owner:${owner}`, pin: n.rec.get("Designator"), name: n.rec.get("Name") }
  })
  const labels = list.filter(n => n.rec.type === "schematic-net-label-record").map(n => n.rec.get("Text"))
  const power = list.filter(n => n.rec.type === "schematic-power-port-record").map(n => n.rec.get("Text") ?? n.rec.get("Name"))
  const wires = list.filter(n => n.rec.type === "schematic-wire-record").length
  const junc = list.filter(n => n.rec.type === "schematic-junction-record").length
  nets.push({ names: [...new Set([...labels, ...power])], pins, wireEnds: wires, junctions: junc, size: list.length })
}
out("SCH.unionFindNetCount", nets.length)
out("SCH.unionFindNets", nets.filter(n => n.pins.length > 0 || n.names.length > 0))
out("SCH.netStats", {
  pinsInNets: nets.reduce((s, n) => s + n.pins.length, 0),
  totalPins: sch.pins.length,
  netsWithMultiplePins: nets.filter(n => n.pins.length > 1).length,
  netsNamed: nets.filter(n => n.names.length > 0).length,
  unconnectedPinNets: nets.filter(n => n.pins.length === 1 && n.names.length === 0).length,
})

// 检查 pin 到最近 wire 端点的距离，证明坐标分数截断问题
const dists = []
for (const p of sch.pins) {
  const pp = pointOf(p)
  let best = Infinity
  for (const r of sch.wires) {
    for (const wp of recPoints(r)) best = Math.min(best, Math.hypot(pp.x - wp.x, pp.y - wp.y))
  }
  dists.push(best)
}
dists.sort((a, b) => a - b)
out("SCH.pinToNearestWireEndpointDistance", { min: dists[0], median: dists[Math.floor(dists.length / 2)], max: dists[dists.length - 1], within1e3: dists.filter(d => d < 0.001).length, within0_01: dists.filter(d => d < 0.01).length })

// ---- 3. 引脚-焊盘对照（用容差重建结果 vs PCB） ----
const pcbPadMap = new Map()
for (const c of pcb.components) {
  for (const r of pcb.getRecordsOwnedByComponent(c)) {
    if (r.type !== "pad-record") continue
    const net = pcb.getNetForRecord(r)?.name
    const k = `${c.designator}|${r.get("NAME")}`
    if (!pcbPadMap.has(k)) pcbPadMap.set(k, [])
    pcbPadMap.get(k).push(net)
  }
}
const schPinRows = []
for (const n of nets) {
  for (const p of n.pins) {
    const netName = n.names[0] ?? "(unnamed)"
    schPinRows.push({ comp: p.comp, pin: p.pin, schNet: netName, pcbNets: pcbPadMap.get(`${p.comp}|${p.pin}`) })
  }
}
out("CROSS.pinPadRows", schPinRows)
const mismatches = schPinRows.filter(r => !r.pcbNets || !r.pcbNets.includes(r.schNet))
out("CROSS.mismatchCount", { total: schPinRows.length, mismatch: mismatches.length, rows: mismatches })

// ---- 4. PCB 几何详情 ----
const padDetail = pcb.pads.slice(0, 22).map(p => ({
  comp: pcb.getComponentForRecord(p)?.designator, number: p.get("NAME"), shape: p.get("SHAPE"),
  x: p.get("X"), y: p.get("Y"), xsize: p.get("XSIZE"), ysize: p.get("YSIZE"),
  hole: p.get("HOLESIZE"), plated: p.get("PLATED"), layer: p.get("LAYER"),
  net: pcb.getNetForRecord(p)?.name, rotation: p.get("ROTATION"),
  maskExpansion: p.get("SOLDERMASKEXPANSION_MANUAL"), pasteExpansion: p.get("PASTEMASKEXPANSION_MANUAL"),
}))
out("PCB.padDetail", padDetail)

out("PCB.trackSummary", {
  count: pcb.tracks.length,
  layers: [...new Set(pcb.tracks.map(t => t.get("LAYER")))],
  widths: [...new Set(pcb.tracks.map(t => t.get("WIDTH")))],
  netsResolved: pcb.tracks.filter(t => pcb.getNetForRecord(t)).length,
  sample: pcb.tracks.slice(0, 4).map(t => ({ layer: t.get("LAYER"), net: pcb.getNetForRecord(t)?.name, x1: t.get("X1"), y1: t.get("Y1"), x2: t.get("X2"), y2: t.get("Y2"), width: t.get("WIDTH") })),
})
out("PCB.viaSummary", {
  count: pcb.vias.length,
  fields: pcb.vias[0] ? pcb.vias[0].items.map(i => `${i.key}=${i.value}`) : null,
  netsResolved: pcb.vias.filter(v => pcb.getNetForRecord(v)).length,
})
out("PCB.regionSummary", pcb.regions.map(r => ({
  layer: r.layer, kind: r.regionKind, isBoardCutout: r.isBoardCutout, isGeneratedPour: r.isGeneratedPour,
  isPolygonCutout: r.isPolygonCutout, isLayerStackRegion: r.isLayerStackRegion,
  net: r.netIndex !== undefined ? pcb.getNetByIndex(r.netIndex)?.name : undefined,
  holes: r.holeCount, outlinePoints: r.geometry.outline.points.length,
})))
out("PCB.polygonSummary", pcb.polygons.map(p => ({
  name: p.name, layer: p.layer, net: p.netIndex !== undefined ? pcb.getNetByIndex(p.netIndex)?.name : undefined,
  type: p.polygonType, shelved: p.shelved, pourIndex: p.pourIndex, priority: p.priority,
  fields: p.items.map(i => `${i.key}=${i.value}`).slice(0, 25),
})))

// 铜皮实际填充：检查每个 polygon 是否有 generated pour region
out("PCB.polygonPourCoverage", pcb.polygons.map(p => ({
  name: p.name,
  regionsForPolygon: pcb.getRecordsForPolygon(p).filter(r => r.type === "region-record").length,
  recordsForPolygon: pcb.getRecordsForPolygon(p).length,
})))

// ---- 5. 规则完整性与类别统计 ----
out("PCB.ruleNames", pcb.rules.map(r => ({ name: r.name, kind: r.ruleKind, cat: r.category, enabled: r.enabled })))
out("PCB.ruleFieldCoverage", {
  withClearance: pcb.rules.filter(r => r.clearanceMils !== undefined).length,
  withWidth: pcb.rules.filter(r => r.widthConstraint !== undefined).length,
  withVia: pcb.rules.filter(r => r.viaDiameterConstraint !== undefined).length,
  withLayers: pcb.rules.filter(r => r.layerConstraints?.length).length,
  withDiffPair: pcb.rules.filter(r => r.differentialPairGap !== undefined).length,
  withImpedance: pcb.rules.filter(r => r.impedanceConstraint !== undefined).length,
  withThermal: pcb.rules.filter(r => r.thermalRelief !== undefined).length,
  withMask: pcb.rules.filter(r => r.maskExpansionMils !== undefined).length,
  withHeight: pcb.rules.filter(r => r.heightConstraint !== undefined).length,
  withHole: pcb.rules.filter(r => r.holeSizeConstraint !== undefined).length,
  withTestpoint: pcb.rules.filter(r => r.testPointSettings !== undefined).length,
  withRoutingLayers: pcb.rules.filter(r => r.routingLayers?.length).length,
})
out("PCB.clearanceRules", pcb.rules.filter(r => r.category === "clearance").map(r => ({ name: r.name, clearanceMils: r.clearanceMils, scope1: r.scope1Expression, scope2: r.scope2Expression })))
out("PCB.widthRules", pcb.rules.filter(r => r.widthConstraint !== undefined).map(r => ({ name: r.name, width: r.widthConstraint, layers: r.layerConstraints, scope1: r.scope1Expression })))

// ---- 6. 版本/单位/来源 ----
out("PCB.meta", {
  boardVersion: pcb.board?.version,
  boardFileName: pcb.board?.fileName,
  displayUnit: pcb.board?.displayUnit,
  origin: pcb.board?.origin,
  uniqueIdRecords: pcb.getRecordsByKind("unique-id-primitive-information-record").length,
})
out("SCH.meta", {
  sheetRecordFields: sch.records.find(r => r.type === "schematic-sheet-record")?.items.map(i => `${i.key}=${i.value}`).slice(0, 30),
})

// ---- 7. 变体 ----
const prj = a.parseAltiumPrjPcb(await readFile(BASE + "DCDC Buck Converter.PrjPcb", "utf8"))
out("PRJ.variantsRaw", prj.lines.filter(l => /variant/i.test(l.type === "ini-section-line" ? l.name : (l.type === "ini-key-value-line" ? l.key : ""))).map(l => l.getString?.()).slice(0, 40))
