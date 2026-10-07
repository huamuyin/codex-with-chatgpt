"""Isolated Fresh protocol-3 bridge; credentials are handed off only at startup."""
from __future__ import annotations
import argparse
import base64
import copy
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import socket
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

import bridge_server as transport
from fresh_delivery import FreshJournal, FreshRequests, VERSION, BUILD_ID, PROTOCOL, PAYLOAD_KEYS

HOST, PORT = "127.0.0.1", 18797
DATA_ROOT = Path(r"D:\ProjectData\codex-with-chatgpt")
MAX_BODY = 65536


class FreshState:
    def __init__(self, journal, extension_id):
        if not re.fullmatch(r"[a-p]{32}", extension_id): raise ValueError("extension_id_invalid")
        self.requests = FreshRequests(journal)
        self.extension_origin = "chrome-extension://" + extension_id
        self.control_token = secrets.token_urlsafe(32)
        self.lock = threading.RLock()
        self.session = None
        self.active = None
        self.status = {}
        self.seen_at = 0.0
        self.boundaries = {}
        self.maintenance_commands = {}
        self.identity = {"version": VERSION, "protocol_version": PROTOCOL, "build_id": BUILD_ID,
            "host": HOST, "port": PORT, "pid": os.getpid(), "started_at_unix": time.time(),
            "source_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "bridge_session_id": str(uuid.uuid4()), "extension_id": extension_id,
            "delivery_semantics": "AT_LEAST_ONCE"}

    def ready(self):
        s = self.status
        return (not self.requests.journal.poisoned and self.session is not None and not self.session.closed
            and time.monotonic() - self.seen_at < 90 and s.get("connected") is True
            and s.get("candidate_count") == 1 and type(s.get("candidate_count")) is int
            and type(s.get("tab_id")) is int and s["tab_id"] >= 0
            and (s.get("url") == "https://chatgpt.com/" or transport.is_conversation_url(s.get("url")))
            and s.get("components") == self.expected_components())

    @staticmethod
    def expected_components():
        return {"protocol_version": PROTOCOL, "background_version": VERSION, "content_version": VERSION,
                "manifest_version": VERSION, "build_id": BUILD_ID}

    def health(self):
        with self.lock:
            return {"bridge_identity": copy.deepcopy(self.identity), "extension_connected": self.session is not None and not self.session.closed,
                    "ready": self.ready(), "active_attempt": copy.deepcopy(self.active),
                    "journal_ok": not self.requests.journal.poisoned, "delivery_semantics": "AT_LEAST_ONCE",
                    "boundaries": copy.deepcopy(self.boundaries),
                    "extension_status": {k: copy.deepcopy(self.status.get(k)) for k in
                        ("connected", "candidate_count", "tab_id", "url", "components", "readiness_code", "attempt_diagnostics", "content_generation", "observed_targets", "bound_tab_diagnostics", "page_state")}}

    def boundary(self, name, **details):
        # Call sites supply only explicit non-secret fields, never headers, tokens or raw DOM.
        with self.lock:
            self.boundaries[name] = {"observed_at_unix": time.time(), **details}

    def maintenance(self, value):
        with self.lock:
            if self.requests.journal.poisoned:
                raise transport.RequestError("extension_disconnected", 503)
            action = value.get("action")
            if action not in ("reload_extension", "sample_status", "restore_thread", "activate_tab", "inspect_draft", "reload_content", "reload_tab", "observe_attempt", "observe_request", "probe_reply_rejection"):
                raise transport.RequestError("maintenance_action_invalid")
            if action != "reload_extension" and (self.session is None or self.session.closed):
                raise transport.RequestError("extension_disconnected", 503)
            message = {"type": "fresh_maintenance", "maintenance_id": str(uuid.uuid4()), "action": action}
            if action == "restore_thread":
                rid, cid, aid = value.get("request_id"), value.get("control_id"), value.get("attempt_id")
                if not isinstance(rid, str) or not isinstance(cid, str) or type(aid) is not int:
                    raise transport.RequestError("maintenance_identity_required", 409)
                r = self.requests.lookup(rid, control_id=cid)
                if not 1 <= aid <= len(r["attempts"]): raise transport.RequestError("attempt_unknown", 409)
                wire = self.requests.wire_request(rid, aid); tid, url = value.get("tab_id"), value.get("url")
                bound = [d for d in self.status.get("bound_tab_diagnostics", []) if d.get("tab_id") == tid]
                observed = self.status.get("observed_targets", [])
                if (type(tid) is not int or tid != wire["target_tab_id"] or url != wire["conversation_url"]
                    or not transport.is_conversation_url(url) or len(bound) != 1 or bound[0].get("exists") is not True
                    or bound[0].get("status") != "complete" or bound[0].get("url") not in ("https://chatgpt.com/", url)
                    or sum(d.get("url") == bound[0].get("url") for d in observed) != 1
                    or any(d.get("url") == url and d.get("tab_id") != tid for d in observed)
                    or time.monotonic() - self.seen_at >= 90):
                    raise transport.RequestError("maintenance_target_unconfirmed", 409)
                message.update(tab_id=tid, url=url, request=wire)
            if action in ("activate_tab", "inspect_draft", "reload_content", "reload_tab", "observe_attempt", "observe_request", "probe_reply_rejection"):
                tid, url = value.get("tab_id"), value.get("url")
                setup_root = not self.requests.records and url == "https://chatgpt.com/"
                fresh_thread = transport.is_conversation_url(url) and any(r["conversation_url"] == url for r in self.requests.records.values())
                # Script maintenance at a pending Fresh root transition does not bind its journal URL.
                fresh_transition = transport.is_conversation_url(url) and any(not r["conversation_url"]
                    and any(a["tab_id"] == tid and a["conversation_url"] == "https://chatgpt.com/" for a in r["attempts"])
                    for r in self.requests.records.values())
                if (type(tid) is not int or tid < 0 or not (setup_root or fresh_thread or fresh_transition)
                    or tid != self.status.get("tab_id") or url != self.status.get("url")
                    or type(self.status.get("candidate_count")) is not int or self.status.get("candidate_count") != 1):
                    raise transport.RequestError("maintenance_target_unconfirmed", 409)
                message.update(tab_id=tid, url=url)
                if action == "observe_attempt":
                    matches = [self.requests.wire_request(r["request_id"], len(r["attempts"])) for r in self.requests.records.values()
                               if r["attempts"] and r["attempts"][-1]["tab_id"] == tid and r["status"] != "complete"
                               and (r["conversation_url"] == url or not r["conversation_url"] and r["attempts"][-1]["conversation_url"] == "https://chatgpt.com/")]
                    if len(matches) != 1 or not self.ready(): raise transport.RequestError("maintenance_attempt_unconfirmed", 409)
                    message["request"] = matches[0]
                if action in ("activate_tab", "inspect_draft", "observe_request", "probe_reply_rejection"):
                    rid, cid, aid = value.get("request_id"), value.get("control_id"), value.get("attempt_id")
                    if not isinstance(rid, str) or not isinstance(cid, str) or type(aid) is not int:
                        raise transport.RequestError("maintenance_identity_required", 409)
                    r = self.requests.lookup(rid, control_id=cid)
                    if not 1 <= aid <= len(r["attempts"]): raise transport.RequestError("attempt_unknown", 409)
                    wire = self.requests.wire_request(rid, aid)
                    if wire["target_tab_id"] != tid or wire["conversation_url"] != url or action != "activate_tab" and not self.ready():
                        raise transport.RequestError("maintenance_attempt_unconfirmed", 409)
                    message["request"] = wire
                    if action == "probe_reply_rejection":
                        field = value.get("field")
                        if field not in ("request_id", "control_id", "attempt_id", "expected_commit", "conversation_url"):
                            raise transport.RequestError("probe_field_invalid")
                        message["field"] = field
                if action in ("observe_attempt", "observe_request"):
                    message["observation"] = self.observation_options(value.get("observation"))
            event = threading.Event()
            self.maintenance_commands[message["maintenance_id"]] = {"message": message, "event": event, "result": None}
            pending = self.maintenance_commands[message["maintenance_id"]]
            pending["expires_at"] = time.monotonic() + 10
            if self.session is not None and not self.session.closed: self.session.send_json(message)
            self.boundary("maintenance", action=action, status="requested", maintenance_id=message["maintenance_id"])
            return message["maintenance_id"], event

    def maintenance_handoff(self, session):
        # Bounded retransmission of an explicitly authorized maintenance command only.
        # Welcome/cache restore is asynchronous in Chrome; it must never dispatch a review.
        for _ in range(100):
            with self.lock:
                if self.session is not session or session.closed: return
                pending = [p for p in self.maintenance_commands.values() if p["message"]["action"] == "reload_extension"
                           and not p["event"].is_set() and time.monotonic() < p.get("expires_at", 0)]
                if not pending: return
                for p in pending:
                    try: session.send_json(p["message"])
                    except OSError: return
            time.sleep(.01)

    @staticmethod
    def observation_options(value=None):
        if value is None: return {}
        if not isinstance(value, dict) or set(value) - {"reply_wait_ms", "locator_miss"}:
            raise transport.RequestError("observation_options_invalid")
        wait = value.get("reply_wait_ms", 600000)
        if type(wait) is not int or not 1000 <= wait <= 600000 or type(value.get("locator_miss", False)) is not bool:
            raise transport.RequestError("observation_options_invalid")
        return copy.deepcopy(value)

    def register(self, session):
        with self.lock:
            if self.session is not None and not self.session.closed and self.session is not session:
                raise transport.RequestError("extension_session_already_active", 409)
            checkpoint = self.requests.checkpoint()
            self.session = session; self.status = {}; self.seen_at = time.monotonic()
            # Restoring a mirror never sends or retries a request.
            return {"type": "fresh_welcome", "bridge_identity": copy.deepcopy(self.identity), "checkpoint": checkpoint}

    def unregister(self, session):
        with self.lock:
            if self.session is session: self.session = None; self.status = {}

    def send(self, payload, *, retry=False, control_id=None, observation=None):
        with self.lock:
            observation = self.observation_options(observation)
            if observation.get("locator_miss"): raise transport.RequestError("locator_fault_observe_only")
            if not self.ready(): raise transport.RequestError("extension_or_chat_disconnected", 503)
            rid = payload.get("request_id")
            if retry:
                if not rid or not control_id: raise transport.RequestError("retry_identity_required")
                r = self.requests.lookup(rid, payload, control_id)
                if r["status"] == "complete": return r
                if self.active and self.active["request_id"] != rid: raise transport.RequestError("request_in_flight", 409)
                # Explicit retry permits another actual send, even if the previous outcome was uncertain.
            else:
                if rid: raise transport.RequestError("new_request_must_not_supply_id")
                if self.active: raise transport.RequestError("request_in_flight", 409)
                if payload["conversation_url"] and payload["conversation_url"] != self.status["url"]:
                    raise transport.RequestError("conversation_binding_mismatch", 409)
                rid = self.requests.create(payload, self.status["url"])
            wire = self.requests.prepare_attempt(rid, self.status["tab_id"], self.status["url"],
                                                 self.expected_components(), self.identity)
            self.active = {"request_id": rid, "control_id": wire["control_id"], "attempt_id": wire["attempt_id"]}
            self.requests.waiters.setdefault(rid, threading.Event())
            try:
                self.session.send_json({"type": "fresh_review", "request": wire, "observation": observation})
            except OSError:
                self.requests.failed(rid, wire["attempt_id"], "delivery_uncertain", uncertain=True)
                self.active = None
            return self.requests.lookup(rid)

    def poll(self, payload, control_id=None):
        with self.lock:
            if not control_id: raise transport.RequestError("poll_control_id_required")
            return self.requests.lookup(payload["request_id"], payload, control_id)

    def timeout(self, rid, aid):
        with self.lock:
            r = self.requests.lookup(rid)
            if r["status"] != "complete": self.requests.failed(rid, aid, "caller_wait_timeout")
            if self.active and self.active["request_id"] == rid and self.active["attempt_id"] == aid: self.active = None

    def message(self, session, m):
        with self.lock:
            if self.session is not session or not isinstance(m, dict): return
            self.seen_at = time.monotonic()
            if m.get("type") == "ping": session.send_json({"type": "pong"}); return
            if m.get("type") == "fresh_status": self.status = copy.deepcopy(m); return
            if m.get("type") == "fresh_diagnostic":
                rid, cid, aid = m.get("request_id"), m.get("control_id"), m.get("attempt_id")
                r = self.requests.lookup(rid, control_id=cid)
                if type(aid) is not int or not 1 <= aid <= len(r["attempts"]): return
                code = m.get("code")
                if code not in ("tab_missing", "sender_tab_mismatch", "sender_url_mismatch", "content_version_mismatch"): return
                self.boundary("content_return", code=code, request_id=rid, control_id=cid, attempt_id=aid,
                    **{k: m.get(k) for k in ("sender_url", "tab_url", "content_url")
                       if m.get(k) == "https://chatgpt.com/" or transport.is_conversation_url(m.get(k))})
                return
            if m.get("type") == "fresh_maintenance_result":
                pending = self.maintenance_commands.get(m.get("maintenance_id"))
                if pending is None or m.get("action") != pending["message"]["action"]: return
                result = {"maintenance_id": m["maintenance_id"], "action": m["action"],
                          "status": "complete" if m.get("complete") is True else "failed"}
                code = m.get("error_code")
                if isinstance(code, str) and re.fullmatch(r"[a-z0-9_]{1,64}", code): result["error_code"] = code
                generation = m.get("content_generation")
                if type(generation) is int and generation > 0: result["content_generation"] = generation
                if pending["message"]["action"] == "inspect_draft" and isinstance(m.get("draft_summary"), dict):
                    d = m["draft_summary"]
                    if (set(d) == {"composer_present", "composer_tag", "contenteditable", "length", "empty", "format_only", "owned_attempt_id", "normalized_owned_attempt_id"}
                        and type(d["length"]) is int and 0 <= d["length"] <= 200000
                        and all(type(d[k]) is bool for k in ("composer_present", "contenteditable", "empty", "format_only"))
                        and d["composer_tag"] in ("TEXTAREA", "INPUT", "DIV", "P", "")
                        and all(d[k] is None or type(d[k]) is int
                             and 1 <= d[k] <= len(self.requests.lookup(pending["message"]["request"]["request_id"])["attempts"])
                             for k in ("owned_attempt_id", "normalized_owned_attempt_id"))):
                        result["draft_summary"] = copy.deepcopy(d)
                if pending["message"]["action"] == "probe_reply_rejection":
                    if m.get("field") == pending["message"]["field"]: result["field"] = m["field"]
                    code = m.get("rejection_code")
                    if isinstance(code, str) and re.fullmatch(r"[a-z0-9_]{1,64}", code): result["rejection_code"] = code
                    result["rejected"] = m.get("rejected") is True
                pending["result"] = result; pending["event"].set()
                self.boundary("maintenance", **result); return
            if m.get("type") not in ("fresh_bound", "fresh_result", "fresh_error"): return
            rid, cid, aid = m.get("request_id"), m.get("control_id"), m.get("attempt_id")
            r = self.requests.lookup(rid, control_id=cid)
            if type(aid) is not int or not 1 <= aid <= len(r["attempts"]): raise transport.RequestError("attempt_unknown", 409)
            wire = self.requests.wire_request(rid, aid)
            if any(m.get(k) != wire[k] for k in ("task_id", "iteration", "repo", "branch", "expected_commit")) or type(m.get("iteration")) is not int:
                raise transport.RequestError("reply_identity_mismatch", 409)
            if m["type"] == "fresh_error":
                code = m.get("error_code", "content_error")
                if not isinstance(code, str) or not re.fullmatch(r"[a-z0-9_]{1,64}", code): code = "content_error"
                self.requests.failed(rid, aid, code)
            else:
                if (not self.ready() or type(m.get("tab_id")) is not int or m["tab_id"] != wire["target_tab_id"]
                    or m["tab_id"] != self.status["tab_id"] or m.get("conversation_url") != self.status["url"]
                    or not transport.is_conversation_url(m.get("conversation_url"))):
                    raise transport.RequestError("reply_binding_unconfirmed", 409)
                if m["type"] == "fresh_bound":
                    self.requests.bind(rid, aid, m["tab_id"], m["conversation_url"]); return
                result = {k: m.get(k) for k in ("raw_reply", "conversation_url", "tab_id", "assistant_generation_complete", "content_identity")}
                try: kind = self.requests.accept(rid, cid, aid, result)
                except ValueError as error: raise transport.RequestError("reply_unconfirmed", 409) from error
                session.send_json({"type": "fresh_result_ack", "request_id": rid, "control_id": cid, "attempt_id": aid, "classification": kind})
            if self.active and self.active["request_id"] == rid:
                if m["type"] == "fresh_result" or self.active["attempt_id"] == aid: self.active = None


