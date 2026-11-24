# PCB 检测器调度：把 Task 3 的 PcbSnapshot 转成 kicad-happy 的检测器输入，
# 跑 4 条 PCB 规则并统一成 ``{findings, status}``。
#
# 语义要点（全部集中在本模块，避免下游再处理）：
# - net 偏移：PcbDoc 的 net index 0 是真实网络（样板为 SW），而 kicad-happy
#   用 0 表示「无网络」。偏移只在 ``_net_id`` 里做一次：``netIndex + 1``，
#   快照的 -1（无网络）因此正好落到 0。
# - 单位：快照坐标已是 mm；线宽与钻孔是 mil，只在 ``_mm_from_mil`` 里
#   乘 0.0254，保证 DFM 的线宽检查拿到的是毫米。
# - 铺铜：快照不含 zones/regions，所以 ``zones`` 传空。若某个焊盘网络只有
#   铺铜、没有铜走线，检测器会静默漏掉它；此时规则状态降级为
#   not_evaluated，不当作 pass（见 ``_pad_nets_without_tracks``）。
# - 过孔外径（DIAMETER）与焊盘 PTH 类型/钻孔会进入 DFM 的环宽与最小钻孔
#   检查；任一输入缺失时规则状态为 partial，并在 coverage.skippedChecks
#   列出被跳过的子检查。
# - 快照不含元件值：``value`` 记空串，不伪造数据。
# - 未归属元件的焊盘（componentIndex = -1）无法构成 "REF.pad" 键，跳过。
# - layerStack 含系统层与 Multi-Layer，不用于数铜层数（铜层过滤在 Task 3）。
from __future__ import annotations

import math
import re
import sys
from collections import Counter

from adapter import kicad_happy_scripts

# 与 adapter 使用同一份 kicad-happy 路径约定（环境变量优先）。
_SCRIPTS = kicad_happy_scripts()
if _SCRIPTS not in sys.path:
    sys.path.insert(0, _SCRIPTS)

from analyze_pcb import (  # noqa: E402
    analyze_current_capacity,
    analyze_decoupling_placement,
    analyze_dfm,
    analyze_pad_to_pad_distances,
)
from finding_schema import (  # noqa: E402
    VALID_CONFIDENCES,
    VALID_EVIDENCE_SOURCES,
    assign_finding_ids,
    make_finding,
    normalize_severity,
)

PASS = "pass"
FOUND = "found"
PARTIAL = "partial"
NOT_EVALUATED = "not_evaluated"
FAILED = "failed"

RULES = ("dfm", "pad_distance", "current_capacity", "decoupling_placement")

# 这些检测器输出的是「实测事实」，不是设计问题：不参与问题计数，
# 在报告中单独成节。
FACT_DETECTORS = frozenset({
    "pad_distance",
    "current_capacity",
    "decoupling_placement",
})

# 焊盘间距只把绕行比 ≥ 1.5 的焊盘对列为异常；其余按网络聚合。
PAD_DISTANCE_ANOMALY_RATIO = 1.5

# 与 analyze_decoupling_placement 内部的过滤条件保持一致。
_CAP_RE = re.compile(r"^C\d")
_IC_RE = re.compile(r"^(U|IC)\d")

# make_finding() 自己消费的字段；其余检测器特有字段（actual_mm、
# min_track_width_mm、routed_distance_mm 等）原样保留作为证据。
_MAKE_FINDING_KEYS = frozenset({
    "detector", "rule_id", "category", "summary", "description",
    "severity", "confidence", "evidence_source", "components", "nets",
    "pins", "recommendation", "report_context", "finding_id", "kind",
})


