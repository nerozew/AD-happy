# AD-Happy Phase 4：SPICE 仿真集成报告

- 分支：`feature/ad-happy`
- 实现范围：仿真器检测、可选 `--spice` 仿真、上游结果归一化、报告「仿真」章节与测试
- 不包含：安装任何仿真器、下载模型/器件数据、把未运行的仿真说成通过

## 1. 上游接口检查结果（只读，未修改 kicad-happy）

检查目录：`D:/Tools/kicad-happy/skills/spice/scripts/`。

### 1.1 `simulate_subcircuits.py`

实际用法（以 argparse 为准）：

```text
python simulate_subcircuits.py <analysis.json> \
  [--output <report.json>] [--workdir <dir>] [--timeout <秒>] \
  [--types <a,b>] [--compact] [--text] \
  [--parasitics <json>] [--simulator auto|ngspice|ltspice|xyce] \
  [--monte-carlo N] [--mc-distribution gaussian|uniform] [--mc-seed 42]
```

- 输入是 **分析 JSON**，不是网表文件。上游只读取 `analysis_json["findings"]`（以及顶层
  `inrush_analysis.rails[]`）；AD-Happy 的 `pipeline-summary.json.findings` 已包含所需字段，
  因此不需要额外的 `.cir` 或原始网表输入。
- 上游按 `detector` 名把 finding 分派到 `spice_templates.TEMPLATE_REGISTRY`：
  `detect_voltage_dividers → voltage_dividers`、`detect_rc_filters → rc_filters`、
  `detect_decoupling → decoupling_analysis`（`_DET_KEY_OVERRIDES`）、
  `detect_power_regulators → power_regulators` 等。名字不匹配时会被**静默跳过**，
  所以 AD-Happy 侧必须做显式映射。
- 每个子电路的流程是：生成测试台 → 写 `<workdir>/<label>.cir` → 调用仿真器 →
  读取结果 → 评估 → 在 `simulation_results[]` 中记录 `status`、`expected`、
  `simulated`、`delta`、`cir_file`、`log_file`、`elapsed_s`。
- 输出信封：`analyzer_type = "spice"`、`summary`（total/pass/warn/fail/skip）、
  `findings[]`（仅 fail/warn 的 SP-FAIL/SP-WARN 英文条目）、`simulation_results[]`。
  AD-Happy 只使用 `simulation_results[]` 与 `summary`，自行生成中文 SP finding，
  避免把上游英文 finding 直接混入。
- 没有 `--simulator` 指定的仿真器时，脚本退出码 1 并打印安装提示；有仿真器但
  测量失败时，结果状态为 `skip`（不是 `pass`）。
- 上游输出中的 `simulator` 字段只调用 `find_ngspice()`，即使实际使用 LTspice
  也可能为空或指向 ngspice；因此 AD-Happy 不依赖该字段，另行记录所选仿真器的
  名称、路径和版本。

### 1.2 `spice_simulator.py`

- 后端：`NgspiceBackend`、`LtspiceBackend`、`XyceBackend`；
  `detect_simulator(preference)` 先看 `SPICE_SIMULATOR`，否则按
  ngspice → LTspice → Xyce 顺序自动选择。
- 路径优先级：`NGSPICE_PATH` / `LTSPICE_PATH` / `XYCE_PATH` → `shutil.which(...)`
  → Windows/macOS/Linux 默认位置。
- ngspice 的 Windows 默认位置：`%PROGRAMFILES%\Spice64\bin\ngspice.exe`、
  `C:\Spice64\bin\ngspice.exe`。
- LTspice 的 Windows 默认位置：`%PROGRAMFILES%\LTC\LTspiceXVII\XVIIx64.exe`、
  `%PROGRAMFILES(X86)%\LTC\LTspiceXVII\XVIIx64.exe`、
  `%LOCALAPPDATA%\Programs\ADI\LTspice\LTspice.exe`；Linux 下还会尝试 wine。
- Xyce 只有 PATH 查找；`Xyce` 与 `xyce` 都识别。
- 运行方式：ngspice `-b <cir>`；LTspice `-b <cir>`；Xyce 直接传 netlist。

### 1.3 `spice_templates.py` / `spice_results.py`

