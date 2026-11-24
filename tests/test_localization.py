# tests/test_localization.py
# finding 文案本地化：上游 kicad-happy 的英文文本必须变成中文，
# rule_id / detector / 字段名与 finding_id 保持原样。
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT.parent / ".agents" / "skills" / "ad-happy" / "scripts"))

from localization import localize_finding  # noqa: E402
from pipeline import run  # noqa: E402

RAW = json.loads((ROOT / "fixtures" / "adapter-raw.json").read_text(encoding="utf-8"))
PCB = json.loads((ROOT / "fixtures" / "pcb.json").read_text(encoding="utf-8"))

# 不应再出现在报告可见文本里的上游英文短语。
ENGLISH_PHRASES = (
    "Voltage divider",
    "Resistive voltage divider",
    "Power regulator",
    "Regulator ",
    "Power net ",
    "min trace",
    "Single-pin net",
    "Track width",
    "Track spacing",
    "Annular ring",
    "Decoupling on ",
)


def _letter_stats(text):
    letters = [char for char in text if char.isalpha()]
    ascii_letters = [char for char in letters if char.isascii()]
    return len(letters), len(ascii_letters)


def _visible_texts(finding):
    """与 report.mjs 的取值一致：title 优先 summary，evidence 优先 description。"""
    return [
        text
        for text in (
            finding.get("title") or finding.get("summary"),
            finding.get("evidence") or finding.get("description"),
        )
        if text
    ]


def test_fixture_findings_are_chinese():
    findings = run(RAW, PCB)["findings"]
    assert findings
    for finding in findings:
        for text in _visible_texts(finding):
            letters, ascii_letters = _letter_stats(text)
            assert any("一" <= char <= "鿿" for char in text), text
            if letters:
                assert ascii_letters / letters < 0.5, text
            assert "（检测器原文）" not in text, text
            for phrase in ENGLISH_PHRASES:
                assert phrase not in text, (phrase, text)


def test_fixture_keeps_rule_identity_and_source_text():
    findings = {
        finding["rule_id"]: finding
        for finding in run(RAW, PCB)["findings"]
        if finding["rule_id"] in {"VD-DET", "PR-DET"}
    }
    divider = findings["VD-DET"]
    assert divider["detector"] == "voltage_divider"
    assert divider["summary"] == "分压器 R1/R2"
    assert divider["description"] == "检测到电阻分压器"
    assert divider["source_text"] == {
        "summary": "Voltage divider R1/R2",
        "description": "Resistive voltage divider detected",
    }
    regulator = findings["PR-DET"]
    assert regulator["detector"] == "power_regulator"
    assert regulator["summary"] == "稳压器 IC1（开关型）"
    assert regulator["description"] == "检测到电源稳压器（开关型）"


