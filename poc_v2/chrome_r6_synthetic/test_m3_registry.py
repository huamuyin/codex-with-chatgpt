import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
import uuid
from unittest.mock import patch
from m3_registry import WorkspaceMissionRegistry,profiles_checked,git_snapshot,encoded

class RegistryTests(unittest.TestCase):
    def setUp(self):
        raw=os.environ.get('C2C_V2_TEST_DATA_ROOT')
        if not raw or not Path(raw).is_absolute():raise AssertionError('explicit private mock root required')
        self.root=Path(raw);self.path=self.root/('m3-'+uuid.uuid4().hex)
        self.profiles=[dict(profile_id=k,path=str((self.root/k).resolve()),repo='huamuyin/codex-with-chatgpt',remote='git@github.com:huamuyin/codex-with-chatgpt.git',branch='codex/mock-'+k,initial_head='a'*40) for k in ['A','B']]
        self.r=WorkspaceMissionRegistry(self.path,self.profiles,private_root=self.root,initialize=True)
        self.i=dict(profile_id='A',mission_id='MOCK_A',request_id=str(uuid.uuid4()),control_id=str(uuid.uuid4()),original_expected_commit='a'*40)
    def tearDown(self):self.r.close()
    def snapshot(self,profile='A',head='a'*40):
        p=next(x for x in self.profiles if x['profile_id']==profile);return {**{k:p[k] for k in ['path','repo','remote','branch']},'head':head}
    def start(self):self.r.start(self.i,self.snapshot())
    def bind(self):self.start();self.r.event('attempt_bound',self.i,attempt_id=1,tab_id=7,url='https://chatgpt.com/c/mock-a')
    def observe(self):return {**self.i,'attempt_id':1,'tab_id':7,'url':'https://chatgpt.com/c/mock-a','authenticated':True,'components_verified':True,'ready':True,'unique_target':True}
    def files(self):return {p.name:p.read_bytes() for p in self.path.iterdir() if p.is_file() and p.name!='writer.lock'}
    def reopen(self):self.r.close();self.r=WorkspaceMissionRegistry(self.path,self.profiles,private_root=self.root)
    def complete(self):
        self.r.event('reply_completed',self.i,attempt_id=1,reply_sha256='b'*64)
        self.receipt=dict(action_id='c'*64,status='completed',result_sha256='d'*64,summary='synthetic only')
        self.r.event('action_receipt',self.i,receipt=self.receipt);self.r.event('mission_closed',self.i,status='completed')
    def test_two_profiles_reopen_byte_stable_without_operations(self):
        self.bind();self.r.event('lifecycle_lost',self.i,reason='bridge_restart');before=self.files();state=self.r.export()
        with patch('m3_registry.subprocess.check_output',side_effect=AssertionError('restore must not call Git')):self.reopen();self.assertEqual(self.r.export(),state)
        self.assertEqual(self.files(),before)
    def test_checkpoint_progress_preserves_original_commit_and_unknown_head_blocks(self):
        self.bind();self.assertEqual(self.r.recovery(self.i,self.snapshot(head='b'*40),self.observe())['decision'],'SAFE_BLOCK')
        self.r.checkpoint(self.i,self.snapshot(head='b'*40));self.assertEqual(self.r.recovery(self.i,self.snapshot(head='b'*40),self.observe())['decision'],'OBSERVE_EXISTING_ATTEMPT')
        m=json.loads(self.r.export())['missions']['MOCK_A'];self.assertEqual(m['identity']['original_expected_commit'],'a'*40);self.assertEqual(m['checkpoint_head'],'b'*40)
    def test_retry_authorized_once_and_restore_never_regrants(self):
        self.bind();self.r.event('attempt_failed',self.i,attempt_id=1,error='timeout',uncertain=True);ticket=str(uuid.uuid4())
        self.r.authorize_retry(self.i,1,ticket,self.snapshot());self.assertEqual(self.r.recovery(self.i,self.snapshot(),self.observe())['decision'],'EXPLICIT_RETRY')
        directive=self.r.claim_retry(self.i,ticket,self.snapshot());self.assertEqual(directive,{**self.i,'attempt_id':2});self.reopen();self.assertIsNone(self.r.claim_retry(self.i,ticket,self.snapshot()))
        self.r.event('attempt_bound',self.i,attempt_id=2,tab_id=7,url='https://chatgpt.com/c/mock-a')
    def test_complete_a_then_switch_b_and_keep_terminal_history(self):
        self.bind();self.complete();other=dict(profile_id='B',mission_id='MOCK_B',request_id=str(uuid.uuid4()),control_id=str(uuid.uuid4()),original_expected_commit='a'*40)
        self.r.start(other,self.snapshot('B'));s=json.loads(self.r.export());self.assertTrue(s['missions']['MOCK_A']['closed']);self.assertEqual(s['active'],'MOCK_B')
    def test_third_duplicate_paths_branches_wrong_remote_and_detached_profiles(self):
        values=[self.profiles+[copy.deepcopy(self.profiles[0])]]
        for k,v in [('path',self.profiles[0]['path']),('branch',self.profiles[0]['branch']),('repo','foreign/repo'),('remote','https://user:password@github.com/huamuyin/codex-with-chatgpt.git'),('branch','HEAD')]:
            x=copy.deepcopy(self.profiles);x[1][k]=v;values.append(x)
        x=copy.deepcopy(self.profiles);x[1]['path']=x[0]['path'].upper();values.append(x)
        for p in values:
            with self.assertRaises(ValueError):profiles_checked(p)
    def test_activation_requires_exact_initial_head_remote_path_branch(self):
        for k,v in [('path','wrong'),('repo','foreign/repo'),('remote','https://other.test/repo'),('branch','codex/other'),('head','b'*40)]:
            with self.assertRaises(ValueError):self.r.start(self.i,{**self.snapshot(),k:v})
        self.assertEqual(json.loads(self.r.export())['missions'],{})
    def test_second_active_mission_or_reused_global_ids_rejected(self):
        self.bind();other={**self.i,'profile_id':'B','mission_id':'MOCK_B'}
        with self.assertRaises(ValueError):self.r.start(other,self.snapshot('B'))
        self.complete()
        with self.assertRaises(ValueError):self.r.start(other,self.snapshot('B'))
    def test_wrong_logical_binding_and_current_head_substitution_rejected(self):
        self.bind();before=self.files()
        for k,v in [('profile_id','B'),('mission_id','OTHER'),('request_id',str(uuid.uuid4())),('control_id',str(uuid.uuid4())),('original_expected_commit','b'*40)]:
            with self.assertRaises(ValueError):self.r.event('reply_completed',{**self.i,k:v},attempt_id=1,reply_sha256='f'*64)
            self.assertEqual(self.files(),before)
    def test_bad_attempt_boolean_sequence_target_and_cross_profile_observation(self):
        self.start()
        for aid in [True,0,2]:
            with self.assertRaises(ValueError):self.r.event('attempt_bound',self.i,attempt_id=aid,tab_id=7,url='https://chatgpt.com/c/mock-a')
        self.r.event('attempt_bound',self.i,attempt_id=1,tab_id=7,url='https://chatgpt.com/c/mock-a')
        for change in [dict(profile_id='B'),dict(control_id=str(uuid.uuid4())),dict(attempt_id=True),dict(tab_id=8),dict(unique_target=False),dict(components_verified=False),dict(authenticated=False)]:
            self.assertEqual(self.r.recovery(self.i,self.snapshot(),{**self.observe(),**change})['decision'],'SAFE_BLOCK')
    def test_retry_without_authority_completed_or_wrong_authorization_rejected(self):
        self.bind();self.assertIsNone(self.r.claim_retry(self.i,str(uuid.uuid4()),self.snapshot()))
        with self.assertRaises(ValueError):self.r.authorize_retry(self.i,1,str(uuid.uuid4()),self.snapshot())
        self.r.event('attempt_failed',self.i,attempt_id=1,error='timeout',uncertain=False);ticket=str(uuid.uuid4());self.r.authorize_retry(self.i,1,ticket,self.snapshot())
        with self.assertRaises(ValueError):self.r.claim_retry(self.i,str(uuid.uuid4()),self.snapshot())
        self.r.event('reply_completed',self.i,attempt_id=1,reply_sha256='f'*64)
        with self.assertRaises(ValueError):self.r.claim_retry(self.i,ticket,self.snapshot())
        with self.assertRaises(ValueError):self.r.authorize_retry(self.i,1,str(uuid.uuid4()),self.snapshot())
    def test_conflicting_receipt_and_late_failure_preserve_completed_attempt(self):
        self.bind();self.r.event('reply_completed',self.i,attempt_id=1,reply_sha256='f'*64);r=dict(action_id='c'*64,status='completed',result_sha256='d'*64,summary='fixture')
        self.r.event('action_receipt',self.i,receipt=r);before=self.files();self.assertFalse(self.r.event('action_receipt',self.i,receipt=r));self.assertEqual(self.files(),before)
        with self.assertRaises(ValueError):self.r.event('action_receipt',self.i,receipt={**r,'status':'failed'})
        self.r.event('attempt_failed',self.i,attempt_id=1,error='late timeout',uncertain=False);s=json.loads(self.r.export())['missions']['MOCK_A'];self.assertEqual(s['attempts'][0]['status'],'complete');self.assertEqual(s['receipt'],r)
    def test_second_writer_in_process_and_real_child_cannot_acquire_lock(self):
        with self.assertRaises(OSError):WorkspaceMissionRegistry(self.path,self.profiles,private_root=self.root)
        code="import json,sys;from m3_registry import WorkspaceMissionRegistry\ntry: WorkspaceMissionRegistry(sys.argv[1],json.loads(sys.argv[2]),private_root=sys.argv[3])\nexcept OSError: sys.exit(23)\nsys.exit(1)"
        r=subprocess.run([sys.executable,'-B','-c',code,str(self.path),json.dumps(self.profiles),str(self.root)],cwd=Path(__file__).parent,capture_output=True)
        self.assertEqual(r.returncode,23,r.stderr.decode('utf-8','replace'))
    def test_corrupt_head_hash_or_truncation_fail_closed_without_rewriting(self):
        self.bind();self.r.close();valid=self.files()
        for n,b in [('head.json',encoded(dict(sequence=999,hash='0'*64))+b'\n'),('events.jsonl',valid['events.jsonl'][:-1]),('events.jsonl',valid['events.jsonl'].replace(b'mission_started',b'mission_Xtarted'))]:
            for key,raw in valid.items():(self.path/key).write_bytes(raw)
            (self.path/n).write_bytes(b);before=self.files()
            with self.assertRaises(ValueError):WorkspaceMissionRegistry(self.path,self.profiles,private_root=self.root)
            self.assertEqual(self.files(),before)
    def test_git_adapter_only_local_argv_and_exact_canonical_facts(self):
        p=Path(self.profiles[0]['path']);values=[str(p).encode(),b'git@github.com:huamuyin/codex-with-chatgpt.git',b'codex/mock-A',b'a'*40]
        with patch('m3_registry.subprocess.check_output',side_effect=values) as mocked:
            self.assertEqual(git_snapshot(p)['head'],'a'*40)
            for call in mocked.call_args_list:self.assertEqual(call.args[0][:3],['git','-C',str(p)]);self.assertNotIn('shell',call.kwargs)
    def test_restore_invokes_no_git_mutation_or_send_callback(self):
        self.bind();before=self.files();self.r.close()
        with patch('m3_registry.subprocess.check_output',side_effect=AssertionError('no Git on restore')):
            self.r=WorkspaceMissionRegistry(self.path,self.profiles,private_root=self.root);self.assertEqual(self.files(),before)
        self.assertFalse(any(e['kind']=='retry_started' for e in self.r.events))

    def test_single_event_head_boolean_is_not_integer_sequence(self):
        self.start();self.r.close();head=json.loads((self.path/'head.json').read_bytes());self.assertEqual(head['sequence'],1)
        head['sequence']=True;(self.path/'head.json').write_bytes(encoded(head)+b'\n');before=self.files()
        with self.assertRaises(ValueError):WorkspaceMissionRegistry(self.path,self.profiles,private_root=self.root)
        self.assertEqual(self.files(),before)
