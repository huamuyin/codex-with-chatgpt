import json
import os
from pathlib import Path
import subprocess
import sys
import unicodedata
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

    def test_composed_and_decomposed_values_share_nfc_identity(self) -> None:
        composed = "Café"
        decomposed = "Cafe\u0301"

        composed_then_decomposed = IdentifierRegistry()
        composed_then_decomposed.register(composed)
        composed_then_decomposed.register(decomposed)

        decomposed_then_composed = IdentifierRegistry()
        decomposed_then_composed.register(decomposed)
        decomposed_then_composed.register(composed)

        expected = [{"canonical": "café", "display": "Café"}]
        self.assertEqual(composed_then_decomposed.records(), expected)
        self.assertEqual(len(composed_then_decomposed.records()), 1)
        self.assertEqual(
            composed_then_decomposed.records(), decomposed_then_composed.records()
        )
        display_value = composed_then_decomposed.records()[0]["display"]
        self.assertTrue(unicodedata.is_normalized("NFC", display_value))

    def test_casefold_identity_is_derived_from_normalized_unicode(self) -> None:
        registry = IdentifierRegistry()

        registry.register("CAFE\u0301")

        self.assertEqual(
            registry.records(),
            [{"canonical": "café", "display": "CAFÉ"}],
        )

    def test_serialize_is_repeatable_and_contains_records_as_json(self) -> None:
        registry = IdentifierRegistry()
        registry.register("Café")
        registry.register("Zulu")

        serialized = registry.serialize()

        self.assertEqual(registry.serialize(), serialized)
        self.assertEqual(json.loads(serialized), registry.records())

    def test_serialize_is_independent_of_insertion_order(self) -> None:
        values = ["Café", "Cafe\u0301", "ALICE", "Alice", "Zulu"]
        forward = IdentifierRegistry()
        reverse = IdentifierRegistry()
        for value in values:
            forward.register(value)
        for value in reversed(values):
            reverse.register(value)

        self.assertEqual(forward.serialize(), reverse.serialize())

    def test_composed_and_decomposed_inputs_serialize_identically(self) -> None:
        composed = IdentifierRegistry()
        composed.register("Café")
        decomposed = IdentifierRegistry()
        decomposed.register("Cafe\u0301")

        self.assertEqual(composed.serialize(), decomposed.serialize())

    def test_serialization_is_stable_across_processes_and_hash_seeds(self) -> None:
        values = ["Café", "Cafe\u0301", "Alpha", "ALPHA", "Zulu"]
        script = (
            "import json, sys\n"
            "from poc_v2.identifier_registry import IdentifierRegistry\n"
            "registry = IdentifierRegistry()\n"
            "for value in json.loads(sys.argv[1]): registry.register(value)\n"
            "print(registry.serialize())\n"
        )
        project_root = Path(__file__).resolve().parents[2]
        outputs = []
        for hash_seed, inputs in (("1", values), ("999", list(reversed(values)))):
            environment = os.environ.copy()
            environment["PYTHONHASHSEED"] = hash_seed
            result = subprocess.run(
                [sys.executable, "-c", script, json.dumps(inputs, ensure_ascii=False)],
                check=True,
                capture_output=True,
                cwd=project_root,
                env=environment,
                text=True,
                timeout=10,
            )
            outputs.append(result.stdout)

        self.assertEqual(outputs[0], outputs[1])


if __name__ == "__main__":
    unittest.main()
