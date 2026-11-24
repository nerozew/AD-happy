# AD-Happy Phase 6：AD 原生检查报告

- 分支：`feature/ad-happy`
- 起点：`0341f0a`（干净的 P5 收尾提交）
- 范围：通过本机 AD-MCP 的 stdio 接口调用 Altium 原生 ERC/DRC 与库原语；新增
  `--with-ad` 深度模式、归一化、报告章节、测试与样例报告
- 不做：修改 AD-MCP 安装、安装软件、联网、修改既有规则、伪造原生结果

## 1. 结论

| 项目 | 结果 |
|---|---|
| AD-MCP 接口 | 已只读检查 `installed-v0.7.0` 的 `start_server.py`、`server/main.py` 与 DelphiScript |
| stdio 桥 | `scripts/ad/mcp_client.py`；逐调用超时、整体 watchdog、结构化失败 |
| 可用性探测 | `detectAdAvailability()`：Windows、AD-MCP 服务端、Python `mcp`、`X2.EXE` 进程 |
| CLI | `--with-ad`；不可用退出码 **2**，不静默退回离线 |
| 归一化 | `AD-ERC-*` / `AD-DRC-*` / `AD-LIB-*`，`source: "altium-native"`，中文标题/描述 |
| 测试 | Node **173 passed**；Python **79 passed** |
| 真实链路 | 已用运行中的 Altium Designer 跑通 ERC；DRC 与封装明细由 AD-MCP/AD 侧失败，已如实记录 |
| 样例报告 | `docs/sample-report/` 已按离线默认重新生成；AD 章节不渲染、`rules.native_* = not_evaluated` |

真实路径**只验证到 ERC 与符号库清单/明细**；DRC 与封装明细在本机 AD26 上被
AD-MCP 的对话框自动化/脚本执行问题阻断。失败被标记为 `failed`/`partial`，没有
生成任何伪造的 DRC 违规或焊盘结论。

## 2. 检查过的 AD-MCP 接口（只读）

安装目录：`D:/NeroZe/pcb布局/AD26_PCB自动布局_工具包/01-altium-mcp/installed-v0.7.0/`

- `manifest.json`：版本 `0.7.0`；入口 `start_server.py`；MCP 配置为
  `python ${__dirname}/start_server.py`。
- `start_server.py`：
  - 启动器会先确保 per-user venv（`ALTIUM_MCP_HOME/venvs/<hash>`）就绪，再
    `exec` `server/main.py`；
  - `--build` 创建 venv 并安装 `requirements.txt`（含 `mcp[cli]==1.30.0`、pywin32、Pillow）。
- `server/main.py`：
  - `FastMCP("AltiumMCP")`，stdio transport；
  - 工具参数与返回均为 JSON 字符串（`structured_output=False`），失败时返回
    `{"success": false, "error": ...}` 或 MCP `isError`；
  - `ALTIUM_MCP_HOME` 决定 `config.json` 与 `altium_mcp.log` 的位置；
  - 与 Altium 的通信通过 `C:/Users/Public/altium_mcp/` 的 request/response 文件；
  - `AltiumConfig` 会从已保存配置、注册表、运行进程、`C:\Program Files\Altium`
    自动发现 `X2.EXE`。
- 本阶段使用的四个工具（签名/返回已核对）：

| 工具 | 参数 | 返回要点 |
|---|---|---|
| `get_erc_violations` | `compile: bool = True`, `project_path: str = ""` | `project_path`、`compiled`、`unsaved_in_altium[]`、`missing_on_disk[]`、`total`、`fatal`、`errors`、`warnings`、`violations[{level,type,detail}]` |
| `run_drc` | `board_path: str = ""`, `max_violations: int = 200`, `rules/nets/area` | `success`、`ran`、`board`、`violation_count`、`complete`、`violations[{rule,description,x_mils,y_mils,primitive1,primitive2}]`、`listed_by_rule`、`report` |
| `get_symbol_primitives` | `library_path: str = ""`, `symbol_name: str = ""` | 清单 `{library_name,symbol_count,symbols[{name,...}]}`；明细 `{primitives:[{type:"pin",pin_number,...}]}` |
| `get_footprint_primitives` | `library_path: str = ""`, `footprint_name: str = ""` | 清单 `{library_name,footprint_count,footprints[{name,...}]}`；明细 `{primitives:[{type:"pad",name,...}]}` |

