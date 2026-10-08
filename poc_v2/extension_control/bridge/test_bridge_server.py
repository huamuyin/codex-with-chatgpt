"""Offline-only tests: no sockets, real bridge, browser, or historical records."""
import copy
import io
import json
import unittest
from unittest.mock import Mock, patch
import bridge_server as bridge
from bridge_server import BridgeState, BridgeHandler, RequestError, validate_review_payload, request_fingerprint

URL = "https://chatgpt.com/c/offline-fixture"
REPLY = "[C2C_V2_EXTENSION_SMOKE_OK]"


def sample_payload(**overrides):
    value = {
        "task_id": "C2C_V2_CHROME_EXTENSION_CONTROL_PLANE_POC_R1", "iteration": 3,
        "repo": "huamuyin/codex-with-chatgpt", "pr": 1, "branch": "poc/c2c-v2-github-bus-r1",
        "commit": "0000000000000000000000000000000000000001",
        "evidence_path": ".c2c-v2/iteration-003/review_request.json",
        "instruction": "Offline fixture only.", "conversation_url": URL, "control_token": "a" * 43,
    }
    value.update(overrides)
    return value


class CapturingSession:
    def __init__(self):
        self.closed = False
        self.messages = []

    def send_json(self, value):
        self.messages.append(copy.deepcopy(value))

    def close(self):
        self.closed = True


def status(**overrides):
    value = {
        "type": "tab_status", "connected": True, "tab_id": 7, "url": URL,
        "protocol_version": bridge.PROTOCOL_VERSION,
        "background_version": bridge.COMPONENT_VERSION, "content_version": bridge.COMPONENT_VERSION,
        "manifest_version": bridge.COMPONENT_VERSION,
        "background_build_id": bridge.BUILD_ID, "content_build_id": bridge.BUILD_ID,
    }
    value.update(overrides)
    return value


def ready_state(**overrides):
    state = BridgeState()
    session = CapturingSession()
    state.register_session(session)
    state.handle_message(session, status(**overrides))
    return state, session


def failed_original(error="chat_tab_unavailable"):
    state, session = ready_state()
    payload = validate_review_payload(sample_payload(control_token=state.control_token))
    pending = state.send_request_once(payload)
    state.handle_message(session, {"type": "review_error", **{
        key: pending["wire_request"][key] for key in bridge.IDENTITY_KEYS
    }, "error_code": error})
    payload["request_id"] = pending["request_id"]
    return state, session, payload


def result_for(state, **overrides):
    r = state.recovery_pending
    value = {
        "type": "recovery_result", **{key: r[key] for key in bridge.IDENTITY_KEYS},
        "attempt": r["attempt"], "tab_id": r["target_tab_id"], "conversation_url": r["conversation_url"],
        **{key: True for key in bridge.CHECK_KEYS},
        "assistant_generation_complete": True, "reply_match_rule": "raw-exact-v1", "raw_reply": REPLY,
    }
    value.update(overrides)
    return value


def handler(path, value=None, headers=None):
    h = object.__new__(BridgeHandler)
    h.path = path
    data = json.dumps(value).encode("utf-8") if value is not None else b""
    h.headers = {"Host": "127.0.0.1:18796", "Content-Type": "application/json",
                 "Content-Length": str(len(data)), **(headers or {})}
    h.client_address = ("127.0.0.1", 9999)
    h.rfile = io.BytesIO(data)
    h.responses = []
    h._write_json = lambda code, body: h.responses.append((code, body))
    return h


