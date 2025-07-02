
// Configure PDF.js
pdfjsLib.GlobalWorkerOptions.workerSrc = '/finance-tools/static/pdf.worker.3.11.174.min.js';


// Constants and regex patterns
const REGEX_PATTERNS = {
    transactions: /Transactions\n ?\nDate\n ?\nDescription\n ?\nReference #\n ?\nLocation\n ?\nAmount\n ?\n(.*?)Interest Charge Calculations/s,
    transaction: /(?<Date>\d{1,2}\s\w+\s\d{4})\n ?\n?(?<Memo>Charge|Return|ACH Online Pymt|Principal Credit Adj\.|Principal Debit Adj\.|Promo Plan Swap)\n ?\n?(?<Ref>[\d ]+)?\n ?\n?(?<Payee>[\w\. ]+)\n ?\n?(?<Outflow>-{0,1}[$\.\d]+)/g,
    fees: /Fees\n ?\n?Date\n ?\n?Description\n ?\n?Amount\n ?\n?(?<Fees>.*)Total Fees for This Period/s,
    fee: /(?<Date>\d{1,2}\s\w+\s\d{4})\n ?\n?(?<Memo>.+?)\n ?\n?(?<Outflow>-{0,1}[$\.\d]+)/g
};

// State
let currentPdfFile = null;
let transactions = [];
let currentFileName = null;

// DOM Elements
const elements = {
    dropZone: document.getElementById('dropZone'),
    fileInput: document.getElementById('pdfInput'),
    fileInfo: document.getElementById('fileInfo'),
    processButton: document.getElementById('processButton'),
    downloadButton: document.getElementById('downloadCsv'),
    canvas: document.getElementById('canvas'),
    csvContent: document.getElementById('csvContent'),
    pdfContainer: document.getElementById('pdfContainer'),
};

// Initial button states
elements.processButton.disabled = true;
elements.downloadButton.disabled = true;

// File handling functions
async function handleFileSelection(file) {
    currentPdfFile = file;
    currentFileName = file.name.replace(/\.pdf$/i, ''); // Store filename without extension
    elements.fileInfo.textContent = `Selected: ${file.name}`;
    elements.dropZone.classList.add('has-file');
    elements.processButton.disabled = false;
    
    // Immediately display the PDF
    await displayPdfPreview(file);
}

async function displayPdfPreview(file) {
    try {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;
        const pdfContainer = elements.pdfContainer;
        
        // Clear existing content
        pdfContainer.innerHTML = '';

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

            pdfContainer.appendChild(canvas);
        }

        elements.processButton.disabled = false;
    } catch (error) {
        console.error('Error displaying PDF:', error);
    }
}

// PDF Processing functions
async function processPdf() {
    console.log("Processing PDF")

    if (!currentPdfFile) return;
    try {
        const arrayBuffer = await currentPdfFile.arrayBuffer();
        const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;
        
        let fullText = '';
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            fullText += textContent.items.map(item => item.str).join('\n');
        }

        transactions = extractTransactions(fullText);
        console.log(fullText)
        displayTransactions(transactions);
        elements.downloadButton.disabled = false;
    } catch (error) {
        console.error('Error processing PDF:', error);
    }
}

function extractTransactions(text) {
    let transactions = [];

    // Extract regular transactions
    const transactionMatch = text.match(REGEX_PATTERNS.transactions);
    if (transactionMatch) {
        let match;
        while ((match = REGEX_PATTERNS.transaction.exec(transactionMatch[1])) !== null) {
            transactions.push(match.groups);
        }
    }

    // Extract fees
    const feesMatch = text.match(REGEX_PATTERNS.fees);
    if (feesMatch) {
        let match;
        while ((match = REGEX_PATTERNS.fee.exec(feesMatch.groups.Fees)) !== null) {
            const fee = match.groups;
            fee.Payee = 'MilitaryStar Card Fee';
            fee.Ref = null;
            transactions.push(fee);
        }
    }

    // Format transactions
    return transactions.map(transaction => {
        const refStr = transaction.Ref ? `: ${transaction.Ref}` : '';
        transaction.Memo = `${transaction.Memo}${refStr}`;
        delete transaction.Ref;
        
        const dateParts = transaction.Date.split(' ');
        const date = new Date(`${dateParts[1]} ${dateParts[0]}, ${dateParts[2]}`);
        transaction.Date = date.toISOString().split('T')[0];
        
        return transaction;
    });
}

// Display and download functions
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
    a.download = `${currentFileName}.csv`;
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
    
    const files = e.dataTransfer.files;
    if (files.length && files[0].type === 'application/pdf') {
        handleFileSelection(files[0]);
    }
});

elements.fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) {
        handleFileSelection(e.target.files[0]);
    }
});

elements.processButton.addEventListener('click', processPdf);
elements.downloadButton.addEventListener('click', downloadCsv);
