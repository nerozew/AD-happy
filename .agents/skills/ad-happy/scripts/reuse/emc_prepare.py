#!/usr/bin/env python3
"""为 EMC 分析器准备原理图 JSON。

`buildEmcInputs`（emc.mjs）只做结构化映射；本脚本在 `--emc` 运行时复用
AD-Happy 已经使用的 kicad-happy AnalysisContext 与检测器，把 EMC 规则实际
读取的检测结果补进 schematic.json：

  - detect_power_regulators      稳压器（拓扑、开关频率、输入/输出电容、电感）
  - detect_crystal_circuits      晶振（频率、引脚网络）
  - detect_protection_devices    TVS/ESD 保护器件（protected_net）
  - detect_lc_filters            LC 滤波（仅保留位于稳压器输入轨的滤波器）
  - detect_rc_filters            RC 滤波
  - analyze_design_rules         差分对与总线分析

检测器单条失败只记录在 `_ad_happy.detectors`，不会伪造结果；依赖该检测器
的 EMC 类别会由 emc.mjs 标记为 not_evaluated。

只读 kicad-happy；不联网。输入/输出都在 `--out` 的 emc-input/ 内。
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
AD_HAPPY_SCRIPTS = SCRIPT_DIR.parent
if str(AD_HAPPY_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(AD_HAPPY_SCRIPTS))

from adapter import to_context  # noqa: E402  依赖 kicad-happy 路径
from netlist_queries import NetlistQueries  # noqa: E402
from analyze_schematic import analyze_design_rules  # noqa: E402
from signal_detectors import (  # noqa: E402
    detect_crystal_circuits,
    detect_decoupling,
    detect_lc_filters,
    detect_power_regulators,
    detect_protection_devices,
    detect_rc_filters,
    detect_voltage_dividers,
)

OK = "ok"
NOT_EVALUATED = "not_evaluated"
FAILED = "failed"


def _load(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"{path} 必须是 JSON 对象")
    return value


def _detector_entry(status: str, count: int = 0, reason: str = "", **extra) -> dict:
    entry = {"status": status, "count": count, "reason": reason}
    entry.update(extra)
    return entry


def _has_parsed(ctx, component_type: str) -> bool:
    return any(
        component.get("type") == component_type
        and component.get("reference") in ctx.parsed_values
        for component in ctx.components
    )


def _run_detector(name: str, prerequisites: bool, reason: str, func):
    """执行单个检测器；返回 (结果, 状态条目, 警告)。

    异常不会向上抛：EMC 的整体运行仍可继续，但依赖该检测器的类别会
    被标记为 not_evaluated/failed。
    """
    if not prerequisites:
        return [], _detector_entry(NOT_EVALUATED, reason=reason), None
    try:
        result = func()
    except Exception as exc:  # noqa: BLE001 检测器隔离是本层职责
        message = f"{name} 检测器执行失败：{type(exc).__name__}: {exc}"
        return [], _detector_entry(FAILED, reason=message), message
    items = result if isinstance(result, list) else []
    return items, _detector_entry(OK, count=len(items)), None


def prepare(raw_path: str, schematic_path: str) -> dict:
    raw = _load(raw_path)
    schematic = _load(schematic_path)
    base_meta = schematic.get("_ad_happy") if isinstance(schematic.get("_ad_happy"), dict) else {}

    ctx = to_context(raw)
    warnings: list[str] = []
    try:
        ctx.nq = NetlistQueries(ctx)
    except Exception as exc:  # noqa: BLE001 缺少多跳查询时仍可做基础检测
        warnings.append(f"无法初始化 NetlistQueries（电感/输出轨识别会降级）：{exc}")

    base_ready = bool(ctx.components)
    nets_ready = bool(ctx.components and ctx.nets)
    pins_ready = bool(ctx.components and ctx.pin_net)
    values_ready = bool(ctx.parsed_values)
    detector_meta: dict[str, dict] = {}
    collected: list[dict] = []

    # 分压器是 RC 滤波与稳压器检测的输入（排除集 / 反馈匹配）。
    dividers, meta, warning = _run_detector(
        "voltage_dividers",
        nets_ready and _has_parsed(ctx, "resistor"),
        "缺少网表或可解析的电阻值",
        lambda: detect_voltage_dividers(ctx).get("voltage_dividers", []),
    )
    detector_meta["voltage_dividers"] = meta
    if warning:
        warnings.append(warning)

    regulators, meta, warning = _run_detector(
        "power_regulators",
        nets_ready and values_ready,
        "缺少网表或可解析的元件参数",
        lambda: detect_power_regulators(ctx, dividers),
    )
    detector_meta["power_regulators"] = meta
    if warning:
        warnings.append(warning)

    crystals, meta, warning = _run_detector(
        "crystals",
        base_ready,
        "缺少元件数据",
        lambda: detect_crystal_circuits(ctx),
    )
    detector_meta["crystals"] = meta
    if warning:
        warnings.append(warning)

    protection, meta, warning = _run_detector(
        "protection_devices",
        pins_ready,
        "缺少引脚-网络拓扑",
        lambda: detect_protection_devices(ctx),
    )
    detector_meta["protection_devices"] = meta
    if warning:
        warnings.append(warning)

    lc_filters, meta, warning = _run_detector(
        "lc_filters",
        nets_ready and values_ready,
        "缺少网表或可解析的 L/C 参数",
        lambda: detect_lc_filters(ctx),
    )
    if warning:
        warnings.append(warning)

    # EF-001/002 只应针对稳压器输入轨上的 LC 滤波；上游规则本身不做轨匹配，
    # 因此这里先按 regulator.input_rail 过滤，避免把输出/开关节点 LC 误当成
    # 输入 EMI 滤波器。
    input_rails = {
        str(reg.get("input_rail"))
        for reg in regulators
        if isinstance(reg, dict) and reg.get("input_rail")
    }
    kept_lc = [
        entry for entry in lc_filters
        if str(entry.get("shared_net") or "") in input_rails
    ]
    dropped_lc = len(lc_filters) - len(kept_lc)
    detector_meta["lc_filters"] = _detector_entry(
        meta["status"],
        count=len(kept_lc),
        reason=meta["reason"],
        detected=len(lc_filters),
        input_filters=len(kept_lc),
        dropped=dropped_lc,
        input_rails=sorted(input_rails),
    )
    if meta["status"] == OK and dropped_lc:
        warnings.append(
            f"已排除 {dropped_lc} 个不在稳压器输入轨上的 LC 滤波器，"
            "避免把开关/输出节点 LC 误判为输入 EMI 滤波器。"
        )

    rc_filters, meta, warning = _run_detector(
        "rc_filters",
        nets_ready and values_ready and _has_parsed(ctx, "resistor") and _has_parsed(ctx, "capacitor"),
        "缺少网表或可解析的 R/C 参数",
        lambda: detect_rc_filters(ctx, dividers),
    )
    detector_meta["rc_filters"] = meta
    if warning:
        warnings.append(warning)

    decoupling, meta, warning = _run_detector(
        "decoupling",
        nets_ready and _has_parsed(ctx, "capacitor"),
        "缺少网表或可解析的电容值",
        lambda: detect_decoupling(ctx),
    )
    detector_meta["decoupling"] = meta
    if warning:
        warnings.append(warning)

    design: dict = {}
    if nets_ready:
        try:
            design = analyze_design_rules(ctx)
            detector_meta["differential_pairs"] = _detector_entry(
                OK, count=len(design.get("differential_pairs") or []),
            )
        except Exception as exc:  # noqa: BLE001
            message = f"差分对/总线分析失败：{type(exc).__name__}: {exc}"
            warnings.append(message)
            detector_meta["differential_pairs"] = _detector_entry(FAILED, reason=message)
    else:
        detector_meta["differential_pairs"] = _detector_entry(
            NOT_EVALUATED, reason="缺少网表，无法识别差分对",
        )

    # EMC 分析器实际读取的检测器结果。分压器/去耦不直接产生 EMC 规则，
    # 但保留在 findings 中不会影响上游（它按 detector 过滤）。
    collected.extend(regulators)
    collected.extend(crystals)
    collected.extend(protection)
    collected.extend(kept_lc)
    collected.extend(rc_filters)
    collected.extend(decoupling)

    components = [
        {
            "reference": str(component.get("reference") or ""),
            "value": str(component.get("value") or ""),
            "type": str(component.get("type") or ""),
            "mpn": str(component.get("mpn") or ""),
            "lib_id": str(component.get("lib_id") or ""),
            "footprint": str(component.get("footprint") or ""),
        }
        for component in ctx.components
    ]
    severity_counts = {"error": 0, "warning": 0, "info": 0}
    for finding in collected:
        severity = str(finding.get("severity", "info")).lower()
        severity = severity if severity in severity_counts else "info"
        severity_counts[severity] += 1

    schematic["analyzer_type"] = "schematic"
    schematic["schema_version"] = "1.4.0"
    schematic["statistics"] = {
        "total_components": len(ctx.components),
        "total_nets": len(ctx.nets),
        "parsed_value_components": len(ctx.parsed_values),
    }
    schematic["findings"] = collected
    schematic["components"] = components
    schematic["design_analysis"] = {
        "differential_pairs": design.get("differential_pairs") or [],
        "buses": design.get("bus_analysis") or {},
    }
    schematic["summary"] = {
        "total_findings": len(collected),
        "by_severity": severity_counts,
    }
    schematic["_ad_happy"] = {
        "source": "ad-happy-prep",
        "generatedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "netlistComplete": base_meta.get("netlistComplete", True),
        "detectors": detector_meta,
        "warnings": warnings,
    }
    return schematic


def main() -> int:
    parser = argparse.ArgumentParser(description="为 EMC 分析器准备原理图 JSON")
    parser.add_argument("--raw", required=True, help="AD-Happy raw.json")
    parser.add_argument("--schematic", required=True, help="已由 buildEmcInputs 写出的 schematic.json")
    args = parser.parse_args()

    try:
        schematic = prepare(args.raw, args.schematic)
    except Exception as exc:  # noqa: BLE001 由调用方决定如何降级
        print(f"EMC 原理图增强失败：{type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    with open(args.schematic, "w", encoding="utf-8") as handle:
        json.dump(schematic, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