- `TEMPLATE_REGISTRY` 支持的 findings 驱动类型：`rc_filters`、`lc_filters`、
  `voltage_dividers`、`opamp_circuits`、`crystal_circuits`、`feedback_networks`、
  `transistor_circuits`、`current_sense`、`protection_devices`、
  `decoupling_analysis`、`power_regulators`、`rf_matching`、`bridge_circuits`、
  `bms_systems`、`rf_chains`、`snubber_circuits`。
- `TOPLEVEL_REGISTRY` 只有 `inrush_analysis`，需要顶层 `inrush_analysis.rails[]`；
  AD-Happy 没有该结构，未纳入。
- 生成器直接读取检测器字段（如 `r_top.ref/ohms`、`ratio`、`feedback_divider`、
  `cutoff_hz`），AD-Happy 的 finding 已保留这些字段，映射时只改 `detector` 名。
- 评估器把仿真值与解析值比较，给出 pass/warn/fail/skip；AD-Happy 将其作为
  SP-003/SP-002 的唯一数值来源，不在 Node 侧重算或补值。
- **联网检查**：`spice_spec_fetcher.py` 含 DigiKey/Mouser 等 HTTP 调用，但
  `simulate_subcircuits.py` 的导入链是 `spice_templates → spice_models`，
  不会导入 `spice_spec_fetcher` / `spice_model_cache`；本次运行未发起网络请求。

## 2. 仿真器检测策略（`scripts/spice.mjs`）

`detectSimulators(options?) -> { ngspice?, ltspice?, xyce?, chosen? }`

1. **显式路径**：读取 `NGSPICE_PATH` / `LTSPICE_PATH` / `XYCE_PATH`，文件存在且可执行
   时优先使用（与上游一致；路径不存在则继续查找，不报错）。
2. **PATH**：按目标平台的 PATH 分隔符拆分；Windows 同时尝试原文件名和
   `PATHEXT`（默认 `.COM;.EXE;.BAT;.CMD`），因此 `.exe`、`.cmd`、`.bat` 和无扩展名
   存根都能被找到；POSIX 检查 `X_OK`。
3. **Windows 常见安装目录**：复用上游的 ngspice/LTspice 位置，并补充
   `%PROGRAMFILES%\ADI\LTspice\LTspice.exe`。
4. **选择规则**：`SPICE_SIMULATOR` 指定 `ngspice`/`ltspice`/`xyce` 时只选指定项；
   指定但未找到则不回退到其他仿真器（与上游 preference 一致）；未指定时按
   ngspice → LTspice → Xyce。
5. **版本**：对 ngspice/Xyce 尝试 `--version`、`-v` 并解析版本号；LTspice 没有可靠的
   命令行版本查询，报告写「版本未知」，不启动 GUI、不猜测。查询失败时 `version = null`。
6. **不安装软件**：只做文件存在性与版本查询，不下载、不写注册表、不修改 PATH。

`runSpice(circuits, simulator, outDir, options?)` 还会把所选路径写入
`NGSPICE_PATH`/`LTSPICE_PATH`/`XYCE_PATH` 与 `SPICE_SIMULATOR` 后再启动 Python，
保证上游使用与检测阶段**同一个**仿真器。

## 3. 实现范围与数据流

### 3.1 `scripts/spice.mjs`

- `detectSimulators()`、`probeSimulatorVersion()`、`simulatorInstallHints()`。
- `runSpice(circuits, simulator, outDir, options)`：
  - 把 AD-Happy 的 finding `detector` 映射为上游 `detect_*` 名，保留全部检测器字段；
  - 写出 `spice/analysis-input.json`（可复现输入）；
  - 调用 `simulate_subcircuits.py --output spice/simulation-report.json
    --workdir spice/work`；
  - 归一化 `simulation_results[]`：类型、元件、状态、expected/simulated/delta、
    **测试台相对/绝对路径、日志路径、仿真器名称与版本**；
  - 生成 SP finding（中文）并计算 coverage。
- 规则 ID：
  - `SP-001`：显式 `--spice` 但未找到仿真器（`kind: fact`、`info`，不伪造结果，
    也不计入问题数）；
  - `SP-002`：仿真执行失败 / 上游脚本缺失 / 单个子电路未完成 / 候选未产出结果
    （`error` 或 `warning`）；
  - `SP-003`：仿真值与解析计算不一致（上游 fail → `error`，warn → `warning`）。
