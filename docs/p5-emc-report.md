# AD-Happy Phase 5：EMC 预合规分析报告

- 分支：`feature/ad-happy`
- 实现范围：复用 kicad-happy 的 EMC 规则，新增 `--emc` 可选阶段、适配器、覆盖模型、中文报告章节与测试
- 不包含：修改 kicad-happy、联网、铺铜实形补全、把未评估类别当作通过

## 1. 上游接口检查（只读，未修改 kicad-happy）

检查目录：`D:/Tools/kicad-happy/skills/emc/scripts/`。

### 1.1 CLI 实际参数

```text
python analyze_emc.py --schematic <schematic.json> --pcb <pcb.json> --output <out.json>
                      [--severity all|low|medium|high|critical] [--standard fcc-class-b]
                      [--market us|eu|automotive|medical|military] [--spice-enhanced]
                      [--compact] [--text] [--analysis-dir <dir>] [--schema]
```

- **输入是分析器 JSON，不是 KiCad 原始文件**。`analyze_emc.py` 直接 `json.load` 两个输入，
  由 `emc_rules.run_all_checks(schematic, pcb, ...)` 读取字段。
- `--schema` 打印的是 **输出** 信封 schema（`analyzer_type=emc`、`schema_version=1.4.0`、
  `inputs`、`compat`、`summary`、`findings[]`、`per_net_scores`、`test_plan`、
  `regulatory_coverage`、`board_info` 等），不是输入 schema；因此输入映射以
  `emc_rules.py` 的实际字段读取为准。
- 输出信封的关键字段：
  - `summary.total_findings / categories_checked / by_severity / emc_risk_score`
  - `findings[]`：`category`、`severity`（规范化为 `error|warning|info`）、`rule_id`、
    `title`、`description`、`components[]`、`nets[]`、`recommendation`、`confidence`、
    `finding_id` 以及各规则的结构化附加字段
  - `target_standard`、`category_summary`、`board_info`、`trust_summary`
- 运行副作用：`get_capability_mode_ref()` 会在输出目录创建 `capability_mode.json`。
  本实现把输出目录限制在 `<--out>/emc-input/`，不写源工程。
- 上游只导入本地模块（`emc_rules`、`emc_formulas`、`finding_schema`、`inputs_builder`、
  `schema_codec`、`capability_mode`、`project_config`、`output_filters`、`kicad_utils`）；
  未传 `--spice-enhanced` 时不会导入 SPICE 仿真，也不发起网络请求。

### 1.2 规则实际读取的字段（按类别）

下表中的「AD-Happy 可提供」是 Phase 5 的适配结论；具体规则状态见第 4 节。

