
// Configure PDF.js
pdfjsLib.GlobalWorkerOptions.workerSrc = '../static/pdf.worker.3.11.174.min.js';


// Constants and regex patterns
//
// Statement text is normalised into one line per visual row before matching (see
// extractLines) so that patterns can key off whole table rows. This matters because
// the statement generator regularly splits a heading's first letter into its own text
// item ("I" + "nterest Charge Calculations"), which broke naive matching on the raw
// concatenated text.
const MONTHS = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
};

const MEMO_TYPES = 'Charge|Return|ACH Online Pymt|Principal Credit Adj\\.|Principal Debit Adj\\.|Promo Plan Swap';
const DATE = '\\d{1,2}\\s+[A-Za-z]+\\s+\\d{4}';
const AMOUNT = '-?\\$?[\\d,]+\\.\\d{2}';

const REGEX_PATTERNS = {
    // Column headings that open each table
    transactionsHeader: /^Date\s+Description\s+(?:Reference #\s+)?Location\s+Amount$/i,
    feesHeader: /^Date\s+Description\s+Amount$/i,
    // Headings that close a table
    sectionEnd: /^(?:Interest Charge Calculations|Important Notices|Terms and Conditions|Total Fees for This Period|\d{4} Year to Date)/i,
    // Table rows
    transaction: new RegExp(`^(?<Date>${DATE})\\s+(?<Memo>${MEMO_TYPES})\\s+(?<Rest>.*?)\\s*(?<Outflow>${AMOUNT})$`),
    fee: new RegExp(`^(?<Date>${DATE})\\s+(?<Memo>.+?)\\s+(?<Outflow>${AMOUNT})$`),
    // Leading reference numbers in the Reference # column (statements may carry more
    // than one, e.g. the reference number followed by the purchase date as DDMMYYYY)
    reference: /^((?:\d{4,}(?:\s+|$))+)(.*)$/
};

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
    elements.csvSummary.textContent = '';
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
            const text = await getPdfText(file);
            const found = extractTransactions(text);
            results.push({name: file.name, transactions: found});
            console.log(`${file.name}: found ${found.length} transactions`);
        } catch (error) {
            console.error(`Error processing ${file.name}:`, error);
            results.push({name: file.name, transactions: [], error: error.message});
        }
    }

    // Combine every statement into a single, date-ordered list
    transactions = results
        .flatMap(result => result.transactions)
        .sort((a, b) => a.Date.localeCompare(b.Date));

    displaySummary(results);
    displayTransactions(transactions);
}

async function getPdfText(file) {
    const pdf = await loadPdf(file);

    let lines = [];
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        lines = lines.concat(extractLines(textContent));
    }
    return lines;
}

// Rebuild the visual lines of a page from PDF.js text items.
//
// PDF.js hands back a stream of small text fragments; a single table row arrives as a
// dozen of them. Joining them blindly (with newlines or nothing) splits words that the
// statement draws in pieces, so fragments are grouped by their baseline instead, with a
// space inserted wherever there is a horizontal gap between fragments.
function extractLines(textContent) {
    const lines = [];
    let current = '';
    let baseline = null;
    let previousEnd = null;

    const pushLine = () => {
        const line = current.replace(/\s+/g, ' ').trim();
        if (line) lines.push(line);
        current = '';
        previousEnd = null;
    };

    for (const item of textContent.items) {
        const x = item.transform[4];
        const y = item.transform[5];

        if (baseline !== null && Math.abs(y - baseline) > 2) pushLine();
        baseline = y;

        if (current && previousEnd !== null && x > previousEnd + 1) current += ' ';
        current += item.str;
        previousEnd = x + (item.width || 0);

        if (item.hasEOL) {
            pushLine();
            baseline = null;
        }
    }
    pushLine();

    return lines;
}

function extractTransactions(lines) {
    const found = [];
    let table = null;

    for (const line of lines) {
        // A heading opens a table; statements repeat the heading on every page they span
        if (REGEX_PATTERNS.transactionsHeader.test(line)) {
            table = 'transactions';
            continue;
        }
        if (REGEX_PATTERNS.feesHeader.test(line)) {
            table = 'fees';
            continue;
        }
        if (!table) continue;
        if (REGEX_PATTERNS.sectionEnd.test(line)) {
            table = null;
            continue;
        }

        const pattern = table === 'transactions' ? REGEX_PATTERNS.transaction : REGEX_PATTERNS.fee;
        const match = line.match(pattern);
        if (!match) continue;

        found.push(table === 'transactions'
            ? buildTransaction(match.groups)
            : buildFee(match.groups));
    }

    if (!found.length) console.log('Found no transactions.');
    return found;
}

function buildTransaction({Date: date, Memo: memo, Rest: rest, Outflow: outflow}) {
    // Whatever sits between the description and the amount is the reference number(s)
    // followed by the location
    let reference = '';
    let payee = rest.trim();

    const match = payee.match(REGEX_PATTERNS.reference);
    if (match) {
        reference = match[1].trim();
        payee = match[2].trim();
    }

    return {
        Date: formatDate(date),
        Memo: reference ? `${memo}: ${reference}` : memo,
        Payee: payee,
        Outflow: outflow
    };
}

function buildFee({Date: date, Memo: memo, Outflow: outflow}) {
    return {
        Date: formatDate(date),
        Memo: memo.trim(),
        Payee: 'MilitaryStar Card Fee',
        Outflow: outflow
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

// Display and download functions
function displaySummary(results) {
    const total = results.reduce((sum, result) => sum + result.transactions.length, 0);
    const parts = [`${total} transaction${total === 1 ? '' : 's'} from ${results.length} PDF${results.length === 1 ? '' : 's'}`];

    const empty = results.filter(result => !result.transactions.length);
    if (empty.length) {
        parts.push(`No transactions found in: ${empty.map(result => result.name).join(', ')}`);
    }

    elements.csvSummary.textContent = parts.join(' — ');
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
