// 工程发现：在给定目录顶层查找 .PrjPcb，并列出其中的文档清单。
import { readdirSync, readFileSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import { parseAltiumPrjPcb } from 'altiumts'

// 扩展名（小写）到文档类别；未列出的类型不参与后续解析。
const DOCUMENT_KINDS = {
  '.pcbdoc': 'pcb',
  '.schdoc': 'sch',
  '.pcblib': 'lib',
  '.schlib': 'lib',
  '.intlib': 'lib',
}

/**
 * 只查找目录顶层的 .PrjPcb（不递归）；同目录有多个工程时取字典序第一个。
 * @param {string} dir
 * @returns {{ projectPath: string, documents: Array<{ path: string, name: string, kind: 'pcb' | 'sch' | 'lib' }> }}
 */
export function discoverProject(dir) {
  const baseDir = resolve(dir)
  const projects = readdirSync(baseDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.prjpcb'))
    .map(entry => entry.name)
    .sort()
  if (projects.length === 0) {
    throw new Error('NO_PROJECT')
  }

  const projectPath = resolve(baseDir, projects[0])
  const project = parseAltiumPrjPcb(readFileSync(projectPath, 'utf8'))

  const documents = []
  for (const ref of project.documents) {
    // PrjPcb 中的子目录分隔符可能是反斜杠，统一后再解析，保证跨平台。
    const path = resolve(baseDir, ref.path.replace(/\\/g, '/'))
    const kind = DOCUMENT_KINDS[extname(path).toLowerCase()]
    if (!kind) continue
    documents.push({ path, name: basename(path), kind })
  }
  return { projectPath, documents }
}
