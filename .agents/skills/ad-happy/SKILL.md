---
name: ad-happy
description: 审查 Altium Designer 工程（.PrjPcb/.SchDoc/.PcbDoc）：用户给出工程文件夹或工程文件路径，要求设计审查、测评或打板前检查时使用。
---

# AD-Happy：Altium 工程设计审查

用一次确定性 CLI 运行完成离线设计审查，然后用中文汇报。除本流程外，不要自行解析工程文件。

`<skill>` 指本文件所在目录的绝对路径（通常为 `<仓库>/.agents/skills/ad-happy`）。下文命令中的占位符必须替换为绝对路径。

## 前置条件

- Node ≥ 20、Python ≥ 3.10 已安装并在 `PATH` 中。
- 首次使用前，在本技能目录（`.agents/skills/ad-happy`）执行 `npm install`，安装锁定版本 `altiumts@0.0.95`。
- kicad-happy 的 scripts 目录（包含 `kicad_types.py`、`finding_schema.py`）。默认路径为 `D:/Tools/kicad-happy/skills/kicad/scripts`；若安装在其他位置，设置环境变量 `KICAD_HAPPY_SCRIPTS` 指向该目录。该目录只读，不要修改。
- 运行 `node "<skill>/scripts/selfcheck.mjs"` 可检查以上依赖；报错信息会给出缺失项与技能目录绝对路径。

## 步骤

### 1. 确认工程路径

- 把用户给的路径解析为绝对路径，并确认它存在、可访问。
- `--project` 只接受**目录**。用户给的是 `.PrjPcb` / `.SchDoc` / `.PcbDoc` 文件时，取它所在的目录。
- 路径不存在或无法访问时，直接告知用户，不要运行命令。

### 2. 定位 `*.PrjPcb`

- 在用户给的目录中查找 `*.PrjPcb`：先看顶层，顶层没有再看子目录。
- 找到多个时，列出全部工程文件（含所在目录）让用户选择；把选中工程所在的目录作为 `--project`，并追加 `--project-file "<PrjPcb 文件名>"`。
- 同一目录下有多个 `.PrjPcb` 且用户未指定时，CLI 会以退出码 2 列出候选；不要自行替用户猜，按候选让用户选择。
- 一个都没有时，告知「路径或工程无效：目录中没有 .PrjPcb」，不要运行命令。

### 3. 运行分析

```bash
node "<skill>/scripts/analyze.mjs" --project "<路径>" --out "<输出目录>" [--project-file "<PrjPcb 文件名>"]
```

- `<路径>`：第 2 步确认的工程目录绝对路径（也可直接给 `.PrjPcb` 文件路径）。
- `<输出目录>`：源工程**之外**的绝对路径。用户没有指定时，使用 CLI 默认输出目录（省略 `--out`，产物位于 `%LOCALAPPDATA%\ad-happy\runs\<run-id>`），不要自行拼接 `%TEMP%` 等字面量。输出到源工程内会被拒绝。
- 同一目录有多个工程时，追加 `--project-file "<PrjPcb 文件名>"`。
- 默认审查文档清单中的最后一块 `PcbDoc`；用户指定板卡时追加 `--board "<PcbDoc 文件名>"`。
- 命令失败时按退出码处理（见下），不要改用其他方式自行解析工程。

### 4. 只读 `summary.json`

- 读取 `<输出目录>/summary.json`（CLI 保证小于 32KB）。
- 需要补充细节时，只从 `<输出目录>/findings.json` 中提取对应的一到两条 finding（按 `rule_id` 或元件/网络定位），不要整份读入。
- 不要读取或粘贴 `snapshot.json`、`raw.json`、`pcb.json`；它们只用于排查和复现。

### 5. 用中文输出

按以下结构汇报，内容全部来自 `summary.json`：

1. **结论**：`status`（完成/部分完成）、必须修复/建议修复/可优化数量，以及一句话判断。
2. **工程概览**：工程名、选中板卡（`project.selectedBoard`）、原理图、文档覆盖（`coverage`）。
3. **问题清单**：按 `must_fix` → `should_fix` → `nice_to_have` 排序；每条给出规则、标题、定位（元件/网络/引脚）、证据与建议。summary 中的证据被截断时，从 `findings.json` 取对应单条补全。
4. **数据覆盖与未检查项**：列出 `rules` 中为 `not_evaluated` 或 `failed` 的规则，并按 `coverage` 说明未覆盖范围；summary 未给出原因时只说明「数据不足/未评估」，不要猜测。说明 `findingsOmitted` 表示还有多少条问题未出现在 summary 中（完整清单在 `report.html`）。
5. **报告**：给出 `report` 字段中 `report.html` 的绝对路径。

## 退出码

- `0`：完成，按第 5 步汇报。
- `2`：输入无效。告知用户「路径或工程无效」，并引用 stderr 的具体原因（路径不存在、目录中没有 `.PrjPcb`、输出目录在工程内等）。不要读取或汇报任何产物。
- `3`：部分完成。告知用户「部分完成」，读取 `<输出目录>/manifest.json` 的 `errors`、`warnings`、`stages`，说明哪一步失败、哪些规则未评估；已生成的结果照常汇报，但必须标明缺失范围。
- 其他非零退出码按工具运行失败处理，引用 stderr。

## 硬规则

- **只读源工程**：不修改、不新增、不移动源工程中的任何文件；所有输出只写入 `--out` 目录。
- **缺失数据标 `not_evaluated`**：`not_evaluated` 不等于通过，`failed` 不等于发现问题。
- **不编造**：只汇报 `summary.json` / `findings.json` 中存在的结论和证据，不臆造检查项或「通过」项。
- **不把整份 snapshot 塞进上下文**：`summary.json` 之外的原始数据按需单条提取。
