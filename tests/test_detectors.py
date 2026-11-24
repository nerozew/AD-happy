# tests/test_detectors.py
import json, sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT.parent / ".agents" / "skills" / "ad-happy" / "scripts"))
from adapter import AnalysisContext, to_context
from detectors import run_schematic


def ctx():
    return to_context(json.loads((ROOT / "fixtures" / "adapter-raw.json").read_text(encoding="utf-8")))


def empty_ctx(rails):
    """没有元件与网络的最小上下文，用于验证输入缺失时的状态。"""
    return AnalysisContext(
        components=[],
        nets={},
        lib_symbols={},
        pin_net={},
        known_power_rails=set(rails),
    )


def test_divider_detected():
    r = run_schematic(ctx())
    assert any(d for d in r["findings"] if d["detector"] == "voltage_divider")


def test_regulator_detected():
    r = run_schematic(ctx())
    assert any(d for d in r["findings"] if d["detector"] == "power_regulator")


def test_each_rule_has_status():
    r = run_schematic(ctx())
    assert set(r["status"]) >= {"voltage_divider", "rc_filter", "decoupling", "power_regulator", "connectivity", "shorted_component"}
    assert all(v in {"pass", "found", "not_evaluated", "failed"} for v in r["status"].values())


def test_zero_findings_not_reported_as_pass():
    r = run_schematic(ctx())
    assert r["status"]["decoupling"] == "not_evaluated"


def test_expected_finding_counts_on_fixture():
    r = run_schematic(ctx())
    counts = Counter(f["detector"] for f in r["findings"])
    assert counts == Counter({"voltage_divider": 1, "power_regulator": 1})


def test_expected_status_on_fixture():
    r = run_schematic(ctx())
    assert r["status"] == {
        "voltage_divider": "found",
        "rc_filter": "pass",
        "decoupling": "not_evaluated",
        "power_regulator": "found",
        "connectivity": "pass",
        "shorted_component": "pass",
    }


def test_findings_align_with_finding_schema():
    r = run_schematic(ctx())
    assert r["findings"]
    required = {
        "detector", "rule_id", "category", "summary", "description",
        "components", "nets", "pins", "severity", "confidence",
        "evidence_source", "recommendation", "report_context", "finding_id",
    }
    for finding in r["findings"]:
        assert required <= set(finding), finding
        assert finding["severity"] in {"error", "warning", "info"}
        assert finding["confidence"] in {"deterministic", "heuristic", "datasheet-backed"}
        assert finding["evidence_source"] in {
            "datasheet", "topology", "heuristic_rule", "symbol_footprint",
            "bom", "geometry", "api_lookup",
        }
    ids = [finding["finding_id"] for finding in r["findings"]]
    assert len(ids) == len(set(ids))


def test_decoupling_evaluated_with_two_rails_including_non_ground():
    r = run_schematic(empty_ctx({"GND", "+5V"}))
    assert r["status"]["decoupling"] == "pass"
    assert r["findings"] == []


def test_decoupling_not_evaluated_with_ground_rails_only():
    r = run_schematic(empty_ctx({"GND", "AGND"}))
    assert r["status"]["decoupling"] == "not_evaluated"


def test_missing_inputs_are_not_evaluated_not_pass():
    r = run_schematic(empty_ctx(set()))
    assert set(r["status"].values()) == {"not_evaluated"}


def test_rc_filter_not_evaluated_without_capacitors():
    context = AnalysisContext(
        components=[{
            "reference": "R1", "value": "10k", "type": "resistor",
            "lib_id": "AD:Resistor", "footprint": "", "properties": {},
            "pins": [
                {"number": "1", "name": "1", "type": "passive", "x": 0, "y": 0},
                {"number": "2", "name": "2", "type": "passive", "x": 0, "y": 0},
            ],
        }],
        nets={},
        lib_symbols={},
        pin_net={},
    )
    r = run_schematic(context)
    assert r["status"]["rc_filter"] == "not_evaluated"
    assert context.parsed_values["R1"] == 10000.0


def _connectivity_ctx():
    """U1.1/U1.2 同时驱动 N1，U1.3 悬空：覆盖 connectivity 的原始列表。"""
    net_n1 = {"pins": [
        {"component": "U1", "pin_number": "1", "pin_name": "OUT1",
         "pin_type": "output", "x": 0, "y": 0},
        {"component": "U1", "pin_number": "2", "pin_name": "OUT2",
         "pin_type": "output", "x": 0, "y": 0},
    ]}
    return AnalysisContext(
        components=[{
            "reference": "U1", "value": "TESTIC", "type": "ic",
            "lib_id": "AD:TESTIC", "footprint": "", "properties": {},
            "pins": [
                {"number": "1", "name": "OUT1", "type": "output", "x": 0, "y": 0},
                {"number": "2", "name": "OUT2", "type": "output", "x": 0, "y": 0},
                {"number": "3", "name": "NC", "type": "input", "x": 0, "y": 0},
            ],
        }],
        nets={"N1": net_n1},
        lib_symbols={},
        pin_net={("U1", "1"): ("N1", net_n1), ("U1", "2"): ("N1", net_n1)},
        known_power_rails={"GND", "+5V"},
    )


def test_connectivity_raw_lists_become_findings():
    r = run_schematic(_connectivity_ctx())
    assert r["status"]["connectivity"] == "found"
    findings = {
        finding["rule_id"]: finding
        for finding in r["findings"]
        if finding["detector"] == "connectivity"
    }
    assert set(findings) == {"NT-002", "NT-003"}
    assert findings["NT-002"]["pins"] == ["U1.3"]
    assert findings["NT-003"]["nets"] == ["N1"]
    # 有两条电源轨（含非地网络）时去耦规则可评估。
    assert r["status"]["decoupling"] == "pass"


def _no_erc_ctx():
    """U1.1 悬空但带 No-ERC 标记，应被 analyze_connectivity 抑制。"""
    return AnalysisContext(
        components=[{
            "reference": "U1", "value": "TESTIC", "type": "ic",
            "lib_id": "AD:TESTIC", "footprint": "", "properties": {},
            "pins": [
                {"number": "1", "name": "NC", "type": "passive",
                 "x": 10.0, "y": 5.0},
            ],
        }],
        nets={},
        lib_symbols={},
        pin_net={},
        no_connects=[{"x": 10.0, "y": 5.0}],
    )


def test_no_erc_suppresses_unconnected_pin_finding():
    r = run_schematic(_no_erc_ctx())
    assert r["status"]["connectivity"] == "pass"
    assert not any(
        finding["rule_id"] == "NT-002" for finding in r["findings"]
    )


def test_rule_exception_marks_failed_and_reports(monkeypatch):
    import detectors

    def boom(_ctx):
        raise RuntimeError("boom")

    monkeypatch.setattr(detectors, "detect_shorted_two_pin_components", boom)
    r = run_schematic(ctx())
    assert r["status"]["shorted_component"] == "failed"
    failed = [f for f in r["findings"] if f["detector"] == "shorted_component"]
    assert len(failed) == 1
    assert "boom" in failed[0]["summary"] + failed[0]["description"]
    # 其余规则不受影响
    assert r["status"]["voltage_divider"] == "found"
