"""Run with uv run --with tiktoken==0.12.0 scripts/count-workflow-tokens.py INPUT OUTPUT."""
import importlib.metadata
import json
import sys
from pathlib import Path

import tiktoken

source, destination = map(Path, sys.argv[1:])
report = json.loads(source.read_text())
encodings = {name: tiktoken.get_encoding(name) for name in ("cl100k_base", "o200k_base")}
rows = []
for sample in report["samples"]:
    row = {"label": sample["label"]}
    for direction in ("request", "response"):
        serialized = sample[f"serialized{direction.title()}"]
        assert json.loads(serialized) == sample[direction], "Recorded payload does not match the parsed message"
        row[direction] = {
            "utf8Bytes": len(serialized.encode("utf-8")),
            **{name: len(encoding.encode(serialized, disallowed_special=())) for name, encoding in encodings.items()},
        }
    rows.append(row)
result = {
    "tokenizer": "tiktoken",
    "version": importlib.metadata.version("tiktoken"),
    "input": str(source),
    "sourceSha256": report["sourceSha256"],
    "fixtureSha256": report["fixtureSha256"],
    "client": report["client"],
    "runtime": report["runtime"],
    "protocol": report["protocol"],
    "calls": report["calls"],
    "toolCount": report["toolCount"],
    "scopeMode": report["scopeMode"],
    "rows": rows,
    "totals": {name: sum(row[direction][name] for row in rows for direction in ("request", "response")) for name in encodings},
    "limitations": report["limitations"] + ["Tokenizes complete minified JSON payloads without transport newline framing; these are tokenizer measurements, not billed-token counts."],
}
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(result["totals"]))