class FreshHandler(BaseHTTPRequestHandler):
    state: FreshState
    protocol_version = "HTTP/1.1"
    def log_message(self, *_): pass
    def write(self, status, value):
        data = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status); self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data))); self.send_header("Cache-Control", "no-store"); self.end_headers(); self.wfile.write(data)
    def host_ok(self): return self.headers.get("Host") == f"{HOST}:{PORT}" and self.client_address[0] == HOST
    def bootstrap(self, method):
        matches = self.headers.get("Origin") == self.state.extension_origin
        self.state.boundary("bootstrap", method=method, host_matches=True,
                            origin_present=self.headers.get("Origin") is not None,
                            origin_matches=matches, http_status=200 if matches else 403,
                            reason="accepted" if matches else "origin_rejected")
        if not matches: self.write(403, {"error_code": "origin_rejected"}); return
        self.write(200, {"control_token": self.state.control_token, "bridge_identity": self.state.identity})
    def do_GET(self):
        if not self.host_ok(): self.write(403, {"error_code": "host_rejected"}); return
        if self.path == "/health": self.write(200, self.state.health())
        elif self.path == "/bootstrap":
            self.bootstrap("GET")
        elif self.path == "/ws": self.websocket()
        else: self.write(404, {"error_code": "not_found"})
    def do_POST(self):
        if not self.host_ok(): self.write(403, {"error_code": "host_rejected"}); return
        if self.path == "/bootstrap": self.bootstrap("POST"); return
        # No original-smoke recovery path exists in this new protocol.
        if self.path == "/recover": self.write(410, {"error_code": "legacy_recovery_closed"}); return
        if self.path not in ("/review", "/retry", "/maintenance"): self.write(404, {"error_code": "not_found"}); return
        try:
            if self.headers.get("Content-Type", "").split(";", 1)[0] != "application/json": raise transport.RequestError("application_json_required", 415)
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BODY: raise transport.RequestError("body_size_invalid", 413)
            value = json.loads(self.rfile.read(length))
            if self.path == "/maintenance":
                token = value.get("control_token") if isinstance(value, dict) else None
                if not isinstance(token, str) or not hmac.compare_digest(token, self.state.control_token):
                    raise transport.RequestError("control_token_rejected", 401)
                mid, event = self.state.maintenance(value); event.wait(10)
                with self.state.lock: result = self.state.maintenance_commands[mid]["result"]
                self.write(200 if result is not None else 202, result or {"maintenance_id": mid, "status": "pending"}); return
            payload = transport.validate_review_payload(value)
            if not hmac.compare_digest(payload["control_token"], self.state.control_token): raise transport.RequestError("control_token_rejected", 401)
            if self.path == "/review" and payload["request_id"]: result = self.state.poll(payload, value.get("control_id"))
            else:
                result = self.state.send(payload, retry=self.path == "/retry", control_id=value.get("control_id"), observation=value.get("observation"))
                rid = result["request_id"]; aid = len(result["attempts"])
                event = self.state.requests.waiters.get(rid)
                if result["status"] == "pending" and event is not None: event.wait(payload["wait_seconds"])
                result = self.state.requests.lookup(rid)
                if result["status"] == "pending": self.state.timeout(rid, aid); result = self.state.requests.lookup(rid)
            self.write(200 if result["status"] == "complete" else 202, result)
        except transport.RequestError as error: self.write(error.status, {"error_code": error.code})
        except (ValueError, TypeError, KeyError): self.write(400, {"error_code": "invalid_request_or_evidence"})
    def websocket(self):
        if self.headers.get("Origin") != self.state.extension_origin: self.write(403, {"error_code": "origin_rejected"}); return
        try: key = base64.b64decode(self.headers.get("Sec-WebSocket-Key", ""), validate=True)
        except ValueError: key = b""
        if (len(key) != 16 or self.headers.get("Upgrade", "").lower() != "websocket"
                or "upgrade" not in self.headers.get("Connection", "").lower() or self.headers.get("Sec-WebSocket-Version") != "13"):
            self.write(400, {"error_code": "websocket_upgrade_invalid"}); return
        accept = base64.b64encode(hashlib.sha1((self.headers["Sec-WebSocket-Key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        self.send_response(101); self.send_header("Upgrade", "websocket"); self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept); self.end_headers(); self.wfile.flush()
        session = transport.WebSocketSession(self.connection)
        try:
            self.connection.settimeout(75)
            op, raw = transport._read_client_frame(self.rfile); auth = json.loads(raw)
            if op != 1 or auth.get("type") != "auth" or not isinstance(auth.get("control_token"), str) or not hmac.compare_digest(auth["control_token"], self.state.control_token):
                session.send_json({"type": "auth_error"}); return
            session.send_json(self.state.register(session))
            self.state.boundary("websocket", authenticated=True, origin_matches=True)
            threading.Thread(target=self.state.maintenance_handoff, args=(session,), daemon=True).start()
            while not session.closed:
                op, raw = transport._read_client_frame(self.rfile)
                if op == 8: break
                if op == 9: session.send_frame(10, raw); continue
                if op == 10: continue
                if op != 1: break
                try: self.state.message(session, json.loads(raw))
                except transport.RequestError as error: session.send_json({"type": "fresh_protocol_error", "error_code": error.code})
        except (OSError, EOFError, ValueError, TypeError, transport.RequestError) as error:
            safe_codes = {"websocket_frame_too_large", "unsupported_websocket_frame", "unmasked_client_frame"}
            self.state.boundary("websocket_exit", reason=str(error) if str(error) in safe_codes else type(error).__name__)
        finally: self.state.unregister(session); session.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", required=True); parser.add_argument("--namespace", required=True)
    parser.add_argument("--extension-id", required=True); parser.add_argument("--initialize-journal", action="store_true")
    args = parser.parse_args()
    if Path(args.data_root).resolve() != DATA_ROOT.resolve(): parser.error("exact project data-root required")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,96}", args.namespace) or args.namespace in (".", ".."): parser.error("namespace invalid")
    if not re.fullmatch(r"[a-p]{32}", args.extension_id) or args.extension_id == transport.EXTENSION_ID: parser.error("independent extension ID required")
    journal = FreshJournal(DATA_ROOT / "runtime" / "extension_control_fresh_18797" / args.namespace,
                           args.namespace, initialize=args.initialize_journal)
    try:
        state = FreshState(journal, args.extension_id)
        handler = type("BoundFreshHandler", (FreshHandler,), {"state": state})
        server = transport.LocalThreadingHTTPServer((HOST, PORT), handler)
        print(json.dumps({"event": "fresh_bridge_ready", "bridge_identity": state.identity, "control_token": state.control_token}), flush=True)
        try: server.serve_forever()
        finally: server.server_close()
    finally: journal.close()


if __name__ == "__main__": main()
