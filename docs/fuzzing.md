# Fuzzing

Scrivener MCP fuzzes its untrusted RTF, model-output, and regular-expression
input paths with [Jazzer.js](https://github.com/CodeIntelligenceTesting/jazzer.js).
The maintained target is [`fuzz/rtf-and-inputs.fuzz.mjs`](../fuzz/rtf-and-inputs.fuzz.mjs).

## OSS-Fuzz integration

The OSS-Fuzz build performs these steps:

```bash
npm ci --ignore-scripts
npm run build
compile_javascript_fuzzer scrivener-mcp fuzz/rtf-and-inputs.fuzz.mjs --sync
```

The target limits each generated input to 64 KiB. It exercises:

- RTF scanning, construct detection, and fidelity-preserving text splicing;
- best-effort parsing of untrusted model JSON; and
- escaping arbitrary Unicode for literal regular-expression matching.

Crashes reported by OSS-Fuzz are handled under the private vulnerability process
documented in [`SECURITY.md`](../SECURITY.md).
