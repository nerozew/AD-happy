// 第五轮：检查 SchDoc 原始 CFB 流，确认 wire 记录是否被解析器漏掉
import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

const LIB = "D:/NeroZe/pcb布局/AD26_PCB自动布局_工具包/03-Altium-样板/smoke-test/offline-placement/node_modules/altiumts/dist/index.js"
const BASE = "D:/NeroZe/pcb布局/AD26_PCB自动布局_工具包/03-Altium-样板/smoke-test/Student-DCDC-Buck-Converter-b19eda1250a50166996a777ce6fc12f0e5d4e36d/"
const a = await import(pathToFileURL(LIB).href)
const out = (k, v) => console.log(`\n### ${k}\n${JSON.stringify(v, null, 2)}`)

const sch = a.parseAltiumFile(new Uint8Array(await readFile(BASE + "SCH1_Main.SchDoc"))).document
const cf = sch.compoundFile
out("CFB.streams", cf.streams.map(s => ({ path: s.path.join("/"), size: s.content.length })))
out("CFB.storages", cf.storages ? cf.storages.map(s => s.path.join("/")) : null)

const dec = new TextDecoder("latin1")
for (const s of cf.streams) {
  const text = dec.decode(s.content)
  const counts = {}
  for (const m of text.matchAll(/RECORD=(\d+)/g)) counts[m[1]] = (counts[m[1]] || 0) + 1
  const u16 = new TextDecoder("utf-16le").decode(s.content)
  const u16counts = {}
  for (const m of u16.matchAll(/RECORD=(\d+)/g)) u16counts[m[1]] = (u16counts[m[1]] || 0) + 1
  out(`STREAM.${s.path.join("/")}`, {
    size: s.content.length,
    asciiRecordCounts: counts,
    utf16RecordCounts: u16counts,
    asciiSample: text.includes("RECORD=27") ? text.slice(Math.max(0, text.indexOf("RECORD=27") - 120), text.indexOf("RECORD=27") + 300) : undefined,
  })
}

// SchDoc 所有 wire 原始字段 + owner
out("SCH.wireFields", sch.wires.map(w => ({ items: w.items.map(i => `${i.key}=${i.value}`), owner: w.ownerIndex, index: w.indexInSheet })))
out("SCH.junctionFields", sch.records.filter(r => r.type === "schematic-junction-record").map(r => r.items.map(i => `${i.key}=${i.value}`)))
out("SCH.recordPositionsNearMissing", (() => {
  // 找所有记录位置接近 (429.134,472.441) 或 (543.307,385.827) 的
  const near = (x, y) => {
    const res = []
    for (const r of sch.records) {
      const xi = Number.parseFloat(r.get("Location.X")); const xf = Number.parseFloat(r.get("Location.X_Frac") ?? "0")
      const yi = Number.parseFloat(r.get("Location.Y")); const yf = Number.parseFloat(r.get("Location.Y_Frac") ?? "0")
      if (![xi, yi].every(Number.isFinite)) continue
      const px = xi + xf / 100000, py = yi + yf / 100000
      if (Math.hypot(px - x, py - y) < 5) res.push({ type: r.type, at: { x: px, y: py }, items: r.items.map(i => `${i.key}=${i.value}`).slice(0, 10) })
    }
    return res
  }
  return { nearVINTip: near(429.13409, 472.4412), nearGNDTip: near(543.30738, 385.82698) }
})())
