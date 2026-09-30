import unittest

from poc_v2.identifier_registry import IdentifierRegistry


class IdentifierRegistryTests(unittest.TestCase):
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

    def test_repeated_exact_value_is_idempotent(self) -> None:
        registry = IdentifierRegistry()

        registry.register("Alice")
        first_records = registry.records()
        registry.register("Alice")

        self.assertEqual(registry.records(), first_records)

    def test_case_variants_share_identity_and_choose_smallest_display(self) -> None:
        registry = IdentifierRegistry()

        registry.register("Alice")
        registry.register("ALICE")

        self.assertEqual(
            registry.records(),
            [{"canonical": "alice", "display": "ALICE"}],
        )

    def test_collision_result_is_independent_of_insertion_order(self) -> None:
        alice_then_upper = IdentifierRegistry()
        alice_then_upper.register("Alice")
        alice_then_upper.register("ALICE")

        upper_then_alice = IdentifierRegistry()
        upper_then_alice.register("ALICE")
        upper_then_alice.register("Alice")

        self.assertEqual(alice_then_upper.records(), upper_then_alice.records())


if __name__ == "__main__":
    unittest.main()
