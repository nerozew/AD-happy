# AD-Happy 终审修复报告

工作分支：`feature/ad-happy`（基于 `b00cec0`）
修复提交范围：`49dee23`..`8ae06db`（15 个提交）
日期：2026-11-24

## 结论

终审列出的 C1–C5、I1–I5 与配套 Minor 全部完成。kicad-happy 目录未做任何修改。
最终测试：Node 67 项全通过，Python 56 项全通过。

## C1 · DFM 在关键检查未执行时报「通过」

**修复**

- `pcb.mjs`
  - `toVia` 输出 `diameterMil`（来源 `DIAMETER`）。
  - `toPad` 输出 `drillMil`（`HOLESIZE`）、`plated`（`PLATED`）与派生 `type`
    （`thru_hole` / `np_thru_hole` / `smd`）。
  - 新增铜层 `arcs` 输出（网络、层、线宽、中心坐标、半径、起止角）。
- `pcb_detectors.py`
  - `_vias` 用真实外径换算为 mm 传给 DFM，环宽检查开始生效。
  - `_pad` 传 `type` / `drill`，PTH 最小钻孔检查开始生效。
  - `_tracks` 接收 `arcs` 并还原为 kicad-happy 的三点圆弧（起点/中点/终点）。
  - 新增 `_dfm_skipped_checks`：线宽、走线间距、过孔钻孔、过孔环宽、PTH 焊盘
    钻孔、板框任一输入缺失时，DFM 状态为 `partial`，并在
    `coverage.skippedChecks`（含规则名、子检查、原因）列出。
  - `run_pcb` 返回增加 `coverage`；`pipeline.py` 把它合并为
    `coverage.pcb.skippedChecks`。
- 状态词表与报告：新增 `partial` / 「部分完成」；报告结论、状态统计、
  「部分完成的规则」清单与数据覆盖节均展示；`partial` 不进入 pass 统计。
  任一条规则为 `partial` 时整次运行状态为 `partial`（退出码 3）。
- 夹具：重新生成 `tests/fixtures/pcb.json`，包含过孔外径与焊盘 PTH 信息。

**测试**

- `tests/pcb.test.mjs`：过孔外径 23.622 mil、钻孔 11.811 mil；4 个 PTH 焊盘；
  `arcs` 字段存在。
- `tests/test_pcb_detectors.py`
  - `test_dfm_annular_ring_check_runs_with_via_diameter`：DFM 实际算出
    `min_annular_ring_mm ≈ 0.15`、`min_drill_mm ≈ 0.3`。
  - `test_dfm_partial_when_subchecks_skipped`：去掉过孔外径与焊盘类型/钻孔后
    DFM 为 `partial`，coverage 含 `via_annular_ring` 与 `pth_pad_drill`。
  - `test_arc_tracks_are_converted_for_detectors`：圆弧三点与单位换算。
  - `test_missing_copper_is_not_evaluated`：无铜时覆盖 `copper` 缺口。
- `tests/report.test.mjs`：`partial` 显示「部分完成」，不混入通过清单。

## C2 · No-ERC 未映射，故意悬空引脚误报

**修复**

- `sch.mjs`：扫描 `recordKind === "22"`（`AltiumSchNoErcRecord`），输出
  `noErcs: [{x,y}]`；同时为每个引脚计算 `xHotspot` / `yHotspot`
  （`LOCATION + PINLENGTH × 方向`）。
- `adapter.py`：把 `noErcs` 转为 `ctx.no_connects`；元件引脚与网络内引脚坐标
  统一改用热点坐标，与 `analyze_connectivity` 的坐标匹配口径一致。
  `_build_nets` 的网络成员坐标也同步为热点。
- 夹具重新生成 `tests/fixtures/adapter-raw.json`（含热点与 `noErcs`）。

**测试**

- `tests/sch.test.mjs`：热点计算与 `readNoErcs` 过滤 `recordKind=22`。
- `tests/test_adapter.py`：No-ERC 坐标进入 `ctx.no_connects`，引脚坐标为热点。
- `tests/test_detectors.py::test_no_erc_suppresses_unconnected_pin_finding`：
  带 No-ERC 的悬空引脚不再产生 NT-002。

