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
# 数据手册提取计划脚本（默认 D:/Tools/kicad-happy/skills/datasheets/scripts）
$env:KICAD_HAPPY_DATASHEETS_SCRIPTS = "D:/path/to/kicad-happy/skills/datasheets/scripts"
# SPICE 仿真脚本（默认 D:/Tools/kicad-happy/skills/spice/scripts）
$env:KICAD_HAPPY_SPICE_SCRIPTS = "D:/path/to/kicad-happy/skills/spice/scripts"
```

数据手册检查会优先使用 `KICAD_HAPPY_DATASHEETS_SCRIPTS`，否则由 `KICAD_HAPPY_SCRIPTS` 推导同级的 `datasheets/scripts`。缺少上游脚本时，匹配到的 PDF 会产生 `DS-003`（提取计划生成失败），不会伪造计划。

SPICE 仿真会优先使用 `KICAD_HAPPY_SPICE_SCRIPTS`，否则由 `KICAD_HAPPY_SCRIPTS` 推导同级的 `spice/scripts`。上游脚本缺失时 `--spice` 标记为 `failed`（`SP-002`、退出码 3），不会伪造仿真结果。

自检：

```bash
node .agents/skills/ad-happy/scripts/selfcheck.mjs
```

## 运行

```bash
node .agents/skills/ad-happy/scripts/analyze.mjs --project "<工程目录或 .PrjPcb>" [--out "<输出目录>"] [--project-file "<PrjPcb 文件名>"] [--board "<PcbDoc 文件名>"] [--gerber "<Gerber 目录>"] [--bom "<BOM CSV>"] [--datasheets "<数据手册目录>"] [--spice] [--svg]
```

- 同目录有多个 `.PrjPcb` 时必须用 `--project-file` 指定，否则退出码 2 并列出候选。
- 默认审查文档清单中最后一块 `PcbDoc`，可用 `--board` 指定。
- `--gerber` 指向 Altium 导出的 Gerber/钻孔目录；省略时自动查找工程目录下的 `Gerber`、`Outputs`、`Project Outputs`、`Manufacturing`。找不到时在 `manifest.warnings` 说明原因，并把制造文件检查标记为 `not_evaluated`。缺少钻孔文件时钻孔相关检查同样是 `not_evaluated`，不会当成通过。
- `--bom` 导入 Altium 导出的 BOM CSV 并与解析到的元件比对；列名大小写不敏感，支持 `Designator`/`Comment`/`Footprint`/`Quantity`/`Description`/`Supplier Part Number`/`MPN` 以及 `位号`/`注释`/`封装`/`数量` 等中文表头。省略时按解析数据生成 `bom.csv` 与 `procurement.csv`（采购清单不联网，「建议渠道」留空）。
- `--datasheets` 指定数据手册 PDF 目录；省略时自动查找工程下的 `datasheets/`。CLI 扫描 PDF、按 MPN 匹配元件，并对匹配到的型号调用上游 `plan_extraction.py` 生成提取计划。提取计划与 scout 缓存写入 `<输出目录>/datasheets/`，不写源工程。它**不解析 PDF 引脚表**：引脚级核对始终为 `not_evaluated`，需要 AI/人工依据 PDF 提取后完成。数据手册缺口（`found`/`partial`/`not_evaluated`）不改变整体退出码；只有目录扫描/IO 异常导致的 `failed` 参与聚合。
- `--spice` 显式启用 SPICE 仿真（默认关闭）。CLI 按 `SPICE_SIMULATOR` → `NGSPICE_PATH`/`LTSPICE_PATH`/`XYCE_PATH` → `PATH` → Windows 常见安装目录的顺序检测 ngspice、LTspice、Xyce；找到后把检测到的分压器、RC 滤波、去耦、稳压器反馈等子电路交给上游 `simulate_subcircuits.py`。没有仿真器时 `rules.spice = not_evaluated`、产生一条 `SP-001` 说明缺什么/如何安装，**退出码不变**，不会编造仿真结果。仿真执行失败或上游脚本缺失产生 `SP-002`（`failed`，退出码 3）；单个子电路未完成也产生 `SP-002` 警告，但只把结果记为 `skip`（全部跳过时规则为 `not_evaluated`）。结果与解析值不一致产生 `SP-003`（`found`，不改变退出码）。
- 退出码：`0` 完成；`2` 输入无效；`3` 部分完成（解析失败、规则 failed 或输出不完整）。
- 默认输出到 `%LOCALAPPDATA%\ad-happy\runs\<run-id>`；`--out` 只接受空目录或带 `.ad-happy-run` 标记的 AD-Happy 输出目录，避免删除用户文件。

产物：`manifest.json`（来源/版本/阶段状态）、`snapshot.json`、`raw.json`、`pcb.json`、`findings.json`、`pipeline-summary.json`、`gerber.json`（上游 Gerber 原始输出，仅在运行 Gerber 分析时生成）、`bom.csv` / `procurement.csv`（物料与采购清单）、`datasheets.json`（PDF 扫描、MPN 匹配与提取计划状态，仅在找到数据手册目录时生成）、`spice.json`（仿真器、逐子电路结果与测试台路径，仅在 `--spice` 时生成）、`spice/`（分析输入、上游仿真结果与 `.cir`/日志；每次运行重建）、`summary.json`（<32KB，给模型读）、`report.html`（单文件中文报告）。

`SKILL.md` 描述 AI harness 的固定使用流程；直接运行 CLI 时以本 README 为准。

## 已知限制

- 单文件输入上限 50MB；超过会将该文档标记为解析失败（退出码 3），不会继续硬解析。
- Python 分析阶段超时 120 秒；超时会写 manifest 错误并退出码 3。
- 不解析 `.SchLib` / `.PcbLib` / `.IntLib`；层次原理图、总线、装配变体与自动修复不在首版范围。
- 网表匹配率不足（引脚未全部入网）时，依赖网表的原理图规则标记为 `not_evaluated`，不会当作通过。
- Gerber 分析复用 kicad-happy 的 `analyze_gerbers.py`：只解析 `.drl` 与 Excellon `.txt` 钻孔文件；检测到 `.xln`/`.nc` 时会注明未纳入评估。没有 Gerber/钻孔输入时制造文件检查为 `not_evaluated`。
- BOM 检查从 Altium 元件参数（`Part Number`/`MPN`/`Manufacturer Part Number` 等，支持带序号命名）读取 MPN；工程完全没有型号数据时，缺 MPN 检查标记为 `not_evaluated`，不会给出「全部通过」，也不会因此把整次运行判为部分完成。采购清单不联网、不推断分销商库存。
- 数据手册检查只做确定性工作：扫描 PDF、按 MPN 匹配、生成上游提取计划。没有 `datasheets/` 目录、没有 PDF 或没有 scout 缓存时标记 `not_evaluated`；缺少 PDF 的集成电路产生 `DS-001`，未匹配的 PDF 产生 `DS-002`，上游计划生成失败产生 `DS-003`（覆盖缺口 `found`，不改变退出码）。**不做引脚级核对**，也不会用正则解析 PDF 引脚表冒充验证。
- `plan_extraction.py` 要求先有 AI scout 写出的 `<MPN>.scout.json`；本工具不会伪造 scout。scout 与生成的 `<MPN>.plan.json` 都放在 `<输出目录>/datasheets/`：首次运行建立输出目录后，把 scout 写入该目录并再次运行即可。缺少 scout 时计划状态为 `not_evaluated`，需要 AI/人工继续。
- SPICE 仿真需要本机已安装 ngspice、LTspice 或 Xyce，本工具**不下载也不安装软件**。仿真范围取决于上游模板注册表与 AD-Happy 已检测到的子电路（当前为分压器、RC 滤波、去耦、稳压器反馈）；没有可仿真子电路时标记 `not_evaluated`。LTspice 没有可靠的命令行版本查询方式，报告会显示「版本未知」而不是猜测。上游 ASCII 结果解析失败或测量缺失的子电路记为 `skip`（`SP-002` 警告），不会当作通过。
- 上游 kicad-happy 检测器的 finding 文案已由适配层翻译成中文；原文保留在 `findings.json` 的 `source_text` 中，个别无法安全翻译的文本以「（检测器原文）」标注。

## 许可

复用组件的许可见 `THIRD-PARTY-NOTICES.md`。kicad-happy 目录只读，不随本仓库分发。
