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
- 深度模式（`--with-ad`）额外需要：Altium Designer 正在运行（进程 `X2.EXE`）；AD-MCP 已安装（默认 `D:/NeroZe/pcb布局/AD26_PCB自动布局_工具包/01-altium-mcp/installed-v0.7.0`，可用 `AD_HAPPY_AD_MCP_SERVER` 覆盖）；选中的 Python 解释器可导入 `mcp`、pywin32 与 Pillow（默认优先 AD-MCP 自带的 `.venv`，可用 `AD_HAPPY_AD_PYTHON` 覆盖）。
- 运行 `node "<skill>/scripts/selfcheck.mjs"` 可检查以上依赖；报错信息会给出缺失项与技能目录绝对路径。

## 分析前：先说明两种模式

收到工程路径后，**先不要直接运行命令**。先告诉用户：

> 这个工程可以分两种方式分析：
>
> **离线模式（默认，不需要打开 Altium）**
> 能查：原理图与 PCB 的结构、元件、网络；10 条设计规则；原理图 ↔ PCB 交叉检查；中文 HTML 报告。
>
> **深度模式（需要打开 Altium Designer）**
> 在离线结果之外，额外能查：AD 原生的 ERC/DRC、库文件本身的引脚与焊盘、编译后的完整网表。
> 需要打开 AD 的原因：ERC/DRC 与库读取必须由 Altium 自己执行，工程文件里没有现成结果。
>
> 要打开 AD 做深度检查吗？不开也能出完整报告，只是上述三项会标「未检查」。

用户选择后：

- **不开 AD（或未回应）**：按离线模式运行，不要加 `--with-ad`。报告中与 AD 相关的检查项会标 `not_evaluated`，汇报时说明原因。
- **开 AD**：先确认 AD 已启动，再加 `--with-ad`。CLI 会检测 Altium 进程、AD-MCP 与 Python `mcp` 包；任一项不满足时以退出码 2 结束，并在 stderr 说明缺什么、如何安装。此时**不要声称做过原生检查**；如实转告用户，并询问是否改为离线模式（去掉 `--with-ad`）重新运行。

## 步骤

### 1. 确认工程路径

- 把用户给的路径解析为绝对路径，并确认它存在、可访问。
- `--project` 接受**目录**或 `.PrjPcb` 文件路径。用户给的是 `.SchDoc` / `.PcbDoc` 等文件时，取它所在的目录；给的是 `.PrjPcb` 时可直接传该文件，或传目录并追加 `--project-file "<文件名>"`。
- 路径不存在或无法访问时，直接告知用户，不要运行命令。

### 2. 定位 `*.PrjPcb`

- 在用户给的目录中查找 `*.PrjPcb`：先看顶层，顶层没有再看子目录。
- 找到多个时，列出全部工程文件（含所在目录）让用户选择；把选中工程所在的目录作为 `--project`，并追加 `--project-file "<PrjPcb 文件名>"`。
- 同一目录下有多个 `.PrjPcb` 且用户未指定时，CLI 会以退出码 2 列出候选；不要自行替用户猜，按候选让用户选择。
- 一个都没有时，告知「路径或工程无效：目录中没有 .PrjPcb」，不要运行命令。

### 3. 运行分析

```bash
node "<skill>/scripts/analyze.mjs" --project "<路径>" --out "<输出目录>" [--project-file "<PrjPcb 文件名>"] [--board "<PcbDoc 文件名>"] [--gerber "<Gerber 目录>"] [--bom "<BOM CSV>"] [--datasheets "<数据手册目录>"] [--spice] [--emc] [--with-ad]
```