## C3 · 规则在无网表/无解析值时仍返回 pass

**修复**（`detectors.py`）

- `voltage_divider`：要求 `ctx.components`、`ctx.nets` 与可解析电阻值。
- `rc_filter`：要求 `ctx.nets` 与可解析的 R、C。
- `power_regulator`：要求 `ctx.components`、`ctx.nets` 与非空 `parsed_values`。
- `shorted_component`：要求 `ctx.components` 与非空 `ctx.pin_net`。
- `decoupling`：在原有电源轨条件外增加 `ctx.components` 门控。
- 不满足均为 `not_evaluated`。

**测试**

- `test_no_nets_does_not_report_pass`：有元件/可解析值但无网表时四条拓扑规则
  均不是 pass。
- `test_unparsable_values_do_not_report_pass`：有网表但 Comment 不可解析时
  VD/RC/PR 为 `not_evaluated`。
- `test_decoupling_not_evaluated_without_components`。

## C4 · `clearArtifacts` 可能删除用户目录里的无关文件

**修复**（`analyze.mjs`）

- 选择 marker 方案：输出目录写入 `.ad-happy-run`
  （`{"tool":"ad-happy","schemaVersion":1}`）。
- 已存在且非空的目录：无 marker 或 marker 不匹配时直接拒绝，退出码 2，
  不读取/删除任何文件；marker 匹配才清理固定产物。
- 空目录与新建目录正常写入 marker 后运行。

**测试**

- `--out 指向无 marker 的非空目录时拒绝且不删除无关文件`：用户自己的
  `manifest.json` 原样保留。
- `同一输出目录可被后续运行安全复用（marker 匹配后清理旧产物）`。

## C5 · 同目录多个 `.PrjPcb` 静默选错工程

**修复**

- `discover.mjs`：`discoverProject(dir, {projectFile?})` 返回全部 `projectPaths`；
  单个工程自动选中；多个且未指定时 `projectPath = null`，由 CLI 报错。
- `analyze.mjs`
  - 多个工程且未指定：退出码 2，stderr 列出候选。
  - 新增 `--project-file`（文件名、相对路径或绝对路径）。
  - `--project` 同时接受 `.PrjPcb` 文件路径，等价于指定该工程。
  - 用法、文件头注释与 manifest 的 `projectPath` 同步。
- `SKILL.md`：步骤 1/2/3 同步多工程选择与 `--project-file`。

**测试**

- `tests/discover.test.mjs`：多候选、按 `projectFile` 选择、未命中时返回候选。
- `tests/e2e.test.mjs`：多 PrjPcb 无参数退出码 2 并列出两者；指定后正常分析；
  `--project` 直接给 PrjPcb 文件可运行。

## I1 · summary/report 不暴露网表匹配率与工程概览

**修复**

- `summary.json` 新增：
  - `schematic: {components, pins, nets, pinsMatched, pinsTotal, pinsMatchRate}`
  - `pcb: {components, pads, nets, tracks, arcs, vias, rules}`
  - `coverage.netlist` 与 `coverage.pcb.skippedChecks`
- `report.html` 新增「工程概览」节（两侧规模、入网引脚、AD 规则清单）。
- 匹配率不足（`pinsMatched < pinsTotal`）时：
  - 报告结论与数据覆盖节显示醒目提示；
  - 依赖网表的原理图规则（VD/RC/PR/短路）中原本为 `pass` 的降级为
    `not_evaluated`；已有 `found` 结果保留（真实发现不因缺口丢弃）；
  - manifest 写入 warning。
- 数据覆盖节列出 DFM 被跳过的子检查。

**测试**

- e2e 断言 summary 两侧概览字段、`coverage.netlist.complete`。
- `report.test.mjs`：工程概览、AD 规则清单、18/22 匹配率提示、
  `via_annular_ring` 跳过项展示。

