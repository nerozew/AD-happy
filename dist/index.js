import { defineTool } from '@deepseek-ai/dsh-tools';
import Schema from '@deepseek-ai/schemastery';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
export const name = 'ad-happy';
export const inject = ['tools'];
export const Config = Schema.object({
    pythonCommand: Schema.string().default('python'),
    kicadHappyScripts: Schema.string().default(''),
    adMcpServer: Schema.string().default(''),
});
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const cliPath = join(pkgRoot, '.agents', 'skills', 'ad-happy', 'scripts', 'analyze.mjs');
function childEnv(config) {
    const env = { ...process.env };
    if (config.kicadHappyScripts)
        env.KICAD_HAPPY_SCRIPTS = config.kicadHappyScripts;
    if (config.adMcpServer)
        env.AD_HAPPY_AD_MCP_SERVER = config.adMcpServer;
    return env;
}
function runCli(args, config, signal) {
    return new Promise((resolveResult, reject) => {
        const child = spawn(process.execPath, [cliPath, ...args], {
            cwd: dirname(cliPath),
            env: childEnv(config),
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        const abort = () => child.kill();
        signal?.addEventListener('abort', abort, { once: true });
        child.once('error', (error) => {
            signal?.removeEventListener('abort', abort);
            reject(error);
        });
        child.once('close', (code) => {
            signal?.removeEventListener('abort', abort);
            resolveResult({ code, stdout, stderr });
        });
    });
}
function pythonVersion(config) {
    try {
        const r = spawnSync(config.pythonCommand, ['--version'], { encoding: 'utf8', windowsHide: true });
        if (r.status === 0)
            return (r.stdout || r.stderr).trim();
    }
    catch { /* 未安装 */ }
    return '未检测到';
}
function altiumtsVersion() {
    const file = join(pkgRoot, 'node_modules', 'altiumts', 'package.json');
    if (!existsSync(file))
        return '未安装';
    try {
        return JSON.parse(readFileSync(file, 'utf8')).version ?? '未知';
    }
    catch {
        return '未知';
    }
}
function statusText(config) {
    const kicad = config.kicadHappyScripts || process.env.KICAD_HAPPY_SCRIPTS || 'D:/Tools/kicad-happy/skills/kicad/scripts';
    const adMcp = config.adMcpServer || process.env.AD_HAPPY_AD_MCP_SERVER || '';
    return [
        'AD-Happy DSH 插件已加载。',
        `Node：${process.version}`,
        `Python：${pythonVersion(config)}`,
        `altiumts：${altiumtsVersion()}`,
        `CLI：${existsSync(cliPath) ? '可用' : '缺失'}（${cliPath}）`,
        `kicad-happy：${existsSync(join(kicad, 'kicad_types.py')) ? '可用' : '缺失'}（${kicad}）`,
        `AD-MCP：${adMcp || '未配置（--with-ad 需要）'}`,
        'SPICE：需要本机 ngspice / LTspice / Xyce',
    ].join('\n');
}
async function runAnalyze(config, args, signal) {
    const outDir = args.outDir || join(tmpdir(), `ad-happy-${Date.now()}`);
    const cliArgs = ['--project', args.projectPath, '--out', outDir];
    if (args.board)
        cliArgs.push('--board', args.board);
    if (args.gerber)
        cliArgs.push('--gerber', args.gerber);
    if (args.bom)
        cliArgs.push('--bom', args.bom);
    if (args.datasheets)
        cliArgs.push('--datasheets', args.datasheets);
    if (args.spice)
        cliArgs.push('--spice');
    if (args.emc)
        cliArgs.push('--emc');
    if (args.withAd)
        cliArgs.push('--with-ad');
    const r = await runCli(cliArgs, config, signal);
    let summary;
    try {
        summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    }
    catch { /* 失败时没有 summary */ }
    return JSON.stringify({
        exit_code: r.code,
        out_dir: outDir,
        report: join(outDir, 'report.html'),
        summary,
        stderr: r.stderr.trim() || undefined,
        stdout_tail: r.stdout.trim().split('\n').slice(-8).join('\n') || undefined,
    }, null, 2);
}
export function apply(ctx, config) {
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'adhappy_status',
        description: '检查 AD-Happy 的运行环境：Node、Python、altiumts、CLI、kicad-happy、AD-MCP 与 SPICE。只读。',
        parameters: {},
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute() {
            return statusText(config);
        },
    })));
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'adhappy_analyze',
        description: '分析一个 Altium 工程文件夹或 .PrjPcb，输出中文设计审查报告（HTML + JSON）。离线运行，不修改源工程。',
        parameters: {
            projectPath: { type: 'string', required: true, description: '工程目录或 .PrjPcb 路径（绝对路径）' },
            outDir: { type: 'string', description: '输出目录；省略时使用系统临时目录下的新目录' },
            board: { type: 'string', description: '指定要审查的 PcbDoc 文件名；默认文档清单中最后一块' },
            gerber: { type: 'string', description: 'Gerber/钻孔目录；省略时自动查找' },
            bom: { type: 'string', description: 'Altium 导出的 BOM CSV；省略时自动生成' },
            datasheets: { type: 'string', description: '数据手册 PDF 目录' },
            spice: { type: 'boolean', description: '运行 SPICE 仿真（需要本机仿真器）' },
            emc: { type: 'boolean', description: '运行 EMC 预合规分析' },
            withAd: { type: 'boolean', description: '深度模式：调用 Altium 原生 ERC/DRC（需要 AD 打开 + AD-MCP）' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args, execution) {
            return runAnalyze(config, args, execution.signal);
        },
    })));
}