class BridgeProtocolTests(unittest.TestCase):
    def test_fixed_loopback_and_exact_commit(self):
        self.assertEqual((bridge.HOST, bridge.PORT), ("127.0.0.1", 18796))
        p = validate_review_payload(sample_payload())
        message = bridge.format_control_message(p, "n" * 32)
        self.assertIn("COMMIT:\n" + p["commit"], message)
        self.assertIn("NONCE: " + "n" * 32, message)

    def test_invalid_input_rejected(self):
        for values in (
            {"commit": "not-sha"}, {"evidence_path": ".c2c-v2/../x"},
            {"branch": "branch\nCOMMIT: injected"}, {"iteration": True},
            {"conversation_url": "https://example.com/c/x"}, {"conversation_url": "https://chatgpt.com/"},
            {"conversation_url": "https://chatgpt.com/c/x?y=1"},
            {"conversation_url": "https://user@chatgpt.com/c/x"},
        ):
            with self.subTest(values=values), self.assertRaises(RequestError):
                validate_review_payload(sample_payload(**values))

    def test_instruction_and_original_url_remain_in_fingerprint(self):
        p = validate_review_payload(sample_payload())
        for overrides in ({"instruction": "different"}, {"conversation_url": URL + "other"}):
            self.assertNotEqual(request_fingerprint(p), request_fingerprint(validate_review_payload(sample_payload(**overrides))))

    def test_startup_identity_is_frozen_and_health_has_no_token(self):
        state = BridgeState()
        first = state.health()["bridge_identity"]
        with patch.object(bridge.Path, "read_bytes", side_effect=AssertionError("dynamic disk hash")):
            self.assertEqual(state.health()["bridge_identity"], first)
        self.assertEqual(first["bridge_version"], "0.8.1")
        self.assertRegex(first["startup_source_sha256"], r"^[a-f0-9]{64}$")
        self.assertNotIn(state.control_token, repr(state.health()))

    def test_components_must_all_match_to_report_ready(self):
        for key, bad in (("background_version", "0.4.0"), ("content_version", "0.4.0"),
                         ("manifest_version", "0.1.1"), ("protocol_version", 1),
                         ("background_build_id", "old"), ("content_build_id", "old")):
            with self.subTest(key=key):
                state, _ = ready_state(**{key: bad})
                self.assertTrue(state.health()["extension_connected"])
                self.assertFalse(state.health()["chat_tab_connected"])
                self.assertFalse(state.health()["content_script_ready"])
        state, _ = ready_state()
        self.assertTrue(state.health()["content_script_ready"])

    def test_ordinary_send_requires_connection_even_with_url(self):
        for state in (BridgeState(), ready_state(connected=False)[0], ready_state(content_version="old")[0]):
            with self.assertRaisesRegex(RequestError, "extension_or_chat_disconnected"):
                state.send_request_once(validate_review_payload(sample_payload()))
            self.assertIsNone(state.pending)
            self.assertEqual(state.committed_nonces, set())

    def test_send_one_in_flight_and_preserves_requested_sha(self):
        state, session = ready_state()
        p = validate_review_payload(sample_payload())
        pending = state.send_request_once(p)
        self.assertEqual(pending["expected_commit"], p["commit"])
        self.assertIn("REQUEST_ID: " + pending["request_id"], pending["wire_request"]["message"])
        with self.assertRaisesRegex(RequestError, "request_in_flight"):
            state.send_request_once(p)
        self.assertIs(state.poll_request(pending["request_id"], request_fingerprint(p))[1], pending["event"])
        self.assertEqual(len([m for m in session.messages if m["type"] == "review"]), 1)

    def test_send_cannot_change_bound_url(self):
        state, _ = ready_state()
        with self.assertRaisesRegex(RequestError, "conversation_binding_mismatch"):
            state.send_request_once(validate_review_payload(sample_payload(conversation_url=URL + "other")))

    def test_recovery_preserves_failure_and_never_calls_send_or_allocates_nonce(self):
        for error in bridge.RECOVERABLE_ERRORS:
            with self.subTest(error=error):
                state, session, p = failed_original(error)
                before = copy.deepcopy(state.completed)
                nonces = state.committed_nonces.copy()
                session.messages.clear()
                with patch.object(state, "send_request_once", side_effect=AssertionError("send called")), \
                     patch.object(bridge.secrets, "token_urlsafe", side_effect=AssertionError("nonce allocated")), \
                     patch.object(bridge.uuid, "uuid4", side_effect=AssertionError("new ID")):
                    _, event = state.recover_original_once(p, REPLY)
                    state.handle_message(session, result_for(state))
                    recovered, _ = state.poll_recovery(p["request_id"], request_fingerprint(p))
                self.assertTrue(event.is_set())
                self.assertEqual(recovered["status"], "complete")
                self.assertEqual(recovered["nonce"], before[p["request_id"]]["nonce"])
                self.assertEqual(state.completed, before)
                self.assertEqual(state.committed_nonces, nonces)
                self.assertIsNone(state.pending)
                self.assertEqual([m["type"] for m in session.messages], ["recover_original", "recovery_ack"])
                self.assertEqual(state.poll_request(p["request_id"], request_fingerprint(p))[0]["status"], "failed")

    def test_cached_recovery_is_idempotent(self):
        state, session, p = failed_original()
        state.recover_original_once(p, REPLY)
        event = state.recovery_pending["event"]
        self.assertIs(state.recover_original_once(p, REPLY)[1], event)
        state.handle_message(session, result_for(state))
        count = len(session.messages)
        cached, _ = state.recover_original_once(p, REPLY)
        self.assertEqual(cached["status"], "complete")
        self.assertEqual(len(session.messages), count)
        with self.assertRaisesRegex(RequestError, "recovery_payload_mismatch"):
            state.recover_original_once(p, "other")

    def test_unknown_request_id_is_rejected_without_state_change(self):
        state, session = ready_state()
        p = validate_review_payload(sample_payload(request_id="4754374f-14dd-4004-bf87-3b87972e17fa"))
        with self.assertRaisesRegex(RequestError, "request_id_unknown"):
            state.recover_original_once(p, REPLY)
        self.assertEqual(session.messages, [])
        self.assertIsNone(state.recovery_pending)

    def test_legacy_records_are_not_migrated(self):
        state, session, p = failed_original()
        record = state.completed[p["request_id"]]
        del record["original"]
        before = copy.deepcopy(record)
        with self.assertRaisesRegex(RequestError, "original_evidence_missing"):
            state.recover_original_once(p, REPLY)
        self.assertEqual(record, before)

    def test_missing_trusted_evidence_rejected(self):
        for key in ("nonce", "expected_commit", "iteration", "task_id", "request_id",
                    "conversation_url", "tab_id", "fingerprint", "message", "fingerprint_schema"):
            with self.subTest(key=key):
                state, _, p = failed_original()
                state.completed[p["request_id"]]["original"].pop(key)
                with self.assertRaises(RequestError):
                    state.recover_original_once(p, REPLY)
                self.assertIsNone(state.recovery_pending)

    def test_payload_changes_do_not_replace_original_fingerprint(self):
        for key, bad in (("commit", "f" * 40), ("iteration", 2), ("conversation_url", URL + "other"),
                         ("task_id", "other"), ("instruction", "changed")):
            with self.subTest(key=key):
                state, _, p = failed_original()
                before = copy.deepcopy(state.completed)
                p[key] = bad
                with self.assertRaisesRegex(RequestError, "recovery_payload_mismatch"):
                    state.recover_original_once(p, REPLY)
                self.assertEqual(state.completed, before)

    def test_untrusted_original_nonce_rejected(self):
        state, _, p = failed_original()
        state.completed[p["request_id"]]["original"]["nonce"] = "wrong" * 8
        with self.assertRaisesRegex(RequestError, "original_evidence_missing"):
            state.recover_original_once(p, REPLY)

    def test_wrong_live_binding_rejected(self):
        for change in ({"tab_id": 8}, {"url": URL + "other"}, {"connected": False}):
            with self.subTest(change=change):
                state, session, p = failed_original()
                state.handle_message(session, status(**change))
                with self.assertRaises(RequestError):
                    state.recover_original_once(p, REPLY)

    def test_other_failure_codes_not_whitelisted(self):
        for code in ("response_identity_mismatch", "recovery_failed", "unknown_error"):
            state, _, p = failed_original(code)
            with self.subTest(code=code), self.assertRaisesRegex(RequestError, "request_not_recoverable"):
                state.recover_original_once(p, REPLY)

    def test_recovery_negative_proofs_leave_original_unchanged(self):
        changes = [
            {"nonce": "x" * 32}, {"iteration": 2}, {"iteration": True}, {"expected_commit": "f" * 40},
            {"task_id": "other"}, {"conversation_url": URL + "other"}, {"conversation_url": URL + "?x=1"},
            {"tab_id": 8}, {"tab_id": True}, {"attempt": 2},
            {"assistant_generation_complete": False}, {"reply_match_rule": "normalized"},
            {"raw_reply": " " + REPLY}, {"raw_reply": REPLY + "\n"},
            *[{key: False} for key in bridge.CHECK_KEYS],
        ]
        for change in changes:
            with self.subTest(change=change):
                state, session, p = failed_original()
                before = copy.deepcopy(state.completed)
                state.recover_original_once(p, REPLY)
                state.handle_message(session, result_for(state, **change))
                r, _ = state.poll_recovery(p["request_id"], request_fingerprint(p))
                self.assertEqual(r["status"], "failed")
                self.assertEqual(state.completed, before)
                self.assertEqual(r["nonce"], before[p["request_id"]]["nonce"])

    def test_result_after_tab_change_or_version_change_fails(self):
        for change in ({"tab_id": 8}, {"url": URL + "other"}, {"content_version": "old"}):
            state, session, p = failed_original()
            state.recover_original_once(p, REPLY)
            proof = result_for(state)
            state.handle_message(session, status(**change))
            state.handle_message(session, proof)
            self.assertEqual(state.recovery_attempts[p["request_id"]][0]["status"], "failed")

    def test_wrong_response_request_id_never_confirms_recovery(self):
        state, session, p = failed_original()
        state.recover_original_once(p, REPLY)
        state.handle_message(session, result_for(state, request_id="4754374f-14dd-4004-bf87-3b87972e17fa"))
        self.assertIsNotNone(state.recovery_pending)
        self.assertEqual(state.recovery_attempts, {})

    def test_status_traffic_does_not_requeue_review(self):
        state, session, p = failed_original()
        state.recover_original_once(p, REPLY)
        before = len(session.messages)
        state.handle_message(session, status())
        self.assertEqual(len(session.messages), before)
        self.assertIsNone(state.pending)

    def test_first_root_binding_is_new_record_only_and_not_overwritten(self):
        state, session = ready_state(url="https://chatgpt.com/")
        p = validate_review_payload(sample_payload(conversation_url=""))
        pending = state.send_request_once(p)
        identity = {key: pending["wire_request"][key] for key in bridge.IDENTITY_KEYS}
        state.handle_message(session, status())
        state.handle_message(session, {"type": "review_bound", **identity, "tab_id": 7, "conversation_url": URL})
        self.assertEqual(pending["original"]["conversation_url"], URL)
        state.handle_message(session, status(url=URL + "other"))
        state.handle_message(session, {"type": "review_bound", **identity, "tab_id": 7, "conversation_url": URL + "other"})
        self.assertEqual(pending["original"]["conversation_url"], URL)

    def test_root_only_failed_record_cannot_recover(self):
        state, session = ready_state(url="https://chatgpt.com/")
        p = validate_review_payload(sample_payload(conversation_url=""))
        pending = state.send_request_once(p)
        state.handle_message(session, {"type": "review_error", **{
            key: pending["wire_request"][key] for key in bridge.IDENTITY_KEYS
        }, "error_code": "chat_tab_unavailable"})
        p["request_id"] = pending["request_id"]
        with self.assertRaisesRegex(RequestError, "original_evidence_missing"):
            state.recover_original_once(p, REPLY)

    def test_wrong_normal_response_commit_fails(self):
        state, session = ready_state()
        pending = state.send_request_once(validate_review_payload(sample_payload()))
        state.handle_message(session, {"type": "review_result", **pending["wire_request"],
                                      "expected_commit": "f" * 40, "raw_reply": "substitution"})
        self.assertEqual(state.completed[pending["request_id"]]["error_code"], "response_identity_mismatch")

    def test_reply_rule_is_raw_exact(self):
        self.assertTrue(bridge.reply_matches(REPLY, REPLY))
        for actual in (" " + REPLY, REPLY + "\n", REPLY + "\r", "Cafe\u0301"):
            self.assertFalse(bridge.reply_matches(actual, REPLY if actual != "Cafe\u0301" else "Café"))

    def test_shared_reply_vectors(self):
        path = bridge.Path(__file__).resolve().parents[1] / "tests" / "reply_match_vectors.json"
        for vector in json.loads(path.read_text(encoding="utf-8")):
            with self.subTest(vector=vector):
                self.assertEqual(bridge.reply_matches(vector["actual"], vector["expected"]), vector["matches"])

    def test_http_health_bootstrap_origin_gates_in_memory(self):
        state = BridgeState()
        with patch.object(bridge, "STATE", state), patch.object(bridge.socket, "socket", side_effect=AssertionError("network")):
            h = handler("/health"); h.do_GET()
            self.assertEqual(h.responses[0][0], 200)
            self.assertNotIn(state.control_token, repr(h.responses))
            h = handler("/bootstrap", headers={"Origin": "https://example.invalid"}); h.do_GET()
            self.assertEqual(h.responses[0][0], 403)
            h = handler("/bootstrap", headers={"Origin": bridge.EXTENSION_ORIGIN}); h.do_GET()
            self.assertEqual(h.responses[0][1]["bridge_identity"], state.startup_identity)

    def test_http_recovery_and_original_poll_are_separate_in_memory(self):
        state, session, p = failed_original()
        state.recover_original_once(p, REPLY)
        state.handle_message(session, result_for(state))
        value = {**p, "expected_reply": REPLY}
        with patch.object(bridge, "STATE", state), patch.object(bridge.socket, "socket", side_effect=AssertionError("network")):
            h = handler("/recover", value); h.do_POST()
            self.assertEqual(h.responses[0][0], 200)
            self.assertEqual(h.responses[0][1]["nonce"], state.completed[p["request_id"]]["nonce"])
            h = handler("/review", p); h.do_POST()
            self.assertEqual(h.responses[0][0], 502)
            self.assertEqual(h.responses[0][1]["error_code"], "chat_tab_unavailable")
            self.assertNotIn("original", h.responses[0][1])
            self.assertNotIn("nonce", h.responses[0][1])

    def test_http_pending_recovery_waits_and_polls_attempt_not_original(self):
        state, session, p = failed_original()
        state.recover_original_once(p, REPLY)
        event = state.recovery_pending["event"]
        with patch.object(bridge, "STATE", state), patch.object(event, "wait", side_effect=lambda _: state.handle_message(session, result_for(state))):
            h = handler("/recover", {**p, "expected_reply": REPLY}); h.do_POST()
        self.assertEqual(h.responses[0][0], 200)
        self.assertEqual(h.responses[0][1]["status"], "complete")

    def test_http_unknown_recovery_never_dispatches(self):
        state, session = ready_state()
        value = sample_payload(control_token=state.control_token,
                               request_id="4754374f-14dd-4004-bf87-3b87972e17fa", expected_reply=REPLY)
        with patch.object(bridge, "STATE", state):
            h = handler("/recover", value); h.do_POST()
        self.assertEqual(h.responses[0], (404, {"status": "error", "error_code": "request_id_unknown"}))
        self.assertEqual(session.messages, [])

