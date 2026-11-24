// 第七轮：补齐封装关联、层叠铜层、版本信息、铺铜字段、变体与原生证据
import { readFile, readdir } from "node:fs/promises"
import { pathToFileURL } from "node:url"

const LIB = "D:/NeroZe/pcb布局/AD26_PCB自动布局_工具包/03-Altium-样板/smoke-test/offline-placement/node_modules/altiumts/dist/index.js"
const BASE = "D:/NeroZe/pcb布局/AD26_PCB自动布局_工具包/03-Altium-样板/smoke-test/Student-DCDC-Buck-Converter-b19eda1250a50166996a777ce6fc12f0e5d4e36d/"
const a = await import(pathToFileURL(LIB).href)
const out = (k, v) => console.log(`\n### ${k}\n${JSON.stringify(v, null, 2)}`)

const sch = a.parseAltiumFile(new Uint8Array(await readFile(BASE + "SCH1_Main.SchDoc"))).document
const pcb = a.parseAltiumFile(new Uint8Array(await readFile(BASE + "PCB4 (Final Design).PcbDoc"))).document
const prjText = await readFile(BASE + "DCDC Buck Converter.PrjPcb", "utf8")
const prj = a.parseAltiumPrjPcb(prjText)

// 1. 原理图封装关联
function designatorOfComponent(c) {
  return sch.getOwnedRecords(c).find(r => r.type === "schematic-designator-record")?.get("Text")
}
const implByComp = []
for (const c of sch.components) {
  const list = sch.getOwnedRecords(c).find(r => r.type === "schematic-implementation-list-record")
  const impls = list ? sch.getOwnedRecords(list) : []
  implByComp.push({
    comp: designatorOfComponent(c),
    implListRecord: !!list,
    ownedByList: impls.map(r => ({ type: r.type, modelName: r.get("ModelName"), modelType: r.get("ModelType") })),
    // 尝试直接用 implList 的 IndexInSheet / index 找 implementation
    allImpls: sch.records.filter(r => r.type === "schematic-implementation-record").map(r => ({ owner: r.get("OwnerIndex"), model: r.get("ModelName") })),
  })
}
out("P7.schFootprintAssociation", implByComp.slice(0, 3))
out("P7.schFootprintMethods", {
  getOwnedOfListWorked: implByComp.some(x => x.ownedByList.length > 0),
  implRecordsTotal: sch.records.filter(r => r.type === "schematic-implementation-record").length,
})
// 二次尝试：implementation 记录的 OwnerIndex 指向 implementation-list 的 IndexInSheet；list 没有 IndexInSheet，但可以按 sheet record 序列位置推断
const listOrder = sch.records.filter(r => r.type === "schematic-implementation-list-record" || r.type === "schematic-implementation-record")
out("P7.implOwnerChainSample", listOrder.slice(0, 6).map(r => ({ type: r.type, owner: r.get("OwnerIndex"), indexInSheet: r.get("IndexInSheet"), model: r.get("ModelName") })))

// 2. 层叠铜层顺序
const stack = a.getPcbLayerStack(pcb.board)
out("P7.stackSummary", {
  name: stack.name, style: stack.style, isFlex: stack.isFlex,
  copperEntries: stack.entries.filter(e => a.isAltiumPcbCopperLayerName(e.name, stack)).map(e => ({ name: e.name, index: e.index, id: e.layerId, source: e.source, copper: e.copperThickness?.raw })),
  dielectricEntries: stack.entries.filter(e => /Dielectric/i.test(e.name ?? "")).map(e => ({ name: e.name, index: e.index, height: e.dielectricHeight?.raw, material: e.dielectricMaterial, dk: e.dielectricConstant })),
  subStacks: stack.subStacks.map(s => ({ index: s.index, name: s.name, source: s.source, type: s.type })),
  layerPairs: stack.layerPairs.map(p => ({ low: p.lowLayer, high: p.highLayer, subStacks: p.subStackIds })),
  firstEntries: stack.entries.slice(0, 8).map(e => ({ name: e.name, index: e.index, source: e.source, next: e.next, previous: e.previous })),
})

