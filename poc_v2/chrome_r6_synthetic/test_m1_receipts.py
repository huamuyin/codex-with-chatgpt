import copy
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import threading
import unittest
import uuid
from m1_receipts import ReceiptLedger, decoded, encoded

class ReceiptTests(unittest.TestCase):
    def setUp(self):
        value = os.environ.get("C2C_V2_TEST_DATA_ROOT")
        if not value or not Path(value).is_absolute(): raise AssertionError("explicit synthetic test root required")
        self.root = Path(value); self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / ("m1-" + uuid.uuid4().hex)
        self.context = dict(mission_id="R6_M1",workspace_id="R6_A",round_no=1,request_id=str(uuid.uuid4()),control_id=str(uuid.uuid4()),reviewed_commit="a"*40)
        self.l = ReceiptLedger(self.path,self.context,private_root=self.root,initialize=True)
    def review(self, attempt=1):
        c=self.context
        return dict(STATE="REVIEW_RESULT",ROUND=c["round_no"],REQUEST_ID=c["request_id"],CONTROL_ID=c["control_id"],ATTEMPT_ID=attempt,REVIEWED_COMMIT=c["reviewed_commit"],VERDICT="PASS_CONTINUE",FINDINGS=[],REVIEW_SUMMARY="Synthetic 中文 café 😀",GITHUB_RESOURCES_READ=[dict(path="fixture.py",ref_commit="a"*40,github_url="https://github.com/huamuyin/codex-with-chatgpt/blob/"+"a"*40+"/fixture.py",read_method="GitHub mock fixture",source_excerpt="synthetic only")],NEXT_CODEX_INSTRUCTION="Run one synthetic test.")
    def raw(self,v=None):return "```json\n"+json.dumps(v or self.review(),ensure_ascii=False)+"\n```"
    def canonical(self):self.l.open_attempt(1);self.l.accept_review(self.raw(),1);return json.loads(self.l.export())["canonical"]["action_id"]
    def receipt(self,action):return dict(action_id=action,status="completed",result_sha256="b"*64,summary="synthetic action only")
    def files(self):return {p.name:p.read_bytes() for p in self.path.iterdir() if p.is_file()}
    def test_export_reopen_and_unicode_are_byte_identical(self):
        self.canonical();before=self.files();state=self.l.export();l=ReceiptLedger(self.path,self.context,private_root=self.root)
        self.assertEqual(l.export(),state);self.assertEqual(self.files(),before);self.assertIn("中文".encode(),state);self.assertIn("😀".encode(),state)
    def test_first_review_atomically_reserves_one_action(self):
        a=self.canonical();s=json.loads(self.l.export());self.assertEqual(len([x for x in self.l.events if x['kind']=='canonical_review']),1)
        self.assertEqual(s['canonical']['action_id'],a);self.assertEqual(s['canonical']['instruction'],self.review()['NEXT_CODEX_INSTRUCTION'])
    def test_timeout_uncertain_history_retained_when_late_same_attempt_completes(self):
        self.l.open_attempt(1);self.l.failure(1,"timeout");self.l.failure(1,"delivery_uncertain",uncertain=True);prefix=(self.path/'events.jsonl').read_bytes()
        self.l.accept_review(self.raw(),1);self.assertTrue((self.path/'events.jsonl').read_bytes().startswith(prefix));self.assertEqual(len(json.loads(self.l.export())['history']),2)
    def test_cross_attempt_duplicates_exclude_only_attempt_id(self):
        a=self.canonical();self.l.open_attempt(2);self.assertEqual(self.l.accept_review(self.raw(self.review(2)),2),'duplicate');self.assertEqual(json.loads(self.l.export())['canonical']['action_id'],a)
    def test_claim_once_and_exact_receipt_replay_after_restore(self):
        a=self.canonical();self.assertEqual(self.l.claim_action(a),self.review()['NEXT_CODEX_INSTRUCTION']);self.assertIsNone(self.l.claim_action(a))
        receipt=self.receipt(a);self.assertTrue(self.l.record_action_receipt(receipt));before=self.files();self.assertFalse(self.l.record_action_receipt(receipt));self.assertEqual(before,self.files())
        l=ReceiptLedger(self.path,self.context,private_root=self.root);self.assertIsNone(l.claim_action(a));self.assertEqual(l.accept_review(self.raw(),1),'duplicate')
    def test_action_started_without_receipt_never_yields_after_restore(self):
        a=self.canonical();self.l.claim_action(a);l=ReceiptLedger(self.path,self.context,private_root=self.root);self.assertIsNone(l.claim_action(a))
    def test_invalid_context_binding_or_boolean_round_is_rejected(self):
        for k,v in [('mission_id','Other'),('workspace_id','Other'),('round_no',2),('request_id',str(uuid.uuid4())),('control_id',str(uuid.uuid4())),('reviewed_commit','b'*40),('round_no',True)]:
            with self.subTest(k=k),self.assertRaises(ValueError):ReceiptLedger(self.path,{**self.context,k:v},private_root=self.root)
    def test_unknown_boolean_or_repeated_attempt_rejected_without_append(self):
        self.l.open_attempt(1);before=self.files()
        for n in [1,True,0,3,-1]:
            with self.subTest(n=n),self.assertRaises(ValueError):self.l.open_attempt(n)
            self.assertEqual(self.files(),before)
        for n in [True,2,999]:
            with self.assertRaises(ValueError):self.l.accept_review(self.raw(self.review(n)),n)
            self.assertEqual(self.files(),before)
    def test_unopened_attempt_result_or_failure_rejected(self):
        before=self.files()
        with self.assertRaises(ValueError):self.l.accept_review(self.raw(),1)
        with self.assertRaises(ValueError):self.l.failure(1,'timeout')
        self.assertEqual(self.files(),before)
    def test_wrong_reply_identity_does_not_reserve_action(self):
        self.l.open_attempt(1);before=self.files()
        for k,v in [('ROUND',2),('REQUEST_ID',str(uuid.uuid4())),('CONTROL_ID',str(uuid.uuid4())),('REVIEWED_COMMIT','b'*40),('ATTEMPT_ID',2)]:
            with self.subTest(k=k),self.assertRaises(ValueError):self.l.accept_review(self.raw({**self.review(),k:v}),1)
            self.assertEqual(self.files(),before)
    def test_every_substantive_changed_canonical_field_is_rejected(self):
        self.canonical();before=self.files()
        changes=dict(VERDICT='CHANGES_REQUIRED',FINDINGS=[dict(finding='different')],REVIEW_SUMMARY='different',NEXT_CODEX_INSTRUCTION='different test')
        for k,v in changes.items():
            with self.subTest(k=k),self.assertRaises(ValueError):self.l.accept_review(self.raw({**self.review(),k:v}),1)
            self.assertEqual(self.files(),before)
        v=self.review();v['GITHUB_RESOURCES_READ'][0]['source_excerpt']='different'
        with self.assertRaises(ValueError):self.l.accept_review(self.raw(v),1)
    def test_malformed_frame_oversized_instruction_and_credential_field_rejected(self):
        self.l.open_attempt(1);before=self.files()
        for raw in ['{}','```json\n{bad}\n```',self.raw({**self.review(),"NEXT_CODEX_INSTRUCTION":"x"*4097}),self.raw({**self.review(),'control_token':'synthetic forbidden'})]:
            with self.assertRaises(ValueError):self.l.accept_review(raw,1)
            self.assertEqual(self.files(),before)
    def test_strict_json_duplicate_nonfinite_surrogate_and_secret_keys(self):
        for raw in ['{"a":1,"a":2}','{"n":NaN}','{"x":"\\ud800"}','{"cookies":"synthetic"}']:
            with self.assertRaises(ValueError):decoded(raw)
        with self.assertRaises(ValueError):encoded(dict(n=float('inf')))
    def test_conflicting_or_unclaimed_receipt_unknown_action_rejected(self):
        a=self.canonical()
        with self.assertRaises(ValueError):self.l.claim_action('x'*64)
        with self.assertRaises(ValueError):self.l.record_action_receipt(self.receipt(a))
        self.l.claim_action(a);self.l.record_action_receipt(self.receipt(a));before=self.files()
        with self.assertRaises(ValueError):self.l.record_action_receipt({**self.receipt(a),'status':'blocked'})
        self.assertEqual(self.files(),before)
    def test_thread_race_reserves_and_claims_one_action(self):
        self.l.open_attempt(1);barrier=threading.Barrier(8)
        def accept(_):barrier.wait();return self.l.accept_review(self.raw(),1)
        with ThreadPoolExecutor(8) as ex:values=list(ex.map(accept,range(8)))
        self.assertEqual(values.count('canonical'),1);self.assertEqual(values.count('duplicate'),7)
        a=json.loads(self.l.export())['canonical']['action_id']
        with ThreadPoolExecutor(8) as ex:values=list(ex.map(lambda _:self.l.claim_action(a),range(8)))
        self.assertEqual(sum(v is not None for v in values),1)
    def test_hash_head_or_truncated_tail_fail_closed_and_preserve_corruption(self):
        self.canonical();valid=self.files()
        for name,raw in [('events.jsonl',valid['events.jsonl'][:-1]),('events.jsonl',valid['events.jsonl'].replace(b'canonical_review',b'canonical_Xeview')),('head.json',encoded(dict(sequence=999,hash='0'*64))+b'\n')]:
            for n,b in valid.items():(self.path/n).write_bytes(b)
            (self.path/name).write_bytes(raw);before=self.files()
            with self.assertRaises(ValueError):ReceiptLedger(self.path,self.context,private_root=self.root)
            self.assertEqual(self.files(),before)
    def test_explicit_private_root_and_no_repository_or_drive_root_output(self):
        bad=[(None,self.root),(Path('relative'),self.root),(self.root,self.root),(Path(self.path.anchor),self.root),(self.path,Path(self.path.anchor)),(Path(__file__).resolve().parent/'never-created',Path(__file__).resolve().parent)]
        for p,root in bad:
            with self.subTest(path=str(p)),self.assertRaises(ValueError):ReceiptLedger(p,self.context,private_root=root)
    def test_no_credentials_in_durable_records(self):
        self.canonical()
        for raw in self.files().values():
            self.assertNotIn(b'control_token',raw);self.assertNotIn(b'cookies',raw);self.assertNotIn(b'authorization',raw)

    def semantic_rewrite(self, kind, mutate):
        envelopes=[json.loads(x) for x in (self.path/'events.jsonl').read_bytes().splitlines()]
        target=next(x['event']['data'] for x in envelopes if x['event']['kind']==kind);mutate(target)
        previous='0'*64;rows=[]
        for x in envelopes:
            e=x['event'];e['previous_hash']=previous;previous=hashlib.sha256(encoded(e)).hexdigest();rows.append(encoded(dict(event=e,hash=previous))+b'\n')
        (self.path/'events.jsonl').write_bytes(b''.join(rows));(self.path/'head.json').write_bytes(encoded(dict(sequence=len(rows),hash=previous))+b'\n')
        corrupted=self.files()
        with self.assertRaises(ValueError):ReceiptLedger(self.path,self.context,private_root=self.root)
        self.assertEqual(self.files(),corrupted)

    def test_recomputed_canonical_boolean_extra_identity_and_instruction_fail_closed(self):
        self.canonical();valid=self.files()
        mutations=[lambda d:d.update(canonical_attempt_id=True),lambda d:d.update(extra='unknown')]
        for k,v in [('ROUND',2),('CONTROL_ID',str(uuid.uuid4())),('REQUEST_ID',str(uuid.uuid4())),('REVIEWED_COMMIT','b'*40)]:
            def change(d,k=k,v=v):
                d['review'][k]=v;d['review_hash']=hashlib.sha256(encoded(d['review'])).hexdigest();d['action_id']=hashlib.sha256(encoded(dict(context=self.context,review_hash=d['review_hash']))).hexdigest()
            mutations.append(change)
        def wrong_instruction(d):d['instruction']='different executable action';d['instruction_hash']=hashlib.sha256(d['instruction'].encode()).hexdigest()
        mutations.append(wrong_instruction)
        for change in mutations:
            for n,b in valid.items():(self.path/n).write_bytes(b)
            self.semantic_rewrite('canonical_review',change)

    def test_recomputed_duplicate_boolean_and_extra_field_fail_closed(self):
        self.canonical();self.l.accept_review(self.raw(),1);valid=self.files()
        for change in [lambda d:d.update(attempt_id=True),lambda d:d.update(extra='unknown')]:
            for n,b in valid.items():(self.path/n).write_bytes(b)
            self.semantic_rewrite('duplicate_review',change)

    def test_recomputed_receipt_bad_status_hash_summary_and_extra_fail_closed(self):
        a=self.canonical();self.l.claim_action(a);self.l.record_action_receipt(self.receipt(a));valid=self.files()
        for field,value in [('status','unknown'),('result_sha256','bad'),('summary',''),('summary','x'*513),('summary',True),('extra','unknown')]:
            for n,b in valid.items():(self.path/n).write_bytes(b)
            self.semantic_rewrite('action_receipt',lambda d,field=field,value=value:d.update({field:value}))
