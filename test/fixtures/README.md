# Statement fixtures

One PDF per version of the statement MyECP has been seen to produce, plus a few
variants. They are what `test/statements.test.js` parses.

**These files contain no real statement data.** Names, addresses, account numbers,
merchants and reference numbers are invented — and so are the dates and amounts, which
matter just as much: a statement's transaction dates and amounts *are* someone's
purchase history. Every amount here is a whole number of dollars, which no real
statement is full of, and `test/statements.test.js` enforces that, so an amount copied
out of a real statement fails the suite rather than getting committed. The amounts are
chosen so each statement's transactions add up to the totals it states.

What the fixtures *do* reproduce is the geometry of a real statement — column
positions, the separate whitespace fragment drawn between each column, the two-column
front page, and each version's quirks. Geometry is what the parser reads, so that is
the part that has to be faithful. The words that must match a real statement are the
ones the parser keys off: the column headings, the section titles, and the Account
Summary labels.

The files are uncompressed and carry no metadata — no author, producer or timestamps —
so `grep` on one shows you everything in it.

They are generated, not hand-edited: `npm run fixtures` rebuilds them from
`test/tools/make-fixtures.js`, and CI checks the committed files still match.

## Versions

A version is named for the earliest statement we have in that layout — so `v2026-06`
is the layout first seen in the June 2026 statement, not a layout that necessarily
began that month. The range is what we have observed, not what MyECP did.

| Version | Observed | Headings | Reference # column |
| --- | --- | --- | --- |
| `v2025-12` | Dec 2025 – Mar 2026 | drawn as one text fragment | one value — the reference number |
| `v2026-06` | Jun 2026 – Aug 2026 | first letter drawn as its own fragment | two values — reference number, then the purchase date as `DDMMYYYY` |

Both `v2026-06` changes broke the parser that shipped before it. It located the
transactions table by searching for the literal `Interest Charge Calculations`, which
that version draws as `I` + `nterest Charge Calculations`, so the table was never found
and every statement reported "no transactions found". Even patched past that, its row
pattern allowed a single value in the reference column, so rows parsed with the
location as the amount.

Column positions have not changed between versions: `Date` at x=54.6, `Description`
114.4, `Reference #` 261.2, `Location` 392.1, `Amount` 559.3.

### Variants

These are *not* versions. The generator varies them from one statement to the next, and
both versions above produce them; each fixture just picks the version it was first
noticed in.

| File | What it covers |
| --- | --- |
| `v2025-12-no-reference-column.pdf` | When no transaction has a reference number, the column is dropped from the table altogether. Long-standing behaviour — `b7b536f` handled it in September 2025, before either version above. |
| `v2026-06-with-fees.pdf` | A statement carrying a Fees table, a description outside the set the original parser knew, and a payee starting with a digit |
| `v2026-06-no-activity.pdf` | A billing cycle with no transactions at all |

## Adding a version

When a statement stops parsing, it is usually because MyECP changed the layout again.
To pin the new one:

1. Work out what changed — compare the text fragments PDF.js reports for the new
   statement against a fixture. Positions and how the text is split into fragments
   matter more than the words do.
2. Decide whether it is a version or a variant. A version is the generator changing how
   it draws statements; a variant is something it has always varied per statement, like
   dropping a column no row uses. If in doubt, check whether an older statement can
   also produce it.
3. Add the version to `VERSIONS` in `test/tools/make-fixtures.js`, named for the
   statement month you saw it in, and a `vYYYY-MM-statement.pdf` entry to
   `FIXTURE_FILES` describing it. Invent the data — including the dates and the
   amounts. Copy the layout, never the contents.
4. Run `npm run fixtures`.
5. Add a group to `test/statements.test.js` asserting the rows it should produce, and
   an assertion that the fixture actually reproduces the new quirk — otherwise a
   fixture that quietly fails to reproduce it will pass against any parser.
6. Record the version in the table above.

One thing to watch when reproducing a quirk: the *order* fragments are drawn in can
matter as much as where they sit. PDF.js joins adjacent fragments into one text item,
so a heading split into `I` + `nterest ...` only survives as two items because the
generator draws the tail first and then goes back for the leading letter.
