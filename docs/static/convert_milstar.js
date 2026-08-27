
// Configure PDF.js
pdfjsLib.GlobalWorkerOptions.workerSrc = '../static/pdf.worker.3.11.174.min.js';


// Statement parsing
//
// MyECP statements are untagged PDFs (Aspose.PDF for Java) - there is no table
// structure to read, only positioned text fragments. Rather than pattern-matching the
// text, the tables are recovered geometrically: the row that spells out the column
// headings defines an x-position for each column, and every fragment on the rows below
// is filed under whichever column it sits in.
//
// That keeps the parser out of the business of predicting the statement's wording. A
// row is a transaction because its Date cell holds a date and its Amount cell holds an
// amount - not because its description matches a list, its reference number is a single
// value, or the table is followed by a particular heading. All three of those have
// changed between statement versions and silently dropped transactions when they did.
const COLUMN_LABELS = ['Date', 'Description', 'Reference #', 'Location', 'Amount'];

// Account Summary lines on page 1, used to check the parsed tables add up. Keyed
// without whitespace so that a label split across text fragments still matches.
const SUMMARY_LABELS = {
    'Purchases/OtherDebits': 'debits',
    'Payments/OtherCredits': 'credits',
    'FeesCharged': 'fees'
};

// How many fragments a summary label may be split across
const MAX_LABEL_FRAGMENTS = 4;

const MONTHS = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
};

const DATE_CELL = /^\d{1,2} [A-Za-z]{3,9} \d{4}$/;
const MONEY_CELL = /^-?\$?[\d,]+\.\d{2}$/;
const FEE_PAYEE = 'MilitaryStar Card Fee';

// Fragments within this many points of each other vertically are on the same line
const BASELINE_TOLERANCE = 2;

// How far left of a column's heading a fragment may start and still belong to it
const COLUMN_TOLERANCE = 2;

// State
let pdfFiles = [];
let transactions = [];

// DOM Elements
const elements = {
    dropZone: document.getElementById('dropZone'),
    fileInput: document.getElementById('pdfInput'),
    fileInfo: document.getElementById('fileInfo'),
    processButton: document.getElementById('processButton'),
    downloadButton: document.getElementById('downloadCsv'),
    csvContent: document.getElementById('csvContent'),
    csvSummary: document.getElementById('csvSummary'),
    pdfContainer: document.getElementById('pdfContainer'),
};

// Initial button states
elements.processButton.disabled = true;
elements.downloadButton.disabled = true;

// File handling functions
function addFiles(fileList) {
    const pdfs = Array.from(fileList).filter(file =>
        file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
    );

    // Skip files that were already added
    const added = pdfs.filter(file => !pdfFiles.some(existing =>
        existing.name === file.name && existing.size === file.size
    ));
    if (!added.length) return;

    pdfFiles = pdfFiles.concat(added);
    onFileListChanged();
}

function removeFile(index) {
    pdfFiles.splice(index, 1);
    onFileListChanged();
}

function onFileListChanged() {
    renderFileList();

    // Any previously generated CSV no longer matches the selection
    transactions = [];
    elements.csvContent.innerHTML = '';
    elements.csvSummary.innerHTML = '';
    elements.downloadButton.disabled = true;

    elements.processButton.disabled = pdfFiles.length === 0;
    elements.dropZone.classList.toggle('has-file', pdfFiles.length > 0);

    displayPdfPreviews();
}

function renderFileList() {
    elements.fileInfo.innerHTML = '';
    if (!pdfFiles.length) return;

    const heading = document.createElement('div');
    heading.textContent = `Selected ${pdfFiles.length} PDF${pdfFiles.length === 1 ? '' : 's'}:`;
    elements.fileInfo.appendChild(heading);

    const list = document.createElement('ul');
    list.className = 'file-list';

    pdfFiles.forEach((file, index) => {
        const item = document.createElement('li');

        const name = document.createElement('span');
        name.textContent = file.name;
        item.appendChild(name);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'file-remove';
        remove.textContent = '×';
        remove.title = `Remove ${file.name}`;
        remove.addEventListener('click', (e) => {
            e.stopPropagation(); // don't re-open the file picker
            removeFile(index);
        });
        item.appendChild(remove);

        list.appendChild(item);
    });

    elements.fileInfo.appendChild(list);
}

