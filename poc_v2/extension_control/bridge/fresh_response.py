"""Strict reviewer JSON framing and identity validation; never repairs malformed input."""
import json
import re
from urllib.parse import urlsplit


class ResponseError(ValueError):
    pass


def _require_unicode_scalars(value):
    pending = [value]
    while pending:
        item = pending.pop()
        if isinstance(item, str) and any(0xD800 <= ord(c) <= 0xDFFF for c in item):
            raise ResponseError("response_unicode_invalid")
        if isinstance(item, dict): pending.extend(item.keys()); pending.extend(item.values())
        elif isinstance(item, list): pending.extend(item)


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
    _require_unicode_scalars(value)
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
    summary = value.get("REVIEW_SUMMARY")
    if not isinstance(summary, str) or not summary.strip(): raise ResponseError("response_summary_invalid")
    resources = value.get("GITHUB_RESOURCES_READ")
    fields = ("path", "ref_commit", "github_url", "read_method", "source_excerpt")
    if not isinstance(resources, list) or not resources: raise ResponseError("response_resources_invalid")
    for resource in resources:
        if not isinstance(resource, dict) or any(not isinstance(resource.get(k), str) or not resource[k].strip() for k in fields):
            raise ResponseError("response_resource_invalid")
        if not re.fullmatch(r"[A-Fa-f0-9]{40}", resource["ref_commit"]): raise ResponseError("response_resource_ref_invalid")
        try: url = urlsplit(resource["github_url"])
        except ValueError as error: raise ResponseError("response_resource_url_invalid") from error
        if url.scheme != "https" or url.netloc.lower() != "github.com" or not url.path.startswith("/"):
            raise ResponseError("response_resource_url_invalid")
    instruction = value.get("NEXT_CODEX_INSTRUCTION")
    if not isinstance(instruction, str) or not instruction.strip() or len(instruction) > 4096:
        raise ResponseError("response_instruction_invalid")
    return value
