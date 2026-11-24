# tests/test_pcb_detectors.py
import json
import sys
from collections import Counter
from pathlib import Path

import pytest

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT.parent / ".agents" / "skills" / "ad-happy" / "scripts"))
import pcb_detectors
from pcb_detectors import run_pcb

PCB = json.loads((ROOT / "fixtures" / "pcb.json").read_text(encoding="utf-8"))


def test_units_are_mm():
    # 板框 24.54 x 12.57 mm；若误用 x0.254 会变成 245.4
    assert 20 < PCB["outline"]["widthMm"] < 30


def test_net_zero_is_real():
    assert PCB["nets"][0] == "SW"


def test_tracks_are_copper_only():
    assert len(PCB["tracks"]) == 40


def test_dfm_runs():
    r = run_pcb(PCB)
    assert "dfm" in r["status"]
    assert r["status"]["dfm"] in {"pass", "found", "not_evaluated"}


def test_pad_distance_reported():
    r = run_pcb(PCB)
    assert any("pad_distance" in k for k in r["status"])


def test_each_rule_has_status():
    r = run_pcb(PCB)
    assert set(r["status"]) == {
        "dfm",
        "pad_distance",
        "current_capacity",
        "decoupling_placement",
    }
    assert all(
        value in {"pass", "found", "partial", "not_evaluated", "failed"}
        for value in r["status"].values()
    )


def test_expected_status_on_fixture():
    # GND 只有过孔、没有铜走线；铺铜区不在快照里，载流规则无法完整评估
    # （见 not_evaluated 的降级规则），不能当成 pass。
    r = run_pcb(PCB)
    assert r["status"] == {
        "dfm": "pass",
        "pad_distance": "found",
        "current_capacity": "not_evaluated",
        "decoupling_placement": "found",
    }


def test_expected_findings_on_fixture():
    r = run_pcb(PCB)
    counts = Counter(finding["detector"] for finding in r["findings"])
    # DFM 0 违规；焊盘间距按网络聚合为 2 条事实；去耦摆放 1 条 info。
    assert counts == Counter({"pad_distance": 2, "decoupling_placement": 1})


def test_facts_are_separated_from_issues():
    r = run_pcb(PCB)
    for finding in r["findings"]:
        assert finding["kind"] in {"fact", "issue"}
        if finding["detector"] in {"pad_distance", "decoupling_placement"}:
            assert finding["kind"] == "fact"


def test_pad_distance_keeps_measured_facts():
    r = run_pcb(PCB)
    finding = next(f for f in r["findings"] if f["detector"] == "pad_distance")
    assert {"routed_distance_mm", "euclidean_distance_mm", "ratio"} <= set(finding)
    assert finding["severity"] == "info"
    assert finding["nets"]
    # 每个网络一条：FB 有 3 对、NetC1_1 有 1 对，聚合后仍保留代表值。
    assert finding["pair_count"] >= 1
    assert finding["min_routed_distance_mm"] <= finding["max_routed_distance_mm"]
    assert finding["max_ratio"] >= 1.0
    assert isinstance(finding["anomalies"], list)


def test_dfm_sees_millimetres(monkeypatch):
    captured = {}

    def spy(footprints, tracks, vias, board_outline, *args, **kwargs):
        captured.update(
            footprints=footprints,
            tracks=tracks,
            vias=vias,
            board_outline=board_outline,
        )
        return {"dfm_tier": "standard", "violation_count": 0, "metrics": {}}

    monkeypatch.setattr(pcb_detectors, "analyze_dfm", spy)
    r = run_pcb(PCB)

    assert r["status"]["dfm"] == "pass"
    segments = captured["tracks"]["segments"]
    assert len(segments) == 40
    # 10 mil -> 0.254 mm；若忘了换算，DFM 会看到 10（被当成 10 mm）。
    assert all(seg["width"] == pytest.approx(0.254) for seg in segments)
    assert captured["vias"]["count"] == 19
    assert all(
        via["size"] == pytest.approx(23.622 * 0.0254)
        for via in captured["vias"]["vias"]
    )
    assert all(
        via["drill"] == pytest.approx(11.811 * 0.0254)
        for via in captured["vias"]["vias"]
    )
    assert captured["board_outline"]["bounding_box"]["width"] == pytest.approx(
        PCB["outline"]["widthMm"]
    )


