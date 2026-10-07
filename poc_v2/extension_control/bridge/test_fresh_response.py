import json
import unittest
from fresh_response import ResponseError, parse_response, validate_response


class ResponseTests(unittest.TestCase):
    def setUp(self):
        self.reply = {"STATE": "REVIEW_RESULT", "ROUND": 1, "REQUEST_ID": "request", "CONTROL_ID": "control",
                      "ATTEMPT_ID": 2, "REVIEWED_COMMIT": "a" * 40, "VERDICT": "PASS_CONTINUE", "FINDINGS": []}
        self.context = dict(round_no=1, request_id="request", control_id="control", attempt_id=2, commit="a" * 40)

    def test_fence_and_recognized_renderer_label_preserve_json_strings(self):
        self.reply["excerpt"] = 'quoted "value"\nnext line \\ literal'
        raw = json.dumps(self.reply)
        for text in ("```json\n" + raw + "\n```", "JSON\n" + raw, "json\n" + raw):
            self.assertEqual(parse_response(text), self.reply)
            self.assertEqual(validate_response(parse_response(text), **self.context), self.reply)

    def test_malformed_json_never_guessed_or_repaired(self):
        raw = "```json\n" + json.dumps(self.reply)[:-1] + "\n```"
        with self.assertRaisesRegex(ResponseError, "response_json_invalid"): parse_response(raw)

    def test_naked_json_and_unknown_language_or_prose_rejected(self):
        raw = json.dumps(self.reply)
        for text in (raw, "```python\n" + raw + "\n```", "prose\n```json\n" + raw + "\n```", "Jsonish\n" + raw,
                     "```json\n" + raw + "\n```\n```json\n{}\n```"):
            with self.subTest(text=text), self.assertRaises(ResponseError): parse_response(text)

    def test_duplicate_keys_nonfinite_and_multiple_objects_rejected(self):
        for raw in ('{"a":1,"a":2}', '{"a":NaN}', '{} {}', '[]'):
            with self.subTest(raw=raw), self.assertRaises(ResponseError): parse_response("JSON\n" + raw)

    def test_wrong_identity_and_boolean_numbers_rejected(self):
        for key, value in (("REQUEST_ID", "wrong"), ("CONTROL_ID", "wrong"), ("ATTEMPT_ID", 99),
                           ("REVIEWED_COMMIT", "b" * 40), ("ROUND", 2), ("ROUND", True), ("ATTEMPT_ID", True)):
            with self.subTest(key=key), self.assertRaises(ResponseError): validate_response({**self.reply, key: value}, **self.context)

    def test_verdict_and_findings_must_be_explicit(self):
        for change in ({"VERDICT": "PASS"}, {"FINDINGS": "none"}):
            with self.assertRaises(ResponseError): validate_response({**self.reply, **change}, **self.context)
