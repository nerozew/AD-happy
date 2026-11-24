# AD-Happy 改造与交付方案

开发交接稿 · 2026-11-23 · 首个验证环境为 Windows + Altium Designer 26

## 1. 最终产品是什么

**主交付物是一套本机 AD 设计审查工具。** 设计师在 AD 打开工程，从「运行脚本」或配置好的「设计审查」菜单启动，得到 HTML 报告和 JSON 结果。基础审查由本地 Python 执行，工程师可以独立使用。Codex 用户可安装可选的 `ad-happy` Skill，用自然语言启动同一套引擎，并追问报告里的问题。

| 交付组件 | 负责什么 | 用户如何使用 |
|---|---|---|
| AD 脚本项目 `.PrjScr` + DelphiScript | 捕获选定的工程、板卡或库，调用 AD 接口采集数据，提供 AD 内入口 | 在 AD 从「文件 → 运行脚本」启动。稳定后可绑到菜单或工具栏 |
| 本地 Python CLI 和规则引擎 | 校验快照、适配规则、生成报告，作为两个入口共用的执行层 | 随工具包部署。开发和回归可直接调用 CLI |
| Codex Skill，具体入口为 `SKILL.md` | 定义如何确认对象和检查范围、调用工具、解释结果并追问证据 | 在 Codex 里指定工程或库，然后请求审查 |
| 本地 Altium MCP | 让 Codex 调用设计师电脑上运行的 AD 工具。先复用现有桥接，按需扩展读接口 | 在需要从 Codex 读取正在打开的 AD 工程时配置。已有快照可直接交给 CLI 分析 |
| 可选 Codex 插件包 | 面向团队分发，将 Skill 与 MCP 配置等安装内容打包 | 规模化部署时再制作。AD 内使用走上面的脚本入口 |

这里「AD 插件」在首版指 **可从 AD 内启动的脚本集成**。正式扩展、扩展管理器安装和常驻面板作为后续交付选项，待确认分发要求与实际可用的 AD 扩展接口。Codex 插件包属于 Codex 的交付渠道。

