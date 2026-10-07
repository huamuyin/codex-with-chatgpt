"""Offline owner-policy tests. All journals are synthetic, in an explicit evidence directory."""
import copy
from contextlib import redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
import uuid

import bridge_server as b
import fresh_delivery as d
import fresh_bridge as f
from test_bridge_server import CapturingSession, sample_payload, URL

EXTENSION = "a" * 32


class FreshTests(unittest.TestCase):
    def setUp(self):
        root = os.environ.get("C2C_V2_TEST_DATA_ROOT")
        if not root or not Path(root).is_absolute(): raise AssertionError("explicit C2C_V2_TEST_DATA_ROOT required")
        self.root = Path(root); self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / (hashlib.sha256(self._testMethodName.encode()).hexdigest()[:8] + "-" + uuid.uuid4().hex[:12])
        self.journals = []
        self.j = self.open(initialize=True)
        self.s, self.ws = self.state(self.j)
        self.p = b.validate_review_payload(sample_payload(task_id="FRESH_OFFLINE_ONLY", iteration=1,
            instruction="Offline fixture, never a real message.", control_token=self.s.control_token))

    def tearDown(self):
        for j in self.journals: j.close()

    def open(self, initialize=False):
        j = d.FreshJournal(self.path, "synthetic-fresh-only", initialize=initialize); self.journals.append(j); return j

    def state(self, j):
        s = f.FreshState(j, EXTENSION); ws = CapturingSession(); s.register(ws)
        s.message(ws, {"type": "fresh_status", "connected": True, "candidate_count": 1, "tab_id": 7,
                       "url": URL, "components": s.expected_components()})
        return s, ws

    def send(self):
        r = self.s.send(self.p)
        self.assertNotEqual(r["request_id"], d.LEGACY_ID)
        return r

    def msg(self, r, aid=1, **changes):
        wire = self.s.requests.wire_request(r["request_id"], aid)
        value = {"type": "fresh_result", **{k: wire[k] for k in ("request_id", "control_id", "attempt_id", "task_id", "iteration", "repo", "branch", "expected_commit")},
                 "tab_id": 7, "conversation_url": URL, "raw_reply": "  Fresh mock\r\n", "assistant_generation_complete": True,
                 "content_identity": {"protocol_version": 3, "version": d.VERSION, "build_id": d.BUILD_ID}}
        value.update(changes); return value

    def retry(self, r):
        return self.s.send({**self.p, "request_id": r["request_id"]}, retry=True, control_id=r["control_id"])

    def test_observation_budget_is_not_request_authority_or_persisted_credential(self):
        r = self.s.send(self.p, observation={"reply_wait_ms": 1000})
        message = self.ws.messages[-1]
        self.assertEqual(message["observation"], {"reply_wait_ms": 1000})
        self.assertEqual(r["payload"], {k:self.p[k] for k in d.PAYLOAD_KEYS})
        self.assertNotIn(b"reply_wait_ms", (self.path / "events.jsonl").read_bytes())

    def test_invalid_observation_and_send_locator_fault_reject_before_creation(self):
        for value in ({"reply_wait_ms": True}, {"reply_wait_ms": 0}, {"reply_wait_ms": 600001}, {"locator_miss": "yes"}, {"unknown": 1}):
            with self.assertRaises(b.RequestError): self.s.send(self.p, observation=value)
        with self.assertRaisesRegex(b.RequestError, "locator_fault_observe_only"): self.s.send(self.p, observation={"locator_miss": True})
        self.assertEqual(self.j.events, []); self.assertEqual(self.ws.messages, [])

    def test_explicit_completed_request_observation_preserves_original_history(self):
        r = self.send(); self.s.message(self.ws, self.msg(r)); raw = (self.path / "events.jsonl").read_bytes()
        self.s.maintenance({"action": "observe_request", "request_id": r["request_id"], "control_id": r["control_id"],
                            "attempt_id": 1, "tab_id": 7, "url": URL})
        self.assertEqual(self.ws.messages[-1]["request"]["control_id"], r["control_id"])
        self.assertEqual((self.path / "events.jsonl").read_bytes(), raw)
        self.s.message(self.ws, self.msg(r))
        self.assertEqual(self.s.requests.lookup(r["request_id"])["duplicate_count"], 1)

    def test_explicit_observation_unknown_or_wrong_identity_tab_url_is_rejected(self):
        r = self.send(); value = {"action": "observe_request", "request_id": r["request_id"], "control_id": r["control_id"],
                                "attempt_id": 1, "tab_id": 7, "url": URL}
        for change in ({"request_id": str(uuid.uuid4())}, {"control_id": str(uuid.uuid4())}, {"attempt_id": 99}, {"attempt_id": True},
                       {"tab_id": 8}, {"url": URL+"wrong"}):
            with self.assertRaises(b.RequestError): self.s.maintenance({**value, **change})

    def test_reload_tab_and_reply_probe_do_not_create_or_send(self):
        r = self.send(); self.ws.messages.clear(); raw = (self.path / "events.jsonl").read_bytes()
        self.s.maintenance({"action": "reload_tab", "tab_id": 7, "url": URL})
        mid, _ = self.s.maintenance({"action": "probe_reply_rejection", "request_id": r["request_id"], "control_id": r["control_id"],
             "attempt_id": 1, "tab_id": 7, "url": URL, "field": "expected_commit"})
        self.s.message(self.ws, {"type": "fresh_maintenance_result", "maintenance_id": mid, "action": "probe_reply_rejection",
             "complete": True, "field": "expected_commit", "rejected": True, "rejection_code": "reply_identity_mismatch"})
        self.assertTrue(self.s.maintenance_commands[mid]["result"]["rejected"])
        self.assertFalse(any(m["type"] == "fresh_review" for m in self.ws.messages))
        self.assertEqual((self.path / "events.jsonl").read_bytes(), raw)

    def test_at_least_once_retry_keeps_logical_ids_increments_attempt_and_wire(self):
        r = self.send(); self.s.timeout(r["request_id"], 1); second = self.retry(r)
        self.assertEqual((r["request_id"], r["control_id"]), (second["request_id"], second["control_id"]))
        self.assertEqual(len(second["attempts"]), 2)
        sends = [m["request"] for m in self.ws.messages if m["type"] == "fresh_review"]
        self.assertEqual([m["attempt_id"] for m in sends], [1, 2])
        self.assertIn("ATTEMPT_ID: 1", sends[0]["message"]); self.assertIn("ATTEMPT_ID: 2", sends[1]["message"])
        self.assertEqual(sends[0]["nonce"], sends[1]["nonce"])
        self.assertEqual(second["attempts"][0]["error_code"], "caller_wait_timeout")

    def bootstrap_mock(self, method="POST", origin=None, host="127.0.0.1:18797", address="127.0.0.1"):
        h = object.__new__(f.FreshHandler); h.state = self.s; h.path = "/bootstrap"
        h.headers = {"Host": host, "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty"}
        if origin is not None: h.headers["Origin"] = origin
        h.client_address = (address, 9000); outputs = []
        h.write = lambda code, body: outputs.append((code, body))
        (h.do_POST if method == "POST" else h.do_GET)()
        return outputs[-1]

    def test_bootstrap_post_exact_origin_handoff_and_nonsecret_real_boundary_diagnostics(self):
        code, value = self.bootstrap_mock(origin=self.s.extension_origin)
        self.assertEqual(code, 200)
        self.assertTrue(value["control_token"] == self.s.control_token)
        self.assertEqual(value["bridge_identity"], self.s.identity)
        proof = self.s.health()["boundaries"]["bootstrap"]
        self.assertEqual(proof["method"], "POST")
        self.assertTrue(proof["origin_matches"]); self.assertTrue(proof["origin_present"])
        self.assertEqual(proof["reason"], "accepted")
        self.assertNotIn(self.s.control_token, json.dumps(self.s.health()))
        self.assertEqual(self.j.events, []); self.assertEqual(self.ws.messages, [])

    def test_historical_fresh_build_reopens_without_rewriting_and_current_live_gate_stays_strict(self):
        rid = self.s.requests.create(self.p)
        old = {**self.s.identity, "version": "0.9.1", "build_id": d.KNOWN_BUILDS["0.9.1"]}
        components = {**self.s.expected_components(), "background_version": "0.9.1", "content_version": "0.9.1",
                      "manifest_version": "0.9.1", "build_id": old["build_id"]}
        self.s.requests.prepare_attempt(rid, 7, URL, components, old)
        raw = (self.path / "events.jsonl").read_bytes(); self.j.close()
        self.s, self.ws = self.state(self.open())
        self.assertEqual((self.path / "events.jsonl").read_bytes(), raw)
        self.assertEqual(self.ws.messages, [])
        self.assertEqual(self.s.requests.lookup(rid)["attempts"][0]["bridge_identity"], old)
        self.s.status["components"] = components
        self.assertFalse(self.s.ready())
        self.s.status["components"] = self.s.expected_components()
        r = self.s.requests.lookup(rid); self.retry(r)
        self.assertTrue((self.path / "events.jsonl").read_bytes().startswith(raw))
        self.assertEqual(self.s.requests.lookup(rid)["attempts"][1]["bridge_identity"]["version"], d.VERSION)

    def test_history_rejects_unknown_or_mixed_builds_and_secret_fields(self):
        self.send()
        for change in ({"version": "0.9.99"}, {"build_id": "wrong"}, {"version": "0.9.1"}, {"control_token": "x" * 43}):
            events = copy.deepcopy(self.j.events); events[-1]["data"]["bridge_identity"].update(change)
            with self.assertRaises(ValueError): d.FreshRequests.replay(events)

    def test_pending_root_transition_maintenance_does_not_bind_or_send_or_rewrite_history(self):
        self.s.status["url"] = "https://chatgpt.com/"; self.p["conversation_url"] = ""
        r = self.send(); self.s.timeout(r["request_id"], 1); self.ws.messages.clear()
        raw = (self.path / "events.jsonl").read_bytes(); self.s.status["url"] = URL
        self.s.maintenance({"action": "reload_content", "tab_id": 7, "url": URL})
        self.assertEqual(self.ws.messages[-1]["type"], "fresh_maintenance")
        self.assertEqual((self.path / "events.jsonl").read_bytes(), raw)
        self.assertEqual(self.s.requests.lookup(r["request_id"])["conversation_url"], "")
        self.assertFalse(any(m["type"] == "fresh_review" for m in self.ws.messages))
        for change in ({"tab_id": 8}, {"tab_id": True}, {"url": URL + "other"}):
            with self.assertRaises(b.RequestError): self.s.maintenance({"action": "reload_content", "tab_id": 7, "url": URL, **change})

    def test_content_return_diagnostic_is_nonsecret_and_does_not_mutate_request(self):
        r = self.send(); raw = (self.path / "events.jsonl").read_bytes()
        m = {**self.msg(r), "type": "fresh_diagnostic", "code": "sender_url_mismatch",
             "sender_url": "https://chatgpt.com/", "tab_url": URL, "content_url": URL}
        self.s.message(self.ws, m)
        self.assertEqual(self.s.health()["boundaries"]["content_return"]["code"], "sender_url_mismatch")
        self.assertEqual((self.path / "events.jsonl").read_bytes(), raw)
        self.assertNotIn("raw_reply", self.s.health()["boundaries"]["content_return"])

    def test_bootstrap_missing_null_wrong_origin_and_wrong_host_stay_closed(self):
        for method in ("GET", "POST"):
            for origin in (None, "null", "https://chatgpt.com", "chrome-extension://" + "b" * 32):
                with self.subTest(method=method, origin=origin):
                    self.assertEqual(self.bootstrap_mock(method, origin), (403, {"error_code": "origin_rejected"}))
        for host, address in (("localhost:18797", "127.0.0.1"), ("127.0.0.1:18796", "127.0.0.1"), ("127.0.0.1:18797", "192.0.2.1")):
            self.assertEqual(self.bootstrap_mock(origin=self.s.extension_origin, host=host, address=address),
                             (403, {"error_code": "host_rejected"}))
        self.assertEqual(self.j.events, []); self.assertEqual(self.ws.messages, [])

    def test_maintenance_exact_fresh_target_and_ack_never_send_or_create_request(self):
        self.s.status["url"] = "https://chatgpt.com/"
        mid, event = self.s.maintenance({"action": "reload_content", "tab_id": 7, "url": "https://chatgpt.com/"})
        self.assertEqual(self.ws.messages[-1]["type"], "fresh_maintenance")
        self.s.message(self.ws, {"type": "fresh_maintenance_result", "maintenance_id": "unknown", "action": "reload_content", "complete": True})
        self.assertFalse(event.is_set())
        self.s.message(self.ws, {"type": "fresh_maintenance_result", "maintenance_id": mid, "action": "reload_extension", "complete": True})
        self.assertFalse(event.is_set())
        self.s.message(self.ws, {"type": "fresh_maintenance_result", "maintenance_id": mid, "action": "reload_content", "complete": True})
        self.assertTrue(event.is_set())
        self.assertEqual(self.j.events, []); self.assertEqual(self.s.requests.records, {})
        self.assertFalse(any(m["type"] == "fresh_review" for m in self.ws.messages))

    def test_maintenance_rejects_unknown_action_tab_url_duplicates_legacy_and_disconnection(self):
        self.s.status["url"] = "https://chatgpt.com/"
        for value in ({"action": "send"}, {"action": "reload_content", "tab_id": 8, "url": "https://chatgpt.com/"},
                      {"action": "reload_content", "tab_id": True, "url": "https://chatgpt.com/"},
                      {"action": "reload_content", "tab_id": 7, "url": URL},
                      {"action": "reload_content", "tab_id": 7, "url": "https://chatgpt.com/c/6abcb6a6-a1b8-83e8-bc72-f85af94bb2f0"}):
            with self.assertRaises(b.RequestError): self.s.maintenance(value)
        self.s.status["candidate_count"] = 2
        with self.assertRaises(b.RequestError): self.s.maintenance({"action": "reload_content", "tab_id": 7, "url": "https://chatgpt.com/"})
        self.s.unregister(self.ws)
        with self.assertRaises(b.RequestError): self.s.maintenance({"action": "reload_content", "tab_id": 7, "url": "https://chatgpt.com/"})
        self.assertEqual(self.ws.messages, []); self.assertEqual(self.j.events, [])

    def test_queued_authenticated_maintenance_reconnects_without_any_logical_send(self):
        self.s.unregister(self.ws)
        mid, event = self.s.maintenance({"action": "reload_extension"})
        self.assertFalse(event.is_set()); self.assertEqual(self.ws.messages, [])
        self.s.register(self.ws)
        def capture(message):
            self.assertEqual(message["type"], "fresh_maintenance")
            self.s.message(self.ws, {"type": "fresh_maintenance_result", "maintenance_id": mid,
                                    "action": "reload_extension", "complete": True})
        self.ws.send_json = capture
        with patch.object(f.time, "sleep", return_value=None): self.s.maintenance_handoff(self.ws)
        self.assertTrue(event.is_set()); self.assertEqual(self.j.events, [])

    def test_queued_maintenance_expiry_and_closed_session_do_not_dispatch(self):
        self.s.unregister(self.ws); mid, event = self.s.maintenance({"action": "reload_extension"})
        self.s.maintenance_commands[mid]["expires_at"] = 0
        self.s.register(self.ws); self.s.maintenance_handoff(self.ws)
        self.assertEqual(self.ws.messages, []); self.assertFalse(event.is_set())
        self.assertEqual(self.j.events, [])

    def test_explicit_fresh_observation_preserves_identity_and_history_without_new_attempt(self):
        self.s.status["url"] = "https://chatgpt.com/"; self.p["conversation_url"] = ""
        r = self.send(); self.s.timeout(r["request_id"], 1); self.s.status["url"] = URL
        raw = (self.path / "events.jsonl").read_bytes(); self.ws.messages.clear()
        self.s.maintenance({"action": "observe_attempt", "tab_id": 7, "url": URL})
        m = self.ws.messages[-1]; self.assertEqual(m["type"], "fresh_maintenance")
        self.assertEqual(m["request"], self.s.requests.wire_request(r["request_id"], 1))
        self.assertEqual((self.path / "events.jsonl").read_bytes(), raw)
        self.assertEqual(len(self.s.requests.lookup(r["request_id"])["attempts"]), 1)
        self.assertFalse(any(m["type"] == "fresh_review" for m in self.ws.messages))
        for change in ({"tab_id": 8}, {"url": URL + "wrong"}):
            with self.assertRaises(b.RequestError): self.s.maintenance({"action": "observe_attempt", "tab_id": 7, "url": URL, **change})

    def test_maintenance_http_keeps_token_authentication(self):
        h = object.__new__(f.FreshHandler); h.state = self.s; h.path = "/maintenance"
        raw = json.dumps({"action": "reload_extension", "control_token": "wrong"}).encode()
        h.headers = {"Host": "127.0.0.1:18797", "Content-Type": "application/json", "Content-Length": str(len(raw))}
        h.client_address = ("127.0.0.1", 9000); h.rfile = io.BytesIO(raw); outputs = []
        h.write = lambda code, body: outputs.append((code, body)); h.do_POST()
        self.assertEqual(outputs, [(401, {"error_code": "control_token_rejected"})])
        self.assertEqual(self.ws.messages, []); self.assertEqual(self.j.events, [])

    def test_previous_attempt_reply_can_complete_later_reply_is_duplicate(self):
        r = self.send(); self.s.timeout(r["request_id"], 1); self.retry(r)
        self.s.message(self.ws, self.msg(r, 1))
        first = copy.deepcopy(self.s.requests.lookup(r["request_id"])["result"])
        self.s.message(self.ws, self.msg(r, 2, raw_reply="another valid late reply"))
        saved = self.s.requests.lookup(r["request_id"])
        self.assertEqual(saved["status"], "complete"); self.assertEqual(saved["result"], first)
        self.assertEqual(saved["duplicate_count"], 1); self.assertEqual(len(self.s.requests.records), 1)
        self.assertEqual(self.ws.messages[-1]["classification"], "duplicate_reply")
        send_count = len(self.ws.messages)
        self.assertEqual(self.retry(r)["status"], "complete")
        self.assertEqual(len(self.ws.messages), send_count)

    def test_late_failure_never_uncompletes_request_or_erases_audit(self):
        r = self.send(); self.s.message(self.ws, self.msg(r))
        prefix = (self.path / "events.jsonl").read_bytes()
        self.s.message(self.ws, self.msg(r, type="fresh_error", error_code="late_timeout"))
        self.assertTrue((self.path / "events.jsonl").read_bytes().startswith(prefix))
        self.assertEqual(self.s.requests.lookup(r["request_id"])["status"], "complete")

    def test_disk_authority_precedes_mock_send_and_contains_no_control_token(self):
        def dispatch(message):
            self.j.verify()
            self.assertEqual([e["kind"] for e in self.j.events], ["logical_created", "send_attempt"])
            self.assertEqual(self.j.events[-1]["data"]["wire_message"], message["request"]["message"])
        self.ws.send_json = dispatch; self.send()
        self.assertNotIn(self.s.control_token.encode(), (self.path / "events.jsonl").read_bytes())

    def test_disk_write_failure_prevents_actual_dispatch_and_restart_reset(self):
        with patch.object(self.j, "_write_new", side_effect=OSError("mock disk full")):
            with self.assertRaisesRegex(b.RequestError, "journal_unavailable"): self.send()
        self.assertEqual(self.ws.messages, []); self.assertFalse(self.s.ready())
        raw = (self.path / "events.jsonl").read_bytes(); self.j.close()
        with self.assertRaises(ValueError): self.open()
        self.assertEqual((self.path / "events.jsonl").read_bytes(), raw)

    def test_socket_error_adds_uncertain_event_retry_is_allowed(self):
        self.ws.send_json = Mock(side_effect=OSError("mock socket failure"))
        r = self.send(); self.assertEqual(r["attempts"][0]["error_code"], "delivery_uncertain")
        self.ws.send_json = CapturingSession().send_json
        self.assertEqual(len(self.retry(r)["attempts"]), 2)

    def test_restart_loads_pending_identity_without_send_or_write_then_allows_explicit_retry(self):
        r = self.send(); raw = (self.path / "events.jsonl").read_bytes(); self.j.close()
        self.s, self.ws = self.state(self.open())
        self.assertEqual(self.ws.messages, []); self.assertIsNone(self.s.active)
        self.assertEqual((self.path / "events.jsonl").read_bytes(), raw)
        self.assertEqual(self.s.requests.lookup(r["request_id"])["control_id"], r["control_id"])
        self.assertEqual(len(self.retry(r)["attempts"]), 2)

    def test_results_duplicates_failures_all_survive_restart_byte_exact(self):
        r = self.send(); self.s.timeout(r["request_id"], 1); self.retry(r)
        self.s.message(self.ws, self.msg(r, 2)); self.s.message(self.ws, self.msg(r, 1))
        before = copy.deepcopy(self.s.requests.records); raw = (self.path / "events.jsonl").read_bytes(); self.j.close()
        restored, session = self.state(self.open())
        self.assertEqual(restored.requests.records, before); self.assertEqual(session.messages, [])
        self.assertEqual((self.path / "events.jsonl").read_bytes(), raw)

    def test_wrong_logical_payload_control_url_tab_version_completion_and_attempt_rejected(self):
        r = self.send(); count = len(self.j.events)
        for change in ({"control_id": "b" * 36}, {"request_id": str(uuid.uuid4())}, {"attempt_id": 2}, {"attempt_id": True},
                       {"iteration": 99}, {"iteration": True}, {"expected_commit": "f" * 40}, {"repo": "other/repo"}, {"branch": "wrong"},
                       {"tab_id": 8}, {"tab_id": True}, {"conversation_url": URL + "-other"},
                       {"assistant_generation_complete": False}, {"content_identity": {"version": "0.8.1"}}, {"raw_reply": ""}):
            with self.subTest(change=change), self.assertRaises(b.RequestError): self.s.message(self.ws, self.msg(r, **change))
            self.assertEqual(self.s.requests.lookup(r["request_id"])["status"], "pending")
            self.assertEqual(len(self.j.events), count)
        for key, value in (("commit", "f" * 40), ("iteration", 2), ("repo", "other/repo"), ("branch", "wrong"), ("conversation_url", URL + "other")):
            with self.assertRaisesRegex(b.RequestError, "logical_identity_mismatch"):
                self.s.send({**self.p, "request_id": r["request_id"], key: value}, retry=True, control_id=r["control_id"])

    def test_new_request_and_retry_require_ready_exact_components_unique_target(self):
        for change in ({"connected": False}, {"candidate_count": 2}, {"candidate_count": True}, {"tab_id": None},
                       {"url": "https://chatgpt.com/?x"}, {"components": {}}):
            original = copy.deepcopy(self.s.status); self.s.status.update(change)
            with self.assertRaisesRegex(b.RequestError, "extension_or_chat_disconnected"): self.send()
            self.assertEqual(self.ws.messages, []); self.s.status = original

    def test_original_legacy_id_never_imported_or_recovered(self):
        with self.assertRaisesRegex(b.RequestError, "request_id_unknown"):
            self.s.requests.lookup(d.LEGACY_ID)
        event = {"request_id": d.LEGACY_ID, "control_id": str(uuid.uuid4()), "kind": "logical_created", "data": {"payload": {k:self.p[k] for k in d.PAYLOAD_KEYS}}}
        with self.assertRaises(ValueError): d.FreshRequests.replay([event])
        self.assertEqual(len(self.s.requests.records), 0)

    def test_truncation_tail_deletion_hash_and_schema_tampering_fail_without_reset(self):
        self.send(); self.j.close(); file = self.path / "events.jsonl"; raw = file.read_bytes()
        for damaged in (raw[:-5], b"\n".join(raw.splitlines()[:-1]) + b"\n", raw.replace(b'"schema":1', b'"schema":0'),
                        raw.replace(b'FRESH_OFFLINE_ONLY', b'FRESH_TAMPERED')):
            file.write_bytes(damaged)
            with self.assertRaises(ValueError): self.open()
            self.assertEqual(file.read_bytes(), damaged)
        file.write_bytes(raw); self.open()

    def test_recomputed_hash_chain_still_requires_correct_wire_and_attempt_sequence(self):
        r = self.send()
        for key, value in (("wire_message", "fake message"), ("attempt_id", 2), ("tab_id", True), ("components", {})):
            events = copy.deepcopy(self.j.events); events[-1]["data"][key] = value
            with self.assertRaises(ValueError): d.FreshRequests.replay(events)

    def test_single_writer_missing_file_owner_mismatch_no_overwrite(self):
        with self.assertRaises(ValueError): self.open()
        self.j.close()
        with self.assertRaises(FileExistsError): self.open(initialize=True)
        owner = (self.path / "owner.json").read_bytes()
        (self.path / "owner.json").write_bytes(owner.replace(b'AT_LEAST_ONCE', b'EXACTLY_ONCE'))
        with self.assertRaises(ValueError): self.open()
        (self.path / "owner.json").write_bytes(owner)
        (self.path / "head.json").unlink()
        with self.assertRaises(ValueError): self.open()
        self.assertFalse((self.path / "head.json").exists())

    def test_empty_or_relative_data_path_and_unknown_namespace_fail(self):
        for path in ("", ".", "relative", self.path.anchor):
            with self.assertRaises(ValueError): d.FreshJournal(path, "fixture")
        with self.assertRaises(ValueError): d.FreshJournal(self.path, "..")

    def test_second_live_extension_session_cannot_take_over(self):
        with self.assertRaisesRegex(b.RequestError, "extension_session_already_active"):
            self.s.register(CapturingSession())
        self.assertIs(self.s.session, self.ws)

    def test_first_thread_binding_is_event_and_retry_uses_same_thread(self):
        self.s.status["url"] = "https://chatgpt.com/"; self.p["conversation_url"] = ""
        r = self.send(); snapshot = copy.deepcopy(self.j.events[0]); self.s.status["url"] = URL
        self.s.message(self.ws, self.msg(r, type="fresh_bound"))
        self.assertEqual(self.j.events[0], snapshot)
        self.s.timeout(r["request_id"], 1); self.retry(r)
        self.assertEqual(self.s.requests.wire_request(r["request_id"], 2)["conversation_url"], URL)

    def test_cli_refuses_wrong_data_root_and_old_extension_before_any_server(self):
        for argv in (["fresh", "--data-root", "D:/", "--namespace", "mock", "--extension-id", EXTENSION],
                     ["fresh", "--data-root", str(f.DATA_ROOT), "--namespace", "..", "--extension-id", EXTENSION],
                     ["fresh", "--data-root", str(f.DATA_ROOT), "--namespace", "mock", "--extension-id", b.EXTENSION_ID]):
            with patch.object(f.sys if hasattr(f, "sys") else __import__("sys"), "argv", argv), \
                 patch.object(b, "LocalThreadingHTTPServer", side_effect=AssertionError("no real server")), \
                 patch.object(f, "FreshJournal", side_effect=AssertionError("no real runtime ledger")):
                with self.assertRaises(SystemExit): f.main()

    def test_cross_language_fixture_uses_real_python_wire_not_legacy_id(self):
        r = self.send(); checkpoint = self.s.requests.checkpoint()
        fixture = {"bridge_identity": self.s.identity, "checkpoint": checkpoint}
        (self.root / "fresh-cross-language.json").write_bytes(d.encoded(fixture) + b"\n")
        self.assertNotIn(d.LEGACY_ID.encode(), d.encoded(fixture))

    def test_poll_requires_control_identity_and_cannot_substitute_payload(self):
        r = self.send(); p = {**self.p, "request_id": r["request_id"]}
        with self.assertRaisesRegex(b.RequestError, "poll_control_id_required"): self.s.poll(p)
        with self.assertRaisesRegex(b.RequestError, "logical_identity_mismatch"): self.s.poll(p, str(uuid.uuid4()))
        self.assertEqual(self.s.poll(p, r["control_id"])["request_id"], r["request_id"])

    def test_closed_recovery_and_http_retry_are_mock_only(self):
        def handler(route, value):
            h = object.__new__(f.FreshHandler); h.state = self.s; h.path = route
            raw = json.dumps(value).encode(); h.headers = {"Host": "127.0.0.1:18797", "Content-Type": "application/json", "Content-Length": str(len(raw))}
            h.client_address = ("127.0.0.1", 9000); h.rfile = io.BytesIO(raw); h.outputs = []
            h.write = lambda code, body: h.outputs.append((code, body)); return h
        h = handler("/recover", {"request_id": d.LEGACY_ID}); h.do_POST()
        self.assertEqual(h.outputs, [(410, {"error_code": "legacy_recovery_closed"})])
        self.assertEqual(self.ws.messages, [])
        r = self.send(); self.s.timeout(r["request_id"], 1)
        h = handler("/retry", {**self.p, "request_id": r["request_id"], "control_id": r["control_id"]})
        with patch.object(__import__("threading").Event, "wait", return_value=False): h.do_POST()
        self.assertEqual(h.outputs[-1][0], 202)
        self.assertEqual(len(h.outputs[-1][1]["attempts"]), 2)

    def test_crash_between_sealed_attempt_and_dispatch_is_retryable_without_losing_history(self):
        rid = self.s.requests.create(self.p)
        self.s.requests.prepare_attempt(rid, 7, URL, self.s.expected_components(), self.s.identity)
        raw = (self.path / "events.jsonl").read_bytes(); r = self.s.requests.lookup(rid)
        self.j.close(); self.s, self.ws = self.state(self.open())
        self.assertEqual(self.ws.messages, [])
        self.assertEqual(len(self.retry(r)["attempts"]), 2)
        self.assertTrue((self.path / "events.jsonl").read_bytes().startswith(raw))

    def test_secret_field_and_wrong_startup_binding_rejected_before_journal_write(self):
        r = self.send(); data = copy.deepcopy(self.j.events[-1]["data"]); count = len(self.j.events)
        for key, value in (("control_token", "a" * 43), ("version", "0.8.1"), ("port", 18795)):
            bad = copy.deepcopy(data); bad["attempt_id"] = 2
            bad["wire_message"] = d.wire_message(r["payload"], r["request_id"], r["control_id"], 2)
            bad["bridge_identity"][key] = value
            with self.assertRaises(ValueError): self.j.append("send_attempt", r["request_id"], r["control_id"], bad)
            self.assertEqual(len(self.j.events), count)

    def test_new_request_in_existing_fresh_thread_keeps_original_payload_and_observed_url(self):
        self.p["conversation_url"] = ""
        r = self.send()
        self.assertEqual(r["payload"]["conversation_url"], "")
        self.assertEqual(r["conversation_url"], URL)
        self.assertEqual(r["attempts"][0]["conversation_url"], URL)
        self.s.timeout(r["request_id"], 1)
        self.assertEqual(len(self.retry(r)["attempts"]), 2)

    def test_startup_controller_handoff_token_is_ephemeral_and_auth_stays_strict(self):
        captured = io.StringIO()
        server = Mock()

        def http_post(route, value):
            h = object.__new__(f.FreshHandler); h.state = self.s; h.path = route
            raw = json.dumps(value).encode()
            h.headers = {"Host": "127.0.0.1:18797", "Content-Type": "application/json", "Content-Length": str(len(raw))}
            h.client_address = ("127.0.0.1", 9000); h.rfile = io.BytesIO(raw); outputs = []
            h.write = lambda code, body: outputs.append((code, body))
            with patch.object(__import__("threading").Event, "wait", return_value=False): h.do_POST()
            return outputs[-1]

        def controller():
            lines = captured.getvalue().splitlines()
            self.assertEqual(len(lines), 1)
            handoff = json.loads(lines[0])
            self.assertEqual(set(handoff), {"event", "bridge_identity", "control_token"})
            self.assertEqual(handoff["event"], "fresh_bridge_ready")
            self.assertTrue(handoff["bridge_identity"] == self.s.identity)
            self.assertTrue(handoff["control_token"] == self.s.control_token, "startup token must match the live HTTP credential")

            for route in ("/review", "/retry"):
                code, body = http_post(route, {**self.p, "control_token": "!" * 43})
                self.assertEqual((code, body), (401, {"error_code": "control_token_rejected"}))
            self.assertEqual(self.ws.messages, [])
            h = object.__new__(f.FreshHandler); h.state = self.s; h.path = "/bootstrap"
            h.headers = {"Host": "127.0.0.1:18797", "Origin": "https://controller.invalid"}
            h.client_address = ("127.0.0.1", 9000); rejected = []
            h.write = lambda code, body: rejected.append((code, body)); h.do_GET()
            self.assertEqual(rejected, [(403, {"error_code": "origin_rejected"})])

            payload = {**self.p, "control_token": handoff["control_token"]}
            code, record = http_post("/review", payload)
            self.assertEqual(code, 202)
            code, retried = http_post("/retry", {**payload, "request_id": record["request_id"], "control_id": record["control_id"]})
            self.assertEqual(code, 202)
            self.assertEqual(len(retried["attempts"]), 2)
            self.s.message(self.ws, self.msg(record, 2))
            result = self.s.requests.lookup(record["request_id"])
            self.assertEqual(result["status"], "complete")
            checkpoint = self.s.requests.checkpoint()
            for value in (self.j.events, checkpoint, self.s.requests.records, result, self.s.health()):
                serialized = d.encoded(value)
                self.assertTrue(self.s.control_token.encode() not in serialized, "ephemeral token must not enter durable/public records")
                self.assertTrue(b'"control_token"' not in serialized, "durable/public records must not contain a credential field")

        server.serve_forever.side_effect = controller
        argv = ["fresh", "--data-root", str(f.DATA_ROOT), "--namespace", "synthetic-fresh-only", "--extension-id", EXTENSION]
        with patch.object(__import__("sys"), "argv", argv), patch.object(f, "FreshJournal", return_value=self.j), \
             patch.object(f, "FreshState", return_value=self.s), patch.object(b, "LocalThreadingHTTPServer", return_value=server), \
             redirect_stdout(captured):
            f.main()
        server.serve_forever.assert_called_once(); server.server_close.assert_called_once()
        self.assertTrue(all(self.s.control_token.encode() not in p.read_bytes() for p in self.path.iterdir() if p.is_file()),
                        "journal files must not contain the startup credential")
