// 原理图连通性引擎：从 SchSnapshot 自建网表，替代 altiumts 的 netGraph。
//
// 坐标单位是 schematic units（1 单位 ≈ 10 mil ≈ 0.254 mm），不是 mil。
// tolerance 也按 schematic units 计：默认 0.005 只用来吸收文件里的浮点舍入误差
// （样板实测最大偏差 0.00023），不要按 0.0254 换算成 mm，否则容差会小 10 倍。
//
// 连接模型（与 Altium 一致）：
// - 每条导线的相邻顶点连成线段；wire.points 必须全部消费，只取 x1/y1/x2/y2
//   会丢掉中间顶点，导致 T 型连接与中段标签丢失。
// - 引脚热点 = (x, y) + 引脚长度 × 方向向量；热点吸附到最近线段（点到线段的距离 ≤ tolerance）。
// - 导线顶点的 T 型连接、junction 坐标、网络标签、电源端口同样吸附到最近线段。
// - 只在节点与线段之间吸附；两条线段在中间交叉且无 junction 时不导通（Altium 规则）。
// - 最后按名称合并同名网络（如 6 个分散的 GND 电源端口），未命名网络编号 __unnamed_N。
import { PIN_DIRECTIONS } from './sch.mjs'

// 坐标去重精度：远小于 tolerance，又足以区分导线上相差 0.00023 的顶点。
const COORDINATE_PRECISION = 6
// 单位是 schematic units，不是 mil。
const DEFAULT_TOLERANCE = 0.005

/**
 * 从 SchSnapshot 构建网表。
 * @param {object} sch Task 4 的 SchSnapshot
 * @param {number} [tolerance=0.005] 吸附容差，schematic units
 * @returns {{
 *   nets: Record<string, Array<{ reference: string, pin: string }>>,
 *   pinNet: Record<string, string>,
 *   stats: { pinsMatched: number, pinsTotal: number, nets: number }
 * }}
 */
