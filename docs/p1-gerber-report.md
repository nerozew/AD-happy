# AD-Happy 第一阶段：Gerber/钻孔制造文件接入报告

## 1. 目标与范围

本阶段把 kicad-happy 的 Gerber/钻孔分析接入 AD-Happy，让 Altium 工程在
离线审查之外，还能对 OutJob 导出的制造文件做打板前检查。

- 上游依赖：`D:/Tools/kicad-happy/skills/kicad/scripts/analyze_gerbers.py`，
  只读，未做任何修改；
- 新增复用层：`.agents/skills/ad-happy/scripts/reuse/gerber.mjs`；
- CLI：新增 `--gerber <目录>`，省略时自动发现 `Gerber`、`Outputs`、
  `Project Outputs`、`Manufacturing`；
- 报告：新增「制造文件」章节；
- 不改变任何既有规则逻辑或阈值。

## 2. 上游调用方式

```text
python -B -X utf8 <kicad-happy>/scripts/analyze_gerbers.py <Gerber 目录> --output <out>/gerber.json
```

- `-B`：不向只读的上游目录写 `__pycache__`；
- `-X utf8`：Windows 管道固定 UTF-8；
- Python 解释器默认取 `python`，可用 `AD_HAPPY_PYTHON` 覆盖；
- 上游目录默认取 `D:/Tools/kicad-happy/skills/kicad/scripts`，可用
  `KICAD_HAPPY_SCRIPTS` 覆盖（与 `selfcheck.mjs` 一致）；
- 超时 120 秒，stdout/stderr 上限 8MB；
- 调用前先做目录预检：目录不存在、不是目录、为空、没有可识别文件时
  不启动子进程，直接返回 `not_evaluated` coverage 与中文原因。

上游 CLI 的 `--analysis-dir` 会额外创建 `capability_mode.json`；本实现改用
`--output` 显式指定 `gerber.json`。上游仍会在输出目录旁写一个
`capability_mode.json`（first-writer-wins），因此 CLI 把它与 `gerber.json`
一起列入每次运行前的固定产物清理列表。

## 3. 观察到的上游输出结构

以 `--output` 运行时，上游写出一个 JSON 信封（schema_version `1.4.0`），
本次实际观察到的顶层键：

```text
analyzer_type, schema_version, directory, generator, layer_count,
board_dimensions, statistics, completeness, alignment, drill_classification,
pad_summary, trace_widths, component_analysis, net_analysis, gerbers, drills,
drill_tools, findings, assessments, summary, trust_summary, inputs, compat,
capability_mode_ref
```

关键字段：

- `statistics`：`gerber_files`、`drill_files`、`total_holes`、
  `total_flashes`、`total_draws`；
- `completeness`：`found_layers`、`expected_layers`、`missing_required`、
  `missing_recommended`（有 `.gbrjob` 时为 `missing`/`extra`）、
  `has_pth_drill`、`has_npth_drill`、`complete`、`source`；
- `alignment`：`aligned`、`issues`、`layer_extents`；
- `drill_classification`：`vias`、`component_holes`、`mounting_holes`、
  `classification_method`；
- `gerbers[]`：每个 Gerber 文件的 `layer_type`、`units`、flash/draw 计数；
- `drills[]`：每个钻孔文件的 `type`（PTH/NPTH/mixed/unknown）、`units`、
  `hole_count`、`tools`；
- `findings[]`：上游已提供稳定规则 ID 的 5 类检查：

| rule_id | 触发条件 | 上游严重度 |
| --- | --- | --- |
| `GR-001` | 缺少层（必需层 warning，建议层 info） | warning / info |
| `GR-002` | 铜层/边框层坐标范围不一致 | warning |
| `GR-003` | 没有钻孔文件，或钻孔文件 0 孔 | warning / info |
| `GR-004` | 锡膏层焊盘数明显少于铜层 | warning |
| `GR-005` | 边框层绘制线段少于 4 条 | error |

上游 finding 已带 `detector: "analyze_gerbers"`、`category`、
`confidence`、`evidence_source`、`components`/`nets`/`pins`、
`report_context` 与 `finding_id`（形如 `gerber:GR-001:<hash>`）。

### 上游格式覆盖的一个重要事实

上游 CLI 的 `inputs.source_files` 枚举包含 `.xln`、`.nc`，但
`analyze_gerbers()` 的解析循环只收集 `*.drl`、`*.DRL`，以及通过文件头
（`M48` 或 `T数字C数字`）识别的 Excellon `.txt`。实测把 `.drl` 改名为
`.xln` 后，`statistics.drill_files` 变为 0，并触发 `GR-003`。

因此 AD-Happy 的处理是：

- `.drl` 与 Excellon `.txt` 正常计入钻孔；
- `.xln`、`.nc` 会被检测到并在 `coverage.unsupportedDrillFiles` /
  `coverage.reasons` 中明确说明「上游未纳入评估」；