| 类别 | 规则 | 上游读取的关键字段 | AD-Happy 可提供 |
|---|---|---|---|
| ground_plane | GP-001 | `pcb.return_path_continuity[]`（`net`、`reference_plane_coverage_pct`、`total_trace_mm`）、`pcb.findings` 中 CP-003、`footprints[].connected_nets` | 否：无回流路径连续性，也无铺铜实形 |
| ground_plane | GP-002/003/004 | `pcb.zones[]`（`net_name`、`layers`、`island_count`、`fill_ratio`、`filled_bbox`/`outline_bbox`）、`pcb.layers[].type` | 否：离线解析不捕获 zones |
| ground_plane | GP-005 | `pcb.ground_domains.domain_count/domains[].net_name` | 是：由焊盘网络派生 |
| decoupling | DC-001 | `pcb.decoupling_placement[]`（`ic`、`value`、`closest_cap_mm`、`nearby_caps[]`） | 是：由元件坐标与焊盘网络派生 |
| decoupling | DC-002 | `pcb.footprints[]`、`pcb.decoupling_placement[]` | 是 |
| decoupling | DC-003 | `pcb.decoupling_placement[]`、`pcb.vias.vias[]`、`pcb.footprints[]`、`pcb.zones[]`、`pcb.layers[]` | 2 层板可评估（规则不适用）；多层板因缺少 zones 无法排除同网覆铜连接 |
| io_filtering | IO-001 | `pcb.footprints[]`（`reference/value/library/lib_id/x/y/pads[].net_name`、`pad_nets`）、`schematic.findings` 中 `detect_protection_devices` | 是：保护器件由上游检测器生成 |
| io_filtering | IO-002 | `footprints[].pad_nets` | 是 |
| switching_emc | SW-001 | `schematic.findings` 中 `detect_power_regulators`（`ref/value/topology/switching_frequency_hz/input_voltage/vout_estimated`） | 是 |
| switching_emc | SW-002 | `pcb.tracks.segments[]`、`pcb.zones[]`、稳压器 `sw_net` | 部分：只能统计走线铜面积，缺少 zone 面积 |
| switching_emc | SW-003 | `pcb.switching_loop_areas[]` 或稳压器 `inductor/input_capacitors` + `footprints` 坐标 | 是（无预计算时上游用稳压器字段回退计算） |
| clock_routing | CK-001/002 | `pcb.net_lengths[]`、`pcb.layers[]`、晶振 `pins[].net`、`design_analysis.buses` | 是 |
| clock_routing | CK-003 | `pcb.tracks.segments[]`、`pcb.footprints[]` 连接器位置 | 是 |
| clock_routing | CK-004 | 晶振 `reference/frequency`、`pcb.zones[].filled_bbox/outline_bbox` | 否：缺少 zones |
| via_stitching | VS-001 | `pcb.vias`（`count`/`vias[].net/x/y`）、`pcb.statistics`、`pcb.board_outline.bounding_box`、晶振频率 | 是 |
| stackup | SU-001 | `pcb.setup.stackup[].type/name`、`pcb.layers[].type` | 是：层序与 signal/plane 类型可由层名派生 |
| stackup | SU-002/003 | `setup.stackup[]` 中 `core/prepreg` 的 `thickness/epsilon_r` | 否：快照无介质厚度/εr |
| emission_estimate | EE-001 | `statistics.board_width_mm/height_mm`、`setup.stackup[].epsilon_r` | 否：εr 未知；上游默认 4.4 会给出近似值 |
| emission_estimate | EE-002 | 稳压器字段 | 是 |
| diff_pair | DP-001/002/004 | `schematic.design_analysis.differential_pairs[]`（`positive/negative/type/shared_ics`）、`pcb.net_lengths[]`、`pcb.layers[]` | 是：差分对由上游检测器生成；网表不完整时不做结论 |
| diff_pair | DP-003 | `pcb.layer_transitions[]` | 否：未计算换层/过孔层对 |
| board_edge | BE-001 | `pcb.board_outline.edges[]`、`tracks.segments[]` | 否：只有包围盒宽高，没有板框线段 |
| board_edge | BE-002 | `board_outline.edges[]`、`zones[]` | 否 |
| board_edge | BE-003 | `footprints` 连接器、`vias.vias[]`、`design_analysis.differential_pairs` | 是 |
| crosstalk | XT-001 | `pcb.trace_proximity.proximity_pairs[]` | 否：未计算走线邻近度 |
| emi_filter | EF-001/002 | 稳压器、`schematic.findings` 中 `detect_lc_filters`（`resonant_hz/inductor`） | 部分：只传位于稳压器输入轨的 LC；纯电容滤波由上游按设计保持沉默 |
| esd_path | ES-001/002 | `schematic.findings` 中 `detect_protection_devices`、`footprints` 连接器/保护器件、`vias.vias[]`、`pcb.nets` | 是 |
| thermal_emc | TH-001/002 | 稳压器 `output_capacitors[]/vout_estimated/output_rail`、`footprints` 磁珠与稳压器位置 | 是 |
| shielding | SH-001 | 连接器 `value/library`、晶振/稳压器发射频率、`statistics` | 是 |
| pdn | PD-001/002 | 稳压器 `output_capacitors[]`、`pcb.setup.stackup`（平面间电容）、`statistics` | 部分：缺少介质厚度/εr，平面间电容按 0；电容模型扫描可用 |
| pdn | PD-003/004 | `schematic.power_budget`、负载 IC、`pcb.net_lengths`、走线寄生 | 否：无 power_budget/负载 IC 数据 |
| return_path | RP-001 | `pcb.layer_transitions[]`、`vias.vias[]`、`pcb.nets` | 否：未计算 layer_transitions |
| inductor_leakage | ML-001 | 稳压器 `inductor`、`footprints` 电感/敏感器件坐标、晶振/ADC/运放/RF findings | 是（有敏感器件时） |

## 2. 适配器设计

### 2.1 `scripts/reuse/emc.mjs`

```js
buildEmcInputs(snapshot, pcb, pipeline, { nets, netlistComplete }) -> {
  schematicJson, pcbJson, coverage   // 初步覆盖（未运行上游）
}
runEmc(emcDir, outDir, { standard }) -> {
  findings, coverage, rawPath
}
emptyEmcCoverage({ requested, standard, reasons, status }) -> coverage
```

- `buildEmcInputs`：
  - 原理图侧：元件统计、网络（优先 `raw.nets`）、pipeline 中已有的稳压器/分压器/RC/去耦
    finding（`detector` 映射为上游 `detect_*` 名称）、空的 `design_analysis` 骨架。
  - PCB 侧：见 2.2。
  - 初步 `coverage`：按可用数据判定每个类别的状态与原因，供测试和 `runEmc` 复用。
