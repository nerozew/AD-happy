# P2 · BOM 检查与采购清单交付报告

版本 v1.0 · 2026-11-25 · 状态：已实现

## 1. 结论

P2 已完成：新增 `scripts/bom.mjs`，从已解析的工程数据构建 BOM，执行 4 项 `BM-` 检查，生成 `bom.csv` / `procurement.csv`，支持 `--bom` 导入 Altium BOM CSV 做差异比对，并把结果合并进 `findings.json`、`summary.json` 与中文报告「物料」章节。

- Node 测试：`node --test tests/*.test.mjs` → **107 通过 / 0 失败**（其中新增 21 条 BOM 测试）。
- Python 测试：`python -B -m pytest -q` → **71 通过**。
- 样例报告已重新生成：`docs/sample-report/`；`summary.rules.bom = found`，报告含「物料」章节、`BM-001` 与 `procurement.csv` 路径。
- 未修改 kicad-happy；未改变既有规则逻辑与阈值；无网络调用；未编造分销渠道。

## 2. 实测的数据来源

设计前先检查了 altiumts 0.0.95 在样板工程（`tests/fixtures/Student-DCDC-Buck-Converter`）上实际提供的字段，而不是按假设设计映射。

### 2.1 原理图（SchDoc）

`sch.mjs` 原本只输出 `reference`、`comment`、`footprint`、`pins`。实测二进制 SchDoc 的元件下挂着 `RECORD=41` 参数记录，样板中有：

| 参数名 | 出现次数 | 示例 |
|---|---:|---|
| `Part Number` | 8 | `CL21A226KOQNNNG`、`7-2176093-1`、`282834-2` |
| `Supplier Part Number 1` | 8 | `1276-7092-1-ND` |
| `Manufacturer` | 8 | `Samsung Electro-Mechanics`、`Yageo` |
| `Comment` | 9 | `TPS561208DDCR`、`=Value`、`=Part Number` |
| `Value` | 6 | `22µF`、`10 kOhms` |
| 其余（Capacitance、Tolerance、Package / Case 等） | 若干 | — |

因此 `sch.mjs` 的元件对象新增 `parameters`（`Record<string, string>`，即元件直属参数的原样映射，同名参数保留第一条），并自动进入 `snapshot.json` 与 `raw.json`。BOM 层从这些参数中读取型号，不在解析层猜测。

**关键实测结论：样板并非“完全没有 MPN”。** 8 个元件带 `Part Number`；只有 `IC1` 没有该参数，`Comment` 仅为 `TPS561208DDCR`。本实现不把 `Comment` 冒充 MPN，因此 `IC1` 产生 `BM-001`。这满足“至少一条 MPN 缺口”的验收，同时如实反映工程数据，而不是假设全部缺失。

### 2.2 PCB（PcbDoc）

`pcb.mjs` 原本只输出 `reference`、`footprint`、位置/角度/层。实测样板 PcbDoc 的元件记录：

- `DESIGNATOR`（位号）：存在；
- `PATTERN`（封装）：存在；
- `COMMENT` / `SOURCECOMMENT`：样板中为空；
- `SOURCEDESCRIPTION`：有描述文本（如 `CAP CER 22UF 16V X5R 0805`）；
- `SOURCELIBREFERENCE`：有库引用（样板中多数等于型号），但库引用不保证是 MPN，**不作为 MPN 使用**；
- 没有显式的 `MPN` / `Manufacturer Part Number` 字段。

因此 `pcb.mjs` 的元件对象新增：

- `value`：`COMMENT`（样板为空，BOM 行会回退到原理图值）；
- `mpn`：仅当元件记录显式带型号字段（`MPN`、`Manufacturer Part Number`、`Part Number` 等）时取值，样板为空串；
- `description`：`SOURCEDESCRIPTION`。

这满足 `buildBom(snapshot, pcb)` 对 PCB 侧 `reference` / `value` / `footprint` / `mpn` 的输入约定，同时不虚构型号。

## 3. BOM 数据模型

`buildBom(snapshot, pcb)` 返回 `{ rows, coverage, findings }`（任务约定 `{ rows, coverage }`，`findings` 为额外返回，供 CLI 直接合并）。一个位号一行：

```json
{
  "reference": "C2",
  "value": "22µF",
  "footprint": "CAP 0805_2012",
  "mpn": "CL21A226KOQNNNG",
  "quantity": 1,
  "source": "both",
  "extraParameters": {
    "manufacturer": "Samsung Electro-Mechanics",
    "supplier": "DigiKey",
    "supplierPartNumber": "1276-7092-1-ND",
    "package": "0805 (2012 Metric)",
    "status": "Active",
    "description": "CAP CER 22UF 16V X5R 0805"
  }
}
```

