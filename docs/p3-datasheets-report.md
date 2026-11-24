# AD-Happy Phase 3：数据手册覆盖检查与提取计划编排报告

- 分支：`feature/ad-happy`
- 实现范围：数据手册目录扫描、MPN 匹配、上游提取计划调用、报告章节与测试
- 不包含：PDF 引脚表解析、引脚级核对、PDF 下载

## 1. 范围裁定（controller 决定，已落实）

kicad-happy 的 `datasheets` skill 是 AI 驱动的流程，不是单个确定性 CLI：

1. `plan_extraction.py` 只负责生成提取计划；阅读 PDF、提取引脚/电气特性由 AI scout 与各任务子代理完成。
2. `validate_extraction_result.py` 校验 AI 产出的单任务结果，本身也不读 PDF。
3. 因此确定性 CLI 无法独立完成引脚表提取。

本 Phase 只做三件事：

1. **PDF 覆盖检查**：扫描数据手册目录，按 MPN 把 PDF 匹配到 BOM 元件，报告哪些元件有/没有数据手册。
2. **提取计划编排**：对匹配到 PDF 的型号调用上游 `plan_extraction.py`，产出 `<MPN>.plan.json`，供 harness 的 AI 继续执行 scout → 提取 → 校验。
3. **只交叉核对确定性信息**：PDF 文件存在性、文件名/manifest 的 MPN、上游计划是否生成。**没有**用正则解析 PDF 引脚表，也没有把覆盖率当作引脚验证。

## 2. 上游接口检查结果（只读，未修改 kicad-happy）

检查目录：`D:/Tools/kicad-happy/skills/datasheets/`

### 2.1 `scripts/plan_extraction.py`

实际参数（以代码为准）：

```text
python plan_extraction.py <mpn> <pdf_path> --cache-dir <dir> [--use-cached-scout] [--force]
```

- 脚本仅使用 Python 标准库（`hashlib` / `json` / `pathlib` 等），无需额外依赖，已实测可运行。
- **`--use-cached-scout` 实际上是必需参数**：不传时脚本直接以退出码 2 报错「live scout dispatch is not implemented」；controller 给出的接口摘要未包含该参数，本次按实际接口接入。
- scout 输入固定为 `<cache-dir>/<MPN>.scout.json`。没有该文件时脚本退出码 2，提示先运行 scout 子代理。
- 输出 `<cache-dir>/<MPN>.plan.json`；scout `quality_verdict.verdict = "skip"` 时写入空计划并以退出码 1 退出。
- 若 `<cache-dir>/<MPN>.json` 已存在且其 `source.sha256` 与当前 PDF 一致，脚本打印「already up-to-date」并以 0 退出，**不重写 plan**。本封装对这种情况返回 `status: "up-to-date"`。
- 退出码约定（来自代码）：`0` 成功/已是最新；`1` scout 判定跳过；`2` 输入/流程错误。

### 2.2 `scripts/validate_extraction_result.py`

实际参数：

```text
python validate_extraction_result.py --result-file <wrapper.json> --task-type <task> [--json]
```

- 校验 `{task_id, status, data, ...}` 包装结果，`status` 必须为 `complete`，`data` 必须匹配 `schemas/<task>.schema.json`。
- 依赖 `jsonschema` 与 `referencing` 第三方包。
- 本 Phase **没有接入**该脚本：它校验的是 AI 提取后的结果，属于后续 AI 提取流程；当前确定性 CLI 不生产该结果，接入会制造「已校验」的错觉。

### 2.3 缓存与 schema

