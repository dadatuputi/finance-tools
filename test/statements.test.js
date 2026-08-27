'use strict';

// Parsing tests, one group per statement version MyECP has produced.
//
// Each version that has broken the parser gets a fixture here. The fixtures hold
// invented data laid out with the geometry of a real statement of that version - see
// test/fixtures/README.md for what distinguishes each one.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const {loadConverter, rawFragments, FIXTURES} = require('./helpers/harness');

const balanced = reconciliation => reconciliation.every(check => check.balanced);
const assertBalanced = reconciliation => {
    assert.strictEqual(reconciliation.length, 3, 'expected all three statement totals to be checked');
    assert.ok(balanced(reconciliation), JSON.stringify(reconciliation));
};

test('v2025-12 - the layout used up to March 2026', async (t) => {
    const {transactions, reconciliation} = await loadConverter().parse('v2025-12-statement.pdf');

    await t.test('reads every transaction', () => {
        assert.deepStrictEqual(transactions, [
            {Date: '2025-12-05', Memo: 'Charge: 200000000000001', Payee: 'EXAMPLE-STORE.com', Outflow: '$60.00'},
            {Date: '2025-12-12', Memo: 'Return: 200000000000002', Payee: 'EXAMPLE MERCHANT', Outflow: '-$20.00'},
            {Date: '2026-01-05', Memo: 'ACH Online Pymt', Payee: 'ECP Payment', Outflow: '-$40.00'}
        ]);
    });

    // The version that follows this one splits headings; this one does not
    await t.test('draws its headings as single text fragments', async () => {
        const fragments = await rawFragments('v2025-12-statement.pdf');
        assert.ok(fragments.includes('Interest Charge Calculations'),
            'the v2025-12 fixture should draw this heading whole');
        assert.ok(!fragments.includes('I'), 'the v2025-12 fixture should not split headings');
    });

    await t.test('adds up to the totals the statement states', () => assertBalanced(reconciliation));
});

test('v2025-12 - a statement with no reference numbers at all', async (t) => {
    const {transactions, reconciliation} = await loadConverter().parse('v2025-12-no-reference-column.pdf');

    // The Reference # column is dropped from the table entirely when nothing has one.
    // Not a version of its own - the generator has always varied this per statement.
    await t.test('copes with the column being absent', () => {
        assert.deepStrictEqual(transactions, [
            {Date: '2026-03-05', Memo: 'ACH Online Pymt', Payee: 'ECP Payment', Outflow: '-$70.00'}
        ]);
    });

    await t.test('adds up to the totals the statement states', () => assertBalanced(reconciliation));
});

test('v2026-06 - the layout used from June 2026', async (t) => {
    const {transactions, reconciliation} = await loadConverter().parse('v2026-06-statement.pdf');

    await t.test('reads every transaction', () => {
        assert.deepStrictEqual(transactions, [
            {Date: '2026-07-06', Memo: 'Charge: 1000000001 05072026', Payee: 'EXAMPLE-STORE.com', Outflow: '$20.00'},
            {Date: '2026-07-10', Memo: 'ACH Online Pymt', Payee: 'ECP Payment', Outflow: '-$100.00'},
            {Date: '2026-07-20', Memo: 'Charge: 1000000002 19072026', Payee: 'EXAMPLE-STORE.com', Outflow: '$30.00'},
            {Date: '2026-07-25', Memo: 'Charge: 1000000002 19072026', Payee: 'EXAMPLE-STORE.com', Outflow: '$40.00'}
        ]);
    });

    // This version draws "Interest Charge Calculations" as "I" plus the rest, which is
    // what made the original parser miss the table completely
    await t.test('is not thrown by a heading split across text fragments', async () => {
        const fragments = await rawFragments('v2026-06-statement.pdf');
        assert.ok(fragments.some(text => text === 'I'),
            'the fixture should reproduce this version\'s split headings');
        assert.strictEqual(transactions.length, 4);
    });

    // Reference # carries the reference number and the purchase date
    await t.test('keeps every value in the reference column', () => {
        assert.strictEqual(transactions[0].Memo, 'Charge: 1000000001 05072026');
    });

    await t.test('adds up to the totals the statement states', () => assertBalanced(reconciliation));
});

