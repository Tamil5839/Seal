# SEAL formats, version 1

This document specifies everything SEAL reads and writes, precisely enough to
build an independent verifier. The reference implementation is in `js/lib/`;
the examples at the end are checked by `tests/format.test.js`, and were
cross-checked against an independent Python implementation.

The key words MUST, MUST NOT and SHOULD are used as in RFC 2119.

## 1. Conventions

- **Bytes to text.** *base64url* is RFC 4648 §5 without padding. Decoders
  MUST reject padding, whitespace, characters outside the alphabet, and
  non-zero unused trailing bits, so every byte string has exactly one
  encoding. *hex* is lowercase.
- **Text.** All text is UTF-8. JSON is RFC 8259.
- **Timestamps** are UTC with whole seconds, exactly `YYYY-MM-DDTHH:MM:SSZ`
  (for example `2026-09-25T12:00:00Z`), and MUST name a real date and time.
- **Hashes.** SHA-256 (FIPS 180-4). **Signatures.** Ed25519 (RFC 8032), raw
  32-byte public keys and 64-byte signatures.

## 2. Keys, fingerprints and Seal IDs

```
fingerprint = SHA-256(raw 32-byte Ed25519 public key)
Seal ID     = "SEAL-" + Crockford base32 of fingerprint[0..9] (the first 80 bits),
              written as four groups of four characters joined by "-"
```

Crockford base32 uses the alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ` and
takes bits most significant first; 80 bits give exactly 16 characters. Example:
the RFC 8032 test key `d75a9801…511a` has fingerprint `21fe31df…21b9` and Seal
ID `SEAL-47Z3-3QX1-AJH6-2RKB`.

When a person types a Seal ID, implementations SHOULD accept lowercase, missing
hyphens or prefix, and read `O` as `0` and `I`/`L` as `1`.

**Public keys that MUST be rejected** (everywhere a key is read):

- encodings of the eight small-order points, with either sign bit, including
  the non-canonical encodings of y = 0 and y = 1 (these are the values
  libsodium blocks). With the sign bit (bit 255) cleared, they are:

  ```
  0000000000000000000000000000000000000000000000000000000000000000
  0100000000000000000000000000000000000000000000000000000000000000
  26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05
  c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a
  ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f
  edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f
  eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f
  ```

- any encoding whose y coordinate is ≥ p = 2²⁵⁵ − 19 (non-canonical).

This matters in practice: at least one mainstream browser's Web Crypto accepts
the identity point as a public key, and then accepts a fixed "signature" for
every message.

## 3. Canonical JSON

The bytes that are signed are the canonical JSON form of the manifest:

- objects: members sorted by key, comparing keys as sequences of UTF-16 code
  units; no duplicate keys;
- no whitespace anywhere outside strings;
- strings: escaped exactly as ECMAScript's `JSON.stringify` does: `\"`, `\\`,
  `\b \f \n \r \t`, other characters below U+0020 as `\u00xx`, lone surrogates
  as `\udxxx` (lowercase hex), everything else literally;
- numbers: integers only, in the safe range (|n| < 2⁵³), in plain decimal;
- `true`, `false`; the result is encoded as UTF-8.

For the keys and values SEAL uses this is identical to RFC 8785 (JCS).

## 4. File seal manifest

| Field         | Rules |
|---------------|-------|
| `v`           | the number `1` |
| `alg`         | the string `"Ed25519"` |
| `pub`         | base64url of the signer's 32-byte public key (43 characters), not a rejected key (§2) |
| `sha256`      | 64 lowercase hex digits: SHA-256 of the covered bytes (§7, §8, §9) |
| `size`        | number of covered bytes, a non-negative safe integer |
| `name`        | the original file name: 1–255 Unicode code points, no control characters (U+0000–U+001F, U+007F–U+009F), no bidirectional embedding, override or isolate characters (U+202A–U+202E, U+2066–U+2069), no lone surrogates |
| `declared_at` | a timestamp (§1): the date *declared by the sealer*. Nothing confirms it. |
| `note`        | optional: 1–280 code points, same rules as `name` except that line feeds (U+000A) are allowed. Omitted when empty. |

