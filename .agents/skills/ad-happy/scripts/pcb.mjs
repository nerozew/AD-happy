// PcbDoc 解析：把 Altium PCB 文档转成后续 PCB 检测器消费的 PcbSnapshot。
import { readFileSync } from 'node:fs'
import {
  getPcbBoardGeometry,
  getPcbComponents,
  getPcbLayerStack,
  getPcbNets,
  getPcbRecordComponentIndex,
  getPcbRecordNetIndex,
  getPcbRecordRule,
  getPcbRecordsOwnedByComponent,
  parseAltiumFile,
  parseAltiumMeasurementToMils,
} from 'altiumts'

const MIL_TO_MM = 0.0254
// PcbDoc 的 65535 表示「无索引」；快照统一记 -1，适配层 +1 后正好落到 KiCad 的 0（无网络）。
const NO_INDEX = -1
// 层叠条目的来源优先级：v8 是主层叠，v7/legacy 是旧格式的机械层镜像。
const STACK_SOURCES = ['v8', 'v7', 'legacy']

/**
 * @param {string} path PcbDoc 文件路径
 * @returns {{
 *   components: Array<{ reference: string, value: string, footprint: string, mpn: string, description: string, x: number, y: number, angle: number, layer: string }>,
 *   pads: Array<{ componentIndex: number, netIndex: number, name: string, x: number, y: number, drillMil: number, plated: boolean, type: 'smd' | 'thru_hole' | 'np_thru_hole' }>,
 *   nets: string[],
 *   tracks: Array<{ netIndex: number, layer: string, widthMil: number, x1: number, y1: number, x2: number, y2: number }>,
 *   arcs: Array<{ netIndex: number, layer: string, widthMil: number, x: number, y: number, radiusMil: number, startAngle: number, endAngle: number }>,
 *   vias: Array<{ netIndex: number, x: number, y: number, drillMil: number, diameterMil: number }>,
 *   rules: Array<{ kind: string, name: string }>,
 *   layerStack: Array<{ name: string, copper: boolean }>,
 *   outline: { widthMm: number, heightMm: number }
 * }}
 */
export function parsePcb(path) {
  const { document: doc } = parseAltiumFile(new Uint8Array(readFileSync(path)))
  const stackEntries = readStackEntries(doc)
  const components = getPcbComponents(doc)

  return {
    components: components.map(toComponent),
    pads: collectPads(doc, components.length),
    nets: getPcbNets(doc).map(net => net.name ?? ''),
    tracks: doc.tracks
      .filter(record => isCopperLayerName(record.getCaseInsensitive('LAYER') ?? '', stackEntries))
      .map(record => toTrack(doc, record)),
    // 圆弧走线与直线走线一样参与线宽、间距与连通性检查；只保留铜层。
    arcs: doc.arcs
      .filter(record => isCopperLayerName(record.getCaseInsensitive('LAYER') ?? '', stackEntries))
      .map(record => toArc(doc, record)),
    vias: doc.vias
      .filter(record => isCopperLayerName(record.getCaseInsensitive('LAYER') ?? '', stackEntries))
      .map(record => toVia(doc, record)),
    rules: doc.rules.map(record => {
      const rule = getPcbRecordRule(doc, record) ?? record
      return { kind: rule.ruleKind ?? '', name: rule.name ?? '' }
    }),
    layerStack: readLayerStack(stackEntries),
    outline: readOutline(doc),
  }
}

function toComponent(record) {
  const position = record.position ?? { x: 0, y: 0 }
  return {
    reference: record.designator ?? '',
    // COMMENT 在部分 PcbDoc 中不存在；此时 value 为空，由 BOM 层回退到原理图值。
    value: record.comment ?? '',
    footprint: record.footprint ?? '',
    // MPN 不是 PcbDoc 的标准字段；只有元件记录显式带型号参数时才取值。
    mpn: readComponentMpn(record),
    description: record.getCaseInsensitive('SOURCEDESCRIPTION') ?? '',
    x: position.x * MIL_TO_MM,
    y: position.y * MIL_TO_MM,
    angle: record.rotation ?? 0,
    layer: record.getCaseInsensitive('LAYER') ?? (record.side === 'bottom' ? 'BOTTOM' : 'TOP'),
  }
}

