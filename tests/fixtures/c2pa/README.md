# Synthetic C2PA fixtures

All assets generated here are original synthetic test content, dedicated to the
public domain under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
No manuscripts, downloaded photos, signing keys or production credentials belong here.

After building, regenerate with `node scripts/create-c2pa-fixtures.mjs`. The generator
uses Node builtins, the existing public document exporters and local `ffmpeg`.
`index.json` records each actual file's MIME type, size and SHA-256. Optional encoders
that are unavailable are listed explicitly; their assets are not fabricated.

`createC2paTestSigner(directory)` creates an encrypted, ephemeral P-256 test CA and
leaf through local OpenSSL. The native gate creates these only in its disposable
private directory, supplies the password in memory, and removes them on completion.
The test root is not publicly trusted. Never commit generated private keys or claim
that trust under this test root establishes public trust or content truth.
