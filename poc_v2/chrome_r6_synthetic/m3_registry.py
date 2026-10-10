"""Synthetic two-workspace authority. Decisions only; never Chrome or send operations."""
import copy
import hashlib
import os
from pathlib import Path
import re
import subprocess
import threading
from m1_receipts import encoded,decoded,checked_receipt

REPO="huamuyin/codex-with-chatgpt"
REMOTES={"git@github.com:huamuyin/codex-with-chatgpt.git","https://github.com/huamuyin/codex-with-chatgpt.git"}
HEX=re.compile(r"^[a-f0-9]{40}$");UUID=re.compile(r"^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$")
ID_KEYS={"profile_id","mission_id","request_id","control_id","original_expected_commit"}
PROFILE_KEYS={"profile_id","path","repo","remote","branch","initial_head"}

def sha(v):return hashlib.sha256(encoded(v)).hexdigest()
def name(v):return isinstance(v,str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,127}",v)
def commit(v):return isinstance(v,str) and bool(HEX.fullmatch(v))
def uuid(v):return isinstance(v,str) and bool(UUID.fullmatch(v))
def positive(v):return type(v) is int and v>0
def git_snapshot(path):
    p=Path(path)
    if not p.is_absolute() or p.resolve()!=p.absolute():raise ValueError("canonical_worktree_required")
    def read(args):return subprocess.check_output(["git","-C",str(p),*args],stderr=subprocess.PIPE,timeout=10).decode("utf-8").strip()
    try:
        top=Path(read(["rev-parse","--show-toplevel"])).resolve()
        v=dict(path=str(top),repo=REPO,remote=read(["remote","get-url","origin"]),branch=read(["symbolic-ref","--short","HEAD"]),head=read(["rev-parse","HEAD"]))
    except (subprocess.SubprocessError,UnicodeError) as e:raise ValueError("local_git_snapshot_failed") from e
    if top!=p.resolve() or v["remote"] not in REMOTES or not name(v["branch"].replace("/","_")) or v["branch"]=="HEAD" or not commit(v["head"]):raise ValueError("workspace_identity_rejected")
    return v

def profiles_checked(profiles):
    if not isinstance(profiles,list) or len(profiles)!=2:raise ValueError("exactly_two_profiles_required")
    out={};paths=set();branches=set()
    for p in profiles:
        if not isinstance(p,dict) or set(p)!=PROFILE_KEYS or not name(p["profile_id"]):raise ValueError("profile_shape")
        path=Path(p["path"])
        if not path.is_absolute() or path.resolve()!=path.absolute() or path==Path(path.anchor):raise ValueError("canonical_profile_path_required")
        key=str(path.resolve()).casefold();branch=p["branch"]
        if p["repo"]!=REPO or p["remote"] not in REMOTES or not isinstance(branch,str) or not name(branch.replace("/","_")) or branch=="HEAD" or not commit(p["initial_head"]):raise ValueError("profile_identity")
        if p["profile_id"] in out or key in paths or branch.casefold() in branches:raise ValueError("duplicate_profile")
        out[p["profile_id"]]=copy.deepcopy(p);paths.add(key);branches.add(branch.casefold())
    return out

