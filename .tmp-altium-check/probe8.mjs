// 第八轮：库文件支持、值表达式解析、走线分层、焊盘/引脚编号完整性
import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

const LIB = "D:/NeroZe/pcb布局/AD26_PCB自动布局_工具包/03-Altium-样板/smoke-test/offline-placement/node_modules/altiumts/dist/index.js"
const BASE = "D:/NeroZe/pcb布局/AD26_PCB自动布局_工具包/03-Altium-样板/smoke-test/Student-DCDC-Buck-Converter-b19eda1250a50166996a777ce6fc12f0e5d4e36d/"
const a = await import(pathToFileURL(LIB).href)
const out = (k, v) => console.log(`\n### ${k}\n${JSON.stringify(v, null, 2)}`)

const sch = a.parseAltiumFile(new Uint8Array(await readFile(BASE + "SCH1_Main.SchDoc"))).document
const pcb = a.parseAltiumFile(new Uint8Array(await readFile(BASE + "PCB4 (Final Design).PcbDoc"))).document

// 1. 库文件解析支持
for (const f of ["PCB_Lib.PcbLib", "SCH_Lib.SchLib", "DCDC Buck Converter.IntLib"]) {
  try {
    const parsed = a.parseAltiumFile(new Uint8Array(await readFile(BASE + f)))
    out(`LIB.${f}`, { ok: true, kind: parsed.detection.documentKind, cls: parsed.document.constructor.name })
  } catch (e) {
    out(`LIB.${f}`, { ok: false, name: e.constructor.name, message: String(e.message).slice(0, 200) })
  }
}

// 2. 参数表达式解析（C2 Comment =Value）
const c2 = sch.components.find(c => sch.getOwnedRecords(c).find(r => r.type === "schematic-designator-record")?.get("Text") === "C2")
const owned = sch.getOwnedRecords(c2)
const params = owned.filter(r => r.type === "schematic-parameter-record")
out("P8.c2Params", params.map(p => ({ name: p.get("Name"), text: p.get("Text") })))
try {
  const resolved = a.resolveSchematicParameterReferenceWithContext ? a.resolveSchematicParameterReferenceWithContext("=Value", { component: c2, document: sch }) : "no-api"
  out("P8.resolveExpression", resolved)
} catch (e) { out("P8.resolveExpression", { error: String(e.message) }) }
try {
  out("P8.resolveSimple", a.resolveSchematicParameterReference ? a.resolveSchematicParameterReference({ input: "=Value", component: c2, document: sch }) : "no-api")
} catch (e) { out("P8.resolveSimple", { error: String(e.message) }) }

// 3. 走线分层与铜层网络
const layerStats = {}
for (const t of pcb.tracks) {
  const L = t.get("LAYER")
  layerStats[L] = layerStats[L] || { total: 0, net: 0, widths: new Set() }
  layerStats[L].total++
  if (pcb.getNetForRecord(t)) layerStats[L].net++
  layerStats[L].widths.add(t.get("WIDTH"))
}
out("P8.trackLayerStats", Object.fromEntries(Object.entries(layerStats).map(([k, v]) => [k, { total: v.total, net: v.net, widths: [...v.widths] }])))

// 4. 引脚/焊盘编号完整性
out("P8.pinPadNumbers", {
  schPinsWithoutDesignator: sch.pins.filter(p => !p.designator).length,
  schPinsWithoutName: sch.pins.filter(p => !p.name).length,
  schPinsWithoutElectrical: sch.pins.filter(p => p.electricalType === undefined).length,
  pcbPadsWithoutName: pcb.pads.filter(p => !p.get("NAME")).length,
  pcbPadsWithoutNet: pcb.pads.filter(p => !p.get("NET")).length,
  pcbComponentsWithoutDesignator: pcb.components.filter(c => !c.designator).length,
  pcbComponentsWithoutFootprint: pcb.components.filter(c => !c.footprint).length,
})

// 5. 设计规则：全部规则名与类别，标注 key 约束是否可得
out("P8.ruleInventory", pcb.rules.map(r => ({
  name: r.name, kind: r.ruleKind, category: r.category, enabled: r.enabled, priority: r.priority,
  scope1: r.scope1Expression, scope2: r.scope2Expression,
  constraints: {
    clearance: r.clearanceMils, width: r.widthConstraint, layer: r.layerConstraints,
    viaD: r.viaDiameterConstraint, viaHole: r.viaHoleConstraint, diff: r.differentialPairGap,
    impedance: r.impedanceConstraint, thermal: r.thermalRelief, mask: r.maskExpansionMils,
    height: r.heightConstraint, hole: r.holeSizeConstraint, silk: r.minimumSilkClearanceMils,
    maskSliver: r.minimumSolderMaskSliverMils, testpoint: r.testPointSettings, routingLayers: r.routingLayers,
  },
})))

// 6. 板框几何：弧段支持、闭合、层叠区域
out("P8.boardGeometryKinds", {
  outline: pcb.boardGeometry.outline.vertices.map(v => v.kind),
  cutouts: pcb.boardGeometry.cutouts.map(c => c.outline.vertices.map(v => v.kind)),
  layerStackRegions: pcb.boardGeometry.layerStackRegions.map(c => ({ kinds: c.outline.vertices.map(v => v.kind), holes: c.holes.length })),
  polygonCutouts: pcb.boardGeometry.polygonCutouts.map(c => ({ kinds: c.outline.vertices.map(v => v.kind), holes: c.holes.length })),
})

// 7. 原理图页数/层级
out("P8.schHierarchy", {
  sheetSymbols: sch.sheetSymbols.length,
  sheetLinks: sch.sheetLinks.length,
  ports: sch.ports.length,
  crossSheetConnectors: sch.records.filter(r => /port|cross/i.test(r.type)).map(r => r.type),
})

// 8. PCB 注释/描述
out("P8.pcbDescriptions", pcb.components.map(c => ({ d: c.designator, comment: c.comment, desc: c.get("SOURCEDESCRIPTION"), libref: c.sourceLibraryReference })))