def run_pcb(pcb: dict) -> dict:
    """运行 4 条 PCB 规则，返回 ``{"findings": [...], "status": {...}, "coverage": {...}}``。

    status 取值：
    - ``found``：规则执行成功且有结果（问题或事实条目）；
    - ``pass``：输入齐全、规则执行成功、确实没有发现问题；
    - ``partial``：规则执行成功，但部分子检查因输入缺失被跳过，不能当作通过；
    - ``not_evaluated``：缺少规则所需的输入（含「只有铺铜、快照看不到」），
      不能下结论；
    - ``failed``：规则抛出异常（异常信息会写入 findings，不静默吞掉）。

    coverage 记录按规则归类的被跳过子检查，供 summary/report 展示数据缺口。
    """
    findings: list[dict] = []
    status: dict[str, str] = {}
    coverage: dict = {"skippedChecks": []}

    try:
        data = _compile(pcb)
    except Exception as exc:  # noqa: BLE001 快照整体不可用则所有规则都失败
        for rule in RULES:
            status[rule] = FAILED
            findings.append(_failure_finding(rule, exc))
        assign_finding_ids(findings, "pcb")
        return {"findings": findings, "status": status, "coverage": coverage}

    def run(rule, evaluate, normalize):
        # 单条规则失败不影响其他规则；异常（含 finding 统一化失败）必须
        # 变成可见的 finding，不能静默吞掉。
        try:
            result = evaluate()
            items, empty_status, skipped = (
                result if len(result) == 3 else (*result, [])
            )
            normalized = [normalize(item, rule) for item in items]
        except Exception as exc:  # noqa: BLE001 规则隔离是本层的职责
            status[rule] = FAILED
            findings.append(_failure_finding(rule, exc))
            return []
        status[rule] = FOUND if items else empty_status
        findings.extend(normalized)
        coverage["skippedChecks"].extend(
            {"rule": rule, **check} for check in skipped
        )
        return items

    run("dfm", lambda: _dfm(data), _normalize_finding)
    run("pad_distance", lambda: _pad_distance(data), _pad_distance_finding)
    run("current_capacity", lambda: _current_capacity(data), _normalize_finding)
    run(
        "decoupling_placement",
        lambda: _decoupling(data),
        _decoupling_finding,
    )

    # 与 kicad-happy 主流程一致：序列化前统一生成稳定 finding_id。
    assign_finding_ids(findings, "pcb")
    return {"findings": findings, "status": status, "coverage": coverage}


# ---------------------------------------------------------------------------
# 各规则的输入判定与调用
# ---------------------------------------------------------------------------

def _dfm(data):
    # 没有任何铜（走线/圆弧/过孔）就没有可评估的制造参数，不能报 pass。
    if (
        not data["tracks"]["segments"]
        and not data["tracks"]["arcs"]
        and not data["vias"]["vias"]
    ):
        return [], NOT_EVALUATED, [
            {"check": "copper", "reason": "快照中没有铜走线、圆弧或过孔"},
        ]
    # design_rules 不传：快照里的 rules 是 AD 规则清单，形状与 kicad-happy
    # 的 setup.design_rules 不同，硬塞会把文本当成约束值。
    # 快照也没有 net_classes / design_intent，检测器按默认 Class 2 评估。
    result = analyze_dfm(
        data["footprints"], data["tracks"], data["vias"], data["outline"],
    )
    skipped = _dfm_skipped_checks(data)
    # 有违规时 found 优先；没有违规但子检查被跳过时必须报 partial，
    # 不能把「没检查」当成「通过」。
    empty_status = PARTIAL if skipped else PASS
    return list(result.get("violations") or []), empty_status, skipped