参考：[AD 脚本与菜单命令](https://www.altium.com/documentation/altium-designer/scripting/running-scripts) · [Codex Skill](https://learn.chatgpt.com/docs/build-skills) · [Codex 插件包](https://learn.chatgpt.com/docs/plugins) · [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

## 2. KiCad Happy 是怎么使用的

本次基线是本机 [kicad-happy 源码](D:/Tools/kicad-happy)，Git 提交 `6a91aaa`，Codex 插件清单版本 `2.3.1`。上游仓库包含多项 Skill，也提供可独立运行的 Python 脚本。

1. **在 Codex 里用。** 按上游安装说明安装技能后，给 Codex 一个有权读取的工程目录。例如「审查这个 KiCad 工程的原理图和 PCB，给我列出打板前需要解决的问题」。Codex 按核心技能说明找工程文件、运行 Python 分析器、读取结果，按任务追加数据手册复核、EMC、SPICE 或制造输出检查。
2. **在终端里用。** 从上游仓库目录运行脚本，把明确指定的设计文件和分析结果交给下一步。以下是现有命令示例，文件名要换成实际路径。

```powershell
python .\skills\kicad\scripts\analyze_schematic.py .\Board.kicad_sch --output .\schematic.json
python .\skills\kicad\scripts\analyze_pcb.py .\Board.kicad_pcb --full --schematic .\schematic.json --output .\pcb.json
python .\skills\emc\scripts\analyze_emc.py --schematic .\schematic.json --pcb .\pcb.json
```

这套模式可以原样保留在产品设计里。**工具产生结构化结果，Skill 编排并解释结果。** 差别在于 AD 版要先通过 AD 脚本、MCP 或明确导出的文件取得输入。对于项目内已放置的元件，基础检查取项目实例和板上焊盘数据，可独立于源库读取。

参考：[kicad-happy 安装与运行说明](https://github.com/aklofas/kicad-happy/blob/6a91aaaea124152b2923326c1cf77278e0999cd4/install-guidance.md) · [核心技能与完整审查流程](https://github.com/aklofas/kicad-happy/blob/6a91aaaea124152b2923326c1cf77278e0999cd4/skills/kicad/SKILL.md)

## 3. 用户怎么用，能读取哪些 AD 数据

### 工程审查

初次使用，在设计师的 Windows 电脑上部署 AD 脚本项目和本机运行器，首次从 AD「运行脚本」选中 `.PrjScr`。常用工位可由安装步骤配置「设计审查」快捷入口。交付包附带针对目标 AD 版本的安装、验证和卸载说明。

1. 用户在本机 AD 打开 `.PrjPcb`，选中目标 `.PcbDoc` 和装配变体。通过脚本入口选择「工程审查」。一个工程有多块板时，显式指定本次板卡。
2. 采集器取得编译后的原理图和目标 PCB 实例。首版以已保存版本为基线，检测到会影响本次采集的未保存修改时，提示保存后再审查。工程、板卡和来源版本随结果记录。原生检查可能生成报告或衍生文件，报告写入路径应明确显示。
3. 用户查看报告。原生 ERC/DRC、原理图与 PCB 对照、工程规则、数据缺口各自显示来源和结果。第一版可按报告上的位号、网络和坐标在 AD 找对象。后续可把跳转封装成工具。

Codex 使用示例：「用 AD-Happy 审查我当前的 Buck 工程，使用主板和默认变体，列出原理图与 PCB 的引脚网络不一致，以及优先调整的输入去耦位置。」接入本机 MCP 后，Skill 确认目标并调用采集和分析。没有 MCP 时，用户可以在 AD 导出快照后把文件交给 Codex。只有 BOM、Gerber 或 PDF 时，执行这些输入能支持的子检查，报告列出缺失项。

### 元件库检查

| 用户给的输入 | 能检查什么 | 实现边界 |
|---|---|---|
| 已打开的项目 | 已放置元件的参数、引脚网络、板上焊盘网络和使用情况 | 通过目标项目审查。需要判断源库本身是否合格时，再选择对应的库和料号 |
| 指定的本地或共享 `.SchLib`、`.PcbLib` | 盘点和读取指定符号、引脚号、类型、图元及封装焊盘、孔径、层和尺寸 | 现有 Altium MCP 有 `get_symbol_primitives` 与 `get_footprint_primitives`。新增库审查入口读取用户选中的文件或元件。共享盘沿用当前 Windows 用户的读取权限 |
| `.IntLib` 集成库 | 可先通过 AD 提取源库，再按符号库、封装库规则核对 | 首版输入为用户提供的提取结果。直接解析须另做样本验证 |
| `.DbLib`、公司 Altium Workspace 托管库 | 在现有账号权限内，对导出的项目使用副本或指定组件资料做检查 | 首版走授权导出。批量直连需要适用的接口、登录和单独确认的访问范围 |
| 指定器件的厂商数据手册 | 校对引脚号、功能、封装版型和推荐焊盘尺寸 | 按制造商、MPN 和封装版本匹配。缺少对应资料时标记「待核实」 |

**工程检查和库检查是两个独立入口。** 用户选择项目时，范围是该项目和选定板卡。用户选择库时，范围是指定文件和元件。建议先做「指定符号 + 指定封装」检查，包括符号引脚对封装焊盘、重复/缺失编号、常见焊盘几何及数据手册对照。重复焊盘、分单元符号、裸露焊盘和纯机械焊盘按类别判断。

本机工具以 Windows 当前用户权限运行。采集前解析实际路径并确认目标，包含共享盘、符号链接或多工程切换的场景。基础规则在本机运行。若使用 Codex 解读结果或启用器件在线查询，按企业数据策略选择可提交的数据。器件查询只需相关 MPN 和制造商，工程快照可留在本机。后台或远端环境使用明确交付的快照或经授权配置的桥接。

参考：[Altium 文件库](https://www.altium.com/documentation/altium-designer/components-libraries/file-based-libraries) · [集成库](https://www.altium.com/documentation/altium-designer/components-libraries/file-based-libraries/integrated) · [Workspace 授权导出](https://www.altium.com/documentation/altium-designer/connected-workspace/acquiring-data-using-content-cart)

## 4. 从 KiCad 迁移的功能清单

| 原流程 | AD 实现 | 首版安排 |
|---|---|---|
| 原理图文件解析、层级和网络重建 | 读取 AD 编译后工程的元件实例及引脚网络。保留逻辑位号、物理位号、通道和可用的元件 ID。转换为 `AnalysisContext` 后复用拓扑类检测器 | 先打通引脚—网络导出，再上 RC、分压、基础去耦。按 AD 语义改写 `PWR_FLAG` 等专用逻辑 |
| ERC 和 DRC | 从选定 AD 工程取验证信息及批量 DRC，保留原生严重度、规则名、启用范围、完成标记和原始报告 | 首版。取消、规则关闭、报错、触及违规上限分别呈现 |
| PCB 对象提取、几何与连通性 | 读取板上组件、Pad、Track、Arc、Via、层叠和板框。按统一单位做线长、焊盘级距离等计算 | 首版做 Pad/Track/Via 和距离。后续补完整板框、实际铜皮、空洞、过孔层跨和规则区 |
| 原理图与 PCB 一致性 | 对照原理图 `实例.引脚 → 网` 和 PCB `实例.焊盘 → 网`。优先使用项目里的元件链接和可取得的实例 ID。单板简单场景可显式配置位号匹配。保留引脚到焊盘映射 | 首版覆盖常规单通道工程。多通道、Net Tie、多焊盘同号、装配变体用专项夹具验证 |
| EMC、热估算、SPICE | 保留规则与模型。EMC 读取已识别的电路、叠层和布线。回流路径读取铺铜实形。热估算读取功耗和散热结构。SPICE 读取检测结果并调用外部仿真器 | 后续按规则依赖逐项启用。可优先打通 RC/分压仿真 |
| Gerber、钻孔、BOM 与生命周期 | AD OutJob 提供制造侧文件。复用 Gerber/Excellon 解析和按 MPN 的数据手册/生命周期逻辑，核对 AD 文件层名、钻孔单位、装配变体、CSV 列和贴片坐标 | 先支持明确指定的成品文件检查。当前上游 BOM 转换器支持相关 CSV 列，Excel 需要独立读取适配 |
| 证据、分析缓存和版本差异 | 保留 `finding` 思路。同一个对象的定位和问题 ID 在同版输入上可复现。比较两版工程时保留数据覆盖差异 | 首版交付 JSON、HTML、原始证据。版本差异后续上线 |

参考：[AD 验证项目](https://www.altium.com/documentation/altium-designer/schematic/design-validation) · [AD 多通道编译模型](https://www.altium.com/documentation/altium-designer/schematic/creating-multi-channel-design) · [AD 批量 DRC](https://www.altium.com/documentation/altium-designer/pcb/drc/setting-up-running) · [AD OutJob](https://www.altium.com/documentation/altium-designer/preparing-for-manufacture/output-jobs)

## 5. 开发实现接口

### 采集与运行链路

```text
AD 菜单 / Run Script ─┐
                       ├─ 选定目标 → 本机 AD 脚本采集 → AD 快照 + 原生证据
Codex Skill / MCP ─────┘                                    │
                                                             ↓
                             HTML + findings.json ← Python 适配与规则引擎
```

- **优先复用现有工具。** `get_project_components` 给出编译后的实例和参数。PCB 由 `get_layout`、`get_component_pins`、`get_pcb_layer_stackup` 等提供。原生检查用 `get_erc_violations`、`run_drc` 或等价的 AD 工作流。按路径绑定工程和板卡，对依赖当前焦点的接口在每个阶段核验目标。处理分页和截断。
- **先补两个缺口。** 编译元件列表缺完整的原理图引脚—网络表，先做 AD26 小样本试验，验证从编译后模型或 AD 原生网表能读取真实端点、多通道实例和引脚编号。布局工具返回 Polygon 外形，会跳过 Polygon 内铺出的铜皮。后续新增实际铜区外轮廓和内孔导出，或用校验过的制造层数据补足适用的几何检查。
- **保持一套分析实现。** AD 菜单入口将任务交给本机运行器后释放 AD 界面，再执行需要 AD 响应的后续步骤。CLI 可以直接分析本地快照，便于离线复现。命令入口与 MCP 可共用服务实现。Codex 入口优先提供整次运行的摘要和按需详情，完整快照保存在磁盘。

### 最小数据契约

| 数据块 | 最少需要的字段 |
|---|---|
| 运行与来源 | `schema_version`、`run_id`、采集时间、AD 版本、目标项目与 PCB、变体、数据来自保存稿还是会话、单位、坐标原点、来源指纹及覆盖状态 |
| 原理图 | 实例 ID 或显式匹配键、物理和逻辑位号、文件和通道、Comment/值、MPN、封装、引脚号/功能/类型、各网的完整引脚端点 |
| PCB | 元件与焊盘 ID/编号、焊盘网络、位置/层、走线弧线、过孔和层跨、规则及层叠。铜区实形单独标明是否已采集、对应哪个 PCB 状态 |
| 原生证据 | ERC、DRC 的运行状态、启用范围、违规数量和明细、是否到达上限、原始报告路径、对应输入状态 |
| 分析结果 | 规则 ID、严重度、可信度、对象定位、观测数据、阈值来源、建议、上游证据。每条检查有通过、发现问题、未评估、部分完成或失败的明确状态 |

建议同一次运行包含 `manifest.json`、`snapshot.json`、`native/`、`findings.json`、`report.html`。适配器按规则的最低输入要求派发，避免将空数组或缺失字段视为零问题。原理图适配器生成 `AnalysisContext`，其他分析器只接收经过验证、字段齐全的兼容 JSON。AD 原始数据和规范化结果各自保留，方便定位转换误差。复用上游代码时锁定提交并保留 MIT 许可声明。

可供 DE 定位的源码：[Altium 编译元件接口](D:/NeroZe/pcb布局/AD26_PCB自动布局_工具包/01-altium-mcp/installed-v0.7.0/server/AltiumScript/other_utils.pas:1710) · [布局对象采集](D:/NeroZe/pcb布局/AD26_PCB自动布局_工具包/01-altium-mcp/installed-v0.7.0/server/AltiumScript/pcb_layout.pas:318) · [库接口定义](D:/NeroZe/pcb布局/AD26_PCB自动布局_工具包/01-altium-mcp/installed-v0.7.0/server/main.py) · [KiCad AnalysisContext](D:/Tools/kicad-happy/skills/kicad/scripts/kicad_types.py:18) · [KiCad Findings](D:/Tools/kicad-happy/skills/kicad/scripts/finding_schema.py:216)

## 6. 开发顺序与验收

| 阶段 | DE 要交付 | 完成条件 |
|---|---|---|
| P0 · 数据可行性 | 在现有 Buck 样板副本上验证 AD26 本机链路，导出编译引脚网络和 PCB 焊盘网络，留一份可重放快照 | 对照 AD，核实器件/网络计数和约定的关键引脚。记录缺字段。若编译模型接口在目标版不可用，验证 AD 原生网表能覆盖哪些字段 |
| P1 · 可用首版 | AD 脚本入口、本地 CLI、工程审查报告，覆盖原生 ERC/DRC、引脚—焊盘对照、RC/分压和基础去耦距离 | 从 AD 启动后产出可定位报告。已知正常样板可复跑，植入网络错配可检出。取消 DRC、路径错误、未保存变化、缺字段分别有可理解状态。原设计文件哈希保持一致 |
| P2 · 库与团队入口 | 指定 `.SchLib`/`.PcbLib` 的库审查，补装配变体和重复通道用例。交付可选 Codex Skill | 同一个快照从 AD 和 Codex 两条入口得到一致的规则结果。正确识别符号引脚缺失、封装孔径异常，且检查范围只覆盖选定对象 |
| P3 · 深度审查与分发 | 实际铺铜、回流路径、EMC/热/SPICE、OutJob 与版本差异，按团队部署需求选择插件打包 | 每个新增检查有对应输入和基准用例。铺铜外形与铜皮不一致、层叠缺失、外部仿真器缺失都有可复现的报告表现 |

P1 的三个可量化样例：

- **电路识别。** 1 kΩ 与 100 nF 的 RC 低通应被识别，截止频率约为 1.592 kHz。
- **工程同步。** 在测试副本故意造成一个明确的 Pin/Pad 网络差异，报告应定位到目标实例、两侧端点和两侧原始网名。
- **布局距离。** 取 Buck 输入电容的电源焊盘与芯片 VIN 焊盘，报告焊盘级距离和坐标，人工用 AD 复测。只有拿到实际走线、过孔和参考面信息后，才进一步判断真实回路。

本方案的当前状态是接口和源码核对。AD26 实际导出的字段完整性、库批量读取和正式打包方式由上述阶段验收。开发起点：**先完成 P0，拿到一份可重放的原理图与 PCB 网表对照样本，再接检测器和两条用户入口。**
