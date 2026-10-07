import json
import unittest
from fresh_response import ResponseError, parse_response, validate_response


class ResponseTests(unittest.TestCase):
    def setUp(self):
        self.reply = {"STATE": "REVIEW_RESULT", "ROUND": 1, "REQUEST_ID": "request", "CONTROL_ID": "control",
                      "ATTEMPT_ID": 2, "REVIEWED_COMMIT": "a" * 40, "VERDICT": "PASS_CONTINUE", "FINDINGS": [],
                      "REVIEW_SUMMARY": "Inspected the exact evidence.", "GITHUB_RESOURCES_READ": [
                          {"path": "fixture.json", "ref_commit": "a" * 40, "github_url": "https://github.com/owner/repo/blob/" + "a" * 40 + "/fixture.json",
                           "read_method": "GitHub offline fixture", "source_excerpt": "A complete synthetic resource."}],
                      "NEXT_CODEX_INSTRUCTION": "Run one bounded Fresh evidence check."}
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

    def test_missing_required_control_fields_rejected_in_an_otherwise_valid_frame(self):
        for key in ("REVIEW_SUMMARY", "GITHUB_RESOURCES_READ", "NEXT_CODEX_INSTRUCTION"):
            value = {k:v for k,v in self.reply.items() if k != key}
            with self.subTest(key=key), self.assertRaises(ResponseError):
                validate_response(parse_response("```json\n" + json.dumps(value) + "\n```"), **self.context)

    def test_mistyped_empty_and_unbounded_required_control_fields_rejected(self):
        cases = [("REVIEW_SUMMARY", value) for value in (None, False, 1, [], "", " \n")]
        cases += [("GITHUB_RESOURCES_READ", value) for value in (None, False, 1, {}, "files")]
        cases += [("NEXT_CODEX_INSTRUCTION", value) for value in (None, False, 1, [], "", " \n", "x" * 4097)]
        for key, wrong in cases:
            with self.subTest(key=key, value=wrong), self.assertRaises(ResponseError):
                validate_response({**self.reply, key: wrong}, **self.context)

    def test_complete_contract_and_bounded_instruction_preserve_original_values(self):
        value = {**self.reply, "NEXT_CODEX_INSTRUCTION": "x" * 4096, "REVIEW_SUMMARY": "  exact summary\n"}
        decoded = parse_response("```json\n" + json.dumps(value) + "\n```")
        self.assertIs(validate_response(decoded, **self.context), decoded)
        self.assertEqual(decoded, value)

    def test_empty_resource_list_and_nonobject_entries_rejected(self):
        for resource in ([], [None], [False], [1], ["file"], [[]]):
            with self.subTest(resource=resource), self.assertRaises(ResponseError):
                validate_response({**self.reply, "GITHUB_RESOURCES_READ": resource}, **self.context)

    def test_each_resource_field_is_required_nonblank_and_string_typed(self):
        base = self.reply["GITHUB_RESOURCES_READ"][0]
        for key in ("path", "ref_commit", "github_url", "read_method", "source_excerpt"):
            variants = [{k:v for k,v in base.items() if k != key}]
            variants += [{**base, key: wrong} for wrong in (None, False, 1, [], {}, "", " \n")]
            for resource in variants:
                with self.subTest(key=key, resource=resource), self.assertRaises(ResponseError):
                    validate_response({**self.reply, "GITHUB_RESOURCES_READ": [resource]}, **self.context)

    def test_resource_ref_and_exact_https_github_host_checked(self):
        base = self.reply["GITHUB_RESOURCES_READ"][0]
        cases = [("ref_commit", x) for x in ("a" * 39, "a" * 41, "z" * 40)]
        cases += [("github_url", x) for x in ("http://github.com/file", "https://other.example/file", "https://github.com.evil/file",
                      "https://github.com@evil.example/file", "https://user@github.com/file", "https://github.com:443/file", "https://github.com")]
        for key, wrong in cases:
            with self.subTest(key=key, wrong=wrong), self.assertRaises(ResponseError):
                    validate_response({**self.reply, "GITHUB_RESOURCES_READ": [{**base, key: wrong}]}, **self.context)

    def test_unicode_scalars_and_valid_escaped_pair_preserve_decoded_values(self):
        value = {**self.reply, "REVIEW_SUMMARY": '中文 🚀 "quoted"\nnext \\ literal e' + chr(0x301),
                 "NEXT_CODEX_INSTRUCTION": "验证中文与 emoji 🚀", "额外": "原样"}
        for ascii_mode in (False, True):
            raw = json.dumps(value, ensure_ascii=ascii_mode)
            if ascii_mode: self.assertIn("\\ud83d\\ude80", raw)
            actual = validate_response(parse_response("```json\n" + raw + "\n```"), **self.context)
            self.assertEqual(actual, value)
            self.assertTrue(actual["REVIEW_SUMMARY"].endswith("e" + chr(0x301)), "no normalization")

    def test_lone_surrogates_in_controls_resource_text_and_keys_fail_closed(self):
        for lone in (chr(0xD800), chr(0xDC00)):
            variants = [{**self.reply, "NEXT_CODEX_INSTRUCTION": lone}, {**self.reply, "REVIEW_SUMMARY": lone},
                        {**self.reply, lone: "value"},
                        {**self.reply, "GITHUB_RESOURCES_READ": [{**self.reply["GITHUB_RESOURCES_READ"][0], "source_excerpt": lone}]}]
            for value in variants:
                with self.subTest(value=value), self.assertRaisesRegex(ResponseError, "response_unicode_invalid"):
                    parse_response("```json\n" + json.dumps(value) + "\n```")

    def test_decoded_nonbmp_instruction_boundary_is_scalar_count(self):
        for count in (4096, 4097):
            value = {**self.reply, "NEXT_CODEX_INSTRUCTION": "🚀" * count}
            decoded = parse_response("```json\n" + json.dumps(value) + "\n```")
            if count == 4096: self.assertEqual(validate_response(decoded, **self.context), value)
            else:
                with self.assertRaisesRegex(ResponseError, "response_instruction_invalid"): validate_response(decoded, **self.context)
