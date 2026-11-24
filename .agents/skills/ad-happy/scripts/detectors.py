# 原理图检测器调度：把 kicad-happy 的 6 条原理图检测器包装成统一的
# ``{findings, status}`` 输出。
#
# kicad-happy 各检测器的返回形状并不一致（dict / list[dict] / 原始问题列表），
# 本模块负责：
# - 把每条规则的输出统一成与 ``finding_schema.py`` 对齐的 findings；
# - 给每条 finding 补统一的 ``detector`` 字段（voltage_divider 等）；
# - 为每条规则记录运行状态（pass / found / not_evaluated / failed），
#   让「检查过且无问题」与「输入缺失、无法评估」可区分。
from __future__ import annotations

import sys

from adapter import AnalysisContext, kicad_happy_scripts

# 与 adapter 使用同一份 kicad-happy 路径约定（环境变量优先）。
_SCRIPTS = kicad_happy_scripts()
if _SCRIPTS not in sys.path:
    sys.path.insert(0, _SCRIPTS)

from analyze_schematic import analyze_connectivity  # noqa: E402
from finding_schema import (  # noqa: E402
    VALID_CONFIDENCES,
    VALID_EVIDENCE_SOURCES,
    assign_finding_ids,
    make_finding,
    normalize_severity,
)
from signal_detectors import (  # noqa: E402
    detect_decoupling,
    detect_power_regulators,
    detect_rc_filters,
    detect_shorted_two_pin_components,
    detect_voltage_dividers,
)

PASS = "pass"
FOUND = "found"
NOT_EVALUATED = "not_evaluated"
FAILED = "failed"

# make_finding() 自己消费的字段；其余检测器特有字段（r_top、topology、
# cutoff_hz、provenance 等）原样保留到 finding 里，作为证据。
_MAKE_FINDING_KEYS = frozenset({
    "detector", "rule_id", "category", "summary", "description",
    "severity", "confidence", "evidence_source", "components", "nets",
    "pins", "recommendation", "report_context", "finding_id",
})


def run_schematic(ctx: AnalysisContext) -> dict:
    """运行 6 条原理图规则，返回 ``{"findings": [...], "status": {...}}``。

    status 取值：
    - ``found``：规则执行成功且有发现；
    - ``pass``：输入齐全、规则执行成功、确实没有发现问题；
    - ``not_evaluated``：缺少规则所需的输入，不能下结论；
    - ``failed``：规则抛出异常（异常信息会写入 findings，不静默吞掉）。
    """
    findings: list[dict] = []
    status: dict[str, str] = {}

    def run(rule, evaluate):
        # 单条规则失败不影响其他规则；异常（含 finding 统一化失败）必须
        # 变成可见的 finding，不能静默吞掉。
        try:
            items, empty_status = evaluate()
            normalized = [_normalize_finding(item, rule) for item in items]
        except Exception as exc:  # noqa: BLE001 规则隔离是本层的职责
            status[rule] = FAILED
            findings.append(_failure_finding(rule, exc))
            return []
        status[rule] = FOUND if items else empty_status
        findings.extend(normalized)
        return items

    # 分压器结果同时是 RC 滤波与稳压器检测的输入（排除集 / 反馈匹配）。
    dividers = run("voltage_divider", lambda: _voltage_divider(ctx))
    run("rc_filter", lambda: _rc_filter(ctx, dividers))
    run("decoupling", lambda: _decoupling(ctx))
    run("power_regulator", lambda: _power_regulator(ctx, dividers))
    run("connectivity", lambda: _connectivity(ctx))
    run("shorted_component", lambda: _shorted_component(ctx))

    # 与 kicad-happy 主流程一致：序列化前统一生成稳定 finding_id。
    assign_finding_ids(findings, "schematic")
    return {"findings": findings, "status": status}


# ---------------------------------------------------------------------------
# 各规则的输入判定与调用
# ---------------------------------------------------------------------------

def _voltage_divider(ctx):
    if not ctx.components:
        return [], NOT_EVALUATED
    # feedback_networks 与 voltage_dividers 是同一批 dict 的双份引用，
    # 只取后者，避免同一条分压被计两次。
    result = detect_voltage_dividers(ctx)
    return result["voltage_dividers"], PASS


def _rc_filter(ctx, dividers):
    # brief 约定：必须同时存在可解析的电阻与电容，否则无法评估。
    if not _has_parsed(ctx, "resistor") or not _has_parsed(ctx, "capacitor"):
        return [], NOT_EVALUATED
    return detect_rc_filters(ctx, dividers), PASS


def _decoupling(ctx):
    # R3：仅当已知电源轨 >= 2 且至少一条不是地网络时才可评估。
    rails = set(getattr(ctx, "known_power_rails", ()) or ())
    non_ground_rails = [rail for rail in rails if not ctx.is_ground(rail)]
    if len(rails) < 2 or not non_ground_rails:
        return [], NOT_EVALUATED
    return detect_decoupling(ctx), PASS