class InspectionTests(unittest.TestCase):
    def begin(self):
        state, session = ready_state()
        p = validate_review_payload(sample_payload(request_id="4754374f-14dd-4004-bf87-3b87972e17fa"))
        pending = state.inspect_original_once(p, 7, REPLY)
        return state, session, p, pending

    def observation(self, pending, **changes):
        nonce = "offline_inspection_nonce_12345678"
        value = {
            "type": "inspection_result", "request_id": pending["request_id"],
            "task_id": pending["task_id"], "iteration": pending["iteration"],
            "expected_commit": pending["expected_commit"], "inspection": pending["inspection"],
            "tab_id": pending["target_tab_id"], "conversation_url": pending["conversation_url"],
            "content_identity": {"version": bridge.COMPONENT_VERSION, "protocol_version": 2, "build_id": bridge.BUILD_ID},
            "candidate_count": 1, "candidates": [{"nonce": nonce,
                "user_text": pending["original_message_template"].replace("__OBSERVED_NONCE__", nonce),
                "assistant_text": REPLY, "assistant_completed_observed": True, "reply_exact_observed": True}],
        }
        value.update(changes)
        return value

    def test_inspection_never_imports_unknown_original_or_calls_recovery_send(self):
        state, session = ready_state()
        p = validate_review_payload(sample_payload(request_id="4754374f-14dd-4004-bf87-3b87972e17fa"))
        before = copy.deepcopy(state.completed)
        with patch.object(state, "send_request_once", side_effect=AssertionError("send")), \
             patch.object(state, "recover_original_once", side_effect=AssertionError("recover")), \
             patch.object(bridge.secrets, "token_urlsafe", side_effect=AssertionError("nonce")):
            pending = state.inspect_original_once(p, 7, REPLY)
            state.handle_message(session, self.observation(pending, authoritative=True, recovered_original=True))
        self.assertEqual(state.completed, before)
        self.assertEqual(state.recovery_attempts, {})
        self.assertEqual(state.committed_nonces, set())
        self.assertFalse(pending["result"]["authoritative"])
        self.assertFalse(pending["result"]["original_nonce_verified"])
        self.assertFalse(pending["result"]["recovered_original"])
        with self.assertRaisesRegex(RequestError, "request_id_unknown"):
            state.recover_original_once(p, REPLY)

    def test_inspection_preserves_existing_failure_byte_for_byte(self):
        state, session, p = failed_original()
        before = json.dumps(state.completed, sort_keys=True)
        pending = state.inspect_original_once(p, 7, REPLY)
        state.handle_message(session, self.observation(pending))
        self.assertEqual(json.dumps(state.completed, sort_keys=True), before)
        self.assertIsNone(state.pending)
        self.assertIsNone(state.recovery_pending)

    def test_wrong_observation_identity_is_rejected(self):
        for changes in ({"iteration": 2}, {"expected_commit": "f"*40}, {"tab_id": 8},
                        {"conversation_url": URL+"other"}, {"task_id": "other"},
                        {"request_id": "11111111-1111-1111-1111-111111111111"}):
            state, session, p, pending = self.begin()
            state.handle_message(session, self.observation(pending, **changes))
            self.assertEqual(pending["result"]["error_code"], "inspection_identity_mismatch")
            self.assertEqual(state.completed, {})

    def test_mismatched_content_and_malformed_candidate_are_rejected(self):
        for changes in ({"content_identity": {"version": "0.5.0"}},
                        {"candidate_count": True}, {"candidates": "bad"}, {"candidate_count": 0}):
            state, session, p, pending = self.begin()
            state.handle_message(session, self.observation(pending, **changes))
            self.assertEqual(pending["result"]["error_code"], "inspection_shape_invalid")

    def test_observed_nonce_must_match_full_legacy_message(self):
        state, session, p, pending = self.begin()
        value = self.observation(pending)
        value["candidates"][0]["user_text"] += " altered"
        state.handle_message(session, value)
        self.assertEqual(pending["result"]["error_code"], "inspection_shape_invalid")

    def test_diagnostic_duplicate_candidates_are_unverified_and_not_recoverable(self):
        state, session, p, pending = self.begin()
        value = self.observation(pending)
        value["candidates"] *= 2; value["candidate_count"] = 2
        state.handle_message(session, value)
        self.assertEqual(pending["result"]["candidate_count"], 2)
        self.assertFalse(pending["result"]["authoritative"])
        with self.assertRaises(RequestError):
            state.recover_original_once(p, REPLY)

    def test_inspection_mode_locks_sending_and_recovery(self):
        state = BridgeState(inspection_only=True)
        p = validate_review_payload(sample_payload())
        self.assertFalse(state.health()["normal_sending_enabled"])
        with self.assertRaisesRegex(RequestError, "inspection_mode_locked"):
            state.send_request_once(p)
        with self.assertRaisesRegex(RequestError, "inspection_mode_locked"):
            state.recover_original_once(p, REPLY)
        self.assertEqual(state.committed_nonces, set())

    def test_inspection_http_timeout_does_not_change_normal_state(self):
        state, session = ready_state()
        p = sample_payload(control_token=state.control_token,
            request_id="4754374f-14dd-4004-bf87-3b87972e17fa", target_tab_id=7, expected_reply=REPLY, wait_seconds=1)
        with patch.object(bridge, "STATE", state), patch.object(bridge.threading.Event, "wait", return_value=False):
            h = handler("/inspect", p); h.do_POST()
        self.assertEqual(h.responses[0][1]["error_code"], "inspection_timeout")
        self.assertFalse(h.responses[0][1]["authoritative"])
        self.assertEqual(state.completed, {})
        self.assertIsNone(state.inspection_pending)

    def test_sending_and_recovery_cannot_run_during_inspection(self):
        state, session, p = failed_original()
        state.inspect_original_once(p, 7, REPLY)
        with self.assertRaisesRegex(RequestError, "request_in_flight"):
            state.send_request_once(p)
        with self.assertRaisesRegex(RequestError, "request_in_flight"):
            state.recover_original_once(p, REPLY)

    def test_missing_inspection_url_or_tab_is_rejected(self):
        state, _ = ready_state()
        p = validate_review_payload(sample_payload(request_id="4754374f-14dd-4004-bf87-3b87972e17fa"))
        for tab in (None, True, -1):
            with self.assertRaises(RequestError):
                state.inspect_original_once(p, tab, REPLY)
        p["conversation_url"] = ""
        with self.assertRaisesRegex(RequestError, "inspection_reference_required"):
            state.inspect_original_once(p, 7, REPLY)


