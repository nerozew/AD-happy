# AD-Happy 开发框架与计划

版本 v0.2 · 2026-11-24 · 设计稿，待批准

> v0.2 依据对 altiumts 0.0.95、kicad-happy 6a91aaa 和真实样板工程的实测结果修订。
> 推翻了 v0.1 的三个假设：原理图 netGraph 可用、库文件可解析、原生插件是主路径。

## 1. 目标与边界

### 1.1 是什么

一个运行在 AI harness 里的 Altium 设计审查 Skill。用户给出一个工程文件夹路径，它自动完成：

1. 找到工程文件（`.PrjPcb`），列出其中的 `.SchDoc` / `.PcbDoc`
2. **离线解析**，不启动 Altium Designer
3. 自建原理图网表，与 PCB 焊盘网络交叉验证
4. 用 kicad-happy 的检测器分析
5. 输出 `findings.json`、`summary.json`、`report.html`，由 AI 用中文给出结论

### 1.2 为什么

kicad-happy 证明了「结构化解析 → 规则引擎 → 证据链报告」这套模式有效，但绑死 KiCad 格式。AD 自带的 ERC/DRC 必须打开工程、结果不可编程。设计师需要「给个路径就出审查报告」。

关键架构事实（已读源码确认）：

- **原理图侧**：40+ 个检测器是 `detect_xxx(ctx: AnalysisContext)` 纯函数，只依赖数据对象
- **PCB 侧**：检测器是 `analyze_xxx(footprints, tracks, vias, ...)` 显式参数纯函数
- 两者都不读文件，因此可以复用，前提是适配层喂对数据

### 1.3 成功标准

- 给定真实样板工程，一条命令产出 HTML 报告，内容为「检查了什么 / 发现了什么 / 哪些没评估」
- 在故意改错引脚或焊盘网络的工程上，能定位到具体实例、引脚/焊盘号和两侧网络
- **不修改 kicad-happy 的任何规则代码**
- 升级 kicad-happy 后，唯一需要维护的是适配层

### 1.4 不做什么

| 不做 | 原因 |
|---|---|
| AD 内插件（DelphiScript / .dxt） | 用户已确认走 harness 路线 |
| 独立库文件解析（`.SchLib` / `.PcbLib` / `.IntLib`） | kicad-happy 自己也不做；altiumts 三种格式全部抛错 |
| 原生 ERC/DRC 结果 | 需要 AD 运行，离线拿不到 |
| 自动修复 | 二进制文件只读，改硬件设计风险太高 |
| 重写检测器 | 复用是方案的核心价值 |
| 电源轨启发式猜测 | 严格照 kicad-happy 语义，只补 Power Port 映射 |

## 2. 架构

### 2.1 数据流

```
用户：分析 D:\xxx 这个 AD 工程
   │
   ▼
.agents/skills/ad-happy/SKILL.md
   │  （dsh 与 opencode 共同自动发现）
   ▼
node scripts/analyze.mjs --project <绝对路径> --out <输出目录>
   │
   ├─ discover.mjs     PrjPcb → 文档清单、变体
   ├─ pcb.mjs          altiumts → 元件、焊盘、网络、走线、过孔、规则、层叠、板框
   ├─ sch.mjs          altiumts → 元件、引脚、导线、标签、电源端口
   ├─ connectivity.mjs 自建并查集 → nets / pin_net（约 50–100 行）
   ├─ adapter.py       raw.json → AnalysisContext / footprints
   └─ detectors.py     调用 kicad-happy 检测器
   │
   ▼
analysis/<run-id>/
   ├─ manifest.json    来源、版本、覆盖状态
   ├─ snapshot.json    解析原始数据
   ├─ findings.json    规则结果
   ├─ summary.json     <32KB，给模型读
   └─ report.html      中文报告，内嵌 SVG
```

**为什么是 Node + Python 两个运行时：** altiumts 只有 TypeScript 版，kicad-happy 只有 Python 版。用 JSON 文件做进程契约，简单、可离线复现、崩溃隔离。

**为什么不是原生插件：** dsh 与 opencode 唯一共同自动发现路径是 `.agents/skills/`；原生插件不能实现「给路径自动触发」，且 dsh 仍是 developer preview。

### 2.2 目录结构