def _power_regulator(ctx, dividers):
    if not ctx.components:
        return [], NOT_EVALUATED
    return detect_power_regulators(ctx, dividers), PASS


def _connectivity(ctx):
    if not ctx.components:
        return [], NOT_EVALUATED
    result = analyze_connectivity(ctx.components, ctx.nets, ctx.no_connects)
    # kicad-happy 只把 NT-001（单引脚网络）整理成 findings；未连接引脚与
    # 多驱动网络只以原始列表返回，这里补成同 schema 的 finding。
    items = list(result.get("single_pin_net_findings") or [])
    items.extend(_unconnected_pin_finding(pin)
                 for pin in result.get("unconnected_pins") or [])
    items.extend(_multi_driver_finding(net)
                 for net in result.get("multi_driver_nets") or [])
    return items, PASS


def _shorted_component(ctx):
    if not ctx.components:
        return [], NOT_EVALUATED
    return detect_shorted_two_pin_components(ctx), PASS


def _has_parsed(ctx, component_type):
    return any(
        component.get("type") == component_type
        and component.get("reference") in ctx.parsed_values
        for component in ctx.components
    )


# ---------------------------------------------------------------------------
# finding 统一化
# ---------------------------------------------------------------------------

def _normalize_finding(item, detector):
    """把检测器原始输出整成 finding_schema 形状，并补统一 detector 字段。"""
    report_context = item.get("report_context") or {}
    extra = {
        key: value
        for key, value in item.items()
        if key not in _MAKE_FINDING_KEYS
    }
    confidence = item.get("confidence")
    if confidence not in VALID_CONFIDENCES:
        confidence = "heuristic"
    evidence_source = item.get("evidence_source")
    if evidence_source not in VALID_EVIDENCE_SOURCES:
        evidence_source = "topology"
    return make_finding(
        detector=detector,
        rule_id=str(item.get("rule_id") or f"{detector.upper()}-DET"),
        category=str(item.get("category") or detector),
        summary=str(item.get("summary") or detector),
        description=str(item.get("description") or item.get("summary") or detector),
        severity=normalize_severity(item.get("severity")),
        confidence=confidence,
        evidence_source=evidence_source,
        components=item.get("components"),
        nets=item.get("nets"),
        pins=item.get("pins"),
        recommendation=str(item.get("recommendation") or ""),
        report_section=report_context.get("section"),
        impact=report_context.get("impact"),
        standard_ref=report_context.get("standard_ref"),
        source="schematic",
        **extra,
    )


def _failure_finding(rule, exc):
    """规则异常转成 error 级 finding，保证失败在报告里可见。"""
    message = f"{type(exc).__name__}: {exc}"
    return make_finding(
        detector=rule,
        rule_id="DET-ERR",
        category="analysis_error",
        severity="error",
        confidence="deterministic",
        evidence_source="topology",
        summary=f"{rule} detector failed: {message}",
        description=(
            f"检测器 {rule} 执行时抛出异常，本条规则已标记为 failed；"
            f"其余规则不受影响。异常：{message}"
        ),
        recommendation="检查 kicad-happy 版本与 AnalysisContext 字段是否匹配。",
        source="schematic",
    )


def _unconnected_pin_finding(pin):
    ref = pin.get("component") or "?"
    number = pin.get("pin_number") or "?"
    name = pin.get("pin_name") or ""
    label = f"{ref}.{number}" + (f" ({name})" if name else "")
    return make_finding(
        detector="connectivity",
        rule_id="NT-002",
        category="connectivity",
        severity="warning",
        confidence="deterministic",
        evidence_source="topology",
        summary=f"Unconnected pin: {label}",
        description=(
            f"Pin {label} belongs to no net and has no no-connect marker. "
            "If the pin is intentionally unused, document it with a "
            "no-connect marker; otherwise it is a missing connection."
        ),
        components=[ref] if ref != "?" else [],
        nets=[],
        pins=[f"{ref}.{number}"],
        recommendation=(
            "Connect the pin to its intended net, or place a no-connect "
            "marker if it is intentionally floating."
        ),
        source="schematic",
    )


def _multi_driver_finding(entry):
    net = entry.get("net") or "?"
    drivers = entry.get("drivers") or []
    labels = [
        f"{driver.get('component', '?')}.{driver.get('pin_number', '?')}"
        for driver in drivers
    ]
    components = sorted({
        driver["component"] for driver in drivers if driver.get("component")
    })
    return make_finding(
        detector="connectivity",
        rule_id="NT-003",
        category="connectivity",
        severity="warning",
        confidence="deterministic",
        evidence_source="topology",
        summary=f"Multiple drivers on net {net}: {', '.join(labels)}",
        description=(
            f"Net {net!r} has {len(drivers)} driver pins "
            f"({', '.join(labels)}). Contention between outputs can damage "
            "the parts or corrupt the signal."
        ),
        components=components,
        nets=[net],
        pins=labels,
        recommendation=(
            "Confirm only one driver is active at a time; re-route the "
            "others to separate nets or add arbitration."
        ),
        source="schematic",
    )