- 上游缓存布局：`<project>/datasheets/<file>.pdf`（输入）+ `<project>/datasheets/extracted/<MPN>.json`、`<MPN>.plan.json`、`<MPN>.scout.json`。AD-Happy 不写源工程，plan/scout 缓存放在 `<--out>/datasheets/`（见第 9 节）。
- `schemas/plan.schema.json`：`plan_version`、`mpn`、`pdf_path`、`pdf_sha256`、`cache_dir`、`scout_ref`、`tasks`、`execution`。
- `schemas/scout.schema.json`：`mpn`、`metadata`、`categories`、`extraction_pages`（至少 `base`、`pinout`）、`quality_verdict`。
- MPN 文件名清洗规则：`datasheet_lookup.py` 保留 `[A-Za-z0-9_.-]`（含点号），其余替换为 `_`；`plan_extraction.py` 则直接使用**原始 MPN** 写 `<MPN>.scout.json` / `<MPN>.plan.json`。本模块的 `sanitizeMpn` 与 lookup 规则一致，计划路径以原始 MPN 为准并拒绝含路径分隔符/非法文件名字符的 MPN。

## 3. 实现

### 3.1 `scripts/datasheets.mjs`

导出：

```js
scanDatasheets(dir) -> {
  directory, exists,
  pdfs: [{ path, fileName, relativePath, inferredMpn, manifestMpns, mpns, sizeBytes }],
  coverage: { status, directory, exists, manifestPresent, manifestInvalid, pdfCount, reasons }
}

matchToComponents(pdfs, bomRows) -> {
  matched: [{ reference, mpn, isIc, pdfPath, pdfFileName, pdfInferredMpn, ... }],
  unmatchedPdfs: [...],
  componentsWithoutPdf: [{ reference, mpn, isIc, reason: 'no_mpn'|'no_pdf', reasonText }],
  coverage: { components, componentsWithMpn, componentsWithPdf, icComponents, icsWithoutPdf, ... }
}

planExtraction(mpn, pdfPath, cacheDir, options?) -> {
  planPath, expectedPlanPath, ok, status, error, exitCode, taskCount, scoutPath
}

evaluateDatasheets({ directory, bomRows, cacheDir?, planOptions? }) -> {
  directory, pdfs, matched, unmatchedPdfs, componentsWithoutPdf, plans, coverage, findings
}

summarizeComponents(bomRows) -> { components, componentsWithMpn, icComponents }
recomputeDatasheetsStatus(coverage) -> 'pass'|'found'|'partial'|'not_evaluated'|'failed'
emptyDatasheetsCoverage(options?) -> coverage
datasheetErrorFinding(message) -> finding
```

实现细节：

- **扫描**：递归最多 4 层，跳过隐藏目录、`node_modules`、`.git`、`extracted`；扩展名大小写不敏感。
- **MPN 来源**：优先读取 `datasheets/manifest.json` 的 `pdfs[*].{path,mpns}`（支持带 `datasheets/` 前缀的路径，按相对路径/文件名匹配）；没有登记时用文件名去掉 `.pdf` 推断。`mpns` 按大小写不敏感去重。
- **匹配归一化**：MPN 转大写并去掉非字母数字字符，因此 `LM2596-ADJ` 与 `lm2596adj` 可匹配；同一 MPN 多份 PDF 时取扫描顺序第一份，但所有候选都视为已使用，不误报 `DS-002`。
- **IC 识别**：位号匹配 `^(U|IC)\d`（大小写不敏感）。只有 IC 缺 PDF 才产生 `DS-001`，避免要求每个电阻/电容都有数据手册。
- **计划调用**：
  - 先按 PDF SHA 判断已有 plan 是否仍有效；有效则直接复用（`status: "existing"`），不启动 Python。
  - 没有 `<MPN>.scout.json` 时**不启动 Python**，返回 `status: "not_evaluated"`，明确说明需要 AI scout；不伪造 scout、不伪造计划。
  - 有 scout 时执行 `python -B -X utf8 plan_extraction.py ... --cache-dir ... --use-cached-scout`，超时 60 秒。
  - `--force` 通过 `options.force` 透传（CLI 当前不暴露）。
  - 所有错误信息为中文摘要，必要时附带上游 stderr 诊断文本。

### 3.2 CLI（`scripts/analyze.mjs`）

新增参数：

```text
--datasheets <数据手册目录>
```

行为：

