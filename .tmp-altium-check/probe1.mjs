// 实测 altiumts 对 Buck 样板工程的离线解析能力
import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

const LIB = "D:/NeroZe/pcb布局/AD26_PCB自动布局_工具包/03-Altium-样板/smoke-test/offline-placement/node_modules/altiumts/dist/index.js"
const BASE = "D:/NeroZe/pcb布局/AD26_PCB自动布局_工具包/03-Altium-样板/smoke-test/Student-DCDC-Buck-Converter-b19eda1250a50166996a777ce6fc12f0e5d4e36d/"
const a = await import(pathToFileURL(LIB).href)

const out = (k, v) => console.log(`\n### ${k}\n${typeof v === "string" ? v : JSON.stringify(v, null, 2)}`)

// ---------- PrjPcb ----------
const prjText = await readFile(BASE + "DCDC Buck Converter.PrjPcb", "utf8")
const prj = a.parseAltiumPrjPcb(prjText)
out("PrjPcb.documents", prj.documents.map(d => ({ path: d.path, kind: d.kind, uniqueId: d.uniqueId })))
out("PrjPcb.variants", prj.variants.map(v => ({ name: v.name, description: v.description })))
out("PrjPcb.projectParameters", prj.projectParameters.map(p => ({ key: p.key, value: p.value })))
out("PrjPcb.documentGraph", prj.getDocumentGraph(BASE).nodes.map(n => ({ path: n.path, kind: n.kind })))

// ---------- SchDoc ----------
const schBytes = new Uint8Array(await readFile(BASE + "SCH1_Main.SchDoc"))
const schDet = a.detectAltiumFile(schBytes)
out("SchDoc.detection", { container: schDet.container, kind: schDet.documentKind, encoding: schDet.encoding })
const schParsed = a.parseAltiumFile(schBytes)
const sch = schParsed.document
out("SchDoc.class", sch.constructor.name)
out("SchDoc.sourceFormat", sch.sourceFormat)
out("SchDoc.recordCount", sch.records.length)
out("SchDoc.components", sch.components.map(c => ({
  designator: c.designator,
  comment: c.comment,
  libraryReference: c.libraryReference,
  designItemId: c.designItemId,
  currentPartId: c.currentPartId,
  uniqueId: c.uniqueId,
  fields: c.items.map(i => `${i.key}=${i.value}`).slice(0, 30),
})))
out("SchDoc.counts", {
  pins: sch.pins.length, wires: sch.wires.length, labels: sch.labels.length,
  netLabels: sch.netLabels.length, powerPorts: sch.powerPorts.length,
  ports: sch.ports.length, sheetSymbols: sch.sheetSymbols.length,
  sheetLinks: sch.sheetLinks.length, parameterSets: sch.parameterSets.length,
  differentialPairs: sch.differentialPairs.length,
})
out("SchDoc.pinsSample", sch.pins.slice(0, 15).map(p => ({
  designator: p.designator, name: p.name, electricalType: p.electricalType,
  ownerIndex: p.ownerIndex, ownerPartId: p.ownerPartId, uniqueId: p.uniqueId,
})))
out("SchDoc.kinds", Object.fromEntries([...new Set(sch.records.map(r => r.type))].map(t => [t, sch.records.filter(r => r.type === t).length])))

// netGraph
let netGraphSummary
try {
  const ng = sch.netGraph
  netGraphSummary = {
    netCount: ng.nets.length,
    nets: ng.nets.slice(0, 40).map(n => ({
      id: n.id, names: n.names, recordCount: n.records.length,
      recordKinds: Object.fromEntries([...new Set(n.records.map(r => r.type))].map(t => [t, n.records.filter(r => r.type === t).length])),
      pins: n.records.filter(r => r.type === "schematic-pin-record").map(r => ({ pin: r.designator, name: r.name, owner: r.ownerIndex })),
    })),
    netsWithoutName: ng.nets.filter(n => n.names.length === 0).length,
    pinNetResolvable: sch.pins.filter(p => ng.getNetForRecord(p)).length,
    pinTotal: sch.pins.length,
  }
} catch (e) {
  netGraphSummary = { error: String(e && e.stack || e) }
}
out("SchDoc.netGraph", netGraphSummary)

