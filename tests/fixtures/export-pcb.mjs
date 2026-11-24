// 生成 tests/fixtures/pcb.json：对样板 PCB 跑 parsePcb，把 PcbSnapshot
// 固化成 Python 检测器测试夹具。样板或解析逻辑变化后重跑本脚本即可。
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePcb } from '../../.agents/skills/ad-happy/scripts/pcb.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const boardPath = join(here, 'Student-DCDC-Buck-Converter', 'PCB4 (Final Design).PcbDoc')
const snapshot = parsePcb(boardPath)

const outputPath = join(here, 'pcb.json')
writeFileSync(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')

console.log(
  `已写入 ${outputPath}：${snapshot.components.length} 元件、` +
    `${snapshot.pads.length} 焊盘、${snapshot.nets.length} 网络、` +
    `${snapshot.tracks.length} 铜走线、${snapshot.vias.length} 过孔、` +
    `${snapshot.rules.length} 规则`,
)
