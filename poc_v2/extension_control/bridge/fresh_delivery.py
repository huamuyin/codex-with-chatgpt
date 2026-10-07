"""Future protocol 3: durable logical requests with at-least-once attempts.

No legacy import, original-smoke recovery, networking, or implicit data directory.
"""
from __future__ import annotations
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import threading
import uuid

from bridge_server import validate_review_payload, format_control_message, is_conversation_url, RequestError

VERSION = "0.9.8"
BUILD_ID = "c2c-v2-fresh-paired-turn-completion-1"
KNOWN_BUILDS = {"0.9.0": "c2c-v2-fresh-at-least-once-1", "0.9.1": "c2c-v2-fresh-bootstrap-post-1",
                "0.9.2": "c2c-v2-fresh-transition-diagnostics-1", "0.9.3": "c2c-v2-fresh-dom-diagnostics-1",
                "0.9.4": "c2c-v2-fresh-bounded-transcript-probe-1", "0.9.5": "c2c-v2-fresh-turn-context-probe-1",
                "0.9.6": "c2c-v2-fresh-bounded-turn-context-1", "0.9.7": "c2c-v2-fresh-heading-turns-1", VERSION: BUILD_ID}
PROTOCOL = 3
PROJECT_DATA_ROOT = Path(r"D:\ProjectData\codex-with-chatgpt")
LEGACY_ID = "4754374f-14dd-4004-bf87-3b87972e17fa"
PAYLOAD_KEYS = ("task_id", "iteration", "repo", "pr", "branch", "commit", "evidence_path", "instruction", "conversation_url")
KINDS = {"logical_created", "send_attempt", "delivery_uncertain", "attempt_failed", "thread_bound", "result", "duplicate_reply"}
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def decode(raw):
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value: raise ValueError("journal_duplicate_key")
            value[key] = item
        return value
    return json.loads(raw, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("journal_nonfinite")))


def wire_message(payload, request_id, control_id, attempt_id):
    message = format_control_message(payload, control_id, request_id)
    return message.replace(f"NONCE: {control_id}",
                           f"CONTROL_ID: {control_id}\nATTEMPT_ID: {attempt_id}\nNONCE: {control_id}", 1)