- **候选对账**：上游 `simulate_subcircuits.py` 在生成器返回 `None` 时会静默
  `continue`，不写任何 `simulation_results` 记录（例如稳压器缺少
  `feedback_divider`、运放是 comparator/open-loop）。本实现：
  - 映射阶段对当前 AD-Happy 规则做保守预过滤（稳压器缺反馈分压、分压器网络
    重叠/接地、RC 参数非正、去耦无容值），记录在 `excludedCircuits`；
  - 上游返回后把提交的候选与 `simulation_results` 按类型/元件对账，未匹配的
    记录在 `unaccountedCircuits`；
  - 只要存在 `excludedCircuits` 或 `unaccountedCircuits`，规则状态至少为
    `partial`（无任何结果时为 `not_evaluated`），每个候选生成一条 `SP-002`；
  - coverage 明确区分 `availableCircuits`（识别到的候选）、`submittedCircuits`
    （实际提交给上游）与 `missingCircuits`（未产出结果）。
- **通过的仿真不生成 finding**：与上游 `build_report()` 的约定一致，pass 结果只写入
  `simulation_results`、coverage、`spice.json` 与报告「仿真」章节；只有 fail/warn/skip
  以及未产出结果的候选才生成 SP-002/SP-003，避免把每次成功仿真变成问题噪音。
- 检测器映射覆盖上游全部 findings 驱动类型。AD-Happy 当前实际产出的是
  `voltage_divider`、`rc_filter`、`decoupling`、`power_regulator`；映射表为后续
  LC/运放/晶振等检测器预留，未识别的类型会记录在 `unsupportedDetectors`。
- 上游英文备注（如 `Simulation failed`、`5.0% error — check for loading`）在
  报告与 finding 中翻译成中文；无法安全翻译的备注按项目既有约定标注
  「（仿真器原文）」，原文保留在 `coverage.circuits[].note`。

### 3.2 CLI（`analyze.mjs`）

- 新增 `--spice`（布尔开关，默认关闭）。
- 规则键新增 `spice`，默认 `not_evaluated`。
- **不带 `--spice`**：
  - `rules.spice = not_evaluated`，原因「未启用 --spice：仿真为可选步骤，本次没有运行。」；
  - 不检测仿真器、不调用上游、不产生任何 SP finding；
  - `manifest.stages.spice = skipped`；
  - 报告仍渲染「仿真」章节，明确写「本次未运行仿真」。
- **带 `--spice`、无仿真器**：
  - `rules.spice = not_evaluated`，原因列出缺少的仿真器、已检查的位置和安装方式；
  - 产生一条 `SP-001`（`kind: fact`、info，不计入问题数），列出
    `NGSPICE_PATH`/`LTSPICE_PATH`/`XYCE_PATH` 与 ngspice/LTspice/Xyce 的安装方式；
  - **退出码不变**（只有 `failed` 参与聚合）；
  - 写出 `spice.json`，记录检测结果与原因。
- **带 `--spice`、有仿真器**：
  - 调用上游并合并 SP finding；
  - 状态：全部 pass → `pass`；有候选未产出结果（预过滤或上游静默丢弃）→ `partial`
    （无任何结果时 `not_evaluated`）；有 warn/fail → `found`；部分 skip → `partial`；
    全部 skip/无结果 → `not_evaluated`；执行异常/上游脚本缺失 → `failed`；
  - `found`/`partial`/`not_evaluated` 不改变退出码；`failed` 退出码 3；
  - 其余阶段、规则与报告结构不变。
- `spice/` 目录每次运行重建；`spice.json` 列入清理清单，避免旧测试台被误读。
- `summary.json` 新增压缩后的 `spice` 与 `coverage.spice`（前 50 个子电路），
  完整明细在 `spice.json`。

### 3.3 报告（`report.mjs`）

新增「仿真」章节（`id="spice"`）：

- 仿真器名称、路径、版本（或「版本未知」）、可仿真子电路数、已提交数、
  未生成结果数、结果计数；
