import assert from 'node:assert/strict';
import test from 'node:test';

import { parseStoreCsv } from './csvService.js';

const header = 'store_id,store_name,address,city,state,country';

test('parses valid CSV rows including quoted commas', () => {
  const stores = parseStoreCsv(
    `${header}\nST001,"North, Central","12 Main St",Delhi,Delhi,India`,
  );
  assert.equal(stores.length, 1);
  assert.equal(stores[0].store_name, 'North, Central');
});

test('rejects missing required CSV headers', () => {
  assert.throws(
    () => parseStoreCsv('store_id,store_name\nST001,Example'),
    /missing required columns: address, city, state, country/,
  );
});

test('rejects duplicate store IDs', () => {
  assert.throws(
    () =>
      parseStoreCsv(
        `${header}\nST001,One,1 Main,Delhi,Delhi,India\nST001,Two,2 Main,Delhi,Delhi,India`,
      ),
    /Duplicate store_id "ST001"/,
  );
});

test('rejects duplicate required headers', () => {
  assert.throws(
    () =>
      parseStoreCsv(
        `${header},store_id\nST001,One,1 Main,Delhi,Delhi,India,ST002`,
      ),
    /duplicate required column: store_id/,
  );
});

test('rejects empty required fields with the input row number', () => {
  assert.throws(
    () => parseStoreCsv(`${header}\nST001,,1 Main,Delhi,Delhi,India`),
    /row 2: store_name must be non-empty/,
  );
});