export function buildNets(sch, tolerance = DEFAULT_TOLERANCE) {
  // 所有几何节点：导线顶点 + 引脚热点 + junction + 标签/电源端口。
  // 坐标完全相同的节点复用同一个 id，导线的共享顶点由此直接连通。
  const nodes = []
  const nodeIdByKey = new Map()
  // 导线折线的相邻顶点对。
  const segments = []

  const nodeAt = (x, y) => {
    const key = `${Number(x).toFixed(COORDINATE_PRECISION)},${Number(y).toFixed(COORDINATE_PRECISION)}`
    let id = nodeIdByKey.get(key)
    if (id === undefined) {
      id = nodes.length
      nodes.push({ x, y })
      nodeIdByKey.set(key, id)
    }
    return id
  }

  // 1. 导线：消费全部顶点，相邻顶点连成线段。
  for (const wire of sch.wires ?? []) {
    const points = wire.points ?? [
      { x: wire.x1, y: wire.y1 },
      { x: wire.x2, y: wire.y2 },
    ]
    if (points.length === 0) continue
    let previous = nodeAt(points[0].x, points[0].y)
    for (let index = 1; index < points.length; index++) {
      const current = nodeAt(points[index].x, points[index].y)
      if (current !== previous) segments.push({ a: previous, b: current })
      previous = current
    }
  }

  // 2. 引脚热点。orientation 由 sch.mjs 从 PINCONGLOMERATE 低两位解码。
  const pinKnots = (sch.pins ?? []).map(pin => {
    const direction = PIN_DIRECTIONS[pin.orientation] ?? PIN_DIRECTIONS[0]
    return {
      pin,
      node: nodeAt(pin.x + direction.x * pin.lengthMil, pin.y + direction.y * pin.lengthMil),
    }
  })

  // 3. junction 与网络标签/电源端口按自身坐标入图。
  //    parseSch 已把电源端口并入 labels；这里仍单独消费 powerPorts，
  //    以兼容没有 labels 字段的手工快照，重名由后面的 Set 去重。
  const namedKnots = [
    ...(sch.labels ?? []),
    ...(sch.powerPorts ?? []),
  ]
    .filter(item => typeof item.text === 'string' && item.text.trim() !== '')
    .map(item => ({ text: item.text.trim(), node: nodeAt(item.x, item.y) }))
  // junction 本身不需要记录归属，入图后由下面的统一吸附处理。
  for (const junction of sch.junctions ?? []) nodeAt(junction.x, junction.y)

  // 4. 并查集：先连导线自身的相邻顶点，再让每个节点吸附最近线段。
  const unionFind = new UnionFind(nodes.length)
  for (const segment of segments) unionFind.union(segment.a, segment.b)

  // 吸附覆盖三类连接：
  // - 引脚/标签落在导线段中段（点到线段距离，而非只比较端点）；
  // - T 型连接：一条导线的顶点落在另一条导线的中段；
  // - junction 显式标在交点上。
  for (let node = 0; node < nodes.length; node++) {
    const nearest = nearestSegment(nodes[node], nodes, segments)
    if (nearest.segment === undefined || nearest.distance > tolerance) continue
    unionFind.union(node, nearest.segment.a)
    unionFind.union(node, nearest.segment.b)
  }

  // 5. 汇总每个连通分量上的引脚与网络名。
  const pinsByRoot = new Map()
  for (const { pin, node } of pinKnots) {
    const root = unionFind.find(node)
    const entry = pinsByRoot.get(root) ?? []
    entry.push({
      reference: sch.components?.[pin.componentIndex]?.reference ?? '',
      pin: pin.number,
    })
    pinsByRoot.set(root, entry)
  }

  const namesByRoot = new Map()
  for (const { text, node } of namedKnots) {
    const root = unionFind.find(node)
    const names = namesByRoot.get(root) ?? new Set()
    names.add(text)
    namesByRoot.set(root, names)
  }

  // 只有落在导线上（分量里含至少一条线段）的引脚才算入网。
  const wiredRoots = new Set()
  for (const segment of segments) wiredRoots.add(unionFind.find(segment.a))

  // 6. 命名：同名网络合并（分散的 GND 端口归为一个网络）；无标签的网络编号 __unnamed_N。
  const netPins = new Map()
  let unnamedCount = 0
  for (const [root, pins] of pinsByRoot) {
    if (!wiredRoots.has(unionFind.find(root))) continue
    const names = [...(namesByRoot.get(root) ?? [])]
    let name
    if (names.length > 0) {
      // 同一物理网络上出现多个不同网络名属于 Altium 的命名冲突，
      // 取文档顺序第一个名，避免把引脚重复计入多个网络。
      name = names[0]
    } else {
      unnamedCount += 1
      name = `__unnamed_${unnamedCount}`
    }
    const list = netPins.get(name) ?? []
    list.push(...pins)
    netPins.set(name, list)
  }

  const nets = {}
  const pinNet = {}
  let pinsMatched = 0
  for (const [name, pins] of netPins) {
    const sorted = [...pins].sort(comparePins)
    nets[name] = sorted
    pinsMatched += sorted.length
    for (const { reference, pin } of sorted) pinNet[`${reference}.${pin}`] = name
  }

  return {
    nets,
    pinNet,
    stats: {
      // pinsMatched：热点落在导线上、已进入网表的引脚数；pinsTotal：快照里的全部引脚数。
      pinsMatched,
      pinsTotal: (sch.pins ?? []).length,
      nets: Object.keys(nets).length,
    },
  }
}

function comparePins(a, b) {
  return a.reference.localeCompare(b.reference)
    || a.pin.localeCompare(b.pin, undefined, { numeric: true })
}

// 点到线段的最短距离；t 夹到 [0, 1]，端点处退化为点到点距离。
function distanceToSegment(point, segment, nodes) {
  const a = nodes[segment.a]
  const b = nodes[segment.b]
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y)
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared))
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy))
}

function nearestSegment(point, nodes, segments) {
  let best
  let bestDistance = Infinity
  for (const segment of segments) {
    const distance = distanceToSegment(point, segment, nodes)
    if (distance < bestDistance) {
      bestDistance = distance
      best = segment
    }
  }
  return { segment: best, distance: bestDistance }
}

// 并查集（路径压缩）。样板规模只有几十个节点，不需要按秩合并。
class UnionFind {
  constructor(size) {
    this.parent = Array.from({ length: size }, (_, index) => index)
  }

  find(node) {
    let root = node
    while (this.parent[root] !== root) root = this.parent[root]
    while (this.parent[node] !== root) {
      const next = this.parent[node]
      this.parent[node] = root
      node = next
    }
    return root
  }

  union(a, b) {
    const rootA = this.find(a)
    const rootB = this.find(b)
    if (rootA !== rootB) this.parent[rootB] = rootA
  }
}