No other fields are allowed. A manifest with an unknown, missing or malformed
field is invalid. Sealers SHOULD normalize `name` and `note` to NFC, remove
forbidden characters and convert line endings in the note to LF before signing.

## 5. Seal object and `.seal` files

A seal object is the JSON object

```json
{ "manifest": { … }, "sig": "<base64url of the 64-byte Ed25519 signature>" }
```

with exactly these two members. `sig` is Ed25519 over the canonical JSON bytes
of `manifest` (§3), made with the private key belonging to `manifest.pub`.

A **`.seal` file** (a "sidecar") holds a seal object as UTF-8 JSON and is named
`<original file name>.seal`. The file it describes is not modified. Formatting
is free (SEAL writes it indented, with manifest keys sorted); a leading UTF-8
byte order mark SHOULD be tolerated. Files larger than 64 KiB are not seals.
Verifiers re-canonicalize the parsed manifest; they never verify the file's
bytes as written.

## 6. Verifying

1. Parse the seal object. If it is not exactly `{manifest, sig}` with a valid
   manifest (§4, or §10 for revocation notices), the result is **invalid**.
2. Check that `pub` is not a rejected key (§2) and verify `sig` over the
   canonical manifest bytes with `pub`. If it fails: **invalid**. An invalid
   seal says nothing about who made the file, so it MUST NOT be presented as
   coming from any Seal ID.
3. Compute the covered bytes of the file (§7–§9), their SHA-256 and length.
   If both equal `sha256` and `size`: **intact** — the file was sealed by the
   holder of this Seal ID and has not changed since. Otherwise: **altered**.
4. If a validly signed revocation notice (§10) with the same `pub` is
   available, the result is additionally **revoked**.

A file with no seal inside it and no `.seal` file has **no seal**.

The file name is informational: renaming a file does not break its seal.

## 7. Sidecar coverage

For a `.seal` file, the covered bytes are the file's bytes, exactly.

## 8. Embedded seal: PNG

The seal is stored in one `iTXt` chunk whose data is:

```
"seal" 0x00            keyword, then the NUL separator
0x00 0x00              compression flag 0 (not compressed), compression method 0
0x00                   empty language tag, then NUL
0x00                   empty translated keyword, then NUL
<seal object>          canonical JSON of the seal object, UTF-8
```

The chunk has the usual PNG layout (4-byte big-endian length, type `iTXt`,
data, CRC-32 over type and data). SEAL inserts it immediately before `IEND`,
but it MAY appear anywhere between `IHDR` and `IEND`.

**Covered bytes:** walk the chunks from the 8-byte PNG signature up to and
including `IEND`, and cut out every seal chunk completely (its length, type,
data and CRC). All other bytes — including chunk CRCs and anything after
`IEND` — are covered, in order. Because sealing changes nothing else, the
covered bytes of a sealed PNG are exactly the original PNG, and the seal
chunk can be moved without breaking the seal.

A seal chunk is an `iTXt` chunk whose data starts with `seal` followed by NUL.
If a PNG contains more than one, the result is **invalid**. A seal chunk with a
wrong CRC is **invalid** (damaged). Sealers MUST NOT embed a second seal: to
add another person's seal to a sealed image, use a `.seal` file (which then
covers the whole sealed file, §7).

If the chunk structure cannot be parsed (a damaged or truncated image), the
file cannot be the sealed original, so a verifier that still finds a seal chunk
(for example by searching for its data prefix `seal`, NUL, four zero bytes,
`{`) reports **altered** if that seal is genuine, and **invalid** otherwise.

## 9. Embedded seal: clear-sealed text

For plain text and Markdown, the seal can travel at the end of the text:

