"""Local-only WebSocket/HTTP bridge for the C2C V2 control-plane PoC."""

from __future__ import annotations

import base64
import argparse
import hashlib
import hmac
import json
import copy
import os
import unicodedata
from pathlib import Path
import re
import secrets
import socket
import struct
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlsplit


HOST = "127.0.0.1"
PORT = 18796
EXTENSION_ID = "bbcncnbagapkhddnpieoodkjhhcbclgi"
EXTENSION_ORIGIN = f"chrome-extension://{EXTENSION_ID}"
MAX_HTTP_BODY = 64 * 1024
MAX_WS_FRAME = 256 * 1024
DEFAULT_WAIT_SECONDS = 240
MAX_WAIT_SECONDS = 600
PROTOCOL_VERSION = 2
COMPONENT_VERSION = "0.8.1"
BUILD_ID = "c2c-v2-binding-diagnostic-1"
FINGERPRINT_SCHEMA = "v1-conversation-url"
STARTUP_IDENTITY = {
    "bridge_version": COMPONENT_VERSION,
    "build_id": BUILD_ID,
    "protocol_version": PROTOCOL_VERSION,
    "pid": os.getpid(),
    "host": HOST,
    "port": PORT,
    "started_at_unix": time.time(),
    "startup_source_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
}
RECOVERABLE_ERRORS = frozenset({"outgoing_turn_not_confirmed", "chat_tab_unavailable"})
IDENTITY_KEYS = ("request_id", "task_id", "iteration", "nonce", "expected_commit")
CHECK_KEYS = (
    "original_user_turn_found", "original_nonce_found", "original_commit_found",
    "subsequent_assistant_turn_found", "assistant_reply_exact",
)


_TASK_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,96}$")
_REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_BRANCH_RE = re.compile(r"^[A-Za-z0-9._/-]{1,200}$")
_SHA_RE = re.compile(r"^[0-9a-fA-F]{40}$")
_REQUEST_ID_RE = re.compile(r"^[0-9a-f-]{36}$")


class RequestError(ValueError):
    def __init__(self, code: str, status: int = 400) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


def _single_line(value: Any, name: str, maximum: int = 512) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum or "\n" in value or "\r" in value:
        raise RequestError(f"invalid_{name}")
    return value


def validate_review_payload(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RequestError("body_must_be_object")
    task_id = _single_line(value.get("task_id"), "task_id", 96)
    if not _TASK_RE.fullmatch(task_id):
        raise RequestError("invalid_task_id")
    iteration = value.get("iteration")
    if isinstance(iteration, bool) or not isinstance(iteration, int) or not 1 <= iteration <= 10000:
        raise RequestError("invalid_iteration")
    repo = _single_line(value.get("repo"), "repo", 200)
    if not _REPO_RE.fullmatch(repo):
        raise RequestError("invalid_repo")
    pr = value.get("pr")
    if isinstance(pr, int) and not isinstance(pr, bool):
        pr = str(pr)
    pr = _single_line(pr, "pr", 12)
    if not pr.isdecimal() or int(pr) < 1:
        raise RequestError("invalid_pr")
    branch = _single_line(value.get("branch"), "branch", 200)
    if not _BRANCH_RE.fullmatch(branch) or branch.startswith("/") or ".." in branch.split("/"):
        raise RequestError("invalid_branch")
    commit = _single_line(value.get("commit"), "commit", 40)
    if not _SHA_RE.fullmatch(commit):
        raise RequestError("invalid_commit")
    evidence_path = _single_line(value.get("evidence_path"), "evidence_path", 512)
    path_parts = evidence_path.replace("\\", "/").split("/")
    if not evidence_path.startswith(".c2c-v2/") or any(part in ("", ".", "..") for part in path_parts):
        raise RequestError("invalid_evidence_path")
    instruction = value.get("instruction")
    if not isinstance(instruction, str) or not instruction.strip() or len(instruction) > 12000:
        raise RequestError("invalid_instruction")
    conversation_url = value.get("conversation_url", "")
    if not isinstance(conversation_url, str):
        raise RequestError("invalid_conversation_url")
    if conversation_url:
        parsed_conversation_url = urlsplit(conversation_url)
        if (
            parsed_conversation_url.scheme != "https"
            or parsed_conversation_url.netloc.lower() != "chatgpt.com"
            or parsed_conversation_url.query
            or parsed_conversation_url.fragment
            or not re.fullmatch(r"/c/[A-Za-z0-9_-]{1,128}", parsed_conversation_url.path)
        ):
            raise RequestError("invalid_conversation_url")
    control_token = value.get("control_token")
    if not isinstance(control_token, str) or len(control_token) < 40 or len(control_token) > 128:
        raise RequestError("invalid_control_token")
    timeout_seconds = value.get("wait_seconds", DEFAULT_WAIT_SECONDS)
    if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, int) or not 1 <= timeout_seconds <= MAX_WAIT_SECONDS:
        raise RequestError("invalid_wait_seconds")
    request_id = value.get("request_id")
    if request_id is not None and (not isinstance(request_id, str) or not _REQUEST_ID_RE.fullmatch(request_id)):
        raise RequestError("invalid_request_id")
    return {
        "task_id": task_id,
        "iteration": iteration,
        "repo": repo,
        "pr": pr,
        "branch": branch,
        "commit": commit,
        "evidence_path": evidence_path.replace("\\", "/"),
        "instruction": instruction,
        "conversation_url": conversation_url,
        "control_token": control_token,
        "wait_seconds": timeout_seconds,
        "request_id": request_id,
    }


