"""Small deterministic identifier registry used by the C2C v2 PoC."""

from __future__ import annotations


class IdentifierRegistry:
    """Store trimmed display values under case-insensitive identities."""

    def __init__(self) -> None:
        self._display_by_identity: dict[str, str] = {}

    def register(self, value: str) -> None:
        display_value = value.strip()
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
