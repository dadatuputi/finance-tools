#!/usr/bin/env node
'use strict';

// Builds the statement PDFs the tests parse.
//
// There is one fixture per statement version MyECP has been seen to produce, named for
// the earliest statement we have in that layout, plus a few variants. When a new
// statement stops parsing, add the version it came from here and regenerate - see
// test/fixtures/README.md.
//
// The fixtures contain no real statement data. Names, addresses, account numbers,
// merchants and reference numbers are invented, and so are the dates and amounts -
// a real statement's transaction dates and amounts are someone's purchase history
// just as much as their name is. Every amount here is a round number of dollars,
// which no real statement is full of; test/statements.test.js enforces that, so
// anything copied from a real statement fails the suite.
//
// What the fixtures do reproduce is the *geometry* of a real statement - column
// positions, the separate whitespace fragment between each column, the two-column
// front page, and each version's quirks. Geometry is what the parser reads, so that is
// what has to be real.
//
// Regenerate with: npm run fixtures

const fs = require('fs');
const path = require('path');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const FONT_SIZE = 8;

// Column positions, taken from real statements. Identical across versions so far.
const COL = {date: 54.6, description: 114.4, reference: 261.2, reference2: 323.7, location: 392.1, amount: 559.3};
const SUMMARY_LABEL = 373.4;
const SUMMARY_VALUE = 563.5;

// The statement layouts seen so far, each named for the earliest statement we have in
// that layout. Only the generator's own changes get a version - things it varies from
// statement to statement, like dropping the Reference # column when nothing has one,
// are variants of a version rather than versions of their own.
const VERSIONS = {
    // Seen December 2025 through March 2026
    'v2025-12': {
        splitHeadings: false,  // headings are drawn as one text fragment
        referenceValues: 1     // the Reference # column holds the reference number only
    },
    // Seen from June 2026. Both of these broke the parser that shipped before them: it
    // looked for the literal "Interest Charge Calculations" to find the end of the
    // table, and allowed a single value in the reference column.
    'v2026-06': {
        splitHeadings: true,   // a heading's first letter is its own text fragment
        referenceValues: 2     // reference number, then the purchase date as DDMMYYYY
    }
};

// --- Minimal PDF writer -----------------------------------------------------------

const escape = text => text.replace(/([\\()])/g, '\\$1');

// One BT/ET per fragment, each with its own text matrix, so PDF.js reports one text
// item per fragment - as the real statements do.
function contentStream(fragments) {
    return fragments
        .map(([x, y, text]) => `BT /F1 ${FONT_SIZE} Tf 1 0 0 1 ${x} ${y} Tm (${escape(text)}) Tj ET`)
        .join('\n');
}

