# tests/test_crosscheck.py
# 跨域交叉检查（原理图 pinNet × PCB 焊盘网络）的行为测试。
import copy
import json
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT.parent / ".agents" / "skills" / "ad-happy" / "scripts"))
from adapter import to_context
from crosscheck import cross_check

RAW = json.loads((ROOT / "fixtures" / "adapter-raw.json").read_text(encoding="utf-8"))
PCB = json.loads((ROOT / "fixtures" / "pcb.json").read_text(encoding="utf-8"))
# 负向夹具是 RAW 的副本：IC1.3 的网络由 IN 改为 OUT，
# 且 pinNet 与 nets.nets 两处结构同步修改，模拟「原理图改了、PCB 没跟上」。
NEG_RAW = json.loads(
    (ROOT / "fixtures" / "negative" / "adapter-raw.json").read_text(encoding="utf-8")
)

STATUSES = {"pass", "found", "not_evaluated", "failed"}


def test_positive_sample_is_consistent():
    r = cross_check(to_context(RAW), PCB)
    assert r["status"]["pin_pad"] == "pass"


def test_negative_sample_detects_mismatch():
    r = cross_check(to_context(NEG_RAW), PCB)
    assert r["status"]["pin_pad"] == "found"
    # 只改了一个引脚，只应报一条；其余 21 对不能有噪音。
    assert len(r["findings"]) == 1
    assert any(f["rule_id"].startswith("XP-") for f in r["findings"])


def test_negative_finding_carries_both_sides():
    # 一条不可操作的 "mismatch" 没有价值：必须同时带上两侧网络、位号、引脚号。
    r = cross_check(to_context(NEG_RAW), PCB)
    finding = next(
        f
        for f in r["findings"]
        if f["rule_id"] == "XP-001" and f["components"] == ["IC1"]
    )
    assert finding["pins"] == ["IC1.3"]
    assert finding["schematic_net"] == "OUT"
    assert finding["pcb_net"] == "IN"
    assert set(finding["nets"]) == {"OUT", "IN"}
    assert finding["severity"] == "error"
    assert finding["match_mode"] == "pin_number"
    assert "IC1.3" in finding["summary"]
    assert "OUT" in finding["summary"] and "IN" in finding["summary"]


def test_positive_compares_all_pins_and_aliases_unnamed_net():
    # 原理图 __unnamed_1 与 PCB NetC1_1 名称不同但连接成员一致（IC1.6/C1.1），
    # 不能只按网络名比较，否则会误报 2 条。
    r = cross_check(to_context(RAW), PCB)
    assert r["findings"] == []
    assert r["coverage"]["compared"] == 22
    # 锁住主匹配路径：22 对全部按 (位号, 引脚号) 命中，没有走降级分支。
    assert r["coverage"]["exact"] == 22
    assert r["coverage"]["by_net_name"] == 0
    aliases = {
        (alias["schematic_net"], alias["pcb_net"])
        for alias in r["coverage"]["net_aliases"]
    }
    assert ("__unnamed_1", "NetC1_1") in aliases


def test_findings_align_with_finding_schema():
    r = cross_check(to_context(NEG_RAW), PCB)
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
        assert finding["rule_id"].startswith("XP-")
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


def test_pad_name_mismatch_falls_back_to_net_name():
    # PCB 焊盘名（A1/A2）与原理图引脚号（1/2）不一致时，按网络名比对。
    ctx = SimpleNamespace(
        pin_net={("U1", "1"): ("VCC", {}), ("U1", "2"): ("GND", {})},
        nets={
            "VCC": {"pins": [{"component": "U1", "pin_number": "1"}]},
            "GND": {"pins": [{"component": "U1", "pin_number": "2"}]},
        },
    )
    pcb = {
        "components": [{"reference": "U1"}],
        "pads": [
            {"componentIndex": 0, "name": "A1", "netIndex": 0},
            {"componentIndex": 0, "name": "A2", "netIndex": 1},
        ],
        "nets": ["VCC", "GND"],
    }
    r = cross_check(ctx, pcb)
    assert r["status"]["pin_pad"] == "pass"
    assert r["coverage"]["compared"] == 2
    assert r["coverage"]["by_net_name"] == 2


