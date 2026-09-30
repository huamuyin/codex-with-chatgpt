import unittest

from poc_v2.identifier_registry import IdentifierRegistry


class IdentifierRegistryRoundOneTests(unittest.TestCase):
    def test_trims_outer_whitespace_and_preserves_display_case(self) -> None:
        registry = IdentifierRegistry()

        registry.register("  MiXeD Name  ")

        self.assertEqual(
            registry.records(),
            [{"canonical": "mixed name", "display": "MiXeD Name"}],
        )

    def test_canonical_identity_is_case_insensitive(self) -> None:
        registry = IdentifierRegistry()

        registry.register("ALIce")

        self.assertEqual(registry.records()[0]["canonical"], "alice")

    def test_display_value_keeps_the_trimmed_original_spelling(self) -> None:
        registry = IdentifierRegistry()

        registry.register("  NorthStar  ")

        self.assertEqual(registry.records()[0]["display"], "NorthStar")

    def test_records_have_deterministic_canonical_order(self) -> None:
        registry = IdentifierRegistry()

        registry.register("Zebra")
        registry.register("Amber")

        self.assertEqual(
            registry.records(),
            [
                {"canonical": "amber", "display": "Amber"},
                {"canonical": "zebra", "display": "Zebra"},
            ],
        )
        self.assertEqual(registry.records(), registry.records())


if __name__ == "__main__":
    unittest.main()