```
<original text>
-----BEGIN SEAL-----
<base64url of the canonical JSON of the seal object, in lines of at most 64 characters>
-----END SEAL-----
```

**Canonical text:** convert every CRLF and every lone CR to LF, then apply
Unicode Normalization Form C. Nothing else changes: a byte order mark, tabs and
trailing spaces are part of the text. The covered bytes are the UTF-8 encoding
of the canonical text; `size` is their length.

**Sealing:** the original text is kept exactly as it was, followed by one line
break, the BEGIN line, the payload lines, the END line and a final line break.
The line break matches the text: CRLF if the text contains CRLF or ends with a
lone CR, CR if it contains only lone CRs, LF otherwise. (Choosing CRLF when the
text ends with CR stops that CR merging with the separator.) Sealers MUST refuse
text that is not valid UTF-8 or already contains a seal block; a `.seal` file
can be used instead.

**Parsing** (always on the canonical form of the whole received text):

1. Split into lines on LF.
2. The END line is the **last** line that equals `-----END SEAL-----` after
   removing trailing whitespace. The BEGIN line is the last line before it that
   equals `-----BEGIN SEAL-----` after removing trailing whitespace.
3. The covered text is all lines before the BEGIN line, joined with LF. This
   drops exactly the one separating line break, so texts with and without a
   final newline are both recovered exactly. (If the BEGIN line is the first
   line, the covered text is empty.)
4. The payload is the lines between BEGIN and END, joined, with all whitespace
   removed; it is strict base64url of the seal object's UTF-8 JSON.
5. Lines after END that contain only whitespace are ignored. If any other text
   follows the END line, that text was never sealed and the result is
   **altered** (when the seal itself is genuine).

A block with an END line but no BEGIN line (or the reverse) whose neighbouring
lines look like payload is a damaged seal: **invalid**. Marker lines followed by
more text and with no decodable seal between them are ordinary text (for
example, documentation of this format) and are not a seal.

Sealed text is always valid UTF-8. A received text that is not valid UTF-8 has
therefore changed: verifiers decode it with replacement characters to find the
seal, and report **altered** if the seal is genuine, even if the decoded text
happens to match.

## 10. Revocation notices

A revocation notice is a seal object whose manifest is:

| Field         | Rules |
|---------------|-------|
| `v`, `alg`, `pub` | as in §4; `pub` is the key being revoked |
| `revoked`     | the value `true` |
| `declared_at` | when the notice was made (declared) |
| `note`        | optional reason, as in §4 |

No other fields. It is signed by the key it revokes, so only the key's holder
can revoke it. SEAL names the file `revocation-<Seal ID>.seal`. Verifiers tell
notices and file seals apart by the `revoked` field; because the two field sets
are disjoint, one can never be mistaken for the other.

There is no server, so nobody learns about a revocation automatically: the
owner has to publish the notice (for example next to their Seal ID), and
verifiers apply it when it is provided or remembered. A revoked key means every
seal made with it should be treated with caution, whatever its declared date —
a thief can declare any date. Because a lost key can't sign anything, SEAL
suggests making a notice in advance and keeping it with the backup.

## 11. Backup files

`seal-backup-<Seal ID>.json`:

```json
{
  "type": "seal-backup",
  "v": 1,
  "about": "<human-readable explanation>",
  "seal_id": "SEAL-…",
  "pub": "<base64url public key>",
  "created_at": "<timestamp>",
  "kdf": { "name": "PBKDF2", "hash": "SHA-256", "iterations": 600000, "salt": "<base64url, 16 bytes>" },
  "cipher": { "name": "AES-GCM", "iv": "<base64url, 12 bytes>" },
  "ct": "<base64url ciphertext and 16-byte tag>"
}
```

- key = PBKDF2-HMAC-SHA-256(NFC(passphrase) as UTF-8, salt, iterations) → 256-bit AES key.
  Readers MUST refuse fewer than 600,000 or more than 10,000,000 iterations.
