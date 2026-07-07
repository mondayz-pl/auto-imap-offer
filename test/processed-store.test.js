import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { openStore } from '../src/processed-store.js';

async function withTempStore(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'oferta-bot-test-'));
  try {
    await fn(path.join(dir, 'store.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('nowy rejestr: nic nie jest przetworzone, startDate ustawione', async () => {
  await withTempStore(async (storePath) => {
    const store = await openStore(storePath);
    assert.equal(store.isProcessed(42), false);
    assert.ok(new Date(store.getStartDate()).getTime() <= Date.now());
  });
});

test('markProcessed + zapis przeżywa ponowne otwarcie', async () => {
  await withTempStore(async (storePath) => {
    const store = await openStore(storePath);
    store.syncUidValidity('111');
    store.markProcessed(42);
    await store.save();

    const reopened = await openStore(storePath);
    assert.equal(reopened.isProcessed(42), true);
    assert.equal(reopened.isProcessed(43), false);
    // startDate nie może się zmienić przy ponownym otwarciu
    assert.equal(reopened.getStartDate(), store.getStartDate());
  });
});

test('recordFailure liczy próby, markProcessed je zeruje', async () => {
  await withTempStore(async (storePath) => {
    const store = await openStore(storePath);
    assert.equal(store.recordFailure(7), 1);
    assert.equal(store.recordFailure(7), 2);
    assert.equal(store.recordFailure(7), 3);

    store.markProcessed(7);
    assert.equal(store.recordFailure(7), 1, 'po markProcessed licznik ma startować od nowa');
  });
});

test('zmiana UIDVALIDITY czyści rejestr UID-ów', async () => {
  await withTempStore(async (storePath) => {
    const store = await openStore(storePath);
    store.syncUidValidity('111');
    store.markProcessed(42);
    await store.save();

    const reopened = await openStore(storePath);
    reopened.syncUidValidity('222'); // serwer przenumerował skrzynkę
    assert.equal(reopened.isProcessed(42), false);
  });
});

test('uszkodzony plik JSON nie wywala bota - rejestr startuje od zera', async () => {
  await withTempStore(async (storePath) => {
    const { writeFile, mkdir } = await import('fs/promises');
    await mkdir(path.dirname(storePath), { recursive: true });
    await writeFile(storePath, '{to nie jest json', 'utf-8');

    const store = await openStore(storePath);
    assert.equal(store.isProcessed(1), false);
    store.markProcessed(1);
    await store.save();

    const reopened = await openStore(storePath);
    assert.equal(reopened.isProcessed(1), true);
  });
});

test('BigInt uidValidity z imapflow jest obsługiwane', async () => {
  await withTempStore(async (storePath) => {
    const store = await openStore(storePath);
    store.syncUidValidity(123n); // imapflow zwraca BigInt
    store.markProcessed(5);
    await store.save();

    const reopened = await openStore(storePath);
    reopened.syncUidValidity(123n);
    assert.equal(reopened.isProcessed(5), true);
  });
});