- `runEmc`：
  1. 定位上游脚本：显式 `KICAD_HAPPY_EMC_SCRIPTS`（设置后不回退）→
     `KICAD_HAPPY_SCRIPTS` 同级 `emc/scripts` → 默认 `D:/Tools/kicad-happy/skills/emc/scripts`。
  2. 若存在 `emc-input/raw.json`，调用 `emc_prepare.py` 增强原理图侧；失败只降级并记录，
     不中止 EMC。
  3. 调用 `analyze_emc.py --schematic ... --pcb ... --output emc-input/emc-raw.json
     --severity all --standard fcc-class-b`。
  4. 校验 `analyzer_type=emc`、`findings[]`、`summary`；失败写 `EM-000`（分析执行错误，
     不是设计结论）。
  5. 按覆盖模型过滤未评估规则的上游结果，归一化为中文 finding，并生成最终 `coverage`。
- Rule ID：`EM-` + 上游规则 ID（如 `EM-SW-001`），保留 `source_rule_id` 便于对账。
- 严重度映射：上游 `error → must_fix`、`warning → should_fix`、`info → nice_to_have`；
  同时保留 `upstream_severity`。
- `kind`：`EE-001/EE-002/EF-002/PD-002` 为 `fact`（估算/实测事实），其余为 `issue`。
- 所有标题、描述、建议均为中文；数值尽量从上游 finding 的结构化字段/描述中提取，
  不把英文原文直接塞进 `findings.json`。

### 2.2 PCB JSON 映射

| AD-Happy 快照 | EMC 输入 |
|---|---|
| `pcb.nets[]`（数组下标 0 起） | `nets`：`{id: name}`，`id = netIndex + 1`；`netIndex=-1 → 0`（无网络） |
| `pcb.components[]` | `footprints[]`：`reference/value/library/lib_id/footprint/mpn/x/y/angle/layer/type` |
| `pcb.pads[]` | `footprints[].pads[]`：`number/net_number/net_name/abs_x/abs_y/type/drill/plated`；同时生成 `pad_nets{pad:{net}}` 与 `connected_nets[]` |
| `pcb.layerStack[]` | `layers[]` + `setup.stackup[]`：按物理铜层顺序映射为 `F.Cu / In1.Cu … / B.Cu`；名称含 `Plane` 的层标 `power`，其余标 `signal`；排除 `Multi-Layer` 伪层 |
| `pcb.tracks[]` / `pcb.arcs[]` | `tracks.segments[]` / `tracks.arcs[]`：宽度与坐标转 mm，层名按上述映射；圆弧转三点 (`start/mid/end`) |
| `pcb.vias[]` | `vias.vias[]`：`x/y/size/drill/net/type/layers`；快照无盲埋孔层对，按通孔处理（仅用于位置/网络判断） |
| `pcb.outline` 宽高 | `board_outline.bounding_box`；`edges: []`，`edge_count: 0` |
| 派生 | `statistics`、`net_lengths`、`decoupling_placement`、`ground_domains`、`switching_loop_areas`（有稳压器电感/输入电容时） |
| 不提供 | `zones: []`、`return_path_continuity`、`layer_transitions`、`trace_proximity`；原因写入 coverage |

层名映射示例：Altium `TOP → F.Cu`、`BOTTOM → B.Cu`、`MIDn/MID-LAYER n → In{n}.Cu`、
`INTERNAL PLANE n/PLANEn → In{n}.Cu`。缺失层叠时仅兜底为 `F.Cu/B.Cu` 两层，并在
coverage 中说明层叠未知会影响相应规则。

### 2.3 `scripts/reuse/emc_prepare.py`（原理图增强）

复用 AD-Happy 已有的 `adapter.to_context(raw)` 构造 kicad-happy `AnalysisContext`，
并额外初始化 `NetlistQueries`（`ctx.nq`），使稳压器检测能沿开关网络找到电感/输出轨。
然后调用上游检测器：

- `detect_voltage_dividers` → `detect_power_regulators`
- `detect_crystal_circuits`
- `detect_protection_devices`
- `detect_lc_filters`（**只保留 `shared_net ∈ 稳压器 input_rail` 的 LC**，避免把开关/输出节点
  LC 误当成输入 EMI 滤波器；被排除数量写入 `_ad_happy.detectors.lc_filters.dropped`）
- `detect_rc_filters`、`detect_decoupling`
- `analyze_design_rules`（`differential_pairs` + `bus_analysis`）

每条检测器独立 try/except；失败写入 `_ad_happy.detectors.<name>.status = failed/not_evaluated`
和 `warnings`，不会伪造结果。`emc.mjs` 根据这些状态决定规则是 `evaluated` 还是
`not_evaluated`。