def _dfm_skipped_checks(data):
    """列出 DFM 因输入缺失而无法执行的子检查。

    kicad-happy 的 analyze_dfm 对缺失输入是静默跳过的（例如 via.size == 0
    时不算环宽、焊盘缺 type/drill 时不参与最小钻孔），因此必须在适配层
    先识别这些缺口，把规则状态降为 partial 并在报告里列出。
    """
    skipped = []
    segments = data["tracks"]["segments"]
    arcs = data["tracks"]["arcs"]
    vias = data["vias"]["vias"]
    footprints = data["footprints"]

    if any(segment.get("width", 0) <= 0 for segment in [*segments, *arcs]):
        skipped.append({
            "check": "track_width",
            "reason": "部分铜走线/圆弧缺少线宽，无法评估最小线宽",
        })
    if len(segments) + len(arcs) < 2:
        skipped.append({
            "check": "track_spacing",
            "reason": "铜走线/圆弧少于两条，无法评估走线间距",
        })

    if vias:
        if not any(via.get("drill", 0) > 0 for via in vias):
            skipped.append({
                "check": "via_drill",
                "reason": "过孔缺少钻孔直径，无法评估最小钻孔",
            })
        if not any(via.get("size", 0) > 0 for via in vias):
            skipped.append({
                "check": "via_annular_ring",
                "reason": "过孔缺少外径（DIAMETER），无法评估环宽",
            })

    pads = [
        pad
        for footprint in footprints
        for pad in footprint.get("pads") or []
    ]
    if not pads:
        skipped.append({
            "check": "pth_pad_drill",
            "reason": "快照不含焊盘，无法评估 PTH 钻孔",
        })
    else:
        untyped = [pad for pad in pads if not pad.get("type")]
        if untyped:
            skipped.append({
                "check": "pth_pad_drill",
                "reason": "部分焊盘缺少类型/钻孔信息，无法评估 PTH 钻孔",
            })
        else:
            thru_pads = [
                pad
                for pad in pads
                if pad.get("type") in ("thru_hole", "np_thru_hole")
            ]
            if any(pad.get("drill", 0) <= 0 for pad in thru_pads):
                skipped.append({
                    "check": "pth_pad_drill",
                    "reason": "PTH 焊盘缺少钻孔直径，无法评估最小钻孔",
                })

    if not data["outline"].get("bounding_box"):
        skipped.append({
            "check": "board_outline",
            "reason": "缺少板框尺寸，无法评估板卡外形",
        })
    return skipped


def _pad_distance(data):
    if not data["tracks"]["segments"] and not data["tracks"]["arcs"]:
        return [], NOT_EVALUATED, []
    if not _pad_nets(data["footprints"]):
        return [], NOT_EVALUATED, []
    result = analyze_pad_to_pad_distances(
        data["footprints"], data["tracks"], data["vias"], data["net_names"],
    )
    # 没有成对结果、且存在只有铺铜的焊盘网络时，说明漏检可能来自缺失的
    # 铺铜数据，而不是设计真的没有可测路径。
    empty_status = _coverage_status(data)
    return _aggregate_pad_distances(result.items()), empty_status, []


def _current_capacity(data):
    if not data["tracks"]["segments"] and not data["vias"]["vias"]:
        return [], NOT_EVALUATED
    # 快照不含铺铜：按约定传空 zones；setup 也传空，沿用 1.6 mm 板厚默认值。
    result = analyze_current_capacity(
        data["tracks"], data["vias"], [], data["net_names"], {},
    )
    items = list(result.get("power_ground_nets") or [])
    items.extend(result.get("narrow_signal_nets") or [])
    # 只有过孔、没有铜走线的网络不会出现在结果里（min_width 为无穷大被跳过），
    # 铺铜承载的电流无法从快照评估。
    return items, _coverage_status(data)


def _decoupling(data):
    footprints = data["footprints"]
    if not _has_reference(footprints, _CAP_RE):
        return [], NOT_EVALUATED
    if not _has_reference(footprints, _IC_RE):
        return [], NOT_EVALUATED
    return analyze_decoupling_placement(footprints), PASS


def _has_reference(footprints, pattern):
    return any(pattern.match(fp.get("reference") or "") for fp in footprints)


def _coverage_status(data):
    """结果为空时的状态：有焊盘网络缺铜走线（可能只有铺铜）则 not_evaluated。"""
    if _pad_nets_without_tracks(data["footprints"], data["tracks"]):
        return NOT_EVALUATED
    return PASS


