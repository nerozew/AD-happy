import { readFile, writeFile } from "node:fs/promises";
import * as A from "file:///D:/NeroZe/pcb%E5%B8%83%E5%B1%80/AD26_PCB%E8%87%AA%E5%8A%A8%E5%B8%83%E5%B1%80_%E5%B7%A5%E5%85%B7%E5%8C%85/03-Altium-%E6%A0%B7%E6%9D%BF/smoke-test/offline-placement/node_modules/altiumts/dist/index.js";

const DIR =
  "D:/NeroZe/pcb布局/AD26_PCB自动布局_工具包/03-Altium-样板/smoke-test/Student-DCDC-Buck-Converter-b19eda1250a50166996a777ce6fc12f0e5d4e36d";
const doc = A.parseAltiumFile(
  new Uint8Array(await readFile(DIR + "/PCB4 (Final Design).PcbDoc"))
).document;

const MIL = 0.0254;
const netNames = {};
doc.nets.forEach((n, i) => { netNames[i + 1] = n.name; });
const netNum = (idx) => (idx === undefined || idx === 65535 || idx === -1 ? 0 : idx + 1);

function fields(r) {
  return Object.fromEntries(r.fields.map((f) => [f.key, f.value]));
}
function mil(v) {
  if (v === undefined || v === null) return 0;
  return parseFloat(String(v).replace("mil", "")) * MIL;
}

const footprints = doc.components.map((c) => {
  const pads = doc.pads
    .filter((p) => p.componentIndex === doc.components.indexOf(c))
    .map((p) => {
      const f = fields(p);
      return {
        number: p.name,
        type: f.PADSTACKMODE === "THRU" || Number(f.HOLESIZE) > 0 ? "thru_hole" : "smd",
        shape: (p.shape || "rect").toLowerCase(),
        width: mil(f.XSIZE),
        height: mil(f.YSIZE),
        abs_x: p.position.x * MIL,
        abs_y: p.position.y * MIL,
        angle: p.rotation || 0,
        drill: mil(f.HOLESIZE),
        net_number: netNum(p.netIndex),
        net_name: netNames[netNum(p.netIndex)] || "",
        layers: [p.layer === "BOTTOM" ? "B.Cu" : "F.Cu"],
      };
    });
  return {
    reference: c.designator,
    value: c.comment || "",
    layer: c.side === "bottom" ? "B.Cu" : "F.Cu",
    x: c.position.x * MIL,
    y: c.position.y * MIL,
    angle: c.rotation || 0,
    pads,
  };
});

const segments = [];
for (const t of doc.tracks) {
  const f = fields(t);
  if (!["TOP", "BOTTOM", "MULTILAYER"].includes(f.LAYER)) continue;
  if (f.NET === "65535") continue;
  segments.push({
    x1: parseFloat(f.X1) * MIL,
    y1: parseFloat(f.Y1) * MIL,
    x2: parseFloat(f.X2) * MIL,
    y2: parseFloat(f.Y2) * MIL,
    width: parseFloat(f.WIDTH) * MIL,
    layer: f.LAYER === "BOTTOM" ? "B.Cu" : "F.Cu",
    net: Number(f.NET) + 1,
  });
}
const vias = [];
for (const v of doc.vias) {
  const f = fields(v);
  if (f.NET === "65535") continue;
  vias.push({
    x: parseFloat(f.X) * MIL,
    y: parseFloat(f.Y) * MIL,
    size: parseFloat(f.DIAMETER) * MIL,
    drill: parseFloat(f.HOLESIZE) * MIL,
    net: Number(f.NET) + 1,
  });
}

const geo = A.getPcbBoardGeometry(doc);
const b = geo.layerStackRegions[0].outline.bounds;
const board_outline = {
  bounding_box: {
    min_x: b.minX * MIL,
    min_y: b.minY * MIL,
    max_x: b.maxX * MIL,
    max_y: b.maxY * MIL,
    width: (b.maxX - b.minX) * MIL,
    height: (b.maxY - b.minY) * MIL,
  },
  points: geo.layerStackRegions[0].outline.points.map((p) => ({ x: p.x * MIL, y: p.y * MIL })),
};

const rules = {};
for (const r of doc.rules) {
  rules[r.ruleKind] = r;
}
const design_rules = {
  clearance: mil(fields(rules.Clearance).GAP),
  track_width: mil(fields(rules.Width).MINLIMIT ?? fields(rules.Width).MAXLIMIT),
};

await writeFile(
  new URL("./pcb.json", import.meta.url),
  JSON.stringify(
    {
      footprints,
      tracks: { segments, arcs: [] },
      vias: { vias },
      net_names: netNames,
      board_outline,
      design_rules,
      copper_track_count: segments.length,
    },
    null,
    1
  )
);
console.log("footprints", footprints.length, "pads", footprints.reduce((n, f) => n + f.pads.length, 0), "copper tracks", segments.length, "vias", vias.length);
console.log("board", board_outline.bounding_box.width.toFixed(2), "x", board_outline.bounding_box.height.toFixed(2), "mm");
console.log("clearance rule", design_rules.clearance, "width rule", design_rules.track_width);