async function displayPdfPreviews() {
    const container = elements.pdfContainer;
    container.innerHTML = '';

    for (const file of pdfFiles) {
        const title = document.createElement('h4');
        title.className = 'pdf-title';
        title.textContent = file.name;
        container.appendChild(title);

        try {
            const pdf = await loadPdf(file);

            for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
                const page = await pdf.getPage(pageNum);
                const viewport = page.getViewport({scale: 0.8}); // Reduced scale

                const canvas = document.createElement('canvas');
                canvas.height = viewport.height;
                canvas.width = viewport.width;
                canvas.style.marginBottom = '20px';

                await page.render({
                    canvasContext: canvas.getContext('2d'),
                    viewport: viewport
                }).promise;

                container.appendChild(canvas);
            }
        } catch (error) {
            console.error(`Error displaying ${file.name}:`, error);
            const message = document.createElement('p');
            message.className = 'error';
            message.textContent = `Could not display ${file.name}`;
            container.appendChild(message);
        }
    }
}

function loadPdf(file) {
    return file.arrayBuffer().then(buffer => pdfjsLib.getDocument(buffer).promise);
}

// PDF Processing functions
async function processPdfs() {
    if (!pdfFiles.length) return;

    const results = [];

    for (const file of pdfFiles) {
        try {
            const pages = await readPages(file);
            const result = parseStatement(pages);
            results.push(Object.assign({name: file.name}, result));
            console.log(`${file.name}: found ${result.transactions.length} transactions`, result.reconciliation);
        } catch (error) {
            console.error(`Error processing ${file.name}:`, error);
            results.push({name: file.name, transactions: [], reconciliation: [], error: error.message});
        }
    }

    // Combine every statement into a single, date-ordered list
    transactions = results
        .flatMap(result => result.transactions)
        .sort((a, b) => a.Date.localeCompare(b.Date));

    displaySummary(results);
    displayTransactions(transactions);
}

async function readPages(file) {
    const pdf = await loadPdf(file);

    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        pages.push(groupIntoRows((await page.getTextContent()).items));
    }
    return pages;
}

// Group text fragments into the rows they visually form, top to bottom, each row's
// fragments ordered left to right. PDF.js emits fragments in drawing order, which is
// not necessarily reading order, so position is the only thing to go on.
function groupIntoRows(items) {
    const rows = [];

    for (const item of items) {
        if (!item.str.trim()) continue;

        const y = item.transform[5];
        let row = rows.find(candidate => Math.abs(candidate.y - y) <= BASELINE_TOLERANCE);
        if (!row) {
            row = {y, fragments: []};
            rows.push(row);
        }
        row.fragments.push({x: item.transform[4], text: item.str});
    }

    rows.sort((a, b) => b.y - a.y);
    rows.forEach(row => row.fragments.sort((a, b) => a.x - b.x));
    return rows;
}

// A row that spells out the column headings defines the grid for the rows beneath it.
// The transactions table and the Fees table are both described this way, so both are
// read by the same code; the Fees table simply has no Location column.
function readColumns(row) {
    const labels = row.fragments.filter(fragment => COLUMN_LABELS.includes(fragment.text.trim()));
    if (labels.length < 3) return null;

    const names = labels.map(label => label.text.trim());
    if (!names.includes('Date') || !names.includes('Amount')) return null;

    return labels.map(label => ({name: label.text.trim(), x: label.x}));
}

