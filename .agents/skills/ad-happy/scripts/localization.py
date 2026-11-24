# finding 中文文案层：把 kicad-happy 检测器输出的英文 summary/description/
# recommendation 翻译成中文。
#
# 约束：
# - 只改文案，不改 rule_id、detector、severity、confidence、finding_id；
# - 动态部分（位号、网络名、引脚号、数值与单位）按原文逐个捕获后原样回填；
# - 原文保存在 ``source_text`` 里，便于与 kicad-happy 对照；
# - 没有安全中文译法的英文串显式标注「（检测器原文）」，不静默保留英文。
#
# 本地化在 ``assign_finding_ids`` 之后执行，避免基于 summary 哈希的 finding_id
# 因翻译而变化。
from __future__ import annotations

import re

SOURCE_PREFIX = "（检测器原文）"

# 报告与 findings.json 中面向用户的文本字段；其余字段（rule_id、detector、
# report_context 等）保持原样。
TEXT_FIELDS = ("title", "summary", "description", "evidence", "recommendation")

_FILTER_CN = {
    "low-pass": "低通",
    "high-pass": "高通",
    "RC-network": "RC 网络",
}

_REGULATOR_TOPO_CN = {
    "switching": "开关型",
    "LDO": "线性低压差（LDO）",
    "charge_pump": "电荷泵",
    "ic_with_internal_regulator": "带内部稳压器的 IC",
    "unknown": "未知拓扑",
}

_COMPONENT_CN = {
    "resistor": "电阻",
    "capacitor": "电容",
    "inductor": "电感",
    "ferrite_bead": "铁氧体磁珠",
    "diode": "二极管",
}

_DRILL_LABEL_CN = {
    "Via drill": "过孔钻孔",
    "Drill": "钻孔",
}

# AD-Happy 自产 finding 的规则 ID：文案本来就是中文，不能按上游模板兜底
# （否则异常消息里的英文标识符会让整句被误标为「检测器原文」）。
_NATIVE_RULE_IDS = frozenset({"NT-002", "NT-003", "XP-001", "DET-ERR"})


def localize_findings(findings) -> None:
    """就地本地化 finding 列表；非 dict 条目跳过。"""
    for finding in findings:
        if isinstance(finding, dict):
            localize_finding(finding)


def localize_finding(finding: dict) -> None:
    """按 (detector, rule_id) 选择模板，就地替换文本字段并记录原文。"""
    detector = str(finding.get("detector") or "")
    rule_id = str(finding.get("rule_id") or "")
    if rule_id in _NATIVE_RULE_IDS:
        return
    spec = _SPECS.get((detector, rule_id)) or _SPECS_BY_DETECTOR.get(detector)
    if spec is None:
        # AD-Happy 自产 finding 本来就是中文，未知检测器不处理。
        return

    originals = {}
    for field in TEXT_FIELDS:
        text = finding.get(field)
        if not isinstance(text, str) or not text:
            continue
        translated = _translate(text, spec.get(field) or ())
        if translated is not None:
            if translated != text:
                finding[field] = translated
                originals[field] = text
        elif _mostly_ascii_letters(text):
            # 该规则有新模板但尚未收录译法：显式标注，不静默透传英文。
            finding[field] = f"{SOURCE_PREFIX}{text}"
            originals[field] = text

    if originals:
        existing = finding.get("source_text")
        source_text = dict(existing) if isinstance(existing, dict) else {}
        source_text.update(originals)
        finding["source_text"] = source_text


# ---------------------------------------------------------------------------
# 模板匹配
# ---------------------------------------------------------------------------

def _translate(text: str, rules):
    for pattern, replacement in rules:
        match = pattern.fullmatch(text)
        if match is None:
            continue
        result = (
            replacement(match)
            if callable(replacement)
            else replacement.format(**match.groupdict())
        )
        if result is not None:
            return result
    return None


