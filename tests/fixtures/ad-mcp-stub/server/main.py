"""测试用 AD-MCP 替身：实现与真实服务器相同的四个 stdio 工具。

它不接触 Altium，只按夹具返回固定结果；环境变量用于模拟失败与超时：
- STUB_AD_ERC_FAIL=1          ERC 调用抛出错误
- STUB_AD_DRC_FAIL=1          DRC 返回 success=false / ran=false
- STUB_AD_SLEEP_MS=5000       每个工具返回前等待，用于超时测试
- STUB_AD_MISSING_SYMBOL_PIN  符号明细中省略该引脚号（逗号分隔）
- STUB_AD_MISSING_PAD         封装明细中省略该焊盘号（逗号分隔）

本文件只在测试中使用，不随 skill 交付。
"""
import asyncio
import json
import os

from mcp.server.fastmcp import Context, FastMCP

mcp = FastMCP("StubAltiumMCP")

# 与 tests/fixtures/Student-DCDC-Buck-Converter 中的原理图元件注释/封装对应。
SYMBOLS = {
    "TPS561208DDCR": ["1", "2", "3", "4", "5", "6"],
    "22µF": ["1", "2"],
    "0.1µF": ["1", "2"],
    "47µF": ["1", "2"],
    "4.7µH": ["1", "2"],
    "56.2 kOhms": ["1", "2"],
    "10 kOhms": ["1", "2"],
    "282834-2": ["1", "2"],
}

FOOTPRINTS = {
    "SOT95P280X110-6N": ["1", "2", "3", "4", "5", "6"],
    "CAP 0805_2012": ["1", "2"],
    "RES 0805_2012": ["1", "2"],
    "TDK SPM3012-LR": ["1", "2"],
    "TE 282834-2": ["1", "2"],
    "CAP 1210_3225 - 2.8MM": ["1", "2"],
}


def _misset(name: str) -> set[str]:
    return {item.strip() for item in os.environ.get(name, "").split(",") if item.strip()}


def _visible(table: dict, exclude_env: str) -> dict:
    excluded = _misset(exclude_env)
    return {name: pins for name, pins in table.items() if name not in excluded}


async def _delay() -> None:
    try:
        milliseconds = int(os.environ.get("STUB_AD_SLEEP_MS", "0") or 0)
    except ValueError:
        milliseconds = 0
    if milliseconds > 0:
        await asyncio.sleep(milliseconds / 1000.0)


@mcp.tool()
async def get_erc_violations(ctx: Context, compile: bool = True, project_path: str = "") -> str:
    """Return canned ERC/compiler violations."""
    await _delay()
    if os.environ.get("STUB_AD_ERC_FAIL") == "1":
        raise RuntimeError("stub ERC failure")
    return json.dumps({
        "project_path": project_path,
        "compiled": True,
        "unsaved_in_altium": [],
        "missing_on_disk": [],
        "total": 2,
        "fatal": 0,
        "errors": 1,
        "warnings": 1,
        "violations": [
            {
                "level": "error",
                "type": "Net has only one pin",
                "detail": "Net GND has only one pin",
            },
            {
                "level": "warning",
                "type": "Off-grid object",
                "detail": "Off grid C1 at 147.92mm,120mm",
            },
        ],
    }, ensure_ascii=False)


