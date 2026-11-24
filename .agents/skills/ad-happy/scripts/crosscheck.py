# 跨域交叉检查：同一个元件的同一个引脚/焊盘，在原理图网表与 PCB 焊盘网络上
# 是否连到同一个网络。
#
# 匹配优先级（与设计文档 3.2 一致）：
# 1. 按 ``(位号, 引脚号/焊盘号)`` 精确匹配；
# 2. 焊盘名与引脚号不一致时，降级为按网络名比对，finding 注明「按名称匹配」。
#
# 未命名网络的处理（设计文档 3.3 第 5 条）：原理图侧统一为 ``__unnamed_N``，
# PCB 侧是 AD 编译名（如 ``NetC1_1``），两者不强行改名对齐。当两侧网络名不同、
# 且至少一侧是自动命名时，改为比较网络的连接成员集合：成员完全一致即视为同一
# 网络，并在 ``coverage["net_aliases"]`` 里同时记录两边的名字。
#
# 数据缺口不伪造通过：
# - PCB 焊盘中未映射的 netIndex（Task 3 已将 65535 映射为 -1）不参与比对，
#   写入 ``coverage["skipped"]`` 说明原因；
# - 没有任何可比对引脚时规则状态为 not_evaluated；
# - 规则抛异常时状态为 failed，并生成可见的 DET-ERR finding，不静默吞掉。
from __future__ import annotations

import re
import sys

from adapter import kicad_happy_scripts

# 与 adapter 使用同一份 kicad-happy 路径约定（环境变量优先）。
_SCRIPTS = kicad_happy_scripts()
if _SCRIPTS not in sys.path:
    sys.path.insert(0, _SCRIPTS)

from finding_schema import assign_finding_ids, make_finding  # noqa: E402

PASS = "pass"
FOUND = "found"
NOT_EVALUATED = "not_evaluated"
FAILED = "failed"

RULE = "pin_pad"

# 原理图未命名网络（Task 5 约定）与 AD 自动编译网络名（如 NetC1_1）。
_SCHEMATIC_UNNAMED_RE = re.compile(r"^__unnamed_\d+$")
_PCB_AUTO_NET_RE = re.compile(r"^Net[A-Za-z0-9_]+_\w+$")


def cross_check(ctx, pcb: dict) -> dict:
    """按 ``(位号, 引脚/焊盘号)`` 比对原理图与 PCB 的网络。

    返回 ``{"findings": [...], "status": {...}, "coverage": {...}}``：

    - ``status["pin_pad"]``：
      - ``found``：发现至少一处网络不一致；
      - ``pass``：可比的引脚/焊盘全部一致；
      - ``not_evaluated``：没有任何可比的引脚/焊盘；
      - ``failed``：规则执行时抛出异常（异常信息写入 DET-ERR finding）。
    - ``coverage``：本次比对的数据覆盖情况。``compared`` 是实际参与比对的对数，
      ``exact`` / ``by_net_name`` 分别是按引脚号 / 按网络名匹配的对数，
      ``net_aliases`` 记录网名不同但连接成员一致的自动命名网络，
      ``skipped`` 记录因数据缺口未参与比对的位置与原因（如 netIndex 未映射）。
    """
    findings: list[dict] = []
    status: dict[str, str] = {}

    try:
        findings, coverage = _compare(ctx, pcb)
    except Exception as exc:  # noqa: BLE001 规则隔离是本层的职责
        status[RULE] = FAILED
        findings = [_failure_finding(exc)]
        coverage = _empty_coverage()
    else:
        status[RULE] = FOUND if findings else (
            PASS if coverage["compared"] else NOT_EVALUATED
        )

    # 与 kicad-happy 主流程一致：序列化前统一生成稳定 finding_id。
    assign_finding_ids(findings, "crosscheck")
    return {"findings": findings, "status": status, "coverage": coverage}


# ---------------------------------------------------------------------------
# 比对主流程
# ---------------------------------------------------------------------------

def _compare(ctx, pcb):
    pin_net = getattr(ctx, "pin_net", None) or {}
    ctx_nets = getattr(ctx, "nets", None) or {}
    pads_by_ref, pcb_net_members, pcb_refs = _pcb_index(pcb)
    sch_net_members = _schematic_net_members(ctx_nets)

    coverage = _empty_coverage()
    findings: list[dict] = []

    for (raw_ref, raw_pin), value in _sorted_pins(pin_net):
        ref = str(raw_ref or "")
        pin_number = str(raw_pin or "")
        sch_net = _net_name(value)

        if not ref or not pin_number or not sch_net:
            coverage["skipped"].append({
                "reference": ref,
                "pin": pin_number,
                "reason": "原理图引脚缺少位号、引脚号或网络名，无法比对",
            })
            continue
        if ref not in pcb_refs:
            coverage["skipped"].append({
                "reference": ref,
                "pin": pin_number,
                "reason": "PCB 上无此元件，无法比对",
            })
            continue

        finding = _compare_pin(
            ref,
            pin_number,
            sch_net,
            pads_by_ref.get(ref) or {},
            sch_net_members,
            pcb_net_members,
            coverage,
        )
        if finding is not None:
            findings.append(finding)

    return findings, coverage


