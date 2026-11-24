// SchDoc 解析：把 Altium 原理图文档转成后续连通性引擎消费的 SchSnapshot。
import { readFileSync } from 'node:fs'
import { getSchematicRecordPoints, parseAltiumFile } from 'altiumts'

// 引脚方向向量：PINCONGLOMERATE 低 2 位是 1/4 圈数，与 altiumts 渲染器一致（原理图 Y 轴向上）。
// 0 → +X，1 → +Y，2 → -X，3 → -Y。
// Task 5 的连接点公式：hotspot = (x, y) + lengthMil × PIN_DIRECTIONS[orientation]。
export const PIN_DIRECTIONS = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
]

// Altium 的 TPinElectrical 序数：0 Input、1 IO、2 Output、3 OpenCollector、4 Passive、
// 5 HiZ、6 OpenEmitter、7 Power、8 Power2。统一枚举没有 HiZ/OpenEmitter，记 unspecified。
const ELECTRICAL_BY_NUMBER = ['input', 'bidirectional', 'output', 'open_collector', 'passive', 'unspecified', 'unspecified', 'power', 'power']
// 库生成的 ASCII 可能用名称而非数字；去掉分隔符后归一。
const ELECTRICAL_BY_NAME = {
  input: 'input',
  io: 'bidirectional',
  output: 'output',
  bidirectional: 'bidirectional',
  bidi: 'bidirectional',
  passive: 'passive',
  power: 'power',
  power2: 'power',
  powerin: 'power',
  powerout: 'power',
  opencollector: 'open_collector',
  openemitter: 'unspecified',
  hiz: 'unspecified',
  tristate: 'unspecified',
  notconnected: 'unspecified',
  unspecified: 'unspecified',
}

/**
 * 坐标为 mil（altiumts 原样输出，不做换算），与 Task 5 的容差单位一致。
 * recordIndex 是元件在 doc.records 中的下标；pins[].componentIndex 是 components 数组下标。
 * @param {string} path SchDoc 文件路径
 * @returns {{
 *   components: Array<{ recordIndex: number, reference: string, comment: string, footprint: string, parameters: Record<string, string>, x: number, y: number, pins: string[] }>,
 *   pins: Array<{ componentIndex: number, number: string, name: string, electrical: string, x: number, y: number, xHotspot: number, yHotspot: number, orientation: 0|1|2|3, lengthMil: number }>,
 *   wires: Array<{ x1: number, y1: number, x2: number, y2: number, points: Array<{ x: number, y: number }> }>,
 *   labels: Array<{ text: string, x: number, y: number, kind: 'net' | 'power' }>,
 *   powerPorts: Array<{ text: string, x: number, y: number }>,
 *   noErcs: Array<{ x: number, y: number }>,
 *   junctions: Array<{ x: number, y: number }>
 * }}
 */
export function parseSch(path) {
  const { document: doc } = parseAltiumFile(new Uint8Array(readFileSync(path)))
  const recordIndex = new Map(doc.records.map((record, index) => [record, index]))
  const ownedBy = groupRecordsByOwner(doc.records)
  const designators = readDesignators(doc.records)
  const componentIndexByRecordIndex = new Map(doc.components.map((component, index) => [recordIndex.get(component), index]))

  const pins = doc.pins.map(record => toPin(record, componentIndexByRecordIndex))
  const components = doc.components.map((component, index) => {
    const componentRecordIndex = recordIndex.get(component)
    const componentPins = pins.filter(pin => pin.componentIndex === index).map(pin => pin.number)
    return {
      recordIndex: componentRecordIndex,
      reference: designators.get(componentRecordIndex) ?? '',
      comment: readComment(component, ownedBy.get(componentRecordIndex) ?? []),
      footprint: readFootprint(ownedBy, recordIndex, componentRecordIndex),
      // 元件自带参数（RECORD=41）原样保留：BOM 检查从中读取 Part Number/MPN、
      // 制造商与供应商料号等字段，解析层不判断哪些参数是型号。
      parameters: readParameters(ownedBy.get(componentRecordIndex) ?? []),
      x: component.position?.x ?? 0,
      y: component.position?.y ?? 0,
      pins: componentPins,
    }
  })

  return {
    components,
    pins,
    wires: doc.wires.map(toWire),
    labels: [
      ...doc.netLabels.map(record => toLabel(record, 'net')),
      ...doc.powerPorts.map(record => toLabel(record, 'power')),
    ],
    powerPorts: doc.powerPorts.map(record => {
      const position = record.position ?? { x: 0, y: 0 }
      return { text: record.text ?? '', x: position.x, y: position.y }
    }),
    // No-ERC 标记落在引脚连接点（热点）上，用于抑制「故意悬空」的误报。
    noErcs: readNoErcs(doc.records),
    junctions: doc.records
      .filter(record => record.recordKind === '29')
      .map(record => {
        const position = record.position ?? { x: 0, y: 0 }
        return { x: position.x, y: position.y }
      }),
  }
}

function groupRecordsByOwner(records) {
  const ownedBy = new Map()
  for (const record of records) {
    const ownerIndex = record.ownerIndex
    if (ownerIndex === undefined || ownerIndex < 0) continue
    const owned = ownedBy.get(ownerIndex)
    if (owned) owned.push(record)
    else ownedBy.set(ownerIndex, [record])
  }
  return ownedBy
}

