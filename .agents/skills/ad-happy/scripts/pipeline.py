# Python 侧唯一入口：Node 侧写好 raw.json（SchSnapshot + buildNets）与
# pcb.json（PcbSnapshot）后调用本脚本：
#
#   python pipeline.py --raw <raw.json> --pcb <pcb.json> --out <dir>
#
# 依次执行 to_context → run_schematic → run_pcb → cross_check，合并三组规则结果：
# - findings.json：合并后的完整 findings 数组（交付物）；
# - pipeline-summary.json：{findings, status, coverage}，供 Node 读取。
#
# 本脚本不做协议转换，只负责编排；各模块的函数签名保持不变。
from __future__ import annotations

import argparse
import json
import os
import sys
import traceback

from adapter import to_context
from crosscheck import cross_check
from detectors import run_schematic
from pcb_detectors import run_pcb


def _read_json(path: str, label: str) -> dict:
    """读取 JSON 对象；失败时以非零状态退出并给出明确原因。"""
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"无法读取 {label} JSON {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise SystemExit(f"{label} JSON {path} 必须是对象")
    return data


def _write_json(path: str, data) -> None:
    # allow_nan=False：NaN/Infinity 不是合法 JSON，宁可在这里显式失败，
    # 也不让 Node 侧读到无法解析的文件。
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write("\n")


def run(raw: dict, pcb: dict) -> dict:
    """执行 Python 侧全部分析阶段，返回合并后的 findings/status/coverage。"""
    ctx = to_context(raw)
    schematic = run_schematic(ctx)
    board = run_pcb(pcb)
    cross = cross_check(ctx, pcb)
    findings = [
        *schematic["findings"],
        *board["findings"],
        *cross["findings"],
    ]
    # 三组规则键互不重叠；后合并者覆盖前者只是防御性写法。
    status = {**schematic["status"], **board["status"], **cross["status"]}
    return {"findings": findings, "status": status, "coverage": cross["coverage"]}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="AD-Happy Python 分析入口")
    parser.add_argument("--raw", required=True, help="raw.json（schematic + nets）")
    parser.add_argument("--pcb", required=True, help="pcb.json（PcbSnapshot）")
    parser.add_argument("--out", required=True, help="输出目录")
    args = parser.parse_args(argv)

    raw = _read_json(args.raw, "raw")
    pcb = _read_json(args.pcb, "pcb")

    try:
        result = run(raw, pcb)
        os.makedirs(args.out, exist_ok=True)
        _write_json(os.path.join(args.out, "findings.json"), result["findings"])
        _write_json(os.path.join(args.out, "pipeline-summary.json"), result)
    except Exception:  # noqa: BLE001 入口负责把异常变成明确的非零退出码
        traceback.print_exc()
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
