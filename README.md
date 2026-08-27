# 🛠️ Finance Tools

🌐 [Try it now!](https://dadatuputi.github.io/finance-tools/)

Browser-based tools for converting financial statements to CSV format for budgeting software.

## 💳 [Military Star Statement Converter](https://dadatuputi.github.io/finance-tools/milstar/)

Convert Military Star Card PDF statements to CSV files.

- Drag-and-drop PDF upload - one statement or many at once
- Multiple statements are merged into a single, date-sorted CSV
- Side-by-side PDF and CSV preview
- One-click CSV download

## 💱 [Wise to YNAB Converter](https://dadatuputi.github.io/finance-tools/wise/)

Convert Wise transaction exports to YNAB-compatible CSV format.

- Direct CSV format conversion
- Editable transaction details
- Transaction totals and summaries
- One-click YNAB download

## 🔒 Security

All processing happens in your browser - your data never leaves your device.

## 🚀 Usage

1. Choose your converter
2. Upload your statement/export — the Military Star converter takes any number of statements at once
3. Preview and edit if needed
4. Download CSV!

## 🧪 Development

The site is static: everything under `docs/` is served as-is by GitHub Pages, with no
build step.

```sh
npm test           # parse a statement fixture for each known format, check the results
npm run fixtures   # rebuild the test fixtures
```

The tests need only Node 20+; there are no dependencies to install. They parse a
fixture for each statement layout MyECP has been seen to produce — `test/fixtures/README.md`
lists them and explains how to pin the next one.

## 🙏 Credits

Based on:

- The original [import_milstar_pdf.py](https://github.com/dadatuputi/finance-tools/blob/master/import_milstar_pdf.py) script
- The original [wise_to_ynab.py](https://gist.github.com/dadatuputi/b961882b8c8535aa30aacbdc446219c4) script
