# AD-Happy finding 中文文案本地化报告

## 1. 目标与范围

本轮只做文案本地化，不改任何规则逻辑、阈值、严重度、置信度、finding 数量或
`finding_id`。kicad-happy 目录保持只读，未做任何修改。

本地化覆盖所有实际接线的上游检测器：

- 原理图：`voltage_divider`、`rc_filter`、`decoupling`、`power_regulator`、
  `connectivity`、`shorted_component`；
- PCB：`dfm`、`current_capacity`（`pad_distance` 与 `decoupling_placement`
  的文案本来就由 AD-Happy 适配层生成中文）；
- 跨域：`crosscheck`（正文已是中文，仅修正了失败 finding 的英文标题）。

## 2. 实现方式

新增共享模块
`.agents/skills/ad-happy/scripts/localization.py`，由 `detectors.py` 与
`pcb_detectors.py` 共同调用：

- 按 `(detector, rule_id)` 选择模板，正则 `fullmatch` 检测器原文；
- 动态部分（位号、网络名、引脚号、数值、单位）用命名捕获组原样回填；
- 翻译后把英文原文写入 finding 的 `source_text` 字段，机器可读、可供对照；
- 对未收录的英文模板显式写成 `（检测器原文）<英文>`，不静默透传；
- 本地化在 `assign_finding_ids()` 之后执行，基于 summary 哈希的
  `finding_id` 不会因翻译而漂移；
- AD-Happy 自产规则（`NT-002`、`NT-003`、`XP-001`、`DET-ERR`）不进入上游
  模板兜底，避免异常消息里的英文标识符导致整句被误标。

### 映射清单

| 规则 | 字段 | 原文示例 | 中文输出示例 |
| --- | --- | --- | --- |
| `VD-DET` | summary / description | `Voltage divider R1/R2`；`Resistive voltage divider detected`；`Feedback network voltage divider detected` | `分压器 R1/R2`；`检测到电阻分压器`；`检测到反馈网络分压器` |
| `RC-DET` | summary / description | `RC filter R3/C4 at 1234.5Hz`；`low-pass RC filter` | `RC 滤波器 R3/C4，截止频率 1234.5Hz`；`低通 RC 滤波器` |
| `DC-DET`（原理图去耦） | summary / description | `Decoupling on +3V3`；`Decoupling capacitors on power rail +3V3` | `+3V3 去耦`；`电源轨 +3V3 上的去耦电容` |
| `PR-DET` | summary / description | `Regulator IC1 switching`；`Power regulator (switching) detected`；关键字路径 | `稳压器 IC1（开关型）`；`检测到电源稳压器（开关型）`；`通过关键字匹配检测到电源稳压器（无引脚数据）` |
| `NT-001` | summary / description / recommendation | `Single-pin net: ...` 等三句 | `单引脚网络：...`、`网络 ... 只有一个引脚：...`、`在对应引脚处检查原理图：...` |
| `SP-001` | summary / description / recommendation | 单元件短路与批量短路两种模板 | `... 的两个引脚都连接在网络 “...” 上，元件被短路，不起作用` 等完整中文 |
| `DFM-001` | summary / description / recommendation | 线宽、线间距、钻孔、环宽、板卡尺寸各档模板 | 例：`走线宽度 0.09mm 低于先进工艺下限（0.1mm）`；`钻孔 0.15mm（焊盘 U1）低于先进工艺下限 0.15mm，需要挑战级制造工艺。` |
| `DFM-002` | summary / description / recommendation | IPC 环宽、环宽破损、盘中孔 | 例：`过孔环宽 0.12mm 低于 IPC Class 2 下限 0.125mm` |
| `CC-DET` | summary / description | `Power net GND: 0.254mm min trace` | `电源网络 GND：最小走线 0.254mm`；`电源/地网络 GND：最小走线 0.254mm，最大 0.254mm，共 24 条线段。` |
| `CC-002` | summary / description / recommendation | `Narrow signal: ...` | `窄信号走线：...`；`信号网络 ... 的走线过窄：...` |

拓扑、滤波类型、元件类型等枚举值在中文句子内做了语义映射（如
`switching → 开关型`、`low-pass → 低通`、`capacitor → 电容`），枚举字段
本身的英文值仍保留在 finding 的结构化字段里。

