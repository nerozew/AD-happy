# AD-Happy 第二阶段：能力补全计划

版本 v0.1 · 2026-11-25 · 状态：待批准

## 目标

在已交付的离线分析（10 条规则 + 交叉检查）之上，补齐 kicad-happy 的分析侧能力，并按用户选择接入 Altium 原生检查。

## 现状

已实现：

- 离线解析 `.PrjPcb` / `.SchDoc` / `.PcbDoc`
- 自建原理图网表（22/22 引脚、6 网络）
- 原理图 6 条规则、PCB 4 条规则、跨域交叉检查
- 中文报告、失败可见、环境自检
- SKILL.md 已支持「离线 / 深度」两种模式的说明与询问

未实现：Gerber、BOM、数据手册、SPICE、EMC、AD 原生检查。

## 阶段划分

| 阶段 | 功能 | 依赖 | 预计 |
|---|---|---|---|
| P1 | Gerber + 钻孔分析 | 无 | 1 天 |
| P2 | BOM 检查与采购清单 | 无 | 1 天 |
| P3 | 数据手册核对 | 用户提供 PDF | 2–3 天 |
| P4 | SPICE 仿真 | 本机装 ngspice/LTspice | 2–3 天 |
| P5 | EMC 预合规 | 无 | 3–5 天 |
| P6 | AD 原生检查（ERC/DRC/库/网表） | AD 运行 + AD-MCP | 3–5 天 |

**总计约 2–3 周。** 每个阶段独立可交付，按顺序做，也可按需跳过。

---

## P1 · Gerber + 钻孔分析

**为什么先做**：Gerber 与 EDA 格式无关，kicad-happy 的 `analyze_gerbers.py` 可直接复用；AD 用户本来就要用 OutJob 导出 Gerber，这是打板前必查项。

**输入**：`--gerber <目录>`，目录内含 `.gbr` / `.drl` / `.gbrjob` / `.zip`。

**实现**：

1. CLI 新增 `--gerber`；未指定时自动在工程目录下查找 `Gerber` / `Outputs` / `Project Outputs` 子目录。
2. 新增 `scripts/reuse/gerber.mjs`：以子进程调用 `python <kicad-happy>/skills/kicad/scripts/analyze_gerbers.py <目录> --output <json>`。
3. 把返回的 findings 合并进 `pipeline-summary.json`，规则前缀 `GB-`。
4. 报告新增「制造文件」小节，显示层数、钻孔数、缺失层、单位。

**验收**：

- 用样板工程的 OutJob 导出 Gerber，跑通并产出至少一条有效结论。
- 目录为空或缺少钻孔文件时，标 `not_evaluated` 并说明缺什么。

**风险**：AD 导出的层命名与 KiCad 不同，可能需要一层层名映射。

---

## P2 · BOM 检查与采购清单

**输入**：`--bom <csv>`，或未指定时从工程元件生成。

**实现**：

1. CLI 新增 `--bom`；未指定时用已解析的元件（位号、值、封装、MPN）生成 `bom.csv`。
2. 新增 `scripts/bom.mjs`：
   - 检查：缺 MPN、缺封装、重复位号、数量为 0、BOM 与工程元件不一致。
   - 采购清单：输出 `procurement.csv`（位号、MPN、数量、建议渠道），**不联网**。
3. AD 导出的 BOM 列名做映射（`Designator`/`Comment`/`Footprint`/`Quantity` 等）。

**验收**：

- 样板工程生成的 BOM 与 AD 导出的 BOM 元件数一致。
- 采购清单包含全部元件，缺 MPN 的单独标出。
- 报告新增「物料」小节。

**风险**：AD BOM 模板差异大，列名映射需要可配置。

---

## P3 · 数据手册核对

**输入**：`--datasheets <目录>`，目录内放 `<MPN>.pdf`。

**实现**：

1. 复用 kicad-happy `skills/datasheets/scripts/` 的 PDF 提取。
2. 按 MPN 匹配工程元件，核对引脚号/功能与原理图引脚名。
3. 缺失数据手册的元件标 `not_evaluated`，不猜。

