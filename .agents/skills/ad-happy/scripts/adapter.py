# 适配层：把 Node 侧导出的 raw.json（SchSnapshot + buildNets 输出）装进
# kicad-happy 的 AnalysisContext。kicad-happy 只读引用，脚本目录优先取
# KICAD_HAPPY_SCRIPTS 环境变量，缺省用本机安装位置。
import os
import sys

# 与 selfcheck.mjs 的默认路径保持一致。
DEFAULT_KICAD_HAPPY_SCRIPTS = "D:/Tools/kicad-happy/skills/kicad/scripts"


def kicad_happy_scripts() -> str:
    """返回 kicad-happy 的 scripts 目录：环境变量优先，其次本机默认路径。"""
    return os.environ.get("KICAD_HAPPY_SCRIPTS") or DEFAULT_KICAD_HAPPY_SCRIPTS


sys.path.insert(0, kicad_happy_scripts())

from kicad_types import AnalysisContext  # noqa: E402  依赖上面的 sys.path
from kicad_utils import classify_component  # noqa: E402

# AD 电气类型（sch.mjs 归一化后的名称）→ KiCad 引脚类型。
# AD 的 Power 不区分输入/输出，统一按 power_in 处理。
PIN_TYPES = {
    "input": "input",
    "output": "output",
    "bidirectional": "bidirectional",
    "passive": "passive",
    "power": "power_in",
    "open_collector": "open_collector",
    "unspecified": "unspecified",
}


def to_context(raw: dict) -> AnalysisContext:
    """把 raw.json 转换为 kicad-happy 的 AnalysisContext。

    raw 形如 ``{"schematic": <SchSnapshot>, "nets": <buildNets 输出>}``。
    元件值取 Comment；"=Value" 表达式已由 Task 4 的 parseSch 按同元件参数解析。
    """
    schematic = raw.get("schematic") or {}
    components = _build_components(
        schematic.get("components") or [],
        _group_pins(schematic.get("pins") or []),
    )
    nets, pin_net = _build_nets(raw.get("nets") or {}, schematic)
    return AnalysisContext(
        components=components,
        nets=nets,
        lib_symbols={},
        pin_net=pin_net,
        # 显式传入非空集合，跳过 __post_init__ 的 #PWR 推断（AD 只有电源端口）。
        known_power_rails=_power_rails(schematic.get("powerPorts") or []),
        # analyze_connectivity 按引脚热点坐标匹配 No-ERC；引脚 x/y 也用热点。
        no_connects=_no_connects(schematic.get("noErcs") or []),
    )


def _build_components(schematic_components, pins_by_component):
    components = []
    for index, component in enumerate(schematic_components):
        reference = str(component.get("reference") or "")
        value = str(component.get("comment") or "").strip()
        lib_id = _lib_id(component, value)
        components.append({
            "reference": reference,
            "value": value,
            "type": classify_component(reference, lib_id, value),
            "lib_id": lib_id,
            "footprint": str(component.get("footprint") or ""),
            "properties": {},
            "pins": [_pin_entry(pin) for pin in pins_by_component.get(index, [])],
        })
    return components


def _lib_id(component, value):
    # SchSnapshot 不含 AD 库名，用 "AD" 作库前缀；符号名取 Comment（即元件值），
    # 缺值时退回封装名/位号，始终保持 "Library:Symbol" 形式。
    symbol = (
        value
        or str(component.get("footprint") or "").strip()
        or str(component.get("reference") or "").strip()
    )
    return f"AD:{symbol}"


def _group_pins(pins):
    grouped = {}
    for pin in pins:
        component_index = pin.get("componentIndex")
        if not isinstance(component_index, int):
            continue
        grouped.setdefault(component_index, []).append(pin)
    return grouped


def _pin_entry(pin):
    x, y = _pin_coordinates(pin)
    return {
        "number": str(pin.get("number") or ""),
        "name": str(pin.get("name") or ""),
        "type": _pin_type(pin.get("electrical")),
        "x": x,
        "y": y,
    }


def _pin_coordinates(pin):
    """引脚连接点（热点）坐标；旧快照缺少热点字段时退回 LOCATION。"""
    x = pin.get("xHotspot", pin.get("x", 0.0))
    y = pin.get("yHotspot", pin.get("y", 0.0))
    return x, y


def _no_connects(no_ercs):
    """AD No-ERC 标记 -> kicad-happy 的 no_connects（坐标为引脚热点）。"""
    positions = []
    for entry in no_ercs:
        try:
            positions.append({
                "x": float(entry.get("x", 0.0)),
                "y": float(entry.get("y", 0.0)),
            })
        except (TypeError, ValueError):
            continue
    return positions


def _pin_type(electrical):
    return PIN_TYPES.get(str(electrical or "").strip().lower(), "unspecified")


def _power_rails(power_ports):
    # 只收 Power Port 上真实出现的网络名，不按命名规则猜测电源轨。
    return {
        str(port.get("text") or "").strip()
        for port in power_ports
        if str(port.get("text") or "").strip()
    }


def _build_nets(net_result, schematic):
    net_map = net_result.get("nets") or {}
    pin_index = _pin_index(schematic)
    nets = {}
    for name, entries in net_map.items():
        pins = []
        for entry in entries:
            reference = str(entry.get("reference") or "")
            pin_number = str(entry.get("pin") or "")
            pin = pin_index.get((reference, pin_number)) or {}
            x, y = _pin_coordinates(pin)
            pins.append({
                "component": reference,
                "pin_number": pin_number,
                "pin_name": str(pin.get("name") or ""),
                "pin_type": _pin_type(pin.get("electrical")),
                "x": x,
                "y": y,
            })
        nets[str(name)] = {"pins": pins}

    # pin_net 的 value 是 (网络名, net_info)，与 kicad-happy 的
    # build_pin_to_net_map 一致，检测器会读取 net_info["pins"]。
    pin_net = {}
    for name, net_info in nets.items():
        for pin in net_info["pins"]:
            pin_net[(pin["component"], pin["pin_number"])] = (name, net_info)
    return nets, pin_net


def _pin_index(schematic):
    references = [
        str(component.get("reference") or "")
        for component in schematic.get("components") or []
    ]
    index = {}
    for pin in schematic.get("pins") or []:
        component_index = pin.get("componentIndex")
        if not isinstance(component_index, int) or not 0 <= component_index < len(references):
            continue
        reference = references[component_index]
        if reference:
            index[(reference, str(pin.get("number") or ""))] = pin
    return index
