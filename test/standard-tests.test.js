const test = require('node:test');
const assert = require('node:assert/strict');

const { STANDARD_TESTS } = require('../src/standard-tests');

test('standard catalog contains unique, usable tests and the requested profiles', () => {
  assert.ok(STANDARD_TESTS.length >= 80);
  const names = STANDARD_TESTS.map(item => item.name.toLowerCase());
  assert.equal(new Set(names).size, names.length, 'test names must be unique');
  assert.ok(names.includes('liver function test (lft)'));
  assert.ok(names.includes('kidney function test (kft)'));
  assert.ok(names.includes('cbc (complete blood count)'));
  for (const item of STANDARD_TESTS) {
    assert.ok(item.name.length >= 2);
    assert.ok(item.category.length >= 2);
    assert.ok(Number.isFinite(item.amount) && item.amount >= 0);
  }
});