// 位号不在 component.designator 里，而在 RECORD=34 的 Text 字段，按 OWNERINDEX 归属到元件。
function readDesignators(records) {
  const designators = new Map()
  for (const record of records) {
    if (record.recordKind !== '34') continue
    const ownerIndex = record.ownerIndex
    const text = record.text ?? ''
    if (ownerIndex === undefined || ownerIndex < 0 || text === '') continue
    if (!designators.has(ownerIndex)) designators.set(ownerIndex, text)
  }
  return designators
}

function toPin(record, componentIndexByRecordIndex) {
  const position = record.position ?? { x: 0, y: 0 }
  const orientation = readOrientation(record)
  const lengthMil = record.pinLengthSchematicUnits ?? 10
  const direction = PIN_DIRECTIONS[orientation] ?? PIN_DIRECTIONS[0]
  return {
    componentIndex: componentIndexByRecordIndex.get(record.ownerIndex) ?? -1,
    number: record.designator ?? '',
    name: record.name ?? '',
    electrical: electricalTypeName(record.getCaseInsensitive('ELECTRICAL')),
    x: position.x,
    y: position.y,
    // 连接点 = LOCATION + 引脚长度 × 方向；No-ERC 与检测器都按这个坐标匹配。
    xHotspot: position.x + direction.x * lengthMil,
    yHotspot: position.y + direction.y * lengthMil,
    orientation,
    lengthMil,
  }
}

// AltiumSchNoErcRecord 的 recordKind 是 "22"；位置即被标记引脚的连接点。
export function readNoErcs(records) {
  return records
    .filter(record => record.recordKind === '22')
    .map(record => {
      const position = record.position ?? { x: 0, y: 0 }
      return { x: position.x, y: position.y }
    })
}

// 二进制 SchDoc 没有 ORIENTATION 字段；方向编码在 PINCONGLOMERATE 低 2 位。ASCII 文档缺 PINCONGLOMERATE 时回退 ORIENTATION。
function readOrientation(record) {
  const conglomerate = record.getNumber('PINCONGLOMERATE')
  const raw = conglomerate ?? record.getNumber('ORIENTATION') ?? 0
  return raw & 0b11
}

/**
 * 把 Altium ELECTRICAL 的原始值（数字序数或名称）归一为统一枚举。
 * 数值序数按 Altium TPinElectrical：0 input、1 IO、2 output、3 open_collector、4 passive、
 * 5 HiZ、6 open_emitter、7 power、8 power2。
 * @param {number | string | undefined} raw
 * @returns {'input'|'output'|'passive'|'power'|'bidirectional'|'open_collector'|'unspecified'}
 */
export function electricalTypeName(raw) {
  if (raw === undefined) return 'unspecified'
  const text = String(raw).trim()
  if (/^-?\d+$/u.test(text)) {
    return ELECTRICAL_BY_NUMBER[Number(text)] ?? 'unspecified'
  }
  const key = text.toLowerCase().replace(/[^a-z0-9]/gu, '')
  return ELECTRICAL_BY_NAME[key] ?? 'unspecified'
}

// Comment 参数可能是 "=Value" / "=Part Number" 这样的表达式，解析到同一元件下的同名参数。
function readComment(component, ownedRecords) {
  const parameters = ownedRecords.filter(record => record.recordKind === '41')
  const comment = parameters.find(record => normalizeKey(record.name) === 'comment')?.text ?? component.comment
  if (comment === undefined || comment === '') return ''
  if (!comment.startsWith('=')) return comment
  const parameterName = comment.slice(1).trim()
  const parameter = parameters.find(record => normalizeKey(record.name) === normalizeKey(parameterName))
  return parameter?.text ?? comment
}

// 元件自带参数（RECORD=41）按参数名收集；同名参数只保留第一条。
// 文档级参数（ownerIndex 为空）不属于元件，不会出现在这里。
function readParameters(ownedRecords) {
  const parameters = Object.create(null)
  for (const record of ownedRecords) {
    if (record.recordKind !== '41') continue
    const name = String(record.name ?? '').trim()
    const text = String(record.text ?? '').trim()
    if (!name || !text || parameters[name] !== undefined) continue
    parameters[name] = text
  }
  return parameters
}

// 封装名在 RECORD=44（实现清单）→ RECORD=45（模型）的 owner 链上。
function readFootprint(ownedBy, recordIndex, componentRecordIndex) {
  for (const implementation of ownedBy.get(componentRecordIndex) ?? []) {
    if (implementation.recordKind !== '44') continue
    const models = (ownedBy.get(recordIndex.get(implementation)) ?? []).filter(record => record.recordKind === '45')
    const model = models.find(record => (record.modelType ?? '').toUpperCase() === 'PCBLIB') ?? models[0]
    if (model?.modelName) return model.modelName
  }
  // 旧格式兼容：模型记录直接挂在元件下。
  const direct = (ownedBy.get(componentRecordIndex) ?? []).filter(record => record.recordKind === '45')
  return (direct.find(record => (record.modelType ?? '').toUpperCase() === 'PCBLIB') ?? direct[0])?.modelName ?? ''
}

// 导线是多段折线（最多 4 个顶点），x1/y1/x2/y2 只保留首尾；
// points 保留全部顶点，Task 5 的并查集必须使用 points，否则 L 形导线的拐角与中段标签会丢失。
function toWire(record) {
  const points = getSchematicRecordPoints(record)
  const first = points[0] ?? { x: 0, y: 0 }
  const last = points.at(-1) ?? first
  return { x1: first.x, y1: first.y, x2: last.x, y2: last.y, points }
}

function toLabel(record, kind) {
  const position = record.position ?? { x: 0, y: 0 }
  return { text: record.text ?? '', x: position.x, y: position.y, kind }
}

function normalizeKey(name) {
  return String(name ?? '').trim().toLowerCase()
}