def format_control_message(payload: dict[str, Any], nonce: str, request_id: str = "") -> str:
    return "\n".join(
        [
            "[C2C_V2]",
            "STATE: REVIEW_REQUEST",
            f"TASK_ID: {payload['task_id']}",
            f"ITERATION: {payload['iteration']}",
            *([f"REQUEST_ID: {request_id}"] if request_id else []),
            f"NONCE: {nonce}",
            "",
            "REPO:",
            payload["repo"],
            "",
            "PR:",
            payload["pr"],
            "",
            "BRANCH:",
            payload["branch"],
            "",
            "COMMIT:",
            payload["commit"],
            "",
            "EVIDENCE_PATH:",
            payload["evidence_path"],
            "",
            "INSTRUCTION:",
            payload["instruction"],
        ]
    )


def request_fingerprint(payload: dict[str, Any]) -> str:
    value = {key: payload[key] for key in ("task_id", "iteration", "repo", "pr", "branch", "commit", "evidence_path", "instruction", "conversation_url")}
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _server_frame(opcode: int, payload: bytes) -> bytes:
    first = bytes((0x80 | opcode,))
    length = len(payload)
    if length < 126:
        header = first + bytes((length,))
    elif length <= 0xFFFF:
        header = first + bytes((126,)) + struct.pack("!H", length)
    else:
        header = first + bytes((127,)) + struct.pack("!Q", length)
    return header + payload


def _read_exact(stream: Any, size: int) -> bytes:
    data = stream.read(size)
    if len(data) != size:
        raise EOFError("websocket_eof")
    return data