// File each fragment under the column it starts in
function readCells(row, columns) {
    const cells = {};
    columns.forEach(column => { cells[column.name] = ''; });

    for (const fragment of row.fragments) {
        let index = 0;
        while (index + 1 < columns.length && fragment.x >= columns[index + 1].x - COLUMN_TOLERANCE) index++;

        const name = columns[index].name;
        cells[name] = cells[name] ? `${cells[name]} ${fragment.text}` : fragment.text;
    }

    Object.keys(cells).forEach(name => { cells[name] = cells[name].replace(/\s+/g, ' ').trim(); });
    return cells;
}

function parseStatement(pages) {
    const found = [];
    const totals = {};

    for (const rows of pages) {
        let columns = null; // headings are repeated on every page a table spans

        for (const row of rows) {
            const heading = readColumns(row);
            if (heading) {
                columns = heading;
                continue;
            }

            readSummaryTotal(row, totals);
            if (!columns) continue;

            const cells = readCells(row, columns);
            // A row is a transaction because of what its cells hold, not what they say
            if (!DATE_CELL.test(cells['Date']) || !MONEY_CELL.test(cells['Amount'])) continue;

            found.push(buildTransaction(cells));
        }
    }

    if (!found.length) console.log('Found no transactions.');
    return {transactions: found, reconciliation: reconcile(found, totals)};
}

function buildTransaction(cells) {
    const description = cells['Description'] || '';
    const reference = cells['Reference #'] || '';
    // The Fees table has no Location column, so its rows are the card's own fees
    const isFee = !('Location' in cells);

    return {
        Date: formatDate(cells['Date']),
        Memo: reference ? `${description}: ${reference}` : description,
        Payee: isFee ? FEE_PAYEE : (cells['Location'] || ''),
        Outflow: cells['Amount']
    };
}

// Format "14 Jul 2026" as "2026-07-14". Built by hand rather than via Date so that the
// result doesn't shift a day for users in timezones ahead of UTC.
function formatDate(date) {
    const [day, month, year] = date.trim().split(/\s+/);
    const monthNumber = MONTHS[month.slice(0, 3).toLowerCase()];
    if (!monthNumber) return date;
    return `${year}-${monthNumber}-${day.padStart(2, '0')}`;
}

// The statement's own Account Summary is a checksum for the tables below it: record the
// value of any summary label we know.
//
// The label is matched against the fragments themselves rather than the whole row,
// because page 1 is laid out in two columns - a summary label shares its baseline with
// whatever unrelated paragraph sits beside it. Fragments are joined while looking for a
// label so that a label the generator split across fragments still matches.
function readSummaryTotal(row, totals) {
    const compact = text => text.replace(/\s+/g, '');

    for (let start = 0; start < row.fragments.length; start++) {
        let label = '';

        for (let end = start; end < row.fragments.length && end - start < MAX_LABEL_FRAGMENTS; end++) {
            label += row.fragments[end].text;

            const key = SUMMARY_LABELS[compact(label)];
            if (!key || key in totals) continue;

            // The value is the next fragment along the same line
            const value = (row.fragments[end + 1] || {}).text;
            if (value && MONEY_CELL.test(value.trim())) totals[key] = toCents(value.trim());
        }
    }
}

function toCents(amount) {
    return Math.round(parseFloat(amount.replace(/[$,]/g, '')) * 100);
}

// Compare what was parsed against what the statement says it contains, so that a table
// this parser only partly understood is reported rather than quietly exported.
function reconcile(found, totals) {
    const sum = predicate => found
        .filter(predicate)
        .reduce((total, transaction) => total + toCents(transaction.Outflow), 0);

    const fees = transaction => transaction.Payee === FEE_PAYEE;
    const charge = transaction => !fees(transaction) && toCents(transaction.Outflow) >= 0;
    const credit = transaction => !fees(transaction) && toCents(transaction.Outflow) < 0;

    const checks = [
        {label: 'Purchases/Other Debits', expected: totals.debits, actual: sum(charge)},
        {label: 'Payments/Other Credits', expected: totals.credits, actual: sum(credit)},
        {label: 'Fees Charged', expected: totals.fees, actual: sum(fees)}
    ];

    // Only report on totals the statement actually stated
    return checks
        .filter(check => check.expected !== undefined)
        .map(check => Object.assign({balanced: check.expected === check.actual}, check));
}

