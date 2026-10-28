# Development dependency security patch

This is the upstream MIT-licensed deepmerge 4.3.1 CommonJS distribution and types, with a narrow fix
for [CVE-2026-93753](https://github.com/advisories/GHSA-gcqx-w48m-w2h4). It is used only by Jest
through a root npm override; it is not a manuscript service or a published upstream release. No
fixed upstream version was available on 2026-10-27.

Original distribution SHA-256: `2e5160f84a1141bd927264afe4d15766f1e6cf07daef182b37ff53fea121de7d`.

Both merge loops reject prototype-mutating key names independently of target shape, and destination
writes define own data properties. Expected primitive targets remain supported; unexpected throwing
property checks fail closed. Arrays, symbols, clone options, custom merges and the existing public
API are retained. The adjacent license is the upstream license. Regressions run against Jest's
actual resolved dependency in `tests/unit/utils/dependency-security.test.ts`.

Replace this override with a verified upstream fix when available, retaining the security tests. Do
not downgrade Jest, suppress audit findings, or remove existing security overrides to make the audit
pass.
