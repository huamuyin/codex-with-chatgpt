from dataclasses import FrozenInstanceError
import hashlib
import json
import unittest
from m2_jsonl import StrictJsonlReader,ReaderError

class JsonlTests(unittest.TestCase):
    def reader(self,**kwargs):return StrictJsonlReader(**dict(max_record_bytes=20000,max_records=20,max_total_bytes=100000,**kwargs))
    def failure(self,raw,code=None,**limits):
        r=StrictJsonlReader(max_record_bytes=limits.get('max_record_bytes',20000),max_records=limits.get('max_records',20),max_total_bytes=limits.get('max_total_bytes',100000))
        with self.assertRaises(ReaderError) as e:r.feed(raw);r.finalize()
        if code:self.assertEqual(e.exception.fingerprint.error_code,code)
        self.assertEqual(e.exception.fingerprint.raw_sha256,hashlib.sha256(raw).hexdigest());self.assertEqual(e.exception.fingerprint.raw_bytes_seen,len(raw));return r,e.exception
    def test_empty_and_empty_chunks_have_zero_records(self):
        r=self.reader();self.assertIsNone(r.feed(b''));a=r.finalize();self.assertEqual(a.record_count,0);self.assertIs(r.finalize(),a)
    def test_many_records_mixed_delimiters_and_metadata(self):
        raw=b'{"a":1}\r\n{"b":2}\n';r=self.reader();self.assertIsNone(r.feed(raw));a=r.finalize();self.assertEqual([dict(x) for x in a.records],[dict(a=1),dict(b=2)]);self.assertEqual(a.raw_bytes,len(raw));self.assertEqual(a.raw_sha256,hashlib.sha256(raw).hexdigest());self.assertEqual(a.record_info[0].payload_bytes,7)
    def test_long_unicode_every_single_split_and_byte_chunks(self):
        value={'text':'中😀é'*120,'nested':{'values':['中文',True,None,1.5]}};raw=(json.dumps(value,ensure_ascii=False)+'\r\n').encode()
        for i in range(len(raw)+1):
            r=self.reader();r.feed(raw[:i]);r.feed(raw[i:]);a=r.finalize();self.assertEqual(a.records[0]['text'],value['text']);self.assertEqual(a.raw_sha256,hashlib.sha256(raw).hexdigest())
        r=self.reader()
        for b in raw:r.feed(bytes([b]))
        self.assertEqual(r.finalize().records[0]['text'],value['text'])
    def test_split_crlf_and_valid_escaped_pair(self):
        r=self.reader();r.feed(b'{"x":"\\ud83d\\ude00"}\r');r.feed(b'\n');self.assertEqual(r.finalize().records[0]['x'],'😀')
    def test_no_unicode_normalization_and_deep_immutability(self):
        r=self.reader();r.feed('{"composed":"Café","decomposed":"Cafe\u0301","list":[{"a":1}]}\n'.encode());a=r.finalize();self.assertNotEqual(a.records[0]['composed'],a.records[0]['decomposed'])
        with self.assertRaises(TypeError):a.records[0]['composed']='changed'
        with self.assertRaises(TypeError):a.records[0]['list'][0]['a']=2
        with self.assertRaises(FrozenInstanceError):a.record_count=0
    def test_exact_boundaries_and_chunking_invariance(self):
        raw=b'{"a":1}\r\n';results=[]
        for chunks in [[raw],[raw[:-1],raw[-1:]],[bytes([b]) for b in raw]]:
            r=StrictJsonlReader(max_record_bytes=7,max_records=1,max_total_bytes=len(raw))
            for chunk in chunks:r.feed(chunk)
            results.append(r.finalize())
        self.assertEqual(results[0],results[1]);self.assertEqual(results[1],results[2])
    def test_invalid_utf8_including_split_sequence(self):
        self.failure(b'{"x":"\xff"}\n','invalid_utf8');r=self.reader();r.feed(b'{"x":"\xe4')
        with self.assertRaises(ReaderError):r.feed(b'X"}\n')
    def test_top_and_nested_duplicate_keys(self):
        for raw in [b'{"x":1,"x":2}\n',b'{"x":{"a":1,"a":2}}\n']:self.failure(raw,'duplicate_key')
    def test_nonfinite_literal_and_overflow(self):
        for raw in [b'{"x":NaN}\n',b'{"x":Infinity}\n',b'{"x":-Infinity}\n',b'{"x":1e999}\n']:self.failure(raw,'nonfinite_number')
    def test_lone_surrogates_in_values_and_keys(self):
        for raw in [b'{"x":"\\ud800"}\n',b'{"x":"\\udfff"}\n',b'{"\\ud800":1}\n']:self.failure(raw,'unicode_scalar_required')
    def test_malformed_or_nonobject(self):
        for raw in [b'{bad}\n',b'[]\n',b'"x"\n',b'1\n',b'null\n']:self.failure(raw)
    def test_blank_lf_and_crlf_rejected(self):
        for raw in [b'\n',b'\r\n']:self.failure(raw,'blank_record')
    def test_unfinished_final_record_rejected(self):self.failure(b'{"x":1}','unfinished_final_record')
    def test_every_limit_plus_one(self):
        self.failure(b'{"a":1}\n','record_byte_limit',max_record_bytes=6)
        self.failure(b'{}\n{}\n','record_count_limit',max_records=1)
        self.failure(b'{}\n','total_byte_limit',max_total_bytes=2)
    def test_oversize_pending_fails_before_delimiter(self):
        self.failure(b'x'*11,'record_byte_limit',max_record_bytes=10)
    def test_feed_after_finalize_does_not_change_result(self):
        r=self.reader();r.feed(b'{}\n');a=r.finalize()
        with self.assertRaises(ValueError):r.feed(b'{}\n')
        self.assertIs(r.finalize(),a)
    def test_sticky_error_and_whole_failing_chunk_hash(self):
        raw=b'{}\n{bad}\ntrailing bytes';r,e=self.failure(raw,'invalid_json');f=e.fingerprint
        for fn in [lambda:r.feed(b'new ignored bytes'),r.finalize]:
            with self.assertRaises(ReaderError) as later:fn()
            self.assertIs(later.exception,e);self.assertEqual(later.exception.fingerprint,f)
        with self.assertRaises(FrozenInstanceError):f.raw_bytes_seen=0
    def test_later_record_failure_never_exports_partial_artifact(self):
        r=self.reader();self.assertIsNone(r.feed(b'{}\n'))
        with self.assertRaises(ReaderError) as e:r.feed(b'[]\n')
        self.assertEqual(e.exception.fingerprint.accepted_record_count,1)
        with self.assertRaises(ReaderError):r.finalize()
    def test_invalid_limit_types_and_bytes_only(self):
        for key in ['max_record_bytes','max_records','max_total_bytes']:
            for value in [True,False,0,-1,1.5]:
                v=dict(max_record_bytes=10,max_records=10,max_total_bytes=100);v[key]=value
                with self.assertRaises(ValueError):StrictJsonlReader(**v)
        for value in ['text',bytearray(b'{}\n'),memoryview(b'{}\n')]:
            with self.assertRaises(ReaderError):self.reader().feed(value)