// per-component owned records incl parameters
out("SchDoc.componentOwnedSample", sch.components.slice(0, 3).map(c => ({
  designator: c.designator,
  owned: sch.getOwnedRecords(c).map(r => ({ type: r.type, items: r.items.map(i => `${i.key}=${i.value}`) })),
})))

// ---------- PcbDoc ----------
const pcbBytes = new Uint8Array(await readFile(BASE + "PCB4 (Final Design).PcbDoc"))
const pcbDet = a.detectAltiumFile(pcbBytes)
out("PcbDoc.detection", { container: pcbDet.container, kind: pcbDet.documentKind, encoding: pcbDet.encoding })
const pcbParsed = a.parseAltiumFile(pcbBytes)
const pcb = pcbParsed.document
out("PcbDoc.class", pcb.constructor.name)
out("PcbDoc.aliasBoard", typeof pcb.boardGeometry)  // 触发 lazy getter 检查
out("PcbDoc.counts", {
  records: pcb.records.length,
  components: pcb.components.length,
  nets: pcb.nets.length,
  pads: pcb.pads.length,
  tracks: pcb.tracks.length,
  arcs: pcb.arcs.length,
  vias: pcb.vias.length,
  regions: pcb.regions.length,
  polygons: pcb.polygons.length,
  rules: pcb.rules.length,
  fills: pcb.fills.length,
  texts: pcb.texts.length,
  models: pcb.models.length,
})
out("PcbDoc.kinds", Object.fromEntries([...new Set(pcb.records.map(r => r.type))].map(t => [t, pcb.records.filter(r => r.type === t).length])))
out("PcbDoc.streamSummaries", pcb.streamSummaries.map(s => ({ family: s.family, decodedPrimitive: s.decodedPrimitiveRecordCount, decodedProperty: s.decodedPropertyRecordCount, declared: s.declaredRecordCount })))

const board = pcb.board
out("PcbDoc.boardRecord", board ? {
  fileName: board.fileName, version: board.version, displayUnit: board.displayUnit,
  origin: board.origin, sheetOrigin: board.sheetOrigin, sheetSize: board.sheetSize,
  outlinePointCount: board.outline?.points?.length,
  outlineWinding: board.outline?.winding,
  outlineExplicitlyClosed: board.outline?.isExplicitlyClosed,
} : null)

// boardGeometry
let bg
try {
  const g = pcb.boardGeometry
  bg = {
    outlinePoints: g.outline.points.length,
    outlineVertices: g.outline.vertices.slice(0, 10),
    outlineWinding: g.outline.winding,
    cutouts: g.cutouts.length,
    polygonCutouts: g.polygonCutouts.length,
    layerStackRegions: g.layerStackRegions.length,
    bounds: a.getAltiumBounds ? null : undefined,
  }
} catch (e) { bg = { error: String(e && e.stack || e) } }
out("PcbDoc.boardGeometry", bg)

// layer stack
let stack
try {
  const s = board ? a.getPcbLayerStack(board) : null
  stack = s ? {
    name: s.name, style: s.style, isFlex: s.isFlex,
    entries: s.entries.map(e => ({ index: e.index, name: e.name, layerId: e.layerId, source: e.source, copperThickness: e.copperThickness, dielectricHeight: e.dielectricHeight, dielectricMaterial: e.dielectricMaterial, dielectricConstant: e.dielectricConstant })),
    subStacks: s.subStacks.length, layerPairs: s.layerPairs.length,
    impedanceProfiles: s.impedanceProfiles.length,
    traceImpedanceConfigurations: s.traceImpedanceConfigurations.length,
  } : null
} catch (e) { stack = { error: String(e && e.stack || e) } }
out("PcbDoc.layerStack", stack)
out("PcbDoc.documentLayerStackEntries", (() => { try { return a.getAltiumPcbDocumentLayerStackEntries(pcb).map(e => ({ index: e.index, name: e.name })) } catch (e) { return { error: String(e) } } })())

