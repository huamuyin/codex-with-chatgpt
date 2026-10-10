"""Synthetic M1 review/action receipts. Never executes the stored instruction."""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import threading

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extension_control/bridge"))
from fresh_response import parse_response, validate_response

CONTEXT_KEYS = {"mission_id", "workspace_id", "round_no", "request_id", "control_id", "reviewed_commit"}
REVIEW_KEYS = {"STATE", "ROUND", "REQUEST_ID", "CONTROL_ID", "ATTEMPT_ID", "REVIEWED_COMMIT", "VERDICT", "FINDINGS", "REVIEW_SUMMARY", "GITHUB_RESOURCES_READ", "NEXT_CODEX_INSTRUCTION"}
SECRET_KEYS = {"control_token", "cookies", "cookie", "headers", "authorization", "password", "api_key", "access_token", "refresh_token"}
UUID = re.compile(r"^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$")

def clean(value):
    pending = [value]
    while pending:
        item = pending.pop()
        if isinstance(item, str) and any(0xD800 <= ord(c) <= 0xDFFF for c in item): raise ValueError("unicode_scalar_required")
        if isinstance(item, dict):
            if any(str(k).lower() in SECRET_KEYS for k in item): raise ValueError("credential_field_rejected")
            pending.extend(item.keys()); pending.extend(item.values())
        elif isinstance(item, list): pending.extend(item)
    return value

