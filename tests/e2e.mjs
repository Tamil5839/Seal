// End-to-end tests of the real UI in headless Chromium: create a seal with a
// backup, seal text / PDF / PNG files, verify every result state, revoke,
// restore on a "second device", save known seals, re-export and delete.
// Also checks accessibility (axe-core), CSP violations, network requests,
// reduced motion, small screens, and browsers without Ed25519.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const AXE_SOURCE = await readFile(require.resolve('axe-core/axe.min.js'), 'utf8');

const PASS = 'lapis river clay moon tablet';
const PASS2 = 'basalt reed star water gold';
const SEAL_ID = /^SEAL-[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/;

class Failure extends Error {}
function expect(condition, message) {
  if (!condition) throw new Failure(message);
}

// ----------------------------------------------------------- fixtures

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function makePng(width, height, seed = 1) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let x = seed;
  for (let i = 0; i < raw.length; i++) {
    if (i % (width * 4 + 1) === 0) continue; // filter byte 0
    x = (x * 1103515245 + 12345) >>> 0;
    raw[i] = x >>> 24;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const POEM = 'Clay remembers.\r\nEvery mark the reed makes.\r\n';

// ------------------------------------------------------------ helpers

function watch(page, baseUrl, problems) {
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console error: ${m.text()}`);
  });
  page.on('request', (r) => {
    const url = r.url();
    if (!url.startsWith(baseUrl) && !url.startsWith('blob:') && !url.startsWith('data:')) problems.push(`request to another site: ${url}`);
  });
}

async function openApp(context, baseUrl, problems, hash = '#/') {
  const page = await context.newPage();
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`));
  });
  watch(page, baseUrl, problems);
  await page.goto(`${baseUrl}/${hash}`);
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
  return page;
}

async function go(page, hash) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForFunction((name) => {
    const s = document.querySelector(`[data-screen="${name}"]`);
    return s && !s.hidden;
  }, hash.replace('#/', '') || 'home');
}

async function download(page, action) {
  const [dl] = await Promise.all([page.waitForEvent('download'), action()]);
  return { name: dl.suggestedFilename(), bytes: await readFile(await dl.path()) };
}

const file = (name, buffer, mimeType = 'application/octet-stream') => ({ name, mimeType, buffer: Buffer.from(buffer) });

/** Drop files on the verify screen and return the result cards' states and headlines. */
async function verify(page, files) {
  await go(page, '#/verify');
  if (await page.isVisible('[data-verify-clear]')) await page.click('[data-verify-clear]');
  await page.setInputFiles('#verify-files', files);
  await page.waitForFunction((n) => document.querySelectorAll('[data-verify-results] .result').length >= n && !/Checking/.test(document.querySelector('[data-verify-status]').textContent), 1);
  return page.$$eval('[data-verify-results] .result', (cards) => cards.map((c) => ({
    state: c.dataset.state,
    headline: c.querySelector('.result-headline').textContent.replace(/\s+/g, ' ').trim(),
    text: c.textContent.replace(/\s+/g, ' '),
  })));
}

async function axe(page, label, violations) {
  const hasAxe = await page.evaluate(() => typeof window.axe !== 'undefined');
  if (!hasAxe) await page.evaluate(AXE_SOURCE);
  const result = await page.evaluate(async () => {
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')})`);
  });
  for (const v of result) violations.push(`[${label}] ${v}`);
}

// -------------------------------------------------------------- tests