// rules
out("PcbDoc.rulesDetail", pcb.rules.map(r => ({
  name: r.name, ruleKind: r.ruleKind, category: r.category, enabled: r.enabled,
  priority: r.priority, scope1: r.scope1Expression, scope2: r.scope2Expression,
  clearanceMils: r.clearanceMils, width: r.widthConstraint,
  viaDiameter: r.viaDiameterConstraint, viaHole: r.viaHoleConstraint,
  routingLayers: r.routingLayers,
  diffPairGap: r.differentialPairGap,
  minMaskSliver: r.minimumSolderMaskSliverMils,
  minSilkClearance: r.minimumSilkClearanceMils,
})))

// components with pad nets
out("PcbDoc.components", pcb.components.map(c => ({
  id: c.id, designator: c.designator, comment: c.comment, footprint: c.footprint,
  position: c.position, rotation: c.rotation, side: c.side, mirrored: c.mirrored,
  channelOffset: c.channelOffset, sourceUniqueId: c.sourceUniqueId,
  sourceHierarchicalPath: c.sourceHierarchicalPath,
  padCount: pcb.getRecordsOwnedByComponent(c).filter(r => r.type === "pad-record").length,
})))

const padsSample = pcb.pads.slice(0, 12).map(p => ({
  type: p.type,
  keys: p.items.map(i => i.key),
  name: p.get("NAME"), number: p.get("NUMBER"), layer: p.get("LAYER"),
  net: p.get("NET"), component: p.get("COMPONENT"), x: p.get("X"), y: p.get("Y"),
  xpad: p.get("XPAD") ?? p.get("X2") ?? p.get("XTOP"), ypad: p.get("YPAD") ?? p.get("Y2"),
  topx: p.get("TOPSIZE"), midx: p.get("MIDSIZE"), botx: p.get("BOTSIZE"),
  hole: p.get("HOLESIZE"), plated: p.get("PLATED"), shape: p.get("SHAPE"),
  padNetResolvable: !!pcb.getNetForRecord(p),
  padComponentResolvable: !!pcb.getComponentForRecord(p),
}))
out("PcbDoc.padsSample", padsSample)
out("PcbDoc.padNetCoverage", {
  padsWithNetField: pcb.pads.filter(p => p.get("NET") !== undefined).length,
  padsNetResolved: pcb.pads.filter(p => pcb.getNetForRecord(p)).length,
  padsWithComponent: pcb.pads.filter(p => pcb.getComponentForRecord(p)).length,
  padCount: pcb.pads.length,
})

// connectivity graph
let conn
try {
  const cg = pcb.connectivity
  conn = {
    edges: cg.edges.length,
    edgeSample: cg.edges.slice(0, 5).map(e => ({ net: e.net.name, component: e.component?.designator, primitiveKinds: e.primitives.map(p => p.type) })),
    netsForFirstComponent: cg.getNetsForComponent(pcb.components[0]).map(n => n.name),
  }
} catch (e) { conn = { error: String(e && e.stack || e) } }
out("PcbDoc.connectivity", conn)

// net records
out("PcbDoc.nets", pcb.nets.map(n => n.name))
out("PcbDoc.netsOnPads", (() => {
  const s = new Set()
  for (const p of pcb.pads) { const n = pcb.getNetForRecord(p); if (n) s.add(n.name) }
  return [...s]
})())

// dangling refs
out("PcbDoc.dangling", pcb.index.getDanglingReferences().length)