# ---------------------------------------------------------------------------
# PcbSnapshot -> 检测器输入
# ---------------------------------------------------------------------------

def _compile(pcb):
    nets = pcb.get("nets") or []
    net_names = _net_names(nets)
    return {
        "footprints": _footprints(
            pcb.get("components") or [], pcb.get("pads") or [], net_names,
        ),
        "tracks": _tracks(pcb.get("tracks") or [], pcb.get("arcs") or []),
        "vias": _vias(pcb.get("vias") or []),
        "net_names": net_names,
        "outline": _outline(pcb.get("outline") or {}),
    }


def _net_id(net_index):
    """快照 netIndex -> 检测器 net id。整个模块唯一的 +1 偏移点。

    快照用 -1 表示无网络、0 起为真实网络；kicad-happy 用 0 表示无网络。
    """
    if not isinstance(net_index, int) or isinstance(net_index, bool):
        return 0
    return max(net_index + 1, 0)


def _net_names(nets):
    # 0 是「无网络」占位；真实网络从 1 开始，名字按下标顺序对应。
    names = {_net_id(-1): ""}
    for index, name in enumerate(nets):
        names[_net_id(index)] = str(name or "")
    return names


def _footprints(components, pads, net_names):
    pads_by_component: dict[int, list[dict]] = {}
    for pad in pads:
        index = pad.get("componentIndex")
        if isinstance(index, int) and not isinstance(index, bool) and 0 <= index < len(components):
            pads_by_component.setdefault(index, []).append(_pad(pad, net_names))

    footprints = []
    for index, component in enumerate(components):
        footprint = str(component.get("footprint") or "")
        component_pads = pads_by_component.get(index, [])
        footprints.append({
            # kicad-happy 的 footprints 用 library 表示封装名；footprint
            # 是对外报告用的别名（kicad-happy 序列化时也这样补齐）。
            "library": footprint,
            "footprint": footprint,
            "reference": str(component.get("reference") or ""),
            # 快照不含 Comment/Value，检测器只用于展示与 ESD 识别，留空。
            "value": "",
            "x": _number(component.get("x")),
            "y": _number(component.get("y")),
            "angle": _number(component.get("angle")),
            "layer": str(component.get("layer") or ""),
            "pad_count": len(component_pads),
            "pads": component_pads,
        })
    return footprints


def _pad(pad, net_names):
    net_number = _net_id(pad.get("netIndex"))
    drill_mil = pad.get("drillMil")
    plated = pad.get("plated")
    pad_type = str(pad.get("type") or "")
    # 旧快照可能既没有 type 也没有 drillMil/plated；此时 type 留空，
    # 由 _dfm_skipped_checks 记录为数据缺口，而不是默认为 SMD。
    if not pad_type and drill_mil is not None:
        pad_type = (
            "thru_hole" if _number(drill_mil) > 0 and bool(plated)
            else "np_thru_hole" if _number(drill_mil) > 0
            else "smd"
        )
    return {
        "number": str(pad.get("name") or ""),
        "net_number": net_number,
        "net_name": net_names.get(net_number, ""),
        "abs_x": _number(pad.get("x")),
        "abs_y": _number(pad.get("y")),
        # DFM 的最小钻孔检查只认 thru_hole / np_thru_hole；SMD 的 drill 为 0。
        "type": pad_type,
        "drill": _mm_from_mil(drill_mil) if drill_mil is not None else 0.0,
        "plated": bool(plated),
    }