test('v2026-06 - a statement carrying fees', async (t) => {
    const {transactions, reconciliation} = await loadConverter().parse('v2026-06-with-fees.pdf');

    await t.test('reads the Fees table as well as the transactions', () => {
        assert.deepStrictEqual(transactions, [
            {Date: '2026-07-08', Memo: 'Purchase Adjustment: 1000000003', Payee: '7 EXAMPLE STORE 0001', Outflow: '$80.00'},
            {Date: '2026-07-12', Memo: 'Late Payment Fee', Payee: 'MilitaryStar Card Fee', Outflow: '$30.00'}
        ]);
    });

    // "Purchase Adjustment" was not one of the descriptions the original parser knew,
    // and "7 ELEVEN 3421" starts with a digit
    await t.test('does not require a familiar description or a non-numeric payee', () => {
        assert.strictEqual(transactions[0].Memo, 'Purchase Adjustment: 1000000003');
        assert.strictEqual(transactions[0].Payee, '7 EXAMPLE STORE 0001');
    });

    await t.test('checks the fee total against Fees Charged', () => {
        const fees = reconciliation.find(check => check.label === 'Fees Charged');
        assert.deepStrictEqual([fees.expected, fees.actual], [3000, 3000]);
        assertBalanced(reconciliation);
    });
});

test('v2026-06 - a billing cycle with no activity', async () => {
    const {transactions, reconciliation} = await loadConverter().parse('v2026-06-no-activity.pdf');

    assert.deepStrictEqual(transactions, []);
    // Nothing found, and nothing claimed to be there
    assertBalanced(reconciliation);
});

test('reconciliation reports a table that was only partly read', () => {
    const app = loadConverter();
    const rows = [
        {Date: '2026-07-06', Memo: 'Charge', Payee: 'EXAMPLE-STORE.com', Outflow: '$20.00'},
        {Date: '2026-07-10', Memo: 'ACH Online Pymt', Payee: 'ECP Payment', Outflow: '-$100.00'}
    ];

    const complete = app.call('reconcile', rows, {debits: 2000, credits: -10000, fees: 0});
    assert.ok(balanced(complete), JSON.stringify(complete));

    // The same rows against a statement that says there should have been more
    const short = app.call('reconcile', rows, {debits: 9000, credits: -10000, fees: 0});
    const problem = short.find(check => !check.balanced);
    assert.strictEqual(problem.label, 'Purchases/Other Debits');
    assert.deepStrictEqual([problem.expected, problem.actual], [9000, 2000]);
});

// A real statement's amounts are someone's purchase history. The fixtures use whole
// dollars throughout, which a real statement never is - so an amount copied out of one
// fails here rather than being committed.
test('fixture amounts are invented, not copied from a real statement', async () => {
    const fixtures = fs.readdirSync(FIXTURES).filter(name => name.endsWith('.pdf'));
    assert.ok(fixtures.length, 'expected some fixtures to check');

    for (const fixture of fixtures) {
        const amounts = (await rawFragments(fixture)).filter(text => /^-?\$[\d,]+\.\d{2}$/.test(text));
        assert.ok(amounts.length, `${fixture} should state some amounts`);

        const notRound = amounts.filter(amount => !amount.endsWith('.00'));
        assert.deepStrictEqual(notRound, [],
            `${fixture} holds amounts that are not whole dollars, which real statements are full of ` +
            'and these fixtures must never contain');
    }
});

test('dates do not shift with the timezone', () => {
    const formatDate = date => loadConverter().call('formatDate', date);

    assert.strictEqual(formatDate('14 Jul 2026'), '2026-07-14');
    assert.strictEqual(formatDate('1 Jan 2026'), '2026-01-01');
    assert.strictEqual(formatDate('31 Dec 2025'), '2025-12-31');
    // CI runs this file under several timezones - see .github/workflows/test.yml.
    // Deriving the date through Date reported the previous day anywhere ahead of UTC.
});