// 型号字段名归一化后匹配；PcbDoc 通常没有 MPN，匹配不到时返回空串，不猜。
const MPN_COMPONENT_FIELDS = new Set([
  'mpn',
  'manufacturerpartnumber',
  'manufacturerpartno',
  'mfrpartnumber',
  'mfrpartno',
  'partnumber',
  'partno',
])

function readComponentMpn(record) {
  for (const item of record.items ?? []) {
    // 与原理图侧一致：去掉结尾序号（MPN1、Manufacturer Part Number 1）。
    const key = String(item?.key ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]/gu, '')
      .replace(/\d+$/u, '')
    if (!MPN_COMPONENT_FIELDS.has(key)) continue
    const text = String(item?.value ?? '').trim()
    if (text) return text
  }
  return ''
}

// 焊盘按元件归属收集；未归属任何元件的焊盘（COMPONENT=65535）也保留，componentIndex 记 -1。
function collectPads(doc, componentCount) {
  const pads = []
  const seen = new Set()
  for (let index = 0; index < componentCount; index++) {
    for (const record of getPcbRecordsOwnedByComponent(doc, index)) {
      if (record.recordKind !== 'Pad') continue
      seen.add(record)
      pads.push(toPad(doc, record, index))
    }
  }
  for (const record of doc.pads) {
    if (seen.has(record)) continue
    pads.push(toPad(doc, record, getPcbRecordComponentIndex(doc, record) ?? NO_INDEX))
  }
  return pads
}

function toPad(doc, record, componentIndex) {
  // HOLESIZE 为 0 表示 SMD；PLATED 只对通孔焊盘有意义。两者都按原始字段
  // 保留，不在解析层猜测。
  const drillMil = measurementMils(record, 'HOLESIZE')
  const plated = readBoolean(record, 'PLATED')
  return {
    componentIndex,
    netIndex: getPcbRecordNetIndex(doc, record) ?? NO_INDEX,
    name: record.name ?? record.getCaseInsensitive('NAME') ?? '',
    x: measurementMils(record, 'X') * MIL_TO_MM,
    y: measurementMils(record, 'Y') * MIL_TO_MM,
    drillMil,
    plated,
    // 下游 DFM 用 type 区分 PTH / NPTH / SMD；由钻孔与镀覆字段派生。
    type: padType(drillMil, plated),
  }
}

function padType(drillMil, plated) {
  if (!(drillMil > 0)) return 'smd'
  return plated ? 'thru_hole' : 'np_thru_hole'
}

function readBoolean(record, key) {
  const raw = record.getCaseInsensitive(key)
  if (raw === undefined) return false
  if (typeof raw === 'boolean') return raw
  return ['true', '1', 'yes'].includes(String(raw).trim().toLowerCase())
}

function toTrack(doc, record) {
  return {
    netIndex: getPcbRecordNetIndex(doc, record) ?? NO_INDEX,
    layer: record.getCaseInsensitive('LAYER') ?? '',
    widthMil: measurementMils(record, 'WIDTH'),
    x1: measurementMils(record, 'X1') * MIL_TO_MM,
    y1: measurementMils(record, 'Y1') * MIL_TO_MM,
    x2: measurementMils(record, 'X2') * MIL_TO_MM,
    y2: measurementMils(record, 'Y2') * MIL_TO_MM,
  }
}

function toVia(doc, record) {
  return {
    netIndex: getPcbRecordNetIndex(doc, record) ?? NO_INDEX,
    x: measurementMils(record, 'X') * MIL_TO_MM,
    y: measurementMils(record, 'Y') * MIL_TO_MM,
    drillMil: measurementMils(record, 'HOLESIZE'),
    // 过孔外径（DIAMETER）是环宽检查的必需输入，缺失时下游记 0 并降级。
    diameterMil: measurementMils(record, 'DIAMETER'),
  }
}

