# AD-Happy

Altium Designer 工程的离线设计审查 Skill + CLI。给一个工程文件夹，它解析 `.PrjPcb` / `.SchDoc` / `.PcbDoc`，自建原理图网表，复用 [kicad-happy](https://github.com/aklofas/kicad-happy) 的规则，产出中文 `findings.json`、`summary.json` 与 `report.html`。

**不需要打开 Altium Designer，不修改源工程。**

## 能查什么

| 类别 | 内容 |
|---|---|
| 原理图 | 分压、RC 滤波、去耦、稳压器、未连接引脚、短路元件 |
| PCB | DFM、焊盘间距、载流、去耦摆放 |
| 交叉检查 | 同一元件的同一引脚，原理图网络与 PCB 焊盘网络是否一致 |
| 物料 | 缺 MPN、缺封装、重复位号、原理图与 PCB 不一致；生成采购清单 |
| 制造文件 | Gerber 层数、钻孔数、缺失层（复用上游 Gerber 分析） |
| 数据手册 | PDF 覆盖率与提取计划（引脚级核对留给 AI/人工） |
| SPICE | RC/分压/LC 等电路仿真（需要本机安装 ngspice/LTspice/Xyce） |
| EMC | 接地、去耦、I/O 滤波、开关谐波等预合规风险 |
| AD 原生 | ERC / DRC / 库符号与封装核对（需要 Altium 已打开 + AD-MCP） |

## 安装

```powershell
# 1. 安装本包
npm install -g .\ad-happy-0.1.0.tgz

# 2. 链接到 harness 技能目录
ad-happy-install

# 3. kicad-happy 不在默认位置时设置
$env:KICAD_HAPPY_SCRIPTS = "D:/path/to/kicad-happy/skills/kicad/scripts"
```

## 使用

在 dsh / opencode 里：

> 分析 `D:\你的工程` 这个 AD 工程

或直接命令行：

```powershell
node "<安装目录>\scripts\analyze.mjs" --project "D:\你的工程" --out "D:\报告输出"
```

常用可选参数：

| 参数 | 作用 |
|---|---|
| `--gerber <目录>` | 指定 Altium 导出的 Gerber/钻孔目录 |
| `--bom <CSV>` | 导入 Altium 导出的 BOM 做比对 |
| `--datasheets <目录>` | 指定数据手册 PDF 目录 |
| `--spice` | 运行 SPICE 仿真 |
| `--emc` | 运行 EMC 预合规 |
| `--with-ad` | 深度模式：调用 Altium 原生 ERC/DRC/库检查 |
| `--svg` | 尝试在报告中内嵌板图 |

退出码：`0` 完成 / `2` 输入无效或深度模式不可用 / `3` 部分完成。

## 产物

- `report.html` — 中文报告，浏览器直接打开
- `summary.json` — 给 AI 读的摘要（< 32KB）
- `findings.json` — 完整问题列表
- `manifest.json` — 版本、覆盖状态、失败原因
- `bom.csv` / `procurement.csv` — 物料与采购清单

## 环境要求

- Node ≥ 20、Python ≥ 3.10
- **kicad-happy 已内置**（`vendor/kicad-happy/`），无需单独安装；如需使用其他版本，可用 `KICAD_HAPPY_SCRIPTS` 覆盖
- 可选：ngspice/LTspice/Xyce（SPICE）、AD-MCP + Altium 运行中（深度模式）

缺什么会在运行时明确提示，不会静默失败。

## 许可

复用的第三方组件许可见仓库根 `THIRD-PARTY-NOTICES.md`。kicad-happy 只读引用，不随包分发。