未修改安装目录中的源码或配置。真实探测期间，AD-MCP 的 Python 导入曾在
`server/__pycache__/` 生成/更新过 `.pyc`（例如 `drc.cpython-313.pyc`）；这是
本阶段早期未加 `-B` 时的副作用，安装目录中的源码/配置没有被改写或删除。
修复后桥接以 `-B` 与 `PYTHONDONTWRITEBYTECODE=1` 启动服务器，不再写字节码。

AD-MCP 运行时只会写：

- 本工具为每次运行创建的 `<--out>/ad/mcp-home/`（`config.json`、`altium_mcp.log`）；
- AD-MCP 自身约定的共享交换目录 `C:/Users/Public/altium_mcp/`；
- 本工具输出目录中的请求/结果 JSON。

## 3. stdio 桥设计

文件：`.agents/skills/ad-happy/scripts/ad/mcp_client.py`

### 3.1 请求/响应

桥只做「启动服务器 → 按顺序调用工具 → 回传原始 JSON」，语义归一化在
`ad.mjs` 中完成。请求由 `ad.mjs` 生成，写入 `<--out>/ad/*-request.json`：

```json
{
  "server": {
    "python": "D:/.../installed-v0.7.0/.venv/Scripts/python.exe",
    "main": "D:/.../installed-v0.7.0/server/main.py",
    "cwd": "D:/.../installed-v0.7.0",
    "altiumHome": "<--out>/ad/mcp-home",
    "env": {}
  },
  "startupTimeoutMs": 60000,
  "calls": [
    {
      "id": "erc",
      "tool": "get_erc_violations",
      "arguments": {"compile": true, "project_path": "..."},
      "timeoutMs": 300000
    }
  ]
}
```

stdout 只有一份 JSON：

```json
{
  "ok": true,
  "phase": "done",
  "server": {"startupMs": 3200, "info": {"name": "AltiumMCP", "version": "1.30.0"}},
  "calls": {
    "erc": {"ok": true, "tool": "get_erc_violations", "result": {...}, "durationMs": 2800},
    "drc": {"ok": false, "tool": "run_drc", "reason": "tool_reported_failure", "error": "..."}
  },
  "errors": ["..."]
}
```

- 启动失败/请求不合法/缺少 `mcp` 包：`ok:false` + `phase` + `reason`；
- 单个工具失败：顶层 `ok` 仍为 `true`（桥本身工作了），该调用为 `ok:false`；
- 工具返回非 JSON、MCP `isError`、或 JSON 中 `success:false`，一律按失败处理；
- 每个调用有 `timeoutMs`；某个调用超时后，后续调用标为
  `skipped_after_timeout`，避免继续占用 Altium；
- 整体还有 `overallTimeoutMs` watchdog（默认启动 + 各调用超时之和 + 30s，上限 30 分钟）；
- Node 侧再用 `spawnSync` 的 `timeout` 兜底，因此 AD-MCP/Altium 卡死不会无限等待。

### 3.2 启动方式与 venv

`detectAdAvailability()` 优先使用安装目录自带的 `.venv/Scripts/python.exe`，其次
`venv`、`ALTIUM_MCP_HOME/venvs/*/Scripts/python.exe`、`AD_HAPPY_AD_PYTHON`、
`python`、`python3`，并对每个候选执行一次只读依赖探测（AD-MCP 的 `server/main.py`
除了 `mcp` 还导入 pywin32 与 Pillow）：

```text
python -B -c "import importlib.util, sys; ... 检查 mcp / win32gui / win32ui /
win32con / win32api / win32process / PIL ..."
```

找到一个依赖齐全的解释器后，直接用该解释器以 `python -B server/main.py` 启动
服务器，并在环境里设置 `PYTHONDONTWRITEBYTECODE=1`，避免向只读安装目录写
`__pycache__`。没有找到时：

- 如果安装目录有 `start_server.py`，报告精确的构建命令：
  `python "<server>/start_server.py" --build`；
- 同时给出 `python -m pip install "mcp[cli]==1.30.0"` 与
  `AD_HAPPY_AD_PYTHON` 的配置方式；
- 本工具**不自动执行**网络安装。

本机实际结果：系统 Python 3.13.12 有 `mcp 1.29.0`；AD-MCP `.venv` 自带
`mcp 1.30.0`，探测优先选择了 `.venv`。

## 4. 可用性探测

`detectAdAvailability(options)` 返回：

```ts
{
  available: boolean,
  serverPath: string,
  mainPath: string,
  launcherPath: string,
  python: string,
  code: 'ok' | 'server_missing' | 'bridge_missing' | 'unsupported_platform' | 'mcp_missing' | 'ad_not_running',
  reason: string,
  prerequisites: string[],
  installCommand: string | null,
  altiumRunning: boolean,
  altiumExePath: string,
  mcpFile: string,
  pythonVersion: string,
  processCheck: 'tasklist' | 'skipped' | 'not_checked' | 'unsupported' | 'tasklist_failed'
}
```