## I2 · 「事实」填满问题清单

**修复**

- 所有 finding 增加 `kind: 'fact' | 'issue'`（Python 三组规则、crosscheck、
  DET-ERR 与 Node 合成 finding 均已覆盖）。
- 焊盘间距、载流、去耦摆放标记为 `fact`。
- 焊盘间距按网络聚合：每个网络一条，保留走线距离范围、最大绕行比、
  代表焊盘对，并把绕行比 ≥ 1.5 的焊盘对列为异常。
- summary `counts.total` 只统计问题，新增 `counts.facts`；top-N 先为每个
  `found` 规则保留一条（优先非事实），再按严重度补齐，最后才是事实。
- 报告问题清单排除事实，新增「实测事实」节，明确不计入问题计数。

**测试**

- `test_facts_are_separated_from_issues`、`test_pad_distance_keeps_measured_facts`。
- e2e：`counts.total + counts.facts == findings.length`，且每个 found 规则
  至少一条出现在 summary top-N。
- `report.test.mjs`：事实只出现在「实测事实」节。
- 夹具焊盘间距由 4 条逐对事实变为 2 条按网络聚合事实。

## I3 · 自产英文 finding 文本

**修复**

- NT-002、NT-003、DET-ERR 的 summary/description/recommendation 改为中文。
- PD-DET、DC-DET 文案改为中文（含「实测事实，不是违规」说明）。
- 上游 kicad-happy 英文原文保留；报告问题清单注明「部分条目的描述来自上游
  kicad-happy 检测器原文（英文）」。

**测试**

- `test_connectivity_raw_lists_become_findings` 断言中文且无英文旧文案。
- `test_facts_are_separated_from_issues` 断言 PD/DC 中文文案。

## I4 · 首次克隆没有安装路径

**修复**

- `SKILL.md` 新增「前置条件」：Node/Python 版本、技能目录 `npm install`、
  `KICAD_HAPPY_SCRIPTS` 与自检命令。
- `selfcheck.mjs`：altiumts 缺失/版本不符/读取失败时错误信息包含技能目录绝对路径。
- 仓库根新增简短 `README.md`：安装、运行、产物、已知限制。

**测试**

- `node --test tests/selfcheck.test.mjs` 通过。

## I5 · 大文件与 Python 进程无边界

**修复**

- `analyze.mjs` 对选中的 SchDoc/PcbDoc 做 `statSync`，超过 50MB 抛明确错误，
  走既有解析失败路径（文档 failed、DET-ERR、退出码 3）。
- `spawnSync('python', ...)` 增加 120 秒 `timeout`；`ETIMEDOUT` 映射为
  「Python 分析阶段超时」并写 manifest。
- Python 参数增加 `-B`，避免向只读的 kicad-happy 目录写 `__pycache__`。
- README「已知限制」记录 50MB、120 秒与超时行为。

**测试**

- `tests/e2e.test.mjs` 用 51MB 稀疏文件验证超限被拒绝、manifest 错误明确、
  PCB 规则标记 failed。
- 超时路径无法在常规测试中稳定模拟，已实现错误映射并写入 README 已知限制。

## Minor

- 状态词表增加 `partial`（设计文档 3.5 的 5 个状态），报告显示「部分完成」，
  不计入 pass。
- `SKILL.md` 第 5 步：有 `recommendation` 时给出，没有则说明未给出，禁止编造；
  问题清单只讲 issue，fact 单独汇报。
- `SKILL.md` 输出目录说明：使用 CLI 默认输出目录；需要临时目录时使用当前
  shell 解析后的绝对路径，不传递字面 `%TEMP%`。

## 测试与验收

```text
$ node --test tests/*.test.mjs
ℹ tests 67
ℹ pass 67
ℹ fail 0
ℹ duration_ms ~6031

$ python -m pytest -q
56 passed, 1 warning in 0.76s
```

（pytest 的唯一 warning 来自第三方 anyio 的 pytest 插件弃用提示，与本仓库无关。）