- `<路径>`：第 2 步确认的工程目录绝对路径（也可直接给 `.PrjPcb` 文件路径）。
- `<输出目录>`：源工程**之外**的绝对路径。用户没有指定时，使用 CLI 默认输出目录（省略 `--out`，产物位于 `%LOCALAPPDATA%\ad-happy\runs\<run-id>`）；需要自行指定临时目录时，使用当前 shell 解析得到的临时目录绝对路径，不要自行拼接 `%TEMP%` 等字面量。输出到源工程内会被拒绝。
- 同一目录有多个工程时，追加 `--project-file "<PrjPcb 文件名>"`。
- 默认审查文档清单中的最后一块 `PcbDoc`；用户指定板卡时追加 `--board "<PcbDoc 文件名>"`。
- 用户提供了 Gerber/钻孔输出目录时追加 `--gerber "<目录>"`；省略时 CLI 自动查找工程下的 `Gerber`、`Outputs`、`Project Outputs`、`Manufacturing`。找不到或缺少钻孔文件时，制造文件检查会标记为未评估，汇报时如实说明。
- 用户提供了 Altium 导出的 BOM CSV 时追加 `--bom "<CSV>"`，CLI 会把它与解析到的元件比对；省略时按解析数据生成 `bom.csv` 与 `procurement.csv`。采购清单不联网，缺 MPN 的元件在报告中单独标出。
- 用户提供了数据手册 PDF 目录时追加 `--datasheets "<目录>"`；省略时自动查找工程下的 `datasheets/`。CLI 只检查 PDF 覆盖、MPN 匹配并调用上游 `plan_extraction.py` 生成提取计划，**不解析 PDF 引脚表**。提取计划与 scout 缓存写在 `<输出目录>/datasheets/`，不写源工程；需要 AI 继续时，让 AI 读取 PDF 后把 `<MPN>.scout.json` 写入该目录，再重跑同一命令即可生成 `<MPN>.plan.json`。没有目录或没有提取计划时按 `not_evaluated` 汇报；引脚级核对必须由 AI/人工依据 PDF 完成，不得声称已经核对。
- 用户明确要求 SPICE 仿真时追加 `--spice`；默认不要加。CLI 自动检测 ngspice、LTspice、Xyce，找不到时 `rules.spice = not_evaluated`，必须如实汇报缺什么/如何安装，**不得声称仿真通过，也不得自行安装软件**。仿真结果只能引用 `summary.spice` 与 `spice.json` 中的测试台路径和数值。
- 用户明确要求 EMC、电磁兼容或预合规分析时追加 `--emc`；默认不要加。CLI 复用 kicad-happy 的 `analyze_emc.py`，默认标准为 FCC Part 15 Class B。铺铜实形、板框线段、层切换、走线邻近度与叠层介质不在离线解析范围内，相关类别会标 `not_evaluated`；必须按 `summary.emc.categories`（每类计数）与 `summary.emc.notEvaluatedRules`（最多 10 条，其余见 `notEvaluatedRulesOmitted`）逐类说明，完整规则/原因见 `emc.json` 与 `report.html`；并检查 `summary.emc.netlistComplete`（为 false 时依赖网表的规则已降级），**不得把未评估类别说成通过**。上游脚本缺失时 `rules.emc = not_evaluated`，不改变退出码；只有 `failed` 才表示执行失败。EMC 结果是设计风险筛查，不是合规测试替代品。
- 用户选择深度模式且已在第 3 步确认 AD 已启动时追加 `--with-ad`；否则不要加。CLI 通过本机 AD-MCP 调用 Altium 原生 ERC/DRC，并对工程中的 `.SchLib`/`.PcbLib` 做符号引脚与封装焊盘核对。AD 不可用、工具超时或库无法读取时，相应检查标 `failed`/`not_evaluated`；库明细被截断或部分元件未匹配到库符号/封装时标 `partial`，不得改写成通过，也不得把「已核对子集一致」说成全部通过。离线默认运行不产生 `AD-` finding；`rules.native_erc`/`native_drc`/`native_library` 为 `not_evaluated`。
- 命令失败时按退出码处理（见下），不要改用其他方式自行解析工程。

### 4. 只读 `summary.json`

