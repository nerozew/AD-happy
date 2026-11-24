import { readFile, writeFile } from "node:fs/promises";
import * as A from "file:///D:/NeroZe/pcb%E5%B8%83%E5%B1%80/AD26_PCB%E8%87%AA%E5%8A%A8%E5%B8%83%E5%B1%80_%E5%B7%A5%E5%85%B7%E5%8C%85/03-Altium-%E6%A0%B7%E6%9D%BF/smoke-test/offline-placement/node_modules/altiumts/dist/index.js";

const DIR =
  "D:/NeroZe/pcb布局/AD26_PCB自动布局_工具包/03-Altium-样板/smoke-test/Student-DCDC-Buck-Converter-b19eda1250a50166996a777ce6fc12f0e5d4e36d";
const sch = A.parseAltiumFile(
  new Uint8Array(await readFile(DIR + "/SCH1_Main.SchDoc"))
).document;

const TOL = 0.05;
class DS {
  constructor() { this.p = new Map(); }
  add(k) { if (!this.p.has(k)) this.p.set(k, k); }
  find(k) { this.add(k); const q = this.p.get(k); if (q === k) return k; const r = this.find(q); this.p.set(k, r); return r; }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p.set(rb, ra); }
}
const ds = new DS();
const nodes = new Map();
const key = (p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
const add = (k, rec, pt) => { ds.add(k); let n = nodes.get(k); if (!n) { n = { recs: new Set(), pt }; nodes.set(k, n); } n.recs.add(rec); };
const segs = [];
for (const w of sch.wires) {
  const pts = A.getSchematicRecordPoints(w);
  for (const pt of pts) add(key(pt), w, pt);
  for (let i = 1; i < pts.length; i++) { ds.union(key(pts[i - 1]), key(pts[i])); segs.push([pts[i - 1], pts[i]]); }
}
const dirFor = (c) => { const o = (c ?? 0) & 3; return o === 0 ? [1, 0] : o === 1 ? [0, 1] : o === 2 ? [-1, 0] : [0, -1]; };
const pinHot = new Map();
for (const p of sch.pins) {
  if (!p.position) continue;
  const [dx, dy] = dirFor(p.pinConglomerate ?? 0);
  const L = p.pinLengthSchematicUnits ?? 0;
  const hot = { x: p.position.x + dx * L, y: p.position.y + dy * L };
  pinHot.set(p, hot);
  add(key(hot), p, hot);
}
const attach = (pt, rec) => {
  for (const [a, b] of segs) {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    if (l2 === 0) continue;
    const t = ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / l2;
    if (t < -1e-9 || t > 1 + 1e-9) continue;
    const x = a.x + t * dx, y = a.y + t * dy;
    if (Math.hypot(pt.x - x, pt.y - y) < TOL) { add(key(pt), rec, pt); ds.union(key(pt), key(a)); }
  }
};
for (const p of sch.pins) { const h = pinHot.get(p); if (h) attach(h, p); }
for (const rec of [...sch.netLabels, ...sch.powerPorts, ...sch.ports]) {
  if (!rec.position) continue;
  add(key(rec.position), rec, rec.position);
  attach(rec.position, rec);
}
const groups = new Map();
for (const [k, n] of nodes) {
  const root = ds.find(k);
  let g = groups.get(root);
  if (!g) { g = { names: new Set(), recs: new Set() }; groups.set(root, g); }
  for (const r of n.recs) {
    g.recs.add(r);
    const nm = r instanceof A.AltiumSchNetLabelRecord || r instanceof A.AltiumSchPowerPortRecord ? r.text
      : r instanceof A.AltiumSchPortRecord ? r.name : undefined;
    if (nm) g.names.add(nm);
  }
}
const merged = [];
for (const g of groups.values()) {
  const names = new Set([...g.names].map((n) => n.toUpperCase()));
  const hit = merged.filter((m) => [...m.names].some((n) => names.has(n.toUpperCase())));
  if (hit.length === 0 || names.size === 0) { merged.push({ names: new Set(g.names), recs: new Set(g.recs) }); continue; }
  const t = hit[0];
  for (const n of g.names) t.names.add(n);
  for (const r of g.recs) t.recs.add(r);
  for (const d of hit.slice(1)) { for (const n of d.names) t.names.add(n); for (const r of d.recs) t.recs.add(r); merged.splice(merged.indexOf(d), 1); }
}
const compOf = new Map();
for (const c of sch.components) {
  const d = sch.getOwnedRecords(c).find((r) => r.recordKind === "34");
  compOf.set(c, d?.text);
}
const compInfo = [];
for (const c of sch.components) {
  const recs = sch.getOwnedRecords(c);
  const des = recs.find((r) => r.recordKind === "34")?.text;
  const params = recs.filter((r) => r.recordKind === "41").map((r) => ({ name: r.name, text: r.text }));
  const get = (n) => params.find((p) => p.name === n)?.text;
  let value = get("Value") ?? get("Comment") ?? "";
  if (value === "=Value") value = get("Value") ?? "";
  const listRec = recs.find((r) => r.recordKind === "44");
  let footprint = null;
  if (listRec) {
    const idx = sch.records.indexOf(listRec);
    const impl = sch.records.filter(
      (r) => r.recordKind === "45" &&
        Number(r.fields?.find((f) => f.key === "OwnerIndex")?.value) === idx
    );
    footprint = impl[0]?.fields?.find((f) => f.key === "ModelName")?.value ?? null;
  }
  const pins = sch.pins
    .filter((p) => sch.records[p.ownerIndex] === c)
    .map((p) => ({
      number: p.designator,
      name: p.name,
      type: String(p.electricalType),
      x: p.position?.x ?? 0,
      y: p.position?.y ?? 0,
    }));
  compInfo.push({
    reference: des,
    value,
    lib_id: `AD:${c.libraryReference}`,
    footprint: footprint ?? "",
    part_number: get("Part Number") ?? "",
    pins,
  });
}
const netOut = {};
const pinNet = {};
let unnamed = 0;
for (const m of merged) {
  const names = [...m.names];
  const name = names.length ? names[0] : `__unnamed_${++unnamed}`;
  const pins = [...m.recs]
    .filter((r) => r instanceof A.AltiumSchPinRecord)
    .map((p) => {
      const owner = sch.records[p.ownerIndex];
      return {
        component: compOf.get(owner),
        pin_number: p.designator,
        pin_name: p.name,
        pin_type: String(p.electricalType),
        x: p.position?.x ?? 0,
        y: p.position?.y ?? 0,
      };
    });
  netOut[name] = { pins };
  for (const p of pins) pinNet[`${p.component}|${p.pin_number}`] = [name, p.pin_name];
}
const powerRails = [...new Set(sch.powerPorts.map((p) => p.text))];
await writeFile(
  new URL("./ctx.json", import.meta.url),
  JSON.stringify({ components: compInfo, nets: netOut, pin_net: pinNet, power_rails: powerRails }, null, 1)
);
console.log("components", compInfo.length, "nets", Object.keys(netOut).length, "rails", powerRails);
for (const [n, v] of Object.entries(netOut)) {
  console.log(n, v.pins.map((p) => `${p.component}.${p.pin_number}`).join(","));
}
