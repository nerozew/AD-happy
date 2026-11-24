# tests/test_mcp_client.py
# AD-MCP stdio 桥的契约测试：请求校验、与桩服务器的端到端调用、
# 工具失败与协议错误的结构化返回。
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parent
SKILL = ROOT.parent / ".agents" / "skills" / "ad-happy"
BRIDGE = SKILL / "scripts" / "ad" / "mcp_client.py"
STUB = ROOT / "fixtures" / "ad-mcp-stub" / "server" / "main.py"

sys.path.insert(0, str(SKILL / "scripts" / "ad"))

import mcp_client  # noqa: E402


def _request(calls, altium_home, **server_extra):
    server = {
        "python": sys.executable,
        "main": str(STUB),
        "cwd": str(STUB.parent.parent),
        "altiumHome": str(altium_home),
        **server_extra,
    }
    return {"server": server, "startupTimeoutMs": 30000, "calls": calls}


def _run_bridge(request, tmp_path):
    request_path = tmp_path / "request.json"
    request_path.write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
    result = subprocess.run(
        [sys.executable, "-B", "-X", "utf8", str(BRIDGE), "--request", str(request_path)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_load_request_rejects_bad_json():
    with pytest.raises(mcp_client.RequestError):
        mcp_client.load_request("not json")


def test_load_request_rejects_unknown_tool():
    with pytest.raises(mcp_client.RequestError):
        mcp_client.load_request(json.dumps({
            "server": {"python": "python", "main": str(STUB)},
            "calls": [{"id": "x", "tool": "delete_everything", "arguments": {}}],
        }))


def test_bridge_erc_against_stub(tmp_path):
    pytest.importorskip("mcp")
    request = _request([{
        "id": "erc",
        "tool": "get_erc_violations",
        "arguments": {"compile": True, "project_path": "C:/demo/demo.PrjPcb"},
    }], tmp_path / "ad-home")
    payload = _run_bridge(request, tmp_path)

    assert payload["ok"] is True
    assert payload["phase"] == "done"
    assert payload["server"]["info"]["name"] == "StubAltiumMCP"
    erc = payload["calls"]["erc"]
    assert erc["ok"] is True
    assert erc["result"]["total"] == 2
    assert erc["result"]["violations"][0]["type"] == "Net has only one pin"


def test_bridge_reports_tool_failure(tmp_path):
    pytest.importorskip("mcp")
    request = _request([{
        "id": "drc",
        "tool": "run_drc",
        "arguments": {"board_path": "C:/demo/demo.PcbDoc"},
    }], tmp_path / "ad-home")
    request["server"]["env"] = {"STUB_AD_DRC_FAIL": "1"}
    payload = _run_bridge(request, tmp_path)

    assert payload["ok"] is True
    drc = payload["calls"]["drc"]
    assert drc["ok"] is False
    assert drc["reason"] == "tool_reported_failure"
    assert "did not run" in drc["error"]


def test_bridge_skips_after_timeout(tmp_path):
    pytest.importorskip("mcp")
    request = _request([
        {
            "id": "erc",
            "tool": "get_erc_violations",
            "arguments": {"compile": True, "project_path": ""},
            "timeoutMs": 800,
        },
        {
            "id": "drc",
            "tool": "run_drc",
            "arguments": {"board_path": ""},
        },
    ], tmp_path / "ad-home")
    request["server"]["env"] = {"STUB_AD_SLEEP_MS": "5000"}
    payload = _run_bridge(request, tmp_path)

    assert payload["ok"] is True
    assert payload["calls"]["erc"]["ok"] is False
    assert payload["calls"]["erc"]["reason"] == "timeout"
    assert payload["calls"]["drc"]["ok"] is False
    assert payload["calls"]["drc"]["reason"] == "skipped_after_timeout"


def test_bridge_missing_server_is_structured(tmp_path):
    request = {
        "server": {
            "python": sys.executable,
            "main": str(tmp_path / "missing.py"),
        },
        "calls": [{"id": "erc", "tool": "get_erc_violations", "arguments": {}}],
    }
    payload = _run_bridge(request, tmp_path)

    assert payload["ok"] is False
    assert payload["phase"] == "request"
    assert "不存在" in payload["reason"]
