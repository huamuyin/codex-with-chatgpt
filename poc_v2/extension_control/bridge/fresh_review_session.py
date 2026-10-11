"""Offline candidate: one explicitly authorized new R6 review session.

Two exclusive, fsynced records pin the creation intent and returned native tab.
An interrupted or unacknowledged creation is a permanent block in this namespace.
Opening/reopening this object never creates a tab, sends, retries, or imports history.
"""
import copy
import hashlib
import re
import uuid

from fresh_delivery import decode, encoded
from bridge_server import RequestError

BUILD = "c2c-v2-r6-new-review-session-offline-1"
ROOT = "https://chatgpt.com/"
TASK = "C2C_V2_CHROME_R6_M3"
REPO = "huamuyin/codex-with-chatgpt"
BRANCH = "codex/c2c-v2-chrome-r6"
UUID = re.compile(r"^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$")


class ReviewSetup:
    def __init__(self, journal, commit, iteration=6):
        namespace = journal.owner["namespace"]
        if (not re.fullmatch(r"CHROME_R6_M3_FINAL_[A-Za-z0-9_-]{1,64}", namespace)
                or not isinstance(commit, str) or not re.fullmatch(r"[a-f0-9]{40}", commit)
                or type(iteration) is not int or not 1 <= iteration <= 1000):
            raise ValueError("new_review_scope_invalid")
        self.path, self.namespace = journal.path, namespace
        self.commit, self.iteration = commit, iteration
        self.intent = self._read("review-open-intent.json")
        self.binding = self._read("review-native-binding.json")
        if self.intent is not None: self.validate_intent(self.intent)
        if self.binding is not None: self.validate_binding(self.binding)
        if journal.events and self.binding is None:
            raise ValueError("new_review_cannot_import_history")
        # Reopen validates the immutable authority against every stored request.
        for event in journal.events:
            if event["kind"] == "logical_created": self.validate_payload(event["data"]["payload"])
            if event["kind"] == "send_attempt" and (self.binding is None or event["data"]["tab_id"] != self.binding["tab_id"]):
                raise ValueError("new_review_native_history_mismatch")
        if sum(e["kind"] == "logical_created" for e in journal.events) > 1:
            raise ValueError("new_review_history_not_single_logical_request")
        if sum(e["kind"] == "send_attempt" for e in journal.events) > 1:
            raise ValueError("new_review_history_has_unauthorized_resend")

    def _read(self, name):
        p = self.path / name
        if p.is_symlink(): raise ValueError("indirect_review_setup_file")
        return decode(p.read_bytes()) if p.exists() else None

    def _new(self, name, value):
        # Never replace an existing record or repair truncated/ambiguous authority.
        p = self.path / name
        with p.open("xb") as f:
            f.write(encoded(value) + b"\n"); f.flush()
            import os
            os.fsync(f.fileno())

    def validate_intent(self, v):
        keys = {"schema", "build_id", "namespace", "review_commit", "iteration", "setup_id", "nonce", "bridge_session_id", "root_url"}
        if (not isinstance(v, dict) or set(v) != keys or type(v["schema"]) is not int or v["schema"] != 1
                or v["build_id"] != BUILD or v["namespace"] != self.namespace
                or v["review_commit"] != self.commit or type(v["iteration"]) is not int or v["iteration"] != self.iteration
                or v["root_url"] != ROOT or any(not isinstance(v[k], str) or not UUID.fullmatch(v[k])
                    for k in ("setup_id", "nonce", "bridge_session_id")) or v["setup_id"] == v["nonce"]):
            raise ValueError("review_intent_invalid")

    def begin(self, bridge):
        if self.intent is not None or self.binding is not None:
            raise RequestError("review_creation_already_consumed", 409)
        v = dict(schema=1, build_id=BUILD, namespace=self.namespace, review_commit=self.commit,
                 iteration=self.iteration, setup_id=str(uuid.uuid4()), nonce=str(uuid.uuid4()),
                 bridge_session_id=bridge["bridge_session_id"], root_url=ROOT)
        self.validate_intent(v)
        self._new("review-open-intent.json", v)  # Consume before any browser command.
        self.intent = v
        return copy.deepcopy(v)

    def validate_binding(self, v):
        keys = {"grant", "tab_id", "before_tab_ids", "creation_observed", "status", "url", "pending_url", "intent_sha256"}
        if self.intent is None or not isinstance(v, dict) or set(v) != keys:
            raise ValueError("review_binding_invalid")
        ids = v["before_tab_ids"]
        if (v["grant"] != self.intent or v["intent_sha256"] != hashlib.sha256(encoded(self.intent)).hexdigest()
                or type(v["tab_id"]) is not int or v["tab_id"] < 0
                or not isinstance(ids, list) or len(ids) > 256 or any(type(x) is not int or x < 0 for x in ids)
                or len(set(ids)) != len(ids) or v["tab_id"] in ids or v["creation_observed"] is not True
                or v["status"] not in ("loading", "complete")
                or v["url"] not in ("", ROOT) or v["pending_url"] not in ("", ROOT)
                or not (v["url"] == ROOT or v["pending_url"] == ROOT)
                or v["status"] == "complete" and (v["url"] != ROOT or v["pending_url"] != "")):
            raise ValueError("review_binding_invalid")

    def bind(self, proof):
        v = {**copy.deepcopy(proof), "intent_sha256": hashlib.sha256(encoded(self.intent)).hexdigest()}
        self.validate_binding(v)
        if self.binding is not None:
            if self.binding != v: raise ValueError("review_binding_conflict")
            return  # Exact duplicate acknowledgement never changes the record.
        self._new("review-native-binding.json", v)
        self.binding = v

    def scope(self):
        return dict(build_id=BUILD, namespace=self.namespace, review_commit=self.commit, iteration=self.iteration,
                    intent=copy.deepcopy(self.intent), binding=copy.deepcopy(self.binding))

    def ready_proof(self):
        if self.binding is None: return None
        return {**{k:self.intent[k] for k in ("build_id", "namespace", "setup_id", "nonce", "review_commit", "iteration")},
                "tab_id": self.binding["tab_id"]}

    def validate_payload(self, p):
        if any(p.get(k) != value for k, value in dict(task_id=TASK, repo=REPO, branch=BRANCH,
                commit=self.commit, iteration=self.iteration).items()) or type(p.get("iteration")) is not int:
            raise RequestError("review_payload_outside_registered_scope", 409)