检查顺序：

1. `server/main.py` 是否存在（支持直接指向 `.../server`）；
2. 桥脚本是否存在；
3. 平台是否为 Windows；
4. 是否找到带 `mcp` 的解释器；
5. `tasklist /FI "IMAGENAME eq X2.EXE"` 是否显示 Altium 正在运行；
6. 读取安装目录 `mcp-state/config.json`（或 `~/.altium-mcp/config.json`）中的
   `altium_exe_path`，写入 per-run home，避免 AD-MCP 因找不到路径弹出文件对话框。

环境变量：

| 变量 | 用途 |
|---|---|
| `AD_HAPPY_AD_MCP_SERVER` | AD-MCP 安装目录；默认本机已知路径 |
| `AD_HAPPY_AD_PYTHON` | 指定带 `mcp` 的解释器 |
| `AD_HAPPY_AD_TOOL_TIMEOUT_MS` | 单次工具超时，默认 300000 |
| `AD_HAPPY_AD_STARTUP_TIMEOUT_MS` | 启动/initialize 超时，默认 60000 |
| `AD_HAPPY_AD_MAX_VIOLATIONS` | DRC 最多列出的违规数，默认 200 |
| `AD_HAPPY_AD_MAX_LIBRARY_DUMPS` | 每个库最多读取的符号/封装明细数，默认 50 |
| `AD_HAPPY_AD_SKIP_PROCESS_CHECK` | 仅测试/CI：跳过 `X2.EXE` 进程检查 |

`--with-ad` 不可用时，CLI 在任何输出目录创建前以退出码 **2** 结束，打印中文
原因、前提与安装命令，并提示「如果只需要离线结果，请去掉 --with-ad 重新运行」。

## 5. 归一化与失败语义

文件：`.agents/skills/ad-happy/scripts/ad/ad.mjs`

### 5.1 规则与 finding

所有原生 finding：

- `source: "altium-native"`；
- `detector: "native_erc" | "native_drc" | "native_library"`；
- `rule_id` 以 `AD-` 开头；
- `source_rule_id` 保留 Altium 原生类型/规则名；
- 标题与描述为中文，原生英文详情放在 `evidence`/描述中的「原生类型/描述」部分。

| 规则 ID | 触发条件 | 严重度 |
|---|---|---|
| `AD-ERC-001` | ERC fatal/error | must_fix |
| `AD-ERC-002` | ERC warning（含未知级别） | should_fix |
| `AD-ERC-003` | ERC info/note | nice_to_have |
| `AD-ERC-000` | ERC 工具失败/超时/结果非 JSON | must_fix（执行错误） |
| `AD-DRC-001` | DRC 违规 | Short-Circuit/Un-Routed 为 must_fix，其余 should_fix |
| `AD-DRC-000` | DRC 未实际运行（`ran:false`）或工具失败 | must_fix（执行错误） |
| `AD-LIB-001` | 库符号缺少原理图元件使用的引脚 | must_fix |
| `AD-LIB-002` | 库封装缺少 PCB 元件使用的焊盘 | must_fix |
| `AD-LIB-000` | 库清单/明细读取失败或失败 dump 汇总 | must_fix（执行错误） |
| `AD-000` | 桥接整体失败（启动/协议） | must_fix（执行错误） |

常见 ERC 类型译为中文（如 `Off-grid object` → 「对象未对齐网格」、
`Net has only one pin` → 「网络只有一个引脚」）；未识别的类型保留原生名，但
标题仍含中文级别。DRC 规则名同样映射（Clearance → 电气间距、Short-Circuit → 短路等）。

### 5.2 覆盖状态

| 检查 | 状态判定 |
|---|---|
| `native_erc` | 工具失败 → `failed`；有未保存/磁盘缺失文档或未编译 → `partial`；有违规 → `found`；否则 `pass` |
| `native_drc` | 工具失败或 `ran:false` → `failed`；达到 AD 上限/明细被截断 → `partial`；有违规 → `found`；否则 `pass` |
| `native_library` | 清单或明细失败 → `failed`/`partial`；引脚/焊盘不一致 → `found`；无匹配/IntLib → `not_evaluated`/`partial`；全部一致 → `pass` |

库核对策略：

- 自动从工程文档清单和工程目录顶层收集 `.SchLib` / `.PcbLib` / `.IntLib`；
- 只对 `.SchLib`/`.PcbLib` 调用原语工具；`.IntLib` 记录为 `not_evaluated`，
  不参与库状态聚合，避免一个无法直接读取的集成库把已完成的核对降级；
