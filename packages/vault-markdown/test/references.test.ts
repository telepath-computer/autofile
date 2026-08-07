import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isReference } from '../src/references.ts';

describe('isReference', () => {
  it('recognises a value with a string $ref', () => {
    const value: unknown = { $ref: 'contacts/priya-narayan' };

    assert.equal(isReference(value), true);
    if (isReference(value)) assert.equal(value.$ref, 'contacts/priya-narayan');
  });

  it('does not recognise one carrying anything alongside its $ref', () => {
    // A form that dropped what it could not represent would lose it silently,
    // so an object carrying more than a $ref is ordinary data.
    assert.equal(isReference({ $ref: 'contacts/priya-narayan', label: 'Priya' }), false);
    assert.equal(isReference({ label: 'Priya', $ref: 'contacts/priya-narayan' }), false);
    assert.equal(isReference({ $ref: 'contacts/priya-narayan', label: undefined }), false);
  });

  it('recognises one whose $ref is not spelled as an identity', () => {
    // Shape alone says it is a reference; whether it points anywhere is a
    // separate question, and a check that answers it needs the reference first.
    assert.equal(isReference({ $ref: '/contacts/priya-narayan' }), true);
    assert.equal(isReference({ $ref: '' }), true);
  });

  it('recognises one with no prototype', () => {
    const value = Object.create(null) as { $ref: string };
    value.$ref = 'contacts/priya-narayan';

    assert.equal(isReference(value), true);
  });

  it('does not recognise a plain string, even one spelled as an identity', () => {
    assert.equal(isReference('contacts/priya-narayan'), false);
  });

  it('does not recognise a $ref that is not a string', () => {
    assert.equal(isReference({ $ref: 3 }), false);
    assert.equal(isReference({ $ref: null }), false);
    assert.equal(isReference({ $ref: { $ref: 'contacts/priya-narayan' } }), false);
  });

  it('does not recognise an object without a $ref', () => {
    assert.equal(isReference({}), false);
    assert.equal(isReference({ ref: 'contacts/priya-narayan' }), false);
  });

  it('does not recognise an object of some other kind', () => {
    // Having no $ref of its own is what settles each of these, rather than
    // anything about the kind: an object is only a reference when it says so.
    assert.equal(isReference(new Date()), false);
    assert.equal(isReference(new Map([['$ref', 'contacts/priya-narayan']])), false);
    assert.equal(isReference(new Error('contacts/priya-narayan')), false);
  });

  it('does not recognise an array, whatever it carries', () => {
    // An array is a value a reference sits inside rather than one itself, so a
    // $ref hung on the array is not a reference either.
    const array: unknown[] & { $ref?: string } = [];
    array.$ref = 'contacts/priya-narayan';

    assert.equal(isReference(array), false);
    assert.equal(isReference([]), false);
    assert.equal(isReference([{ $ref: 'events/2026-06-02-zine-paper-chat' }]), false);
  });

  it('does not recognise a $ref reached through the prototype chain', () => {
    // A field's value is what a vault read back, and nothing parsed from JSON
    // or YAML inherits. So a reference carries its own $ref.
    assert.equal(isReference(Object.create({ $ref: 'contacts/priya-narayan' })), false);

    const own = Object.create({ $ref: 'contacts/someone-else' }) as { $ref: string };
    own.$ref = 'contacts/priya-narayan';
    assert.equal(isReference(own), true);
  });

  it('does not recognise the value a reference is nested in', () => {
    // A reference may sit at any depth in a field's value, so a caller walks
    // the value and asks about each part; the parts holding one are not it.
    assert.equal(isReference({ related: { $ref: 'contacts/priya-narayan' } }), false);
  });

  it('does not recognise anything that is not an object', () => {
    for (const value of [null, undefined, 3, true, false, '', Symbol('$ref')]) {
      assert.equal(isReference(value), false, String(value?.toString()));
    }
  });
});