if __name__ == "__main__":
    unittest.main()


class NormalResponseTests(unittest.TestCase):
    def normal_result(self, pending, **overrides):
        result = {
            "type": "review_result", **{key: pending["wire_request"][key] for key in bridge.IDENTITY_KEYS},
            "tab_id": 7, "conversation_url": URL, "raw_reply": "  Cafe\u0301\r\n",
            "assistant_generation_complete": True, "reply_match_rule": "raw-exact-v1",
            "content_identity": {"version": bridge.COMPONENT_VERSION,
                "protocol_version": bridge.PROTOCOL_VERSION, "build_id": bridge.BUILD_ID},
        }
        result.update(overrides)
        return result

    def test_complete_normal_response_keeps_exact_raw_text_and_binding_proof(self):
        state, session = ready_state()
        pending = state.send_request_once(validate_review_payload(sample_payload()))
        result = self.normal_result(pending)
        state.handle_message(session, result)
        saved = state.completed[pending["request_id"]]
        self.assertEqual(saved["status"], "complete")
        self.assertEqual(saved["raw_reply"], "  Cafe\u0301\r\n")
        self.assertEqual(saved["conversation_url"], URL)
        self.assertTrue(saved["assistant_generation_complete"])
        self.assertEqual(saved["original"]["nonce"], pending["nonce"])

    def test_normal_response_rejects_wrong_identity_completion_binding_and_components(self):
        changes = (
            {"nonce": "x" * 32}, {"iteration": 2}, {"iteration": True},
            {"request_id": "00000000-0000-0000-0000-000000000002"},
            {"expected_commit": "f" * 40}, {"tab_id": 8}, {"tab_id": True},
            {"conversation_url": URL + "-other"}, {"assistant_generation_complete": False},
            {"assistant_generation_complete": "true"}, {"reply_match_rule": "trimmed"},
            {"content_identity": {}}, {"content_identity": {"version": "0.3.0",
                "protocol_version": bridge.PROTOCOL_VERSION, "build_id": bridge.BUILD_ID}},
        )
        for change in changes:
            with self.subTest(change=change):
                state, session = ready_state()
                pending = state.send_request_once(validate_review_payload(sample_payload()))
                state.handle_message(session, self.normal_result(pending, **change))
                self.assertEqual(state.completed[pending["request_id"]]["status"], "failed")

    def test_normal_response_rejects_missing_proof_and_stale_live_status(self):
        for field in ("tab_id", "conversation_url", "assistant_generation_complete", "reply_match_rule", "content_identity"):
            with self.subTest(missing=field):
                state, session = ready_state()
                pending = state.send_request_once(validate_review_payload(sample_payload()))
                result = self.normal_result(pending)
                result.pop(field)
                state.handle_message(session, result)
                self.assertEqual(state.completed[pending["request_id"]]["status"], "failed")
        for update in (status(connected=False), status(url=URL + "-other"), status(content_version="0.3.0")):
            state, session = ready_state()
            pending = state.send_request_once(validate_review_payload(sample_payload()))
            state.handle_message(session, update)
            state.handle_message(session, self.normal_result(pending))
            self.assertEqual(state.completed[pending["request_id"]]["status"], "failed")

    def test_root_response_requires_verified_first_binding(self):
        for bind in (False, True):
            with self.subTest(bind=bind):
                state, session = ready_state(url="https://chatgpt.com/")
                pending = state.send_request_once(validate_review_payload(sample_payload(conversation_url="")))
                state.handle_message(session, status())
                if bind:
                    state.handle_message(session, {"type": "review_bound",
                        **{key: pending["wire_request"][key] for key in bridge.IDENTITY_KEYS},
                        "tab_id": 7, "conversation_url": URL})
                state.handle_message(session, self.normal_result(pending))
                self.assertEqual(state.completed[pending["request_id"]]["status"], "complete" if bind else "failed")