## 3. 保留英文的内容及原因

以下内容按约束或按「机器可读」原则保留英文，不属于报告可见正文：

- `rule_id`、`detector`、`severity`、`confidence`、`finding_id` 与所有 JSON
  字段名：任务明确要求不翻译。
- `source_text` 中的英文原文：刻意保留，用于与 kicad-happy 对照。
- `report_context.section` / `impact` / `standard_ref`：上游机器上下文，
  `report.mjs` 不渲染这些字段。`standard_ref` 中的 `IPC-6012 Class 2` 等也是
  标准编号。
- DFM finding 的 `message`：上游原始消息，作为结构化证据保留；报告展示的是
  已翻译的 `summary` / `description` / `recommendation`。
- 检测器特有的结构化证据字段（如 `r_top`、`topology`、`input_net`、
  `routed_distance_mm`、`anomaly` 等）：字段名与枚举值不翻译。
- 正文中的 `pin_type=power_in`、网络名、位号、封装名、`NetC1_1` 等标识符：
  按原样保留，仅中文句子包住它们。

没有出现需要落到 `（检测器原文）` 兜底的夹具文本；该兜底路径有独立单测覆盖。

## 4. 其他修改

- `crosscheck.py` 的 `DET-ERR` 标题改为
  `跨域交叉检查执行失败：<异常>`，与其余中文 finding 一致。
- `report.mjs` 问题清单提示改为说明本地化与 `source_text`，不再声称上游英文
  会原样展示。
- `README.md` 已知限制同步更新。

## 5. 测试

新增 `tests/test_localization.py`：

- 用 `tests/fixtures/adapter-raw.json` + `tests/fixtures/pcb.json` 跑完整
  Python 流水线，断言每条 finding 的 title/summary、evidence/description
  都含中文、ASCII 字母占比 < 50%、无残留上游英文短语、夹具中不出现
  `（检测器原文）`；
- 断言 `VD-DET` / `PR-DET` 的 `rule_id`、`detector`、`source_text` 与中文
  文案完全符合预期；
- 对 `RC-DET`、原理图 `DC-DET`、`NT-001`、`SP-001`、`CC-DET`、`CC-002`、
  `DFM-001` 的模板做参数化单测，覆盖动态位号/网络/数值回填；
- 覆盖未知英文模板的 `（检测器原文）` 兜底与 `DET-ERR` 排除逻辑。

`tests/e2e.test.mjs` 新增端到端断言：对真实夹具工程运行 CLI，检查生成的
`findings.json` 中所有可见文本为中文且不含已知上游英文短语。

执行结果：

```text
$ node --test tests/*.test.mjs
ℹ tests 68
ℹ pass 68
ℹ fail 0

$ python -B -m pytest -q
71 passed, 1 warning in 0.99s
```

（pytest 的 1 条 warning 来自第三方 anyio 插件的弃用提示，与本改动无关。）

## 6. 样例报告

重新生成命令：

```text
node .agents/skills/ad-happy/scripts/analyze.mjs \
  --project tests/fixtures/Student-DCDC-Buck-Converter \
  --out docs/sample-report
```

产物目录：`docs/sample-report/`；报告：`docs/sample-report/report.html`。

已核对 `report.html` 中可见问题文本全部为中文，例如：

- `稳压器 IC1（开关型）` / `检测到电源稳压器（开关型）`
- `分压器 R1/R2` / `检测到电阻分压器`
- `电源网络 GND：最小走线 0.254mm` / `电源/地网络 GND：最小走线 0.254mm，最大 0.254mm，共 24 条线段。`

`findings.json` 中上述三条 finding 均带 `source_text`，保留原始英文；规则
状态、严重度与 finding 数量与本地化前一致（必须修复 0 / 建议修复 0 /
可优化 2，实测事实 8 条）。

## 7. 提交计划

1. 本地化模块 + 原理图/PCB 适配层接入 + crosscheck 失败文案。
2. 本地化单元测试与端到端中文断言。
3. 重新生成的样例报告、报告提示/README 更新与本报告。