- `source`：`schematic` / `pcb` / `both`。
- `quantity`：该位号在原理图/PCB 中出现次数的较大值（正常为 1；重复位号会大于 1，用于提示合并）。
- `extraParameters`：只携带采购/核对有用的字段（制造商、供应商、供应商料号、描述、封装、生命周期状态），避免把 Altium 内部字段全部塞进产物。原始参数仍完整保留在 `snapshot.schematic.components[].parameters`。
- 合并优先级：原理图值/封装/MPN 优先，缺失时回退到 PCB 同名字段。
- 没有位号的元件不进入 `rows`，在 `coverage.componentsWithoutReference` 与 `coverage.reasons` 中说明。

### 3.1 coverage

```json
{
  "status": "found",
  "rows": 9,
  "components": 9,
  "schematicComponents": 9,
  "pcbComponents": 9,
  "componentsWithoutReference": 0,
  "rowsWithMpn": 8,
  "rowsMissingMpn": 1,
  "rowsWithFootprint": 9,
  "rowsMissingFootprint": 0,
  "duplicateDesignators": [],
  "schematicOnly": [],
  "pcbOnly": [],
  "checks": {
    "missing_mpn": "found",
    "missing_footprint": "pass",
    "duplicate_designator": "pass",
    "schematic_pcb_match": "pass"
  },
  "reasons": [],
  "findings": 1,
  "imported": null
}
```

带 `--bom` 时追加 `checks.imported_diff` 与 `imported`（导入路径、行数、表头映射、缺失/多余位号、导入文件缺列）。

## 4. 检查语义

所有 finding 字段：`detector: 'bom'`、`source: 'bom'`、`kind: 'issue'`、中文标题/证据/建议、`confidence: 'deterministic'`。

| 规则 | 触发条件 | 严重度 | 说明 |
|---|---|---|---|
| `BM-001` | 存在可用 MPN 数据源，但某些行没有 MPN | warning | 聚合为一条 finding，`components` 列出缺型号位号（上限 50 个，证据列出前 40 个）。样例中只有 `IC1`。 |
| `BM-002` | 行没有解析到封装 | error | 聚合为一条 finding。封装优先取原理图，缺失时回退 PCB。 |
| `BM-003` | 同一位号在原理图或 PCB 中出现多次，或导入 BOM 内位号重复 | error | 每个重复位号一条；合并行 `quantity` 为出现次数。 |
| `BM-004` | 位号只在原理图、或只在 PCB | error | 每个不一致位号一条，标题区分方向。仅在两侧都解析到元件时评估。 |
| `BM-005` | 导入 BOM 与工程元件不一致（缺件/多件） | warning | 每条方向一条，`components` 列出差异位号。 |
| `BM-ERR` | BOM 构建/导入/写文件失败 | error | 导入 CSV 无 `Designator`/`位号` 列、文件为空等。 |

### 4.1 状态聚合

`recomputeBomStatus`：

1. 任一项为 `failed` → `failed`；
2. 没有 BOM 行 → `not_evaluated`；
3. 所有检查都 `not_evaluated` → `not_evaluated`；
4. 任一项 `not_evaluated`，或存在无位号元件 → `partial`；
5. 任一项 `found` → `found`；
6. 否则 `pass`。

`rules.bom` 使用同一状态。`found` 不会让整体运行退出码变为 3；`failed` / `partial` 按既有逻辑处理。显式 `--bom` 但工程没有可核对元件时，加入 `missingInputs`，退出码 3。

## 5. CSV 导入映射

`importBomCsv(text)`：

- 去掉 UTF-8 BOM；自动识别 `,` / `;` / Tab 分隔符（扫描前 30 行中含 `designator` / `位号` 的表头行）。
- 表头大小写不敏感；归一化时去掉空格、下划线、点、斜杠与中英文括号。
- 在前 30 行内查找表头行，允许 Altium 导出文件带标题行。
- 位号单元格可包含多个位号（逗号、分号、中文标点、空白分隔），逐位号展开。
- 缺少 `Quantity` 时默认 1；数值中的非数字字符会被忽略。
- `Supplier Part Number`/`Supplier Part Number 1` 映射为 `supplierPartNumber`；若没有独立 MPN 列，作为 `mpn` 的回退。该值仍单独保留，文档与报告中说明其来源，不冒充制造商型号。