- 逐子电路表格：类型、元件、通过/警告/失败/跳过、测试台路径（文件不存在时明确标注）、
  解析值/仿真值/偏差；
- 「未生成结果的候选」列表：区分「预过滤」与「上游未返回」，逐条给出原因；
- 未运行时的显式说明；无仿真器时的原因与安装提示；
- `spice.json`、`spice/analysis-input.json`、`spice/simulation-report.json`、
  `spice/work` 路径；
- 仿真器检测、测试台生成、仿真执行三个检查项的状态。

## 4. 降级行为

| 情形 | rules.spice | 产物 | 退出码 | 可见说明 |
| --- | --- | --- | --- | --- |
| 未传 `--spice` | `not_evaluated` | 无 `spice.json` | 不变 | 报告「本次未运行仿真」；无 SP finding |
| `--spice`、无仿真器 | `not_evaluated` | `spice.json`（仅检测记录） | 不变 | SP-001 + 安装提示 |
| `--spice`、有仿真器、无可仿真子电路 | `not_evaluated` | `spice.json` | 不变 | 说明支持的类型与本次检测到的规则 |
| `--spice`、部分子电路 skip | `partial` | `spice.json` + 测试台/日志 | 不变 | SP-002 警告；跳过项不代表通过 |
| `--spice`、候选被预过滤/上游静默丢弃 | `partial`（无结果时 `not_evaluated`） | 同上 | 不变 | 每个候选一条 SP-002；报告列出未生成结果的候选 |
| `--spice`、全部子电路 skip | `not_evaluated` | 同上 | 不变 | SP-002 警告 + 原因 |
| `--spice`、结果与解析值不一致 | `found` | 同上 | 不变 | SP-003（fail=error / warn=warning） |
| `--spice`、上游脚本缺失或执行异常 | `failed` | `manifest` 错误 + SP-002 | 3 | 明确脚本路径/异常信息 |

## 5. 测试与输出

### 5.1 测试命令与结果

```text
node --test tests/*.test.mjs   → 147 passed, 0 failed, 0 skipped
python -B -m pytest -q         → 71 passed, 1 warning（任何现有第三方库弃用警告）
```

新增 `tests/spice.test.mjs`（19 个测试）：

1. PATH 中 ngspice/LTspice 替身的检测与优先级；`SPICE_SIMULATOR` 指定。
2. `NGSPICE_PATH` 覆盖；空 PATH 的「无仿真器」分支。
3. 版本探测；LTspice 返回「版本未知」。
4. `runSpice` + 替身跑通分压器：pass、仿真器版本、测试台相对/绝对路径均存在。
5. 替身注入 5% 偏差 → SP-003（error），偏差来自替身实际输出。
6. 替身主动失败 → SP-002 警告、全部 skip 时 `not_evaluated`，测试台仍保留。
7. 无仿真器 → SP-001、`not_evaluated`，不创建 `spice/`。
8. 无可仿真子电路 → `not_evaluated`，不调用上游。
9. 报告渲染：未运行、安装提示、测试台路径。
10. CLI 不带 `--spice`：`rules.spice=not_evaluated`、无 SP finding、报告说明可选。
11. CLI `--spice` 无仿真器：`not_evaluated`、退出码 0、原因/安装提示/SP-001。
12. CLI `--spice` + 替身：`pass`、2 个子电路、版本与测试台路径可追溯，
    `spice/analysis-input.json` 与上游 `simulation-report.json` 一致。
13. CLI `--spice` + 替身偏差：SP-003 计入问题、`found`、退出码仍为 0。
14. CLI `--spice` + 上游脚本缺失：`failed`、SP-002、退出码 3，报告状态文案为
    「仿真执行失败」而不是「未评估」。
15. 候选对账：comparator/open-loop 运放被上游生成器返回 None → `unaccountedCircuits`
    1 个、状态 `partial`、SP-002，**不得报 pass**。
16. 预过滤：缺 `feedback_divider` 的稳压器 → `excludedCircuits` 1 个、
    `submittedCircuits=1`、状态 `partial`；只有该候选时 `not_evaluated` 且不调用上游。