def _compare_pin(
    ref,
    pin_number,
    sch_net,
    pads,
    sch_net_members,
    pcb_net_members,
    coverage,
):
    """比对单个引脚；返回 None 表示一致或已跳过，返回 dict 表示不一致。"""
    pad_nets = pads.get(pin_number)

    if pad_nets is not None:
        assigned = [name for name in pad_nets if name]
        if not assigned:
            # 焊盘存在但 netIndex 未映射：不参与比对，不能据此判 pass。
            coverage["skipped"].append({
                "reference": ref,
                "pin": pin_number,
                "reason": "PCB 焊盘无网络（netIndex 未映射），跳过比对",
            })
            return None

        coverage["compared"] += 1
        coverage["exact"] += 1
        if sch_net in assigned:
            return None

        pcb_net = _join_nets(assigned)
        if _same_net_by_membership(
            sch_net, pcb_net, sch_net_members, pcb_net_members,
        ):
            _record_alias(coverage, sch_net, pcb_net, ref, pin_number)
            return None
        return _mismatch_finding(
            ref,
            pin_number,
            sch_net,
            pcb_net,
            match_mode="pin_number",
            pad_number=pin_number,
        )

    # 焊盘名与引脚号不一致：降级为按网络名比对。
    mapped_pads = sorted(name for name, names in pads.items() if any(names))
    unmapped_pads = sorted(name for name, names in pads.items() if not any(names))
    component_pad_nets = sorted({
        name for names in pads.values() for name in names if name
    })

    if not component_pad_nets:
        # 没有焊盘，或全部焊盘的 netIndex 都未映射：这是数据缺口，不是网络
        # 不一致，不能生成 XP-001。
        coverage["skipped"].append({
            "reference": ref,
            "pin": pin_number,
            "reason": (
                "PCB 上该元件无焊盘，无法按名称比对"
                if not pads
                else "PCB 上该元件焊盘网络均未映射（netIndex 未映射），无法比对"
            ),
            **({"pads": unmapped_pads} if unmapped_pads else {}),
        })
        return None

    coverage["compared"] += 1
    coverage["by_net_name"] += 1
    for candidate in component_pad_nets:
        if candidate == sch_net or _same_net_by_membership(
            sch_net, candidate, sch_net_members, pcb_net_members,
        ):
            if candidate != sch_net:
                _record_alias(coverage, sch_net, candidate, ref, pin_number)
            return None

    # 有已映射网络但对不上：真实不一致。未映射焊盘不参与判定，但要在
    # coverage 与 finding 里列出，避免把数据缺口藏进差异里。
    for pad_name in unmapped_pads:
        coverage["skipped"].append({
            "reference": ref,
            "pin": pin_number,
            "pad": pad_name,
            "reason": f"PCB 焊盘 {pad_name} 无网络（netIndex 未映射），不参与比对",
        })
    return _name_mismatch_finding(
        ref,
        pin_number,
        sch_net,
        component_pad_nets,
        pad_numbers=mapped_pads,
        unmapped_pads=unmapped_pads,
        pcb_pads=_pad_net_pairs(pads),
    )


# ---------------------------------------------------------------------------
# PCB 快照索引
# ---------------------------------------------------------------------------