- 符号名按原理图的 Comment、`LibReference`、`Library Reference`、`LibRef`、
  `Design Item ID` 匹配；封装名按 PCB 元件的 `footprint` 匹配；
- 匹配不到时不猜、不产生不一致 finding，标记 `partial` 并说明原因；
- **覆盖边界必须可见**：
  - 每个库最多读取 `AD_HAPPY_AD_MAX_LIBRARY_DUMPS`（默认 50）个符号/封装明细；
    达到上限时该库标 `truncated`，状态降级为 `partial`，报告列出「部分条目未核对」；
  - 原理图/PCB 中存在、但没有匹配到任何已提供 `.SchLib`/`.PcbLib` 的元件，
    计入 `unmatchedSymbols`/`unmatchedFootprints`，相关库与 `checks.library`
    降级为 `partial`，报告在库表与警告条中列出这些元件；
  - 因此「已匹配子集一致」不会被报告成「全部通过」；
- 符号明细比较引脚号集合；封装明细比较具名焊盘号集合；只报告「原理图/PCB
  使用但库中缺失」的编号，库中多余引脚/焊盘不报错；
- 多元件共用同一符号/封装时，按各自引脚/焊盘集合分别比较。

### 5.3 不伪造

- 工具失败/超时：只产生执行错误 finding，不把 `violations` 字段缺失当成 0 违规；
- DRC `ran:false`：即使 `violation_count` 有值，也明确说明它是板上既有标记，
  不是本次结果，且不生成 `AD-DRC-001`；
- 库明细读取失败：不生成不一致 finding，只记录 `AD-LIB-000` 与覆盖原因；
- 未启用 `--with-ad`：不调用 AD，`native_*` 全部 `not_evaluated`，无 `AD-` finding。

## 6. CLI、summary 与报告

### 6.1 CLI

- 新增 `--with-ad`；`--help` 与 README/SKILL.md 已更新。
- 可用性检查在输出目录创建之前；不可用返回 2。
- 原生阶段在 EMC 之后、报告之前运行；结果合并进 `findings.json`。
- 新增产物：
  - `ad.json`：可用性、覆盖、逐库结果、finding 与桥接原始返回；
  - `ad/inventory-request.json`、`ad/inventory-result.json`；
  - `ad/dumps-request.json`、`ad/dumps-result.json`；
  - `ad/mcp-home/`：本次运行的 AD-MCP `config.json` 与日志。
- `manifest.stages.native` 与 `manifest.native` 记录状态、ERC/DRC/库计数、
  可用性、产物与失败原因。
- 退出码：原生工具 `failed` 或规则 `partial` 参与聚合 → 3；全部工具正常且
  只有设计问题 → 0（问题数量不影响退出码）。

### 6.2 summary.json

新增顶层 `native`（紧凑版）与 `coverage.native`：

```json
{
  "native": {
    "requested": true,
    "status": "found",
    "available": true,
    "serverPath": "...",
    "python": "...",
    "checks": {"erc": {"status": "found"}, "drc": {"status": "found"}, "library": {"status": "pass"}},
    "erc": {"total": 2, "errors": 1, "warnings": 1, "compiled": true, "unsavedInAltium": 0, "missingOnDisk": 0},
    "drc": {"ran": true, "violationCount": 2, "listed": 2, "complete": true},
    "counts": {"issues": 4, "libraries": {"matchedSymbols": 8, "matchedFootprints": 6, "mismatches": 0}},
    "artifact": "ad.json",
    "reasons": []
  }
}
```

`rules.native_erc` / `native_drc` / `native_library` 始终存在；离线为
`not_evaluated`，`--with-ad` 时为实际状态。summary 仍严格 <32KB（样例约 24KB，
桩服务器运行约 23–25KB）。

### 6.3 report.html

新增 `id="native"` 的「Altium 原生检查」章节（仅 `--with-ad` 时渲染）：

- 状态、AD-MCP/Python 路径、Altium 是否运行、ERC/DRC/库核对状态；
- 检查项表（ERC、DRC、符号库清单、封装库清单、引脚/焊盘核对、库汇总）；
- ERC 表：是否编译、总数、致命/错误/警告、明细数、类型分布、未保存/磁盘缺失文档；
- DRC 表：是否实际运行、违规数、明细数、是否完整、按规则计数、板卡、AD 报告路径；
- 库表：每个库的路径/类型/状态/清单/匹配元件/已读明细/问题与原因；
- 原生发现表：`AD-` finding、级别、类型、证据与定位；
- 说明与限制、产物路径。