手工验证：对 `tests/fixtures/Student-DCDC-Buck-Converter` 运行 CLI，退出码 0；
summary 含
`schematic {components:9, pins:22, nets:6, pinsMatched:22}`、
`pcb {components:9, pads:22, nets:6, tracks:73, vias:7, rules:35}`；
top findings 以 VD-DET/PR-DET 开头；报告含「工程概览」「AD 规则清单」
「实测事实」「检测器原文」说明。

## 未修项

无。终审清单中的 C1–C5、I1–I5 与配套 Minor 均已修复。
以下为明确的非目标（与设计一致）：库文件独立解析、原生 ERC/DRC、层次/总线、
装配变体、自动修复；上游 kicad-happy 文件保持只读。

## 提交列表

```text
49dee23 fix(C1): DFM 使用真实过孔外径与焊盘 PTH 信息，缺输入时降级为 partial
fba7472 fix(C2): 映射 Altium No-ERC 标记，避免误报故意悬空引脚
47fc48b fix(C3): 规则缺少网表或解析值时不再返回 pass
fae4b4e fix(C4): --out 仅在带 .ad-happy-run marker 的目录内清理产物
5edf2b1 fix(C5): 多 .PrjPcb 目录不再静默选错工程
cce8967 fix(I1): summary/report 暴露工程概览与网表匹配率
6f8cf3c fix(I2): 实测事实与问题分离，避免挤占问题清单
7ffe006 fix(I3): AD-Happy 自产 finding 文案改为中文
7d5c207 fix(I4): 补充安装前置条件与仓库 README
b7e2856 fix(I5): 输入文件与 Python 进程增加硬边界
6a6fb38 fix(minor): SKILL 汇报步骤适配 fact/partial 与建议缺失说明
5181971 fix(C1): 圆弧走线参与铺铜覆盖判定并补充转换测试
24818be fix(I2): Node 合成的 DET-ERR finding 也带 kind=issue
d4da7f1 fix(C1): 规则 partial 视为整次运行部分完成（退出码 3）
8ae06db fix(C5): SKILL 与 CLI 一致，--project 可直接给 .PrjPcb
7295972 fix(C3): decoupling 增加网表与可解析电容门控
```

## 补丁·复审后追加：C3 去耦规则门控

复审指出 `decoupling` 仍只检查 `ctx.components`，在「有组件、有电源轨、
`nets={}`」或「有 nets 但无可解析电容值」时返回 pass。上游
`detect_decoupling` 遍历 `ctx.nets`，且只统计 `parsed_values` 中可解析的
电容，因此空结果代表「没检查」，不是通过。

**修复**

- `detectors.py::_decoupling` 增加门控：
  - `ctx.nets` 必须非空；
  - `_has_parsed(ctx, "capacitor")` 必须为真（至少一个可解析电容值）；
  - 原有的「电源轨 ≥ 2 且含非地网络」条件保留；
  - 任一不满足返回 `not_evaluated`。
- `analyze.mjs::NETLIST_DEPENDENT_RULES` 加入 `decoupling`，网表匹配率不足时
  其空结果会被降级为 `not_evaluated`。

**测试**

- `test_decoupling_not_evaluated_without_nets`：有组件、有电源轨、`nets={}` → `not_evaluated`。
- `test_decoupling_not_evaluated_without_parsed_capacitor`：有 nets 与电源轨、
  电容值不可解析 → `not_evaluated`。
- `test_decoupling_evaluated_with_two_rails_including_non_ground`：补可解析电容
  与 `+5V` 网表后仍可正常评估。
- 样板夹具（仅 GND 一条电源轨）的 `decoupling` 仍为 `not_evaluated`，
  `test_expected_status_on_fixture` 通过。

**全量测试**

```text
$ node --test tests/*.test.mjs
ℹ tests 67   ℹ pass 67   ℹ fail 0

$ python -m pytest -q
58 passed, 1 warning
```

提交：`7295972 fix(C3): decoupling 增加网表与可解析电容门控`