def _mostly_ascii_letters(text: str) -> bool:
    """判断文本是否以英文字母为主；中文夹带 R1/GND/mm 等标识符时返回 False。"""
    letters = [char for char in text if char.isalpha()]
    if len(letters) < 4:
        return False
    ascii_letters = sum(1 for char in letters if char.isascii())
    return ascii_letters / len(letters) >= 0.6


def _rc_description(match):
    kind = _FILTER_CN.get(match.group("kind"))
    if kind is None:
        return None
    return f"{kind} RC 滤波器"


def _regulator_summary(match):
    topology = _REGULATOR_TOPO_CN.get(match.group("topology"))
    if topology is None:
        return None
    return f"稳压器 {match.group('ref')}（{topology}）"


def _regulator_description(match):
    topology = _REGULATOR_TOPO_CN.get(match.group("topology"))
    if topology is None:
        return None
    return f"检测到电源稳压器（{topology}）"


def _shorted_component_description(match):
    component_type = _COMPONENT_CN.get(
        match.group("component_type"), match.group("component_type"),
    )
    return (
        f"{match.group('ref')} 是{component_type}，引脚 1 与引脚 2 都连接在网络 "
        f"“{match.group('net')}” 上。电流完全绕过该元件，因此它对电路没有任何"
        "作用。ERC 与 DRC 都会通过：所有引脚均已连接、网表内部一致，只能靠设计"
        "意图区分它与有意设置的连接。跳线、网络连接点（net tie）、零欧姆连接和"
        " DNP 元件不在本检查范围内。"
    )


def _shorted_mass_description(match):
    return (
        f"{match.group('count')} 个两脚元件（{match.group('refs')}）的引脚 1 与"
        f"引脚 2 都连接在网络 “{match.group('net')}” 上。可能是原理图尚未完成"
        "（元件已放置，但第二个节点还没接线），也可能是提取出的网表把两条电源轨"
        "合并了——通常是电源轨与地——导致它们之间的每个去耦电容都被判为短路。"
        "若是后一种情况，该网络上其他基于网表的发现同样可疑。"
    )


def _drill_description(match, tier: str):
    label = _DRILL_LABEL_CN.get(match.group("label"))
    if label is None:
        return None
    reference = (match.group("reference") or "").replace(" on ", "", 1)
    reference_text = f"（焊盘 {reference}）" if reference else ""
    if tier == "advanced":
        threshold = "先进工艺下限"
        fab_tier = "挑战级"
    else:
        threshold = "标准工艺下限"
        fab_tier = "先进级"
    return (
        f"{label} {match.group('x')}mm{reference_text}低于{threshold} "
        f"{match.group('y')}mm，需要{fab_tier}制造工艺。"
    )


def _mapped_template(field: str, mapping: dict, template: str):
    """把捕获组按映射表翻译后再套用中文模板；映射缺失时返回 None。"""
    def render(match):
        mapped = mapping.get(match.group(field))
        if mapped is None:
            return None
        groups = dict(match.groupdict())
        groups[field] = mapped
        return template.format(**groups)

    return render


_NUMBER = r"[-\d.eE+]+"
_DRILL_LABEL = r"(?P<label>Via drill|Drill)"