def _pcb_index(pcb):
    """返回 ``(按位号分组的焊盘, 网络成员集合, PCB 位号集合)``。

    焊盘按 ``{reference: {pad_name: [net_name_or_None, ...]}}`` 分组，保留同名
    焊盘的多个网络，避免静默丢弃。``netIndex`` 越界或为 -1 时 net_name 记 None。
    """
    components = pcb.get("components") or []
    pads = pcb.get("pads") or []
    nets = pcb.get("nets") or []
    if not isinstance(components, list) or not isinstance(pads, list) or not isinstance(nets, list):
        raise ValueError("PcbSnapshot 的 components/pads/nets 必须是数组")

    references = [str(component.get("reference") or "") for component in components]
    pcb_refs = {reference for reference in references if reference}

    pads_by_ref: dict[str, dict[str, list[str | None]]] = {}
    members: dict[str, set[tuple[str, str]]] = {}
    for pad in pads:
        component_index = pad.get("componentIndex")
        if (
            not isinstance(component_index, int)
            or isinstance(component_index, bool)
            or not 0 <= component_index < len(references)
        ):
            continue  # 未归属元件的焊盘无法构成 "位号.焊盘" 键
        reference = references[component_index]
        if not reference:
            continue

        pad_name = str(pad.get("name") or "")
        net_index = pad.get("netIndex")
        net_name = None
        if (
            isinstance(net_index, int)
            and not isinstance(net_index, bool)
            and 0 <= net_index < len(nets)
        ):
            net_name = str(nets[net_index] or "") or None

        pads_by_ref.setdefault(reference, {}).setdefault(pad_name, []).append(net_name)
        if net_name:
            members.setdefault(net_name, set()).add((reference, pad_name))

    return (
        pads_by_ref,
        {name: frozenset(pins) for name, pins in members.items()},
        pcb_refs,
    )


def _schematic_net_members(ctx_nets):
    """``{网络名: {(位号, 引脚号), ...}}``，用于未命名网络的成员比对。"""
    members = {}
    if not isinstance(ctx_nets, dict):
        return members
    for name, info in ctx_nets.items():
        pins = info.get("pins") if isinstance(info, dict) else None
        if not isinstance(pins, list):
            continue
        pairs = {
            (str(pin.get("component") or ""), str(pin.get("pin_number") or ""))
            for pin in pins
            if isinstance(pin, dict)
        }
        members[str(name)] = frozenset(pairs)
    return members


# ---------------------------------------------------------------------------
# 网络等价判断
# ---------------------------------------------------------------------------

def _same_net_by_membership(sch_net, pcb_net, sch_net_members, pcb_net_members):
    """两侧网名不同时，靠连接成员集合判断是否为同一网络。

    只对自动命名网络启用：显式命名的网络名不同就是不一致，不做宽松匹配。
    """
    if not (_is_auto_net_name(sch_net) or _is_auto_net_name(pcb_net)):
        return False
    left = sch_net_members.get(sch_net)
    right = pcb_net_members.get(pcb_net)
    return bool(left) and bool(right) and left == right


def _is_auto_net_name(name):
    return bool(
        _SCHEMATIC_UNNAMED_RE.match(name)
        or _PCB_AUTO_NET_RE.match(name)
    )


def _record_alias(coverage, sch_net, pcb_net, ref, pin_number):
    key = f"{ref}.{pin_number}"
    for alias in coverage["net_aliases"]:
        if alias["schematic_net"] == sch_net and alias["pcb_net"] == pcb_net:
            if key not in alias["pins"]:
                alias["pins"].append(key)
                alias["pins"].sort()
            return
    coverage["net_aliases"].append({
        "schematic_net": sch_net,
        "pcb_net": pcb_net,
        "pins": [key],
    })


# ---------------------------------------------------------------------------
# finding 构造
# ---------------------------------------------------------------------------

def _mismatch_finding(ref, pin_number, sch_net, pcb_net, *, match_mode, pad_number):
    nets = _ordered_nets(sch_net, pcb_net)
    match_text = "按 (位号, 引脚号)" if match_mode == "pin_number" else "按名称匹配"
    return make_finding(
        detector="crosscheck",
        rule_id="XP-001",
        category="cross_domain",
        detection_id=f"pin-pad-{ref}.{pin_number}",
        summary=(
            f"{ref}.{pin_number} 网络不一致："
            f"原理图 {sch_net} / PCB {pcb_net}"
        ),
        description=(
            f"元件 {ref} 的引脚 {pin_number} 在原理图上连接网络 {sch_net!r}，"
            f"但在 PCB 对应焊盘 {pad_number!r} 上连接网络 {pcb_net!r}。"
            f"匹配方式：{match_text}。"
        ),
        severity="error",
        confidence="deterministic",
        evidence_source="topology",
        components=[ref],
        nets=nets,
        pins=[f"{ref}.{pin_number}"],
        recommendation=(
            "核对原理图与 PCB 的网络连接：以原理图为准同步 PCB，"
            "或确认 PCB 才是期望设计后反向修正原理图。"
        ),
        report_section="跨域一致性",
        source="crosscheck",
        kind="issue",
        match_mode=match_mode,
        schematic_net=sch_net,
        pcb_net=pcb_net,
        pin_number=pin_number,
        pad_number=pad_number,
    )


