// A very small test harness that runs in the browser.

const registry = [];
let prefix = '';

export function describe(name, fn) {
  const saved = prefix;
  prefix = prefix ? `${prefix} › ${name}` : name;
  fn();
  prefix = saved;
}

export function test(name, fn, { timeout = 60000 } = {}) {
  registry.push({ name: prefix ? `${prefix} › ${name}` : name, fn, timeout });
}

export class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
  }
}

const show = (v) => {
  if (v instanceof Uint8Array) return `Uint8Array(${v.length})[${Array.from(v.slice(0, 16)).join(',')}${v.length > 16 ? ',…' : ''}]`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return a.length === b.length && a.every((x, i) => x === b[i]);
  }
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

export const assert = {
  ok(value, message = 'expected a truthy value') {
    if (!value) throw new AssertionError(message);
  },
  equal(actual, expected, message) {
    if (!Object.is(actual, expected)) {
      throw new AssertionError(`${message ? message + ': ' : ''}expected ${show(expected)}, got ${show(actual)}`);
    }
  },
  notEqual(actual, unexpected, message) {
    if (Object.is(actual, unexpected)) throw new AssertionError(`${message ? message + ': ' : ''}did not expect ${show(actual)}`);
  },
  deepEqual(actual, expected, message) {
    if (!deepEqual(actual, expected)) {
      throw new AssertionError(`${message ? message + ': ' : ''}expected ${show(expected)}, got ${show(actual)}`);
    }
  },
  match(text, pattern, message) {
    if (!pattern.test(text)) throw new AssertionError(`${message ? message + ': ' : ''}${show(text)} does not match ${pattern}`);
  },
  throws(fn, pattern, message) {
    try {
      fn();
    } catch (error) {
      if (pattern && !pattern.test(String(error && error.message))) {
        throw new AssertionError(`${message ? message + ': ' : ''}error "${error.message}" does not match ${pattern}`);
      }
      return error;
    }
    throw new AssertionError(message || 'expected function to throw');
  },
  async rejects(fnOrPromise, pattern, message) {
    try {
      await (typeof fnOrPromise === 'function' ? fnOrPromise() : fnOrPromise);
    } catch (error) {
      if (pattern && !pattern.test(String(error && error.message))) {
        throw new AssertionError(`${message ? message + ': ' : ''}error "${error.message}" does not match ${pattern}`);
      }
      return error;
    }
    throw new AssertionError(message || 'expected promise to reject');
  },
};

export async function runAll({ onResult = () => {}, filter = '' } = {}) {
  const results = [];
  for (const t of registry) {
    if (filter && !t.name.includes(filter)) continue;
    const started = performance.now();
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(t.fn),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${t.timeout} ms`)), t.timeout);
        }),
      ]);
      results.push({ name: t.name, ok: true, ms: Math.round(performance.now() - started) });
    } catch (error) {
      results.push({
        name: t.name,
        ok: false,
        ms: Math.round(performance.now() - started),
        error: String((error && error.stack) || error),
      });
    } finally {
      clearTimeout(timer);
    }
    onResult(results[results.length - 1]);
  }
  return results;
}