- 显式提供的目录必须存在且是目录，否则退出码 2，stderr 说明「数据手册目录不存在或不可访问」。
- 省略时自动查找 `<projectDir>/datasheets`；找不到时不报错，`rules.datasheets = not_evaluated`，并在 `manifest.warnings` 与报告中说明原因。
- 新增阶段 `stages.datasheets`；新增产物 `datasheets.json`（仅在找到目录时生成），包含 PDF 扫描、匹配、未匹配 PDF、缺手册元件、逐 MPN 计划状态。
- `findings.json` 合并 `DS-001` / `DS-002` / `DS-003` / `DS-ERR`，`source` 与 `detector` 均为 `datasheets`。
- `summary.json` 新增 `datasheets` 概览与 `coverage.datasheets`；`rules.datasheets` 存在。
- **退出码**：数据手册的 `found` / `partial` / `not_evaluated` 不参与整体 `partial` 聚合；只有目录扫描/IO 异常导致的 `failed`（`DS-ERR`）会把整体降级为退出码 3。提取计划未生成属于 `found` 缺口（`DS-003`），不改变退出码。这与 BOM 的裁定一致。
- 提取计划与 scout 缓存写在 `<--out>/datasheets/`，不写源工程。
- `manifest.datasheets.pinVerification` 固定为 `not_evaluated`。

### 3.3 报告（`scripts/report.mjs`）

新增「数据手册」章节（`id="datasheets"`），位于「物料」之后、「制造文件」之前，包含：

- 状态说明与未评估原因；
- 覆盖计数：PDF 数、元件数、有 MPN 数、匹配到 PDF 的元件数、缺 PDF 的元件数、IC 数、缺 PDF 的 IC 数、未匹配 PDF 数、提取计划状态；
- 检查项表：`coverage`、`pdf_match`、`extraction_plan`、`pin_verification`；
- 已匹配清单（位号/MPN/PDF/计划状态）；
- 缺数据手册的元件清单（标注 IC/非 IC 与原因）；
- 未匹配到元件的数据手册清单；
- 提取计划失败/未评估/跳过的原因；
- 未评估与限制说明。

该章节始终显示醒目提示：

> 引脚级核对：未评估。引脚定义必须由 AI 或人工依据数据手册 PDF 提取后核对；本次运行没有做引脚级验证，不能用数据手册覆盖率代替引脚核对结论。

未评估时不会显示「没有缺失数据手册的元件」这类可能被误读为通过的文案。

## 4. 检查语义（schema 与状态）

### 4.1 `datasheets.json`

```json
{
  "schemaVersion": 1,
  "generatedAt": "YYYY-MM-DD HH:mm:ss",
  "directory": "C:/project/datasheets",
  "coverage": {
    "status": "pass|found|partial|not_evaluated|failed",
    "directory": "...",
    "cacheDir": "C:/out/datasheets",
    "exists": true,
    "manifestPresent": false,
    "manifestInvalid": false,
    "pdfCount": 3,
    "components": 9,
    "componentsWithMpn": 8,
    "componentsWithPdf": 3,
    "componentsWithoutPdf": 6,
    "icComponents": 2,
    "icsWithoutPdf": 1,
    "matched": 3,
    "unmatchedPdfs": 0,
    "plans": 3,
    "planGenerated": 1,
    "planNotEvaluated": 2,
    "planSkipped": 0,
    "planFailed": 0,
    "checks": {
      "coverage": "found|pass|not_evaluated",
      "pdf_match": "found|pass|not_evaluated",
      "extraction_plan": "pass|partial|not_evaluated|found",
      "pin_verification": "not_evaluated"
    },
    "reasons": ["..."],
    "findings": 1
  },
  "pdfs": [],
  "matched": [],
  "unmatchedPdfs": [],
  "componentsWithoutPdf": [],
  "plans": []
}
```

`summary.json` 中的 `datasheets` 只保留计数、计划状态计数、20 条截断原因与 `pinVerification: "not_evaluated"`，不放大列表；`coverage.datasheets` 保留计数与截断原因。完整明细在 `datasheets.json` / `report.html`。

### 4.2 规则与 finding