function writePdf(pages) {
    const objects = [];
    const add = body => objects.push(body) && objects.length; // returns the object number

    const catalogId = 1, pagesId = 2, fontId = 3;
    objects.length = 3; // reserved, filled in below

    const kids = pages.map(fragments => {
        const contents = contentStream(fragments);
        const contentId = add(`<< /Length ${contents.length} >>\nstream\n${contents}\nendstream`);
        return add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] ` +
            `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    });

    objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map(id => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    objects[fontId - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

    let pdf = '%PDF-1.4\n';
    const offsets = [];
    objects.forEach((body, index) => {
        offsets.push(pdf.length);
        pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });

    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    offsets.forEach(offset => { pdf += `${String(offset).padStart(10, '0')} 00000 n \n`; });
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

    return Buffer.from(pdf, 'latin1');
}

// --- Statement building blocks ----------------------------------------------------

// Statements separate every column with its own whitespace fragment
const spacer = (x, y) => [x, y, ' '];

// v2 draws some headings with the first letter as a separate fragment. The generator
// emits the rest of the heading first and then goes back to draw that letter, which is
// what makes PDF.js report the two as separate text items rather than joining them -
// so the order these are drawn in matters, not just their positions.
const heading = (x, y, text, version) => version.splitHeadings
    ? [[x + 3, y, text.slice(1)], [x, y, text.slice(0, 1)]]
    : [[x, y, text]];

const headingKey = {'Date': 'date', 'Description': 'description', 'Reference #': 'reference',
                    'Location': 'location', 'Amount': 'amount'};

function summaryPage({version, debits, credits, fees}) {
    const rows = [
        ['Account Summary', null],
        ['Previous Balance', '$0.00'],
        ['Purchases/Other Debits', debits],
        ['Payments/Other Credits', credits],
        ['Fees Charged', fees],
        ['Interest Charged', '$0.00'],
        ['New Balance', debits]
    ];

    const fragments = [];
    rows.forEach(([label, value], index) => {
        const y = 648.8 - index * 11.5;
        fragments.push([SUMMARY_LABEL, y, label]);
        if (value === null) return;
        fragments.push(spacer(SUMMARY_LABEL + 70, y), [SUMMARY_VALUE, y, value]);

        // Page 1 is two columns wide: an unrelated paragraph shares this baseline. It
        // is why a summary label cannot be read off a whole row of fragments.
        if (label === 'Payments/Other Credits') {
            fragments.push([60.0, y, 'Late Payment Warning: Payment reversals/returned checks may require']);
        }
    });

    fragments.push(...heading(60.0, 500.0, 'Payment Information', version));
    return fragments;
}

function tableHeader(names, y) {
    return names.flatMap(name => [[COL[headingKey[name]], y, name], spacer(COL[headingKey[name]] + 25, y)]);
}

function tableRow(row, y) {
    return Object.entries(row)
        .filter(([, value]) => value !== null && value !== undefined)
        .flatMap(([key, value]) => [[COL[key], y, value], spacer(COL[key] + 25, y)]);
}

function transactionsPage({version, columns, rows, feeRows}) {
    const fragments = [];
    let y = 711.3;

    fragments.push(...heading(COL.date, y, 'Transactions', version));
    y -= 14;
    fragments.push(...tableHeader(columns, y));
    y -= 9.6;

    rows.forEach(row => { fragments.push(...tableRow(row, y)); y -= 9.7; });

    y -= 7;
    fragments.push(...heading(COL.date, y, 'Interest Charge Calculations', version));
    y -= 13;
    fragments.push([COL.date, y, 'Your Annual Percentage Rate (APR) is the annual interest rate on your account.']);

    // Content below the table that must not be mistaken for transactions
    y -= 42;
    fragments.push([53.9, y, 'Exchange Retail'], spacer(120, y), [399.8, y, '0.00%(v)'],
                   spacer(441, y), [496.7, y, '$0.00'], spacer(520, y), [570.7, y, '$0.00']);
    y -= 50;
    fragments.push([222.0, y, '2026 Year to Date Fees'], spacer(324, y), [405.8, y, '$0.00']);

    if (feeRows) {
        y -= 30;
        fragments.push(...heading(COL.date, y, 'Fees', version));
        y -= 14;
        fragments.push(...tableHeader(['Date', 'Description', 'Amount'], y));
        y -= 9.6;
        feeRows.forEach(row => { fragments.push(...tableRow(row, y)); y -= 9.7; });
        fragments.push([COL.date, y, 'Total Fees for This Period'], spacer(200, y), [COL.amount, y, total(feeRows)]);
    }

    y -= 30;
    fragments.push(...heading(COL.date, y, 'Important Notices', version));
    return fragments;
}

const total = rows => {
    const cents = rows.reduce((sum, row) => sum + Math.round(parseFloat(row.amount.replace(/[$,]/g, '')) * 100), 0);
    return `$${(cents / 100).toFixed(2)}`;
};

const ALL_COLUMNS = ['Date', 'Description', 'Reference #', 'Location', 'Amount'];

// --- The fixtures -----------------------------------------------------------------

const FIXTURE_FILES = {
    // One statement per version. These are the fixtures that guard against a repeat of
    // the format changes that have broken the parser before.
    'v2025-12-statement.pdf': [
        summaryPage({version: VERSIONS['v2025-12'], debits: '$60.00', credits: '-$60.00', fees: '$0.00'}),
        transactionsPage({
            version: VERSIONS['v2025-12'],
            columns: ALL_COLUMNS,
            rows: [
                {date: '05 Dec 2025', description: 'Charge', reference: '200000000000001', location: 'EXAMPLE-STORE.com', amount: '$60.00'},
                {date: '12 Dec 2025', description: 'Return', reference: '200000000000002', location: 'EXAMPLE MERCHANT', amount: '-$20.00'},
                {date: '05 Jan 2026', description: 'ACH Online Pymt', location: 'ECP Payment', amount: '-$40.00'}
            ]
        })
    ],

    'v2026-06-statement.pdf': [
        summaryPage({version: VERSIONS['v2026-06'], debits: '$90.00', credits: '-$100.00', fees: '$0.00'}),
        transactionsPage({
            version: VERSIONS['v2026-06'],
            columns: ALL_COLUMNS,
            rows: [
                {date: '06 Jul 2026', description: 'Charge', reference: '1000000001', reference2: '05072026', location: 'EXAMPLE-STORE.com', amount: '$20.00'},
                {date: '10 Jul 2026', description: 'ACH Online Pymt', location: 'ECP Payment', amount: '-$100.00'},
                {date: '20 Jul 2026', description: 'Charge', reference: '1000000002', reference2: '19072026', location: 'EXAMPLE-STORE.com', amount: '$30.00'},
                {date: '25 Jul 2026', description: 'Charge', reference: '1000000002', reference2: '19072026', location: 'EXAMPLE-STORE.com', amount: '$40.00'}
            ]
        })
    ],

    // Variants. These are not versions: the generator has always varied them from one
    // statement to the next, and both versions produce them.
    //
    // When no transaction has a reference number, the column is left out of the table
    // altogether - handled since b7b536f, well before either version above
    'v2025-12-no-reference-column.pdf': [
        summaryPage({version: VERSIONS['v2025-12'], debits: '$0.00', credits: '-$70.00', fees: '$0.00'}),
        transactionsPage({
            version: VERSIONS['v2025-12'],
            columns: ['Date', 'Description', 'Location', 'Amount'],
            rows: [
                {date: '05 Mar 2026', description: 'ACH Online Pymt', location: 'ECP Payment', amount: '-$70.00'}
            ]
        })
    ],

    // A statement carrying fees, and a description the original parser's list of
    // known descriptions did not contain
    'v2026-06-with-fees.pdf': [
        summaryPage({version: VERSIONS['v2026-06'], debits: '$80.00', credits: '$0.00', fees: '$30.00'}),
        transactionsPage({
            version: VERSIONS['v2026-06'],
            columns: ALL_COLUMNS,
            rows: [
                {date: '08 Jul 2026', description: 'Purchase Adjustment', reference: '1000000003', location: '7 EXAMPLE STORE 0001', amount: '$80.00'}
            ],
            feeRows: [
                {date: '12 Jul 2026', description: 'Late Payment Fee', amount: '$30.00'}
            ]
        })
    ],

    // A billing cycle with no activity
    'v2026-06-no-activity.pdf': [
        summaryPage({version: VERSIONS['v2026-06'], debits: '$0.00', credits: '$0.00', fees: '$0.00'})
    ]
};

fs.mkdirSync(FIXTURES, {recursive: true});
for (const [name, pages] of Object.entries(FIXTURE_FILES)) {
    fs.writeFileSync(path.join(FIXTURES, name), writePdf(pages));
    console.log(`wrote test/fixtures/${name} (${pages.length} page${pages.length === 1 ? '' : 's'})`);
}

module.exports = {VERSIONS};
