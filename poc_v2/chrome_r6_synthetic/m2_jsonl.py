"""Strict bounded incremental UTF-8 JSONL artifacts; no partial successful output."""
from dataclasses import dataclass
import hashlib
import json
import math
from types import MappingProxyType

@dataclass(frozen=True)
class Failure:
    error_code: str
    raw_sha256: str
    raw_bytes_seen: int
    accepted_record_count: int
    current_record_index: int

class ReaderError(ValueError):
    def __init__(self, fingerprint):
        super().__init__(fingerprint.error_code); self._fingerprint = fingerprint
    @property
    def fingerprint(self): return self._fingerprint

@dataclass(frozen=True)
class RecordInfo:
    index: int
    payload_bytes: int
    sha256: str

@dataclass(frozen=True)
class Artifact:
    records: tuple
    record_count: int
    raw_bytes: int
    raw_sha256: str
    record_info: tuple

def freeze(value):
    if isinstance(value, dict): return MappingProxyType({k: freeze(v) for k,v in value.items()})
    if isinstance(value, list): return tuple(freeze(x) for x in value)
    return value

def strict_object(payload):
    text = payload.decode("utf-8", errors="strict")
    def pairs(items):
        result = {}
        for k,v in items:
            if k in result: raise ValueError("duplicate_key")
            result[k] = v
        return result
    def constant(_): raise ValueError("nonfinite_number")
    value = json.loads(text, object_pairs_hook=pairs, parse_constant=constant)
    if not isinstance(value, dict): raise ValueError("object_required")
    pending = [value]
    while pending:
        item = pending.pop()
        if isinstance(item, str) and any(0xD800 <= ord(c) <= 0xDFFF for c in item): raise ValueError("unicode_scalar_required")
        if isinstance(item, float) and not math.isfinite(item): raise ValueError("nonfinite_number")
        if isinstance(item, dict): pending.extend(item.keys()); pending.extend(item.values())
        elif isinstance(item, list): pending.extend(item)
    return value

class StrictJsonlReader:
    def __init__(self, *, max_record_bytes, max_records, max_total_bytes):
        if any(type(x) is not int or x < 1 for x in (max_record_bytes,max_records,max_total_bytes)): raise ValueError("positive_explicit_limits_required")
        self.max_record_bytes=max_record_bytes;self.max_records=max_records;self.max_total_bytes=max_total_bytes
        self._pending=bytearray();self._records=[];self._info=[];self._sha=hashlib.sha256();self._bytes=0
        self._state="OPEN";self._error=None;self._artifact=None
    def _fail(self, code):
        self._state="FAILED"
        self._error=ReaderError(Failure(code,self._sha.hexdigest(),self._bytes,len(self._records),len(self._records)+1))
        raise self._error
    def _check_open(self):
        if self._state=="FAILED": raise self._error
        if self._state!="OPEN": raise ValueError("feed_after_finalize")
    def feed(self, chunk):
        self._check_open()
        if type(chunk) is not bytes: self._fail("bytes_chunk_required")
        self._sha.update(chunk);self._bytes+=len(chunk)
        if self._bytes>self.max_total_bytes: self._fail("total_byte_limit")
        start=0
        while start<len(chunk):
            end=chunk.find(b"\n",start);complete=end>=0;part=chunk[start:end] if complete else chunk[start:]
            size=len(self._pending)+len(part)
            trailing_cr=part.endswith(b"\r") if part else self._pending.endswith(b"\r")
            if size-int(trailing_cr)>self.max_record_bytes: self._fail("record_byte_limit")
            self._pending.extend(part)
            if not complete: return
            payload=bytes(self._pending)
            if payload.endswith(b"\r"):payload=payload[:-1]
            self._pending.clear();start=end+1
            if not payload:self._fail("blank_record")
            if len(self._records)>=self.max_records:self._fail("record_count_limit")
            try:value=strict_object(payload)
            except UnicodeDecodeError:self._fail("invalid_utf8")
            except RecursionError:self._fail("json_depth_exceeded")
            except json.JSONDecodeError:self._fail("invalid_json")
            except ValueError as e:self._fail(str(e) if str(e) in ("duplicate_key","nonfinite_number","object_required","unicode_scalar_required") else "invalid_json")
            self._records.append(value);self._info.append(RecordInfo(len(self._records),len(payload),hashlib.sha256(payload).hexdigest()))
    def finalize(self):
        if self._state=="FAILED":raise self._error
        if self._state=="FINALIZED":return self._artifact
        if self._pending:self._fail("unfinished_final_record")
        try:self._artifact=Artifact(tuple(freeze(x) for x in self._records),len(self._records),self._bytes,self._sha.hexdigest(),tuple(self._info))
        except RecursionError:self._fail("json_depth_exceeded")
        self._state="FINALIZED";return self._artifact