- 如果目录里只有 `.xln`/`.nc`，直接返回 `not_evaluated`，不伪造通过。

## 4. 归一化与映射决策

### 4.1 finding 结构

`normalizeGerberFinding()` 把上游 finding 转成 AD-Happy 形状：

| AD-Happy 字段 | 取值 |
| --- | --- |
| `detector` | 固定 `gerber`（report/summary 用它作为规则状态键） |
| `rule_id` | 上游 `GR-00x` 映射为 `GB-00x`；原始 ID 保留在 `source_rule_id`。其他稳定编号原样保留，无法识别的加 `GB-` 前缀 |
| `severity` | 保留上游 `error` / `warning` / `info`；报告层再映射到 must_fix / should_fix / nice_to_have |
| `title` / `summary` | 中文标题（由 `summary` 翻译） |
| `evidence` / `description` | 中文证据（由 `description` 翻译） |
| `recommendation` | 中文建议 |
| `kind` | `issue` |
| `source` | `gerber` |
| `source_text` | 被翻译字段的英文原文，便于与 kicad-happy 对照 |
| 其他 | `category`、`confidence`、`evidence_source`、`components`、`nets`、`pins`、`report_context`、`finding_id` 按上游保留（字段值不翻译） |

规则 ID 映射逻辑：`GR-001..GR-005` 统一转成 `GB-001..GB-005`，
原始 ID 写入 `source_rule_id`（例如 `source_rule_id: "GR-003"`）；
其他匹配 `^[A-Z]{2,4}-\d+$` 的稳定编号原样保留；无法识别的转成
`GB-<大写 slug>`。上游当前 5 条规则全部输出 `GB-00x`。

### 4.2 中文文案

翻译在本层完成，保持与 `scripts/localization.py` 相同的约定：

- 动态内容（层名、毫米数、焊盘数、比例）按原文回填；
- 英文原文写入 `source_text`；
- 未知英文模板显式写成 `（检测器原文）<英文>`，不静默透传；
- 已收录模板覆盖 `GR-001`～`GR-005` 的全部实际文案，包括：
  - `缺少层：F.Mask` / `Gerber 文件中未找到必需层 F.Mask。`
  - `层对齐问题：铜层与边框层的宽度相差 1.5mm`
  - `Gerber 文件集中没有钻孔文件` / `未找到 Excellon 钻孔文件；PCB 制造需要钻孔数据。`
  - `F 面锡膏层：4 个焊盘开窗，铜层 10 个（40%）`
  - `板框可能未闭合：仅有 2 条绘制线段`

### 4.3 coverage 与状态

`coverage` 固定包含：

`status, directory, gerberFiles, drillFiles, unsupportedDrillFiles,
layerCount, drillCount, units, missingLayers, missingRequired,
missingRecommended, boardDimensions, checks, reasons, findings`

子检查状态：

| checks 键 | 判定 |
| --- | --- |
| `layer_completeness` | 无 Gerber 文件 → not_evaluated；缺必需层 → found；否则 pass |
| `drill_data` | 无可解析钻孔 → not_evaluated；有钻孔但 0 孔 → found；否则 pass |
| `alignment` | 无 Gerber 文件 → not_evaluated；`aligned=false` → found；否则 pass |
| `board_dimensions` | 没有任何有效坐标 → not_evaluated；否则 pass |

整体状态：

- 全部子检查 not_evaluated → `not_evaluated`；
- 任一子检查 not_evaluated、存在文件解析错误，或检测到无法解析的
  `.xln`/`.nc` → `partial`（即使同时存在可解析的 `.drl`，也不给 `pass`）；
- 全部已评估且有 finding → `found`；
- 全部已评估且无 finding → `pass`；
- 上游脚本缺失、Python 启动失败、超时或 JSON 非法 → `failed`，并生成
  `GB-ERR`（severity error）中文 finding。

「缺目录/空目录」与「缺钻孔」都不会得到 `pass`：前者所有检查
`not_evaluated`，后者 `drill_data=not_evaluated` 且整体 `partial`。

### 4.4 与既有流程的合并

- `ALL_RULES` 增加 `gerber`，报告规则表与 `summary.rules` 始终有该键；
- Gerber findings 追加到 `findings.json` 与 `summary.json` 的 top findings；
- `summary.coverage.gerber` 写入完整 coverage；
- `manifest.stages.gerber` 直接反映 coverage 状态：`pass` / `found` /
  `partial` / `not_evaluated` / `failed`，自动跳过时为 `skipped`；
  `manifest.gerber` 记录 `requested`、`autoDetected`、`directory`、
  `status`、`findings`；