class IsolatedEndpointTests(unittest.TestCase):
    def test_fixed_new_endpoint_and_frozen_startup_identity(self):
        state = BridgeState(inspection_only=True)
        self.assertEqual((bridge.HOST, bridge.PORT), ("127.0.0.1", 18796))
        identity = state.health()["bridge_identity"]
        self.assertEqual((identity["host"], identity["port"]), (bridge.HOST, bridge.PORT))
        self.assertEqual(identity["mode"], "inspection-only")
        self.assertFalse(state.health()["normal_sending_enabled"])

    def test_previous_shared_endpoint_host_is_rejected_offline(self):
        h = handler("/health", headers={"Host": "127.0.0.1:18795"})
        h.do_GET()
        self.assertEqual(h.responses[-1][0], 403)
        self.assertEqual(h.responses[-1][1]["error_code"], "host_rejected")

    def test_cli_default_uses_new_port_and_locks_send_recover_without_real_server(self):
        previous = bridge.STATE
        fake_server = Mock()
        capture = io.StringIO()
        try:
            with patch.object(bridge.sys, "argv", ["bridge_server.py"]), \
                    patch.object(bridge, "LocalThreadingHTTPServer", return_value=fake_server) as factory, \
                    patch.object(bridge.sys, "stdout", capture):
                self.assertEqual(bridge.main(), 0)
                factory.assert_called_once_with(("127.0.0.1", 18796), BridgeHandler)
                self.assertTrue(bridge.STATE.inspection_only)
                for action in (bridge.STATE.send_request_once, bridge.STATE.recover_original_once):
                    with self.assertRaises(RequestError) as raised:
                        if action.__name__ == "recover_original_once":
                            action({}, REPLY)
                        else:
                            action({})
                    self.assertEqual(raised.exception.code, "inspection_mode_locked")
                fake_server.server_close.assert_called_once()
        finally:
            bridge.STATE = previous