def encoded(value):
    return json.dumps(clean(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")

def decoded(raw):
    def pairs(items):
        v = {}
        for k, x in items:
            if k in v: raise ValueError("duplicate_key")
            v[k] = x
        return v
    return clean(json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite"))))

def digest(value): return hashlib.sha256(encoded(value)).hexdigest()

def checked_context(v):
    if not isinstance(v, dict) or set(v) != CONTEXT_KEYS: raise ValueError("context_shape")
    clean(v)
    if any(not isinstance(v[k], str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,127}", v[k]) for k in ("mission_id", "workspace_id")): raise ValueError("context_name")
    if type(v["round_no"]) is not int or v["round_no"] < 1: raise ValueError("context_round")
    if any(not isinstance(v[k], str) or not UUID.fullmatch(v[k]) for k in ("request_id", "control_id")): raise ValueError("context_uuid")
    if not isinstance(v["reviewed_commit"], str) or not re.fullmatch(r"[a-f0-9]{40}", v["reviewed_commit"]): raise ValueError("context_commit")
    return copy.deepcopy(v)

class ReceiptLedger:
    def __init__(self, directory, context, *, private_root, initialize=False):
        if directory is None or private_root is None: raise ValueError("explicit_private_directory_required")
        p, root = Path(directory), Path(private_root)
        if (not p.is_absolute() or not root.is_absolute() or p == Path(p.anchor) or root == Path(root.anchor) or p == root
                or p.resolve() != p.absolute() or root.resolve() != root.absolute()
                or not p.resolve().is_relative_to(root.resolve())
                or any((a / ".git").exists() for a in [p, *p.parents])): raise ValueError("private_path_rejected")
        self.path = p; self.context = checked_context(context); self.lock = threading.RLock()
        self.poisoned = False
        if initialize:
            p.mkdir(parents=True, exist_ok=False)
            self._new("owner.json", encoded(self.context) + b"\n")
            self._new("events.jsonl", b""); self._new("head.json", encoded({"sequence": 0, "hash": "0" * 64}) + b"\n")
        self._load()

    def _new(self, name, raw):
        with (self.path / name).open("xb") as f: f.write(raw); f.flush(); os.fsync(f.fileno())

    def _load(self):
        if self.poisoned: raise ValueError("ledger_poisoned")
        if any((self.path / n).is_symlink() for n in ("owner.json", "events.jsonl", "head.json")): raise ValueError("indirect_ledger")
        if decoded((self.path / "owner.json").read_bytes()) != self.context: raise ValueError("context_mismatch")
        raw = (self.path / "events.jsonl").read_bytes()
        if raw and not raw.endswith(b"\n"): raise ValueError("truncated_event")
        self.events = []; previous = "0" * 64
        state = {"context": self.context, "attempts": [], "history": [], "canonical": None, "action_started": False, "receipt": None}
        for i, line in enumerate(raw.splitlines(), 1):
            x = decoded(line)
            if set(x) != {"event", "hash"}: raise ValueError("event_envelope")
            e = x["event"]
            if set(e) != {"sequence", "previous_hash", "kind", "data"} or type(e["sequence"]) is not int or e["sequence"] != i or e["previous_hash"] != previous: raise ValueError("event_identity")
            if digest(e) != x["hash"]: raise ValueError("event_hash")
            self._apply(state, e["kind"], e["data"])
            previous = x["hash"]; self.events.append(e)
        if decoded((self.path / "head.json").read_bytes()) != {"sequence": len(self.events), "hash": previous}: raise ValueError("head_mismatch")
        self.state = state; self.head = previous

    @staticmethod
    def _apply(s, kind, data):
        if kind == "attempt_opened":
            if set(data) != {"attempt_id"} or type(data["attempt_id"]) is not int or data["attempt_id"] != len(s["attempts"]) + 1: raise ValueError("attempt_sequence")
            s["attempts"].append(data["attempt_id"])
        elif kind == "attempt_failed":
            if set(data) != {"attempt_id", "error", "uncertain"} or data["attempt_id"] not in s["attempts"] or type(data["attempt_id"]) is not int or type(data["uncertain"]) is not bool or not isinstance(data["error"], str) or not 1 <= len(data["error"]) <= 128: raise ValueError("failure_invalid")
            s["history"].append(copy.deepcopy(data))
        elif kind == "canonical_review":
            if s["canonical"] is not None or data["canonical_attempt_id"] not in s["attempts"]: raise ValueError("canonical_conflict")
            if digest(data["review"]) != data["review_hash"] or hashlib.sha256(data["instruction"].encode()).hexdigest() != data["instruction_hash"]: raise ValueError("canonical_hash")
            if data["action_id"] != digest({"context": s["context"], "review_hash": data["review_hash"]}): raise ValueError("action_identity")
            s["canonical"] = copy.deepcopy(data)
        elif kind == "duplicate_review":
            if set(data) != {"attempt_id", "review_hash"} or data["attempt_id"] not in s["attempts"] or s["canonical"] is None or data["review_hash"] != s["canonical"]["review_hash"]: raise ValueError("duplicate_conflict")
        elif kind == "action_started":
            if s["canonical"] is None or data != {"action_id": s["canonical"]["action_id"]} or s["action_started"]: raise ValueError("action_started_conflict")
            s["action_started"] = True
        elif kind == "action_receipt":
            if not s["action_started"] or s["receipt"] is not None or data["action_id"] != s["canonical"]["action_id"]: raise ValueError("receipt_conflict")
            s["receipt"] = copy.deepcopy(data)
        else: raise ValueError("unknown_event")

    def _append(self, kind, data):
        e = {"sequence": len(self.events) + 1, "previous_hash": self.head, "kind": kind, "data": data}
        candidate = copy.deepcopy(self.state); self._apply(candidate, kind, data)
        h = digest(e)
        try:
            with (self.path / "events.jsonl").open("ab") as f: f.write(encoded({"event": e, "hash": h}) + b"\n"); f.flush(); os.fsync(f.fileno())
            temp = self.path / ("head-" + os.urandom(12).hex() + ".tmp")
            with temp.open("xb") as f: f.write(encoded({"sequence": e["sequence"], "hash": h}) + b"\n"); f.flush(); os.fsync(f.fileno())
            os.replace(temp, self.path / "head.json"); self._load()
        except (OSError, ValueError): self.poisoned = True; raise

    def open_attempt(self, attempt_id):
        with self.lock:
            self._load(); self._append("attempt_opened", {"attempt_id": attempt_id})

    def failure(self, attempt_id, error, *, uncertain=False):
        with self.lock:
            self._load(); self._append("attempt_failed", {"attempt_id": attempt_id, "error": error, "uncertain": uncertain})

    def accept_review(self, raw, attempt_id):
        with self.lock:
            self._load()
            if type(attempt_id) is not int or attempt_id not in self.state["attempts"]: raise ValueError("unknown_attempt")
            c = self.context
            v = validate_response(parse_response(raw), round_no=c["round_no"], request_id=c["request_id"], control_id=c["control_id"], attempt_id=attempt_id, commit=c["reviewed_commit"])
            if set(v) != REVIEW_KEYS: raise ValueError("review_shape")
            clean(v); logical = {k:x for k,x in v.items() if k != "ATTEMPT_ID"}; h = digest(logical)
            old = self.state["canonical"]
            if old:
                if old["review_hash"] != h: raise ValueError("canonical_content_changed")
                self._append("duplicate_review", {"attempt_id": attempt_id, "review_hash": h}); return "duplicate"
            instruction = v["NEXT_CODEX_INSTRUCTION"]
            self._append("canonical_review", dict(canonical_attempt_id=attempt_id,review=logical,review_hash=h,
                action_id=digest({"context": c, "review_hash": h}),instruction=instruction,instruction_hash=hashlib.sha256(instruction.encode()).hexdigest()))
            return "canonical"

    def claim_action(self, action_id):
        with self.lock:
            self._load(); c = self.state["canonical"]
            if c is None or action_id != c["action_id"]: raise ValueError("unknown_action")
            if self.state["action_started"]: return None
            self._append("action_started", {"action_id": action_id}); return c["instruction"]

    def record_action_receipt(self, receipt):
        with self.lock:
            self._load(); clean(receipt)
            if not isinstance(receipt, dict) or set(receipt) != {"action_id", "status", "result_sha256", "summary"}: raise ValueError("receipt_shape")
            if receipt["status"] not in ("completed", "failed", "blocked") or not isinstance(receipt["result_sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", receipt["result_sha256"]) or not isinstance(receipt["summary"], str) or not 1 <= len(receipt["summary"]) <= 512: raise ValueError("receipt_invalid")
            if self.state["receipt"]:
                if receipt != self.state["receipt"]: raise ValueError("receipt_conflict")
                return False
            self._append("action_receipt", receipt); return True

    def export(self):
        with self.lock: self._load(); return encoded(self.state)