- 显式 `--gerber` 指向不存在/非目录 → 退出码 2；
- 显式 `--gerber` 但拿到 not_evaluated（例如空目录）→ 本次运行 partial、
  退出码 3；
- 自动发现不到目录 → 只写 `manifest.warnings`，规则标 not_evaluated，
  不改变退出码（工程可能尚未导出 Gerber）。

## 5. 报告改动

`scripts/report.mjs` 与 `templates/report.html`：

- 新增 `<section id="manufacturing">`「制造文件」，位于「板卡与文档」之后；
- 展示状态、分析目录、Gerber 文件数、钻孔文件数、铜层数量、钻孔数量、
  单位（`mm` → 毫米（mm），`inch` → 英寸（inch））、板框尺寸；
- 缺失层以列表展示，区分「必需」与「建议」；
- 制造检查项表：层完整性、钻孔数据、层对齐、板框尺寸；
- 未评估原因逐条列出；
- Gerber findings 在该节汇总展示；
- 来源固定标注「Gerber 分析」；主问题清单中的 Gerber finding 也带
  `source-tag` 标注；
- `RULE_LABELS` 增加 `gerber: 制造文件（Gerber/钻孔）检查`。

所有用户可见文本为简体中文；层名（`F.Mask`、`Edge.Cuts`）、规则 ID、
字段名与目录路径按标识符保留。

## 6. 测试与结果

新增 `tests/gerber.test.mjs`（18 项，含评审修复后的新增用例）：

1. 完整夹具返回 pass coverage（2 层、1 个钻孔文件、5 孔、30×20mm、mm）；
2. 缺失目录返回 not_evaluated，四个子检查全部 not_evaluated；
3. 空目录返回 not_evaluated 并说明原因；
4. 有 Gerber 无钻孔 → partial、`drill_data=not_evaluated`、中文 `GB-003`；
5. `.xln` 与有效 `.drl` 并存 → partial（不是 pass）；
6. 上游脚本缺失 → failed、`GB-ERR`（severity error）；
7. `GR-001`/`GR-002`/`GR-004`/`GR-005` 映射为 `GB-00x` 并逐字段断言中文文案；
8. 非稳定规则 ID 自动加 `GB-` 前缀，未知英文模板标注「（检测器原文）」；
9. `detectGerberDirectory` 优先选择含内容的候选目录；
10. 报告「制造文件」章节含层数、钻孔数、缺失层、单位与来源；
11. 主问题清单为 Gerber finding 标注「Gerber 分析」；
12. 端到端 `--gerber`：退出码 0、`summary.rules.gerber=pass`、报告含章节；
13. 端到端自动发现工程下的 `Gerber/` 目录；
14. 无 Gerber 目录时规则 not_evaluated、manifest 有 warning、报告仍解释原因；
15. 端到端缺钻孔：summary/报告中为 `GB-00x`，`manifest.stages.gerber=partial`；
16. 端到端 `.xln` 并存：`summary.rules.gerber=partial`；
17. 端到端显式空目录：退出码 3，所有制造检查未评估；
18. 显式 `--gerber` 指向缺失目录时退出码 2。

新增夹具 `tests/fixtures/gerber-basic/`：9 个文本 Gerber（GTL/GBL/GTS/GBS/
GTO/GBO/GTP/GBP/GM1）+ 1 个 Excellon `.TXT`，合计约 1.5KB，不包含大型
二进制导出。

执行结果：

```text
$ node --test tests/*.test.mjs
ℹ tests 86
ℹ pass 86
ℹ fail 0

$ python -B -m pytest -q
71 passed, 1 warning in 0.64s
```

pytest 的 warning 来自第三方 anyio 插件的弃用提示，与本改动无关；所有既有
测试保持通过。

## 7. 样例报告

重新生成命令：

```text
node .agents/skills/ad-happy/scripts/analyze.mjs \
  --project tests/fixtures/Student-DCDC-Buck-Converter \
  --gerber tests/fixtures/gerber-basic \
  --out docs/sample-report
```

结果：

- 路径：`docs/sample-report/report.html`；
- 状态：complete，退出码 0；
- `summary.rules.gerber = pass`；
- `summary.coverage.gerber`：2 层、9 个 Gerber 文件、1 个钻孔文件、5 个孔、
  单位 mm、板框 30×20mm、无缺失层；
- `manifest.stages.gerber = pass`，`manifest.gerber.requested = true`；
- 新增 `docs/sample-report/gerber.json`（上游原始输出，约 12KB）与上游
  生成的 `capability_mode.json`（约 257B）；
- 报告「制造文件」章节显示来源「Gerber 分析」与「通过」状态。

## 8. 未评估项与原因

- 样例工程当前未提供 Gerber 目录时（不传 `--gerber` 且工程下无候选目录）：
  `gerber` 规则为 `not_evaluated`，`manifest.warnings` 说明未找到
  `Gerber`、`Outputs`、`Project Outputs`、`Manufacturing`，报告「制造文件」
  章节列出原因。不得视为通过。