def _tracks(tracks, arcs=()):
    segments = []
    for track in tracks:
        segments.append({
            "x1": _number(track.get("x1")),
            "y1": _number(track.get("y1")),
            "x2": _number(track.get("x2")),
            "y2": _number(track.get("y2")),
            "width": _mm_from_mil(track.get("widthMil")),
            "layer": str(track.get("layer") or ""),
            "net": _net_id(track.get("netIndex")),
        })
    arc_entries = [_arc_entry(arc) for arc in arcs]
    width_distribution = Counter(
        entry["width"] for entry in [*segments, *arc_entries]
    )
    layer_distribution = Counter(
        entry["layer"] for entry in [*segments, *arc_entries]
    )
    return {
        "segment_count": len(segments),
        "arc_count": len(arc_entries),
        "total_count": len(segments) + len(arc_entries),
        "width_distribution": dict(width_distribution),
        "layer_distribution": dict(layer_distribution),
        "segments": segments,
        "arcs": arc_entries,
    }


def _arc_entry(arc):
    """快照圆弧 -> kicad-happy 的三点圆弧（起点/中点/终点）。"""
    center_x = _number(arc.get("x"))
    center_y = _number(arc.get("y"))
    radius = _mm_from_mil(arc.get("radiusMil"))
    start = _number(arc.get("startAngle"))
    end = _number(arc.get("endAngle"))
    sweep = end - start
    if sweep <= 0:
        sweep += 360
    if sweep <= 0 or sweep > 360:
        sweep = 360
    points = [
        _arc_point(center_x, center_y, radius, start),
        _arc_point(center_x, center_y, radius, start + sweep / 2),
        _arc_point(center_x, center_y, radius, start + sweep),
    ]
    return {
        "start": points[0],
        "mid": points[1],
        "end": points[2],
        "width": _mm_from_mil(arc.get("widthMil")),
        "layer": str(arc.get("layer") or ""),
        "net": _net_id(arc.get("netIndex")),
    }


def _arc_point(center_x, center_y, radius, angle_degrees):
    angle = math.radians(angle_degrees)
    return [
        center_x + radius * math.cos(angle),
        center_y + radius * math.sin(angle),
    ]


def _vias(vias):
    entries = []
    for via in vias:
        size = _mm_from_mil(via.get("diameterMil"))
        entries.append({
            "x": _number(via.get("x")),
            "y": _number(via.get("y")),
            # 外径来自 DIAMETER；缺失时为 0，DFM 会跳过环宽并由 partial 标记。
            "size": size,
            "drill": _mm_from_mil(via.get("drillMil")),
            "net": _net_id(via.get("netIndex")),
            "type": "through",
        })
    size_distribution = Counter(
        f"{entry['size']}/{entry['drill']}"
        for entry in entries
    )
    return {
        "count": len(entries),
        "size_distribution": dict(size_distribution),
        "vias": entries,
    }


def _outline(outline):
    width = _number(outline.get("widthMm"))
    height = _number(outline.get("heightMm"))
    bounding_box = None
    if width > 0 and height > 0:
        # 快照只提供宽高；板框原点未知，按 (0, 0) 起算（DFM 只读宽高）。
        bounding_box = {
            "min_x": 0.0,
            "min_y": 0.0,
            "max_x": width,
            "max_y": height,
            "width": width,
            "height": height,
        }
    return {
        # 快照不含板框线段，只有包围盒尺寸。
        "edge_count": 0,
        "edges": [],
        "bounding_box": bounding_box,
        "width_mm": width or None,
        "height_mm": height or None,
    }


def _pad_nets(footprints):
    """net_number -> 该网络上的焊盘键（至少两个焊盘才可测间距/载流）。"""
    nets: dict[int, list[str]] = {}
    for footprint in footprints:
        reference = footprint.get("reference") or ""
        for pad in footprint.get("pads") or []:
            net = pad.get("net_number") or 0
            if net <= 0:
                continue
            nets.setdefault(net, []).append(
                f"{reference}.{pad.get('number', '')}",
            )
    return {net: keys for net, keys in nets.items() if len(keys) >= 2}