问题清单中的每条 AD finding 带「Altium 原生检查」来源标签。
离线默认运行不渲染该章节，`coverage` 中的 `native_*` 规则注明「未启用 --with-ad」。

## 7. 测试

### 7.1 Node

```bash
node --test tests/*.test.mjs
# tests 173 / pass 173 / fail 0
```

新增 `tests/ad.test.mjs`（18 条）：

1. `detectAdAvailability` 桩服务器可用；
2. 服务端缺失 → `server_missing` + 中文原因/前提；
3. 非 Windows → `unsupported_platform`；
4. 桩服务器端到端 ERC/DRC/库归一化：`AD-ERC-001/002`、2 × `AD-DRC-001`、
   `source: altium-native`、中文标题/描述、`ad/` 产物、不写源工程；
5. DRC `ran:false` → `AD-DRC-000`，不产生 `AD-DRC-001`；
6. 库缺引脚/焊盘 → `AD-LIB-001` / `AD-LIB-002`，含元件与引脚定位；
7. 库明细被截断（`maxLibraryDumps=1`）→ 两个库、`checks.library` 均为
   `partial`，`truncatedLibraries=2`，不产生 `AD-LIB-000`；
8. 未匹配符号/封装（stub 排除 `10 kOhms`、`CAP 0805_2012`）→ `unmatchedSymbols=1`、
   `unmatchedFootprints=2`，库状态 `partial` 且 reasons 列出 R2/C1/C2；
9. 工具超时 → 不挂起，ERC 失败，后续调用跳过，无伪造 DRC/库结论；
10. 离线 CLI：`native_* = not_evaluated`、无 `AD-` finding、无原生章节、无 `ad.json`；
11. `--with-ad` + 桩服务器：退出 0、summary/规则状态、`ad.json`、报告章节与来源标签；
12. `--with-ad` + `AD_HAPPY_AD_MAX_LIBRARY_DUMPS=1`：退出 3、
    `rules.native_library=partial`、报告出现 `native-library-coverage` 警告；
13. `--with-ad` DRC 失败：退出 3、`native_drc=failed`、manifest 错误、无伪造违规；
14. `--with-ad` 不可用：退出 2、中文 stderr、不创建输出目录；
15. 桥收到非法 JSON → `{ok:false, phase:"request"}`；
16. 桥服务端入口缺失 → 结构化失败；
17. 库文件不存在（`Missing.SchLib`/`Missing.PcbLib`）→ 库 `failed`、
    `unmatchedComponents` 为空、不产生未匹配警告；
18. `discoverLibraries` 收集 `.SchLib`/`.PcbLib`/`.IntLib` 并去重。

桩服务器：`tests/fixtures/ad-mcp-stub/server/main.py`，用 FastMCP 实现同名四个
工具，返回固定结果；`STUB_AD_DRC_FAIL`、`STUB_AD_SLEEP_MS`、
`STUB_AD_MISSING_SYMBOL_PIN`、`STUB_AD_MISSING_PAD` 模拟失败/超时/不一致。
测试通过 `AD_HAPPY_AD_MCP_SERVER` 指向桩目录，并设置
`AD_HAPPY_AD_SKIP_PROCESS_CHECK=1`，不接触真实 Altium。

### 7.2 Python

```bash
python -B -m pytest -q
# 79 passed, 1 warning
```

新增 `tests/test_mcp_client.py`（8 条）：

- 请求 JSON 不合法、未知工具被拒绝；
- 与桩服务器的 ERC 端到端（`ok`、`StubAltiumMCP`、2 条违规）；
- `success:false` 工具失败 → `tool_reported_failure`；
- 成功调用的 `durationMs` 覆盖真实工具执行时间（stub sleep 150ms）；
- `build_server_env` 设置 `PYTHONDONTWRITEBYTECODE=1`；
- 超时 → `timeout`，后续调用 `skipped_after_timeout`；
- 服务端入口缺失 → `phase:"request"`。

## 8. 真实 Altium 验证（本机）

环境：

- Altium Designer AD26：`D:\Altium\AD26\X2.EXE`，运行中（PID 72480）；
- AD-MCP 0.7.0：`D:/NeroZe/pcb布局/AD26_PCB自动布局_工具包/01-altium-mcp/installed-v0.7.0/`；
- 桥解释器：AD-MCP `.venv/Scripts/python.exe`（Python 3.13.12，mcp 1.30.0）；
- 工程：把 `tests/fixtures/Student-DCDC-Buck-Converter` 复制到临时目录后运行，
  不触碰源夹具。

