import json
import sys

sys.path.insert(0, r"D:/Tools/kicad-happy/skills/kicad/scripts")

from kicad_types import AnalysisContext
from kicad_utils import classify_component
from signal_detectors import (
    detect_voltage_dividers,
    detect_rc_filters,
    detect_decoupling,
    detect_power_regulators,
    detect_shorted_two_pin_components,
)
from analyze_schematic import analyze_connectivity

AD_PIN_TYPE = {
    "0": "input",
    "1": "bidirectional",
    "2": "output",
    "3": "open_collector",
    "4": "passive",
    "5": "tri_state",
    "6": "open_emitter",
    "7": "power_in",
}

raw = json.load(open(r"d:/Code_all/ad-happy/.tmp-altium-check/ctx.json", encoding="utf-8"))

components = []
for c in raw["components"]:
    ref = c["reference"]
    value = c["value"]
    lib_id = c["lib_id"]
    ctype = classify_component(ref, lib_id, value, footprint=c["footprint"])
    pins = [
        {
            "number": p["number"],
            "name": p["name"],
            "type": AD_PIN_TYPE.get(p["type"], "passive"),
            "x": p["x"],
            "y": p["y"],
        }
        for p in c["pins"]
    ]
    components.append(
        {
            "reference": ref,
            "value": value,
            "type": ctype,
            "lib_id": lib_id,
            "footprint": c["footprint"],
            "properties": {"Part Number": c["part_number"]},
            "pins": pins,
        }
    )

pin_net = {}
for k, v in raw["pin_net"].items():
    ref, pin = k.split("|", 1)
    pin_net[(ref, pin)] = (v[0], v[1])

nets = {}
for name, info in raw["nets"].items():
    pins = []
    for p in info["pins"]:
        pins.append(
            {
                "component": p["component"],
                "pin_number": p["pin_number"],
                "pin_name": p["pin_name"],
                "pin_type": AD_PIN_TYPE.get(p["pin_type"], "passive"),
                "x": p["x"],
                "y": p["y"],
            }
        )
    nets[name] = {"pins": pins}

ctx = AnalysisContext(
    components=components,
    nets=nets,
    lib_symbols={},
    pin_net=pin_net,
    known_power_rails=set(raw["power_rails"]),
)

print("types:", {c["reference"]: c["type"] for c in components})
print("parsed:", ctx.parsed_values)
print("power rails:", ctx.known_power_rails)

vd = detect_voltage_dividers(ctx)
print("\n[VD] dividers:", len(vd["voltage_dividers"]), "feedback:", len(vd["feedback_networks"]))
for d in vd["voltage_dividers"]:
    print("  ", d["r_top"]["ref"], "/", d["r_bottom"]["ref"], "ratio", d["ratio"], d["top_net"], d["mid_net"], d["bottom_net"])

rc = detect_rc_filters(ctx, vd["voltage_dividers"])
print("[RC] count:", len(rc))
for r in rc:
    print("  ", json.dumps(r, ensure_ascii=False)[:300])

dec = detect_decoupling(ctx)
print("[DECOUP] count:", len(dec))
for d in dec:
    print("  ", d["rail"], d["cap_count"], d["total_capacitance_uF"])

pr = detect_power_regulators(ctx, vd["voltage_dividers"])
print("[PWRREG] count:", len(pr))
for p in pr:
    print("  ", json.dumps(p, ensure_ascii=False)[:300])

sh = detect_shorted_two_pin_components(ctx)
print("[SHORT] count:", len(sh))
for s in sh:
    print("  ", json.dumps(s, ensure_ascii=False)[:300])

conn = analyze_connectivity(components, nets, [])
print("[CONN] unconnected:", len(conn["unconnected_pins"]), "single_pin_nets:", len(conn["single_pin_nets"]))
print("  unconnected:", conn["unconnected_pins"])
print("  single:", conn["single_pin_nets"])
print("  multi_driver:", len(conn.get("multi_driver_nets", [])))

total = len(vd["voltage_dividers"]) + len(vd["feedback_networks"]) + len(rc) + len(dec) + len(pr) + len(sh) + len(conn.get("single_pin_net_findings", []))
print("\nTOTAL finding-like objects from 6 schematic rules:", total)