```
ad-happy/
├── .agents/skills/ad-happy/
│   ├── SKILL.md                  # name + description，中文正文
│   ├── package.json              # type=module；altiumts 锁定 0.0.95
│   ├── scripts/
│   │   ├── analyze.mjs           # 唯一入口
│   │   ├── discover.mjs
│   │   ├── pcb.mjs
│   │   ├── sch.mjs
│   │   ├── connectivity.mjs      # 自建原理图网表
│   │   ├── adapter.py            # AD → AnalysisContext
│   │   ├── detectors.py          # 调 kicad-happy
│   │   ├── report.mjs            # HTML（SVG 渲染走 altiumts）
│   │   └── selfcheck.mjs         # 环境自检
│   ├── references/
│   │   └── checks.md             # 规则清单与覆盖边界
│   └── templates/report.html
├── .opencode/opencode.json       # {"skills": {"paths": ["./ .agents/skills"]}}
├── AGENTS.md                     # 路由：给 AD 工程路径时使用 ad-happy 技能
├── docs/
├── tests/
│   ├── fixtures/                 # MIT 样板 + 故意改错的最小工程
│   └── expected/
└── THIRD-PARTY-NOTICES.md        # kicad-happy MIT + altiumts MIT + 样板 MIT
```

### 2.3 与 kicad-happy 的关系

- **不复制代码。** `KICAD_HAPPY_SCRIPTS` 指向 `skills/kicad/scripts`，`sys.path.insert` 后 import。
- **不修改文件。** 目录保持只读，锁定提交 `6a91aaa`。
- **保留许可。** `THIRD-PARTY-NOTICES.md` 写明 MIT 与版权人（Andrew Klofas）。
- **契约测试。** 升级前跑一遍，确认 `AnalysisContext` 字段和检测器签名未变。

## 3. 核心设计

### 3.1 解析层（Node + altiumts 0.0.95）

**实测能力（样板工程，二进制 CFB）：**

| 文件 | 结果 | 耗时 |
|---|---|---|
| `PCB4 (Final Design).PcbDoc` | 9 元件、22 焊盘、6 网络、208 走线、19 过孔、35 规则、11 区域、13 铺铜 | 36 ms |
| `SCH1_Main.SchDoc` | 424 记录、9 元件、22 引脚、15 导线、4 网络标签、6 电源端口 | 16 ms |

**可直接使用：**
- `getPcbComponents()` → 元件、位号、封装、位置、旋转、层
- `getRecordsOwnedByComponent()` → 焊盘，含 `pad.name` 和 `net.name`
- `getPcbNets()` / `getPcbLayerStack()` / `getPcbBoardGeometry()` / `getPcbRecordRule()`
- `serializeAltiumPcbToSvg()` / `serializeAltiumSheetToSvg()` → 自包含 SVG，可嵌 HTML

**必须绕开的陷阱：**

| 陷阱 | 事实 | 处理 |
|---|---|---|
| `schDoc.netGraph` | 33 个碎片网络，22/22 引脚孤立，0 个进入命名网络 | 不使用，自建连通性 |
| `component.designator` | 二进制与 ASCII 均为 `undefined` | 从 `OWNERINDEX` 指向的 `RECORD=34` 读 |
| `component.id` / `net.id` | 二进制上为 `undefined` | 用数组索引或 `getComponentByIndex()` |
| `.PcbLib` / `.SchLib` / `.IntLib` | 分别抛 `AltiumFormatDetectionError` / `AltiumUnsupportedFeatureError` / `AltiumFormatDetectionError` | 不支持，报告标注未检查 |
| 规则 Scope | 只作为文本保存，不求值 | 不判断对象命中哪条规则，只展示规则清单 |
| 层次/总线 | `netGraph` 不处理 bus、sheet entry、port | v1 显式降级并提示 |
| 二进制写回 | 修改后的二进制被拒绝序列化 | 只读，不做自动修复 |

**版本策略：** 锁定 `altiumts@0.0.95`（exact），无原生依赖，Node ≥ 20。

### 3.2 连通性引擎（自建，约 50–100 行）

**为什么必须有：** altiumts 的 `netGraph` 只对导线顶点做精确坐标并查集，把引脚根部的 `LOCATION` 当连接点，忽略引脚长度、方向、点在线段上、junction、T 型连接。实测样板 33 个碎片网络、0 个引脚入网。

**算法：**

1. **引脚热点** = `LOCATION` + `PINLENGTH` × 方向。方向从 `PINCONGLOMERATE` 低 2 位解码（二进制 SchDoc 不含 `ORIENTATION` 字段）。
2. **导线顶点**做并查集。
3. **点在线段上**：容差 1e-3 ~ 5e-3（实测 1e-4 会多出 2 个假失配）。
4. **T 型连接与 junction**：junction 坐标同时吸附到相交线段。
5. **同名网络合并**：网络标签、电源端口、同名导线归并。

