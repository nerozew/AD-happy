# tests/test_pipeline.py
# Python 侧唯一入口 pipeline.py 的契约测试：合并三组规则的 findings/status/coverage。
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent
SCRIPT = ROOT.parent / ".agents" / "skills" / "ad-happy" / "scripts" / "pipeline.py"
RAW = ROOT / "fixtures" / "adapter-raw.json"
PCB = ROOT / "fixtures" / "pcb.json"

ALL_RULES = {
    "voltage_divider",
    "rc_filter",
    "decoupling",
    "power_regulator",
    "connectivity",
    "shorted_component",
    "dfm",
    "pad_distance",
    "current_capacity",
    "decoupling_placement",
    "pin_pad",
}
STATUSES = {"pass", "found", "not_evaluated", "failed"}


def _run(out_dir, raw=RAW, pcb=PCB):
    return subprocess.run(
        [
            sys.executable,
            # 与 analyze.mjs 保持一致：Windows 管道下输出固定为 UTF-8。
            "-X",
            "utf8",
            str(SCRIPT),
            "--raw",
            str(raw),
            "--pcb",
            str(pcb),
            "--out",
            str(out_dir),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def test_pipeline_writes_findings_and_pipeline_summary(tmp_path):
    result = _run(tmp_path)
    assert result.returncode == 0, result.stderr

    findings = json.loads((tmp_path / "findings.json").read_text(encoding="utf-8"))
    summary = json.loads(
        (tmp_path / "pipeline-summary.json").read_text(encoding="utf-8")
    )

    assert set(summary) == {"findings", "status", "coverage"}
    assert summary["findings"] == findings
    # 2 条原理图发现 + 2 条焊盘间距事实（按网络聚合）+ 1 条去耦摆放事实。
    assert len(findings) == 5
    assert set(summary["status"]) == ALL_RULES
    assert set(summary["status"].values()) <= STATUSES
    assert summary["status"]["pin_pad"] == "pass"
    # 三组规则的 finding 由 pipeline 合并，finding_id 互不冲突。
    finding_ids = [finding.get("finding_id") for finding in findings]
    assert all(finding_ids)
    assert len(set(finding_ids)) == len(finding_ids)
    # coverage 来自 cross_check，Node 侧用它生成概览。
    assert summary["coverage"]["compared"] == 22
    assert summary["coverage"]["exact"] == 22


def test_pipeline_merges_schematic_and_pcb_findings(tmp_path):
    result = _run(tmp_path)
    assert result.returncode == 0, result.stderr

    findings = json.loads((tmp_path / "findings.json").read_text(encoding="utf-8"))
    detectors = {finding.get("detector") for finding in findings}
    assert "voltage_divider" in detectors
    assert "power_regulator" in detectors
    assert "pad_distance" in detectors
    assert "decoupling_placement" in detectors

    summary = json.loads(
        (tmp_path / "pipeline-summary.json").read_text(encoding="utf-8")
    )
    assert summary["status"]["voltage_divider"] == "found"
    assert summary["status"]["dfm"] == "pass"


def test_pipeline_fails_loudly_on_invalid_raw_json(tmp_path):
    bad_raw = tmp_path / "raw.json"
    bad_raw.write_text("{not json", encoding="utf-8")
    out_dir = tmp_path / "out"

    result = _run(out_dir, raw=bad_raw)

    assert result.returncode != 0
    assert "raw" in result.stderr.lower()
    assert not (out_dir / "findings.json").exists()
    assert not (out_dir / "pipeline-summary.json").exists()