| 内部字段 | 支持的英文表头（大小写不敏感） | 中文表头 |
|---|---|---|
| `designator` | Designator(s)、Ref(s)、Reference(s) | 位号、元件位号、位号列表 |
| `value` | Comment(s)、Value | 注释、值、元件值、规格 |
| `footprint` | Footprint(s)、Package | 封装、封装形式 |
| `quantity` | Quantity、Qty、Count | 数量 |
| `description` | Description、Desc | 描述、说明 |
| `mpn` | MPN、Manufacturer Part Number、Mfr Part Number、Part Number | 型号、型号(MPN)、制造商料号、物料编号 |
| `supplierPartNumber` | Supplier Part Number、Supplier Part Number 1、Supplier Part No、Supplier PN | 供应商料号、供应商编号 |

差异比对按位号归一化（去空格、转大写）比较；SQL 式列缺失不会中止：`coverage.missingColumns` 会列出缺失列，缺失值按空处理。

## 6. 产物

### 6.1 `bom.csv`

中文表头：`位号,数量,值,封装,型号(MPN),来源,制造商,供应商,供应商料号,描述`。

- `来源`：`原理图` / `PCB` / `双方`。
- 含逗号/引号/换行的字段按 RFC 4180 加引号转义。
- 按位号自然排序（`R2` 在 `R10` 前）。

### 6.2 `procurement.csv`

固定列：`位号,数量,型号(MPN),封装,值,建议渠道`。

- 每行一个位号，按自然顺序。
- `建议渠道` 一律留空；不联网、不推测分销商库存或可采购性。
- 缺 MPN 的元件该列留空，并在 `BM-001` 与报告「物料」章节标出。

## 7. CLI 集成

`analyze.mjs` 新增：

- `--bom <CSV>`：导入 BOM；路径必须存在且为文件，否则退出码 2。格式错误时 `rules.bom = failed`、产出 `BM-ERR`、退出码 3，但其余分析与报告照常产出。
- 未指定 `--bom` 时在运行目录生成 `bom.csv` 与 `procurement.csv`。
- `--bom` 模式仍基于工程解析结果生成采购清单，导入文件只用于差异比对。
- `findings.json` 合并 Python 规则、DET-ERR、Gerber 与 BOM findings。
- `summary.json` 新增：
  - `rules.bom`；
  - `bom`（状态、元件数、缺 MPN/封装数、重复位号数、两侧不一致数、两个 CSV 路径、导入差异计数）；
  - `coverage.bom`（完整 coverage，含逐项检查状态与原因）。
- `manifest.json` 新增 `stages.bom` 与 `bom`（请求路径、状态、findings 数、行数、缺 MPN/封装、重复/不一致数、产物名）。
- 旧产物清理列表加入 `bom.csv` / `procurement.csv`。
- 终端摘要新增一行物料统计。

## 8. 报告

`templates/report.html` 无需新增 CSS；`report.mjs` 新增 `renderBom`，位于「板卡与文档」与「制造文件」之间：

- 标题「物料」；
- 元件数、缺少 MPN、缺少封装、重复位号、原理图与 PCB 不一致；导入模式追加「导入 BOM 差异」；
- 未评估原因列表（`id="bom-reasons"`）；
- 重复位号与两侧不一致位号列表；
- 导入 BOM 比对（工程有/BOM 没有、BOM 有/工程没有、缺失列）；
- 产物路径表（`id="bom-paths"`）：BOM 文件、采购清单；
- `not_evaluated` 时显式写「本次未评估物料检查」并给出原因，绝不显示「未发现物料问题」；
- 所有可见文本为中文；路径、位号、型号等数据转义输出。

## 9. 测试与输出

新增 `tests/bom.test.mjs`（21 条）：