### 2.4 缺失数据的处理原则

1. **不把空数组当成「没有问题」**：`zones=[]` 会让上游 GP-002 误报「没有接地平面」；
   `edges=[]` 会让 BE-001/002 静默跳过；`epsilon_r` 缺失会让 EE-001 用默认 4.4 算近似值。
   这些规则一律标 `not_evaluated`。
2. **过滤上游兜底结果**：覆盖模型只保留 `evaluated` + `partial` 规则的上游 finding；
   被排除的规则/条数/原因写入 `coverage.suppressedFindings`，报告单独展示。
3. **部分评估**：SW-002（只算走线铜面积）、PD-001/002（平面间电容按 0）、
   EF-001/002（未找到输入轨 LC）标 `partial`，其上游结果保留，但类别状态不是通过。
4. **不伪造 finding**：EM finding 必须能在 `emc-input/emc-raw.json` 中找到对应
   `source_rule_id`；测试逐条对账。唯一的 `EM-000` 是分析执行错误说明。

## 3. 覆盖模型

`coverage` 结构：

```json
{
  "requested": true,
  "status": "partial",
  "standard": "fcc-class-b",
  "available": true,
  "categories": [
    {
      "key": "ground_plane",
      "label": "地平面完整性",
      "status": "partial",
      "rules": [{"rule": "GP-001", "status": "not_evaluated", "reason": "..."}],
      "evaluatedRules": ["GP-005"],
      "partiallyEvaluatedRules": [],
      "notEvaluatedRules": [{"rule": "GP-001", "reason": "..."}],
      "reasons": ["..."]
    }
  ],
  "evaluatedRules": ["..."],
  "partiallyEvaluatedRules": ["..."],
  "notEvaluatedRules": [{"rule": "...", "reason": "..."}],
  "suppressedFindings": [{"rule": "GP-002", "count": 1, "reason": "..."}],
  "unsupportedRules": [],
  "counts": {"evaluated": 25, "partial": 5, "notEvaluated": 14, "issues": 6, "facts": 1},
  "findings": 6,
  "facts": 1,
  "detectors": {"power_regulators": {"status": "ok", "count": 1}, "...": {}},
  "upstream": {"available": true, "script": "...", "summary": {}, "categorySummary": {}},
  "artifacts": {"schematic": "emc-input/schematic.json", "pcb": "...", "raw": "..."}
}
```

状态聚合：

- `failed`：上游执行失败/输出不合法（唯一会影响退出码的 EMC 状态）
- `not_evaluated`：没有任何规则可评估，或未启用/上游不可用
- `partial`：至少一条规则/类别未评估或部分评估
- `found`：全部可评估规则已评估，且保留的 finding 中有问题/事实
- `pass`：全部可评估规则已评估且没有 finding

## 4. 评估与未评估类别（本机样例）

样例：`tests/fixtures/Student-DCDC-Buck-Converter`（2 层板，9 个元件，73 段走线，7 个过孔），
适用标准 `fcc-class-b`。

### 4.1 已评估（25 条规则）

`GP-005`、`DC-001`、`DC-002`、`DC-003`（2 层板不适用）、`IO-001`、`IO-002`、
`SW-001`、`SW-003`、`CK-001`、`CK-002`、`CK-003`、`VS-001`、`SU-001`、`EE-002`、
`DP-001`、`DP-002`、`DP-003`（无差分对，规则不适用）、`DP-004`、`BE-003`、
`ES-001`、`ES-002`、`TH-001`、`TH-002`、`SH-001`、`ML-001`。

说明：样例没有晶振、保护器件或差分对；对应检测器已运行且返回空结果，因此
IO/ES/DP/ML 的「无结果」是真实结论，不是未评估。

### 4.2 部分评估（5 条规则）

| 规则 | 原因 |
|---|---|
| SW-002 | 只统计走线铜面积（宽×长）；缺少 zones，未计入铺铜面积 |
| EF-001/EF-002 | 未检测到位于稳压器输入轨的 LC 滤波器；上游对纯电容滤波不下结论（样例的 L1/C1、L1/C3 在 SW/OUT，不是输入滤波） |
| PD-001/PD-002 | 缺少叠层介质厚度/εr，平面间电容按 0；仅用电容模型做解析阻抗扫描 |

### 4.3 未评估（14 条规则）