| 规则 ID | 触发条件 | 严重度 | 说明 |
|---|---|---|---|
| `DS-001` | 识别为 IC（位号 `U*`/`IC*`）且没有匹配到 PDF | should_fix | 包含没有 MPN 的 IC；证据中单独说明数量 |
| `DS-002` | 目录中存在 PDF，但没有匹配到任何工程元件 | nice_to_have | 按文件名/登记的 MPN 判定 |
| `DS-003` | 匹配到 PDF，但上游 `plan_extraction.py` 执行失败 | should_fix | 目录扫描失败用 `DS-ERR` |
| `DS-ERR` | 目录扫描失败或阶段异常 | error | `category: analysis_error` |

总状态聚合（`recomputeDatasheetsStatus`）：

1. 任一 check 为 `failed`（本实现只会在目录扫描/IO 异常时出现）→ `failed`；
2. 没有元件 → `not_evaluated`；
3. 有 finding → `found`；
4. 任一 check 为 `partial` → `partial`；
5. 三个评估项（`coverage`/`pdf_match`/`extraction_plan`）全部 `not_evaluated` → `not_evaluated`；
6. `pin_verification` 不是 `pass`（本工具永远不会是）→ `partial`；
7. 否则 `pass`。

因此即使覆盖与计划都完成，规则状态也是 `partial`，不会把「没做引脚核对」说成通过。

### 4.3 未评估条件

- 工程目录没有 `datasheets/`，且未传 `--datasheets`：`not_evaluated`，不会产生 `DS-001`（未提供数据手册来源，不做覆盖率判断）。
- 目录存在但没有 PDF：`DS-001`（IC 仍缺手册），`pdf_match = not_evaluated`。
- 元件没有 MPN：无法按型号匹配，`reason = "no_mpn"`；若是 IC 则计入 `DS-001`。
- 有匹配但 `<--out>/datasheets/<MPN>.scout.json` 不存在：`extraction_plan = not_evaluated`，不调用 Python、不产生 `DS-003`。
- 上游 scout 判定 `skip`：计划为空，`status = "skipped"`，`extraction_plan = not_evaluated`，不产生 `DS-003`。

## 5. 测试与输出

新增 `tests/datasheets.test.mjs`（第二轮修复后共 18 个测试，新增项见第 9 节）：

- PDF 扫描：大小写扩展名、递归子目录、非 PDF 忽略、manifest 登记、无效 manifest 降级；
- MPN 匹配：归一化匹配、缺 MPN、缺 PDF、未匹配 PDF；
- 目录不存在 → `not_evaluated`；
- IC 缺 PDF → `DS-001`，`pin_verification = not_evaluated`，不是 `pass`；
- PDF 未匹配 → `DS-002`；非 IC 缺 PDF 不产生 `DS-001`；
- 缺 scout → `planExtraction` 返回 `not_evaluated` 且不启动 Python；
- 真实上游 `plan_extraction.py` + 合成 scout → 生成包含 `base`/`pinout` 两个任务的 plan（上游缺失时 skip）；
- 上游计划失败 → `DS-003`，规则状态 `found`（覆盖缺口），不是 `failed`；
- 报告章节渲染：覆盖率、缺手册元件、未匹配 PDF、引脚级核对未评估；
- CLI `--datasheets` 不存在 → 退出码 2；
- CLI 自动查找 `datasheets/` → `DS-001`、`rules.datasheets = found`、整体仍 `complete`/退出码 0；
- CLI 无 `datasheets/` → `rules.datasheets = not_evaluated`、整体 `complete`/退出码 0、报告显式未评估。

测试中使用的 PDF 是程序生成的最小单页 PDF（含 xref 偏移），不是真实器件手册，也不提交大文件。

命令与结果（最终验证）：

```text
node --test tests/*.test.mjs   → 128 passed, 0 failed
python -B -m pytest -q         → 71 passed, 1 warning
```

## 6. 重新生成的样例

命令：

```bash
node .agents/skills/ad-happy/scripts/analyze.mjs \
  --project tests/fixtures/Student-DCDC-Buck-Converter \
  --gerber tests/fixtures/gerber-basic \
  --out docs/sample-report
```

