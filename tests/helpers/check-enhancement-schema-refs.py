"""Run with uv run --with jsonschema==4.26.0 tests/helpers/check-enhancement-schema-refs.py."""

import copy
import hashlib
import importlib.metadata
import json
import subprocess
from pathlib import Path

from jsonschema import Draft7Validator, Draft202012Validator

root = Path(__file__).resolve().parents[2]
fixtures = root / "tests/fixtures/contracts"
before = json.loads((fixtures / "enhance-content-output-before-refs.json").read_text())
results = json.loads((fixtures / "enhance-content-valid-results.json").read_text())
source = subprocess.check_output(
    [
        "node",
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        "import { enhanceContentHandler } from './src/handlers/analysis-handlers/content-enhancement.ts';"
        "process.stdout.write(JSON.stringify(enhanceContentHandler.outputSchema));",
    ],
    cwd=root,
    timeout=30,
)
after = json.loads(source)
expanded = copy.deepcopy(after)
for index in (0, 1):
    assert expanded["oneOf"][index]["properties"]["envelope"] == {
        "$ref": "#/$defs/AnalysisEnvelope",
        "description": expanded["$defs"]["AnalysisEnvelope"]["description"],
    }
    expanded["oneOf"][index]["properties"]["envelope"] = {
        **expanded["$defs"]["AnalysisEnvelope"],
        "description": expanded["oneOf"][index]["properties"]["envelope"]["description"],
    }
del expanded["$defs"]
assert expanded == before

cases = [(name, result, True) for name, result in results.items()]
for variant in ("rewrite", "unavailable"):
    for field in before["oneOf"][0]["properties"]["envelope"]["required"]:
        result = copy.deepcopy(results[variant])
        del result["envelope"][field]
        cases.append((f"{variant}:missing-{field}", result, False))
    result = copy.deepcopy(results[variant])
    result["envelope"]["policy"]["mutatesManuscript"] = True
    cases.append((f"{variant}:mutation-policy", result, False))
for length in (0, 1, 2, 11999, 12000, 12001):
    result = copy.deepcopy(results["rewrite"])
    result["coverage"]["sourceCharacters"] = length
    cases.append((f"source-characters-{length}", result, 1 <= length <= 12000))

for validator_type in (Draft7Validator, Draft202012Validator):
    for schema in (before, after):
        validator_type.check_schema(schema)
        validator = validator_type(schema)
        for name, instance, valid in cases:
            assert validator.is_valid(instance) == valid, (validator_type.__name__, name)

print(json.dumps({
    "validator": "jsonschema",
    "version": importlib.metadata.version("jsonschema"),
    "dialects": ["draft-07", "2020-12"],
    "casesPerSchemaPerDialect": len(cases),
    "schemaSha256": hashlib.sha256(source).hexdigest(),
    "expandedSchemaExactlyMatchesBefore": True,
}))