| 规则 | 原因 |
|---|---|
| GP-001 | 缺少回流路径连续性数据（需铺铜实形与上游 `--full` 级分析） |
| GP-002/GP-003/GP-004 | 离线解析未捕获铺铜/区域填充形状（zones） |
| CK-004 | 同上（需要接地覆铜 bbox 判断晶振附近是否有铺铜） |
| SU-002/SU-003 | 未捕获叠层介质厚度与介电常数（εr） |
| EE-001 | 未捕获 εr；上游默认 4.4 的板腔谐振属于近似值 |
| BE-001/BE-002 | 未捕获板框线段几何/ zones |
| XT-001 | 未计算走线邻近度（trace_proximity） |
| PD-003/PD-004 | 缺少 `power_budget`、负载 IC、走线寄生与跨轨瞬态电流 |
| RP-001 | 未计算信号换层与过孔层对（layer_transitions） |

> 在多层板（>2 铜层）上，DC-003 也会因缺少 zones 无法判断「电容是否在
> 同网覆铜内」，标记 `not_evaluated`。

### 4.4 类别状态

| 类别 | 状态 | 已评估/部分/未评估 |
|---|---|---|
| ground_plane | partial | GP-005 / — / GP-001..004 |
| decoupling | evaluated | DC-001..003 / — / — |
| io_filtering | evaluated | IO-001..002 / — / — |
| switching_emc | partial | SW-001、SW-003 / SW-002 / — |
| clock_routing | partial | CK-001..003 / — / CK-004 |
| via_stitching | evaluated | VS-001 / — / — |
| stackup | partial | SU-001 / — / SU-002..003 |
| emission_estimate | partial | EE-002 / — / EE-001 |
| diff_pair | evaluated | DP-001..004 / — / — |
| board_edge | partial | BE-003 / — / BE-001..002 |
| crosstalk | not_evaluated | — / — / XT-001 |
| emi_filter | partial | — / EF-001..002 / — |
| esd_path | evaluated | ES-001..002 / — / — |
| thermal_emc | evaluated | TH-001..002 / — / — |
| shielding | evaluated | SH-001 / — / — |
| pdn | partial | — / PD-001..002 / PD-003..004 |
| return_path | not_evaluated | — / — / RP-001 |
| inductor_leakage | evaluated | ML-001 / — / — |

## 5. 样例实际运行结果

运行命令：

```bash
node .agents/skills/ad-happy/scripts/analyze.mjs \
  --project tests/fixtures/Student-DCDC-Buck-Converter \
  --gerber tests/fixtures/gerber-basic \
  --out "$TEMP/ad-happy-p5-emc2" --emc
```

- 退出码：`0`（EMC 为 `partial`，按约定不影响退出码）
- CLI 摘要：`EMC：partial；问题 6 / 事实 1；已评估规则 25 + 部分 5 / 未评估 14（标准 fcc-class-b）`
- `summary.json`：31,217 字节（<32KB）
- `emc.json`：31,142 字节；`emc-input/emc-raw.json`：21,110 字节；
  `emc-input/schematic.json`：8,916 字节；`emc-input/pcb.json`：33,358 字节
- `report.html`：58,199 字节，包含「EMC 预合规」章节

上游 `analyze_emc.py` 原始输出：**10 条 finding**，`emc_risk_score=86.5`：

```text
GP-001 info  ground_plane      Return path analysis data not available
GP-002 error ground_plane      No ground plane zones detected
IO-001 info  io_filtering      No EMC filtering near J2
IO-001 info  io_filtering      No EMC filtering near J1
SU-001 info  stackup           Adjacent signal layers: F.Cu, B.Cu
EE-001 info  emission_estimate Board cavity resonance frequencies
SW-001 warning switching_emc   IC1 harmonics in 30-88 MHz band
SW-001 info  switching_emc     IC1 harmonics in 88-216 MHz band
SW-001 info  switching_emc     IC1 harmonics in 216-960 MHz band
EE-002 info  emission_estimate IC1 harmonic envelope
```

覆盖模型排除 3 条（`GP-001`、`GP-002`、`EE-001`，见 `suppressedFindings`），
保留 7 条归一化 finding：

```text
EM-IO-001 nice_to_have issue 连接器 J2 附近缺少 EMI 滤波
EM-IO-001 nice_to_have issue 连接器 J1 附近缺少 EMI 滤波
EM-SU-001 nice_to_have issue 相邻信号层之间缺少参考平面
EM-SW-001 should_fix  issue 稳压器 IC1 的开关谐波落入测试频段（30-88 MHz）
EM-SW-001 nice_to_have issue 稳压器 IC1 的开关谐波落入测试频段（88-216 MHz）
EM-SW-001 nice_to_have issue 稳压器 IC1 的开关谐波落入测试频段（216-960 MHz）
EM-EE-002 nice_to_have fact  稳压器 IC1 谐波包络估算
```

