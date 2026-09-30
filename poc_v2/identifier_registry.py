"""Small deterministic identifier registry used by the C2C v2 PoC."""

from __future__ import annotations

import json
import unicodedata


class IdentifierRegistry:
    """Store trimmed display values under case-insensitive identities."""

    def __init__(self) -> None:
        self._display_by_identity: dict[str, str] = {}

    def register(self, value: str) -> None:
        trimmed_value = value.strip()
        display_value = unicodedata.normalize("NFC", trimmed_value)
        canonical_identity = display_value.casefold()
        existing_display_value = self._display_by_identity.get(canonical_identity)
        self._display_by_identity[canonical_identity] = (
            display_value
            if existing_display_value is None
            else min(existing_display_value, display_value)
        )

    def records(self) -> list[dict[str, str]]:
        """Return records in canonical-identity order."""
        return [
            {
                "canonical": identity,
                "display": self._display_by_identity[identity],
            }
            for identity in sorted(self._display_by_identity)
        ]

    def serialize(self) -> str:
        """Return canonical JSON for this registry's records."""
        return json.dumps(
            self.records(),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