结果：

- 样例工程没有 `datasheets/` 目录，因此 `summary.rules.datasheets = not_evaluated`；
- `summary.datasheets`：`pdfCount = 0`、`components = 9`、`componentsWithMpn = 8`、`icComponents = 1`、`icsWithoutPdf = 0`（未评估不推断缺口）、`pinVerification = not_evaluated`、`cacheDir = docs/sample-report/datasheets`；
- 原因：`工程目录中没有 datasheets 目录，未找到可用的 PDF 数据手册`；
- `report.html` 新增「数据手册」章节，显示本次未评估、PDF 0 份、元件 9 个，并明确「引脚级核对：未评估，需要 AI 或人工依据 PDF 提取」；
- 整体状态仍为 `complete`、退出码 0；`summary.json` 约 13.6KB，继续满足 <32KB 约束；
- 本次未生成 `datasheets.json`（没有数据手册目录，属于预期行为）。

样例路径：`docs/sample-report/report.html`、`docs/sample-report/summary.json`。

## 7. 明确未验证 / 未实现

1. **引脚级核对未验证**：没有读取 PDF 引脚表，没有比对符号引脚名/编号/电气类型与实际器件。`checks.pin_verification` 与 `summary.datasheets.pinVerification` 永远为 `not_evaluated`。需要 AI 或人工依据 PDF 提取后完成。
2. **没有 PDF 文本提取**：当前 Node 侧没有可用的 PDF 文本库，也没有引入第三方依赖；只做文件存在性与 MPN 匹配。PDF 内容的正确性、版本、器件型号是否与文件内容一致均未验证。
3. **没有下载 PDF**：不联网，不查询 DigiKey/Mouser/LCSC；PDF 必须由用户或上游 distributor skill 放入 `datasheets/`。
4. **没有运行 scout / 提取 / 合并**：没有调用 `validate_extraction_result.py`，没有生成 `<MPN>.json` 结构化提取，也没有做质量评分。
5. **MPN 匹配的保守性**：文件名推断是启发式的；文件名与器件不一致时可能产生 `DS-002` 或错误匹配。`manifest.json` 登记可以消除大部分歧义，但本工具不验证登记内容是否与 PDF 实际内容一致。
6. **单工程范围**：只扫描当前选中工程根目录下的 `datasheets/`，不跨工程共享缓存，不处理层次化多工程的数据手册分发。
7. **上游缺失时的行为**：若本机没有 `plan_extraction.py`，匹配到的 PDF 会产生 `DS-003`，`rules.datasheets = found`（提取计划缺口），整体仍为 `complete`/退出码 0；只有目录扫描/IO 异常才是 `failed`。

## 8. 边界与后续建议

- 若后续要让 AI 继续完成引脚核对，推荐流程：本 CLI 产出 `datasheets.json` 与 `DS-*` findings → AI scout 阅读 PDF 写入 `<MPN>.scout.json` → 再次运行 CLI 生成 `<MPN>.plan.json` → AI 按 plan 提取并用 `validate_extraction_result.py` 校验 → 最后由上层把提取结果与符号引脚对照。确定性 CLI 只负责前半段的可复现编排。
- 若需要更准确的 PDF 内容校验，可在后续引入受控的 PDF 文本提取依赖；在此之前，不应把文件名匹配当成内容验证。

## 9. 评审修复（第二轮）

本轮按控制器裁定修复 3 个 Important 与 1 个相关 Minor。

### 9.1 `DS-003` 不再把整体退出码变成 3

- **原问题**：上游脚本缺失/执行失败 → `planExtraction` 返回 `status: "failed"` → `extraction_plan = "failed"` → `recomputeDatasheetsStatus` 返回 `failed` → `analyze.mjs` 写入 `state.errors` → 整体退出码 3，即使数据手册是自动发现且用户未请求。
- **修复**：`aggregatePlanStatus` 把计划失败映射为 `found`（覆盖缺口，产出 `DS-003`）；`recomputeDatasheetsStatus` 只在会话内的 check 真的为 `failed` 时返回 `failed`，而目前只有目录扫描/IO 异常（`DS-ERR`）会设置它。`runDatasheetStage` 不再为 `found` 写入 `state.errors`。
- **结果**：上游缺失或计划失败时，`rules.datasheets = found`，`manifest.stages.datasheets = found`，整体 `complete`/退出码 0；只有目录扫描/IO 异常才 `failed`/退出码 3。
- **测试**：单测断言 `coverage.status = found`、`checks.extraction_plan = found`；新增 CLI 测试断言 `DS-003`、`summary.status = complete`、退出码 0。

