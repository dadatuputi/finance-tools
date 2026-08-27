'use strict';

// Converter tests: selecting files, combining them, and what gets downloaded.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {loadConverter} = require('./helpers/harness');

const ALL_FIXTURES = ['v2026-06-statement.pdf', 'v2025-12-statement.pdf', 'v2026-06-with-fees.pdf', 'v2026-06-no-activity.pdf'];

test('several statements become one CSV', async (t) => {
    const app = loadConverter();
    app.select(ALL_FIXTURES);
    await app.process();

    await t.test('every transaction from every statement is included', () => {
        assert.strictEqual(app.transactions.length, 9);
    });

    await t.test('they are ordered by date across statements', () => {
        assert.deepStrictEqual(app.transactions.map(transaction => transaction.Date), [
            '2025-12-05', '2025-12-12', '2026-01-05', '2026-07-06', '2026-07-08',
            '2026-07-10', '2026-07-12', '2026-07-20', '2026-07-25'
        ]);
    });

    await t.test('the summary names a statement that yielded nothing', () => {
        assert.match(app.nodes.csvSummary.text, /9 transactions from 4 PDFs/);
        assert.match(app.nodes.csvSummary.text, /v2026-06-no-activity\.pdf: no transactions found/);
    });

    await t.test('a combined download is named for its date range', () => {
        assert.strictEqual(app.call('csvFileName'), 'milstar_2025-12-05_to_2026-07-25.csv');
    });

    await t.test('the CSV keeps the columns budgeting software expects', () => {
        app.call('downloadCsv');
        const [csv] = app.downloads;
        const lines = csv.split('\n');

        assert.strictEqual(lines[0], 'Date,Memo,Payee,Outflow');
        assert.strictEqual(lines.length, 10); // header + 9
        assert.strictEqual(lines[1], '"2025-12-05","Charge: 200000000000001","EXAMPLE-STORE.com","$60.00"');
    });
});

test('a single statement keeps its own name', async () => {
    const app = loadConverter();
    app.select(['v2026-06-statement.pdf']);
    await app.process();

    assert.strictEqual(app.call('csvFileName'), 'v2026-06-statement.csv');
});

test('selecting the same file twice adds it once', () => {
    const app = loadConverter();

    app.select(['v2026-06-statement.pdf', 'v2025-12-statement.pdf']);
    app.select(['v2026-06-statement.pdf']);

    assert.deepStrictEqual(app.pdfFiles.map(file => file.name),
        ['v2026-06-statement.pdf', 'v2025-12-statement.pdf']);
});

test('changing the selection clears the CSV it no longer matches', async () => {
    const app = loadConverter();
    app.select(['v2026-06-statement.pdf', 'v2025-12-statement.pdf']);
    await app.process();
    assert.strictEqual(app.transactions.length, 7);
    assert.strictEqual(app.nodes.downloadCsv.disabled, false);

    app.call('removeFile', 1);

    assert.strictEqual(app.pdfFiles.length, 1);
    assert.strictEqual(app.transactions.length, 0);
    assert.strictEqual(app.nodes.downloadCsv.disabled, true, 'stale CSV must not stay downloadable');
});

test('a statement that cannot be read is reported, not thrown', async () => {
    const app = loadConverter();
    app.call('addFiles', [{
        name: 'not-really-a.pdf',
        size: 4,
        type: 'application/pdf',
        arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer
    }]);
    await app.process();

    assert.strictEqual(app.transactions.length, 0);
    assert.match(app.nodes.csvSummary.text, /not-really-a\.pdf: could not be read/);
});

// The parser reads element ids and the page supplies them; a change to either alone
// breaks the tool silently in the browser
test('the page and the converter still agree', async (t) => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'docs', 'milstar', 'index.html'), 'utf8');
    const script = fs.readFileSync(path.join(__dirname, '..', 'docs', 'static', 'convert_milstar.js'), 'utf8');

    await t.test('the page provides every element the converter looks up', () => {
        const ids = [...script.matchAll(/getElementById\('([^']+)'\)/g)].map(match => match[1]);
        assert.ok(ids.length >= 8, `expected the converter to look up several elements, found ${ids.length}`);

        ids.forEach(id => assert.match(html, new RegExp(`id="${id}"`), `#${id} is missing from the page`));
    });

    await t.test('the file input accepts more than one statement', () => {
        assert.match(html, /<input[^>]*id="pdfInput"[^>]*\smultiple[\s/>]/);
    });
});
