"""New session entry candidate: offline only, no browser or live bridge."""
import copy
import io
import json
import os
from pathlib import Path
import unittest
import uuid

import fresh_bridge as f
import fresh_delivery as d
import fresh_review_session as entry
import test_bridge_server as fixtures


class ReviewSessionTests(unittest.TestCase):
    def setUp(self):
        root = os.environ.get("C2C_V2_TEST_DATA_ROOT")
        if not root or not Path(root).is_absolute(): raise AssertionError("explicit test data root required")
        self.root = Path(root); self.root.mkdir(parents=True, exist_ok=True)
        self.namespace = "CHROME_R6_M3_FINAL_" + uuid.uuid4().hex
        self.path = self.root / self.namespace
        self.j = d.FreshJournal(self.path, self.namespace, initialize=True)
        self.s = f.FreshState(self.j, "a" * 32, review_session_commit="a" * 40)
        self.ws = fixtures.CapturingSession(); self.s.register(self.ws)
        self.status = dict(type="fresh_status", connected=False, candidate_count=0, tab_id=None, url="",
            components={**self.s.expected_components(), "content_version":""}, review_setup_capability=entry.BUILD)
        self.s.message(self.ws, self.status)
        self.value = dict(action="create_review_session", control_token=self.s.control_token)
        self.p = f.transport.validate_review_payload(fixtures.sample_payload(task_id=entry.TASK, iteration=6, repo=entry.REPO,
            branch=entry.BRANCH, commit="a" * 40, conversation_url=""))

    def tearDown(self): self.j.close()

    def journal_bytes(self):
        return {n:(self.path/n).read_bytes() for n in ("owner.json", "events.jsonl", "head.json")}

    def begin(self):
        mid, _ = self.s.maintenance(self.value)
        return mid, self.ws.messages[-1]["grant"]

    def proof(self, grant):
        return dict(grant=copy.deepcopy(grant), tab_id=99, before_tab_ids=[7], creation_observed=True,
                    status="complete", url=entry.ROOT, pending_url="")

    def bind(self):
        mid, grant = self.begin(); proof = self.proof(grant)
        self.s.message(self.ws, dict(type="fresh_maintenance_result",maintenance_id=mid,
            action="create_review_session",complete=True,proof=proof))
        self.s.message(self.ws,{**self.status, "connected":True, "candidate_count":1,"tab_id":99,
            "url":entry.ROOT,"components":self.s.expected_components(),"review_setup_binding":self.s.review_setup.ready_proof()})
        return mid, grant, proof

    def test_disabled_old_namespace_and_nonempty_history_cannot_create(self):
        raw = self.journal_bytes()
        old = f.FreshState(self.j, "a"*32); oldws=fixtures.CapturingSession();old.register(oldws)
        with self.assertRaises(f.transport.RequestError): old.maintenance(self.value)
        self.assertEqual(raw,self.journal_bytes());self.assertFalse((self.path/"review-open-intent.json").exists())
        self.j.owner["namespace"]="CHROME_R6_20261010_092138"
        with self.assertRaises(ValueError): entry.ReviewSetup(self.j,"a"*40)
        self.j.owner["namespace"]=self.namespace
        self.j.events=[dict(kind="logical_created")]
        with self.assertRaises(ValueError): entry.ReviewSetup(self.j,"a"*40)
        self.j.events=[]

    def test_creation_intent_consumed_once_before_command_and_no_request_or_secret(self):
        raw=self.journal_bytes();mid,grant=self.begin()
        self.assertTrue((self.path/"review-open-intent.json").exists())
        self.assertEqual(self.ws.messages[-1]["action"],"create_review_session")
        self.assertNotEqual(grant["setup_id"],grant["nonce"])
        with self.assertRaises(f.transport.RequestError):self.begin()
        self.assertEqual(raw,self.journal_bytes());self.assertEqual(self.s.requests.records,{})
        self.assertFalse(self.s.ready());self.assertIsNone(self.s.active)
        self.assertFalse(self.s.control_token.encode() in (self.path/"review-open-intent.json").read_bytes())

    def test_wrong_capability_version_stale_active_and_extra_input_block_before_intent(self):
        for case in ("old_worker","mixed_version","stale","active","extra"):
            self.s.status=copy.deepcopy(self.status);self.s.seen_at=f.time.monotonic();self.s.active=None;value=dict(self.value)
            if case=="old_worker":self.s.status.pop("review_setup_capability")
            if case=="mixed_version":self.s.status["components"]["manifest_version"]="0.8.1"
            if case=="stale":self.s.seen_at-=91
            if case=="active":self.s.active={"request_id":"unknown"}
            if case=="extra":value["tab_id"]=7
            with self.subTest(case=case),self.assertRaises(f.transport.RequestError):self.s.maintenance(value)
            self.assertFalse((self.path/"review-open-intent.json").exists())

    def test_host_and_token_authentication_are_not_bypassed_by_new_action(self):
        # Exercise the unchanged real handler without opening a network port.
        raw=json.dumps({"action":"create_review_session","control_token":"wrong"}).encode()
        handler=object.__new__(f.FreshHandler);handler.state=self.s;handler.path="/maintenance"
        handler.headers={"Content-Type":"application/json","Content-Length":str(len(raw))}
        handler.rfile=io.BytesIO(raw);writes=[];handler.write=lambda code,body:writes.append((code,body))
        handler.host_ok=lambda:True;handler.do_POST();self.assertEqual(writes[-1][0],401)
        handler.host_ok=lambda:False;handler.do_POST();self.assertEqual(writes[-1][0],403)
        self.assertFalse((self.path/"review-open-intent.json").exists());self.assertEqual(self.s.requests.records,{})

    def test_wrong_nonce_commit_namespace_native_status_and_missing_ack_cannot_bind(self):
        mid,grant=self.begin();base=self.proof(grant);raw=self.journal_bytes()
        for case in ("nonce","commit","namespace","old_tab","bool_tab","loading_unknown","pending_other","null"):
            p=copy.deepcopy(base)
            if case in ("nonce","commit","namespace"):p["grant"][{"nonce":"nonce","commit":"review_commit","namespace":"namespace"}[case]]="wrong"
            if case=="old_tab":p["tab_id"]=7
            if case=="bool_tab":p["tab_id"]=True
            if case=="loading_unknown":p["status"]="unknown"
            if case=="pending_other":p["pending_url"]="https://chatgpt.com/c/other"
            if case=="null":p=None
            with self.subTest(case=case),self.assertRaises((ValueError,TypeError)):self.s.review_setup.bind(p)
            self.assertFalse((self.path/"review-native-binding.json").exists())
        self.s.message(self.ws,dict(type="fresh_maintenance_result",maintenance_id=mid,
            action="create_review_session",complete=True,proof=None))
        self.assertEqual(self.s.maintenance_commands[mid]["result"]["status"],"failed")
        self.assertEqual(raw,self.journal_bytes());self.assertFalse(self.s.ready())

    def test_duplicate_late_binding_and_restart_never_create_or_change_journal(self):
        raw=self.journal_bytes();mid,grant,proof=self.bind();self.assertTrue(self.s.ready())
        b=(self.path/"review-native-binding.json").read_bytes()
        self.s.message(self.ws,dict(type="fresh_maintenance_result",maintenance_id=mid,
            action="create_review_session",complete=True,proof={**proof,"tab_id":100}))
        self.assertEqual((self.path/"review-native-binding.json").read_bytes(),b)
        restored=f.FreshState(self.j,"a"*32,review_session_commit="a"*40);ws=fixtures.CapturingSession();welcome=restored.register(ws)
        self.assertEqual(welcome["review_session_setup"]["binding"]["tab_id"],99);self.assertEqual(ws.messages,[])
        self.assertFalse(restored.ready());self.assertEqual(raw,self.journal_bytes())
        with self.assertRaises(ValueError):entry.ReviewSetup(self.j,"b"*40)

    def test_interrupted_intent_restart_is_blocked_not_replayed(self):
        self.begin();raw=self.journal_bytes();restored=f.FreshState(self.j,"a"*32,review_session_commit="a"*40)
        ws=fixtures.CapturingSession();restored.register(ws);restored.message(ws,self.status)
        with self.assertRaises(f.transport.RequestError):restored.maintenance(self.value)
        self.assertFalse(restored.ready());self.assertEqual(ws.messages,[]);self.assertEqual(raw,self.journal_bytes())

    def test_ready_requires_exact_setup_nonce_native_and_component_proof(self):
        self.bind();base=copy.deepcopy(self.s.status)
        for case in ("nonce","native","missing","old_content","extra_binding"):
            self.s.status=copy.deepcopy(base)
            if case=="nonce":self.s.status["review_setup_binding"]["nonce"]=str(uuid.uuid4())
            if case=="native":self.s.status["tab_id"]=7
            if case=="missing":self.s.status.pop("review_setup_binding")
            if case=="old_content":self.s.status["components"]["content_version"]="0.8.1"
            if case=="extra_binding":self.s.status["review_setup_binding"]["other"]=True
            with self.subTest(case=case):self.assertFalse(self.s.ready())
        self.s.status=base;self.assertTrue(self.s.ready())

    def test_one_new_logical_review_only_and_uncertainty_does_not_allow_resend(self):
        self.bind();raw=self.journal_bytes()
        for k,value in (("task_id","M4"),("commit","b"*40),("iteration",7),("branch","other"),("repo","other")):
            with self.subTest(field=k),self.assertRaises(f.transport.RequestError):self.s.send({**self.p,k:value})
            self.assertEqual(raw,self.journal_bytes())
        r=self.s.send(self.p);self.assertEqual(r["attempts"][0]["tab_id"],99)
        self.assertIn("NONCE: "+r["control_id"],r["attempts"][0]["wire_message"])
        self.s.timeout(r["request_id"],1);after=self.journal_bytes()
        with self.assertRaises(f.transport.RequestError):self.s.send({**self.p,"request_id":r["request_id"]},retry=True,control_id=r["control_id"])
        with self.assertRaises(f.transport.RequestError):self.s.send(self.p)
        self.assertEqual(after,self.journal_bytes());self.assertEqual(len(self.s.requests.records),1)
        self.assertEqual(len(self.s.poll({**self.p,"request_id":r["request_id"]},r["control_id"])["attempts"]),1)

    def test_truncated_or_replaced_setup_records_fail_closed_without_repair(self):
        self.bind();p=self.path/"review-open-intent.json";original=p.read_bytes();changed=json.loads(original);changed["nonce"]=str(uuid.uuid4());p.write_bytes(d.encoded(changed)+b"\n")
        with self.assertRaises(ValueError):entry.ReviewSetup(self.j,"a"*40)
        self.assertEqual(p.read_bytes(),d.encoded(changed)+b"\n")
        p.write_bytes(b'{"schema":');before=p.read_bytes()
        with self.assertRaises(ValueError):entry.ReviewSetup(self.j,"a"*40)
        self.assertEqual(p.read_bytes(),before)

    def test_z_emit_cross_language_fixture_without_credentials(self):
        mid,grant,proof=self.bind();v=dict(scope=self.s.review_setup.scope(),grant=grant,proof=proof,
            bridge_identity=self.s.identity,empty_checkpoint=self.s.requests.checkpoint())
        raw=d.encoded(v);self.assertFalse(self.s.control_token.encode() in raw)
        (self.root/"new-review-session-cross-language.json").write_bytes(raw+b"\n")
