# AD-Happy

Altium Designer 工程的离线设计审查 Skill + CLI：解析 `.PrjPcb` / `.SchDoc` / `.PcbDoc`，自建原理图网表，复用 [kicad-happy](https://github.com/aklofas/kicad-happy) 的检测器，产出中文 `findings.json`、`summary.json` 与 `report.html`。不启动 Altium Designer，不修改源工程。

## 快速安装（从 tgz 分发包）

前提：Node ≥ 20、Python ≥ 3.10，以及 [kicad-happy](https://github.com/aklofas/kicad-happy) 仓库。

```powershell
# 1. 安装分发包（全局）
npm install -g .\ad-happy-0.1.0.tgz

# 2. 把技能链接到本机已有的 harness 技能目录（dsh / .agents / Claude Code）
ad-happy-install

# 3. kicad-happy 不在默认位置时，设置路径
$env:KICAD_HAPPY_SCRIPTS = "D:/path/to/kicad-happy/skills/kicad/scripts"
```

安装完成后，在 dsh 或 opencode 里直接说：

> 分析 `D:\你的工程` 这个 AD 工程

技能会先问你要不要开 Altium 做深度检查，然后自动分析并输出中文报告。

直接命令行使用：

```powershell
node "<安装目录>\scripts\analyze.mjs" --project "D:\你的工程" --out "D:\报告输出"
```

## 从源码安装

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
# EMC 预合规脚本（默认 D:/Tools/kicad-happy/skills/emc/scripts）
$env:KICAD_HAPPY_EMC_SCRIPTS = "D:/path/to/kicad-happy/skills/emc/scripts"
```

深度模式（`--with-ad`）还需要本机 AD-MCP 与 Python `mcp` 包：

```powershell
# AD-MCP 安装目录（默认 D:/NeroZe/pcb布局/AD26_PCB自动布局_工具包/01-altium-mcp/installed-v0.7.0）
$env:AD_HAPPY_AD_MCP_SERVER = "D:/path/to/ad-mcp/installed-v0.7.0"
# 可选：指定已安装 mcp 的解释器；默认依次尝试 <AD-MCP>/.venv/Scripts/python.exe、python、python3
$env:AD_HAPPY_AD_PYTHON = "C:/path/to/python.exe"
# 可选：单次工具调用超时（毫秒，默认 300000）与启动超时（默认 60000）
$env:AD_HAPPY_AD_TOOL_TIMEOUT_MS = "300000"
$env:AD_HAPPY_AD_STARTUP_TIMEOUT_MS = "60000"
```

`mcp` 包（以及 AD-MCP 的 pywin32、Pillow 依赖）缺失时 CLI 会以退出码 2 给出安装/构建命令，不会自行安装软件：

```bash
python -m pip install "mcp[cli]==1.30.0" pywin32 pillow
# 或让 AD-MCP 创建自己的 venv（只需一次）：
python "<AD-MCP>/start_server.py" --build
```

数据手册检查会优先使用 `KICAD_HAPPY_DATASHEETS_SCRIPTS`，否则由 `KICAD_HAPPY_SCRIPTS` 推导同级的 `datasheets/scripts`。缺少上游脚本时，匹配到的 PDF 会产生 `DS-003`（提取计划生成失败），不会伪造计划。

SPICE 仿真会优先使用 `KICAD_HAPPY_SPICE_SCRIPTS`，否则由 `KICAD_HAPPY_SCRIPTS` 推导同级的 `spice/scripts`。上游脚本缺失时 `--spice` 标记为 `failed`（`SP-002`、退出码 3），不会伪造仿真结果。

EMC 预合规优先使用 `KICAD_HAPPY_EMC_SCRIPTS`，否则由 `KICAD_HAPPY_SCRIPTS` 推导同级的 `emc/scripts`。显式设置了 `KICAD_HAPPY_EMC_SCRIPTS` 但目录无效时不会回退到默认路径：`--emc` 标记为 `not_evaluated` 并说明原因，退出码不变。

自检：

```bash
node .agents/skills/ad-happy/scripts/selfcheck.mjs
```

## 运行

```bash
node .agents/skills/ad-happy/scripts/analyze.mjs --project "<工程目录或 .PrjPcb>" [--out "<输出目录>"] [--project-file "<PrjPcb 文件名>"] [--board "<PcbDoc 文件名>"] [--gerber "<Gerber 目录>"] [--bom "<BOM CSV>"] [--datasheets "<数据手册目录>"] [--spice] [--emc] [--with-ad] [--svg]
```

- 同目录有多个 `.PrjPcb` 时必须用 `--project-file` 指定，否则退出码 2 并列出候选。
- 默认审查文档清单中最后一块 `PcbDoc`，可用 `--board` 指定。
- `--gerber` 指向 Altium 导出的 Gerber/钻孔目录；省略时自动查找工程目录下的 `Gerber`、`Outputs`、`Project Outputs`、`Manufacturing`。找不到时在 `manifest.warnings` 说明原因，并把制造文件检查标记为 `not_evaluated`。缺少钻孔文件时钻孔相关检查同样是 `not_evaluated`，不会当成通过。
- `--bom` 导入 Altium 导出的 BOM CSV 并与解析到的元件比对；列名大小写不敏感，支持 `Designator`/`Comment`/`Footprint`/`Quantity`/`Description`/`Supplier Part Number`/`MPN` 以及 `位号`/`注释`/`封装`/`数量` 等中文表头。省略时按解析数据生成 `bom.csv` 与 `procurement.csv`（采购清单不联网，「建议渠道」留空）。
- `--datasheets` 指定数据手册 PDF 目录；省略时自动查找工程下的 `datasheets/`。CLI 扫描 PDF、按 MPN 匹配元件，并对匹配到的型号调用上游 `plan_extraction.py` 生成提取计划。提取计划与 scout 缓存写入 `<输出目录>/datasheets/`，不写源工程。它**不解析 PDF 引脚表**：引脚级核对始终为 `not_evaluated`，需要 AI/人工依据 PDF 提取后完成。数据手册缺口（`found`/`partial`/`not_evaluated`）不改变整体退出码；只有目录扫描/IO 异常导致的 `failed` 参与聚合。
- `--spice` 显式启用 SPICE 仿真（默认关闭）。CLI 按 `SPICE_SIMULATOR` → `NGSPICE_PATH`/`LTSPICE_PATH`/`XYCE_PATH` → `PATH` → Windows 常见安装目录的顺序检测 ngspice、LTspice、Xyce；找到后把检测到的分压器、RC 滤波、去耦、稳压器反馈等子电路交给上游 `simulate_subcircuits.py`。没有仿真器时 `rules.spice = not_evaluated`、产生一条 `SP-001` 说明缺什么/如何安装，**退出码不变**，不会编造仿真结果。仿真执行失败或上游脚本缺失产生 `SP-002`（`failed`，退出码 3）；单个子电路未完成也产生 `SP-002` 警告，但只把结果记为 `skip`（全部跳过时规则为 `not_evaluated`）。如果某个候选因缺少上游模板必需字段（例如稳压器没有反馈分压器）而未生成结果，规则至少为 `partial`（没有任何结果时 `not_evaluated`），并为该候选产生 `SP-002`，不会把其余结果当作全部通过。结果与解析值不一致产生 `SP-003`（`found`，不改变退出码）。
- `--emc` 显式启用 EMC 预合规分析（默认关闭），复用上游 `analyze_emc.py`，默认适用标准为 `fcc-class-b`。原理图侧的稳压器、晶振、保护器件、LC/RC 滤波与差分对由 `scripts/reuse/emc_prepare.py` 复用 kicad-happy 检测器生成；PCB 侧的元件、焊盘、走线、过孔、层序与板框尺寸直接来自快照。**离线解析不捕获铺铜/区域填充形状、板框线段、信号换层、走线邻近度与叠层介质参数**，因此 GP-001/002/003/004、CK-004、EE-001、BE-001/002、XT-001、RP-001、PD-001/002/003/004、SU-002/003、SW-002、DP-001/002 等规则固定标记 `not_evaluated` 并给出原因，绝不静默当作通过。原理图网表不完整时，所有依赖原理图检测器的规则（SW、EE-002、TH、IO-001、ES、EF、ML-001、CK-001/002、DP 等）同样降级为 `not_evaluated`；报告 EMC 章节会显示网表完整性。ML-001 的敏感器件集合来自晶振/ADC/运放/RF 四个检测器，任一检测器未成功运行也会降级。适配输入写入 `<输出目录>/emc-input/`，归一化结果写入 `emc.json`；`emc-input/` 每次运行重建。`found`/`partial`/`not_evaluated` 不改变退出码，只有上游执行失败（`failed`）参与聚合。
- `--with-ad` 显式启用深度模式（默认关闭）。CLI 先检测 Altium Designer 进程（`X2.EXE`）、AD-MCP 服务端与 Python 依赖（`mcp`/pywin32/Pillow）；任一项不满足时以退出码 **2** 结束，并说明缺什么/如何安装，**不会静默退回离线结果**。可用时通过 `scripts/ad/mcp_client.py` 以 stdio 启动 AD-MCP，调用 `get_erc_violations`、`run_drc`、`get_symbol_primitives`、`get_footprint_primitives`，把结果归一化为 `AD-ERC-*`、`AD-DRC-*`、`AD-LIB-*` finding（`source: "altium-native"`）。ERC/DRC 工具失败、超时或未实际运行（`ran=false`）时标记 `failed` 并产生 `AD-ERC-000`/`AD-DRC-000`/`AD-LIB-000` 说明，绝不伪造违规；库文件只支持 `.SchLib`/`.PcbLib`，`.IntLib` 标 `not_evaluated`。库明细超过 `AD_HAPPY_AD_MAX_LIBRARY_DUMPS` 或部分元件未匹配到库符号/封装时，相关库标 `partial` 并在报告列出未核对范围，不会把「已核对子集一致」写成全部通过。请求、原始结果、AD-MCP 的 per-run home 写入 `<输出目录>/ad/`，归一化结果写入 `ad.json`。
- 退出码：`0` 完成；`2` 输入无效或深度模式不可用（AD 未运行、AD-MCP 缺失、`mcp` 包缺失）；`3` 部分完成（解析失败、规则 failed、原生工具失败/超时或输出不完整）。
- 默认输出到 `%LOCALAPPDATA%\ad-happy\runs\<run-id>`；`--out` 只接受空目录或带 `.ad-happy-run` 标记的 AD-Happy 输出目录，避免删除用户文件。

产物：`manifest.json`（来源/版本/阶段状态）、`snapshot.json`、`raw.json`、`pcb.json`、`findings.json`、`pipeline-summary.json`、`gerber.json`（上游 Gerber 原始输出，仅在运行 Gerber 分析时生成）、`bom.csv` / `procurement.csv`（物料与采购清单）、`datasheets.json`（PDF 扫描、MPN 匹配与提取计划状态，仅在找到数据手册目录时生成）、`spice.json`（仿真器、逐子电路结果与测试台路径，仅在 `--spice` 时生成）、`spice/`（分析输入、上游仿真结果与 `.cir`/日志；每次运行重建）、`emc.json`（EMC 覆盖、类别、检测器状态与归一化 finding，仅在 `--emc` 时生成）、`emc-input/`（适配后的 schematic/pcb、raw 与上游 `analyze_emc.py` 原始输出；每次运行重建）、`ad.json`（AD 原生检查的可用性、覆盖、逐库结果与归一化 finding，仅在 `--with-ad` 时生成）、`ad/`（MCP 请求/原始结果与本次运行的 AD-MCP home；每次运行重建）、`summary.json`（<32KB，给模型读；超限时先裁剪 top findings、板卡清单与 EMC/可选阶段覆盖明细，完整信息在 `report.html` / `emc.json`）、`report.html`（单文件中文报告）。

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
- EMC 预合规只覆盖离线快照能支撑的规则。铺铜/区域填充形状、板框线段、信号换层/过孔层对、走线邻近度和叠层介质厚度/εr 不在快照中：对应规则标记 `not_evaluated`，上游因空数据产生的兜底 finding（如「未检测到接地平面」「板腔谐振」）会被排除并记录在 `coverage.suppressedFindings`。EMC 结果是设计风险筛查，不是合规测试的替代品。
- `--with-ad` 需要 Altium Designer 正在运行且 AD-MCP 已安装；本工具**不安装 AD-MCP、不下载软件**。AD-MCP 的 `run_drc` 通过驱动 Design Rule Checker 对话框运行，Altium 版本/界面语言或未关闭的对话框都可能让检查无法启动；此时 `native_drc` 标 `failed`（退出码 3），不会生成伪造的 DRC 结论。`.IntLib` 不能直接交给符号/封装原语工具，标 `not_evaluated`；库符号只按原理图 Comment/`LibReference` 等名称匹配，匹配不到时核对标 `partial` 并说明原因，不会猜测。
- 上游 kicad-happy 检测器的 finding 文案已由适配层翻译成中文；原文保留在 `findings.json` 的 `source_text` 中，个别无法安全翻译的文本以「（检测器原文）」标注。

## 许可

复用组件的许可见 `THIRD-PARTY-NOTICES.md`。kicad-happy 目录只读，不随本仓库分发。