def _name_mismatch_finding(
    ref,
    pin_number,
    sch_net,
    component_pad_nets,
    *,
    pad_numbers,
    unmapped_pads,
    pcb_pads,
):
    nets = _ordered_nets(sch_net, *component_pad_nets)
    pcb_net = _join_nets(component_pad_nets)
    # 降级路径没有同名焊盘，pad_number 记录实际参与比对的候选焊盘；
    # 多个候选时用 "/" 连接，具体列表见 pcb_pads。
    pad_number = "/".join(pad_numbers)
    pads_text = "、".join(
        f"{entry['number']}（{entry['net'] or '未映射'}）"
        for entry in pcb_pads
    ) or "无"
    unmapped_text = (
        f"未映射网络（netIndex 未映射）的焊盘：{'、'.join(unmapped_pads)}。"
        if unmapped_pads else ""
    )
    return make_finding(
        detector="crosscheck",
        rule_id="XP-001",
        category="cross_domain",
        detection_id=f"pin-pad-{ref}.{pin_number}",
        summary=(
            f"{ref}.{pin_number} 网络不一致："
            f"原理图 {sch_net} / PCB {pcb_net}（按名称匹配）"
        ),
        description=(
            f"PCB 上元件 {ref} 没有名为 {pin_number!r} 的焊盘；"
            f"按网络名比对，该元件也没有焊盘连接网络 {sch_net!r}。"
            f"该元件焊盘：{pads_text}。{unmapped_text}"
            "焊盘可能已改名或缺失，匹配方式：按名称匹配。"
        ),
        severity="error",
        confidence="deterministic",
        evidence_source="topology",
        components=[ref],
        nets=nets,
        pins=[f"{ref}.{pin_number}"],
        recommendation=(
            "确认 PCB 封装焊盘号是否与原理图引脚号对应，并核对两侧网络连接；"
            "以原理图为准同步 PCB，或确认 PCB 才是期望设计后反向修正原理图。"
        ),
        report_section="跨域一致性",
        source="crosscheck",
        kind="issue",
        match_mode="name",
        schematic_net=sch_net,
        pcb_net=pcb_net,
        pcb_nets=component_pad_nets,
        pcb_pads=pcb_pads,
        unmapped_pads=unmapped_pads,
        pin_number=pin_number,
        pad_number=pad_number,
    )


def _failure_finding(exc):
    """规则异常转成 error 级 finding，保证失败在报告里可见。"""
    message = f"{type(exc).__name__}: {exc}"
    return make_finding(
        detector="crosscheck",
        rule_id="DET-ERR",
        category="analysis_error",
        severity="error",
        confidence="deterministic",
        evidence_source="topology",
        summary=f"跨域交叉检查执行失败：{message}",
        description=(
            f"跨域交叉检查执行时抛出异常，本次无法给出跨域一致性结论。"
            f"异常：{message}"
        ),
        recommendation="检查 PcbSnapshot 与 AnalysisContext.pin_net 的字段是否匹配。",
        source="crosscheck",
        kind="issue",
    )


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------

def _sorted_pins(pin_net):
    # 按 (位号, 引脚号) 自然排序，保证 finding 顺序稳定；数字引脚按数值排。
    return sorted(
        pin_net.items(),
        key=lambda item: (
            str(item[0][0]),
            _pin_sort_key(str(item[0][1])),
        ),
    )


def _pin_sort_key(pin_number):
    return (0, int(pin_number), "") if pin_number.isdigit() else (1, 0, pin_number)


def _net_name(value):
    # pin_net 的 value 约定为 (net_name, net_info)；兼容直接给字符串的实现。
    if isinstance(value, (tuple, list)):
        return str(value[0] or "") if value else ""
    return str(value or "")


def _join_nets(net_names):
    unique = sorted({name for name in net_names if name})
    return "/".join(unique)


def _pad_net_pairs(pads):
    """``{焊盘名: [网络名或 None]}`` -> ``[{number, net}]``，供 finding 举证。"""
    pairs = []
    for pad_name in sorted(pads):
        nets = sorted({name for name in pads[pad_name] if name})
        if not nets:
            net_text = None
        elif len(nets) == 1:
            net_text = nets[0]
        else:
            net_text = "/".join(nets)
        pairs.append({"number": pad_name, "net": net_text})
    return pairs


def _ordered_nets(*net_names):
    ordered = []
    for name in net_names:
        if name and name not in ordered:
            ordered.append(name)
    return ordered


def _empty_coverage():
    return {
        "compared": 0,
        "exact": 0,
        "by_net_name": 0,
        "net_aliases": [],
        "skipped": [],
    }
