// 环境自检：确认 Node、altiumts、Python 与 kicad-happy 脚本可用。
// 任一项不满足时写入 errors；全部满足时 ok 为 true。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 相对本文件定位依赖，避免依赖调用方的 cwd（测试从仓库根目录运行）。
const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REQUIRED_ALTIMTS_VERSION = '0.0.95'
const DEFAULT_KICAD_HAPPY_SCRIPTS = 'D:/Tools/kicad-happy/skills/kicad/scripts'

/**
 * @param {{ kicadHappyScripts?: string }} [env]
 * @returns {{ ok: boolean, node: string, altiumts: string, python: string, kicadHappy: string, errors: string[] }}
 */
export function runSelfCheck(env = {}) {
  const errors = []

  const node = process.version
  const nodeMajor = Number.parseInt(node.slice(1), 10)
  if (!(nodeMajor >= 20)) {
    errors.push(`Node 版本需 ≥ 20，当前 ${node}`)
  }

  const altiumts = readAltiumtsVersion(errors)
  const python = readPythonVersion(errors)

  const kicadHappy = env.kicadHappyScripts
    ?? process.env.KICAD_HAPPY_SCRIPTS
    ?? DEFAULT_KICAD_HAPPY_SCRIPTS
  checkKicadHappy(kicadHappy, errors)

  return { ok: errors.length === 0, node, altiumts, python, kicadHappy, errors }
}

function readAltiumtsVersion(errors) {
  const pkgPath = join(SKILL_ROOT, 'node_modules', 'altiumts', 'package.json')
  if (!existsSync(pkgPath)) {
    errors.push(`未安装 altiumts@${REQUIRED_ALTIMTS_VERSION}，请运行 npm install`)
    return ''
  }
  try {
    const { version } = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (version !== REQUIRED_ALTIMTS_VERSION) {
      errors.push(`altiumts 版本应为 ${REQUIRED_ALTIMTS_VERSION}，当前 ${version}`)
    }
    return version ?? ''
  } catch (e) {
    errors.push(`无法读取 altiumts 版本: ${e.message}`)
    return ''
  }
}

function readPythonVersion(errors) {
  let output
  try {
    output = execFileSync('python', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    errors.push('未找到 Python，请安装 Python ≥ 3.10 并加入 PATH')
    return ''
  }
  const match = /Python (\d+\.\d+(?:\.\d+)?)/.exec(output)
  if (!match) {
    errors.push(`无法识别 Python 版本: ${output.trim()}`)
    return ''
  }
  const version = match[1]
  const [major, minor] = version.split('.').map(Number)
  if (major < 3 || (major === 3 && minor < 10)) {
    errors.push(`Python 版本需 ≥ 3.10，当前 ${version}`)
  }
  return version
}

function checkKicadHappy(dir, errors) {
  const required = ['kicad_types.py', 'finding_schema.py']
  const missing = required.filter(f => !existsSync(join(dir, f)))
  if (missing.length > 0) {
    errors.push(`kicad-happy scripts 目录无效: ${dir}（缺少 ${missing.join('、')}），请设置 KICAD_HAPPY_SCRIPTS`)
  }
}