@mcp.tool()
async def run_drc(ctx: Context, board_path: str = "", max_violations: int = 200,
                  rules: list = None, nets: list = None, area: list = None) -> str:
    """Return canned batch DRC results."""
    await _delay()
    if os.environ.get("STUB_AD_DRC_FAIL") == "1":
        return json.dumps({
            "success": False,
            "ran": False,
            "board": board_path,
            "error": "The check did not run: stub DRC dialog failure",
            "violation_count": 0,
            "violations": [],
            "listed_by_rule": {},
        }, ensure_ascii=False)
    violations = [
        {
            "rule": "Clearance",
            "description": "Clearance violation between Pad R1-1 and Track on Top Layer",
            "x_mils": 1000,
            "y_mils": 2000,
            "primitive1": {"object": "Pad R1-1", "net": "GND", "layer": "Top Layer"},
            "primitive2": {"object": "Track", "net": "VFB", "layer": "Top Layer"},
        },
        {
            "rule": "Short-Circuit",
            "description": "Short circuit between Net GND and Net VFB",
            "x_mils": 1200,
            "y_mils": 2200,
            "primitive1": {"object": "Track", "net": "GND", "layer": "Top Layer"},
            "primitive2": {"object": "Track", "net": "VFB", "layer": "Top Layer"},
        },
    ]
    return json.dumps({
        "success": True,
        "ran": True,
        "board": board_path,
        "violation_count": len(violations),
        "complete": True,
        "violations": violations[:max_violations],
        "listed_by_rule": {"Clearance": 1, "Short-Circuit": 1},
        "report": {"path": "stub-drc-report.txt", "stopped": False},
    }, ensure_ascii=False)


@mcp.tool()
async def get_symbol_primitives(ctx: Context, library_path: str = "", symbol_name: str = "") -> str:
    """Inventory a fake SchLib, or dump a fake symbol."""
    await _delay()
    symbols = _visible(SYMBOLS, "STUB_AD_SYMBOL_EXCLUDE")
    if not symbol_name:
        return json.dumps({
            "library_name": os.path.basename(library_path),
            "symbol_count": len(symbols),
            "symbols": [
                {"name": name, "description": "", "part_count": 1, "pins": len(pins)}
                for name, pins in symbols.items()
            ],
        }, ensure_ascii=False)
    pins = symbols.get(symbol_name)
    if pins is None:
        return json.dumps({
            "success": False,
            "error": f"ERROR: Symbol not found in library: {symbol_name}",
        }, ensure_ascii=False)
    missing = _misset("STUB_AD_MISSING_SYMBOL_PIN")
    primitives = [
        {
            "type": "pin",
            "pin_number": number,
            "pin_name": f"P{number}",
            "electrical": 4,
            "orientation": 0,
            "x": 0,
            "y": 0,
            "length": 100,
            "owner_part_id": 1,
        }
        for number in pins if number not in missing
    ]
    return json.dumps({
        "library_name": os.path.basename(library_path),
        "symbol_name": symbol_name,
        "description": "",
        "part_count": 1,
        "parameters": [],
        "primitives": primitives,
    }, ensure_ascii=False)


@mcp.tool()
async def get_footprint_primitives(ctx: Context, library_path: str = "",
                                   footprint_name: str = "") -> str:
    """Inventory a fake PcbLib, or dump a fake footprint."""
    await _delay()
    footprints = _visible(FOOTPRINTS, "STUB_AD_FOOTPRINT_EXCLUDE")
    if not footprint_name:
        return json.dumps({
            "library_name": os.path.basename(library_path),
            "library_path": library_path,
            "footprint_count": len(footprints),
            "footprints": [
                {"name": name, "description": "", "pads": len(pads), "tracks": 1}
                for name, pads in footprints.items()
            ],
        }, ensure_ascii=False)
    pads = footprints.get(footprint_name)
    if pads is None:
        return json.dumps({
            "success": False,
            "error": f"ERROR: Footprint not found in library: {footprint_name}",
        }, ensure_ascii=False)
    missing = _misset("STUB_AD_MISSING_PAD")
    primitives = [
        {
            "type": "pad",
            "name": number,
            "x": index * 100,
            "y": 0,
            "rotation": 0,
            "layer": "Top Layer",
            "plated": True,
        }
        for index, number in enumerate(pads) if number not in missing
    ]
    return json.dumps({
        "library_name": os.path.basename(library_path),
        "library_path": library_path,
        "footprint_name": footprint_name,
        "description": "",
        "primitives": primitives,
        "bodies_3d": [],
    }, ensure_ascii=False)


if __name__ == "__main__":
    mcp.run()
