// The example seals published in docs/FORMAT.md. They were checked against an
// independent implementation (Python: json, hashlib and the "cryptography"
// package's Ed25519). If these tests fail, the documented format and the code
// disagree.

import { assert, describe, test } from './harness.js';
import { DECLARED, testIdentity } from './fixtures.js';
import { utf8Decode, utf8Encode } from '../js/lib/bytes.js';
import { canonicalize } from '../js/lib/canonical-json.js';
import { sealFile } from '../js/lib/sealer.js';
import { verifyFiles } from '../js/lib/verifier.js';

const HELLO = utf8Encode('Hello, clay.\n');

const CANONICAL_MANIFEST = '{"alg":"Ed25519","declared_at":"2026-09-25T12:00:00Z","name":"hello.txt","note":"Example seal",' +
  '"pub":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo","sha256":"9c03998f4313ea3156fee518e825a8dc47fcf9ca0bebb25299ee2110c803bff8","size":13,"v":1}';
const SIGNATURE = '2ZKhidqUZ42ubXlLB5gfkCOnrSap2yXbWqygLu2MMiUffHiy5sW8oEA6jziuGvj-XppmyJFW6rxdLQpeA5eLCQ';

const SEAL_FILE = `{
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
  "sig": "${SIGNATURE}"
}
`;

const CLEAR_SEALED = `Hello, clay.

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
`;

async function sealHello(mode) {
  const { privateKey, publicKey } = await testIdentity(0);
  return sealFile({ bytes: HELLO, name: 'hello.txt', mode, privateKey, publicKey, declaredAt: DECLARED, note: 'Example seal' });
}

describe('documented format examples (docs/FORMAT.md)', () => {
  test('the .seal file for hello.txt is exactly as documented', async () => {
    const { seal, output } = await sealHello('sidecar');
    assert.equal(canonicalize(seal.manifest), CANONICAL_MANIFEST);
    assert.equal(seal.sig, SIGNATURE);
    assert.equal(utf8Decode(output.bytes), SEAL_FILE);
  });

  test('the clear-sealed hello.txt is exactly as documented', async () => {
    const { output } = await sealHello('text');
    assert.equal(utf8Decode(output.bytes), CLEAR_SEALED);
  });

  test('the documented examples verify as intact, and edits are caught', async () => {
    let report = await verifyFiles([{ name: 'hello.txt', bytes: HELLO }, { name: 'hello.txt.seal', bytes: utf8Encode(SEAL_FILE) }]);
    assert.equal(report.items[0].checks[0].status, 'intact');
    assert.equal(report.items[0].checks[0].signer.sealId, 'SEAL-47Z3-3QX1-AJH6-2RKB');
    report = await verifyFiles([{ name: 'hello-sealed.txt', bytes: utf8Encode(CLEAR_SEALED) }]);
    assert.equal(report.items[0].checks[0].status, 'intact');
    report = await verifyFiles([{ name: 'hello-sealed.txt', bytes: utf8Encode(CLEAR_SEALED.replace('clay', 'Clay')) }]);
    assert.equal(report.items[0].checks[0].status, 'altered');
  });
});