class FreshJournal:
    """Immutable events and sealed head; interrupted writes fail closed, never reset.

    Hashes detect accidental damage; they are not signatures against a local attacker.
    Directory ownership/ACLs remain a deployment concern. One process holds the writer lock.
    """
    def __init__(self, directory, namespace, *, initialize=False):
        self.path = Path(directory)
        if (not self.path.is_absolute() or self.path == Path(self.path.anchor)
                or self.path.resolve() != self.path.absolute()
                or not self.path.resolve().is_relative_to(PROJECT_DATA_ROOT.resolve())):
            raise ValueError("explicit_direct_journal_path_required")
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,96}", namespace) or namespace in (".", ".."):
            raise ValueError("journal_namespace_invalid")
        self.owner = {"schema": 1, "protocol_version": PROTOCOL, "namespace": namespace,
                      "delivery_semantics": "AT_LEAST_ONCE"}
        self.lock_file = None
        self.poisoned = False
        self.events = []
        if initialize:
            self.path.mkdir(parents=True, exist_ok=False)
            for name, raw in (("owner.json", encoded(self.owner) + b"\n"), ("events.jsonl", b""),
                              ("head.json", encoded({"sequence": 0, "hash": "0" * 64}) + b"\n"), ("writer.lock", b"0")):
                self._write_new(self.path / name, raw)
        try:
            self.lock_file = (self.path / "writer.lock").open("r+b")
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.lock_file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.verify()
        except (OSError, ValueError, TypeError, KeyError) as error:
            self.close()
            raise ValueError("journal_open_failed") from error

    def close(self):
        if self.lock_file:
            self.lock_file.close()
            self.lock_file = None

    @staticmethod
    def _write_new(path, raw):
        with path.open("xb") as stream:
            stream.write(raw); stream.flush(); os.fsync(stream.fileno())

    def verify(self):
        if self.poisoned or self.lock_file is None: raise ValueError("journal_unavailable")
        try:
            if any((self.path / name).is_symlink() for name in ("owner.json", "head.json", "events.jsonl", "writer.lock")):
                raise ValueError("indirect_journal_file")
            if decode((self.path / "owner.json").read_bytes()) != self.owner: raise ValueError("journal_owner_mismatch")
            raw = (self.path / "events.jsonl").read_bytes()
            if raw and not raw.endswith(b"\n"): raise ValueError("journal_truncated")
            events, previous = [], "0" * 64
            for index, line in enumerate(raw.splitlines(), 1):
                envelope = decode(line)
                if not isinstance(envelope, dict) or set(envelope) != {"event", "hash"}: raise ValueError("journal_shape")
                event = envelope["event"]
                if (not isinstance(event, dict) or set(event) != {"schema", "sequence", "previous_hash", "kind", "request_id", "control_id", "data"}
                        or type(event["schema"]) is not int or event["schema"] != 1
                        or type(event["sequence"]) is not int or event["sequence"] != index
                        or event["previous_hash"] != previous or event["kind"] not in KINDS): raise ValueError("journal_event_invalid")
                digest = hashlib.sha256(encoded(event)).hexdigest()
                if envelope["hash"] != digest: raise ValueError("journal_hash_mismatch")
                events.append(event); previous = digest
            FreshRequests.replay(events)  # Schema/identity/attempt/result checks, including a recomputed hash chain.
            seal = decode((self.path / "head.json").read_bytes())
            if seal != {"sequence": len(events), "hash": previous} or type(seal.get("sequence")) is not int:
                raise ValueError("journal_seal_mismatch")
            self.events, self.head_hash = events, previous
        except (OSError, ValueError, TypeError, KeyError) as error:
            self.poisoned = True
            raise ValueError("journal_integrity_failed") from error

    def append(self, kind, request_id, control_id, data):
        self.verify()
        event = {"schema": 1, "sequence": len(self.events) + 1, "previous_hash": self.head_hash,
                 "kind": kind, "request_id": request_id, "control_id": control_id, "data": copy.deepcopy(data)}
        FreshRequests.replay([*self.events, event])  # Reject before writing any invalid data.
        digest = hashlib.sha256(encoded(event)).hexdigest()
        try:
            with (self.path / "events.jsonl").open("ab") as stream:
                stream.write(encoded({"event": event, "hash": digest}) + b"\n"); stream.flush(); os.fsync(stream.fileno())
            temporary = self.path / ("head-" + str(uuid.uuid4()) + ".tmp")
            self._write_new(temporary, encoded({"sequence": event["sequence"], "hash": digest}) + b"\n")
            os.replace(temporary, self.path / "head.json")
            self.verify()
        except (OSError, ValueError) as error:
            self.poisoned = True
            raise ValueError("journal_write_failed") from error