function formatCents(cents) {
    const sign = cents < 0 ? '-' : '';
    return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

// Display and download functions
function displaySummary(results) {
    elements.csvSummary.innerHTML = '';

    const total = results.reduce((sum, result) => sum + result.transactions.length, 0);
    const heading = document.createElement('div');
    heading.textContent = `${total} transaction${total === 1 ? '' : 's'} from ` +
        `${results.length} PDF${results.length === 1 ? '' : 's'}`;
    elements.csvSummary.appendChild(heading);

    results.forEach(result => {
        const problems = result.reconciliation.filter(check => !check.balanced);
        if (result.transactions.length && !problems.length && !result.error) return;

        const line = document.createElement('div');
        line.className = 'warning';

        if (result.error) {
            line.textContent = `${result.name}: could not be read (${result.error})`;
        } else if (!result.transactions.length) {
            line.textContent = `${result.name}: no transactions found`;
        } else {
            // The statement disagrees with what was parsed out of it - say so rather
            // than handing over a CSV that is quietly missing rows
            const detail = problems
                .map(check => `${check.label} is ${formatCents(check.expected)}, found ${formatCents(check.actual)}`)
                .join('; ');
            line.textContent = `${result.name}: does not match the statement totals — ${detail}. Check the preview.`;
        }

        elements.csvSummary.appendChild(line);
    });
}

function displayTransactions(transactions) {
    if (!transactions.length) {
        elements.csvContent.innerHTML = 'No transactions found';
        elements.downloadButton.disabled = true;
        return;
    }

    const table = document.createElement('table');

    // Header
    const header = document.createElement('tr');
    Object.keys(transactions[0]).forEach(key => {
        const th = document.createElement('th');
        th.textContent = key;
        header.appendChild(th);
    });
    table.appendChild(header);

    // Data rows
    transactions.forEach(transaction => {
        const row = document.createElement('tr');
        Object.values(transaction).forEach(value => {
            const td = document.createElement('td');
            td.textContent = value;
            row.appendChild(td);
        });
        table.appendChild(row);
    });

    elements.csvContent.innerHTML = '';
    elements.csvContent.appendChild(table);
    elements.downloadButton.disabled = false;
}

function csvFileName() {
    // A single statement keeps its own name; a combined export is named for its range
    if (pdfFiles.length === 1) return `${pdfFiles[0].name.replace(/\.pdf$/i, '')}.csv`;

    const dates = transactions.map(transaction => transaction.Date).sort();
    if (!dates.length) return 'milstar_combined.csv';
    return `milstar_${dates[0]}_to_${dates[dates.length - 1]}.csv`;
}

function downloadCsv() {
    if (!transactions.length) return;

    const headers = Object.keys(transactions[0]);
    const csvRows = [headers.join(',')];

    transactions.forEach(transaction => {
        const values = headers.map(header => {
            const value = transaction[header] || '';
            return `"${value.toString().replace(/"/g, '""')}"`;
        });
        csvRows.push(values.join(','));
    });

    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = csvFileName();
    a.click();
}

// Event Listeners
elements.dropZone.addEventListener('click', () => elements.fileInput.click());

elements.dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    elements.dropZone.classList.add('dragover');
});

['dragleave', 'dragend'].forEach(type => {
    elements.dropZone.addEventListener(type, (e) => {
        e.preventDefault();
        elements.dropZone.classList.remove('dragover');
    });
});

elements.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    elements.dropZone.classList.remove('dragover');
    addFiles(e.dataTransfer.files);
});

elements.fileInput.addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = ''; // allow re-selecting the same file after removing it
});

elements.processButton.addEventListener('click', processPdfs);
elements.downloadButton.addEventListener('click', downloadCsv);