关键点：**上游 GP-002 的 `error`（「没有接地平面」）是基于 `zones=[]` 的兜底结果，
不是真实设计问题**；本实现把它排除并标记 GP-002 未评估，而不是让它进入
`must_fix` 计数。SU-001 的 `info` 是 2 层板相邻信号层的真实上游结论（两面板
无法在中间插入参考平面），按 `nice_to_have` 展示。

## 6. CLI 与报告行为

- 不带 `--emc`：
  - `rules.emc = not_evaluated`（`ALL_RULES` 中新增）
  - 不调用上游、不写 `emc.json`/`emc-input/`、不产生 `EM-` finding
  - 报告不渲染 EMC 章节；只在「数据覆盖与未评估」中显示一行
    「未启用 --emc（可选步骤），本次没有运行。」
- 带 `--emc`：
  - `emc-input/` 每次运行重建：`schematic.json`、`pcb.json`、`raw.json`、
    `emc-raw.json`（上游原始输出）与上游生成的 `capability_mode.json`
  - `emc.json` 写入归一化 finding 与完整 coverage
  - 报告新增「EMC 预合规」章节：适用标准、类别覆盖表、EMC 发现、被排除的上游结果、
    说明与限制、产物路径
  - `rules.emc` 取 coverage 状态；`partial`/`not_evaluated`/`found` 均不改变退出码，
    `failed` 才参与聚合（退出码 3）
- 缺少上游脚本/`KICAD_HAPPY_EMC_SCRIPTS` 指向无效目录：
  - `rules.emc = not_evaluated`，`summary.emc.available=false`，原因明确写出
  - 无 `EM-` finding，退出码与不带 `--emc` 相同
- 上游执行失败/超时/输出不合法：
  - `rules.emc = failed`，产生 `EM-000`（`must_fix`，描述明确为「分析执行错误」）
  - 退出码 3

## 7. 测试与验证

```text
node --test tests/*.test.mjs   → 152 passed, 0 failed
python -B -m pytest -q         → 71 passed, 1 warning
```

新增 `tests/emc.test.mjs`（5 条）：

1. **适配器字段**：`buildEmcInputs` 生成 `statistics`、`findings`（含
   `detect_power_regulators`）、`nets`、`layers`、`setup.stackup`、`board_outline`、
   `footprints`（`pads/pad_nets/connected_nets`）、`tracks.segments`、`vias.vias`、
   `net_lengths`、`decoupling_placement`、`ground_domains`；并断言铺铜相关类别
   未评估且原因非空。
2. **实际调用上游**：`runEmc` 生成 `emc-raw.json`（`analyzer_type=emc`）；每条
   EM finding 都有 `source_rule_id` 且能在上游原始结果中找到；标题/描述为中文；
   14 条固定未评估规则不出现；`GP-002` 兜底结果被记录在 `suppressedFindings`；
   ground_plane/board_edge/crosstalk/return_path 类别为 partial/not_evaluated 且有原因。
3. **CLI 正常启用**：默认运行退出码与 `--emc` 相同；`emc-input/` 只在 `--out` 下；
   `summary.emc`/`emc.json` 存在；报告含 EMC 章节与 FCC 标准；源工程无
   `emc-input/`；默认报告不渲染 EMC 章节。
4. **上游执行失败**：用替身 `analyze_emc.py` 退出 2，断言 `rules.emc=failed`、
   `manifest.stages.emc=failed`、`EM-000` 可见、退出码 3。
5. **缺少上游脚本**：`KICAD_HAPPY_EMC_SCRIPTS` 指向空目录，断言
   `rules.emc=not_evaluated`、无 EM finding、退出码与默认相同、原因可见。

另外，既有 147 条 Node 测试与 71 条 Python 测试全部通过；`--emc` 的加入没有改变
默认运行的退出码、findings 数量或规则语义。

## 8. 样例路径

- 默认样例（按仓库既有约定，不包含可选阶段）：
  `docs/sample-report/`
  - `report.html` 不渲染 EMC 章节
  - `summary.json` 中 `rules.emc = "not_evaluated"`、`emc.requested = false`
- 本次 `--emc` 演示输出（临时目录，未提交，避免大 JSON 产物）：
  `%TEMP%/ad-happy-p5-emc2/`
  - `emc.json`、`emc-input/`、`report.html`（含「EMC 预合规」章节）

## 9. 已知限制与风险

1. **没有铺铜实形**：GP-001/002/003/004、CK-004、BE-002 无法评估；多层板的
   DC-003 也无法排除「电容在同网覆铜内」的情况。这是离线 PcbDoc 解析的硬限制。
