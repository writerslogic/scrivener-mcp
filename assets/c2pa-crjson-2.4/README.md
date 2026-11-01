# C2PA 2.4 assessment schema

`crJSON.schema.json` is the unmodified Content Credentials JSON schema published by the Coalition
for Content Provenance and Authenticity (C2PA) in the
[2.4 schema archive](https://spec.c2pa.org/specifications/specifications/2.4/specs/_attachments/C2PA_Schemas.zip).
The source is pinned to specifications commit `c7e55d5a3c1e758eeabad058e501fadbb8cfe777`, archive
entry `crJSON/partials/crJSON.schema.json`. `provenance.json` records immutable source URLs, sizes,
and SHA-256 digests. The schema has not been reformatted or modified.

The
[C2PA 2.4 crJSON specification](https://spec.c2pa.org/specifications/specifications/2.4/crJSON/crjson-format.html)
licenses this work under
[Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/). The
complete license is retained in `LICENSE`; attribution is to C2PA. No endorsement by C2PA is
claimed.

The explicit 2.4 assessment export validates against these exact schema bytes. Its separate native
evidence retains the complete original inspection, including both native manifest flags. Schema
validation establishes the export's JSON structure; it does not establish cryptographic validity or
formal C2PA conformance.