def _pad_nets_without_tracks(footprints, tracks):
    """有多个焊盘、却没有任何铜走线/圆弧的网络 —— 铺铜数据缺失时的漏检来源。"""
    routed = {
        entry["net"]
        for entry in [*tracks.get("segments", []), *tracks.get("arcs", [])]
        if entry.get("net", 0) > 0
    }
    return {net for net in _pad_nets(footprints) if net not in routed}


# ---------------------------------------------------------------------------
# finding 统一化
# ---------------------------------------------------------------------------

def _aggregate_pad_distances(items):
    """把逐焊盘对的结果按网络聚合，避免几十条事实挤占问题清单。

    每个网络保留：焊盘对数量、走线距离范围、最大绕行比与代表焊盘对；
    另列出绕行比 ≥ 1.5 的异常焊盘对。
    """
    by_net: dict[str, list[tuple[str, dict]]] = {}
    for key, entry in items:
        net = str(entry.get("net") or "")
        by_net.setdefault(net, []).append((key, entry))

    aggregated = []
    for net in sorted(by_net):
        pairs = by_net[net]
        representative_key, representative = max(
            pairs,
            key=lambda pair: _number(pair[1].get("ratio")),
        )
        routed_values = [
            _number(entry.get("routed_distance_mm"))
            for _, entry in pairs
        ]
        anomalies = [
            {
                "pair": key,
                "routed_distance_mm": _number(entry.get("routed_distance_mm")),
                "euclidean_distance_mm": _number(entry.get("euclidean_distance_mm")),
                "ratio": _number(entry.get("ratio")),
            }
            for key, entry in pairs
            if _number(entry.get("ratio")) >= PAD_DISTANCE_ANOMALY_RATIO
        ]
        aggregated.append({
            "net": net,
            "pairs": [key for key, _ in pairs],
            "pair_count": len(pairs),
            "representative_pair": representative_key,
            "representative": representative,
            "routed_distance_mm": _number(
                representative.get("routed_distance_mm")
            ),
            "euclidean_distance_mm": _number(
                representative.get("euclidean_distance_mm")
            ),
            "ratio": _number(representative.get("ratio")),
            "min_routed_distance_mm": min(routed_values) if routed_values else 0.0,
            "max_routed_distance_mm": max(routed_values) if routed_values else 0.0,
            "max_ratio": _number(representative.get("ratio")),
            "anomalies": anomalies,
        })
    return aggregated


def _normalize_finding(item, detector):
    """把已带 finding 字段的检测器输出整成 finding_schema 形状。"""
    report_context = item.get("report_context") or {}
    extra = {
        key: value
        for key, value in item.items()
        if key not in _MAKE_FINDING_KEYS
    }
    kind = item.get("kind") or (
        "fact" if detector in FACT_DETECTORS else "issue"
    )
    confidence = item.get("confidence")
    if confidence not in VALID_CONFIDENCES:
        # 与 Task 7 一致：缺失时退到保守的 heuristic，不冒充确定性结论。
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
        source="pcb",
        kind=kind,
        **extra,
    )


