// 生成 tests/fixtures/adapter-raw.json：对样板原理图跑 parseSch + buildNets，
// 把结果固化成 Python 适配层测试夹具。样板或解析逻辑变化后重跑本脚本即可。
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSch } from '../../.agents/skills/ad-happy/scripts/sch.mjs'
import { buildNets } from '../../.agents/skills/ad-happy/scripts/connectivity.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const schematicPath = join(here, 'Student-DCDC-Buck-Converter', 'SCH1_Main.SchDoc')
const schematic = parseSch(schematicPath)
const nets = buildNets(schematic)

const outputPath = join(here, 'adapter-raw.json')
writeFileSync(outputPath, `${JSON.stringify({ schematic, nets }, null, 2)}\n`, 'utf8')

console.log(
  `已写入 ${outputPath}：${schematic.components.length} 元件、` +
    `${nets.stats.pinsMatched}/${nets.stats.pinsTotal} 引脚、${nets.stats.nets} 网络`,
)