2. **没有板框线段**：BE-001/002 无法评估；只有包围盒尺寸，无法判断走线到板边的距离。
3. **没有 layer_transitions**：DP-003、RP-001 无法评估。
4. **没有 trace_proximity**：XT-001 无法评估。
5. **没有叠层介质参数**：SU-002/003、EE-001、PD-001/002 的平面间电容无法计算；
   PD-001/002 只能做电容模型解析扫描，标 `partial`。
6. **没有 power_budget/负载 IC**：PD-003/004 无法评估。
7. **LC 滤波器按输入轨过滤是适配层选择**：上游 EF 规则本身不校验滤波器位于哪条轨；
   本实现只传 `shared_net == regulator.input_rail` 的 LC，避免把开关/输出 LC 当成
   输入 EMI 滤波器。代价是如果稳压器 `input_rail` 识别失败，EF 会保持 partial。
8. **EMC 结果是设计风险筛查**，不是预测试/合规测试的替代品；上游模型使用保守假设
   （如 10 ns 上升沿、默认 εr=4.4，后者已被本实现禁用），不能替代实测。
9. **只分析第一份原理图与最后一块 PcbDoc**（与 AD-Happy 既有约定一致）；多板/多页
   工程需要分别运行。
10. **kicad-happy 版本耦合**：适配器依赖 `emc_rules.py` 的字段读取与检测器签名；
    上游升级后需要重新核对（本实现已把未登记的上游规则列入 `unsupportedRules`
    并排除，不会静默混入）。

## 10. 上游只读与网络

- 未修改 `D:/Tools/kicad-happy` 下任何文件；`analyze_emc.py`、`emc_rules.py`、
  `emc_formulas.py`、`emc_prepare.py` 所依赖的 kicad-happy 检测器均通过既有
  `KICAD_HAPPY_SCRIPTS` 路径 import。
- 未传 `--spice-enhanced`，未导入 `emc_spice` 的仿真后端；测试与样例运行均无网络请求。

## 11. P5 评审修复（第二轮）

本节针对 P5 评审的 1 个 Critical 与 3 个 Important 修复；与上文冲突处，以本节为准。

### 11.1 Critical：ML-001 敏感器件检测器缺失

**问题**：上一版 `emc.mjs` 只用 `powerRegulators && hasPcb` 判定 `ML-001` 可评估，
但 `emc_prepare.py` 没有运行 `detect_adc_circuits`、`detect_opamp_circuits`、
`detect_rf_chains`。上游 `check_inductor_leakage()` 的敏感器件集合来自
晶振 + ADC + 运放 + RF 四个检测器；检测器未运行时上游拿不到结果，覆盖模型却仍显示
`inductor_leakage: evaluated`，属于虚假通过。

**修复**：

1. `scripts/reuse/emc_prepare.py` 新增三个检测器：
   - `detect_opamp_circuits(ctx)`（`signal_detectors.py`）
   - `detect_rf_chains(ctx)`（`domain_detectors.py`）
   - `detect_adc_circuits(ctx, rc_filters, protection_devices)`（`domain_detectors.py`）
2. ADC finding 的 `ref` 字段补上 `reference` 与 `ic.ref` 别名，使上游
   `check_inductor_leakage()` 实际能取到 ADC 位号（上游读取 `adc.get('ic', {}).get('ref')`
   或 `adc.get('reference')`，而检测器原生字段名是 `ref`）。
3. 三个检测器的运行状态写入 `_ad_happy.detectors.adc_circuits/opamp_circuits/rf_chains`
   与 `emc.json` 的 `coverage.detectors`。
4. `emc.mjs` 的 `ML-001` 判定改为：`powerRegulators && hasPcb && netlistComplete
   && crystals.ok && adc_circuits.ok && opamp_circuits.ok && rf_chains.ok`；
   任一条件不满足标 `not_evaluated`，原因写明缺哪类检测器。
5. 新增聚焦测试：把样例 L1 改为未屏蔽电感、在 L1 旁 2 mm 放置 `U2=OPA333AIDBVR`，
   断言四个检测器均为 `ok`、`inductor_leakage` 类别为 `evaluated`，并实际产生
   `EM-ML-001`（组件包含 `L1`、`U2`，中文说明包含两者）。

样例本身没有 ADC/运放/RF，但三个检测器现在确实运行且返回空结果，因此样例中
`ML-001` 的 `evaluated` 是真实结论（没有敏感器件可触发），不是未运行导致的假通过。

### 11.2 Important 1：晶振检测器状态参与判定

`emc.mjs` 现在读取 `detectors.crystals.status`。以下规则在晶振检测器未成功运行时
标记 `not_evaluated` 并写明「晶振检测器未成功运行，依赖晶振频率的规则无法下结论」：

