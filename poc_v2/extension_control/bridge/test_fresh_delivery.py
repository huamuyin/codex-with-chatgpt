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
    def test_bounded_extended_composer_metadata_remains_read_only_and_no_missing_summary_success(self):
        r = self.send(); before = (self.path / "events.jsonl").read_bytes()
        value = dict(action="inspect_draft", request_id=r["request_id"], control_id=r["control_id"], attempt_id=1, tab_id=7, url=URL)
        summary = dict(composer_present=True,composer_tag="DIV",contenteditable=True,length=12,empty=False,format_only=False,
                       owned_attempt_id=None,normalized_owned_attempt_id=1,composer_form_present=True,
                       composer_buttons=[dict(test_id="composer-submit-button",aria_label="发送",type="button",disabled=True,aria_disabled=False,visible=True)])
        for variant in ("valid", "missing", "oversize", "extra", "bad_boolean"):
            mid, _ = self.s.maintenance(value); payload = copy.deepcopy(summary)
            if variant == "oversize": payload["composer_buttons"] *= 13
            if variant == "extra": payload["composer_buttons"][0]["raw_draft"] = "must not pass"
            if variant == "bad_boolean": payload["composer_buttons"][0]["disabled"] = 1
            m = dict(type="fresh_maintenance_result", maintenance_id=mid, action="inspect_draft", complete=True)
            if variant != "missing": m["draft_summary"] = payload
            self.s.message(self.ws, m); result = self.s.maintenance_commands[mid]["result"]
            self.assertEqual(result["status"], "complete" if variant == "valid" else "failed")
            self.assertEqual("draft_summary" in result, variant == "valid")
            self.assertEqual((self.path / "events.jsonl").read_bytes(), before)

    def future_setup_fixture(self):
        r = self.send(); self.s.message(self.ws, self.msg(r))
        self.s.status.update(connected=False, candidate_count=0, tab_id=None, url="",
            bound_tab_diagnostics=[dict(tab_id=7, exists=False, status="missing", url="")],
            observed_targets=[dict(tab_id=8, url="https://chatgpt.com/", status="complete", pending_url="")])
        return dict(action="prepare_future_thread", request_id=r["request_id"], control_id=r["control_id"],
                    attempt_id=1, tab_id=8, url=URL)

    def test_future_setup_only_navigates_new_tab_without_rebinding_completed_authority(self):
        value = self.future_setup_fixture(); raw = (self.path / "events.jsonl").read_bytes()
        records = copy.deepcopy(self.s.requests.records); checkpoint = self.s.requests.checkpoint()
        mid, _ = self.s.maintenance(value); m = self.ws.messages[-1]
        self.assertEqual(m["request"]["target_tab_id"], 7); self.assertEqual(m["tab_id"], 8)
        self.assertTrue(m["future_only"]); self.assertEqual(m["url"], URL)
        self.s.message(self.ws, dict(type="fresh_maintenance_result", maintenance_id=mid,
                                    action="prepare_future_thread", complete=True, future_only=True))
        self.assertFalse(self.s.ready()); self.assertIsNone(self.s.active)
        self.assertEqual((self.path / "events.jsonl").read_bytes(), raw)
        self.assertEqual(self.s.requests.records, records); self.assertEqual(self.s.requests.checkpoint(), checkpoint)

    def test_future_setup_refuses_changed_identity_pending_duplicate_stale_or_existing_old_tab(self):
        value = self.future_setup_fixture(); base = copy.deepcopy(self.s.status)
        raw = (self.path / "events.jsonl").read_bytes(); count = len(self.ws.messages)
        for change in (dict(request_id=str(uuid.uuid4())), dict(control_id=str(uuid.uuid4())),
                       dict(attempt_id=2), dict(tab_id=7), dict(url="https://chatgpt.com/c/other")):
            with self.subTest(change=change), self.assertRaises(b.RequestError): self.s.maintenance({**value, **change})
        for variant in ("old_exists", "duplicate", "loading", "pending_url", "other_url", "mixed_components", "stale", "active", "pending", "failed"):
            self.s.status = copy.deepcopy(base); self.s.seen_at = f.time.monotonic(); self.s.active = None
            r = self.s.requests.records[value["request_id"]]; r["status"] = "complete"
            if variant == "old_exists": self.s.status["bound_tab_diagnostics"][0]["exists"] = True
            if variant == "duplicate": self.s.status["observed_targets"].append(dict(tab_id=9, url="https://chatgpt.com/", status="complete"))
            if variant == "loading": self.s.status["observed_targets"][0]["status"] = "loading"
            if variant == "pending_url": self.s.status["observed_targets"][0]["pending_url"] = URL
            if variant == "other_url": self.s.status["observed_targets"][0]["url"] = URL
            if variant == "mixed_components": self.s.status["components"]["background_version"] = "0.8.1"
            if variant == "stale": self.s.seen_at -= 91
            if variant == "active": self.s.active = dict(request_id=value["request_id"])
            if variant in ("pending", "failed"): r["status"] = variant
            with self.subTest(variant=variant), self.assertRaises(b.RequestError): self.s.maintenance(value)
            self.assertEqual(len(self.ws.messages), count); self.assertEqual((self.path / "events.jsonl").read_bytes(), raw)

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

    def test_explicit_retry_preserves_failed_journal_byte_prefix_and_rejects_changed_authority(self):
        original = self.send(); rid, cid = original["request_id"], original["control_id"]
        wire1 = self.s.requests.wire_request(rid, 1)
        self.s.timeout(rid, 1)
        before = (self.path / "events.jsonl").read_bytes()
        decoded = [json.loads(line) for line in before.splitlines()]
        retried = self.retry(original); after = (self.path / "events.jsonl").read_bytes()
        rows = [json.loads(line) for line in after.splitlines()]
        self.assertTrue(after.startswith(before)); self.assertEqual(rows[:-1], decoded)
        self.assertEqual(len(rows), len(decoded) + 1); self.assertEqual(rows[-1]["event"]["kind"], "send_attempt")
        self.assertEqual(rows[-1]["event"]["data"]["attempt_id"], 2)
        self.assertEqual(retried["request_id"], rid); self.assertEqual(retried["control_id"], cid)
        self.assertEqual(retried["attempts"][0]["status"], "failed")
        self.assertEqual(retried["attempts"][0]["error_code"], "caller_wait_timeout")
        self.assertEqual(retried["attempts"][0]["wire_message"], wire1["message"])
        wire2 = self.s.requests.wire_request(rid, 2)
        for key in ("request_id", "control_id", "nonce", "expected_commit"):
            self.assertEqual(wire2[key], wire1[key])
        self.assertEqual(sum(x["event"]["kind"] == "logical_created" for x in rows), 1)
        for key, bad in (("commit", "b" * 40), ("instruction", "changed instruction"), ("conversation_url", "https://chatgpt.com/c/other")):
            with self.subTest(key=key), self.assertRaisesRegex(b.RequestError, "logical_identity_mismatch"):
                self.s.send({**self.p, "request_id": rid, key: bad}, retry=True, control_id=cid)
            self.assertEqual((self.path / "events.jsonl").read_bytes(), after)

    def test_canonical_attempt_survives_same_attempt_late_error_and_restart(self):
        r = self.send(); self.s.message(self.ws, self.msg(r, raw_reply="canonical exact"))
        before = (self.path / "events.jsonl").read_bytes(); derived = self.s.requests.lookup(r["request_id"])
        canonical = d.encoded(derived["result"])
        self.s.requests.failed(r["request_id"], 1, "late_error")
        after = (self.path / "events.jsonl").read_bytes(); current = self.s.requests.lookup(r["request_id"])
        self.assertTrue(after.startswith(before)); self.assertEqual(current, derived)
        self.assertEqual(d.encoded(current["result"]), canonical)
        self.assertEqual(self.s.requests.journal.events[-1]["kind"], "attempt_failed")
        self.j.close(); self.s, self.ws = self.state(self.open())
        self.assertEqual(self.s.requests.lookup(r["request_id"]), current); self.assertEqual(self.ws.messages, [])
        self.assertEqual((self.path / "events.jsonl").read_bytes(), after)

    def test_both_completed_attempts_preserved_after_duplicate_and_late_errors(self):
        r = self.send(); self.s.timeout(r["request_id"], 1); self.retry(r)
        self.s.message(self.ws, self.msg(r, 2, raw_reply="canonical attempt2"))
        self.s.message(self.ws, self.msg(r, 1, raw_reply="late duplicate attempt1"))
        derived = self.s.requests.lookup(r["request_id"]); before = (self.path / "events.jsonl").read_bytes()
        canonical = d.encoded(derived["result"]); self.assertEqual(derived["duplicate_count"], 1)
        self.s.requests.failed(r["request_id"], 1, "late_error1")
        self.s.requests.failed(r["request_id"], 2, "late_uncertain2", uncertain=True)
        current = self.s.requests.lookup(r["request_id"]); after = (self.path / "events.jsonl").read_bytes()
        self.assertEqual(current, derived); self.assertTrue(after.startswith(before)); self.assertEqual(d.encoded(current["result"]), canonical)
        self.assertEqual([x["status"] for x in current["attempts"]], ["complete", "complete"])
        self.assertEqual([x["kind"] for x in self.s.requests.journal.events[-2:]], ["attempt_failed", "delivery_uncertain"])
        self.j.close(); self.s, self.ws = self.state(self.open())
        self.assertEqual(self.s.requests.lookup(r["request_id"]), current); self.assertEqual((self.path / "events.jsonl").read_bytes(), after)

    def test_failure_before_valid_reply_still_completes_without_erasing_failure_history(self):
        r = self.send(); self.s.timeout(r["request_id"], 1)
        before = (self.path / "events.jsonl").read_bytes(); self.s.message(self.ws, self.msg(r, raw_reply="valid after failure"))
        current = self.s.requests.lookup(r["request_id"]); after = (self.path / "events.jsonl").read_bytes()
        self.assertTrue(after.startswith(before)); self.assertEqual(current["status"], "complete")
        self.assertEqual(current["attempts"][0]["status"], "complete"); self.assertEqual(current["attempts"][0]["error_code"], "caller_wait_timeout")
        self.assertEqual(current["duplicate_count"], 0); canonical = d.encoded(current["result"])
        self.j.close(); self.s, self.ws = self.state(self.open())
        restored = self.s.requests.lookup(r["request_id"]); self.assertEqual(restored, current)
        self.assertEqual(d.encoded(restored["result"]), canonical); self.assertEqual((self.path / "events.jsonl").read_bytes(), after)

    def test_websocket_origin_and_first_auth_frame_are_closed_before_registration(self):
        self.s.unregister(self.ws); before = (self.path / "events.jsonl").read_bytes()
        cases = [(None, {}), ("chrome-extension://" + "b" * 32, {}),
                 (self.s.extension_origin, {"type": "auth"}),
                 (self.s.extension_origin, {"type": "auth", "control_token": "!" * 43}),
                 (self.s.extension_origin, {"type": "auth", "control_token": self.s.control_token})]
        for index, (origin, auth) in enumerate(cases):
            h = object.__new__(f.FreshHandler); h.state = self.s; h.path = "/ws"
            h.headers = {"Host": "127.0.0.1:18797", "Upgrade": "websocket", "Connection": "Upgrade", "Sec-WebSocket-Version": "13",
                         "Sec-WebSocket-Key": f.base64.b64encode(b"x" * 16).decode()}
            if origin is not None: h.headers["Origin"] = origin
            h.client_address = ("127.0.0.1", 9000); h.connection = Mock(); h.rfile = io.BytesIO(); h.wfile = io.BytesIO()
            writes = []; h.write = lambda code, body: writes.append((code, body))
            h.send_response = Mock(); h.send_header = Mock(); h.end_headers = Mock()
            session = Mock(); session.closed = False; messages = []
            session.send_json.side_effect = lambda value: messages.append(copy.deepcopy(value))
            session.close.side_effect = lambda: setattr(session, "closed", True)
            with patch.object(b, "WebSocketSession", return_value=session), patch.object(b, "_read_client_frame", side_effect=[(1, json.dumps(auth).encode()), (8, b"")]), \
                 patch.object(f.threading, "Thread"), patch.object(self.s, "register", wraps=self.s.register) as register:
                h.do_GET(); self.assertEqual(register.call_count, 1 if index == 4 else 0)
            if index < 2: self.assertEqual(writes, [(403, {"error_code": "origin_rejected"})])
            if index in (2, 3): self.assertEqual(messages, [{"type": "auth_error"}])
            if index == 4:
                self.assertEqual(len(messages), 1); self.assertEqual(messages[0]["type"], "fresh_welcome")
            for value in (writes, messages, self.s.health(), self.s.requests.checkpoint()):
                raw = d.encoded(value); self.assertTrue(self.s.control_token.encode() not in raw); self.assertNotIn(b'"control_token"', raw)
            self.assertIsNone(self.s.session); self.assertEqual((self.path / "events.jsonl").read_bytes(), before)
            self.assertEqual(self.s.requests.records, {})

    def test_controller_posts_reject_wrong_host_port_peer_or_token_before_actions(self):
        before = (self.path / "events.jsonl").read_bytes(); count = len(self.ws.messages)
        for route in ("/review", "/retry", "/maintenance"):
            for host, peer, token, expected in [("localhost:18797", "127.0.0.1", self.s.control_token, "host_rejected"),
                ("127.0.0.1:18795", "127.0.0.1", self.s.control_token, "host_rejected"),
                ("127.0.0.1:18797", "192.0.2.1", self.s.control_token, "host_rejected"),
                ("127.0.0.1:18797", "127.0.0.1", "!" * 43, "control_token_rejected")]:
                payload = {**self.p, "control_token": token} if route != "/maintenance" else {"action": "sample_status", "control_token": token}
                raw = json.dumps(payload).encode(); h = object.__new__(f.FreshHandler); h.state = self.s; h.path = route
                h.headers = {"Host": host, "Content-Type": "application/json", "Content-Length": str(len(raw))}; h.client_address = (peer, 9000); h.rfile = io.BytesIO(raw)
                writes = []; h.write = lambda code, body: writes.append((code, body)); h.do_POST()
                self.assertEqual(writes, [(403 if expected == "host_rejected" else 401, {"error_code": expected})])
                self.assertEqual((self.path / "events.jsonl").read_bytes(), before); self.assertEqual(self.s.requests.records, {})
                self.assertEqual(len(self.ws.messages), count); self.assertEqual(self.s.maintenance_commands, {})

    def test_maintenance_messages_results_and_durable_files_exclude_ephemeral_credential(self):
        mid, _ = self.s.maintenance({"action": "sample_status", "control_token": self.s.control_token})
        self.s.message(self.ws, dict(type="fresh_maintenance_result", maintenance_id=mid, action="sample_status", complete=True))
        p = self.s.maintenance_commands[mid]
        for value in (p["message"], p["result"], self.ws.messages, self.s.health(), self.s.requests.checkpoint(), self.s.requests.records):
            raw = d.encoded(value); self.assertTrue(self.s.control_token.encode() not in raw); self.assertNotIn(b'"control_token"', raw)
        self.j.close()  # Release the Windows exclusive writer lock before inspecting its bytes too.
        for file in self.path.iterdir():
            if file.is_file(): self.assertTrue(self.s.control_token.encode() not in file.read_bytes()); self.assertNotIn(b'"control_token"', file.read_bytes())

    def test_sealed_checkpoint_roundtrip_exports_background_fixture_without_sending(self):
        r = self.send(); self.s.timeout(r["request_id"], 1); self.retry(r)
        self.s.message(self.ws, self.msg(r, 2, raw_reply="canonical2")); self.s.message(self.ws, self.msg(r, 1, raw_reply="duplicate1"))
        before = {name:(self.path/name).read_bytes() for name in ("events.jsonl", "head.json")}
        records = copy.deepcopy(self.s.requests.records); checkpoint = self.s.requests.checkpoint(); self.j.close()
        reopened = self.open(); state = f.FreshState(reopened, EXTENSION); session = CapturingSession(); welcome = state.register(session)
        self.assertEqual(welcome["type"], "fresh_welcome"); self.assertEqual(welcome["checkpoint"], checkpoint)
        self.assertEqual(state.requests.records, records); self.assertEqual(state.requests.checkpoint(), checkpoint)
        self.assertEqual(session.messages, []); self.assertIsNone(state.active); self.assertEqual(state.maintenance_commands, {})
        for name, raw in before.items(): self.assertEqual((self.path/name).read_bytes(), raw)
        fixture = {"bridge_identity": state.identity, "checkpoint": checkpoint, "records": records}
        self.assertTrue(state.control_token.encode() not in d.encoded(fixture)); self.assertNotIn(b'"control_token"', d.encoded(fixture))
        (self.root/"fresh-roundtrip-cross-language.json").write_bytes(d.encoded(fixture) + b"\n")

    def test_corrupt_seals_deleted_tail_and_recomputed_invalid_attempt_never_replace_journal(self):
        r = self.send(); self.s.timeout(r["request_id"], 1); self.retry(r)
        original = {name:(self.path/name).read_bytes() for name in ("owner.json", "events.jsonl", "head.json")}
        for variant in ("head_sequence", "head_hash", "deleted_tail", "invalid_attempt", "invalid_wire"):
            path = self.root / ("corrupt-roundtrip-" + variant + "-" + uuid.uuid4().hex[:8]); path.mkdir()
            corrupted = dict(original)
            if variant.startswith("head_"):
                head = json.loads(corrupted["head.json"])
                if variant == "head_sequence": head["sequence"] += 1
                else: head["hash"] = "0" * 64
                corrupted["head.json"] = d.encoded(head) + b"\n"
            elif variant == "deleted_tail": corrupted["events.jsonl"] = b"\n".join(corrupted["events.jsonl"].splitlines()[:-1]) + b"\n"
            else:
                rows = [json.loads(line)["event"] for line in corrupted["events.jsonl"].splitlines()]
                if variant == "invalid_attempt": rows[-1]["data"]["attempt_id"] = 999
                else: rows[-1]["data"]["wire_message"] += " altered"
                previous = "0" * 64; encoded = []
                for event in rows:
                    event["previous_hash"] = previous; digest = hashlib.sha256(d.encoded(event)).hexdigest()
                    encoded.append(d.encoded({"event": event, "hash": digest}) + b"\n"); previous = digest
                corrupted["events.jsonl"] = b"".join(encoded); corrupted["head.json"] = d.encoded({"sequence": len(rows), "hash": previous}) + b"\n"
            for name, raw in corrupted.items(): (path/name).write_bytes(raw)
            (path/"writer.lock").write_bytes(b""); names = sorted(x.name for x in path.iterdir())
            with self.subTest(variant=variant), self.assertRaises(ValueError):
                candidate = d.FreshJournal(path, "synthetic-fresh-only"); candidate_state = f.FreshState(candidate, EXTENSION)
                candidate_state.requests.checkpoint()
            self.assertEqual(sorted(x.name for x in path.iterdir()), names)
            for name, raw in corrupted.items(): self.assertEqual((path/name).read_bytes(), raw)

    def test_restore_original_thread_from_root_is_navigation_only_and_uses_frozen_attempt(self):
        r = self.send(); raw = (self.path / "events.jsonl").read_bytes()
        self.s.status.update(connected=False, candidate_count=0, tab_id=None, url="",
            bound_tab_diagnostics=[dict(tab_id=7, exists=True, status="complete", url="https://chatgpt.com/")],
            observed_targets=[dict(tab_id=7, url="https://chatgpt.com/", status="complete")])
        value = dict(action="restore_thread", request_id=r["request_id"], control_id=r["control_id"], attempt_id=1, tab_id=7, url=URL)
        self.s.maintenance(value)
        self.assertEqual(self.ws.messages[-1]["request"], self.s.requests.wire_request(r["request_id"], 1))
        self.assertEqual((self.path / "events.jsonl").read_bytes(), raw)
        for change in (dict(tab_id=8), dict(url="https://chatgpt.com/"), dict(control_id=str(uuid.uuid4())), dict(attempt_id=999), dict(request_id=str(uuid.uuid4()))):
            with self.assertRaises(b.RequestError): self.s.maintenance({**value, **change})
        self.s.status["observed_targets"].append(dict(tab_id=8, url=URL))
        with self.assertRaises(b.RequestError): self.s.maintenance(value)
        self.assertEqual((self.path / "events.jsonl").read_bytes(), raw)

    def test_activation_uses_known_frozen_attempt_without_requiring_a_running_content_event_loop(self):
        r = self.send(); raw = (self.path / "events.jsonl").read_bytes()
        self.s.status.update(connected=False, components={})
        value = dict(action="activate_tab", request_id=r["request_id"], control_id=r["control_id"], attempt_id=1, tab_id=7, url=URL)
        self.s.maintenance(value)
        self.assertEqual(self.ws.messages[-1]["request"], self.s.requests.wire_request(r["request_id"], 1))
        for change in (dict(tab_id=8), dict(url="https://chatgpt.com/"), dict(control_id=str(uuid.uuid4())), dict(attempt_id=999)):
            with self.assertRaises(b.RequestError): self.s.maintenance({**value, **change})
        self.assertEqual((self.path / "events.jsonl").read_bytes(), raw)

    def test_restore_rejects_stale_duplicate_and_unrelated_current_urls_without_writes_or_dispatch(self):
        r = self.send(); value = dict(action="restore_thread", request_id=r["request_id"], control_id=r["control_id"], attempt_id=1, tab_id=7, url=URL)
        status = {**self.s.status, "connected": False, "candidate_count": 0, "tab_id": None, "url": "",
                  "bound_tab_diagnostics": [dict(tab_id=7, exists=True, status="complete", url="https://chatgpt.com/")],
                  "observed_targets": [dict(tab_id=7, url="https://chatgpt.com/", status="complete")]}
        before = (self.path / "events.jsonl").read_bytes(); count = len(self.ws.messages)
        for variant in ("stale", "duplicate_root", "duplicate_target", "unrelated"):
            self.s.status = copy.deepcopy(status); self.s.seen_at = f.time.monotonic()
            if variant == "stale": self.s.seen_at -= 91
            if variant == "duplicate_root": self.s.status["observed_targets"].append(dict(tab_id=8, url="https://chatgpt.com/"))
            if variant == "duplicate_target": self.s.status["observed_targets"].append(dict(tab_id=8, url=URL))
            if variant == "unrelated": self.s.status["bound_tab_diagnostics"][0]["url"] = "https://chatgpt.com/c/other"
            with self.subTest(variant=variant), self.assertRaises(b.RequestError): self.s.maintenance(value)
            self.assertEqual(len(self.ws.messages), count); self.assertEqual((self.path / "events.jsonl").read_bytes(), before)
            self.assertEqual(len(self.s.requests.records), 1)
        self.s.status = copy.deepcopy(status); self.s.seen_at = f.time.monotonic()
        mid, _ = self.s.maintenance(value)
        self.s.message(self.ws, dict(type="fresh_maintenance_result", maintenance_id=mid, action="restore_thread", complete=True))
        self.assertEqual(self.s.maintenance_commands[mid]["result"]["status"], "complete")
        self.assertFalse(self.s.ready(), "navigation ACK is not post-navigation readiness")
        self.assertEqual((self.path / "events.jsonl").read_bytes(), before)

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
