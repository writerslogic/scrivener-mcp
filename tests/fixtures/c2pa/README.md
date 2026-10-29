# Synthetic C2PA fixtures

All assets generated here are original synthetic test content, dedicated to the
public domain under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
No manuscripts, downloaded photos, signing keys or production credentials belong here.

After building, regenerate with `node scripts/create-c2pa-fixtures.mjs`. The generator
requires local `ffmpeg` and uses Node builtins plus the existing public document exporters.
`index.json` records each actual file's MIME type, size and SHA-256. Optional encoders
that are unavailable are listed explicitly; their assets are not fabricated.
The original TTF and WOFF contain only an empty space glyph and were generated
from the [OpenType table specification](https://learn.microsoft.com/en-us/typography/opentype/spec/otff)
and [WOFF specification](https://www.w3.org/TR/WOFF/), without copying a system font.

`createC2paTestSigner(directory)` creates an encrypted, ephemeral P-256 test CA and
leaf through local OpenSSL. The native gate creates these only in its disposable
private directory, supplies the password in memory, and removes them on completion.
The test root is not publicly trusted. Never commit generated private keys or claim
that trust under this test root establishes public trust or content truth.

Run `node scripts/check-c2pa-compatibility.mjs --output <report.json>` after building
to exercise checked-in assets through the real public credential services. This
gate requires local OpenSSL, needs no ffmpeg, and fails when the installed native
SDK is unavailable. It reports embedded eligibility, disabled experimental text
features, detached roundtrips, integrity failures and explicit test-root trust
separately. Media eligibility follows the [published SDK format guidance](https://opensource.contentauthenticity.org/docs/sdk-repos/c2patool/docs/supported-formats/);
the emitted report records the actual installed SDK version and fixture index hash.
Published Rust format guidance alone does not prove that a particular released
Node binary was built with optional PDF or text features.

The gate also compresses a fresh test manifest using the standard
[C2PA `c2cm` / `brob` representation](https://spec.c2pa.org/specifications/specifications/2.5/specs/ContentCredentials.html#_compressed_manifests).
It retains the manifest label and signed bytes, then asks the real service to
validate the detached result against the same asset. This is a test-only container
transformation, not a production signer. Its report distinguishes validated,
not-validated and not-proven outcomes; it never enables SDK capability flags.