// 圆弧走线：中心点、半径、起止角；下游按三点（起/中/终）还原几何。
function toArc(doc, record) {
  const center = record.center ?? { x: 0, y: 0 }
  return {
    netIndex: getPcbRecordNetIndex(doc, record) ?? NO_INDEX,
    layer: record.getCaseInsensitive('LAYER') ?? '',
    widthMil: record.widthMils ?? measurementMils(record, 'WIDTH'),
    x: center.x * MIL_TO_MM,
    y: center.y * MIL_TO_MM,
    radiusMil: record.radiusMils ?? measurementMils(record, 'RADIUS'),
    startAngle: record.startAngle ?? record.getNumber('STARTANGLE') ?? 0,
    endAngle: record.endAngle ?? record.getNumber('ENDANGLE') ?? 360,
  }
}

function measurementMils(record, key) {
  const raw = record.getCaseInsensitive(key)
  if (raw === undefined) return 0
  return parseAltiumMeasurementToMils(raw) ?? 0
}

function readStackEntries(doc) {
  const board = doc.board
  return board ? getPcbLayerStack(board).entries : []
}

// 只取主层叠来源（优先 v8）并按层名去重，避免 v7 的机械层镜像重复出现。
function readLayerStack(entries) {
  const source = STACK_SOURCES.find(candidate => entries.some(entry => entry.source === candidate))
  const selected = source === undefined ? entries : entries.filter(entry => entry.source === source)
  const seen = new Set()
  const layers = []
  for (const entry of selected) {
    if (!entry.name) continue
    const key = normalizeLayerName(entry.name)
    if (seen.has(key)) continue
    seen.add(key)
    layers.push({ name: entry.name, copper: isCopperLayerName(entry.name, entries) })
  }
  return layers
}

function readOutline(doc) {
  const { outline } = getPcbBoardGeometry(doc)
  const bounds = outline.bounds ?? boundsOf(outline.points)
  if (!bounds) return { widthMm: 0, heightMm: 0 }
  return {
    widthMm: (bounds.maxX - bounds.minX) * MIL_TO_MM,
    heightMm: (bounds.maxY - bounds.minY) * MIL_TO_MM,
  }
}

function boundsOf(points) {
  if (points.length === 0) return undefined
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const { x, y } of points) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  return { minX, minY, maxX, maxY }
}

function normalizeLayerName(name) {
  return name.replace(/[\s_-]/gu, '').toUpperCase()
}

// Altium 层 ID 的族号：256 = 信号层，257 = 内电层（都是铜）；258 = 机械层，259 = 系统层。
function getSignalLayerName(layerId) {
  const id = Number(layerId)
  if (!Number.isSafeInteger(id)) return undefined
  const family = Math.floor(id / 65536)
  const ordinal = id % 65536
  if (family === 256) {
    if (ordinal === 1) return 'TOP'
    if (ordinal >= 2 && ordinal <= 31) return `MID${ordinal - 1}`
    if (ordinal === 65535) return 'BOTTOM'
  }
  if (family === 257 && ordinal >= 1 && ordinal <= 16) return `INTERNALPLANE${ordinal}`
  return undefined
}

// 铜层判定：先认 Altium 的标准层名，再用层叠条目的层 ID 族号兜底。
// MULTILAYER 是复合铜层伪层（过孔位于该层），按铜处理。
function isCopperLayerName(name, stackEntries) {
  const normalized = normalizeLayerName(name)
  if (/^(?:TOP|TOPLAYER|BOTTOM|BOTTOMLAYER|MULTILAYER)$/u.test(normalized)) return true
  if (isNumberedLayer(normalized, 'MID', 30) || isNumberedLayer(normalized, 'MIDLAYER', 30)) return true
  if (isNumberedLayer(normalized, 'PLANE', 16) || isNumberedLayer(normalized, 'INTERNALPLANE', 16)) return true
  const entry = stackEntries.find(item => item.name !== undefined && normalizeLayerName(item.name) === normalized)
  return getSignalLayerName(entry?.layerId) !== undefined
}

function isNumberedLayer(normalized, prefix, maximum) {
  const match = new RegExp(`^(?:${prefix})(\\d{1,2})$`, 'u').exec(normalized)
  if (!match) return false
  const ordinal = Number(match[1])
  return ordinal >= 1 && ordinal <= maximum
}