- plaintext = canonical JSON of the private key as a JWK: `{"crv":"Ed25519","d":…,"kty":"OKP","x":…}`.
- `ct` = AES-256-GCM(key, iv, plaintext) with a 128-bit tag and **additional
  authenticated data** = canonical JSON of the backup object without `ct`.
  Editing any readable field therefore makes decryption fail.
- After decrypting, readers MUST check that `x` equals `pub`, and that `seal_id`
  matches `pub`.
- Passphrases must be at least 12 code points long.

AES-GCM cannot tell a wrong passphrase from a damaged file; both fail the same
way.

## 12. Examples

Signer: RFC 8032 TEST 1 key (secret `9d61b19d…7f60`, public
`d75a9801…511a`), Seal ID `SEAL-47Z3-3QX1-AJH6-2RKB`. File `hello.txt`
containing the 13 bytes `Hello, clay.` plus LF. Declared date
`2026-09-25T12:00:00Z`, note `Example seal`. (Ed25519 is deterministic, so
these values are exact.)

Canonical manifest (the signed bytes):

```
{"alg":"Ed25519","declared_at":"2026-09-25T12:00:00Z","name":"hello.txt","note":"Example seal","pub":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo","sha256":"9c03998f4313ea3156fee518e825a8dc47fcf9ca0bebb25299ee2110c803bff8","size":13,"v":1}
```

Signature: `2ZKhidqUZ42ubXlLB5gfkCOnrSap2yXbWqygLu2MMiUffHiy5sW8oEA6jziuGvj-XppmyJFW6rxdLQpeA5eLCQ`

`hello.txt.seal`:

```json
{
  "manifest": {
    "alg": "Ed25519",
    "declared_at": "2026-09-25T12:00:00Z",
    "name": "hello.txt",
    "note": "Example seal",
    "pub": "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
    "sha256": "9c03998f4313ea3156fee518e825a8dc47fcf9ca0bebb25299ee2110c803bff8",
    "size": 13,
    "v": 1
  },
  "sig": "2ZKhidqUZ42ubXlLB5gfkCOnrSap2yXbWqygLu2MMiUffHiy5sW8oEA6jziuGvj-XppmyJFW6rxdLQpeA5eLCQ"
}
```

The same file, clear-sealed (`hello-sealed.txt`; the canonical text is
`Hello, clay.` plus LF, so the manifest and signature are identical):

```
Hello, clay.

-----BEGIN SEAL-----
eyJtYW5pZmVzdCI6eyJhbGciOiJFZDI1NTE5IiwiZGVjbGFyZWRfYXQiOiIyMDI2
LTA5LTI1VDEyOjAwOjAwWiIsIm5hbWUiOiJoZWxsby50eHQiLCJub3RlIjoiRXhh
bXBsZSBzZWFsIiwicHViIjoiMTFxWUFZS3hDcmZWU183VHlXUUhPZzdoY3ZQYXBp
TWxyd0lhYVBjSFVSbyIsInNoYTI1NiI6IjljMDM5OThmNDMxM2VhMzE1NmZlZTUx
OGU4MjVhOGRjNDdmY2Y5Y2EwYmViYjI1Mjk5ZWUyMTEwYzgwM2JmZjgiLCJzaXpl
IjoxMywidiI6MX0sInNpZyI6IjJaS2hpZHFVWjQydWJYbExCNWdma0NPbnJTYXAy
eVhiV3F5Z0x1Mk1NaVVmZkhpeTVzVzhvRUE2anppdUd2ai1YcHBteUpGVzZyeGRM
UXBlQTVlTENRIn0
-----END SEAL-----
```

## 13. Emblems

Emblems are drawn from the fingerprint by `js/lib/emblem.js` and
`js/lib/motifs.js` using an integer-only generator (sfc32 seeded from the
fingerprint) and plain arithmetic, so the SVG text is identical in every
browser. They are a recognition aid only. They are not part of the format and
may change between SEAL versions; the Seal ID and fingerprint never do.
