"""Strict reviewer JSON framing and identity validation; never repairs malformed input."""
import json
import re


class ResponseError(ValueError):
    pass


def parse_response(raw):
    if not isinstance(raw, str): raise ResponseError("response_not_text")
    text = raw.strip()
    if text.startswith("```"):
        match = re.fullmatch(r"```json[ \t]*\r?\n(.*?)\r?\n```", text, re.S)
        if not match: raise ResponseError("response_fence_invalid")
        text = match[1]
    elif "\n" in text and text.split("\n", 1)[0].rstrip("\r") in ("JSON", "json"):
        text = text.split("\n", 1)[1]
    else: raise ResponseError("response_json_frame_required")
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result: raise ResponseError("response_duplicate_key")
            result[key] = value
        return result
    def constant(_): raise ResponseError("response_nonfinite")
    try: value = json.loads(text, object_pairs_hook=pairs, parse_constant=constant)
    except json.JSONDecodeError as error: raise ResponseError("response_json_invalid") from error
    if not isinstance(value, dict): raise ResponseError("response_object_required")
    return value


def validate_response(value, *, round_no, request_id, control_id, attempt_id, commit):
    expected = {"STATE": "REVIEW_RESULT", "ROUND": round_no, "REQUEST_ID": request_id,
                "CONTROL_ID": control_id, "ATTEMPT_ID": attempt_id, "REVIEWED_COMMIT": commit}
    if not isinstance(value, dict) or any(value.get(k) != v for k, v in expected.items()):
        raise ResponseError("response_identity_mismatch")
    if type(value["ROUND"]) is not int or type(value["ATTEMPT_ID"]) is not int:
        raise ResponseError("response_identity_type")
    if value.get("VERDICT") not in ("PASS_CONTINUE", "CHANGES_REQUIRED", "BLOCKED_AUTHORITY"):
        raise ResponseError("response_verdict_invalid")
    if not isinstance(value.get("FINDINGS"), list): raise ResponseError("response_findings_invalid")
    return value