def test_net_offset_applied_once(monkeypatch):
    captured = {}

    def spy(footprints, tracks, vias, net_names):
        captured.update(footprints=footprints, tracks=tracks, net_names=net_names)
        return {}

    monkeypatch.setattr(pcb_detectors, "analyze_pad_to_pad_distances", spy)
    run_pcb(PCB)

    # 快照 netIndex 0（SW）在检测器输入里是 1；0 只表示无网络。
    assert captured["net_names"][0] == ""
    assert captured["net_names"][1] == "SW"
    assert captured["net_names"][5] == "GND"
    assert all(seg["net"] >= 1 for seg in captured["tracks"]["segments"])
    sw_pads = [
        pad
        for footprint in captured["footprints"]
        for pad in footprint["pads"]
        if pad["net_name"] == "SW"
    ]
    # 若 +1 偏移被应用两次，这里会是 2；若没应用，会是 0。
    assert sw_pads
    assert all(pad["net_number"] == 1 for pad in sw_pads)


def test_unowned_net_maps_to_zero():
    # 快照用 -1 表示无网络，+1 后正好落到 KiCad 的 0。
    assert pcb_detectors._net_id(-1) == 0
    assert pcb_detectors._net_id(0) == 1


def test_missing_copper_is_not_evaluated():
    pcb = json.loads(json.dumps(PCB))
    pcb["tracks"] = []
    pcb["vias"] = []
    pcb["arcs"] = []
    r = run_pcb(pcb)
    assert r["status"]["dfm"] == "not_evaluated"
    assert r["status"]["pad_distance"] == "not_evaluated"
    assert r["status"]["current_capacity"] == "not_evaluated"
    # 去耦摆放只依赖元件与焊盘，仍应照常评估。
    assert r["status"]["decoupling_placement"] == "found"
    assert any(
        check["rule"] == "dfm" and check["check"] == "copper"
        for check in r["coverage"]["skippedChecks"]
    )


def test_dfm_annular_ring_check_runs_with_via_diameter():
    # 外径 23.622 mil、钻孔 11.811 mil -> 环宽 5.9055 mil = 0.15 mm。
    data = pcb_detectors._compile(PCB)
    result = pcb_detectors.analyze_dfm(
        data["footprints"], data["tracks"], data["vias"], data["outline"],
    )
    assert abs(result["metrics"]["min_annular_ring_mm"] - 0.15) < 1e-3
    # 最小钻孔来自过孔（0.3 mm），不是 4 个 PTH 焊盘（1.0999 mm）。
    assert result["metrics"]["min_drill_mm"] == pytest.approx(11.811 * 0.0254)


def test_dfm_partial_when_subchecks_skipped():
    pcb = json.loads(json.dumps(PCB))
    for via in pcb["vias"]:
        via.pop("diameterMil", None)
    for pad in pcb["pads"]:
        pad.pop("drillMil", None)
        pad.pop("plated", None)
        pad.pop("type", None)
    r = run_pcb(pcb)
    assert r["status"]["dfm"] == "partial"
    checks = {
        check["check"]
        for check in r["coverage"]["skippedChecks"]
        if check["rule"] == "dfm"
    }
    assert {"via_annular_ring", "pth_pad_drill"} <= checks


def test_rule_failure_is_visible(monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(pcb_detectors, "analyze_dfm", boom)
    r = run_pcb(PCB)

    assert r["status"]["dfm"] == "failed"
    # 单条规则失败不影响其他规则。
    assert r["status"]["pad_distance"] == "found"
    failure = next(f for f in r["findings"] if f["detector"] == "dfm")
    assert failure["rule_id"] == "DET-ERR"
    assert failure["severity"] == "error"
    assert "boom" in failure["summary"]


def test_findings_align_with_finding_schema():
    r = run_pcb(PCB)
    assert r["findings"]
    required = {
        "detector",
        "rule_id",
        "category",
        "summary",
        "description",
        "components",
        "nets",
        "pins",
        "severity",
        "confidence",
        "evidence_source",
        "recommendation",
        "report_context",
        "finding_id",
    }
    for finding in r["findings"]:
        assert required <= set(finding), finding
        assert finding["severity"] in {"error", "warning", "info"}
        assert finding["confidence"] in {
            "deterministic",
            "heuristic",
            "datasheet-backed",
        }
        assert finding["evidence_source"] in {
            "datasheet",
            "topology",
            "heuristic_rule",
            "symbol_footprint",
            "bom",
            "geometry",
            "api_lookup",
        }
    ids = [finding["finding_id"] for finding in r["findings"]]
    assert len(ids) == len(set(ids))
