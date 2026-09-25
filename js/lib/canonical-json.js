// Canonical JSON: object keys sorted, no whitespace, UTF-8.
//
// Rules (also written down in docs/FORMAT.md):
//  - objects: keys sorted by UTF-16 code units (JavaScript's default sort,
//    the same order as RFC 8785); every key serialized with JSON.stringify
//  - strings: JSON.stringify escaping (ECMAScript 2019+, well-formed)
//  - numbers: safe integers only (no fractions, no exponents, no -0 issues)
//  - true, false and null as usual; arrays keep their order
//  - anything else (undefined, functions, NaN, dates, ...) is an error
// For the key sets and values SEAL uses this matches RFC 8785 (JCS).

import { utf8Encode } from './bytes.js';

export function canonicalize(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isSafeInteger(value)) throw new TypeError('Canonical JSON only allows safe integers');
      return String(value === 0 ? 0 : value);
    case 'object': {
      if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new TypeError('Canonical JSON only allows plain objects');
      const keys = Object.keys(value).sort();
      return '{' + keys.map((k) => {
        if (value[k] === undefined) throw new TypeError(`Undefined value for key ${k}`);
        return JSON.stringify(k) + ':' + canonicalize(value[k]);
      }).join(',') + '}';
    }
    default:
      throw new TypeError(`Canonical JSON cannot encode ${typeof value}`);
  }
}

export function canonicalBytes(value) {
  return utf8Encode(canonicalize(value));
}