class BindingDiagnosticTests(unittest.TestCase):
    def diagnostic(self, tabs=None, count=None):
        tabs = [(8, "complete")] if tabs is None else tabs
        count = len(tabs) if count is None else count
        reason = ("no_matching_conversation_tab" if count == 0 else "duplicate_conversation_tabs" if count > 1
                  else "historical_tab_id_mismatch" if tabs[0][0] != 7 else "original_tab_not_complete")
        return {"schema": 1, "requested_tab_id": 7, "exact_url": URL, "reason": reason,
            "matching_tab_count": count, "truncated": count > 4, "authoritative": False,
            "matching_tabs": [{"tab_id": tid, "url": URL, "status": status} for tid, status in tabs[:4]]}

    def error(self, pending, diagnostic, **overrides):
        return InspectionTests().observation(pending, type="inspection_error",
            error_code="inspection_binding_unconfirmed", binding_diagnostic=diagnostic, **overrides)

    def test_bounded_exact_url_metadata_describes_each_binding_failure_without_rebinding(self):
        for tabs in ([], [(8, "complete")], [(7, "loading")], [(7, "unknown")],
                     [(7, "complete"), (8, "complete")], [(i, "complete") for i in range(7, 13)]):
            state, session, payload, pending = InspectionTests().begin()
            before = (copy.deepcopy(state.completed), state.chat_tab_id, state.chat_url, state.committed_nonces.copy())
            diagnostic = self.diagnostic(tabs)
            state.handle_message(session, self.error(pending, diagnostic))
            self.assertEqual(pending["result"]["error_code"], "inspection_binding_unconfirmed")
            self.assertEqual(pending["result"]["binding_diagnostic"], diagnostic)
            self.assertFalse(pending["result"]["recovered_original"])
            self.assertEqual((state.completed, state.chat_tab_id, state.chat_url, state.committed_nonces), before)
            self.assertIsNone(state.inspection_pending)

    def test_binding_diagnostic_rejects_unscoped_invalid_ambiguous_or_authoritative_metadata(self):
        mutations = [
            lambda d: d.update(exact_url=URL + "other"), lambda d: d.update(requested_tab_id=8),
            lambda d: d.update(requested_tab_id=True), lambda d: d.update(schema=True),
            lambda d: d.update(matching_tab_count=True), lambda d: d.update(matching_tab_count=-1),
            lambda d: d.update(matching_tab_count=10001), lambda d: d.update(truncated=True),
            lambda d: d.update(authoritative=True), lambda d: d.update(reason="no_matching_conversation_tab"),
            lambda d: d.update(title="unrelated private title"),
            lambda d: d["matching_tabs"][0].update(url=URL + "other"),
            lambda d: d["matching_tabs"][0].update(tab_id=True),
            lambda d: d["matching_tabs"][0].update(tab_id=-1),
            lambda d: d["matching_tabs"][0].update(status="active"),
            lambda d: d["matching_tabs"][0].update(active=True),
            lambda d: d.update(matching_tabs=[]),
            lambda d: d.update(matching_tab_count=2, reason="duplicate_conversation_tabs", matching_tabs=d["matching_tabs"] * 2),
            lambda d: d.update(matching_tab_count=5, truncated=True, reason="duplicate_conversation_tabs", matching_tabs=d["matching_tabs"] * 5),
            lambda d: d["matching_tabs"][0].update(tab_id=7, status="complete"),
        ]
        for mutate in mutations:
            state, session, payload, pending = InspectionTests().begin()
            d = self.diagnostic(); mutate(d)
            state.handle_message(session, self.error(pending, d))
            self.assertEqual(pending["result"]["error_code"], "inspection_diagnostic_shape_invalid")
            self.assertNotIn("binding_diagnostic", pending["result"])
            self.assertEqual(state.completed, {})

    def test_diagnostic_cannot_bypass_request_commit_iteration_url_or_tab_identity(self):
        for changes in ({"request_id": "11111111-1111-1111-1111-111111111111"},
                        {"expected_commit": "f" * 40}, {"iteration": 2}, {"tab_id": 8}, {"conversation_url": URL + "other"}):
            state, session, payload, pending = InspectionTests().begin()
            state.handle_message(session, self.error(pending, self.diagnostic(), **changes))
            self.assertEqual(pending["result"]["error_code"], "inspection_identity_mismatch")
            self.assertNotIn("binding_diagnostic", pending["result"])

    def test_original_failure_preserved_and_diagnostics_never_send_recover_or_allocate_nonce(self):
        state, session, payload = failed_original()
        before = copy.deepcopy(state.completed)
        with patch.object(state, "send_request_once", side_effect=AssertionError("send")), \
                patch.object(state, "recover_original_once", side_effect=AssertionError("recover")), \
                patch.object(bridge.secrets, "token_urlsafe", side_effect=AssertionError("nonce")):
            pending = state.inspect_original_once(payload, 7, REPLY)
            state.handle_message(session, self.error(pending, self.diagnostic()))
        self.assertEqual(state.completed, before)
        self.assertEqual(state.recovery_attempts, {})
        self.assertIsNone(state.pending)
        self.assertIsNone(state.recovery_pending)

    def test_line_wrapped_user_control_message_is_accepted_without_changing_raw_reply_rule(self):
        state, session, payload, pending = InspectionTests().begin()
        observation = InspectionTests().observation(pending)
        observation["candidates"][0]["user_text"] = " \n\t".join(observation["candidates"][0]["user_text"].split())
        observation["candidates"][0]["assistant_text"] = " " + REPLY + " "
        state.handle_message(session, observation)
        self.assertEqual(pending["result"]["status"], "observed_unverified")
        self.assertFalse(pending["result"]["candidates"][0]["reply_exact_observed"])

    def test_nfc_user_control_message_accepts_real_decomposed_unicode(self):
        state, session = ready_state()
        payload = validate_review_payload(sample_payload(request_id="4754374f-14dd-4004-bf87-3b87972e17fa", instruction="Caf\u00e9 fixture"))
        pending = state.inspect_original_once(payload, 7, REPLY)
        observation = InspectionTests().observation(pending)
        observation["candidates"][0]["user_text"] = observation["candidates"][0]["user_text"].replace("Caf\u00e9", "Cafe\u0301")
        state.handle_message(session, observation)
        self.assertEqual(pending["result"]["status"], "observed_unverified")


