import test from 'node:test';
import assert from 'node:assert/strict';
import { I18N, LANGS } from '../cloud/public/i18n.js';
import { describe } from '../cloud/public/policy.js';

test('every language defines the same keys with the same kinds of values', () => {
  const base = I18N[LANGS[0]];
  for (const lang of LANGS) {
    assert.deepEqual(Object.keys(I18N[lang]).sort(), Object.keys(base).sort(), lang);
    for (const k of Object.keys(base)) {
      assert.equal(typeof I18N[lang][k], typeof base[k], `${lang}.${k}`);
      if (typeof base[k] === 'function') assert.equal(I18N[lang][k].length, base[k].length, `${lang}.${k} arity`);
      if (typeof base[k] === 'string') assert.ok(I18N[lang][k].length > 0, `${lang}.${k} empty`);
    }
  }
});

test('rule text exists in every language and mentions the bounds', () => {
  for (const lang of LANGS) {
    const text = describe({ tMin: 24.5, tMax: 25.5 }, lang);
    assert.ok(text.includes('25.5') && text.includes('24.5'), lang);
  }
});