- 样板工程 9 行、8 行有 MPN、`IC1` 产生 `BM-001`、状态 `found`；
- 合成缺 MPN 夹具产生 `BM-001` + `found`，断言不是 `pass`；
- 完全没有 MPN 数据 → `checks.missing_mpn = not_evaluated`，不产生 `BM-001`，整体 `partial`；
- 空工程 / 无元件 → `not_evaluated`，所有检查未评估；
- 重复位号 `BM-003` 与数量合并；
- 原理图↔PCB 双向不一致 `BM-004`；
- 缺封装 `BM-002`；
- `exportProcurement` 固定中文列、建议渠道为空、无分销商编造；
- `exportBom` 附加参数与逗号转义；
- CSV 导入：英文表头大小写不敏感、`Supplier Part Number` 回退、多位号单元格；中文表头（含 BOM 前缀）；分号分隔；无 Designator 列报错；
- `diffBom` 缺件/多件、工程为空 `not_evaluated`；
- 报告「物料」章节与 `not_evaluated` 文案；
- 端到端：生成两个 CSV、`summary.rules.bom = found`、`BM-001`、manifest/snapshot 新字段、报告含「物料」；
- 端到端 `--bom`：中文表头 BOM 回读无差异；删除 `IC1` 行后产生 `BM-005`；
- 端到端 `--bom` 指向同一输出目录上一次生成的 `bom.csv` 时不会被产物清理误删；
- 端到端 `--bom` 格式无效 → `rules.bom = failed` + `BM-ERR`；
- 端到端 `--bom` 文件不存在 → 退出码 2；
- 端到端无元件工程 → `rules.bom = not_evaluated`，报告不写通过。

命令与结果：

```text
node --test tests/*.test.mjs   → 107 passed, 0 failed
python -B -m pytest -q         → 71 passed
```

## 10. 重新生成的样例

命令：

```bash
node .agents/skills/ad-happy/scripts/analyze.mjs \
  --project tests/fixtures/Student-DCDC-Buck-Converter \
  --gerber tests/fixtures/gerber-basic \
  --out docs/sample-report
```

结果：

- `docs/sample-report/report.html`：含「物料」章节与 `BM-001`（`IC1` 缺 MPN）；
- `docs/sample-report/summary.json`：`rules.bom = found`，`bom.components = 9`，`bom.rowsWithMpn = 8`，`bom.rowsMissingMpn = 1`；
- 新增 `docs/sample-report/bom.csv`（9 行）与 `docs/sample-report/procurement.csv`（9 行，建议渠道为空）；
- `manifest.stages.bom = found`，`manifest.bom.artifacts` 指向两个 CSV；
- 报告整体仍为「完成」，退出码 0（`found` 只表示发现问题，不等于运行失败）。

## 11. 仍为 not_evaluated 的情况与原因

以下情况不会给出「通过」，而是显式 `not_evaluated` / `partial`：

1. **工程没有任何带位号的元件**：四项检查全部 `not_evaluated`，`reasons` 写「没有可检查的元件」。样例空工程已验证。
2. **工程完全没有 MPN 参数**：`checks.missing_mpn = not_evaluated`，不产生 `BM-001`；其余检查正常评估，整体为 `partial`。原因：无法区分“元件本来不需要型号”与“型号数据未填写”。
3. **只解析到一侧（原理图或 PCB）**：`checks.schematic_pcb_match = not_evaluated`，整体 `partial`。不会把“另一侧为空”当成全部不一致。
4. **PCB-only 工程**：PcbDoc 通常没有显式 MPN 字段，`missing_mpn` 为 `not_evaluated`；封装、重复位号仍可检查。
5. **`--bom` 但工程没有可核对元件**：`imported_diff = not_evaluated`，并加入 `missingInputs`，退出码 3。
6. **导入 BOM 缺列**：`coverage.imported.missingColumns` 说明缺失列；相关字段按空处理，但检查本身仍执行。

## 12. 未做 / 边界

- 不联网查询 DigiKey/Mouser/立创等库存与价格；`建议渠道` 始终留空。
- 不把 `Comment`、`SOURCELIBREFERENCE` 或供应商料号自动当成制造商 MPN；`Supplier Part Number` 仅在导入 BOM 缺 MPN 列时作为回退，并在文档中说明。
- 不检查“数量为 0”（本阶段验收未要求；导入数量仅保留字段，不参与判定）。
- 不比较导入 BOM 的字段值差异（值/封装/MPN 文本），只做位号级别的缺件/多件与重复检查，避免 AD BOM 模板表达式造成误报。
- 层次原理图、多板卡与装配变体仍沿用既有边界：只解析第一份 SchDoc 与选中的 PcbDoc。

## 13. 涉及文件

- 新增：`.agents/skills/ad-happy/scripts/bom.mjs`、`tests/bom.test.mjs`、`docs/p2-bom-report.md`
- 修改：`.agents/skills/ad-happy/scripts/analyze.mjs`、`sch.mjs`、`pcb.mjs`、`report.mjs`、`SKILL.md`、`README.md`
- 重新生成：`docs/sample-report/*`（含新增 `bom.csv`、`procurement.csv`）