### 9.2 MPN 文件名与上游实际写入规则对齐

- **原问题**：`sanitizeMpn` 使用 `[^A-Za-z0-9_-]` 把点号替换成 `_`，而 `plan_extraction.py` 用原始 MPN 写 `<MPN>.scout.json` / `<MPN>.plan.json`；`datasheet_lookup.py` 的清洗则保留点号。含点 MPN（如 `ABM8G-106-12.000MHZ-T`）永远找不到 scout/plan，甚至可能把上游返回 0 当成 `up-to-date` 的无证据成功。
- **修复**：
  - `sanitizeMpn` 改为保留 `[A-Za-z0-9_.-]`，与 `datasheet_lookup.py` 一致。
  - `planExtraction` 改用**原始 MPN** 作为 scout/plan 文件名（与 `plan_extraction.py` 实际行为一致），并新增 `mpnFileStem` 拒绝空名、`.`/`..`、路径分隔符以及 Windows 非法文件名字符（`/ \ : * ? " < > | NUL`）。
  - 上游返回 0 但没有 plan 时，只有同时存在 `<MPN>.json` 且其 `source.sha256` 与当前 PDF 一致，才接受 `up-to-date`；否则返回失败并说明「无证据的成功声明」。
- **测试**：新增含点 MPN 的 plan 路径测试（断言生成的 plan 文件名保留点号）、含 `/`、`\`、`..`、`:` 的 MPN 拒绝测试（断言不启动 Python）。

### 9.3 提取计划缓存改写到 `--out`

- **原问题**：`evaluateDatasheets` 默认 `cacheDir = <datasheets>/extracted`，CLI 也未传 `cacheDir`；存在 scout 时会写入源工程，违反「源工程只读」硬规则。
- **修复**：CLI 固定传入 `<--out>/datasheets/`；`evaluateDatasheets`/`planExtraction` 的缺省回退改为系统临时目录，绝不默认写源工程。`manifest.datasheets.cacheDir`、`summary.datasheets.cacheDir`、`coverage.datasheets.cacheDir`、`datasheets.json` 与报告都会展示该缓存路径。AI 继续流程为：首次运行建立 `--out` 后，把 `<MPN>.scout.json` 写入 `<--out>/datasheets/`，再次运行即可生成 plan。
- **测试**：CLI 测试先运行建立输出目录，写入 scout 后用模拟上游生成 plan，断言 plan 位于 `<out>/datasheets/`，且源工程下没有 `extracted/`。

### 9.4 failed/partial 报告文案

- **原问题**：`status = failed` 且缺失列表为空时，报告显示「没有缺失数据手册的元件」，容易被读成通过。
- **修复**：`failed` 和 `partial` 分别显示「无法判断：数据手册检查执行失败……」和「部分完成：部分输入不足……」，只有确实评估完成且列表为空时才显示「没有缺失数据手册的元件」；PDF 匹配为空时同样区分未评估/失败/部分完成。
- **测试**：新增 failed 状态报告测试，断言包含「无法判断」且不包含「没有缺失数据手册的元件」。

### 9.5 本轮验证

```text
node --test tests/*.test.mjs   → 128 passed, 0 failed
python -B -m pytest -q         → 71 passed, 1 warning
```

新增/更新了 `tests/datasheets.test.mjs` 的 18 个数据手册测试；重新生成 `docs/sample-report/`（样例无 `datasheets/`，仍为 `rules.datasheets = not_evaluated`，`cacheDir` 指向 `docs/sample-report/datasheets`）。