### 8.1 ERC：成功

通过新桥调用 `get_erc_violations(compile=true)`：

```json
{
  "compiled": true,
  "unsaved_in_altium": [],
  "missing_on_disk": [],
  "total": 16,
  "fatal": 0,
  "errors": 0,
  "warnings": 16
}
```

16 条全部是 `Off-grid object`（对象未对齐网格），分布在 C1/C2/C3/J1/J2/L1/R1/R2
及其引脚上。归一化后为 16 条 `AD-ERC-002`（should_fix），标题「Altium ERC 警告：
对象未对齐网格」，并带元件定位。原始结果保存在临时运行的
`ad/inventory-result.json` 与 `ad.json`（未提交，避免把本机路径入库）。

### 8.2 DRC：AD 侧未能运行

调用 `run_drc` 返回：

```json
{
  "success": false,
  "ran": false,
  "error": "The check did not run: the Design Rule Checker dialog could not be started and was closed. violation_count is what was already on the board, not a result.",
  "notes": ["the dialog has no Run Design Rule Check button"],
  "violation_count": 0,
  "violations": []
}
```

原因在 AD-MCP/AD 的对话框自动化：Design Rule Checker 对话框可以被打开，但
找不到可用的「Run Design Rule Check」按钮（可能与 AD26 界面语言/版本或当时
其他对话框有关）。本实现将其标记为 `native_drc = failed`，产生 `AD-DRC-000`
执行错误 finding，退出码 3，**没有**把 `violation_count: 0` 当作 DRC 通过。

### 8.3 库：符号成功，封装明细被 AD-MCP 超时阻断

- `SCH_Lib.SchLib`：
  - 清单：1 个符号 `TPS561208DDCR`；
  - 明细：6 个引脚（1–6），与原理图 IC1 的 6 个引脚一致 → `pass`；
- `PCB_Lib.PcbLib`：
  - 清单：2 个封装（`PCBComponent_1`、`SOT95P280X110-6N`）；
  - 明细 `get_footprint_primitives(footprint_name="SOT95P280X110-6N")`：
    AD-MCP 在 121 秒后返回
    `No response from Altium after 121 s ... command 'get_footprint_primitives' started but did not finish`；
    本实现标记该库 `partial`、`AD-LIB-000`，**没有**生成焊盘不一致结论。
- `DCDC Buck Converter.IntLib`：记录为 `not_evaluated`（集成库不能直接交给
  原语工具），不参与库状态聚合。

### 8.4 完整 CLI 真实运行

```bash
AD_HAPPY_AD_TOOL_TIMEOUT_MS=150000 node .agents/skills/ad-happy/scripts/analyze.mjs \
  --project "<临时副本>" --board "PCB4 (Final Design).PcbDoc" \
  --out "<临时输出>" --with-ad
```

结果：退出码 **3**，耗时 145 秒（主要是封装明细的 121 秒超时），
`summary.status = partial`：

- `rules.native_erc = found`，16 条 ERC 警告；
- `rules.native_drc = failed`，`AD-DRC-000`；
- `rules.native_library = partial`，符号核对通过、封装明细失败（`AD-LIB-000`）；
- `manifest.stages.native = failed`，`manifest.errors` 含 DRC 未运行与封装明细失败原因；
- 报告包含「Altium 原生检查」章节与 18 条 `AD-` finding（16 ERC + DRC + 库）；
- 输出目录中生成 `ad.json` 与 `ad/*.json`、`ad/mcp-home/`。

**未验证**：DRC 实际产生违规、封装焊盘明细成功读取、库不一致 finding 在真实
AD 上的端到端路径。这些路径由桩服务器测试覆盖，但本机 AD-MCP 0.7.0 + AD26
环境中未能跑通。

## 9. 样例报告（离线默认）

按仓库既有约定重新生成：

```bash
node .agents/skills/ad-happy/scripts/analyze.mjs \
  --project tests/fixtures/Student-DCDC-Buck-Converter \
  --gerber tests/fixtures/gerber-basic \
  --out docs/sample-report
```

结果：退出码 0、`summary.status = complete`；`summary.json` 约 24KB。

- `summary.native.requested = false`、`status = not_evaluated`；
- `rules.native_erc` / `native_drc` / `native_library` 均为 `not_evaluated`；
- `findings.json` 中没有 `AD-` finding；
- `report.html` **不渲染** `id="native"` 章节；
- 未生成 `ad.json` / `ad/`。

