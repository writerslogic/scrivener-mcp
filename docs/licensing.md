# Draftbridge licensing

The server, the setup tool and the Claude Desktop extension are free and open source. Only the Draftbridge Mac app asks for a license, and only for **connecting, repairing and fixing**. Detecting apps, listing projects, testing the connection, disconnecting, and every connection that already exists keep working whatever happens to a license.

The scheme is self-contained: Ed25519-signed keys checked offline, a per-Mac activation receipt, and a signed revocation list. There is no third-party licensing vendor.

## What this does and does not stop

The app source is public, so anyone can build it without the check. That is intended: the repository stays free, and the fee buys the signed, notarized, ready-to-use build. Builds from source have licensing switched off. This scheme is meant to stop casual sharing of paid keys, not to defeat a determined reverse engineer.

- A key that leaks is revoked in the signed list and stops working on every Mac within a day of its next check.
- A key works on a limited number of Macs (seats). Activation needs the license service once per Mac.
- A patched, re-signed copy loses its Developer ID notarization, which stops the non-technical users this app is for.

## Token formats

All three are `PREFIX.<base64url JSON>.<base64url Ed25519 signature>`. The signature covers the UTF-8 bytes of `domain + "\n" + <base64url JSON exactly as written in the token>`. Signing the text as written avoids any canonical-JSON step, and the distinct `domain` stops a signature for one kind of token being replayed as another.

| Token | Prefix | Domain | JSON payload |
|---|---|---|---|
| License | `DB1` | `draftbridge-license-v1` | `{"v":1,"kid","id","email","iat","seats","product":"draftbridge"}` |
| Receipt | `DBR1` | `draftbridge-receipt-v1` | `{"v":1,"kid","id","dev","iat"}` |
| Revocations | `DBX1` | `draftbridge-revocations-v1` | `{"v":1,"kid","iat","ids":[...]}` |

`kid` names the public key. The app ships a set of public keys, so a key can be rotated by adding a new one. `dev` is the SHA-256 of `"draftbridge:" + <hardware UUID>`, so the service never sees the hardware UUID.

`apps/mac/license/issuer.mjs` is the reference implementation, and `apps/mac/license/vectors.json` holds tokens the Swift tests and the Node tests both verify. A license service must pass those vectors.

## Service contract

The app talks to `LICENSE_BASE_URL` over HTTPS only. Tokens are verified offline, so the service is needed only for activation and the revocation list.

| Request | Body | Success | Failure |
|---|---|---|---|
| `POST /v1/draftbridge/activate` | `{"license","device","name"}` | `200 {"receipt":"DBR1..."}` | `409 {"error":"seat_limit","seats":N}`, `403` revoked, `400`/`404`/`422` unknown key |
| `POST /v1/draftbridge/deactivate` | `{"license","device"}` | `2xx` (or `404` if no seat) | any other status keeps the key on the Mac |
| `GET /v1/draftbridge/revocations` | none | `200` text: a `DBX1` token | the app keeps the last list it has |

The service must verify the license signature before activating, count distinct `device` values per license `id`, refuse beyond `seats`, and make activation idempotent for a device that already holds a seat. The app rejects a receipt whose `id` or `dev` does not match, and a revocation list older than the one it already has.

## Selling it

Checkout is Stripe. On `checkout.session.completed` the service creates a license `id`, signs a `DB1` token for the customer's email, and delivers it on the post-purchase page and by email. The success page offers an **Open in Draftbridge** link: `draftbridge://license?key=<token>`, which opens the purchase window with the key filled in. The person still presses Activate.

On a refund or a lost dispute the service adds the license `id` to the revocation list and re-signs it with a newer `iat`.

## Building a licensed app

`apps/mac/scripts/build-app.sh` refuses to produce a signed build that has neither license settings nor `LICENSE_DISABLED=1`, so a paid build cannot ship unlocked by accident:

```bash
LICENSE_PUBLIC_KEYS="2026a=<base64 public key>" \
LICENSE_BASE_URL="https://license.example.com" \
LICENSE_CHECKOUT_URL="https://example.com/draftbridge/buy" \
LICENSE_PRICE='$14.99' \
SIGN_IDENTITY=... NOTARY_PROFILE=... apps/mac/scripts/build-app.sh
```

## Operating the keys

```bash
node apps/mac/license/issuer.mjs keygen --kid 2026a --out ~/secure/draftbridge-2026a.pem
node apps/mac/license/issuer.mjs issue --key ~/secure/draftbridge-2026a.pem --kid 2026a --email reader@example.com --id lic_123
```

`keygen` refuses to write a private key inside this repository. Keep the private key only on the license service and in an offline backup. Never commit it. If it leaks, generate a new `kid`, ship a build that trusts it, and revoke by retiring the old `kid` once most Macs have updated.

Hand issuing with `issue` is a fine way to sell the first copies before the service exists, with the receipt requirement turned off (`LICENSE_REQUIRE_ACTIVATION=false`).