- `CK-001`、`CK-002`（时钟网络识别/长度）
- `VS-001`（过孔缝合频率要求）
- `SH-001`（连接器开口谐振与发射源匹配）
- `ML-001`（晶振也是敏感器件来源之一）

新增测试：构造 `crystals.status = failed` 的输入，断言上述规则全部未评估，
且不保留上游结果，同时 `CK-003`（只依赖 PCB 走线/连接器）保持可评估。

### 11.3 Important 2：网表完整性统一降级

`emc.mjs` 现在把 `netlistComplete` 作为所有原理图检测器驱动规则的前置条件。
当 `netlistComplete === false` 时，以下规则标 `not_evaluated`（原因：原理图网表匹配
不完整，依赖网表的规则无法下结论）：

- `SW-001`、`SW-003`、`EE-002`（稳压器检测）
- `TH-001`、`TH-002`（输出电容/磁珠）
- `IO-001`、`ES-001`、`ES-002`（保护器件）
- `EF-001`、`EF-002`（LC 滤波）
- `ML-001`（敏感器件）
- `CK-001`、`CK-002`（晶振时钟网络）
- `DP-001`、`DP-002`、`DP-003`、`DP-004`（差分对）

`IO-002` 只依赖 PCB 焊盘网络，不受原理图网表完整性影响；`CK-003`、`BE-003` 同理。
`coverage.netlist.complete` 与 `summary.emc.netlistComplete` 对外可见，报告 EMC
章节新增「网表完整性」一栏（完整 / 不完整（相关规则已降级）/ 未知）。
新增测试：`netlistComplete=false` 时上述规则全部未评估，且不保留上游结果；
`IO-002` 仍为 `evaluated`。

### 11.4 Important 3：缺 zones/介质的规则改为 not_evaluated

按需求原文与控制器的裁定，取消以下近似/部分评估：

| 规则 | 旧状态 | 新状态 | 原因 |
|---|---|---|---|
| `SW-002` | partial（只算走线面积） | `not_evaluated` | 缺少 zones，无法完整计算开关节点铜面积 |
| `PD-001`、`PD-002` | partial（平面间电容按 0） | `not_evaluated` | 缺少叠层介质厚度/εr；不再用近似值出结论 |
| `DP-001`、`DP-002` | evaluated（默认 εr=4.4） | `not_evaluated` | 传播延时/skew 需要 εr；不静默使用默认 4.4 |

`DP-003` 仍只在存在差分对时因缺少 `layer_transitions` 未评估；`DP-004` 不依赖 εr，
保持可评估。`EE-001` 的原因文案明确写出「上游会用默认 εr=4.4 做近似，本实现未使用」。
不再有 EMC 规则在缺介质参数时保留默认 εr 的近似结论。

### 11.5 样例结果变化

重新运行样例（`--emc`，`fcc-class-b`）：

```text
EMC：partial；问题 6 / 事实 1；已评估规则 23 + 部分 2 / 未评估 19
```

类别状态变化：

- `switching_emc`：partial（SW-001、SW-003 可评估；SW-002 未评估）
- `pdn`：`not_evaluated`（PD-001..004 全部未评估）
- `diff_pair`：partial（DP-003/004 可评估；DP-001/002 因缺少 εr 未评估）
- `inductor_leakage`：`evaluated`（晶振/ADC/运放/RF 检测器均已运行；样例无敏感器件）
- 其余类别状态与第一轮一致

上游原始输出仍为 10 条（保留 7 条：6 问题 + 1 事实，排除 GP-001/GP-002/EE-001）；
`summary.json` 压缩后约 31 KB，仍低于 32 KB 上限。

### 11.6 测试与产物

```text
node --test tests/*.test.mjs   → 155 passed, 0 failed（EMC 测试 8 条）
python -B -m pytest -q         → 71 passed, 1 warning
```

新增/加强的测试：

1. `ML-001：ADC/运放/RF 检测器实际运行，运放靠近开关电感时产生 finding`
2. `晶振检测器失败时 CK/VS/SH/ML 降级为 not_evaluated`
3. `网表不完整时所有依赖原理图检测器的规则降级`
4. 原「缺少铺铜/层切换」测试的固定未评估列表加入 `SW-002`、`PD-001/002`、
   `DP-001/002`，并断言 `pdn` 类别不再是 partial/evaluated 的通过状态。

样例报告：

- 默认样例 `docs/sample-report/` 仍按仓库约定不带可选阶段（无 EMC 章节，
  `rules.emc=not_evaluated`）。
- 本轮 `--emc` 验证输出在 `%TEMP%/ad-happy-p5-emc-fixed/`，类别表与上文一致；
  `emc.json`、`emc-input/` 与 `report.html` 均在临时目录，未提交大 JSON。