class IndependentExtensionIdentityTests(unittest.TestCase):
    candidate_id = "abcdefghijklmnopabcdefghijklmnop"

    def test_identity_and_origin_are_frozen_per_state(self):
        state = BridgeState(inspection_only=True, extension_id=self.candidate_id)
        self.assertEqual(state.startup_identity["extension_id"], self.candidate_id)
        self.assertEqual(state.extension_origin, "chrome-extension://" + self.candidate_id)
        self.assertEqual(BridgeState().startup_identity["extension_id"], bridge.EXTENSION_ID)
        self.assertTrue(state.inspection_only)

    def test_invalid_extension_ids_fail_before_token_or_state_allocation(self):
        for invalid in ("", "a" * 31, "a" * 33, "q" * 32, "A" * 32, None):
            with self.subTest(invalid=invalid), patch.object(bridge.secrets, "token_urlsafe", side_effect=AssertionError("allocated")):
                with self.assertRaisesRegex(ValueError, "extension_id_invalid"):
                    BridgeState(extension_id=invalid)

    def test_candidate_bootstrap_origin_rejects_old_extension(self):
        state = BridgeState(inspection_only=True, extension_id=self.candidate_id)
        with patch.object(bridge, "STATE", state):
            for origin, expected in ((state.extension_origin, 200), (bridge.EXTENSION_ORIGIN, 403), ("https://chatgpt.com", 403)):
                h = handler("/bootstrap", headers={"Origin": origin}); h.do_GET()
                self.assertEqual(h.responses[-1][0], expected)
            h = handler("/ws", headers={"Origin": bridge.EXTENSION_ORIGIN}); h.do_GET()
            self.assertEqual(h.responses[-1][1]["error_code"], "origin_rejected")

    def test_cli_candidate_identity_uses_mock_server_and_stays_locked(self):
        previous = bridge.STATE
        try:
            with patch.object(bridge.sys, "argv", ["bridge_server.py", "--extension-id", self.candidate_id]), \
                    patch.object(bridge, "LocalThreadingHTTPServer", return_value=Mock()), \
                    patch.object(bridge.sys, "stdout", io.StringIO()):
                self.assertEqual(bridge.main(), 0)
                self.assertEqual(bridge.STATE.startup_identity["extension_id"], self.candidate_id)
                self.assertTrue(bridge.STATE.inspection_only)
                self.assertFalse(bridge.STATE.health()["normal_sending_enabled"])
        finally:
            bridge.STATE = previous

    def test_cli_invalid_identity_creates_no_server_or_state(self):
        previous = bridge.STATE
        with patch.object(bridge.sys, "argv", ["bridge_server.py", "--extension-id", "q" * 32]), \
                patch.object(bridge, "LocalThreadingHTTPServer") as factory, \
                patch.object(bridge.sys, "stderr", io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                bridge.main()
            self.assertEqual(raised.exception.code, 2)
            factory.assert_not_called()
            self.assertIs(bridge.STATE, previous)

    def test_busy_candidate_port_aborts_without_replacing_existing_process(self):
        previous = bridge.STATE
        try:
            with patch.object(bridge.sys, "argv", ["bridge_server.py"]), \
                    patch.object(bridge, "LocalThreadingHTTPServer", side_effect=OSError("busy")) as factory, \
                    patch.object(bridge.sys, "stderr", io.StringIO()):
                self.assertEqual(bridge.main(), 2)
                factory.assert_called_once_with(("127.0.0.1", 18796), BridgeHandler)
                self.assertTrue(bridge.STATE.inspection_only)
        finally:
            bridge.STATE = previous