export async function runE2E({ browser, baseUrl, filter = '' }) {
  let failures = 0;
  const shared = {};
  const a11y = [];

  async function step(name, fn) {
    if (filter && !name.includes(filter) && !['create', 'seal'].some((k) => name.startsWith(k))) return;
    try {
      await fn();
      console.log(`  ok   e2e › ${name}`);
    } catch (error) {
      failures++;
      console.log(` FAIL  e2e › ${name}\n${error instanceof Failure ? error.message : error.stack}`);
    }
  }

  const problems = [];
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await openApp(context, baseUrl, problems);

  await step('home shows the three actions and the honesty panel', async () => {
    const titles = await page.$$eval('.action-title', (els) => els.map((e) => e.textContent));
    expect(JSON.stringify(titles) === JSON.stringify(['Create my seal', 'Seal a file', 'Verify a file']), `actions: ${titles}`);
    const honesty = await page.textContent('[data-screen="home"] .honesty');
    for (const phrase of ['This exact file was sealed by the holder of this Seal ID', 'not one byte', 'That a human made it, or that no AI was used', 'declared by the sealer', 'Social platforms re-compress', 'Losing your private key']) {
      expect(honesty.includes(phrase), `honesty panel is missing "${phrase}"`);
    }
    expect(!/verified human|authentic/i.test(await page.textContent('body')), 'forbidden wording on the page');
    await axe(page, 'home', a11y);
  });

  await step('keyboard: skip link first, visible focus, file inputs reachable', async () => {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement.classList.contains('skip-link')), 'the skip link is the first stop');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => document.activeElement.id === 'main'), 'skip link moves focus to the main content');
    const stops = [];
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      stops.push(await page.evaluate(() => {
        const el = document.activeElement;
        if (el === document.body) return { text: '(browser chrome)', outline: 'n/a' }; // Tab wrapped past the last link
        const style = getComputedStyle(el);
        return { text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30), outline: style.outlineStyle };
      }));
    }
    expect(stops.every((s) => s.outline !== 'none'), `every focused element shows a focus ring: ${JSON.stringify(stops)}`);
    expect(stops.some((s) => s.text.startsWith('Create my seal')), `home actions reachable by keyboard: ${JSON.stringify(stops.map((s) => s.text))}`);
    await go(page, '#/verify');
    await page.focus('#verify-files');
    const ring = await page.evaluate(() => getComputedStyle(document.querySelector('[data-verify-drop]')).outlineStyle);
    expect(ring !== 'none', 'the drop zone shows focus when its file input is focused');
    await go(page, '#/');
  });

  await step('create: a weak passphrase is refused', async () => {
    await go(page, '#/create');
    await axe(page, 'create intro', a11y);
    await page.click('[data-create-begin]');
    await page.waitForSelector('[data-step="backup"]:not([hidden])');
    shared.sealId = (await page.textContent('[data-create-new-id]')).trim();
    expect(SEAL_ID.test(shared.sealId), `new Seal ID ${shared.sealId}`);
    await page.fill('#create-pass', 'too short');
    await page.fill('#create-pass2', 'too short');
    await page.click('[data-backup-submit]');
    expect(/at least 12/.test(await page.textContent('[data-backup-error]')), 'short passphrase error');
    await page.fill('#create-pass', 'password1234');
    await page.fill('#create-pass2', 'password1234');
    await page.click('[data-backup-submit]');
    expect(await page.isVisible('[data-backup-error]'), 'common passphrase refused');
    await page.fill('#create-pass', PASS);
    await page.fill('#create-pass2', PASS + 'x');
    await page.click('[data-backup-submit]');
    expect(/different/.test(await page.textContent('[data-backup-error]')), 'mismatch error');
    await axe(page, 'create backup', a11y);
  });

  await step('create: the encrypted backup downloads and can be checked', async () => {
    await page.fill('#create-pass', PASS);
    await page.fill('#create-pass2', PASS);
    shared.backup = await download(page, () => page.click('[data-backup-submit]'));
    expect(shared.backup.name === `seal-backup-${shared.sealId}.json`, `backup name ${shared.backup.name}`);
    const json = JSON.parse(shared.backup.bytes.toString('utf8'));
    expect(json.kdf.iterations >= 600000 && json.cipher.name === 'AES-GCM' && json.seal_id === shared.sealId, 'backup settings');
    await page.waitForSelector('[data-step="confirm"]:not([hidden])');
    expect(await page.isDisabled('[data-confirm-submit]'), 'finish is disabled until confirmed');
    await page.click('[data-step="confirm"] summary');
    await page.setInputFiles('#test-backup-file', file(shared.backup.name, shared.backup.bytes, 'application/json'));
    await page.fill('#test-backup-pass', 'wrong passphrase here');
    await page.click('[data-backup-test] button[type="submit"]');
    await page.waitForFunction(() => /passphrase/.test(document.querySelector('[data-backup-test-status]').textContent));
    await page.fill('#test-backup-pass', PASS);
    await page.click('[data-backup-test] button[type="submit"]');
    await page.waitForFunction(() => /backup works/.test(document.querySelector('[data-backup-test-status]').textContent));
    await axe(page, 'create confirm', a11y);
  });

  await step('create: finishing stores a non-extractable key and rolls the emblem', async () => {
    await page.check('[data-confirm-saved]');
    await page.click('[data-confirm-submit]');
    await page.waitForSelector('[data-step="done"]:not([hidden])');
    expect((await page.textContent('[data-create-final-id]')).trim() === shared.sealId, 'final Seal ID');
    await page.waitForSelector('[data-create-roll] [data-cylinder]', { state: 'attached' });
    await page.waitForFunction(() => !document.querySelector('[data-create-roll] [data-cylinder]'), null, { timeout: 5000 });
    expect(await page.getAttribute('[data-create-roll] [data-reveal]', 'width') === '600.00', 'the whole impression is revealed');
    expect(await page.$('[data-create-roll] svg svg [id$="-art"]') !== null, 'the stage contains the emblem');
    const key = await page.evaluate(async () => {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('seal'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const rec = await new Promise((res, rej) => { const r = db.transaction('identity').objectStore('identity').get('primary'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      db.close();
      let exported = false;
      for (const format of ['jwk', 'pkcs8', 'raw']) {
        try { await crypto.subtle.exportKey(format, rec.privateKey); exported = true; } catch { /* expected */ }
      }
      return { extractable: rec.privateKey.extractable, exported, sealId: rec.sealId };
    });
    expect(key.extractable === false && key.exported === false, `stored key must be non-extractable: ${JSON.stringify(key)}`);
    expect(key.sealId === shared.sealId, 'stored Seal ID');
    await axe(page, 'create done', a11y);
  });

  await step('seal: text is clear-sealed inside the file', async () => {
    await go(page, '#/seal');
    await page.setInputFiles('#seal-file', file('poem.txt', POEM, 'text/plain'));
    await page.waitForSelector('[data-seal-options]:not([hidden])');
    expect(await page.isChecked('[data-seal-mode-embed]'), 'embed is the default for text');
    await page.fill('#seal-note', 'My first sealed poem');
    await axe(page, 'seal options', a11y);
    shared.poem = await download(page, () => page.click('[data-seal-submit]'));
    expect(shared.poem.name === 'poem-sealed.txt', `name ${shared.poem.name}`);
    const text = shared.poem.bytes.toString('utf8');
    expect(text.startsWith(POEM) && text.includes('\r\n-----BEGIN SEAL-----\r\n') && text.includes('-----END SEAL-----'), 'clear-sealed text keeps the original and CRLF');
    await page.waitForSelector('[data-seal-result]:not([hidden])');
    expect((await page.textContent('[data-seal-howto]')).includes(shared.sealId), 'how-to line names the Seal ID');
    await axe(page, 'seal result', a11y);
  });

  await step('seal: PDF gets a separate .seal file', async () => {
    await page.click('[data-seal-another]');
    await page.setInputFiles('#seal-file', file('paper.pdf', PDF, 'application/pdf'));
    await page.waitForSelector('[data-seal-options]:not([hidden])');
    expect(await page.isDisabled('[data-seal-mode-embed]'), 'embed disabled for PDF');
    expect(await page.isChecked('[data-seal-mode-sidecar]'), 'sidecar chosen for PDF');
    shared.pdfSeal = await download(page, () => page.click('[data-seal-submit]'));
    expect(shared.pdfSeal.name === 'paper.pdf.seal', `name ${shared.pdfSeal.name}`);
  });

  await step('seal: PNG gets an embedded seal', async () => {
    await page.click('[data-seal-another]');
    shared.png = makePng(12, 8, 5);
    await page.setInputFiles('#seal-file', file('pixel.png', shared.png, 'image/png'));
    await page.waitForSelector('[data-seal-options]:not([hidden])');
    expect(await page.isChecked('[data-seal-mode-embed]'), 'embed default for PNG');
    shared.sealedPng = await download(page, () => page.click('[data-seal-submit]'));
    expect(shared.sealedPng.name === 'pixel-sealed.png', `name ${shared.sealedPng.name}`);
  });

  await step('verify: INTACT for sealed text, PDF and PNG', async () => {
    let cards = await verify(page, [file(shared.poem.name, shared.poem.bytes, 'text/plain')]);
    expect(cards.length === 1 && cards[0].state === 'intact', `text: ${JSON.stringify(cards)}`);
    expect(cards[0].headline.includes(`Sealed by ${shared.sealId}, unchanged since sealing`), cards[0].headline);
    expect(cards[0].text.includes('your seal') && cards[0].text.includes('My first sealed poem') && cards[0].text.includes('declared by the sealer'), 'details');
    await axe(page, 'verify intact', a11y);
    cards = await verify(page, [file('paper.pdf', PDF, 'application/pdf'), file(shared.pdfSeal.name, shared.pdfSeal.bytes)]);
    expect(cards.length === 1 && cards[0].state === 'intact', `pdf: ${JSON.stringify(cards)}`);
    cards = await verify(page, [file(shared.sealedPng.name, shared.sealedPng.bytes, 'image/png')]);
    expect(cards.length === 1 && cards[0].state === 'intact', `png: ${JSON.stringify(cards)}`);
  });

  await step('verify: line-ending changes keep text INTACT', async () => {
    const lf = shared.poem.bytes.toString('utf8').replace(/\r\n/g, '\n');
    const cards = await verify(page, [file('poem-lf.txt', lf, 'text/plain')]);
    expect(cards[0].state === 'intact', JSON.stringify(cards));
  });

  await step('verify: ALTERED after a one-byte change', async () => {
    const edited = Buffer.from(shared.poem.bytes);
    edited[0] ^= 0x20; // "Clay" -> "clay"
    let cards = await verify(page, [file('poem-sealed.txt', edited, 'text/plain')]);
    expect(cards[0].state === 'altered' && /changed since it was sealed/.test(cards[0].headline), JSON.stringify(cards));
    await axe(page, 'verify altered', a11y);
    const pdf = Buffer.from(PDF);
    pdf[20] ^= 1;
    cards = await verify(page, [file('paper.pdf', pdf, 'application/pdf'), file(shared.pdfSeal.name, shared.pdfSeal.bytes)]);
    expect(cards[0].state === 'altered', `pdf: ${JSON.stringify(cards)}`);
    const png = Buffer.from(shared.sealedPng.bytes);
    png[40] ^= 1; // inside the image data
    cards = await verify(page, [file('pixel-sealed.png', png, 'image/png')]);
    expect(cards[0].state === 'altered', `png: ${JSON.stringify(cards)}`);
  });

  await step('verify: INVALID SEAL after editing the seal', async () => {
    const seal = JSON.parse(shared.pdfSeal.bytes.toString('utf8'));
    seal.manifest.declared_at = '2001-01-01T00:00:00Z';
    const cards = await verify(page, [file('paper.pdf', PDF, 'application/pdf'), file('paper.pdf.seal', JSON.stringify(seal))]);
    expect(cards[0].state === 'invalid' && /not valid/.test(cards[0].headline), JSON.stringify(cards));
    expect(!cards[0].text.includes(shared.sealId), 'an invalid seal does not name a signer');
    await axe(page, 'verify invalid', a11y);
  });

  await step('verify: NO SEAL FOUND, and a .seal file on its own', async () => {
    let cards = await verify(page, [file('random.bin', Buffer.from('no seal here at all'))]);
    expect(cards[0].state === 'none' && /No seal found/.test(cards[0].headline), JSON.stringify(cards));
    await axe(page, 'verify none', a11y);
    cards = await verify(page, [file(shared.pdfSeal.name, shared.pdfSeal.bytes)]);
    expect(cards[0].state === 'seal-only' && cards[0].text.includes('paper.pdf'), JSON.stringify(cards));
  });

  await step('verify: pasted clear-sealed text', async () => {
    await go(page, '#/verify');
    await page.click('[data-verify-clear]').catch(() => {});
    await page.click('[data-verify-paste] summary');
    await page.fill('#verify-text', shared.poem.bytes.toString('utf8'));
    await page.click('[data-verify-paste-form] button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('[data-verify-results] .result'));
    expect(await page.getAttribute('[data-verify-results] .result', 'data-state') === 'intact', 'pasted text intact');
  });

  await step('my seal: emblem download and revocation notice', async () => {
    await go(page, '#/my-seal');
    expect((await page.textContent('[data-my-id]')).trim() === shared.sealId, 'Seal ID shown');
    expect(await page.isVisible('[data-reexport-form]'), 're-export available in the creating session');
    const svg = await download(page, () => page.click('[data-download-band]'));
    expect(svg.name === `seal-emblem-${shared.sealId}.svg` && svg.bytes.toString('utf8').startsWith('<svg'), svg.name);
    await page.fill('#revoke-reason', 'Laptop stolen');
    shared.revocation = await download(page, () => page.click('[data-revoke-form] button[type="submit"]'));
    expect(shared.revocation.name === `revocation-${shared.sealId}.seal`, shared.revocation.name);
    const notice = JSON.parse(shared.revocation.bytes.toString('utf8'));
    expect(notice.manifest.revoked === true && notice.manifest.note === 'Laptop stolen', 'notice contents');
    await axe(page, 'my seal', a11y);
  });

  await step('verify: REVOKED with a matching revocation notice, and remembered', async () => {
    let cards = await verify(page, [file(shared.poem.name, shared.poem.bytes, 'text/plain'), file(shared.revocation.name, shared.revocation.bytes)]);
    expect(cards.length === 2 && cards[0].state === 'revoked' && cards[1].state === 'revocation', JSON.stringify(cards));
    expect(cards[0].text.includes('Laptop stolen') && cards[0].text.includes('unchanged since sealing'), 'revocation details');
    await axe(page, 'verify revoked', a11y);
    await page.click('[data-verify-results] .result >> text=Remember this revocation on this device');
    await page.waitForFunction(() => /Remembered on this device/.test(document.querySelector('[data-verify-results]').textContent));
    cards = await verify(page, [file(shared.poem.name, shared.poem.bytes, 'text/plain')]);
    expect(cards[0].state === 'revoked' && cards[0].text.includes('remembered on this device'), JSON.stringify(cards));
    await go(page, '#/my-seal');
    await page.click('[data-saved-revocations] button');
    await page.waitForSelector('[data-saved-revocations-panel]', { state: 'hidden' });
    cards = await verify(page, [file(shared.poem.name, shared.poem.bytes, 'text/plain')]);
    expect(cards[0].state === 'intact', 'forgetting the revocation');
  });

  await step('about page', async () => {
    await go(page, '#/about');
    expect((await page.textContent('[data-screen="about"]')).includes('never uploads'), 'privacy text');
    await axe(page, 'about', a11y);
  });

  // ---------------------------------------------- a second "device"
  const problems2 = [];
  const context2 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await openApp(context2, baseUrl, problems2);

  await step('second device: known seals are named "saved by you"', async () => {
    let cards = await verify(phone, [file(shared.poem.name, shared.poem.bytes, 'text/plain')]);
    expect(cards[0].state === 'intact' && !cards[0].text.includes('your seal'), 'not my seal on another device');
    expect(cards[0].text.includes('can’t tell you who'), 'explains that the Seal ID is anonymous');
    await phone.fill('[data-verify-results] .result input[type="text"]', 'Ada');
    await phone.click('[data-verify-results] .result form button[type="submit"]');
    await phone.waitForFunction(() => /saved by you/.test(document.querySelector('[data-verify-results]').textContent));
    cards = await verify(phone, [file(shared.poem.name, shared.poem.bytes, 'text/plain')]);
    expect(cards[0].text.includes('“Ada” · saved by you'), JSON.stringify(cards[0].text));
    await go(phone, '#/my-seal');
    expect((await phone.textContent('[data-known-list]')).includes('Ada'), 'listed in known seals');
  });

  await step('second device: restore from the backup', async () => {
    await go(phone, '#/restore');
    await axe(phone, 'restore', a11y);
    await phone.setInputFiles('#restore-file', file(shared.backup.name, shared.backup.bytes, 'application/json'));
    await phone.waitForFunction((id) => document.querySelector('[data-restore-file-status]').textContent.includes(id), shared.sealId);
    await phone.fill('#restore-pass', 'not the passphrase');
    await phone.click('[data-restore-submit]');
    await phone.waitForFunction(() => !document.querySelector('[data-restore-error]').hidden);
    await phone.fill('#restore-pass', PASS);
    await phone.click('[data-restore-submit]');
    await phone.waitForSelector('[data-restore-step="done"]:not([hidden])');
    expect((await phone.textContent('[data-restore-final-id]')).trim() === shared.sealId, 'same Seal ID after restore');
    const cards = await verify(phone, [file(shared.poem.name, shared.poem.bytes, 'text/plain')]);
    expect(cards[0].text.includes('your seal'), 'now recognised as my seal');
  });

  await step('second device: re-export the backup with a new passphrase', async () => {
    await go(phone, '#/my-seal');
    expect(await phone.isVisible('[data-reexport-form]'), 're-export offered after a restore');
    await phone.fill('#reexport-current', PASS);
    await phone.fill('#reexport-new', PASS2);
    await phone.fill('#reexport-new2', PASS2);
    const again = await download(phone, () => phone.click('[data-reexport-submit]'));
    const json = JSON.parse(again.bytes.toString('utf8'));
    expect(json.seal_id === shared.sealId, 'same seal');
    const opens = await phone.evaluate(async ([backup, pass]) => {
      const { openBackup } = await import('./js/lib/backup.js');
      try { await openBackup(backup, pass); return true; } catch { return false; }
    }, [json, PASS2]);
    expect(opens, 'the new backup opens with the new passphrase');
  });

  await step('second device: the layout fits phone screens (390 and 320 px wide)', async () => {
    for (const width of [390, 320]) {
      await phone.setViewportSize({ width, height: 800 });
      for (const screen of ['#/', '#/create', '#/seal', '#/verify', '#/my-seal', '#/about', '#/restore']) {
        await go(phone, screen);
        const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow <= 0, `${screen} at ${width}px scrolls sideways by ${overflow}px`);
      }
    }
    const cards = await verify(phone, [file(shared.poem.name, shared.poem.bytes, 'text/plain'), file(shared.revocation.name, shared.revocation.bytes)]);
    expect(cards.length === 2, 'results render on a small screen');
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow <= 0, `verify results at 320px scroll sideways by ${overflow}px`);
    await phone.setViewportSize({ width: 390, height: 844 });
  });

  await step('second device: delete the seal', async () => {
    await go(phone, '#/my-seal');
    expect(await phone.isDisabled('[data-delete-submit]'), 'delete needs confirmation');
    await phone.check('[data-delete-confirm]');
    await phone.click('[data-delete-submit]');
    await phone.waitForSelector('[data-my-none]:not([hidden])');
    expect((await phone.textContent('[data-my-none]')).includes('deleted'), 'deleted message');
    await go(phone, '#/seal');
    expect(await phone.isVisible('[data-seal-needs-seal]'), 'sealing needs a seal again');
  });

  // ----------------------------------------------- reduced motion
  const problems3 = [];
  const context3 = await browser.newContext({ reducedMotion: 'reduce' });
  const calm = await openApp(context3, baseUrl, problems3);
  await step('reduced motion: the impression appears without rolling', async () => {
    await go(calm, '#/restore');
    await calm.setInputFiles('#restore-file', file(shared.backup.name, shared.backup.bytes, 'application/json'));
    await calm.fill('#restore-pass', PASS);
    await calm.click('[data-restore-submit]');
    await calm.waitForSelector('[data-restore-step="done"]:not([hidden])');
    await calm.waitForSelector('[data-restore-roll] [data-reveal]', { state: 'attached' });
    expect(await calm.$('[data-restore-roll] [data-cylinder]') === null, 'no rolling cylinder with reduced motion');
    expect(await calm.getAttribute('[data-restore-roll] [data-reveal]', 'width') === '600.00', 'impression fully shown at once');
  });

  // --------------------------------------------- no Ed25519 support
  const problems4 = [];
  const context4 = await browser.newContext();
  await context4.addInitScript(() => {
    const original = SubtleCrypto.prototype.importKey;
    SubtleCrypto.prototype.importKey = function (format, data, algorithm, ...rest) {
      const name = typeof algorithm === 'string' ? algorithm : algorithm && algorithm.name;
      if (name === 'Ed25519') return Promise.reject(new DOMException('Unrecognized name', 'NotSupportedError'));
      return original.call(this, format, data, algorithm, ...rest);
    };
  });
  const old = await openApp(context4, baseUrl, problems4);
  await step('a browser without Ed25519 gets a clear message', async () => {
    expect(await old.isVisible('#support-banner'), 'support banner shown');
    expect((await old.textContent('#support-banner')).includes('update'), 'asks to update');
    await go(old, '#/create');
    expect(await old.isDisabled('[data-create-begin]'), 'create disabled');
  });

  await step('no console errors, CSP violations or requests to other sites', async () => {
    const all = [...problems, ...problems2, ...problems3, ...problems4];
    expect(all.length === 0, all.join('\n'));
  });

  await step('accessibility: no axe violations (WCAG 2.2 AA rules)', async () => {
    expect(a11y.length === 0, a11y.join('\n'));
  });

  await context.close();
  await context2.close();
  await context3.close();
  await context4.close();
  console.log(`\ne2e: ${failures ? `${failures} failed` : 'all passed'}`);
  return failures;
}