**验收**：

- 一个 PDF 能提取出引脚表。
- 原理图引脚与数据手册不一致时产出 finding。
- 无 PDF 时报告明确写「未核对」。

**风险**：PDF 提取质量依赖厂商排版；需要多个样本验证。

---

## P4 · SPICE 仿真

**输入**：`--spice`（需要本机安装 ngspice / LTspice / Xyce）。

**实现**：

1. 复用 `skills/spice/scripts/` 的网表生成与仿真器调用。
2. 从已识别的 RC/分压/LC/运放电路生成 testbench，跑批处理，解析结果。
3. 本机无仿真器时，标 `not_evaluated` 并给出安装提示。

**验收**：

- 样板上的 RC/分压电路能被识别并生成 testbench。
- 仿真结果与解析计算一致（误差 < 5%）。
- 无仿真器时明确提示，不静默跳过。

**风险**：仿真器版本差异；子电路识别错误会导致仿真对象错误。

---

## P5 · EMC 预合规

**输入**：`--emc`（吃已有原理图/PCB 分析结果）。

**实现**：

1. 复用 `skills/emc/scripts/` 的 44 条规则。
2. 需要把 AD 侧数据转成 EMC 期望的 JSON 字段（层叠、铺铜、回流路径）。
3. 铺铜实形目前离线拿不到，相关规则标 `not_evaluated`。

**验收**：

- 报告出现 EMC 风险项，且每条标明数据来源与覆盖状态。
- 缺铺铜数据时，相关规则不报「通过」。

**风险**：EMC 规则对铺铜/回流路径依赖强，离线数据不足会影响覆盖度。

---

## P6 · AD 原生检查（深度模式）

**前提**：AD 已打开，AD-MCP 可用。

**入口**：`--with-ad`。SKILL.md 已在分析前询问用户。

**实现**：

1. 新增 `scripts/ad/`：
   - `erc.mjs`：调用 AD-MCP `get_erc_violations`。
   - `drc.mjs`：调用 AD-MCP `run_drc`。
   - `library.mjs`：调用 `get_symbol_primitives` / `get_footprint_primitives`。
   - `netlist.mjs`：调用 `get_project_components`，用于校核离线网表。
2. 结果与离线结果合并，每条 finding 标记 `source: offline | ad`。
3. AD 不可用时，`--with-ad` 返回明确错误，不静默退回离线。

**验收**：

- AD 打开时能拿到 ERC/DRC 原生结果并合并。
- AD 未打开时给出清晰提示。
- 报告「检查来源」小节区分两类结果。
- 离线与 AD 网表不一致时产出 finding（说明离线解析有缺口）。

**风险**：AD-MCP 需要额外安装/配置；调用时 AD 可能弹出对话框阻塞。

---

## 不做 / 延后

| 功能 | 原因 |
|---|---|
| 热估算 | 依赖封装热阻数据，需要额外数据源 |
| 版本差异 | 需要两版快照，用户暂不需要 |
| 采购 API（DigiKey/Mouser 等） | 需要 API key，先用采购清单替代 |
| 制造下单（嘉立创/PCBWay） | 联网上传，涉及账号，暂不做 |
| 独立库文件解析（离线） | altiumts 不支持，AD 在场时由 P6 覆盖 |

## 执行顺序建议

1. **P1 + P2**：零依赖，一天一个，先让报告覆盖制造与物料。
2. **P6**：你已有 AD 和 AD-MCP，这是差异化能力，做完后报告能同时展示原生与离线结果。
3. **P3 + P4**：需要样本（PDF、仿真器），可以并行准备。
4. **P5**：依赖最多，放最后。

## 每阶段的统一要求

- 不修改 kicad-happy。
- 新功能必须有「有数据能出结论、无数据标 not_evaluated」两条测试。
- 报告新增小节必须中文。
- 每个阶段结束后重新生成 `docs/sample-report/` 供肉眼验收。
