import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPricing, formatPricingForPrompt } from '../src/pricing.js';

test('loadPricing wczytuje przykładowy cennik z poprawnymi polami', async () => {
  const pricing = await loadPricing('./data/cennik.csv');

  assert.ok(pricing.length > 30, `oczekiwano >30 pozycji, jest ${pricing.length}`);

  for (const row of pricing) {
    assert.ok(row.kategoria, `brak kategorii w wierszu: ${JSON.stringify(row)}`);
    assert.ok(row.usluga, `brak usługi w wierszu: ${JSON.stringify(row)}`);
    assert.ok(!Number.isNaN(row.cena_netto), `cena_netto nie jest liczbą: ${JSON.stringify(row)}`);
  }
});

test('loadPricing radzi sobie z cytowanymi polami zawierającymi przecinki', async () => {
  const pricing = await loadPricing('./data/cennik.csv');
  const wesele = pricing.find((p) => p.usluga === 'Przyjęcie weselne');

  assert.ok(wesele, 'brak pozycji "Przyjęcie weselne"');
  assert.equal(wesele.cena_netto, 420);
  assert.match(wesele.opis, /bez alkoholu/i);
});

test('formatPricingForPrompt buduje czytelne linie dla modelu', async () => {
  const pricing = await loadPricing('./data/cennik.csv');
  const text = formatPricingForPrompt(pricing);

  assert.match(text, /\[Noclegi\]/);
  assert.match(text, /zł netto/);
  assert.equal(text.split('\n').length, pricing.length);
});
