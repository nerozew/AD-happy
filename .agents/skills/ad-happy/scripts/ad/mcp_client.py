#!/usr/bin/env python3
"""AD-Happy 与 AD-MCP 之间的 stdio 桥。

设计目标：
- 只做「启动 AD-MCP 服务器 → 依次调用工具 → 回传原始结果」，
  不在这里解释 ERC/DRC/库语义；归一化在 scripts/ad/ad.mjs 中完成。
- 永远只向 stdout 写一份 JSON；诊断信息写 stderr。
- 每个工具调用都有超时；启动失败、调用超时、协议错误都返回
  ``{"ok": false, ...}`` 或逐项 ``ok: false``，不会无限等待。

用法：
    python -B -X utf8 mcp_client.py --request request.json
    python -B -X utf8 mcp_client.py < request.json

请求格式：
    {
      "server": {
        "python": "C:/.../python.exe",
        "main": "C:/.../server/main.py",
        "cwd": "C:/.../installed-v0.7.0",
        "altiumHome": "C:/.../out/ad-mcp-home",
        "env": {"NAME": "VALUE"}
      },
      "startupTimeoutMs": 60000,
      "overallTimeoutMs": 600000,
      "calls": [
        {
          "id": "erc",
          "tool": "get_erc_violations",
          "arguments": {"compile": true, "project_path": "..."},
          "timeoutMs": 300000
        }
      ]
    }
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path

# 只允许调用本阶段需要的四个工具。请求文件虽然由本工具生成，仍按最小权限处理。
ALLOWED_TOOLS = {
    "get_erc_violations",
    "run_drc",
    "get_symbol_primitives",
    "get_footprint_primitives",
}

DEFAULT_STARTUP_TIMEOUT_MS = 60_000
DEFAULT_TOOL_TIMEOUT_MS = 300_000
DEFAULT_OVERALL_MARGIN_MS = 30_000
MAX_OVERALL_TIMEOUT_MS = 30 * 60 * 1000
MAX_ERROR_TEXT = 4000


class RequestError(ValueError):
    """请求 JSON 不符合桥的契约。"""


def _now_ms() -> int:
    return int(time.monotonic() * 1000)


def _text(value, limit: int = MAX_ERROR_TEXT) -> str:
    text = "" if value is None else str(value)
    if len(text) <= limit:
        return text
    return text[: max(limit - 1, 0)] + "…"


def _stderr():
    # pythonw 下 sys.stderr 可能为 None；此时丢弃服务器日志，但协议仍可用。
    return sys.stderr if sys.stderr is not None else open(os.devnull, "w", encoding="utf-8")


def _emit(payload: dict) -> None:
    """stdout 只输出这一份 JSON，其他内容一律走 stderr。"""
    stream = sys.stdout
    if stream is None:  # 极端情况下（无控制台）仍尽量写出去
        return
    stream.write(json.dumps(payload, ensure_ascii=False) + "\n")
    stream.flush()


def _failure(phase: str, reason: str, **extra) -> dict:
    payload = {
        "ok": False,
        "phase": phase,
        "reason": _text(reason),
        "server": None,
        "calls": {},
        "errors": [_text(reason)],
    }
    payload.update(extra)
    return payload


def _request_path(argv: list[str]) -> str | None:
    """解析 --request <path> / --request=<path>；其余参数忽略。"""
    for index, argument in enumerate(argv):
        if argument == "--request":
            if index + 1 >= len(argv):
                raise RequestError("--request 缺少文件路径")
            return argv[index + 1]
        if argument.startswith("--request="):
            value = argument.split("=", 1)[1]
            if not value:
                raise RequestError("--request 缺少文件路径")
            return value
    return None


def load_request(text: str) -> dict:
    """解析并校验请求；失败时抛出 RequestError。"""
    try:
        request = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RequestError(f"请求 JSON 不合法：{exc}") from exc
    if not isinstance(request, dict):
        raise RequestError("请求必须是 JSON 对象")

    server = request.get("server")
    if not isinstance(server, dict):
        raise RequestError("请求缺少 server 对象")
    python = server.get("python")
    main = server.get("main")
    if not isinstance(python, str) or not python.strip():
        raise RequestError("server.python 必须是非空字符串")
    if not isinstance(main, str) or not main.strip():
        raise RequestError("server.main 必须是非空字符串")
    if not Path(main).is_file():
        raise RequestError(f"AD-MCP 服务端入口不存在：{main}")

    calls = request.get("calls")
    if not isinstance(calls, list):
        raise RequestError("calls 必须是数组")
    normalized_calls = []
    seen_ids = set()
    for index, call in enumerate(calls):
        if not isinstance(call, dict):
            raise RequestError(f"calls[{index}] 必须是对象")
        call_id = call.get("id")
        tool = call.get("tool")
        arguments = call.get("arguments", {})
        if not isinstance(call_id, str) or not call_id.strip():
            raise RequestError(f"calls[{index}].id 必须是非空字符串")
        if call_id in seen_ids:
            raise RequestError(f"calls[{index}].id 重复：{call_id}")
        seen_ids.add(call_id)
        if tool not in ALLOWED_TOOLS:
            raise RequestError(f"calls[{index}].tool 不受支持：{tool!r}")
        if not isinstance(arguments, dict):
            raise RequestError(f"calls[{index}].arguments 必须是对象")
        timeout_ms = call.get("timeoutMs", DEFAULT_TOOL_TIMEOUT_MS)
        if not isinstance(timeout_ms, (int, float)) or isinstance(timeout_ms, bool) or timeout_ms <= 0:
            raise RequestError(f"calls[{index}].timeoutMs 必须是正数")
        normalized_calls.append({
            "id": call_id,
            "tool": tool,
            "arguments": arguments,
            "timeoutMs": int(timeout_ms),
        })
    if not normalized_calls:
        raise RequestError("calls 不能为空")

    startup_timeout = request.get("startupTimeoutMs", DEFAULT_STARTUP_TIMEOUT_MS)
    if not isinstance(startup_timeout, (int, float)) or isinstance(startup_timeout, bool) or startup_timeout <= 0:
        raise RequestError("startupTimeoutMs 必须是正数")

    overall = request.get("overallTimeoutMs")
    if overall is None:
        overall = int(startup_timeout) + sum(call["timeoutMs"] for call in normalized_calls) + DEFAULT_OVERALL_MARGIN_MS
    if not isinstance(overall, (int, float)) or isinstance(overall, bool) or overall <= 0:
        raise RequestError("overallTimeoutMs 必须是正数")
    overall = min(int(overall), MAX_OVERALL_TIMEOUT_MS)

    return {
        "server": server,
        "startupTimeoutMs": int(startup_timeout),
        "overallTimeoutMs": overall,
        "calls": normalized_calls,
    }


def build_server_env(server: dict) -> dict:
    """把 AD-MCP 需要的环境变量叠到当前进程环境上。"""
    env = os.environ.copy()
    extra = server.get("env")
    if isinstance(extra, dict):
        for key, value in extra.items():
            if isinstance(key, str) and isinstance(value, (str, int, float, bool)):
                env[key] = str(value)
    home = server.get("altiumHome")
    if isinstance(home, str) and home.strip():
        Path(home).mkdir(parents=True, exist_ok=True)
        # AD-MCP 的配置与日志都放进本次运行的输出目录，避免写安装目录。
        env["ALTIUM_MCP_HOME"] = home
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    # AD-MCP 安装目录只读：禁止服务器在 server/ 下写 __pycache__。
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env


def _tool_text(result) -> str:
    """连接 MCP CallToolResult 的所有文本块。"""
    parts = []
    for item in getattr(result, "content", None) or []:
        text = getattr(item, "text", None)
        if isinstance(text, str):
            parts.append(text)
    return "\n".join(parts).strip()


def _parse_tool_result(call: dict, result, started: int) -> dict:
    """把 CallToolResult 转成桥的逐项结果。

    AD-MCP 的失败有两种形式：MCP 层的 isError，以及工具自己返回的
    ``{"success": false, "error": ...}``。两者都按失败处理，绝不把错误
    文本当成成功结果交给上层归一化。
    """
    text = _tool_text(result)
    if getattr(result, "isError", False):
        return {
            "ok": False,
            "tool": call["tool"],
            "reason": "tool_error",
            "error": _text(text or "MCP 工具返回 isError=true"),
            "durationMs": _now_ms() - started,
        }

    value = None
    if text:
        try:
            value = json.loads(text)
        except json.JSONDecodeError:
            return {
                "ok": False,
                "tool": call["tool"],
                "reason": "invalid_json",
                "error": "MCP 工具返回的不是 JSON：" + _text(text, 1000),
                "raw": _text(text),
                "durationMs": _now_ms() - started,
            }
    elif getattr(result, "structuredContent", None) is not None:
        value = result.structuredContent

    if isinstance(value, dict) and value.get("success") is False:
        error = value.get("error") or value.get("message") or "工具报告 success=false"
        return {
            "ok": False,
            "tool": call["tool"],
            "reason": "tool_reported_failure",
            "error": _text(error),
            "result": value,
            "durationMs": _now_ms() - started,
        }

    return {
        "ok": True,
        "tool": call["tool"],
        "result": value,
        "durationMs": _now_ms() - started,
    }


async def _run_session(request: dict) -> dict:
    try:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
    except Exception as exc:  # pragma: no cover - 依赖缺失时走 main 的结构化输出
        raise RuntimeError(
            "缺少 Python mcp 包；请执行 python -m pip install \"mcp[cli]==1.30.0\"，"
            "或把 AD_HAPPY_AD_PYTHON 指向已安装 mcp 的解释器"
        ) from exc

    server = request["server"]
    params = StdioServerParameters(
        command=server["python"],
        args=["-B", server["main"]],
        env=build_server_env(server),
        cwd=server.get("cwd") or None,
    )

    startup_started = _now_ms()
    calls_out: dict[str, dict] = {}
    errors: list[str] = []
    server_info = None
    stop_remaining = False

    try:
        async with stdio_client(params, errlog=_stderr()) as (read, write):
            async with ClientSession(read, write) as session:
                init = await asyncio.wait_for(
                    session.initialize(),
                    request["startupTimeoutMs"] / 1000.0,
                )
                info = getattr(init, "serverInfo", None) or getattr(init, "server_info", None)
                if info is not None:
                    server_info = {
                        "name": getattr(info, "name", "") or "",
                        "version": getattr(info, "version", "") or "",
                    }

                for call in request["calls"]:
                    if stop_remaining:
                        calls_out[call["id"]] = {
                            "ok": False,
                            "tool": call["tool"],
                            "reason": "skipped_after_timeout",
                            "error": "前序调用超时或失败，未执行本调用",
                            "durationMs": 0,
                        }
                        continue
                    started = _now_ms()
                    try:
                        result = await asyncio.wait_for(
                            session.call_tool(call["tool"], call["arguments"]),
                            call["timeoutMs"] / 1000.0,
                        )
                    except asyncio.TimeoutError:
                        message = (
                            f"工具 {call['tool']} 调用超时（{call['timeoutMs']} ms）；"
                            "后续调用已跳过，避免继续占用 Altium"
                        )
                        calls_out[call["id"]] = {
                            "ok": False,
                            "tool": call["tool"],
                            "reason": "timeout",
                            "error": message,
                            "durationMs": _now_ms() - started,
                        }
                        errors.append(message)
                        stop_remaining = True
                        continue
                    except Exception as exc:  # noqa: BLE001 - 单项错误不能拖垮整次桥接
                        message = f"工具 {call['tool']} 调用失败：{_text(exc)}"
                        calls_out[call["id"]] = {
                            "ok": False,
                            "tool": call["tool"],
                            "reason": "call_error",
                            "error": message,
                            "durationMs": _now_ms() - started,
                        }
                        errors.append(message)
                        continue

                    record = _parse_tool_result(call, result, started)
                    calls_out[call["id"]] = record
                    if not record.get("ok"):
                        errors.append(f"工具 {call['tool']}：{record.get('error', '未知错误')}")
    except asyncio.TimeoutError:
        message = f"AD-MCP 服务器启动超时（{request['startupTimeoutMs']} ms）"
        return _failure(
            "startup",
            message,
            calls=calls_out,
            server={"startupMs": _now_ms() - startup_started, "info": server_info},
        )
    except Exception as exc:  # noqa: BLE001 - 启动/协议错误都要结构化返回
        message = f"无法启动或连接 AD-MCP 服务器：{_text(exc)}"
        return _failure(
            "startup",
            message,
            calls=calls_out,
            server={"startupMs": _now_ms() - startup_started, "info": server_info},
        )

    failed = sum(1 for record in calls_out.values() if not record.get("ok"))
    return {
        "ok": True,
        "phase": "done",
        "reason": None,
        "server": {
            "startupMs": _now_ms() - startup_started,
            "info": server_info,
        },
        "calls": calls_out,
        "errors": errors,
        "failedCalls": failed,
    }


async def _run_with_watchdog(request: dict) -> dict:
    return await asyncio.wait_for(
        _run_session(request),
        request["overallTimeoutMs"] / 1000.0,
    )


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)

    try:
        request_path = _request_path(argv)
        if request_path:
            text = Path(request_path).read_text(encoding="utf-8")
        else:
            text = sys.stdin.read()
        request = load_request(text)
    except (OSError, RequestError) as exc:
        _emit(_failure("request", str(exc)))
        return 0

    try:
        result = asyncio.run(_run_with_watchdog(request))
    except asyncio.TimeoutError:
        result = _failure(
            "overall",
            f"桥接整体超时（{request['overallTimeoutMs']} ms）；已停止等待 AD-MCP",
        )
    except RuntimeError as exc:
        # mcp 依赖缺失：给出可直接执行的安装命令。
        result = _failure(
            "import",
            str(exc),
            installCommand='python -m pip install "mcp[cli]==1.30.0"',
        )
    except Exception as exc:  # noqa: BLE001 - 顶层兜底，保证 stdout 仍有一份 JSON
        result = _failure("internal", f"桥接内部错误：{_text(exc)}")

    _emit(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