def _pad_distance_finding(entry, detector):
    """把按网络聚合的焊盘间距结果转成一条实测事实。"""
    net = str(entry.get("net") or "")
    pairs = [str(pair) for pair in entry.get("pairs") or []]
    components = sorted({
        reference
        for key in pairs
        for reference in [_split_pad_key(key, 0)[0], _split_pad_key(key, 1)[0]]
        if reference
    })
    pins = [
        f"{reference}.{pad}"
        for key in pairs
        for reference, pad in (
            _split_pad_key(key, 0),
            _split_pad_key(key, 1),
        )
        if reference
    ]
    anomalies = entry.get("anomalies") or []
    anomaly_text = ""
    if anomalies:
        details = "；".join(
            f"{item['pair']} 绕行比 {item['ratio']}"
            for item in anomalies
        )
        anomaly_text = f"其中绕行比偏大的焊盘对：{details}。"
    summary = (
        f"网络 {net}：{entry.get('pair_count', len(pairs))} 对焊盘间实测走线距离 "
        f"{entry.get('min_routed_distance_mm')}–{entry.get('max_routed_distance_mm')} mm，"
        f"最大绕行比 {entry.get('max_ratio')}"
        f"（代表焊盘对 {entry.get('representative_pair')}）。"
    )
    description = (
        f"同一网络 {net!r} 上共测量 {entry.get('pair_count', len(pairs))} 对焊盘的"
        f"实际走线距离（非直线距离）。代表焊盘对 "
        f"{entry.get('representative_pair')} 的走线距离为 "
        f"{entry.get('routed_distance_mm')} mm，直线距离为 "
        f"{entry.get('euclidean_distance_mm')} mm，绕行比 {entry.get('ratio')}。"
        f"{anomaly_text}这是实测事实，不是违规。"
    )
    extra = {
        name: value
        for name, value in entry.items()
        if name not in ("net", "pairs", "representative")
    }
    return make_finding(
        detector=detector,
        rule_id="PD-DET",
        category="pad_distance",
        # 按网络聚合后每个网络一条，detection_id 用网络名保证稳定。
        detection_id=f"pad-distance-{net}",
        summary=summary,
        description=description,
        severity="info",
        confidence="deterministic",
        evidence_source="topology",
        components=components,
        nets=[net] if net else [],
        pins=pins,
        recommendation="",
        report_section="Pad Distances",
        impact="",
        standard_ref="",
        source="pcb",
        kind="fact",
        **extra,
    )


def _decoupling_finding(entry, detector):
    """把 analyze_decoupling_placement 的每条结果转成 info finding。"""
    ic = str(entry.get("ic") or "")
    nearby = entry.get("nearby_caps") or []
    closest = entry.get("closest_cap_mm")
    caps = [str(cap.get("cap") or "") for cap in nearby]
    nets = sorted({
        net
        for cap in nearby
        for net in (cap.get("shared_nets") or [])
        if net
    })
    extra = {}
    if entry.get("gnd_only_caps"):
        extra["gnd_only_caps"] = entry["gnd_only_caps"]
    return make_finding(
        detector=detector,
        rule_id="DC-DET",
        category="decoupling",
        detection_id=f"decoupling-{ic}",
        summary=(
            f"{ic}：10 mm 内有 {len(nearby)} 个去耦电容，"
            f"最近距离 {closest} mm。"
        ),
        description=(
            f"IC {ic} 在共享非地网络的 10 mm 范围内有 {len(nearby)} 个电容，"
            f"最近的一个距离 {closest} mm。这是实测摆放事实，不是违规。"
        ),
        severity="info",
        confidence="deterministic",
        evidence_source="topology",
        components=([ic] if ic else []) + caps,
        nets=nets,
        pins=[],
        recommendation="",
        report_section="Decoupling",
        impact="",
        standard_ref="",
        source="pcb",
        kind="fact",
        nearby_caps=nearby,
        closest_cap_mm=closest,
        **extra,
    )


def _split_pad_key(key, position):
    """拆分 analyze_pad_to_pad_distances 的 "REF1.pad-REF2.pad" 键。"""
    parts = key.split("-", 1)
    if len(parts) <= position:
        return "", ""
    reference, _, pad = parts[position].partition(".")
    return reference, pad


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
        summary=f"{rule} 检测器执行失败：{message}",
        description=(
            f"检测器 {rule} 执行时抛出异常，本条规则已标记为 failed；"
            f"其余规则不受影响。异常：{message}"
        ),
        recommendation="检查 kicad-happy 版本与 PcbSnapshot 字段是否匹配。",
        source="pcb",
        kind="issue",
    )


# ---------------------------------------------------------------------------
# 基础换算
# ---------------------------------------------------------------------------

def _mm_from_mil(value):
    """mil -> mm。整个模块唯一的单位换算点；快照坐标本身已是 mm。"""
    return _number(value) * 0.0254


def _number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0