- 读取 `<输出目录>/summary.json`（CLI 保证小于 32KB）。
- 需要补充细节时，只从 `<输出目录>/findings.json` 中提取对应的一到两条 finding（按 `rule_id` 或元件/网络定位），不要整份读入。
- 不要读取或粘贴 `snapshot.json`、`raw.json`、`pcb.json`；它们只用于排查和复现。

### 5. 用中文输出

按以下结构汇报，内容全部来自 `summary.json`：

1. **结论**：`status`（完成/部分完成）、必须修复/建议修复/可优化数量，以及一句话判断。
2. **工程概览**：工程名、选中板卡（`project.selectedBoard`）、原理图、文档覆盖（`coverage`）。
3. **问题清单**：只讲 `kind` 为 `issue` 的条目，按 `must_fix` → `should_fix` → `nice_to_have` 排序；每条给出规则、标题、定位（元件/网络/引脚）、证据。有建议（`recommendation`）时给出；没有就说明未给出，不要自行补充建议。summary 中的证据被截断时，从 `findings.json` 取对应单条补全。
4. **实测事实**：`kind` 为 `fact` 的条目（焊盘间距、载流、去耦摆放等）单独汇报，明确「不计入问题数量」。
5. **数据覆盖与未检查项**：列出 `rules` 中为 `partial`、`not_evaluated` 或 `failed` 的规则，并按 `coverage` 说明未覆盖范围与网表匹配率；summary 未给出原因时只说明「数据不足/未评估」，不要猜测。`datasheets` 只汇报 PDF 覆盖、MPN 匹配与提取计划状态；`datasheets.pinVerification` 始终为 `not_evaluated`，**不得说引脚已核对或通过**。`spice` 只汇报实际使用的仿真器/版本、逐子电路结果与测试台路径；未运行或未找到仿真器时明确说明，不得把 `not_evaluated` 说成通过。若 `summary.spice.missingCircuits > 0`（`excludedCircuits`/`unaccountedCircuits`），必须说明有候选未生成结果，不得说全部候选都已验证。`emc` 只汇报 `summary.emc` 中实际评估的类别/规则、问题与事实计数、未评估类别及原因；未启用、上游不可用或类别 `partial` 时必须如实说明，不得省略原因或声称合规。`native` 只汇报 `summary.native` 中的 ERC/DRC 计数、库匹配与不一致数量、各检查状态与失败原因；`--with-ad` 未启用或 AD 不可用时说明 `not_evaluated`，**不得把未运行说成通过**。说明 `findingsOmitted` 表示还有多少条结果未出现在 summary 中（完整清单在 `report.html`）。
6. **报告**：给出 `report` 字段中 `report.html` 的绝对路径。

## 退出码

- `0`：完成，按第 5 步汇报。
- `2`：输入无效或深度模式不可用。告知用户「路径或工程无效」或「深度模式不可用」，并引用 stderr 的具体原因（路径不存在、目录中没有 `.PrjPcb`、输出目录在工程内、Altium 未运行、AD-MCP 缺失、Python `mcp` 包缺失等）。不要读取或汇报任何产物。
- `3`：部分完成。告知用户「部分完成」，读取 `<输出目录>/manifest.json` 的 `errors`、`warnings`、`stages`，说明哪一步失败、哪些规则未评估；已生成的结果照常汇报，但必须标明缺失范围。`--with-ad` 已启用但 ERC/DRC/库工具失败或超时时同样返回 3。
- 其他非零退出码按工具运行失败处理，引用 stderr。

## 硬规则

- **只读源工程**：不修改、不新增、不移动源工程中的任何文件；所有输出只写入 `--out` 目录。
- **缺失数据标 `not_evaluated`**：`not_evaluated` 不等于通过，`failed` 不等于发现问题。
- **不编造**：只汇报 `summary.json` / `findings.json` 中存在的结论和证据，不臆造检查项或「通过」项。
- **不把整份 snapshot 塞进上下文**：`summary.json` 之外的原始数据按需单条提取。