class WorkspaceMissionRegistry:
    def __init__(self,directory,profiles,*,private_root,initialize=False):
        p,root=Path(directory),Path(private_root)
        if not p.is_absolute() or not root.is_absolute() or p==root or root==Path(root.anchor) or p.resolve()!=p.absolute() or not p.resolve().is_relative_to(root.resolve()) or any((x/".git").exists() for x in [p,*p.parents]):raise ValueError("private_registry_path_required")
        self.path=p;self.profiles=profiles_checked(profiles);self.lock=threading.RLock();self.writer=None;self.poisoned=False
        if initialize:
            p.mkdir(parents=True,exist_ok=False)
            for n,b in [("owner.json",encoded(self.profiles)+b"\n"),("events.jsonl",b""),("head.json",encoded(dict(sequence=0,hash="0"*64))+b"\n"),("writer.lock",b"0")]:
                with (p/n).open("xb") as f:f.write(b);f.flush();os.fsync(f.fileno())
        try:
            self.writer=(p/"writer.lock").open("r+b");self.writer.seek(0)
            if os.name=="nt":
                import msvcrt
                msvcrt.locking(self.writer.fileno(),msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(self.writer.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
            self._load()
        except Exception:self.close();raise
    def close(self):
        if self.writer:self.writer.close();self.writer=None
    def __enter__(self):return self
    def __exit__(self,*_):self.close()
    def _identity(self,s,identity):
        if not isinstance(identity,dict) or set(identity)!=ID_KEYS:raise ValueError("mission_identity_shape")
        m=s["missions"].get(identity["mission_id"])
        if m is None or m["identity"]!=identity or m["closed"]:raise ValueError("mission_identity_changed")
        return m
    def _snapshot(self,profile,snapshot,head):
        p=self.profiles[profile]
        if not isinstance(snapshot,dict) or set(snapshot)!={"path","repo","remote","branch","head"} or any(snapshot[k]!=p[k] for k in ("path","repo","remote","branch")) or snapshot["head"]!=head:raise ValueError("workspace_snapshot_changed")
    def _apply(self,s,kind,d):
        schemas={"mission_started":ID_KEYS|{"initial_head"},"checkpoint_recorded":{"identity","previous_head","head"},"attempt_bound":{"identity","attempt_id","tab_id","url"},"attempt_failed":{"identity","attempt_id","error","uncertain"},"lifecycle_lost":{"identity","reason"},"retry_authorized":{"identity","attempt_id","authorization_id"},"retry_started":{"identity","authorization_id","attempt_id"},"recovery_decision":{"identity","decision","reason"},"reply_completed":{"identity","attempt_id","reply_sha256"},"action_receipt":{"identity","receipt"},"mission_closed":{"identity","status"}}
        if kind not in schemas or not isinstance(d,dict) or set(d)!=schemas[kind]:raise ValueError("event_schema")
        if kind=="mission_started":
            identity={k:d[k] for k in ID_KEYS};mid=identity["mission_id"]
            if identity["profile_id"] not in self.profiles or not name(mid) or not uuid(identity["request_id"]) or not uuid(identity["control_id"]) or not commit(identity["original_expected_commit"]) or d["initial_head"]!=identity["original_expected_commit"]:raise ValueError("mission_start_identity")
            if s["active"] is not None or mid in s["missions"] or any(identity[k]==m["identity"][k] for m in s["missions"].values() for k in ("request_id","control_id")):raise ValueError("mission_or_control_conflict")
            s["missions"][mid]=dict(identity=identity,checkpoint_head=d["initial_head"],attempts=[],failures=[],decisions=[],lifecycle=[],reply=None,receipt=None,closed=False,retry=None);s["active"]=mid;return
        m=self._identity(s,d["identity"])
        if kind=="checkpoint_recorded":
            if d["previous_head"]!=m["checkpoint_head"] or not commit(d["head"]):raise ValueError("checkpoint_lineage")
            m["checkpoint_head"]=d["head"]
        elif kind=="attempt_bound":
            if not positive(d["attempt_id"]) or d["attempt_id"]!=len(m["attempts"])+1 or type(d["tab_id"]) is not int or d["tab_id"]<0 or not isinstance(d["url"],str) or not re.fullmatch(r"https://chatgpt\.com/c/[A-Za-z0-9-]+",d["url"]):raise ValueError("attempt_binding")
            if d["attempt_id"]>1 and not (m["retry"] and m["retry"]["used"] and m["retry"]["next_attempt"]==d["attempt_id"]):raise ValueError("retry_not_claimed")
            if any(not other["closed"] and other is not m and any(a["tab_id"]==d["tab_id"] or a["url"]==d["url"] for a in other["attempts"]) for other in s["missions"].values()):raise ValueError("duplicate_target")
            m["attempts"].append(dict(attempt_id=d["attempt_id"],tab_id=d["tab_id"],url=d["url"],status="bound"))
            if d["attempt_id"]>1:m["retry"]=None
        elif kind=="attempt_failed":
            if not positive(d["attempt_id"]) or d["attempt_id"]>len(m["attempts"]) or not isinstance(d["error"],str) or not 1<=len(d["error"])<=128 or type(d["uncertain"]) is not bool:raise ValueError("failure_identity")
            m["failures"].append(copy.deepcopy(d))
            if m["attempts"][d["attempt_id"]-1]["status"]!="complete":m["attempts"][d["attempt_id"]-1]["status"]="uncertain" if d["uncertain"] else "failed"
        elif kind=="lifecycle_lost":
            if d["reason"] not in ("page_refresh","worker_restart","bridge_restart","controller_restart"):raise ValueError("lifecycle_reason")
            m["lifecycle"].append(d["reason"])
        elif kind=="retry_authorized":
            if not positive(d["attempt_id"]) or d["attempt_id"]!=len(m["attempts"]) or m["reply"] or m["receipt"] or not uuid(d["authorization_id"]) or m["attempts"][-1]["status"] not in ("failed","uncertain") or m["retry"] is not None:raise ValueError("retry_authority")
            m["retry"]=dict(authorization_id=d["authorization_id"],used=False,next_attempt=d["attempt_id"]+1)
        elif kind=="retry_started":
            if m["reply"] or m["receipt"] or not positive(d["attempt_id"]) or not m["retry"] or m["retry"]["used"] or d["authorization_id"]!=m["retry"]["authorization_id"] or d["attempt_id"]!=m["retry"]["next_attempt"]:raise ValueError("retry_already_claimed")
            m["retry"]["used"]=True
        elif kind=="recovery_decision":
            if d["decision"] not in ("OBSERVE_EXISTING_ATTEMPT","EXPLICIT_RETRY","SAFE_BLOCK") or not isinstance(d["reason"],str) or not 1<=len(d["reason"])<=128:raise ValueError("recovery_schema")
            m["decisions"].append(copy.deepcopy(d))
        elif kind=="reply_completed":
            if not positive(d["attempt_id"]) or d["attempt_id"]>len(m["attempts"]) or not isinstance(d["reply_sha256"],str) or not re.fullmatch(r"[a-f0-9]{64}",d["reply_sha256"]):raise ValueError("reply_identity")
            if m["reply"] and m["reply"]!=d:raise ValueError("reply_conflict")
            m["reply"]=copy.deepcopy(d);m["attempts"][d["attempt_id"]-1]["status"]="complete"
        elif kind=="action_receipt":
            checked_receipt(d["receipt"])
            if not m["reply"] or m["receipt"] and m["receipt"]!=d["receipt"]:raise ValueError("receipt_conflict")
            m["receipt"]=copy.deepcopy(d["receipt"])
        elif kind=="mission_closed":
            if d["status"] not in ("completed","failed","blocked") or d["status"]=="completed" and not (m["reply"] and m["receipt"] and m["receipt"]["status"]=="completed"):raise ValueError("closure_incomplete")
            m["closed"]=True;s["active"]=None
    def _load(self):
        if self.poisoned or self.writer is None:raise ValueError("registry_unavailable")
        if any((self.path/n).is_symlink() for n in ("owner.json","events.jsonl","head.json","writer.lock")):raise ValueError("indirect_registry")
        if decoded((self.path/"owner.json").read_bytes())!=self.profiles:raise ValueError("profile_manifest_changed")
        raw=(self.path/"events.jsonl").read_bytes()
        if raw and not raw.endswith(b"\n"):raise ValueError("truncated_journal")
        s=dict(missions={},active=None);events=[];previous="0"*64
        for i,line in enumerate(raw.splitlines(),1):
            x=decoded(line);e=x["event"]
            if set(x)!={"event","hash"} or set(e)!={"sequence","previous_hash","kind","data"} or type(e["sequence"]) is not int or e["sequence"]!=i or e["previous_hash"]!=previous or sha(e)!=x["hash"]:raise ValueError("event_chain")
            self._apply(s,e["kind"],e["data"]);previous=x["hash"];events.append(e)
        seal=decoded((self.path/"head.json").read_bytes())
        if not isinstance(seal,dict) or set(seal)!={"sequence","hash"} or type(seal["sequence"]) is not int or seal!=dict(sequence=len(events),hash=previous):raise ValueError("head_seal")
        self.state=s;self.events=events;self.head=previous
    def _append(self,kind,d):
        self._load();candidate=copy.deepcopy(self.state);self._apply(candidate,kind,d)
        e=dict(sequence=len(self.events)+1,previous_hash=self.head,kind=kind,data=d);h=sha(e)
        try:
            with (self.path/"events.jsonl").open("ab") as f:f.write(encoded(dict(event=e,hash=h))+b"\n");f.flush();os.fsync(f.fileno())
            temp=self.path/("head-"+os.urandom(12).hex()+".tmp")
            with temp.open("xb") as f:f.write(encoded(dict(sequence=e["sequence"],hash=h))+b"\n");f.flush();os.fsync(f.fileno())
            os.replace(temp,self.path/"head.json");self._load()
        except Exception:self.poisoned=True;raise
    def start(self,identity,snapshot):
        with self.lock:
            if not isinstance(identity,dict) or set(identity)!=ID_KEYS:raise ValueError("mission_identity_shape")
            self._snapshot(identity["profile_id"],snapshot,identity["original_expected_commit"]);self._append("mission_started",{**identity,"initial_head":snapshot["head"]})
    def checkpoint(self,identity,snapshot):
        with self.lock:
            self._load();m=self._identity(self.state,identity);self._snapshot(identity["profile_id"],snapshot,snapshot["head"])
            self._append("checkpoint_recorded",dict(identity=identity,previous_head=m["checkpoint_head"],head=snapshot["head"]))
    def event(self,kind,identity,**fields):
        with self.lock:
            self._load();m=self._identity(self.state,identity)
            if kind=="action_receipt" and m["receipt"]==fields.get("receipt"):return False
            self._append(kind,dict(identity=identity,**fields));return True
    def recovery(self,identity,snapshot,observation):
        with self.lock:
            self._load()
            try:
                m=self._identity(self.state,identity);self._snapshot(identity["profile_id"],snapshot,m["checkpoint_head"])
                if m["reply"] or m["receipt"] or not m["attempts"]:raise ValueError("terminal_or_unknown_attempt")
                a=m["attempts"][-1]
                expected={**identity,"attempt_id":a["attempt_id"],"tab_id":a["tab_id"],"url":a["url"]}
                if not isinstance(observation,dict) or any(observation.get(k)!=v or type(observation.get(k)) is not type(v) for k,v in expected.items()) or any(observation.get(k) is not True for k in ("authenticated","components_verified","ready","unique_target")):raise ValueError("fresh_authority_unconfirmed")
                decision="EXPLICIT_RETRY" if m["retry"] and not m["retry"]["used"] else "OBSERVE_EXISTING_ATTEMPT";reason="exact_authority"
            except (ValueError,KeyError,TypeError):decision="SAFE_BLOCK";reason="authority_or_lifecycle_unconfirmed"
            mid=identity.get("mission_id") if isinstance(identity,dict) else None
            if name(mid) and mid in self.state["missions"] and not self.state["missions"][mid]["closed"]:
                canonical=self.state["missions"][mid]["identity"];self._append("recovery_decision",dict(identity=canonical,decision=decision,reason=reason))
            return dict(decision=decision,reason=reason)
    def authorize_retry(self,identity,attempt_id,authorization_id,snapshot):
        with self.lock:
            self._load();m=self._identity(self.state,identity);self._snapshot(identity["profile_id"],snapshot,m["checkpoint_head"]);self._append("retry_authorized",dict(identity=identity,attempt_id=attempt_id,authorization_id=authorization_id))
    def claim_retry(self,identity,authorization_id,snapshot):
        with self.lock:
            self._load();m=self._identity(self.state,identity);self._snapshot(identity["profile_id"],snapshot,m["checkpoint_head"])
            if not m["retry"] or m["retry"]["used"]:return None
            n=m["retry"]["next_attempt"];self._append("retry_started",dict(identity=identity,authorization_id=authorization_id,attempt_id=n));return {**identity,"attempt_id":n}
    def export(self):
        with self.lock:self._load();return encoded(self.state)