@pytest.mark.parametrize(
    ("finding", "expected"),
    [
        (
            {
                "detector": "rc_filter",
                "rule_id": "RC-DET",
                "summary": "RC filter R3/C4 at 1234.5Hz",
                "description": "low-pass RC filter",
            },
            {
                "summary": "RC 滤波器 R3/C4，截止频率 1234.5Hz",
                "description": "低通 RC 滤波器",
            },
        ),
        (
            {
                "detector": "decoupling",
                "rule_id": "DC-DET",
                "summary": "Decoupling on +3V3",
                "description": "Decoupling capacitors on power rail +3V3",
            },
            {
                "summary": "+3V3 去耦",
                "description": "电源轨 +3V3 上的去耦电容",
            },
        ),
        (
            {
                "detector": "connectivity",
                "rule_id": "NT-001",
                "summary": "Single-pin net: U1.VCC only connects to U1.7 (VCC) (power_in)",
                "description": (
                    "Net 'N1' has exactly one pin: U1.7 (VCC), "
                    "pin_type='power_in'. Verify the intended target — if this "
                    "pin should connect somewhere, the wire/label is missing."
                ),
                "recommendation": (
                    "Check the schematic at the referenced pin — add the "
                    "missing wire or place a no-connect marker if the pin is "
                    "intentionally floating."
                ),
            },
            {
                "summary": "单引脚网络：U1.VCC 仅连接 U1.7 (VCC)（power_in）",
                "description": (
                    "网络 'N1' 只有一个引脚：U1.7 (VCC)，pin_type='power_in'。"
                    "请核对预期连接目标：若该引脚本应连接，说明缺少导线或网络标签。"
                ),
                "recommendation": (
                    "在对应引脚处检查原理图：补上缺失的导线；若该引脚有意悬空，"
                    "请放置 No-ERC 标记。"
                ),
            },
        ),
        (
            {
                "detector": "shorted_component",
                "rule_id": "SP-001",
                "summary": "C7 (100n) has both pins on net 'GND' -- the component is shorted out and has no effect",
                "description": (
                    "C7 is a capacitor with pin 1 and pin 2 both connected to "
                    "'GND'. Current bypasses the part entirely, so it "
                    "contributes nothing to the circuit. ERC and DRC pass on "
                    "this: every pin is connected and the netlist is "
                    "internally consistent, so only intent distinguishes it "
                    "from a deliberate link. Jumpers, net ties, zero-ohm links "
                    "and DNP parts are excluded from this check."
                ),
                "recommendation": (
                    "Confirm C7 is meant to bridge 'GND'. If not, one pin is on "
                    "the wrong net -- check which node it should reach."
                ),
            },
            {
                "summary": "C7（100n）的两个引脚都连接在网络 “GND” 上，元件被短路，不起作用",
                "description": (
                    "C7 是电容，引脚 1 与引脚 2 都连接在网络 “GND” 上。"
                    "电流完全绕过该元件，因此它对电路没有任何作用。ERC 与 DRC "
                    "都会通过：所有引脚均已连接、网表内部一致，只能靠设计意图区分"
                    "它与有意设置的连接。跳线、网络连接点（net tie）、零欧姆连接和 "
                    "DNP 元件不在本检查范围内。"
                ),
                "recommendation": (
                    "确认 C7 是否设计为桥接 “GND”。若不是，说明有一个引脚接错网络，"
                    "请检查它应连接到的节点。"
                ),
            },
        ),
        (
            {
                "detector": "current_capacity",
                "rule_id": "CC-DET",
                "summary": "Power net GND: 0.254mm min trace",
                "description": (
                    "Power/ground net GND: min trace 0.254mm, max 0.254mm, "
                    "24 segments."
                ),
            },
            {
                "summary": "电源网络 GND：最小走线 0.254mm",
                "description": "电源/地网络 GND：最小走线 0.254mm，最大 0.254mm，共 24 条线段。",
            },
        ),
        (
            {
                "detector": "current_capacity",
                "rule_id": "CC-002",
                "summary": "Narrow signal: SIG1 min 0.12mm",
                "description": "Signal net SIG1 has narrow traces: min 0.12mm across 8 segments.",
                "recommendation": "Widen trace or verify signal integrity requirements.",
            },
            {
                "summary": "窄信号走线：SIG1 最小 0.12mm",
                "description": "信号网络 SIG1 的走线过窄：8 条线段中最小宽度 0.12mm。",
                "recommendation": "加宽走线，或确认信号完整性要求可以接受。",
            },
        ),
        (
            {
                "detector": "dfm",
                "rule_id": "DFM-001",
                "summary": "Track width 0.09mm below advanced minimum (0.1mm)",
                "description": (
                    "Track width 0.09mm is below the advanced process minimum "
                    "of 0.1mm, requiring a challenging fab tier."
                ),
                "recommendation": "Track width 0.09mm is below advanced process minimum (0.1mm)",
            },
            {
                "summary": "走线宽度 0.09mm 低于先进工艺下限（0.1mm）",
                "description": "走线宽度 0.09mm 低于先进工艺下限 0.1mm，需要挑战级制造工艺。",
                "recommendation": "走线宽度 0.09mm 低于先进工艺下限（0.1mm）",
            },
        ),
        (
            {
                "detector": "dfm",
                "rule_id": "DFM-001",
                "summary": "Drill 0.15mm below advanced minimum (0.15mm)",
                "description": (
                    "Drill 0.15mm on U1 is below the advanced process minimum "
                    "of 0.15mm, requiring a challenging fab tier."
                ),
                "recommendation": "Drill 0.15mm is below advanced process minimum (0.15mm)",
            },
            {
                "summary": "钻孔 0.15mm 低于先进工艺下限（0.15mm）",
                "description": "钻孔 0.15mm（焊盘 U1）低于先进工艺下限 0.15mm，需要挑战级制造工艺。",
                "recommendation": "钻孔 0.15mm 低于先进工艺下限（0.15mm）",
            },
        ),
    ],
)
def test_detector_templates_translate_dynamic_parts(finding, expected):
    original = dict(finding)
    localize_finding(finding)
    for field, text in expected.items():
        assert finding[field] == text
        assert finding["source_text"][field] == original[field]


def test_unknown_english_is_marked_not_passed_through():
    finding = {
        "detector": "voltage_divider",
        "rule_id": "VD-DET",
        "summary": "A previously unseen detector sentence",
        "description": "检测到电阻分压器",
    }
    localize_finding(finding)
    assert finding["summary"] == "（检测器原文）A previously unseen detector sentence"
    assert finding["description"] == "检测到电阻分压器"
    assert finding["source_text"] == {
        "summary": "A previously unseen detector sentence",
    }


def test_det_err_is_not_treated_as_upstream_text():
    finding = {
        "detector": "dfm",
        "rule_id": "DET-ERR",
        "summary": "dfm 检测器执行失败：RuntimeError: boom",
        "description": "检测器 dfm 执行时抛出异常，本条规则已标记为 failed。",
    }
    localize_finding(finding)
    assert finding["summary"].startswith("dfm 检测器执行失败")
    assert "source_text" not in finding


def test_non_authored_detectors_are_untouched():
    finding = {
        "detector": "pad_distance",
        "rule_id": "PD-DET",
        "summary": "网络 FB：3 对焊盘间实测走线距离 2.16–5.126 mm。",
        "description": "这是实测事实，不是违规。",
    }
    localize_finding(finding)
    assert "source_text" not in finding
    assert finding["summary"].startswith("网络 FB")