def _read_client_frame(stream: Any) -> tuple[int, bytes]:
    head = _read_exact(stream, 2)
    first, second = head
    if first & 0x70 or not first & 0x80:
        raise ValueError("unsupported_websocket_frame")
    opcode = first & 0x0F
    if not second & 0x80:
        raise ValueError("unmasked_client_frame")
    length = second & 0x7F
    if length == 126:
        length = struct.unpack("!H", _read_exact(stream, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", _read_exact(stream, 8))[0]
    if length > MAX_WS_FRAME:
        raise ValueError("websocket_frame_too_large")
    mask = _read_exact(stream, 4)
    payload = bytearray(_read_exact(stream, length))
    for index in range(length):
        payload[index] ^= mask[index % 4]
    return opcode, bytes(payload)


@dataclass
class WebSocketSession:
    connection: socket.socket
    send_lock: threading.Lock = field(default_factory=threading.Lock)
    closed: bool = False

    def send_frame(self, opcode: int, payload: bytes) -> None:
        with self.send_lock:
            if self.closed:
                raise OSError("websocket_closed")
            self.connection.sendall(_server_frame(opcode, payload))

    def send_json(self, value: Any) -> None:
        self.send_frame(0x1, _json_bytes(value))

    def close(self) -> None:
        with self.send_lock:
            if self.closed:
                return
            self.closed = True
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                self.connection.close()
            except OSError:
                pass


def is_conversation_url(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    url = urlsplit(value)
    return (url.scheme == "https" and url.netloc == "chatgpt.com"
            and not url.query and not url.fragment
            and re.fullmatch(r"/c/[A-Za-z0-9_-]{1,128}", url.path) is not None)


def reply_matches(actual: Any, expected: Any) -> bool:
    # raw-exact-v1: no trimming, NFC conversion, or whitespace folding.
    return isinstance(actual, str) and isinstance(expected, str) and bool(expected) and actual == expected


def validate_binding_diagnostic(value: Any, pending: dict[str, Any]) -> dict[str, Any] | None:
    # Only metadata for the exact requested URL; never rebind or confer original authority.
    if not isinstance(value, dict) or set(value) != {
            "schema", "requested_tab_id", "exact_url", "reason", "matching_tab_count",
            "truncated", "authoritative", "matching_tabs"}:
        return None
    count, tabs = value["matching_tab_count"], value["matching_tabs"]
    if (type(value["schema"]) is not int or value["schema"] != 1
            or type(value["requested_tab_id"]) is not int or value["requested_tab_id"] != pending["target_tab_id"]
            or value["exact_url"] != pending["conversation_url"] or value["authoritative"] is not False
            or type(count) is not int or not 0 <= count <= 10000 or not isinstance(tabs, list)
            or len(tabs) != min(count, 4) or value["truncated"] is not (count > 4)):
        return None
    seen = set()
    for tab in tabs:
        if (not isinstance(tab, dict) or set(tab) != {"tab_id", "url", "status"}
                or type(tab["tab_id"]) is not int or tab["tab_id"] < 0 or tab["tab_id"] in seen
                or tab["url"] != pending["conversation_url"] or tab["status"] not in ("loading", "complete", "unknown")):
            return None
        seen.add(tab["tab_id"])
    reason = ("no_matching_conversation_tab" if count == 0 else "duplicate_conversation_tabs" if count > 1
              else "historical_tab_id_mismatch" if tabs[0]["tab_id"] != pending["target_tab_id"]
              else "original_tab_not_complete" if tabs[0]["status"] != "complete" else None)
    if value["reason"] != reason or reason is None:
        return None
    return copy.deepcopy(value)


class BridgeState:
    def __init__(self, inspection_only: bool = False, extension_id: str = EXTENSION_ID) -> None:
        if not isinstance(extension_id, str) or re.fullmatch(r"[a-p]{32}", extension_id) is None:
            raise ValueError("extension_id_invalid")
        self.inspection_only = inspection_only
        self.extension_origin = f"chrome-extension://{extension_id}"
        self.control_token = secrets.token_urlsafe(32)
        self.bridge_session_id = str(uuid.uuid4())
        self.startup_identity = {**STARTUP_IDENTITY, "bridge_session_id": self.bridge_session_id,
            "mode": "inspection-only" if inspection_only else "normal", "extension_id": extension_id}
        self.lock = threading.RLock()
        self.session: WebSocketSession | None = None
        self.extension_seen_at = 0.0
        self.chat_seen_at = 0.0
        self.chat_tab_connected = False
        self.chat_tab_id: int | None = None
        self.chat_url = ""
        self.component_report: dict[str, Any] = {}
        self.pending: dict[str, Any] | None = None
        self.recovery_pending: dict[str, Any] | None = None
        # Original terminal records are never rewritten by recovery or evicted.
        self.completed: dict[str, dict[str, Any]] = {}
        self.recovery_attempts: dict[str, list[dict[str, Any]]] = {}
        self.committed_nonces: set[str] = set()
        self.inspection_pending: dict[str, Any] | None = None
        self.inspection_counter = 0

    def _components_match(self) -> bool:
        r = self.component_report
        return (r.get("protocol_version") == PROTOCOL_VERSION
                and r.get("background_version") == COMPONENT_VERSION
                and r.get("content_version") == COMPONENT_VERSION
                and r.get("manifest_version") == COMPONENT_VERSION
                and r.get("background_build_id") == BUILD_ID
                and r.get("content_build_id") == BUILD_ID)

    def health(self) -> dict[str, Any]:
        now = time.monotonic()
        with self.lock:
            connected = self.session is not None and not self.session.closed and now - self.extension_seen_at < 90
            compatible = connected and self._components_match()
            ready = compatible and self.chat_tab_connected and now - self.chat_seen_at < 90
            return {
                "status": "ok", "bridge_alive": True,
                "bridge_identity": copy.deepcopy(self.startup_identity),
                "extension_connected": connected, "components_match": compatible,
                "chat_tab_connected": ready, "content_script_ready": ready,
                "chat_tab_id": self.chat_tab_id if ready else None,
                "chat_url": self.chat_url if ready else "",
                "tab_id": self.chat_tab_id if ready else None,
                "tab_url": self.chat_url if ready else "",
                "adapter_version": self.component_report.get("background_version", ""),
                "component_versions": copy.deepcopy(self.component_report),
                "request_in_flight": self.pending is not None or self.recovery_pending is not None,
                "inspection_in_flight": self.inspection_pending is not None,
                "normal_sending_enabled": not self.inspection_only,
            }

    def register_session(self, session: WebSocketSession) -> dict[str, Any]:
        with self.lock:
            old = self.session
            self.session = session
            self.extension_seen_at = time.monotonic()
            self.chat_tab_connected = False
            self.component_report = {}
            welcome: dict[str, Any] = {"type": "welcome", "bridge_identity": copy.deepcopy(self.startup_identity)}
            if self.pending is not None:
                welcome["pending_request"] = {**self.pending["wire_request"], "resume": True}
            if self.recovery_pending is not None:
                welcome["pending_recovery"] = copy.deepcopy(self.recovery_pending["wire_request"])
        if old is not None and old is not session:
            old.close()
        return welcome

    def unregister_session(self, session: WebSocketSession) -> None:
        with self.lock:
            if self.session is session:
                self.session = None
                self.chat_tab_connected = False
                self.chat_tab_id = None
                self.chat_url = ""
                self.component_report = {}

    def send_request_once(self, payload: dict[str, Any]) -> dict[str, Any]:
        if self.inspection_only:
            raise RequestError("inspection_mode_locked", 423)
        with self.lock:
            health = self.health()
            # Sending has no recovery exception, even when a URL is supplied.
            if not health["extension_connected"] or not health["chat_tab_connected"]:
                raise RequestError("extension_or_chat_disconnected", 503)
            if self.pending is not None or self.recovery_pending is not None or self.inspection_pending is not None:
                raise RequestError("request_in_flight", 409)
            if len(self.completed) >= 64:
                raise RequestError("original_record_capacity", 409)
            if payload["conversation_url"] and payload["conversation_url"] != self.chat_url:
                raise RequestError("conversation_binding_mismatch", 409)
            req_id = str(uuid.uuid4())
            nonce = secrets.token_urlsafe(24)
            while nonce in self.committed_nonces:
                nonce = secrets.token_urlsafe(24)
            message = format_control_message(payload, nonce, req_id)
            original = {
                "schema": PROTOCOL_VERSION, "fingerprint_schema": FINGERPRINT_SCHEMA,
                "request_id": req_id, "task_id": payload["task_id"], "iteration": payload["iteration"],
                "nonce": nonce, "expected_commit": payload["commit"],
                "fingerprint": request_fingerprint(payload),
                "tab_id": self.chat_tab_id,
                "conversation_url": self.chat_url if is_conversation_url(self.chat_url) else "",
                "message": message,
            }
            request = {
                **{key: original[key] for key in IDENTITY_KEYS},
                "message": message, "target_tab_id": original["tab_id"],
                "conversation_url": original["conversation_url"],
            }
            pending = {
                "request_id": req_id, "nonce": nonce, "expected_commit": payload["commit"],
                "fingerprint": original["fingerprint"], "original": original,
                "event": threading.Event(), "created_at": time.monotonic(),
                "wire_request": request, "result": None, "delivery_uncertain": False,
            }
            self.committed_nonces.add(nonce)
            self.pending = pending
            session = self.session
        try:
            if session is None:
                raise OSError("extension_disconnected")
            session.send_json({"type": "review", "request": request, "resume": False})
        except OSError:
            pending["delivery_uncertain"] = True
        return pending

    def _trusted_original(self, payload: dict[str, Any]) -> dict[str, Any]:
        record = self.completed.get(payload["request_id"])
        if record is None:
            raise RequestError("request_id_unknown", 404)
        o = record.get("original")
        if not isinstance(o, dict) or o.get("schema") != PROTOCOL_VERSION:
            raise RequestError("original_evidence_missing", 409)
        valid = (
            o.get("request_id") == payload["request_id"]
            and isinstance(o.get("task_id"), str) and bool(o["task_id"])
            and isinstance(o.get("iteration"), int) and not isinstance(o["iteration"], bool)
            and 1 <= o["iteration"] <= 10000
            and isinstance(o.get("nonce"), str) and re.fullmatch(r"[A-Za-z0-9_-]{16,128}", o["nonce"])
            and isinstance(o.get("expected_commit"), str) and _SHA_RE.fullmatch(o["expected_commit"])
            and isinstance(o.get("tab_id"), int) and not isinstance(o["tab_id"], bool)
            and o["tab_id"] >= 0 and is_conversation_url(o.get("conversation_url"))
            and o.get("fingerprint_schema") == FINGERPRINT_SCHEMA
            and isinstance(o.get("message"), str) and bool(o["message"])
            and record.get("fingerprint") == o.get("fingerprint")
            and record.get("nonce") == o["nonce"]
            and record.get("expected_commit") == o["expected_commit"]
        )
        if not valid:
            raise RequestError("original_evidence_missing", 409)
        if (o["fingerprint"] != request_fingerprint(payload)
                or o["task_id"] != payload["task_id"] or o["iteration"] != payload["iteration"]
                or o["expected_commit"] != payload["commit"]):
            raise RequestError("recovery_payload_mismatch", 409)
        if record.get("status") != "failed" or record.get("error_code") not in RECOVERABLE_ERRORS:
            raise RequestError("request_not_recoverable", 409)
        return copy.deepcopy(o)

    def recover_original_once(self, payload: dict[str, Any], expected_reply: str) -> tuple[dict[str, Any] | None, threading.Event | None]:
        if self.inspection_only:
            raise RequestError("inspection_mode_locked", 423)
        with self.lock:
            # No ID/nonce allocation, no call to sending, no mutation of the original.
            original = self._trusted_original(payload)
            request_id = original["request_id"]
            current = self.recovery_pending
            if current is not None:
                if current["request_id"] != request_id or current["expected_reply"] != expected_reply:
                    raise RequestError("request_in_flight", 409)
                return None, current["event"]
            attempts = self.recovery_attempts.get(request_id, [])
            if attempts:
                last = attempts[-1]
                if last["expected_reply"] != expected_reply:
                    raise RequestError("recovery_payload_mismatch", 409)
                return copy.deepcopy(last), None
            if self.pending is not None or self.inspection_pending is not None:
                raise RequestError("request_in_flight", 409)
            health = self.health()
            if not health["extension_connected"] or not health["chat_tab_connected"]:
                raise RequestError("extension_or_chat_disconnected", 503)
            if self.chat_tab_id != original["tab_id"] or self.chat_url != original["conversation_url"]:
                raise RequestError("conversation_binding_mismatch", 409)
            wire_request = {
                **{key: original[key] for key in IDENTITY_KEYS},
                "target_tab_id": original["tab_id"], "conversation_url": original["conversation_url"],
                "original_message": original["message"], "expected_reply": expected_reply,
                "attempt": len(attempts) + 1,
            }
            pending = {
                **wire_request, "fingerprint": original["fingerprint"],
                "wire_request": wire_request, "created_at": time.monotonic(), "event": threading.Event(),
            }
            self.recovery_pending = pending
            session = self.session
        try:
            session.send_json({"type": "recover_original", "request": wire_request})
        except OSError:
            # The same pending DOM-only attempt may resume after a compatible reconnect.
            pass
        return None, pending["event"]

    def inspect_original_once(self, payload: dict[str, Any], tab_id: int, expected_reply: str) -> dict[str, Any]:
        # This reference is a diagnostic hint, never an import of original authority.
        if not payload["request_id"] or not is_conversation_url(payload["conversation_url"]):
            raise RequestError("inspection_reference_required", 400)
        if type(tab_id) is not int or tab_id < 0:
            raise RequestError("invalid_target_tab_id")
        with self.lock:
            if self.pending is not None or self.recovery_pending is not None or self.inspection_pending is not None:
                raise RequestError("request_in_flight", 409)
            health = self.health()
            if not health["extension_connected"]:
                raise RequestError("extension_disconnected", 503)
            self.inspection_counter += 1
            wire = {
                "request_id": payload["request_id"], "task_id": payload["task_id"], "iteration": payload["iteration"],
                "expected_commit": payload["commit"], "target_tab_id": tab_id,
                "conversation_url": payload["conversation_url"], "expected_reply": expected_reply,
                "original_message_template": format_control_message(payload, "__OBSERVED_NONCE__"),
                "inspection": self.inspection_counter,
            }
            pending = {**wire, "event": threading.Event(), "result": None, "wire_request": wire}
            self.inspection_pending = pending
            session = self.session
        try:
            session.send_json({"type": "inspect_original", "request": wire})
        except OSError:
            with self.lock:
                self._finish_inspection(pending, {"status": "failed", "error_code": "inspection_delivery_uncertain"})
        return pending

    def _finish_inspection(self, pending: dict[str, Any], result: dict[str, Any]) -> None:
        pending["result"] = {
            **result, "authoritative": False, "original_nonce_verified": False,
            "recovered_original": False, "request_id": pending["request_id"],
            "expected_commit": pending["expected_commit"], "iteration": pending["iteration"],
            "inspection": pending["inspection"], "bridge_identity": copy.deepcopy(self.startup_identity),
        }
        if self.inspection_pending is pending:
            self.inspection_pending = None
        pending["event"].set()

    def poll_request(self, request_id: str, fingerprint: str) -> tuple[dict[str, Any] | None, threading.Event | None]:
        with self.lock:
            record = self.completed.get(request_id)
            if record is not None:
                if record["fingerprint"] != fingerprint:
                    raise RequestError("request_poll_payload_mismatch", 409)
                return copy.deepcopy(record), None
            pending = self.pending
            if pending is None or pending["request_id"] != request_id:
                raise RequestError("request_id_unknown", 404)
            if pending["fingerprint"] != fingerprint:
                raise RequestError("request_poll_payload_mismatch", 409)
            return None, pending["event"]

    def poll_recovery(self, request_id: str, fingerprint: str) -> tuple[dict[str, Any] | None, threading.Event | None]:
        with self.lock:
            attempts = self.recovery_attempts.get(request_id, [])
            if attempts:
                if attempts[-1]["fingerprint"] != fingerprint:
                    raise RequestError("recovery_payload_mismatch", 409)
                return copy.deepcopy(attempts[-1]), None
            pending = self.recovery_pending
            if pending is None or pending["request_id"] != request_id:
                raise RequestError("recovery_attempt_unknown", 404)
            if pending["fingerprint"] != fingerprint:
                raise RequestError("recovery_payload_mismatch", 409)
            return None, pending["event"]

    def handle_message(self, session: WebSocketSession, message: Any) -> None:
        if not isinstance(message, dict):
            return
        kind = message.get("type")
        with self.lock:
            if self.session is not session:
                return
            self.extension_seen_at = time.monotonic()
            if kind == "ping":
                session.send_json({"type": "pong"})
                return
            if kind in ("inspection_result", "inspection_error"):
                p = self.inspection_pending
                if p is None or message.get("inspection") != p["inspection"]:
                    return
                identity_ok = (
                    type(message.get("inspection")) is int and message["inspection"] == p["inspection"]
                    and message.get("request_id") == p["request_id"] and message.get("task_id") == p["task_id"]
                    and type(message.get("iteration")) is int and message["iteration"] == p["iteration"]
                    and message.get("expected_commit") == p["expected_commit"]
                    and type(message.get("tab_id")) is int and message["tab_id"] == p["target_tab_id"]
                    and message.get("conversation_url") == p["conversation_url"]
                )
                if not identity_ok:
                    self._finish_inspection(p, {"status": "failed", "error_code": "inspection_identity_mismatch"})
                    return
                if kind == "inspection_error":
                    code = message.get("error_code")
                    safe = code if isinstance(code, str) and re.fullmatch(r"[a-z0-9_]{1,64}", code) else "inspection_failed"
                    result = {"status": "failed", "error_code": safe}
                    if "binding_diagnostic" in message:
                        diagnostic = validate_binding_diagnostic(message["binding_diagnostic"], p)
                        if safe != "inspection_binding_unconfirmed" or diagnostic is None:
                            self._finish_inspection(p, {"status": "failed", "error_code": "inspection_diagnostic_shape_invalid"})
                            return
                        result["binding_diagnostic"] = diagnostic
                    self._finish_inspection(p, result)
                    return
                candidates = message.get("candidates")
                valid = isinstance(candidates, list) and len(candidates) <= 4
                if valid:
                    for candidate in candidates:
                        if not isinstance(candidate, dict):
                            valid = False; break
                        nonce, text = candidate.get("nonce"), candidate.get("user_text")
                        if (not isinstance(nonce, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", nonce)
                                or not isinstance(text, str) or len(text) > 16000
                                or not isinstance(candidate.get("assistant_text"), str)
                                or len(candidate["assistant_text"]) > 16000):
                            valid = False; break
                        template = p["original_message_template"].replace("__OBSERVED_NONCE__", nonce)
                        normalize = lambda value: re.sub(r"\s+", " ", unicodedata.normalize("NFC", value)).strip()
                        if normalize(text) != normalize(template):
                            valid = False; break
                content = message.get("content_identity", {})
                component_ok = (isinstance(content, dict) and content.get("version") == COMPONENT_VERSION
                    and content.get("protocol_version") == PROTOCOL_VERSION and content.get("build_id") == BUILD_ID)
                if (not valid or type(message.get("candidate_count")) is not int
                        or message["candidate_count"] != len(candidates) or not component_ok):
                    self._finish_inspection(p, {"status": "failed", "error_code": "inspection_shape_invalid"})
                else:
                    candidates = [{
                        "nonce": c["nonce"], "user_text": c["user_text"], "assistant_text": c["assistant_text"],
                        "assistant_completed_observed": c.get("assistant_completed_observed") is True,
                        "reply_exact_observed": reply_matches(c["assistant_text"], p["expected_reply"]),
                        "selector_strategy": str(c.get("selector_strategy", ""))[:512],
                    } for c in candidates]
                    self._finish_inspection(p, {"status": "observed_unverified",
                        "candidate_count": len(candidates), "candidates": copy.deepcopy(candidates),
                        "conversation_url": p["conversation_url"], "tab_id": p["target_tab_id"],
                         "content_identity": copy.deepcopy(content)})
                return
            if kind == "tab_status":
                url, tab_id = message.get("url"), message.get("tab_id")
                parsed = urlsplit(url) if isinstance(url, str) else None
                valid = (parsed is not None and parsed.scheme == "https" and parsed.netloc == "chatgpt.com"
                         and isinstance(tab_id, int) and not isinstance(tab_id, bool) and tab_id >= 0)
                self.component_report = {key: message.get(key) for key in (
                    "protocol_version", "background_version", "content_version", "manifest_version",
                    "background_build_id", "content_build_id")}
                self.chat_tab_connected = message.get("connected") is True and valid and self._components_match()
                self.chat_tab_id = tab_id if self.chat_tab_connected else None
                self.chat_url = url if self.chat_tab_connected else ""
                self.chat_seen_at = time.monotonic()
                # Do not turn recovery or status traffic into normal send dispatch.
                return
            if kind == "review_bound":
                p = self.pending
                if p is None or not self._identity_matches(message, p["wire_request"]):
                    return
                o = p["original"]
                if (message.get("tab_id") != o["tab_id"] or not is_conversation_url(message.get("conversation_url"))
                        or not self.health()["content_script_ready"] or self.chat_tab_id != o["tab_id"]
                        or self.chat_url != message["conversation_url"]
                        or (o["conversation_url"] and o["conversation_url"] != message["conversation_url"])):
                    return
                # New protocol-2 requests only. First observed binding; never overwrite a pinned URL.
                if not o["conversation_url"]:
                    o["conversation_url"] = message["conversation_url"]
                return
            if kind == "review_result":
                p = self.pending
                if p is None:
                    return
                if not self._identity_matches(message, p["wire_request"]):
                    p["result"] = {"status": "failed", "error_code": "response_identity_mismatch"}
                elif not isinstance(message.get("raw_reply"), str) or len(message["raw_reply"]) > 200_000:
                    p["result"] = {"status": "failed", "error_code": "response_shape_invalid"}
                else:
                    original = p["original"]
                    content = message.get("content_identity")
                    bound = (
                        type(message.get("tab_id")) is int and message["tab_id"] == original["tab_id"]
                        and is_conversation_url(original["conversation_url"])
                        and message.get("conversation_url") == original["conversation_url"]
                        and self.health()["content_script_ready"]
                        and self.chat_tab_id == original["tab_id"] and self.chat_url == original["conversation_url"]
                        and isinstance(content, dict) and content.get("version") == COMPONENT_VERSION
                        and content.get("protocol_version") == PROTOCOL_VERSION and content.get("build_id") == BUILD_ID
                        and message.get("assistant_generation_complete") is True
                        and message.get("reply_match_rule") == "raw-exact-v1"
                    )
                    p["result"] = ({"status": "complete", "raw_reply": message["raw_reply"],
                        "selector_strategy": message.get("selector_strategy", ""),
                        "conversation_url": original["conversation_url"], "tab_id": original["tab_id"],
                        "assistant_generation_complete": True, "reply_match_rule": "raw-exact-v1",
                        "content_identity": copy.deepcopy(content)}
                        if bound else {"status": "failed", "error_code": "normal_response_unconfirmed"})
                self._complete_locked(p)
                session.send_json({"type": "result_ack", "request_id": p["request_id"]})
                return
            if kind == "review_error":
                p = self.pending
                if p and self._identity_matches(message, p["wire_request"]):
                    code = message.get("error_code")
                    safe = code if isinstance(code, str) and re.fullmatch(r"[a-z0-9_]{1,64}", code) else "extension_error"
                    p["result"] = {"status": "failed", "error_code": safe}
                    self._complete_locked(p)
                    session.send_json({"type": "result_ack", "request_id": p["request_id"]})
                return
            if kind in ("recovery_result", "recovery_error"):
                p = self.recovery_pending
                if p is None or message.get("request_id") != p["request_id"]:
                    return
                valid = (
                    self._identity_matches(message, p)
                    and type(message.get("attempt")) is int and message["attempt"] == p["attempt"]
                    and type(message.get("tab_id")) is int and message["tab_id"] == p["target_tab_id"]
                    and message.get("conversation_url") == p["conversation_url"]
                    and is_conversation_url(message.get("conversation_url"))
                    and self.health()["content_script_ready"]
                    and self.chat_tab_id == p["target_tab_id"] and self.chat_url == p["conversation_url"]
                )
                proof_ok = (kind == "recovery_result" and valid
                            and all(message.get(key) is True for key in CHECK_KEYS)
                            and message.get("assistant_generation_complete") is True
                            and message.get("reply_match_rule") == "raw-exact-v1"
                            and reply_matches(message.get("raw_reply"), p["expected_reply"]))
                if proof_ok:
                    p["result"] = {"status": "complete", "raw_reply": message["raw_reply"],
                                   **{key: True for key in CHECK_KEYS}, "assistant_generation_complete": True,
                                   "selector_strategy": message.get("selector_strategy", "")}
                else:
                    code = message.get("error_code") if kind == "recovery_error" and valid else None
                    safe = code if isinstance(code, str) and re.fullmatch(r"[a-z0-9_]{1,64}", code) else "original_smoke_recovery_unconfirmed"
                    p["result"] = {"status": "failed", "error_code": safe}
                self._complete_recovery_locked(p)
                session.send_json({"type": "recovery_ack", "request_id": p["request_id"], "attempt": p["attempt"]})

    @staticmethod
    def _identity_matches(message: dict[str, Any], expected: dict[str, Any]) -> bool:
        return (all(message.get(key) == expected[key] for key in IDENTITY_KEYS)
                and type(message.get("iteration")) is int)

    def _complete_locked(self, pending: dict[str, Any]) -> None:
        self.pending = None
        self.completed[pending["request_id"]] = {
            **pending["result"], "request_id": pending["request_id"], "fingerprint": pending["fingerprint"],
            "nonce": pending["nonce"], "expected_commit": pending["expected_commit"],
            "original": copy.deepcopy(pending["original"]),
        }
        pending["event"].set()

    def _complete_recovery_locked(self, pending: dict[str, Any]) -> None:
        if self.recovery_pending is pending:
            self.recovery_pending = None
        record = {
            **pending["result"], **{key: pending[key] for key in IDENTITY_KEYS},
            "attempt": pending["attempt"], "fingerprint": pending["fingerprint"],
            "conversation_url": pending["conversation_url"], "tab_id": pending["target_tab_id"],
            "expected_reply": pending["expected_reply"], "reply_match_rule": "raw-exact-v1",
            "recovered_original": pending["result"]["status"] == "complete",
        }
        self.recovery_attempts.setdefault(pending["request_id"], []).append(copy.deepcopy(record))
        pending["event"].set()


STATE = BridgeState()


class BridgeHandler(BaseHTTPRequestHandler):
    server_version = "C2CV2LocalBridge"
    sys_version = ""

    def log_message(self, _format: str, *_args: Any) -> None:
        # Intentionally suppress access logs so no instruction, reply, nonce, or token is recorded.
        return

    def _write_json(self, status: int, value: Any) -> None:
        data = _json_bytes(value)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _host_ok(self) -> bool:
        return self.headers.get("Host", "") == f"{HOST}:{PORT}" and self.client_address[0] == HOST

    def _bootstrap_client_allowed(self) -> bool:
        origin = self.headers.get("Origin")
        if origin == STATE.extension_origin:
            return True
        if origin is not None:
            return False
        return (
            self.headers.get("Sec-Fetch-Site") == "none"
            and self.headers.get("Sec-Fetch-Mode") == "cors"
            and self.headers.get("Sec-Fetch-Dest") == "empty"
        )

    def do_GET(self) -> None:
        if not self._host_ok():
            self._write_json(403, {"status": "error", "error_code": "host_rejected"})
            return
        route = urlsplit(self.path)
        if route.query:
            self._write_json(404, {"status": "error", "error_code": "not_found"})
            return
        if route.path == "/health":
            self._write_json(200, STATE.health())
            return
        if route.path == "/bootstrap":
            if not self._bootstrap_client_allowed():
                self._write_json(403, {"status": "error", "error_code": "origin_rejected"})
                return
            self._write_json(200, {"control_token": STATE.control_token, "bridge_identity": STATE.startup_identity})
            return
        if route.path == "/ws":
            self._upgrade_websocket()
            return
        self._write_json(404, {"status": "error", "error_code": "not_found"})

    def do_POST(self) -> None:
        if not self._host_ok():
            self._write_json(403, {"status": "error", "error_code": "host_rejected"})
            return
        if self.path not in {"/review", "/recover", "/inspect"}:
            self._write_json(404, {"status": "error", "error_code": "not_found"})
            return
        try:
            if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
                raise RequestError("application_json_required", 415)
            raw_length = self.headers.get("Content-Length")
            if raw_length is None:
                raise RequestError("content_length_required", 411)
            length = int(raw_length)
            if length < 1 or length > MAX_HTTP_BODY:
                raise RequestError("body_size_invalid", 413)
            value = json.loads(self.rfile.read(length).decode("utf-8"))
            payload = validate_review_payload(value)
            if not hmac.compare_digest(payload["control_token"], STATE.control_token):
                raise RequestError("control_token_rejected", 401)
            fingerprint = request_fingerprint(payload)
            if self.path == "/inspect":
                expected_reply = _single_line(value.get("expected_reply"), "expected_reply", 500)
                pending = STATE.inspect_original_once(payload, value.get("target_tab_id"), expected_reply)
                pending["event"].wait(payload["wait_seconds"])
                if pending["result"] is None:
                    # Finish this observation attempt; no resend/recovery or original-state mutation.
                    with STATE.lock:
                        STATE._finish_inspection(pending, {"status": "failed", "error_code": "inspection_timeout"})
                result = pending["result"]
                self._write_json(200 if result["status"] == "observed_unverified" else 502, result)
                return
            if self.path == "/recover":
                if not payload["request_id"]:
                    raise RequestError("request_id_required")
                expected_reply = _single_line(value.get("expected_reply"), "expected_reply", 500)
                complete, event = STATE.recover_original_once(payload, expected_reply)
                pending = None
            elif payload["request_id"]:
                complete, event = STATE.poll_request(payload["request_id"], fingerprint)
                pending = None
            else:
                pending = STATE.send_request_once(payload)
                complete, event = None, pending["event"]
            if complete is None and event is not None:
                event.wait(payload["wait_seconds"])
                if payload["request_id"]:
                    if self.path == "/recover":
                        complete, _ = STATE.poll_recovery(payload["request_id"], fingerprint)
                    else:
                        complete, _ = STATE.poll_request(payload["request_id"], fingerprint)
                else:
                    with STATE.lock:
                        complete = STATE.completed.get(pending["request_id"])
            if complete is None:
                request_id = payload["request_id"] or (pending["request_id"] if pending else "")
                self._write_json(202, {"status": "pending", "request_id": request_id})
                return
            private_keys = {"fingerprint", "expected_commit", "original"}
            if self.path != "/recover":
                private_keys.add("nonce")
            response = {key: item for key, item in complete.items() if key not in private_keys}
            self._write_json(200 if response.get("status") == "complete" else 502, response)
        except RequestError as error:
            self._write_json(error.status, {"status": "error", "error_code": error.code})
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            self._write_json(400, {"status": "error", "error_code": "invalid_json"})

    def _upgrade_websocket(self) -> None:
        if self.headers.get("Origin") != STATE.extension_origin:
            self._write_json(403, {"status": "error", "error_code": "origin_rejected"})
            return
        if self.headers.get("Upgrade", "").lower() != "websocket" or "upgrade" not in self.headers.get("Connection", "").lower():
            self._write_json(400, {"status": "error", "error_code": "websocket_upgrade_required"})
            return
        if self.headers.get("Sec-WebSocket-Version") != "13":
            self._write_json(400, {"status": "error", "error_code": "websocket_version_unsupported"})
            return
        key = self.headers.get("Sec-WebSocket-Key", "")
        try:
            decoded_key = base64.b64decode(key, validate=True)
        except ValueError:
            decoded_key = b""
        if len(decoded_key) != 16:
            self._write_json(400, {"status": "error", "error_code": "websocket_key_invalid"})
            return
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()).decode("ascii")
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        self.wfile.flush()
        session = WebSocketSession(self.connection)
        try:
            self.connection.settimeout(75)
            opcode, payload = _read_client_frame(self.rfile)
            if opcode != 0x1:
                raise ValueError("websocket_auth_required")
            auth = json.loads(payload.decode("utf-8"))
            if not isinstance(auth, dict) or auth.get("type") != "auth" or not isinstance(auth.get("control_token"), str) or not hmac.compare_digest(auth["control_token"], STATE.control_token):
                session.send_json({"type": "auth_error"})
                return
            welcome = STATE.register_session(session)
            session.send_json(welcome)
            while not session.closed:
                opcode, frame = _read_client_frame(self.rfile)
                if opcode == 0x8:
                    try:
                        session.send_frame(0x8, b"")
                    except OSError:
                        pass
                    break
                if opcode == 0x9:
                    session.send_frame(0xA, frame)
                    continue
                if opcode == 0xA:
                    continue
                if opcode != 0x1:
                    raise ValueError("websocket_text_required")
                message = json.loads(frame.decode("utf-8"))
                STATE.handle_message(session, message)
        except (OSError, EOFError, ValueError, UnicodeDecodeError, json.JSONDecodeError, socket.timeout):
            pass
        finally:
            STATE.unregister_session(session)
            session.close()


class LocalThreadingHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False


def main() -> int:
    global STATE
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("inspection-only", "normal"), default="inspection-only")
    parser.add_argument("--extension-id", default=EXTENSION_ID)
    args = parser.parse_args()
    if re.fullmatch(r"[a-p]{32}", args.extension_id) is None:
        parser.error("--extension-id must contain exactly 32 lowercase letters a-p")
    STATE = BridgeState(inspection_only=args.mode == "inspection-only", extension_id=args.extension_id)
    try:
        server = LocalThreadingHTTPServer((HOST, PORT), BridgeHandler)
    except OSError as error:
        print(json.dumps({"event": "bridge_start_failed", "error": type(error).__name__}), file=sys.stderr, flush=True)
        return 2
    print(json.dumps({"event": "bridge_ready", "host": HOST, "port": PORT, "control_token": STATE.control_token}), flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