**已验证结果：** 22/22 引脚、6 个网络，与 PCB 的 6 个网络完全一致（IN、NetC1_1、SW、OUT、GND、FB）。

**跨文档匹配：** PCB 的 `NetC1_1` 对应原理图中未命名的 VBST 节点。**必须按 `(位号, 引脚/焊盘号)` 匹配，不能只按网络名**，否则漏 1 个网络。

### 3.3 适配层（Python）

**原理图 → `AnalysisContext`**

| 字段 | AD 来源 |
|---|---|
| `components[].reference` | `AltiumSchDesignatorRecord.text`（RECORD=34） |
| `components[].value` | Comment 字段；若为 `=Value` 表达式，解析 `Value` 参数 |
| `components[].type` | `classify_component(ref, lib_id, value)` |
| `components[].lib_id` | `Library:Symbol` 拼接 |
| `components[].footprint` | RECORD=44 → 45 两层 owner 链上的 `ModelName` |
| `components[].pins` | `AltiumSchPinRecord` |
| `nets` / `pin_net` | 自建连通性引擎（3.2） |
| `known_power_rails` | Power Port 映射为 `#PWR`，填充此集合 |

**PCB → 检测器输入**

| 字段 | AD 来源 |
|---|---|
| `footprints[]` | `getPcbComponents()` |
| `footprints[].pads` | `getRecordsOwnedByComponent()` |
| `tracks` / `vias` | PcbDoc 记录，**先按铜层过滤** |
| `net_names` | `getPcbNets()` + 索引偏移 |
| `outline` | `getPcbBoardGeometry()` |
| `rules` | `getPcbRecordRule()` |

**必须补齐的语义（否则静默漏检）：**

1. **单位**：altiumts 输出 mil，转 mm 用 **×0.0254**。（v0.1 写成 ×0.254，差 10 倍。）
2. **net 0 陷阱**：PcbDoc 的 net index 0 是真实网络（样板为 SW），不是「未连接」。适配层必须 +1 偏移；KiCad 用 0 表示无网络。
3. **铜层过滤**：样板 208 条 track 中只有 40 条是真铜（TOP 33 + BOTTOM 7），其余是丝印、机械、keepout。不过滤会让 DFM、线宽、间距、载流全部失真。
4. **电源符号**：AD 的 Power Port → `#PWR` 前缀伪元件。样板 6 个 Power Port 全是 GND；`IN`/`OUT` 只是网络标签，`is_power_net_name` 不识别。这是数据未标注，不是工具缺陷，报告中如实说明。
5. **未命名网络**：统一 `__unnamed_N`；报告同时显示 PCB 侧的 AD 编译名（如 `NetC1_1`），两者不强行对齐。
6. **引脚类型**：AD `Input/Output/Passive/Power/Bidirectional/OpenCollector/...` → KiCad `input/output/passive/power_in/power_out/bidirectional`。
7. **No-ERC**：`AltiumSchNoErcRecord` 映射到 `no_connects`，避免把故意悬空的引脚报成错误。

### 3.4 规则层（复用 kicad-happy）

**原理图（6 条，全部 `detect_xxx(ctx)`）**

| 规则 | 函数 |
|---|---|
| 电压分压 | `detect_voltage_dividers(ctx)` |
| RC 滤波 | `detect_rc_filters(ctx, dividers)` |
| 去耦 | `detect_decoupling(ctx)` |
| 电源稳压器 | `detect_power_regulators(ctx, dividers)` |
| 单引脚网络 / 未连接 | `analyze_connectivity(components, nets, no_connects)` |
| 短路的两脚元件 | `detect_shorted_two_pin_components(ctx)` |

**PCB（4 条，显式参数）**

| 规则 | 函数 |
|---|---|
| 焊盘间距 | `analyze_pad_to_pad_distances(...)` |
| 载流/线宽 | `analyze_current_capacity(...)` |
| 去耦摆放 | `analyze_decoupling_placement(footprints)` |
| DFM | `analyze_dfm(...)` |

**样板上的真实结果（实测）：**

