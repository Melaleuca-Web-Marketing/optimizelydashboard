const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveFields, customFields, designUrl } = require('../fields');

test('optional design field prefers Optimizely and falls back independently when empty or invalid', () => {
  const figma = 'https://www.figma.com/design/abc/Example?node-id=1-2';
  const xd = 'https://xd.adobe.com/view/example/';
  const item = { apiName: 'Campaign', customFields: { design: figma } };
  const saved = { design: xd, updatedAt: '2026-11-11' };
  assert.equal(resolveFields(item, saved).design, figma);
  assert.equal(resolveFields(item, saved).sources.design, 'Optimizely');
  for (const value of ['', null, '   ']) {
    const result = resolveFields({ ...item, customFields: { design: value } }, saved);
    assert.equal(result.design, xd);
    assert.equal(result.sources.design, 'Local fallback');
    assert.deepEqual(result.warnings, []);
  }
  for (const value of ['javascript:alert(1)', 'http://figma.com/file/a', 'https://user:password@figma.com/', {}, 'not a link']) {
    assert.equal(designUrl(value), '');
    const result = resolveFields({ ...item, customFields: { design: value } }, saved);
    assert.equal(result.design, xd);
    assert.equal(result.warnings.length, 1);
  }
  assert.equal(resolveFields({ apiName: 'Campaign' }).design, '');
  assert.deepEqual(resolveFields({ apiName: 'Campaign' }).warnings, []);
});

test('design is retained from the campaign or a consistent experience value', () => {
  const design = 'https://xd.adobe.com/view/example/';
  assert.equal(customFields({ custom_field_values: { design } }, []).values.design, design);
  assert.equal(customFields({}, [{ custom_field_values: { design } }]).values.design, design);
  const conflict = customFields({}, [{ custom_field_values: { design } }, { custom_field_values: { design: 'https://figma.com/file/other' } }]);
  assert.equal(conflict.values.design, undefined);
  assert.equal(conflict.warnings.length, 1);
});