17. 备注翻译覆盖 `feedback divider` / `will be wrong` 两个上游变体。
18. 报告渲染未生成结果的候选：`partial` 文案与缺失清单，不得写「全部通过」。
19. 直接构造 `renderReport({status:"failed", simulator:null})`：报告写「仿真执行失败」，
    而不是「未评估」。

替身实现：
- Windows 写 `ngspice.cmd`（调用 Node 脚本），POSIX 写可执行的 `ngspice` sh 脚本；
- 读取上游测试台的 `echo "...=..." > <out>` 行，把 `expected` 回写为测量值；
  `SPICE_STUB_ERROR_PCT` 注入偏差，`SPICE_STUB_FAIL=1` 模拟失败；
- 这不是产品逻辑，只在测试临时目录中生成，用来在不安装仿真器的机器上走通
  「仿真器可用」分支。

### 5.2 实际运行验证

- 不带 `--spice`：`rules.spice=not_evaluated`，SP finding 数 0，`spice.json` 不存在；
  样例项目检测到 2 个可仿真子电路（分压器 R1/R2、稳压器反馈 IC1/R1/R2），
  但因为没有启用，未交给上游。
- `--spice` 无仿真器（本机真实环境）：`not_evaluated`、退出码 0、SP-001 1 条、
  `spice.json` 存在、报告展示安装提示。
- `--spice` + 替身：`pass`、2/2 通过、仿真器 `ngspice 99-stub`、
  测试台 `spice/work/voltage-divider_R1_R2.cir` 与
  `spice/work/regulator-feedback_IC1_R1_R2.cir` 均实际存在；
  上游 `simulation-report.json` 与 `spice.json` 的 counts/电路数一致。
- `--spice` + 替身 5% 偏差：2 条 SP-003 error，`found`，退出码 0。
- `--spice` + 替身失败：2 条 SP-002 warning，`not_evaluated`，退出码 0。
- `--spice` + 上游脚本缺失：`failed`，SP-002 error，退出码 3；报告状态文案为
  「仿真执行失败」。
- 候选对账（替身）：有效分压器 + comparator 运放 → 上游只返回 1 条结果，
  `available=2`、`submitted=2`、`missing=1`、`partial`，SP-002 列出运放候选；
  缺 `feedback_divider` 的稳压器在提交前被预过滤，`submitted=1`、`missing=1`，
  同样不报 pass。

## 6. 重新生成的样例

命令（**不带** `--spice`，样例展示可选状态）：

```bash
node .agents/skills/ad-happy/scripts/analyze.mjs \
  --project tests/fixtures/Student-DCDC-Buck-Converter \
  --gerber tests/fixtures/gerber-basic \
  --out docs/sample-report
```

结果：

- `summary.rules.spice = not_evaluated`；
- `summary.spice.requested = false`、`status = not_evaluated`、
  `simulator = null`，原因「未启用 --spice：仿真为可选步骤，本次没有运行。」；
- `findings.json` 中没有 SP- finding；
- `manifest.stages.spice = skipped`，`manifest.spice.requested = false`；
- `report.html` 新增「仿真」章节，显示「本次未运行仿真：--spice 为可选开关，
  默认关闭；未运行不代表通过。」，并列出仿真器/版本/测试台等字段为「—」；
- 未生成 `spice.json` 与 `spice/` 目录；
- `summary.spice.availableCircuits=0`、`submittedCircuits=0`、`missingCircuits=0`
  （未启用时不做候选映射）；
- `summary.json` 约 15.0KB，继续满足 <32KB 约束；
- 整体状态 `complete`、退出码 0。

样例路径：`docs/sample-report/report.html`、`docs/sample-report/summary.json`。

## 7. 明确未验证 / 无法在本机验证

1. **真实仿真器未验证**：本机没有 ngspice、LTspice 或 Xyce，所有「可用」路径均由
   测试替身走通；真实仿真器的收敛、模型、测量语法与版本差异未验证。
2. **LTspice 未验证**：没有安装 LTspice，生成器渲染的 `.meas` 语法、`.log`
   解析和 GUI 版本均未实测；版本显示为「版本未知」。
3. **Xyce 未验证**：没有安装 Xyce，`.measure` 语法与 `.mt0` 解析未实测。
4. **Windows 常见安装路径未验证**：没有在装有 ngspice/LTspice 的 Windows 上
   确认默认路径命中；只验证了 PATH 与 `NGSPICE_PATH`。