- 原理图：1 个分压识别（R1/R2）、1 个开关稳压器识别（IC1）、1 条 info（FB 只连 IC1.4）
- PCB：DFM 0 违规、未布线 0、去耦摆放 1 条 info、焊盘间距 4 对事实
- RC、去耦、短路均为 0——样板是正常工作的 Buck 电路，值也不匹配原方案假设的 1 kΩ/100 nF

**结论：** 不做「发现数量」验收，做「该报的报了、不该报的没报」。

### 3.5 报告

**报告语言：中文。** 规则 ID 与字段名保留英文，方便与 kicad-happy 对照。

**必须包含规则运行状态。** kicad-happy 的 `compute_trust_summary`（`finding_schema.py:329`）在 `total == 0` 时直接给 `trust_level = 'high'`。若适配层因语义缺口静默返回 0，报告会显示「很好」。因此：

- 每条规则标记：`通过` / `发现问题` / `未评估` / `部分完成` / `失败`
- 数据缺口单独成节，不把空数组当作零问题

**产物：**

- `findings.json`：字段与 `finding_schema.py` 对齐
- `summary.json`：< 32KB，模型只读这个
- `report.html`：单文件、内嵌 CSS、内嵌 SVG（altiumts 渲染，43ms/块）
- 对话摘要：Must fix + 前 5 条 Should fix + 未评估项

### 3.6 SKILL 与 harness

**`SKILL.md` frontmatter：** 仅 `name` + `description`。description 覆盖触发词：Altium、`.PrjPcb`、`.SchDoc`、`.PcbDoc`、工程文件夹、审查、测评、打板前检查。

**正文固定步骤：**

1. 解析并确认用户给的绝对路径
2. 找 `*.PrjPcb`；多个则列出让用户选
3. 运行 `node "<skill>/scripts/analyze.mjs" --project "<路径>" --out "<输出目录>"`
4. 只读 `summary.json`（必要时读 `findings.json` 的单条证据）
5. 用中文输出：结论 / 工程概览 / 按严重度排序的问题（含定位与证据）/ 数据覆盖与未检查项 / `report.html` 路径

**硬规则：** 只读源工程；缺失数据标 `not_evaluated`；不编造通过项；不把整份 snapshot 塞进上下文。

**多板选择：** 默认审 `PrjPcb` 文档清单中的**最后一块** `PcbDoc`，支持 `--board <文件名>` 指定；报告中列出全部板卡清单。

**输出位置：** 默认 `%LOCALAPPDATA%\ad-happy\runs\<run-id>`，不写进工程目录；支持 `--out` 覆盖。

**退出码：** 0 完成 / 2 输入无效 / 3 部分完成。

### 3.7 环境自检

每次分析前执行，缺什么明确说缺什么：

| 检查项 | 要求 | 不满足时 |
|---|---|---|
| Node | ≥ 20 | 提示版本要求 |
| altiumts | 0.0.95 | 提示 `npm i altiumts@0.0.95` |
| Python | ≥ 3.10 | 提示安装 |
| kicad-happy scripts | `KICAD_HAPPY_SCRIPTS` 有效 | 提示设置环境变量 |
| 工程文件 | 路径存在且含 `.PrjPcb` 或 `PcbDoc`/`SchDoc` | 列出找到的文件与缺失项 |

成功时也打印一行版本摘要，写入 `manifest.json`，保证报告可复现。

## 4. 开发阶段

### P0 · 可行性验证（2–3 天）

| 任务 | 产出 | 出口条件 |
|---|---|---|
| 复制 MIT 样板到 `tests/fixtures/` | 可运行样本 | 保留 LICENSE |
| 锁定 altiumts 0.0.95 | `package.json` + lockfile | 精确版本 |
| 实测 PcbDoc 解析 | 元件/焊盘/网络计数 | 与本文 3.1 一致 |
| 实现连通性引擎 | 6 个网络、22/22 引脚 | 与 PCB 网络一致 |
| 构造最小 `AnalysisContext` | 跑通 `detect_voltage_dividers` | 返回识别结果 |
| 环境自检 | 一行版本摘要 | 五项全部可识别 |

**P0 不通过就不进入 P1。**

### P1 · 原理图适配（1 周）

- `sch.mjs` + `connectivity.mjs` 输出完整 `raw.json`
- `adapter.py` 完成原理图映射与 7 条语义补齐
- 跑通 6 条原理图规则
- 用真实样板 + 故意改错的最小工程做回归

### P2 · PCB 适配（1 周）