class FreshRequests:
    def __init__(self, journal):
        self.journal = journal
        self.lock = threading.RLock()
        self.waiters = {}
        self.records = self.replay(journal.events)

    @staticmethod
    def replay(events):
        records = {}
        controls = set()
        def require(ok):
            if not ok: raise ValueError("fresh_event_invalid")
        for event in events:
            rid, cid, kind, d = (event[k] for k in ("request_id", "control_id", "kind", "data"))
            require(isinstance(rid, str) and UUID.fullmatch(rid) and rid != LEGACY_ID
                    and isinstance(cid, str) and UUID.fullmatch(cid) and isinstance(d, dict))
            if kind == "logical_created":
                require(rid not in records and cid not in controls and set(d) == {"payload", "conversation_url"}
                        and isinstance(d["payload"], dict) and set(d["payload"]) == set(PAYLOAD_KEYS))
                p = validate_review_payload({**d["payload"], "control_token": "x" * 43})
                require({k: p[k] for k in PAYLOAD_KEYS} == d["payload"])
                require((d["conversation_url"] == "" or is_conversation_url(d["conversation_url"]))
                        and (not p["conversation_url"] or p["conversation_url"] == d["conversation_url"]))
                records[rid] = {"request_id": rid, "control_id": cid, "payload": copy.deepcopy(d["payload"]),
                    "conversation_url": d["conversation_url"], "attempts": [], "status": "pending", "result": None,
                    "duplicate_count": 0}
                controls.add(cid); continue
            require(rid in records and records[rid]["control_id"] == cid)
            r = records[rid]
            aid = d.get("attempt_id")
            require(type(aid) is int and aid > 0)
            if kind == "send_attempt":
                require(set(d) == {"attempt_id", "wire_message", "tab_id", "conversation_url", "components", "bridge_identity"}
                        and aid == len(r["attempts"]) + 1 and r["status"] != "complete"
                        and type(d["tab_id"]) is int and d["tab_id"] >= 0
                        and d["conversation_url"] == (r["conversation_url"] or "https://chatgpt.com/")
                        and d["wire_message"] == wire_message(r["payload"], rid, cid, aid)
                        and isinstance(d["bridge_identity"], dict)
                        and set(d["bridge_identity"]) == {"version", "protocol_version", "build_id", "host", "port", "pid",
                            "started_at_unix", "source_sha256", "bridge_session_id", "extension_id", "delivery_semantics"}
                        and d["bridge_identity"].get("version") in KNOWN_BUILDS
                        and d["bridge_identity"].get("build_id") == KNOWN_BUILDS[d["bridge_identity"]["version"]]
                        and d["bridge_identity"].get("protocol_version") == PROTOCOL
                        and d["components"] == {"protocol_version": PROTOCOL,
                            "background_version": d["bridge_identity"]["version"], "content_version": d["bridge_identity"]["version"],
                            "manifest_version": d["bridge_identity"]["version"], "build_id": d["bridge_identity"]["build_id"]}
                        and d["bridge_identity"].get("host") == "127.0.0.1" and d["bridge_identity"].get("port") == 18797
                        and type(d["bridge_identity"].get("pid")) is int and d["bridge_identity"]["pid"] > 0
                        and isinstance(d["bridge_identity"].get("started_at_unix"), (int, float))
                        and d["bridge_identity"]["started_at_unix"] > 0
                        and re.fullmatch(r"[a-p]{32}", d["bridge_identity"].get("extension_id", ""))
                        and d["bridge_identity"].get("delivery_semantics") == "AT_LEAST_ONCE"
                        and isinstance(d["bridge_identity"].get("bridge_session_id"), str)
                        and re.fullmatch(r"[a-f0-9]{64}", d["bridge_identity"].get("source_sha256", "")))
                r["attempts"].append({**copy.deepcopy(d), "status": "pending", "error_code": None})
                r["status"] = "pending"; continue
            require(aid <= len(r["attempts"]))
            attempt = r["attempts"][aid - 1]
            if kind in ("attempt_failed", "delivery_uncertain"):
                require(set(d) == {"attempt_id", "error_code"} and isinstance(d["error_code"], str)
                        and re.fullmatch(r"[a-z0-9_]{1,64}", d["error_code"]))
                attempt["status"] = "failed"; attempt["error_code"] = d["error_code"]
                if r["status"] != "complete": r["status"] = "failed"
            elif kind == "thread_bound":
                require(set(d) == {"attempt_id", "conversation_url", "tab_id"} and type(d["tab_id"]) is int
                        and d["tab_id"] == attempt["tab_id"] and is_conversation_url(d["conversation_url"])
                        and (not r["conversation_url"] or r["conversation_url"] == d["conversation_url"]))
                r["conversation_url"] = d["conversation_url"]
                attempt["conversation_url"] = d["conversation_url"]
            elif kind in ("result", "duplicate_reply"):
                require(set(d) == {"attempt_id", "raw_reply", "conversation_url", "tab_id", "assistant_generation_complete", "content_identity"}
                        and isinstance(d["raw_reply"], str) and bool(d["raw_reply"].strip()) and len(d["raw_reply"]) <= 200000
                        and type(d["tab_id"]) is int and d["tab_id"] == attempt["tab_id"]
                        and is_conversation_url(r["conversation_url"]) and d["conversation_url"] == r["conversation_url"]
                        and d["assistant_generation_complete"] is True
                        and isinstance(d["content_identity"], dict)
                        and d["content_identity"].get("version") in KNOWN_BUILDS
                        and d["content_identity"] == {"protocol_version": PROTOCOL, "version": d["content_identity"]["version"],
                            "build_id": KNOWN_BUILDS[d["content_identity"]["version"]]})
                require((kind == "duplicate_reply") == (r["status"] == "complete"))
                attempt["status"] = "complete"
                if kind == "result": r["status"] = "complete"; r["result"] = copy.deepcopy(d)
                else: r["duplicate_count"] += 1
            else: raise ValueError("fresh_event_kind_invalid")
        return records

    def _append(self, kind, r, data):
        try:
            self.journal.append(kind, r["request_id"], r["control_id"], data)
            self.records = self.replay(self.journal.events)
        except (OSError, ValueError) as error:
            raise RequestError("journal_unavailable", 503) from error

    def create(self, payload, initial_url=None):
        with self.lock:
            rid, cid = str(uuid.uuid4()), str(uuid.uuid4())
            r = {"request_id": rid, "control_id": cid}
            url = initial_url if initial_url is not None else payload["conversation_url"]
            self._append("logical_created", r, {"payload": {k: payload[k] for k in PAYLOAD_KEYS},
                                               "conversation_url": "" if url == "https://chatgpt.com/" else url})
            return rid

    def lookup(self, rid, payload=None, control_id=None):
        r = self.records.get(rid)
        if r is None: raise RequestError("request_id_unknown", 404)
        if (payload is not None and any(payload[k] != r["payload"][k] for k in PAYLOAD_KEYS)) or (control_id is not None and control_id != r["control_id"]):
            raise RequestError("logical_identity_mismatch", 409)
        return copy.deepcopy(r)

    def prepare_attempt(self, rid, tab_id, url, components, bridge_identity):
        with self.lock:
            r = self.lookup(rid)
            if r["status"] == "complete": raise RequestError("logical_request_complete", 409)
            aid = len(r["attempts"]) + 1
            self._append("send_attempt", r, {"attempt_id": aid,
                "wire_message": wire_message(r["payload"], rid, r["control_id"], aid), "tab_id": tab_id,
                "conversation_url": url, "components": components, "bridge_identity": bridge_identity})
            return self.wire_request(rid, aid)

    def wire_request(self, rid, aid):
        r = self.lookup(rid); a = r["attempts"][aid - 1]
        return {"request_id": rid, "control_id": r["control_id"], "attempt_id": aid, "task_id": r["payload"]["task_id"],
            "iteration": r["payload"]["iteration"], "repo": r["payload"]["repo"], "branch": r["payload"]["branch"],
            "expected_commit": r["payload"]["commit"], "nonce": r["control_id"], "message": a["wire_message"],
            "target_tab_id": a["tab_id"], "conversation_url": a["conversation_url"]}

    def failed(self, rid, aid, code, uncertain=False):
        with self.lock:
            r = self.lookup(rid)
            self._append("delivery_uncertain" if uncertain else "attempt_failed", r, {"attempt_id": aid, "error_code": code})

    def bind(self, rid, aid, tab_id, url):
        with self.lock:
            r = self.lookup(rid)
            self._append("thread_bound", r, {"attempt_id": aid, "tab_id": tab_id, "conversation_url": url})

    def accept(self, rid, cid, aid, result):
        with self.lock:
            r = self.lookup(rid, control_id=cid)
            kind = "duplicate_reply" if r["status"] == "complete" else "result"
            self._append(kind, r, {"attempt_id": aid, **result})
            if rid in self.waiters: self.waiters[rid].set()
            return kind

    def checkpoint(self):
        with self.lock:
            self.journal.verify()
            return {"schema": 1, "protocol_version": PROTOCOL, "delivery_semantics": "AT_LEAST_ONCE",
                    "requests": [self.wire_request(rid, aid) for rid, r in self.records.items()
                                 for aid in range(1, len(r["attempts"]) + 1)]}