5. **真实 ngspice 的 `.control` 行为未验证**：替身只模拟 `echo` 输出文件，
   没有验证 ngspice 实际测量失败、超时、非零退出、对话框等行为。
6. **更多子电路类型未验证**：AD-Happy 当前没有 LC 滤波、运放、晶振等检测器；
   映射表虽已覆盖，但真实 finding 字段是否满足上游模板未验证。
7. **后仿/寄生参数未接入**：未使用 `extract_parasitics.py` 或 `--parasitics`；
   仿真模型是上游的理想/通用模型，不代表实际 PCB 寄生或器件模型。
8. **上游模型库/API 未验证**：没有调用 `spice_spec_fetcher.py`（联网）或器件模型
   缓存；AD-Happy 不联网，也不声称使用了厂商模型。
9. **不安装软件**：按要求未在本机安装任何 SPICE 仿真器，也未修改系统 PATH/注册表。

## 8. 变更文件

- 新增 `.agents/skills/ad-happy/scripts/spice.mjs`
- 修改 `.agents/skills/ad-happy/scripts/analyze.mjs`（`--spice`、stage、summary、报告参数）
- 修改 `.agents/skills/ad-happy/scripts/report.mjs`（「仿真」章节与归一化）
- 新增 `tests/spice.test.mjs`
- 修改 `README.md`、`.agents/skills/ad-happy/SKILL.md`（使用说明）
- 重新生成 `docs/sample-report/`

## 9. 评审修复（Important + 相关 Minor）

### 9.1 Important：上游静默丢弃候选时不再报 pass

问题：上游 `simulate_subcircuits.py` 在生成器返回 `None` 时直接 `continue`，
不写 `simulation_results`；原实现只用上游返回的结果决定状态，导致
`availableCircuits=2`、`counts.total=1` 时仍可能报 `pass`，用户会误以为所有候选
都已验证。

修复：

- **预过滤**（`exclusionReason`）：对当前 AD-Happy 规则复制上游生成器的
  None 条件——稳压器缺 `feedback_divider.r_top/r_bottom`、分压器网络重叠/接地、
  分压电阻非正、RC 参数非正、去耦无容值。被排除的候选写入
  `excludedCircuits`，不提交上游。
- **结果对账**（`reconcileCandidates`）：上游返回后，按预期 `subcircuit_type`
  与元件/`regulator` 字段把提交的候选与 `simulation_results` 匹配；未匹配的写入
  `unaccountedCircuits`。
- **状态**：存在 `missingCircuits = excluded + unaccounted` 时，有结果则
  `partial`，无结果则 `not_evaluated`；每个未产出结果的候选生成一条 `SP-002`
  （warning），并在报告中列出「预过滤」/「上游未返回」及原因。`pass` 只在
  `missingCircuits=0` 且全部结果通过时出现。
- **coverage** 新增 `availableCircuits`（识别到的候选）、`submittedCircuits`
  （实际提交）、`missingCircuits`、`excludedCircuits`、`unaccountedCircuits`；
  报告新增这两类候选的清单与计数。

新增测试：
- comparator/open-loop 运放（上游生成器返回 None）+ 有效分压器 → 上游只返回
  1 条结果，`available=2/submitted=2/missing=1`，状态 `partial`，SP-002；
  明确断言 `notEqual(status, 'pass')`。
- 缺 `feedback_divider` 的稳压器 + 有效分压器 → `excluded=1/submitted=1/missing=1`，
  状态 `partial`；只有该稳压器时 `not_evaluated`，且不创建 `spice/` 目录。

### 9.2 Minor 1：SP-001 不再计入问题数

`spiceNotRunFinding()` 的 `kind` 从 `issue` 改为 `fact`。`summary.counts.total`
/ `must_fix` / `should_fix` / `nice_to_have` 不再因「没装仿真器」增加；SP-001 仍保留在
`findings.json` 与报告的「实测事实」中。CLI 测试新增断言：
`summary.counts.total === findings.filter(kind !== 'fact').length`。

### 9.3 Minor 2：补全稳压器/反馈网络备注翻译

