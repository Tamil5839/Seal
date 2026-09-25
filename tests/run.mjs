// Runs the browser test suite (and the end-to-end UI tests) in headless
// Chromium using Playwright.
//   node tests/run.mjs            unit + e2e
//   node tests/run.mjs --unit     unit tests only
//   node tests/run.mjs --e2e      end-to-end tests only
//   node tests/run.mjs --filter=PNG
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';

const args = process.argv.slice(2);
const onlyUnit = args.includes('--unit');
const onlyE2e = args.includes('--e2e');
const filter = (args.find((a) => a.startsWith('--filter=')) || '').slice('--filter='.length);

const server = await startServer();
const browser = await chromium.launch();
let failures = 0;

try {
  if (!onlyE2e) {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('page error:', e));
    await page.goto(`${server.url}/tests/index.html${filter ? `?filter=${encodeURIComponent(filter)}` : ''}`);
    await page.waitForFunction(() => window.__SEAL_TESTS__ && window.__SEAL_TESTS__.done, null, { timeout: 600000 });
    const results = await page.evaluate(() => window.__SEAL_TESTS__.results);
    for (const r of results) {
      console.log(`${r.ok ? '  ok  ' : ' FAIL '} ${r.name}${r.ok ? '' : '\n' + r.error}`);
    }
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\nunit: ${results.length - failed} passed, ${failed} failed`);
    failures += failed;
    await page.close();
  }
  if (!onlyUnit) {
    const { runE2E } = await import('./e2e.mjs');
    failures += await runE2E({ browser, baseUrl: server.url, filter });
  }
} finally {
  await browser.close();
  await server.close();
}

process.exit(failures ? 1 : 0);