def test_name_fallback_finding_notes_name_matching():
    # 焊盘名不一致且网络名也对不上：必须生成带「按名称匹配」说明的 XP finding，
    # 并带焊盘号与 PCB 网络；未映射焊盘单独列出，不能混成网络不一致。
    ctx = SimpleNamespace(
        pin_net={("U1", "1"): ("VCC", {}), ("U1", "2"): ("GND", {})},
        nets={
            "VCC": {"pins": [{"component": "U1", "pin_number": "1"}]},
            "GND": {"pins": [{"component": "U1", "pin_number": "2"}]},
        },
    )
    pcb = {
        "components": [{"reference": "U1"}],
        "pads": [
            {"componentIndex": 0, "name": "A1", "netIndex": 0},
            {"componentIndex": 0, "name": "A2", "netIndex": 0},
            {"componentIndex": 0, "name": "A3", "netIndex": -1},
        ],
        "nets": ["GND"],
    }
    r = cross_check(ctx, pcb)
    assert r["status"]["pin_pad"] == "found"
    finding = next(f for f in r["findings"] if f["pins"] == ["U1.1"])
    assert finding["rule_id"].startswith("XP-")
    assert "按名称匹配" in finding["summary"]
    assert finding["match_mode"] == "name"
    assert finding["schematic_net"] == "VCC"
    assert finding["pcb_net"] == "GND"
    assert set(finding["pad_number"].split("/")) == {"A1", "A2"}
    assert finding["pcb_nets"] == ["GND"]
    assert finding["unmapped_pads"] == ["A3"]
    assert {entry["number"] for entry in finding["pcb_pads"]} == {"A1", "A2", "A3"}
    skipped = [
        item for item in r["coverage"]["skipped"] if item.get("pad") == "A3"
    ]
    assert skipped and "netIndex" in skipped[0]["reason"]


def test_missing_or_unmapped_pads_are_not_mismatches():
    # 评审反例：原理图 U1.1=VCC，PCB 只有焊盘 A1 且 netIndex=-1。
    # 这是数据缺口，不能生成 XP-001，也不能计为已比对。
    ctx = SimpleNamespace(
        pin_net={("U1", "1"): ("VCC", {})},
        nets={"VCC": {"pins": [{"component": "U1", "pin_number": "1"}]}},
    )
    cases = [
        ([], [], "无焊盘"),
        ([{"componentIndex": 0, "name": "A1", "netIndex": -1}], [], "netIndex"),
    ]
    for pads, nets, expected_reason in cases:
        r = cross_check(
            ctx,
            {"components": [{"reference": "U1"}], "pads": pads, "nets": nets},
        )
        assert r["status"]["pin_pad"] == "not_evaluated"
        assert r["findings"] == []
        assert r["coverage"]["compared"] == 0
        assert expected_reason in r["coverage"]["skipped"][0]["reason"]


def test_unmapped_pad_net_is_skipped_and_reported():
    # Task 3 把 PcbDoc 的 65535 映射成 -1；这类焊盘不参与比对，但必须留痕。
    pcb = copy.deepcopy(PCB)
    pad = next(
        p for p in pcb["pads"]
        if p["componentIndex"] == 1 and p["name"] == "2"  # R2.2（FB）
    )
    pad["netIndex"] = -1

    r = cross_check(to_context(RAW), pcb)
    assert r["status"]["pin_pad"] == "pass"
    assert r["coverage"]["compared"] == 21
    skipped = {(item["reference"], item["pin"]) for item in r["coverage"]["skipped"]}
    assert ("R2", "2") in skipped
    reason = next(
        item["reason"]
        for item in r["coverage"]["skipped"]
        if (item["reference"], item["pin"]) == ("R2", "2")
    )
    assert "netIndex" in reason


def test_rule_failure_is_visible():
    bad_pcb = {
        "components": [{"reference": "IC1"}],
        "pads": ["not-a-pad"],
        "nets": ["X"],
    }
    r = cross_check(to_context(RAW), bad_pcb)
    assert r["status"]["pin_pad"] == "failed"
    failure = next(f for f in r["findings"] if f["rule_id"] == "DET-ERR")
    assert failure["severity"] == "error"
    assert "AttributeError" in failure["summary"]


def test_empty_inputs_are_not_evaluated():
    ctx = SimpleNamespace(pin_net={}, nets={})
    r = cross_check(ctx, {"components": [], "pads": [], "nets": []})
    assert r["status"]["pin_pad"] == "not_evaluated"
    assert r["findings"] == []


def test_status_vocabulary_is_restricted():
    results = [
        cross_check(to_context(RAW), PCB),
        cross_check(to_context(NEG_RAW), PCB),
        cross_check(SimpleNamespace(pin_net={}, nets={}), {"components": [], "pads": [], "nets": []}),
        cross_check(
            to_context(RAW),
            {"components": [{"reference": "IC1"}], "pads": ["bad"], "nets": []},
        ),
    ]
    for result in results:
        assert set(result["status"]) == {"pin_pad"}
        assert result["status"]["pin_pad"] in STATUSES