- PCB 字段映射（单位、net 0 偏移、铜层过滤）
- 跑通 4 条 PCB 规则
- 原理图 ↔ PCB 交叉检查：按 `(位号, 引脚/焊盘号)` 匹配

### P3 · 报告与 harness（1 周）

- `report.html`，内嵌 SVG，中文
- 规则运行状态与数据缺口
- `SKILL.md` + `AGENTS.md` 路由
- `.agents/skills/` 安装到 dsh 与 opencode
- 端到端验收：给路径 → 出报告

**总计：3–4 周**（不含样板扩充与用户验收）

## 5. 风险与应对

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| 连通性引擎在真实复杂工程上失配 | 中 | 高 | 容差可配置；报告标注匹配率；多通道/层次先降级提示 |
| 检测器内置 KiCad 语义导致漏检 | 高 | 高 | 每条规则记录运行状态；样板逐条校准 |
| 电源轨识别不足（AD 用普通标签） | 高 | 中 | 照 kicad-happy 语义，报告标 `not_evaluated` |
| altiumts 0.0.x 破坏性升级 | 中 | 中 | 锁定 0.0.95；适配层隔离；契约测试 |
| dsh 的 shell 权限未确认 | 中 | 中 | 备选：stdio MCP server 薄封装 |
| 大板内存（>50MB） | 低 | 中 | 解析放子进程，设 20–50MB 上限 |

## 6. 已确认的决定

| 事项 | 决定 |
|---|---|
| 首版范围 | 原理图与 PCB 两侧 |
| 库文件检查 | **不做独立解析**，只做工程内引脚/焊盘交叉验证；报告标注未检查 |
| 报告形态 | JSON + HTML，中文 |
| harness | **Skill + 确定性 CLI**，`.agents/skills/`，dsh 与 opencode 共同发现 |
| 电源轨 | 严格按 kicad-happy 语义，只补 Power Port 映射，不额外推断 |
| 验收 | 真实样板 + 故意改错的最小工程，不套假设数字 |
| 测试样本 | MIT 样板（© 2020 Mark Harris）可进仓库，保留 LICENSE |
| 运行环境 | Node ≥ 20 已有，可安装；内置环境自检 |

## 7. 仍待确认

1. **`AD2611-PCB-Layout-Lab` 里的 Buck 工程**是否含客户或内部资料？决定它能否进 `tests/fixtures/`。
2. **dsh 是否提供 shell 工具**：若没有，改用 stdio MCP server 封装同一引擎。
3. **是否需要多页层次原理图**：样板 `sheetSymbols`/`ports` 均为 0，无法验证。v1 先显式降级。

## 8. 验收样例

### 8.1 正向

- 真实样板：报告列出全部文档、9 个元件、6 个网络、35 条规则；原理图识别出 R1/R2 分压与 IC1 稳压器；PCB 的 DFM、线宽、间距有明确状态。
- 连通性：22/22 引脚匹配到网络，与 PCB 焊盘网络一致（按位号+引脚号匹配）。

### 8.2 负向（自建夹具）

- 把某个元件的焊盘网络改错，报告应定位到：实例位号、引脚号、原理图网络名、PCB 网络名。
- 移除一个去耦电容的网络连接，去耦规则应报告缺失。

### 8.3 不接受的验收方式

- 用 finding 数量当指标（正常样板本就问题少）
- 把 `not_evaluated` 当成通过
- 修改源工程文件

## 9. 实测附录（2026-11-24）

**样板：** `Student-DCDC-Buck-Converter`（MIT, © 2020 Mark Harris）

**元件实际值：** R1 = 56.2 kΩ、R2 = 10 kΩ、C1 = 0.1 µF、C2 = 22 µF、C3 = 47 µF

**PcbDoc：** 9 元件、22 焊盘、6 网络（SW/OUT/NetC1_1/IN/GND/FB）、208 走线（真铜 40）、19 过孔、35 规则、板 24.54 × 12.57 mm

**SchDoc：** 424 记录、9 元件、22 引脚、15 导线、4 网络标签、6 电源端口（全为 GND）

**连通性重建：** 6 个网络，与 PCB 一致；`NetC1_1` 是原理图未命名的 VBST 节点

**规则实测：** 分压 1、稳压器 1、info 1、RC 0、去耦 0、短路 0；PCB DFM 0 违规、去耦摆放 1 info

**库文件：** `.PcbLib` / `.SchLib` / `.IntLib` 全部无法语义解析

**复用验证：** 10 个检测器可独立 import（纯标准库，0.17 s）