# 每个 (detector, rule_id) 一套字段模板。正则用 fullmatch 匹配检测器原文；
# 模板中的 {name} 来自命名捕获组。
_SPECS = {
    ("voltage_divider", "VD-DET"): {
        "summary": [
            (
                re.compile(r"Voltage divider (?P<top>[^/\s]+)/(?P<bottom>\S+)"),
                "分压器 {top}/{bottom}",
            ),
        ],
        "description": [
            (
                re.compile(r"Resistive voltage divider detected"),
                "检测到电阻分压器",
            ),
            (
                re.compile(r"Feedback network voltage divider detected"),
                "检测到反馈网络分压器",
            ),
        ],
    },
    ("rc_filter", "RC-DET"): {
        "summary": [
            (
                re.compile(
                    rf"RC filter (?P<res>[^/\s]+)/(?P<cap>\S+) at "
                    rf"(?P<fc>{_NUMBER})Hz"
                ),
                "RC 滤波器 {res}/{cap}，截止频率 {fc}Hz",
            ),
        ],
        "description": [
            (re.compile(r"(?P<kind>\S+) RC filter"), _rc_description),
        ],
    },
    ("decoupling", "DC-DET"): {
        "summary": [
            (
                re.compile(r"Decoupling on (?P<rail>.+)"),
                "{rail} 去耦",
            ),
        ],
        "description": [
            (
                re.compile(r"Decoupling capacitors on power rail (?P<rail>.+)"),
                "电源轨 {rail} 上的去耦电容",
            ),
        ],
    },
    ("power_regulator", "PR-DET"): {
        "summary": [
            (
                re.compile(r"Regulator (?P<ref>\S+) (?P<topology>\S+)"),
                _regulator_summary,
            ),
        ],
        "description": [
            (
                re.compile(
                    r"Power regulator \((?P<topology>[^()]+)\) detected"
                ),
                _regulator_description,
            ),
            (
                re.compile(
                    r"Power regulator detected by keyword match \(no pin data\)"
                ),
                "通过关键字匹配检测到电源稳压器（无引脚数据）",
            ),
        ],
    },
    ("connectivity", "NT-001"): {
        "summary": [
            (
                re.compile(
                    r"Single-pin net: (?P<net>.+?) only connects to "
                    r"(?P<label>.+?) \((?P<pin_type>[^()]*)\)"
                ),
                "单引脚网络：{net} 仅连接 {label}（{pin_type}）",
            ),
        ],
        "description": [
            (
                re.compile(
                    r"Net (?P<net>.+?) has exactly one pin: (?P<label>.+?), "
                    r"pin_type=(?P<pin_type>.+?)\. Verify the intended target "
                    r"— if this pin should connect somewhere, the wire/label "
                    r"is missing\."
                ),
                (
                    "网络 {net} 只有一个引脚：{label}，pin_type={pin_type}。"
                    "请核对预期连接目标：若该引脚本应连接，说明缺少导线或网络标签。"
                ),
            ),
        ],
        "recommendation": [
            (
                re.compile(
                    r"Check the schematic at the referenced pin — add the "
                    r"missing wire or place a no-connect marker if the pin is "
                    r"intentionally floating\."
                ),
                "在对应引脚处检查原理图：补上缺失的导线；若该引脚有意悬空，"
                "请放置 No-ERC 标记。",
            ),
        ],
    },
    ("shorted_component", "SP-001"): {
        "summary": [
            (
                re.compile(
                    r"(?P<ref>\S+) \((?P<value>.*)\) has both pins on net "
                    r"'(?P<net>.*)' -- the component is shorted out and has "
                    r"no effect"
                ),
                (
                    "{ref}（{value}）的两个引脚都连接在网络 “{net}” 上，"
                    "元件被短路，不起作用"
                ),
            ),
            (
                re.compile(
                    r"(?P<count>\d+) two-pin components have both pins on net "
                    r"'(?P<net>.*)' \((?P<first>\S+) \.\. (?P<last>\S+)\) -- "
                    r"mass short or net-map problem"
                ),
                (
                    "{count} 个两脚元件的两个引脚都连接在网络 “{net}” 上"
                    "（{first} .. {last}），可能是批量短路或网表映射问题"
                ),
            ),
        ],
        "description": [
            (
                re.compile(
                    r"(?P<ref>\S+) is a (?P<component_type>.+?) with pin 1 "
                    r"and pin 2 both connected to '(?P<net>.*)'\. Current "
                    r"bypasses the part entirely, so it contributes nothing "
                    r"to the circuit\. ERC and DRC pass on this: every pin is "
                    r"connected and the netlist is internally consistent, so "
                    r"only intent distinguishes it from a deliberate link\. "
                    r"Jumpers, net ties, zero-ohm links and DNP parts are "
                    r"excluded from this check\."
                ),
                _shorted_component_description,
            ),
            (
                re.compile(
                    r"(?P<count>\d+) two-pin parts \((?P<refs>.*)\) each have "
                    r"pin 1 and pin 2 on '(?P<net>.*)'\. Either the schematic "
                    r"is unfinished \(parts placed but not yet wired to their "
                    r"second node\) or the extracted net map has merged two "
                    r"rails -- typically a power rail and ground -- so every "
                    r"decoupling capacitor between them reads as shorted\. In "
                    r"the second case the other net-based findings on this net "
                    r"are suspect too\."
                ),
                _shorted_mass_description,
            ),
        ],
        "recommendation": [
            (
                re.compile(
                    r"Confirm (?P<ref>\S+) is meant to bridge '(?P<net>.*)'\. "
                    r"If not, one pin is on the wrong net -- check which node "
                    r"it should reach\."
                ),
                (
                    "确认 {ref} 是否设计为桥接 “{net}”。若不是，说明有一个引脚"
                    "接错网络，请检查它应连接到的节点。"
                ),
            ),
            (
                re.compile(
                    r"Check '(?P<net>.*)' in KiCad first: if it carries both a "
                    r"supply and ground, or far more pins than expected, the "
                    r"net map is wrong and the parts are fine \(report the "
                    r"board\)\. Otherwise wire each listed part to its second "
                    r"node\."
                ),
                (
                    "先在原理图中检查网络 “{net}”：若该网络同时带有电源与地，"
                    "或引脚数远超预期，说明网表映射有误，元件本身没有问题"
                    "（请上报该板卡）。否则请把列出的每个元件接到它的第二个节点。"
                ),
            ),
        ],
    },
    ("current_capacity", "CC-DET"): {
        "summary": [
            (
                re.compile(
                    rf"Power net (?P<net>.+): (?P<min>{_NUMBER})mm min trace"
                ),
                "电源网络 {net}：最小走线 {min}mm",
            ),
        ],
        "description": [
            (
                re.compile(
                    rf"Power/ground net (?P<net>.+): min trace "
                    rf"(?P<min>{_NUMBER})mm, max (?P<max>{_NUMBER})mm, "
                    rf"(?P<count>\d+) segments\."
                ),
                (
                    "电源/地网络 {net}：最小走线 {min}mm，最大 {max}mm，"
                    "共 {count} 条线段。"
                ),
            ),
        ],
    },
    ("current_capacity", "CC-002"): {
        "summary": [
            (
                re.compile(
                    rf"Narrow signal: (?P<net>.+?) min (?P<min>{_NUMBER})mm"
                ),
                "窄信号走线：{net} 最小 {min}mm",
            ),
        ],
        "description": [
            (
                re.compile(
                    rf"Signal net (?P<net>.+?) has narrow traces: min "
                    rf"(?P<min>{_NUMBER})mm across (?P<count>\d+) segments\."
                ),
                (
                    "信号网络 {net} 的走线过窄：{count} 条线段中最小宽度 "
                    "{min}mm。"
                ),
            ),
        ],
        "recommendation": [
            (
                re.compile(
                    r"Widen trace or verify signal integrity requirements\."
                ),
                "加宽走线，或确认信号完整性要求可以接受。",
            ),
        ],
    },
    ("dfm", "DFM-001"): {
        "summary": [
            (
                re.compile(
                    rf"Track width (?P<x>{_NUMBER})mm below advanced minimum "
                    rf"\((?P<y>{_NUMBER})mm\)"
                ),
                "走线宽度 {x}mm 低于先进工艺下限（{y}mm）",
            ),
            (
                re.compile(
                    rf"Track width (?P<x>{_NUMBER})mm requires advanced "
                    rf"process \(standard: (?P<y>{_NUMBER})mm\)"
                ),
                "走线宽度 {x}mm 需要先进工艺（标准下限：{y}mm）",
            ),
            (
                re.compile(
                    rf"Track spacing (?P<x>{_NUMBER})mm below advanced "
                    rf"minimum \((?P<y>{_NUMBER})mm\)"
                ),
                "走线间距 {x}mm 低于先进工艺下限（{y}mm）",
            ),
            (
                re.compile(
                    rf"Track spacing (?P<x>{_NUMBER})mm requires advanced "
                    rf"process \(standard: (?P<y>{_NUMBER})mm\)"
                ),
                "走线间距 {x}mm 需要先进工艺（标准下限：{y}mm）",
            ),
            (
                re.compile(
                    rf"{_DRILL_LABEL} (?P<x>{_NUMBER})mm below advanced "
                    rf"minimum \((?P<y>{_NUMBER})mm\)"
                ),
                _mapped_template(
                    "label", _DRILL_LABEL_CN,
                    "{label} {x}mm 低于先进工艺下限（{y}mm）",
                ),
            ),
            (
                re.compile(
                    rf"{_DRILL_LABEL} (?P<x>{_NUMBER})mm requires advanced "
                    rf"process \(standard: (?P<y>{_NUMBER})mm\)"
                ),
                _mapped_template(
                    "label", _DRILL_LABEL_CN,
                    "{label} {x}mm 需要先进工艺（标准下限：{y}mm）",
                ),
            ),
            (
                re.compile(
                    rf"Annular ring (?P<x>{_NUMBER})mm below advanced minimum "
                    rf"\((?P<y>{_NUMBER})mm\)"
                ),
                "环宽 {x}mm 低于先进工艺下限（{y}mm）",
            ),
            (
                re.compile(
                    rf"Annular ring (?P<x>{_NUMBER})mm requires advanced "
                    rf"process \(standard: (?P<y>{_NUMBER})mm\)"
                ),
                "环宽 {x}mm 需要先进工艺（标准下限：{y}mm）",
            ),
            (
                re.compile(
                    rf"Board size (?P<w>{_NUMBER})x(?P<h>{_NUMBER})mm exceeds "
                    r"100x100mm pricing threshold"
                ),
                "板卡尺寸 {w}x{h}mm 超过 100x100mm 计价阈值",
            ),
            (
                re.compile(
                    rf"Board size (?P<w>{_NUMBER})x(?P<h>{_NUMBER})mm is very "
                    r"small — handling concerns"
                ),
                "板卡尺寸 {w}x{h}mm 过小，存在生产搬运风险",
            ),
        ],
        "description": [
            (
                re.compile(
                    rf"Track width (?P<x>{_NUMBER})mm is below the advanced "
                    rf"process minimum of (?P<y>{_NUMBER})mm, requiring a "
                    r"challenging fab tier\."
                ),
                "走线宽度 {x}mm 低于先进工艺下限 {y}mm，需要挑战级制造工艺。",
            ),
            (
                re.compile(
                    rf"Track width (?P<x>{_NUMBER})mm is below the standard "
                    rf"process minimum of (?P<y>{_NUMBER})mm, requiring an "
                    r"advanced fab tier\."
                ),
                "走线宽度 {x}mm 低于标准工艺下限 {y}mm，需要先进级制造工艺。",
            ),
            (
                re.compile(
                    rf"Approximate track spacing (?P<x>{_NUMBER})mm is below "
                    rf"the advanced process minimum of (?P<y>{_NUMBER})mm\."
                ),
                "近似走线间距 {x}mm 低于先进工艺下限 {y}mm。",
            ),
            (
                re.compile(
                    rf"Approximate track spacing (?P<x>{_NUMBER})mm requires "
                    rf"an advanced fab tier \(standard minimum: "
                    rf"(?P<y>{_NUMBER})mm\)\."
                ),
                "近似走线间距 {x}mm 需要先进级制造工艺（标准下限：{y}mm）。",
            ),
            (
                re.compile(
                    rf"{_DRILL_LABEL} (?P<x>{_NUMBER})mm"
                    r"(?P<reference> on \S+)? is below the advanced process "
                    rf"minimum of (?P<y>{_NUMBER})mm, requiring a challenging "
                    r"fab tier\."
                ),
                lambda match: _drill_description(match, "advanced"),
            ),
            (
                re.compile(
                    rf"{_DRILL_LABEL} (?P<x>{_NUMBER})mm"
                    r"(?P<reference> on \S+)? is below the standard process "
                    rf"minimum of (?P<y>{_NUMBER})mm, requiring an advanced "
                    r"fab tier\."
                ),
                lambda match: _drill_description(match, "standard"),
            ),
            (
                re.compile(
                    rf"Annular ring (?P<x>{_NUMBER})mm is below the advanced "
                    rf"process minimum of (?P<y>{_NUMBER})mm, requiring a "
                    r"challenging fab tier\."
                ),
                "环宽 {x}mm 低于先进工艺下限 {y}mm，需要挑战级制造工艺。",
            ),
            (
                re.compile(
                    rf"Annular ring (?P<x>{_NUMBER})mm is below the standard "
                    rf"process minimum of (?P<y>{_NUMBER})mm, requiring an "
                    r"advanced fab tier\."
                ),
                "环宽 {x}mm 低于标准工艺下限 {y}mm，需要先进级制造工艺。",
            ),
            (
                re.compile(
                    rf"Board size (?P<w>{_NUMBER})x(?P<h>{_NUMBER})mm exceeds "
                    r"the 100x100mm threshold, resulting in higher fabrication "
                    r"pricing at JLCPCB\."
                ),
                "板卡尺寸 {w}x{h}mm 超过 100x100mm 阈值，"
                "在 JLCPCB 会产生更高的制造价格。",
            ),
            (
                re.compile(
                    rf"Board size (?P<w>{_NUMBER})x(?P<h>{_NUMBER})mm is below "
                    r"the minimum dimension threshold, which may cause "
                    r"handling issues during fabrication\."
                ),
                "板卡尺寸 {w}x{h}mm 低于最小尺寸阈值，制造过程中可能出现搬运问题。",
            ),
        ],
        "recommendation": [
            (
                re.compile(
                    rf"Track width (?P<x>{_NUMBER})mm is below advanced "
                    rf"process minimum \((?P<y>{_NUMBER})mm\)"
                ),
                "走线宽度 {x}mm 低于先进工艺下限（{y}mm）",
            ),
            (
                re.compile(
                    rf"Track width (?P<x>{_NUMBER})mm requires advanced "
                    rf"process \(standard minimum: (?P<y>{_NUMBER})mm\)"
                ),
                "走线宽度 {x}mm 需要先进工艺（标准下限：{y}mm）",
            ),
            (
                re.compile(
                    rf"Approximate track spacing (?P<x>{_NUMBER})mm is below "
                    rf"advanced process minimum \((?P<y>{_NUMBER})mm\)"
                ),
                "近似走线间距 {x}mm 低于先进工艺下限（{y}mm）",
            ),
            (
                re.compile(
                    rf"Approximate track spacing (?P<x>{_NUMBER})mm requires "
                    rf"advanced process \(standard: (?P<y>{_NUMBER})mm\)"
                ),
                "近似走线间距 {x}mm 需要先进工艺（标准下限：{y}mm）",
            ),
            (
                re.compile(
                    rf"{_DRILL_LABEL} (?P<x>{_NUMBER})mm is below advanced "
                    rf"process minimum \((?P<y>{_NUMBER})mm\)"
                ),
                _mapped_template(
                    "label", _DRILL_LABEL_CN,
                    "{label} {x}mm 低于先进工艺下限（{y}mm）",
                ),
            ),
            (
                re.compile(
                    rf"{_DRILL_LABEL} (?P<x>{_NUMBER})mm requires advanced "
                    rf"process \(standard: (?P<y>{_NUMBER})mm\)"
                ),
                _mapped_template(
                    "label", _DRILL_LABEL_CN,
                    "{label} {x}mm 需要先进工艺（标准下限：{y}mm）",
                ),
            ),
            (
                re.compile(
                    rf"Annular ring (?P<x>{_NUMBER})mm is below advanced "
                    rf"process minimum \((?P<y>{_NUMBER})mm\)"
                ),
                "环宽 {x}mm 低于先进工艺下限（{y}mm）",
            ),
            (
                re.compile(
                    rf"Annular ring (?P<x>{_NUMBER})mm requires advanced "
                    rf"process \(standard: (?P<y>{_NUMBER})mm\)"
                ),
                "环宽 {x}mm 需要先进工艺（标准下限：{y}mm）",
            ),
            (
                re.compile(
                    rf"Board size (?P<w>{_NUMBER})x(?P<h>{_NUMBER})mm exceeds "
                    r"100x100mm — higher fabrication pricing tier at JLCPCB"
                ),
                "板卡尺寸 {w}x{h}mm 超过 100x100mm，JLCPCB 的价格档位更高",
            ),
            (
                re.compile(
                    rf"Board size (?P<w>{_NUMBER})x(?P<h>{_NUMBER})mm is very "
                    r"small — may have handling concerns during fabrication"
                ),
                "板卡尺寸 {w}x{h}mm 过小，制造过程中可能存在搬运风险",
            ),
        ],
    },
    ("dfm", "DFM-002"): {
        "summary": [
            (
                re.compile(
                    rf"Via annular ring (?P<x>{_NUMBER})mm below IPC Class "
                    rf"(?P<ipc_class>\d+) minimum (?P<y>{_NUMBER})mm"
                ),
                "过孔环宽 {x}mm 低于 IPC Class {ipc_class} 下限 {y}mm",
            ),
            (
                re.compile(
                    r"(?P<count>\d+) vias with annular ring breakout "
                    r"\(IPC Class 3 violation\)"
                ),
                "{count} 个过孔存在环宽破损（违反 IPC Class 3）",
            ),
            (
                re.compile(
                    r"(?P<count>\d+) via-in-pad instances require fill for "
                    r"IPC Class 3"
                ),
                "{count} 处盘中孔需要填充以满足 IPC Class 3",
            ),
        ],
        "description": [
            (
                re.compile(
                    rf"Via annular ring (?P<x>{_NUMBER})mm does not meet IPC "
                    rf"Class (?P<ipc_class>\d+) minimum of (?P<y>{_NUMBER})mm\."
                ),
                "过孔环宽 {x}mm 不满足 IPC Class {ipc_class} 的下限 {y}mm。",
            ),
            (
                re.compile(
                    r"(?P<count>\d+) vias have annular ring breakout, which "
                    r"is not allowed for IPC Class 3\."
                ),
                "{count} 个过孔存在环宽破损，IPC Class 3 不允许。",
            ),
            (
                re.compile(
                    r"(?P<count>\d+) via-in-pad instances detected; IPC "
                    r"Class 3 requires filled and plated-over via-in-pad\."
                ),
                "检测到 {count} 处盘中孔；IPC Class 3 要求盘中孔填充并盖镀。",
            ),
        ],
        "recommendation": [
            (
                re.compile(
                    rf"Increase via annular ring to at least "
                    rf"(?P<y>{_NUMBER})mm to meet IPC Class "
                    r"(?P<ipc_class>\d+) requirements"
                ),
                "将过孔环宽增加到至少 {y}mm，以满足 IPC Class {ipc_class} 要求",
            ),
            (
                re.compile(
                    r"Increase via annular ring to eliminate breakout for "
                    r"IPC Class 3 compliance"
                ),
                "增大过孔环宽以消除破损，满足 IPC Class 3 要求",
            ),
            (
                re.compile(
                    r"Ensure via-in-pad instances are filled and plated-over "
                    r"for IPC Class 3 compliance"
                ),
                "确保盘中孔已填充并盖镀，以满足 IPC Class 3 要求",
            ),
        ],
    },
}

# detector 级兜底：规则 ID 未收录时仍按已收录模板匹配；全部不匹配的英文串
# 会被标注「（检测器原文）」，不会静默透传。
_SPECS_BY_DETECTOR: dict[str, dict[str, list]] = {}
for (_detector, _rule_id), _spec in _SPECS.items():
    _merged = _SPECS_BY_DETECTOR.setdefault(_detector, {})
    for _field, _rules in _spec.items():
        _merged.setdefault(_field, []).extend(_rules)
