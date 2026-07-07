import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';
import { parseSimpleEmailFile } from '../src/test-single-run.js';

test('parseSimpleEmailFile wyciąga nagłówki i treść z przykładowego maila', async () => {
  const raw = await readFile('./data/przykladowy-mail.txt', 'utf-8');
  const { from, subject, text } = parseSimpleEmailFile(raw);

  assert.match(from, /Anna Wiśniewska/);
  assert.match(subject, /Zapytanie o pobyt/);
  assert.match(text, /pokoju dwuosobowego/);
  assert.ok(!text.includes('Subject:'), 'treść nie powinna zawierać nagłówków');
});

test('parseSimpleEmailFile nie wybucha na pliku bez pustej linii', () => {
  const { from, subject, text } = parseSimpleEmailFile('samo body bez nagłówków');
  assert.equal(from, 'nieznany');
  assert.equal(subject, '(brak tematu)');
  assert.equal(text, 'samo body bez nagłówków');
});
