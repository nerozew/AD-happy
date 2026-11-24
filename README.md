# AD-Happy

Altium Designer 工程的离线设计审查 Skill + CLI：解析 `.PrjPcb` / `.SchDoc` / `.PcbDoc`，自建原理图网表，复用 [kicad-happy](https://github.com/aklofas/kicad-happy) 的检测器，产出中文 `findings.json`、`summary.json` 与 `report.html`。不启动 Altium Designer，不修改源工程。

## 安装

需要 Node ≥ 20、Python ≥ 3.10，以及 kicad-happy 的 scripts 目录。

```bash
cd .agents/skills/ad-happy
npm install          # 安装锁定版本 altiumts@0.0.95
```

kicad-happy 默认从 `D:/Tools/kicad-happy/skills/kicad/scripts` 读取；其他位置请设置环境变量：

```bash
# Windows PowerShell
$env:KICAD_HAPPY_SCRIPTS = "D:/path/to/kicad-happy/skills/kicad/scripts"
```

自检：

```bash
node .agents/skills/ad-happy/scripts/selfcheck.mjs
```

## 运行

```bash
node .agents/skills/ad-happy/scripts/analyze.mjs --project "<工程目录或 .PrjPcb>" [--out "<输出目录>"] [--project-file "<PrjPcb 文件名>"] [--board "<PcbDoc 文件名>"] [--gerber "<Gerber 目录>"] [--svg]
```

- 同目录有多个 `.PrjPcb` 时必须用 `--project-file` 指定，否则退出码 2 并列出候选。
- 默认审查文档清单中最后一块 `PcbDoc`，可用 `--board` 指定。
- `--gerber` 指向 Altium 导出的 Gerber/钻孔目录；省略时自动查找工程目录下的 `Gerber`、`Outputs`、`Project Outputs`、`Manufacturing`。找不到时在 `manifest.warnings` 说明原因，并把制造文件检查标记为 `not_evaluated`。缺少钻孔文件时钻孔相关检查同样是 `not_evaluated`，不会当成通过。
- 退出码：`0` 完成；`2` 输入无效；`3` 部分完成（解析失败、规则 failed 或输出不完整）。
- 默认输出到 `%LOCALAPPDATA%\ad-happy\runs\<run-id>`；`--out` 只接受空目录或带 `.ad-happy-run` 标记的 AD-Happy 输出目录，避免删除用户文件。

产物：`manifest.json`（来源/版本/阶段状态）、`snapshot.json`、`raw.json`、`pcb.json`、`findings.json`、`pipeline-summary.json`、`gerber.json`（上游 Gerber 原始输出，仅在运行 Gerber 分析时生成）、`summary.json`（<32KB，给模型读）、`report.html`（单文件中文报告）。

`SKILL.md` 描述 AI harness 的固定使用流程；直接运行 CLI 时以本 README 为准。

## 已知限制

- 单文件输入上限 50MB；超过会将该文档标记为解析失败（退出码 3），不会继续硬解析。
- Python 分析阶段超时 120 秒；超时会写 manifest 错误并退出码 3。
- 不解析 `.SchLib` / `.PcbLib` / `.IntLib`；层次原理图、总线、装配变体与自动修复不在首版范围。
- 网表匹配率不足（引脚未全部入网）时，依赖网表的原理图规则标记为 `not_evaluated`，不会当作通过。
- Gerber 分析复用 kicad-happy 的 `analyze_gerbers.py`：只解析 `.drl` 与 Excellon `.txt` 钻孔文件；检测到 `.xln`/`.nc` 时会注明未纳入评估。没有 Gerber/钻孔输入时制造文件检查为 `not_evaluated`。
- 上游 kicad-happy 检测器的 finding 文案已由适配层翻译成中文；原文保留在 `findings.json` 的 `source_text` 中，个别无法安全翻译的文本以「（检测器原文）」标注。

## 许可

复用组件的许可见 `THIRD-PARTY-NOTICES.md`。kicad-happy 目录只读，不随本仓库分发。
