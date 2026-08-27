'use strict';

// Loads the converter the way the browser does - the vendored PDF.js build plus
// docs/static/convert_milstar.js - against a stub DOM, so the tests exercise the file
// that actually ships rather than a copy of its logic.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const STATIC = path.join(ROOT, 'docs', 'static');
const CONVERTER = path.join(STATIC, 'convert_milstar.js');
const FIXTURES = path.join(__dirname, '..', 'fixtures');

const ELEMENT_IDS = ['dropZone', 'pdfInput', 'fileInfo', 'processButton', 'downloadCsv',
                     'csvContent', 'csvSummary', 'pdfContainer'];

let pdfjsLib = null;
let workerPath = null;

// PDF.js ships as a browser bundle: give it the globals it reaches for, and a copy of
// the worker under the filename its fallback loader requires.
function loadPdfjs() {
    if (pdfjsLib) return pdfjsLib;

    const [bundle] = fs.readdirSync(STATIC).filter(name => /^pdf\.[\d.]+min\.js$/.test(name));
    const [worker] = fs.readdirSync(STATIC).filter(name => /^pdf\.worker\.[\d.]+min\.js$/.test(name));
    if (!bundle || !worker) throw new Error('Could not find the vendored PDF.js build in docs/static');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milstar-pdfjs-'));
    fs.copyFileSync(path.join(STATIC, bundle), path.join(dir, 'pdf.min.js'));
    fs.copyFileSync(path.join(STATIC, worker), path.join(dir, 'pdf.worker.js'));

    // Some of these are read-only globals in newer Node versions, so define rather
    // than assign
    const defineGlobal = (name, value) =>
        Object.defineProperty(global, name, {value, configurable: true, writable: true});

    defineGlobal('window', global);
    defineGlobal('navigator', {userAgent: 'node', platform: 'linux', language: 'en-US'});
    defineGlobal('location', {href: 'file:///', protocol: 'file:', origin: 'file://'});
    defineGlobal('document', {
        currentScript: {src: 'file:///pdf.js'},
        createElement: () => ({style: {}, getContext: () => null, setAttribute() {}, appendChild() {}}),
        createElementNS: () => ({style: {}}),
        documentElement: {style: {}},
        head: {appendChild() {}}
    });

    // The fixtures use a standard font rather than an embedded one, so PDF.js warns
    // that it cannot fetch substitute font data. That only affects rendering glyphs,
    // which the tests never do, so keep it out of the output.
    const log = console.log;
    console.log = (...args) => {
        if (typeof args[0] === 'string' && args[0].startsWith('Warning: fetchStandardFontData')) return;
        log(...args);
    };

    workerPath = path.join(dir, 'pdf.worker.js');
    pdfjsLib = require(path.join(dir, 'pdf.min.js'));
    return pdfjsLib;
}

function stubElement(tag) {
    return {
        tag,
        disabled: false,
        title: '',
        type: '',
        className: '',
        style: {},
        children: [],
        _text: '',
        classList: {add() {}, remove() {}, toggle() {}},
        addEventListener() {},
        appendChild(child) { this.children.push(child); return child; },
        set textContent(value) { this._text = value; this.children = []; },
        get textContent() { return this._text; },
        set innerHTML(value) { this._text = value; this.children = []; },
        get innerHTML() { return this._text; },
        // Everything this element renders, as the user would read it
        get text() {
            return [this._text, ...this.children.map(child => child.text)].filter(Boolean).join('\n');
        }
    };
}

// A stand-in for a File the user picked; the converter only needs these three things
function fixtureFile(name) {
    const contents = fs.readFileSync(path.join(FIXTURES, name));
    return {
        name,
        size: contents.length,
        type: 'application/pdf',
        arrayBuffer: async () => Uint8Array.from(contents).buffer
    };
}

function loadConverter() {
    const nodes = Object.fromEntries(ELEMENT_IDS.map(id => [id, stubElement(id)]));
    const downloads = [];

    const sandbox = {
        pdfjsLib: loadPdfjs(),
        document: {
            getElementById: id => nodes[id] || null,
            createElement: tag => Object.assign(stubElement(tag), {click() {}})
        },
        window: {URL: {createObjectURL: () => 'blob:test'}},
        // Capture what a download would have written
        Blob: class { constructor(parts) { downloads.push(parts.join('')); } },
        console: {log() {}, error() {}, warn() {}},
        Array, Object, String, Number, Math, JSON, RegExp, Date, Set, Map, Error, Promise, Uint8Array
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(CONVERTER, 'utf8'), sandbox);

    // The converter points PDF.js at a worker URL that only means something in a
    // browser; under Node the fallback loader resolves it as a module path
    sandbox.pdfjsLib.GlobalWorkerOptions.workerSrc = workerPath;

    const evaluate = expression => vm.runInContext(expression, sandbox);

    // Objects made inside the sandbox have that context's prototypes, which
    // assert.deepStrictEqual treats as a difference. Hand back plain data instead.
    const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

    return {
        nodes,
        downloads,
        // let/const declarations are not properties of the sandbox, so read them by name
        get transactions() { return plain(evaluate('transactions')); },
        get pdfFiles() { return plain(evaluate('pdfFiles')); },
        call: (name, ...args) => plain(sandbox[name](...args)),
        select: fixtureNames => sandbox.addFiles(fixtureNames.map(fixtureFile)),
        process: () => sandbox.processPdfs(),
        // The rows of text fragments PDF.js reports for a fixture
        pages: fixtureName => sandbox.readPages(fixtureFile(fixtureName)).then(plain),
        // Parse one fixture without going through the UI
        parse: async fixtureName => {
            const pages = await sandbox.readPages(fixtureFile(fixtureName));
            return plain(sandbox.parseStatement(pages));
        }
    };
}

// Every text fragment PDF.js reports for a fixture, for asserting that a fixture
// really does reproduce its version's quirks
async function rawFragments(fixtureName) {
    const {loadConverter: load} = module.exports;
    const app = load();
    const pages = await app.pages(fixtureName);
    return pages.flatMap(rows => rows.flatMap(row => row.fragments.map(fragment => fragment.text)));
}

module.exports = {loadConverter, rawFragments, fixtureFile, FIXTURES};