`docs/sample-report/` 中的 `capability_mode.json`、`gerber.json`、`manifest.json`、
`snapshot.json`、`summary.json`、`report.html` 因本次运行的时间戳/新增 summary
字段重新生成；问题数量与既有规则结论未改变（必须修复 0 / 建议修复 1 / 可优化 2）。

## 10. 约束与已知限制

- **AD-MCP 只读**：未修改安装目录中的源码/配置；运行时只写本工具输出目录与
  AD-MCP 自己的共享交换目录。早期未加 `-B` 的探测触发过 `server/__pycache__`
  的 `.pyc` 写入；修复后服务器以 `-B` + `PYTHONDONTWRITEBYTECODE=1` 启动。
- **不安装软件**：缺少 `mcp` 包时只报告精确安装命令；没有自动执行 `--build`
  或 pip。
- **不联网**：本工具不发起网络请求；MCP 与 Altium 均为本机进程。
- **不修改既有规则**：离线 10 条规则与 P1–P5 的 finding/退出码语义未变；
  新增 `native_*` 三条规则默认 `not_evaluated`。
- **不伪造**：工具失败/超时/未运行均记录为 failed 或 not_evaluated；未启用
  `--with-ad` 时没有 AD finding。
- 已知真实环境限制：
  - AD-MCP `run_drc` 依赖驱动 Design Rule Checker 对话框；AD26 本机未能找到
    Run 按钮，导致 DRC 无法运行；
  - `get_footprint_primitives` 单封装明细在本机 121 秒超时，可能是 AD-MCP
    0.7.0 的脚本问题；本实现已把该情况标为 partial/failed，不会挂起整个分析；
  - `.IntLib` 不能直接读取；需要先在 Altium 中拆出 `.SchLib`/`.PcbLib`；
  - 库符号名只能从原理图 Comment/`LibReference` 等字段推断，匹配不到时
    核对标 partial，不猜测。
- 未验证：真实 DRC 违规归一化、真实封装明细、真实库不一致 finding。这些由
  桩服务器测试覆盖；真实 ERC 与符号库路径已验证。
- 临时探测目录 `.tmp-p6/` 中最后一个 `DCDC Buck Converter.IntLib` 副本仍被
  Altium 进程占用（编译临时工程时打开），无法立即删除；该目录已加入
  `.gitignore`，不影响提交与测试。关闭 Altium 或释放该文件后可手工删除。

## 11. 变更文件

新增：

- `.agents/skills/ad-happy/scripts/ad/mcp_client.py`
- `.agents/skills/ad-happy/scripts/ad/ad.mjs`
- `tests/ad.test.mjs`
- `tests/fixtures/ad-mcp-stub/server/main.py`
- `tests/test_mcp_client.py`
- `docs/p6-ad-report.md`

修改：

- `.agents/skills/ad-happy/scripts/analyze.mjs`（`--with-ad`、原生阶段、产物、summary/report 接线）
- `.agents/skills/ad-happy/scripts/report.mjs`（`normalizeNative`、`renderNative`、标签）
- `.agents/skills/ad-happy/SKILL.md`（深度模式行为、退出码、native 汇报）
- `README.md`（`--with-ad`、环境变量、产物、限制）
- `docs/sample-report/*`（离线重新生成）

## 12. P6 评审修复记录

评审提出 1 个 Important 与 2 个相关 Minor，本轮已全部修复；其余 Minor 记为 debt。

### 12.1 Important：库明细截断/未匹配不再报 `pass`

- 每个库在匹配数超过 `AD_HAPPY_AD_MAX_LIBRARY_DUMPS` 时设置
  `state.truncated=true`，库状态与 `checks.library` 降级为 `partial`；
  reasons 明确写出「只读取前 N 个，未被读取的符号/封装未核对」。
- 新增全局未匹配统计：符号侧按所有已提供 `.SchLib` 的匹配结果汇总，
  封装侧按所有 `.PcbLib` 汇总；未匹配元件写入
  `coverage.libraries[].unmatchedComponents`、
  `coverage.counts.libraries.unmatchedSymbols/unmatchedFootprints`，
  并让相关库、`checks.library`、`rules.native_library` 降级为 `partial`。
- 状态收尾顺序调整为：failed > 明细读取失败（AD-LIB-000）> 截断/明细不可用/
  未匹配（partial）> 引脚/焊盘不一致（found）> pass。即「已核对子集一致」
  不会覆盖「仍有未核对范围」。
- 报告「库覆盖与核对」表新增“明细达到上限”“未匹配元件未参与核对”问题列，
  并在表下增加 `id="native-library-coverage"` 警告条，明确写出未匹配符号数、
  未匹配封装数与截断库数，以及「不能读成全部通过」。

