// Loads every test module, runs them, and reports to the page (and to the
// Playwright runner through window.__SEAL_TESTS__).
import { runAll } from './harness.js';

const modules = [
  './core.test.js',
  './manifest.test.js',
  './seal-verify.test.js',
  './text.test.js',
  './png.test.js',
];

const summary = document.getElementById('summary');
const list = document.getElementById('results');
const filter = new URLSearchParams(location.search).get('filter') || '';

window.__SEAL_TESTS__ = { done: false, results: [] };

try {
  for (const m of modules) await import(m);
  const results = await runAll({
    filter,
    onResult(r) {
      const li = document.createElement('li');
      li.className = r.ok ? 'pass' : 'fail';
      li.textContent = `${r.ok ? '✓' : '✗'} ${r.name} (${r.ms} ms)`;
      if (!r.ok) {
        const pre = document.createElement('pre');
        pre.textContent = r.error;
        li.append(pre);
      }
      list.append(li);
    },
  });
  const failed = results.filter((r) => !r.ok).length;
  summary.textContent = `${results.length - failed} passed, ${failed} failed`;
  window.__SEAL_TESTS__ = { done: true, results };
} catch (error) {
  summary.textContent = 'Test run crashed: ' + error;
  window.__SEAL_TESTS__ = { done: true, results: [{ name: 'test loader', ok: false, error: String(error.stack || error) }] };
}
