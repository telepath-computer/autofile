import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { splitIdentity } from './identity.ts';

/** Asserts every one of the given spellings is not an identity. */
function rejects(...ids: string[]): void {
  for (const id of ids) assert.equal(splitIdentity(id), null, `expected ${JSON.stringify(id)}`);
}

describe('splitIdentity', () => {
  it('splits an identity into its collection and key', () => {
    assert.deepEqual(splitIdentity('contacts/priya-narayan'), {
      collection: 'contacts',
      key: 'priya-narayan',
    });
  });

  it('takes everything before the first slash as the collection and the rest as the key', () => {
    assert.deepEqual(splitIdentity('people/family/priya-narayan'), {
      collection: 'people',
      key: 'family/priya-narayan',
    });
    assert.deepEqual(splitIdentity('blobs/assets/site/index.html'), {
      collection: 'blobs',
      key: 'assets/site/index.html',
    });
  });

  it('returns the collection and key exactly as they were given', () => {
    // Splitting is the whole of it: nothing here trims, folds case or
    // normalises unicode, so a caller gets back what it passed in and two
    // spellings stay two identities.
    assert.deepEqual(splitIdentity('  Contacts  /  Priya Narayan  '), {
      collection: '  Contacts  ',
      key: '  Priya Narayan  ',
    });
    assert.deepEqual(splitIdentity('CONTACTS/Priya-NARAYAN'), {
      collection: 'CONTACTS',
      key: 'Priya-NARAYAN',
    });
    assert.deepEqual(splitIdentity('日記/2026-08-06-晴れ'), {
      collection: '日記',
      key: '2026-08-06-晴れ',
    });

    // The same name in both unicode normal forms: one accented codepoint, and
    // a letter followed by a combining acute. They are different strings, so a
    // key in one is not the key in the other and neither becomes the other.
    const name = 'josé-nuñez';
    const composed = name.normalize('NFC');
    const decomposed = name.normalize('NFD');
    assert.notEqual(composed, decomposed, 'the two normal forms must differ');
    assert.deepEqual(splitIdentity(`kontakte/${composed}`), {
      collection: 'kontakte',
      key: composed,
    });
    assert.deepEqual(splitIdentity(`kontakte/${decomposed}`), {
      collection: 'kontakte',
      key: decomposed,
    });
  });

  it('does not decode percent-encoding', () => {
    // `%2F` is three characters in a key, not a slash. A consumer that receives
    // an identity escaped — a URL path — unescapes what it received before it
    // has an identity to split.
    assert.deepEqual(splitIdentity('contacts/priya%2Fnarayan'), {
      collection: 'contacts',
      key: 'priya%2Fnarayan',
    });
    assert.deepEqual(splitIdentity('blobs/holiday%20photo.jpg'), {
      collection: 'blobs',
      key: 'holiday%20photo.jpg',
    });
    // Decoded this would be `contacts/priya-narayan`; as written it holds no
    // slash and so is no identity at all.
    rejects('contacts%2Fpriya-narayan');
  });

  it('accepts a key that no file could be named', () => {
    // A key is a string rather than a path, so segments a filesystem would
    // refuse are still a key here. What a vault storing keys as file paths
    // will not accept is that vault's rule.
    assert.deepEqual(splitIdentity('contacts/.'), { collection: 'contacts', key: '.' });
    assert.deepEqual(splitIdentity('contacts/..'), { collection: 'contacts', key: '..' });
    assert.deepEqual(splitIdentity('contacts/./priya-narayan'), {
      collection: 'contacts',
      key: './priya-narayan',
    });
    assert.deepEqual(splitIdentity('contacts/../priya-narayan'), {
      collection: 'contacts',
      key: '../priya-narayan',
    });
    assert.deepEqual(splitIdentity('contacts//priya-narayan'), {
      collection: 'contacts',
      key: '/priya-narayan',
    });
    assert.deepEqual(splitIdentity('contacts/priya-narayan/'), {
      collection: 'contacts',
      key: 'priya-narayan/',
    });
    assert.deepEqual(splitIdentity('blobs/priya-narayan.jpg'), {
      collection: 'blobs',
      key: 'priya-narayan.jpg',
    });
  });

  it('accepts a collection name that begins with a dot', () => {
    // A collection's name is non-empty and contains no `/`, and that is all.
    assert.deepEqual(splitIdentity('.hidden/priya-narayan'), {
      collection: '.hidden',
      key: 'priya-narayan',
    });
    assert.deepEqual(splitIdentity('./contacts/priya-narayan'), {
      collection: '.',
      key: 'contacts/priya-narayan',
    });
    assert.deepEqual(splitIdentity('../contacts/priya-narayan'), {
      collection: '..',
      key: 'contacts/priya-narayan',
    });
  });

  it('rejects an empty string', () => {
    rejects('');
  });

  it('rejects a bare collection name with no key', () => {
    rejects('contacts', '.hidden');
  });

  it('rejects an empty key', () => {
    rejects('contacts/');
  });

  it('rejects an empty collection', () => {
    // Everything before the first slash is the collection, so a leading slash
    // leaves nothing to name one.
    rejects('/', '/contacts/priya-narayan', '//contacts/priya-narayan');
  });
});
