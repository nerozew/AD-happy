#!/usr/bin/env node
// 把本包链接到各 AI harness 的技能目录，让它们能自动发现 ad-happy。
// 用法：npm install -g ad-happy && ad-happy-install
// 或：  npx ad-happy-install
import { existsSync, mkdirSync, symlinkSync, readlinkSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')

const candidates = [
  { name: 'dsh', dir: join(homedir(), '.dsh', 'skills') },
  { name: '通用 .agents', dir: join(homedir(), '.agents', 'skills') },
  { name: 'Claude Code', dir: join(homedir(), '.claude', 'skills') },
  { name: 'opencode（项目级）', dir: join(process.cwd(), '.opencode', 'skills') },
]

const results = []
for (const c of candidates) {
  if (!existsSync(c.dir)) {
    results.push(`跳过 ${c.name}：目录不存在（${c.dir}）`)
    continue
  }
  const link = join(c.dir, 'ad-happy')
  try {
    if (existsSync(link)) {
      const current = readlinkSync(link)
      if (resolve(c.dir, current) === pkgRoot) {
        results.push(`已就绪 ${c.name}：${link}`)
        continue
      }
      results.push(`跳过 ${c.name}：${link} 已存在且指向其他位置（${current}）`)
      continue
    }
    symlinkSync(pkgRoot, link, 'junction')
    results.push(`已安装 ${c.name}：${link}`)
  } catch (e) {
    results.push(`失败 ${c.name}：${e.message}`)
  }
}

console.log('AD-Happy 技能安装结果：')
for (const r of results) console.log('  ' + r)

console.log('')
console.log('下一步：')
console.log('  1. 设置 kicad-happy 路径（如果不在默认位置）：')
console.log('     Windows PowerShell: $env:KICAD_HAPPY_SCRIPTS = "D:/path/to/kicad-happy/skills/kicad/scripts"')
console.log('  2. 自检：node "' + join(pkgRoot, 'scripts', 'selfcheck.mjs') + '"')
console.log('  3. 试跑：node "' + join(pkgRoot, 'scripts', 'analyze.mjs') + '" --project "<工程目录>" --out "<输出目录>"')
console.log('')
console.log('示例报告：' + join(pkgRoot, '..', '..', '..', 'docs', 'full-report', 'report.html'))
