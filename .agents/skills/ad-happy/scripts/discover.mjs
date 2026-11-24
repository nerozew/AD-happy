// 工程发现：在给定目录顶层查找 .PrjPcb，并列出其中的文档清单。
import { readdirSync, readFileSync } from 'node:fs'
import { basename, extname, isAbsolute, resolve } from 'node:path'
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
 * 只查找目录顶层的 .PrjPcb（不递归），返回全部候选。
 *
 * - 只有一个工程时自动选中并解析文档清单；
 * - 多个工程且未指定 projectFile 时 projectPath 为 null，由 CLI 报错让用户选择；
 * - projectFile 可以是绝对路径、相对目录的路径或文件名，必须命中候选之一。
 *
 * @param {string} dir
 * @param {{ projectFile?: string }} [options]
 * @returns {{
 *   projectPath: string | null,
 *   projectPaths: string[],
 *   documents: Array<{ path: string, name: string, kind: 'pcb' | 'sch' | 'lib' }>
 * }}
 */
export function discoverProject(dir, options = {}) {
  const baseDir = resolve(dir)
  const projectPaths = readdirSync(baseDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.prjpcb'))
    .map(entry => resolve(baseDir, entry.name))
    .sort(comparePaths)
  if (projectPaths.length === 0) {
    throw new Error('NO_PROJECT')
  }

  const projectPath = options.projectFile
    ? selectProjectFile(projectPaths, baseDir, options.projectFile)
    : projectPaths.length === 1 ? projectPaths[0] : null
  if (!projectPath) {
    return { projectPath: null, projectPaths, documents: [] }
  }

  const project = parseAltiumPrjPcb(readFileSync(projectPath, 'utf8'))

  const documents = []
  for (const ref of project.documents) {
    // PrjPcb 中的子目录分隔符可能是反斜杠，统一后再解析，保证跨平台。
    const path = resolve(baseDir, ref.path.replace(/\\/g, '/'))
    const kind = DOCUMENT_KINDS[extname(path).toLowerCase()]
    if (!kind) continue
    documents.push({ path, name: basename(path), kind })
  }
  return { projectPath, projectPaths, documents }
}

function selectProjectFile(projectPaths, baseDir, wanted) {
  const needle = normalizeProjectPath(
    isAbsolute(wanted) ? wanted : resolve(baseDir, wanted),
  )
  return projectPaths.find(path => normalizeProjectPath(path) === needle) ?? null
}

// Windows 路径大小写不敏感；比较前统一归一化。
function normalizeProjectPath(path) {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function comparePaths(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}
