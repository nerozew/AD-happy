# tests/test_adapter.py
import json, sys
from pathlib import Path

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT.parent / ".agents" / "skills" / "ad-happy" / "scripts"))

from adapter import to_context

def load_raw():
    return json.loads((ROOT / "fixtures" / "adapter-raw.json").read_text(encoding="utf-8"))

def test_components_and_nets():
    ctx = to_context(load_raw())
    assert len(ctx.components) == 9
    assert len(ctx.nets) == 6
    assert len(ctx.pin_net) == 22

def test_component_type_recognized():
    ctx = to_context(load_raw())
    assert ctx.comp_lookup["R1"]["type"] == "resistor"
    assert ctx.comp_lookup["C1"]["type"] == "capacitor"

def test_power_rails_from_power_ports():
    ctx = to_context(load_raw())
    assert "GND" in ctx.known_power_rails

def test_value_parsed():
    ctx = to_context(load_raw())
    assert abs(ctx.parsed_values["R1"] - 56200) < 1
    assert abs(ctx.parsed_values["C1"] - 0.1e-6) < 1e-12


def test_no_erc_and_hotspot_coordinates():
    raw = {
        "schematic": {
            "components": [{"reference": "U1", "comment": "TEST"}],
            "pins": [{
                "componentIndex": 0, "number": "1", "name": "NC",
                "electrical": "passive", "x": 0.0, "y": 0.0,
                "xHotspot": 10.0, "yHotspot": 5.0,
                "orientation": 0, "lengthMil": 10,
            }],
            "powerPorts": [],
            "noErcs": [{"x": 10.0, "y": 5.0}],
        },
        "nets": {"nets": {}, "pinNet": {}, "stats": {}},
    }
    ctx = to_context(raw)
    # No-ERC 进入 ctx.no_connects，引脚坐标改用热点，二者可精确匹配。
    assert ctx.no_connects == [{"x": 10.0, "y": 5.0}]
    assert ctx.components[0]["pins"][0]["x"] == 10.0
    assert ctx.components[0]["pins"][0]["y"] == 5.0