测试：

- `runNativeChecks` + `maxLibraryDumps: 1` → 两个库与 `checks.library` 均为
  `partial`、`truncatedLibraries=2`、无 `AD-LIB-000`；
- `STUB_AD_SYMBOL_EXCLUDE=10 kOhms`、`STUB_AD_FOOTPRINT_EXCLUDE=CAP 0805_2012`
  → `unmatchedSymbols=1`（R2）、`unmatchedFootprints=2`（C1/C2），库 reasons
  列出元件，`checks.library=partial`，不产生 `AD-LIB-001/002`；
- CLI + `AD_HAPPY_AD_MAX_LIBRARY_DUMPS=1` → `rules.native_library=partial`、
  `summary.status=partial`、退出码 3、报告包含覆盖不足警告。

### 12.2 Minor：`durationMs` 记录真实执行时间

`mcp_client.py` 的 `_parse_tool_result()` 现在接收调用前的 `started`，成功、
`isError`、非 JSON、`success:false` 四种返回都使用同一计时起点。新增 Python
测试用 stub `STUB_AD_SLEEP_MS=150` 验证 `durationMs >= 100`。

### 12.3 Minor：禁止向 AD-MCP 安装目录写 `__pycache__`

- `build_server_env()` 增加 `PYTHONDONTWRITEBYTECODE=1`；
- 启动参数改为 `python -B server/main.py`；
- 报告 §2 的绝对表述已修正：承认早期未加 `-B` 的探测曾生成/更新
  `server/__pycache__/drc.cpython-313.pyc`，但未改写或删除安装目录中的
  源码/配置；修复后不再写字节码。
- 未删除既有 `__pycache__`（删除同样属于修改安装目录）；关闭 AD 后如需清理，
  由用户自行决定。

### 12.4 本轮债务（不修）

- `drc.complete` 缺省语义；文档顺序；桥测试依赖 PATH；离线打印文案；
  测试缺口；真实证据入库。均按评审意见记入后续 debt。

### 12.5 修复后验证

- `node --test tests/*.test.mjs`：**172 passed / 0 failed**；
- `python -B -m pytest -q`：**79 passed**；
- `docs/sample-report/` 已在**不带 `--with-ad`** 下重新生成：`summary.status=complete`、
  `native.requested=false`、`rules.native_*=not_evaluated`、无 `AD-` finding、
  报告不渲染原生章节；`summary.json` 约 20.5KB。

## 13. P6 复审修复记录（Low）

复审确认原 3 项已解决，但指出一个 Low：库读取失败时仍计算「未匹配元件」，
导致文案与覆盖归类不准确。

### 13.1 修复

- 未匹配统计只使用 `inventory === 'ok'` 的 `.SchLib`/`.PcbLib`：
  `exists=false`、清单读取失败或清单解析失败的库不再参与
  「已匹配/未匹配」计算，`unmatchedComponents` 保持为空。
- 未匹配原因文案改为「未在已成功读取的符号库/封装库中找到匹配」，不再暗示
  所有库都成功读取；缺失库的原因仍是「库文件不存在」或具体读取错误。
- 报告 `native-library-coverage` 警告文案补充：「相关库已标记为部分完成；
  库读取失败的原因见上方库状态，失败库不参与未匹配统计」。读取失败的库单独
  显示 `failed`，不会被描述成「部分完成」。

### 13.2 测试

新增 `tests/ad.test.mjs` 用例「库文件不存在只报读取失败，不把所有元件算成
未匹配」：

- 传入不存在的 `Missing.SchLib` / `Missing.PcbLib`；
- 两个库状态均为 `failed`、`inventory=failed`；
- `unmatchedComponents` 为空，`unmatchedSymbols=0`、`unmatchedFootprints=0`；
- reasons 含「库文件不存在」，不含「未在已成功读取」；
- `checks.library=failed`；
- 报告渲染后不出现 `native-library-coverage` 警告，状态体现失败。

### 13.3 验证

- `node --test tests/*.test.mjs`：**173 passed / 0 failed**；
- `python -B -m pytest -q`：**79 passed**；
- `docs/sample-report/` 已在**不带 `--with-ad`** 下重新生成：
  `summary.status=complete`、`native.requested=false`、`rules.native_*=not_evaluated`、
  无 `AD-` finding、报告不渲染原生章节；`summary.json` 约 20.5KB。

### 13.4 范围外 debt

`summarizeLibraryCheck` 不看 mismatches、`aggregateNativeStatus` 的 partial
优先级、`emptyNativeCoverage` 缺字段，按复审意见记为 debt，本轮不修。