- 钻孔文件缺失：`drill_data` 为 `not_evaluated`，整体 `partial`，并保留
  上游 `GR-003` finding；
- 检测到 `.xln`/`.nc`：明确写入未纳入评估的原因，因为上游只解析 `.drl`
  与 Excellon `.txt`；
- 已生成的样例报告没有 Gerber 相关未评估项（夹具完整）。

## 9. 约束确认

- kicad-happy 目录未修改；
- 既有规则逻辑、阈值与 finding 文案未改动；
- 未提交 `node_modules`、临时输出或大型二进制导出；
- 新增夹具为纯文本，总计约 1.5KB；
- 所有面向用户的文本为简体中文。

## 10. 评审修复（2026-11-25）

### 10.1 Important 1：`GB-` 前缀落实到输出

- `normalizeRuleId()` 现在把上游 `GR-001..GR-005` 映射为
  `GB-001..GB-005`；上游原始 ID 存入 finding 的
  `source_rule_id` 字段（例如 `source_rule_id: "GR-003"`），便于追溯。
- 中文文案模板仍按上游原始 ID（`GR-00x`）匹配，输出规则 ID 使用 `GB-`，
  两者解耦，翻译不会因 ID 映射而失效。
- 测试更新：归一化用例全部断言 `GB-00x` + `source_rule_id`；
  端到端缺钻孔用例断言 `summary.findings`、`findings.json` 与
  `report.html` 均显示 `GB-003`，报告不再出现 `GR-003`。

### 10.2 Important 2：无法解析的 `.xln`/`.nc` 不再给 pass

- `buildCoverage()` 的状态聚合新增条件：`unsupportedDrillFiles > 0`
  时整体至少为 `partial`，即使同时存在可解析的 `.drl`/Excellon `.txt`。
- `coverage.reasons` 继续说明这些文件未被上游解析。
- 新增测试：
  - wrapper：完整夹具 + `board-extra.xln` → `coverage.status = partial`，
    `drillFiles = 1`、`unsupportedDrillFiles = 1`；
  - 端到端：同一场景 → `summary.rules.gerber = partial`，
    `manifest.stages.gerber = partial`，退出码 3。

### 10.3 相关 Minor

- 报告「制造文件」在 `not_evaluated` / `failed` 时不再输出
  「没有缺失层。」「未发现制造文件问题。」，改为：
  - `未评估，无法判断是否缺失层。`
  - `未评估，未生成制造文件问题结论。`
  - 失败时对应改为「分析失败，无法判断是否缺失层。」与
    「分析失败，无法生成制造文件问题结论。」
- `manifest.stages.gerber` 直接镜像 coverage 状态：
  `pass` / `found` / `partial` / `not_evaluated` / `failed`，
  自动跳过时为 `skipped`；外部只读 stage 也不会把 partial/found
  误读为完全通过。

### 10.4 新增测试与执行结果

`tests/gerber.test.mjs` 由 13 项增加到 18 项，新增：

- `.xln` 与 `.drl` 并存 → wrapper `partial`；
- 上游脚本缺失 → `failed` + `GB-ERR`；
- 端到端缺钻孔 → `GB-` 前缀进入 summary/report，stage `partial`；
- 端到端 `.xln` 并存 → `summary.rules.gerber=partial`；
- 端到端显式空目录 → 退出码 3、所有制造检查未评估，报告使用
  「未评估，无法判断…」文案。

执行结果：

```text
$ node --test tests/*.test.mjs
ℹ tests 86
ℹ pass 86
ℹ fail 0

$ python -B -m pytest -q
71 passed, 1 warning in 0.64s
```

### 10.5 样例报告重新生成

```text
node .agents/skills/ad-happy/scripts/analyze.mjs \
  --project tests/fixtures/Student-DCDC-Buck-Converter \
  --gerber tests/fixtures/gerber-basic \
  --out docs/sample-report
```

结果：退出码 0、`summary.rules.gerber=pass`、`manifest.stages.gerber=pass`，
报告「制造文件」章节正常；样例夹具没有触发 finding，因此样例中不出现
`GB-` 规则 ID，`GB-` 前缀由上述端到端缺钻孔/`.xln` 用例覆盖。

### 10.6 记入 debt、本轮不修

- `pipeline-summary.json` 目前仍只包含 Python 规则层 findings，与合并后的
  `findings.json` 条数不再一致；该文件仅作中间产物，本轮不改其契约。
- 尚未用真实 Altium OutJob 导出目录做验收，当前夹具为手工构造的文本
  Gerber/Excellon。
- 上游的 zip 输入（`zip_archives`）未接入 AD-Happy。