翻译表新增上游实际文案：

- `{x}% error in feedback divider` → 「反馈分压误差 {x}%」；
- `{x}% error — regulator output voltage will be wrong` → 「误差 {x}%：稳压器输出电压将不正确」。

原有 `feedback voltage` / `may be wrong` 变体继续保留（分别来自
`evaluate_regulator_feedback` 与反馈网络评估器）。新增 3 条翻译断言。

### 9.4 Minor 3：failed 状态文案优先级

`report.mjs` 的 `spiceStatusText()` / `spiceCircuitsEmptyText()` 改为先判断
`status === 'failed'`，再判断 `simulator` 是否为空。这样「仿真器路径不存在」等
`simulator=null` 的失败场景显示「仿真执行失败」，与失败徽标和退出码 3 一致，
不再误写成「未评估」。CLI 上游脚本缺失测试新增报告文案断言。

### 9.5 回归

```text
node --test tests/*.test.mjs   → 147 passed, 0 failed, 0 skipped
python -B -m pytest -q         → 71 passed, 1 warning
```

样例已重新生成（不带 `--spice`，`summary.json` 约 15.0KB）。本轮按评审要求
将 opt-in 噪音、summary 余量、报告措辞等其余 Minor 记为 debt，未修改。

## 10. P4 复审 Minor 修复

### 10.1 Minor 1：未提交分支的计数自洽

问题：无仿真器、仿真器不可执行、不支持的仿真器名称、上游脚本缺失等分支在
`submittedCircuits=0` 时仍保留 `missingCircuits=0`，报告显示
「可仿真子电路 2 / 已提交仿真 0 / 未生成结果 0」，与「available 与 submitted
的差额必须被解释」的不变式矛盾。

修复：

- 所有**未提交**的提前返回分支统一设置
  `missingCircuits = availableCircuits`（包括无仿真器、名称不支持、路径不可执行、
  上游脚本缺失）；全候选预过滤分支本来就是 `missing = excluded = available`。
- `spiceStageFailure()`（已提交但执行失败）也把
  `submittedCircuits + excludedCircuits` 计入 `missingCircuits`。
- 报告在 `missingCircuits > 0` 但没有逐候选清单时（例如没有仿真器、脚本缺失、
  执行失败），显示「共 N 个候选未生成结果；本次没有可用于这些候选的仿真结果，
  原因见上方状态与说明」，避免出现「计数 2 但列表为空」。
- summary/报告/summary.coverage 现在在所有分支都满足：
  `submittedCircuits=0` 时 `missingCircuits=availableCircuits`；
  有结果时 `missingCircuits = excluded + unaccounted`。

新增/更新断言：

- `runSpice` 无仿真器：`available=1 / submitted=0 / missing=1`。
- CLI `--spice` 无仿真器：`available=2 / submitted=0 / missing=2`，报告出现
  「未生成结果的候选」与「共 2 个候选未生成结果」。
- CLI `--spice` 上游脚本缺失：`submitted=0`、`missing=available`。

### 10.2 Minor 2：`failed + simulator=null` 的真实覆盖

原断言位于「上游脚本缺失」CLI 测试，而该路径在检查脚本前已经设置
`coverage.simulator`，所以没有真正覆盖 `simulator=null` 的失败场景。

修复：新增独立单测，直接构造：

```js
renderReport({
  status: { spice: 'failed' },
  spice: {
    requested: true,
    status: 'failed',
    simulator: null,
    reasons: ['仿真器不可执行或不存在：C:/tools/ngspice.exe'],
    // ...
  },
})
```

断言 `id="spice-status"` 的文案是「仿真执行失败」，不含「未评估」；
空结果文案是「仿真执行失败，没有可用的子电路结果」，不是
「未找到可用仿真器，没有生成任何子电路结果」。

### 10.3 回归

```text
node --test tests/*.test.mjs   → 147 passed, 0 failed, 0 skipped
python -B -m pytest -q         → 71 passed, 1 warning
```

`docs/sample-report/` 已在不带 `--spice` 下重新生成，计数行显示
`available=0 / submitted=0 / missing=0`（未启用时不做候选映射，不矛盾）。
范围外的 summary 余量、报告措辞等观察继续记为 debt。