// 3. 版本信息与单位
out("P7.versionInfo", {
  pcbFileVersionRecord: pcb.getRecordsByKind("file-version-info-record").map(r => r.items.map(i => `${i.key}=${i.value}`)),
  boardFields: pcb.board?.items.map(i => `${i.key}=${i.value}`).filter(s => /^(VERSION|ORIGIN|DISPLAYUNIT|LAYERS|SHEET)/i.test(s)),
  schHeader: sch.header?.items?.map(i => `${i.key}=${i.value}`).slice(0, 20),
  prjVersionLines: prj.lines.filter(l => l.type === "ini-key-value-line" && /version/i.test(l.key)).map(l => `${l.key}=${l.value}`).slice(0, 20),
})
out("P7.unitsEvidence", {
  boardOutline: pcb.boardGeometry.outline.points,
  padXExamples: pcb.pads.slice(0, 3).map(p => ({ x: p.get("X"), y: p.get("Y"), xsize: p.get("XSIZE"), ysize: p.get("YSIZE") })),
  trackWidthExamples: pcb.tracks.slice(0, 3).map(t => t.get("WIDTH")),
  viaDiameters: pcb.vias.slice(0, 3).map(v => ({ d: v.get("DIAMETER"), hole: v.get("HOLESIZE") })),
})

// 4. 铺铜区域字段
const poly = pcb.polygons.find(p => p.name.startsWith("71,78,68,95"))
out("P7.pourRegionFields", pcb.getRecordsForPolygon(poly).map(r => ({
  fields: r.items.map(i => `${i.key}=${i.value}`).slice(0, 30),
  geometryBounds: (() => { const pts = r.geometry.outline.vertices.map(v => v.position); return { minX: Math.min(...pts.map(p => p.x)), maxX: Math.max(...pts.map(p => p.x)), minY: Math.min(...pts.map(p => p.y)), maxY: Math.max(...pts.map(p => p.y)), n: pts.length } })(),
})))

// 5. 元件注释/字段
out("P7.pcbComponentFieldCoverage", pcb.components.map(c => ({
  designator: c.designator, comment: c.comment, footprint: c.footprint,
  hasCommentField: c.items.some(i => /COMMENT/i.test(i.key)),
  allFields: c.items.map(i => `${i.key}=${i.value}`).filter(s => /COMMENT|DESCRIPT|FOOTPRINT|SOURCE|CHANNEL|NAME/i.test(s)),
})))

// 6. 变体、BOM、OutJob/原生报告文件
out("P7.projectRootFiles", (await readdir(BASE)).sort())
out("P7.projectVariants", { parserVariants: prj.variants, variantSectionPresent: prjText.includes("Variant") })
out("P7.projectDocs", prj.documents.map(d => ({ path: d.path, kind: d.kind })))
out("P7.projectSettings", prj.projectParameters.slice(0, 6))

// 7. 规则可解释性：scope 表达式样本、未知类别
out("P7.ruleScopeExprs", [...new Set(pcb.rules.map(r => r.scope1Expression))])
out("P7.ruleCategories", Object.fromEntries(Object.entries(pcb.rules.reduce((m, r) => { m[r.category] = (m[r.category] || 0) + 1; return m }, {}))))

// 8. 走线/过孔/焊盘全量网络覆盖率
out("P7.netCoverage", {
  pads: { total: pcb.pads.length, net: pcb.pads.filter(x => pcb.getNetForRecord(x)).length },
  tracks: { total: pcb.tracks.length, net: pcb.tracks.filter(x => pcb.getNetForRecord(x)).length },
  vias: { total: pcb.vias.length, net: pcb.vias.filter(x => pcb.getNetForRecord(x)).length },
  fills: pcb.fills.length,
  arcs: pcb.arcs.length,
})

// 9. 焊盘完整字段（3 个样本）
out("P7.padFields", pcb.pads.slice(0, 3).map(p => p.items.map(i => `${i.key}=${i.value}`)))
