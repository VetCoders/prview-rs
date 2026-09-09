#!/usr/bin/env node
// Optional DOM interaction gate: NODE_PATH=<jsdom node_modules> node tools/test_dashboard_reader.cjs <dashboard.html>
// jsdom does not validate browser layout, file-URL permissions, or native downloads.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const htmlPath = process.argv[2];
assert(htmlPath, 'Pass a generated dashboard.html');
const errors = [];
let fetches = 0;
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', error => errors.push(error.message));
const dom = new JSDOM(fs.readFileSync(htmlPath, 'utf8'), {
  url: 'https://prview.test/dashboard.html',
  runScripts: 'dangerously',
  virtualConsole,
  beforeParse(window) {
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    window.HTMLElement.prototype.scrollIntoView = function () {};
    window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
    window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    window.URL.createObjectURL = () => 'blob:prview-test-source';
    window.URL.revokeObjectURL = () => {};
    window.fetch = async () => { fetches++; throw new Error('Network access is forbidden in this test'); };
    window.CSS = { escape: value => value.replace(/[^a-zA-Z0-9_-]/g, character => '\\' + character) };
  },
});

function click(element) { assert(element, 'Expected a clickable control'); element.click(); }
function addTemplate(doc, attribute, path, text) {
  const template = doc.createElement('template');
  template.setAttribute(attribute, path);
  const pre = doc.createElement('pre');
  pre.textContent = text;
  template.content.append(pre);
  doc.body.append(template);
  return template;
}

// Add stress fixtures before DOMContentLoaded installs the evidence maps.
const doc = dom.window.document;
const actualSarif = doc.querySelector('[data-evidence-path="30_context/INLINE_FINDINGS.sarif"]');
const sarifPath = actualSarif ? '30_context/INLINE_FINDINGS.sarif' : 'test-fixture/located.sarif';
if (!actualSarif) {
  assert(doc.querySelector('[data-i18n="evidence.noLocated"]'), 'Absent SARIF must be explained, not linked');
  addTemplate(doc, 'data-evidence-content', sarifPath, JSON.stringify({version:'2.1.0', runs:[{results:[]}]}));
  const link = doc.createElement('a');
  link.setAttribute('data-evidence-path', sarifPath);
  doc.body.append(link);
}
addTemplate(doc, 'data-evidence-content', '20_quality/long.log', Array.from({length: 12001}, (_, n) => 'line ' + (n + 1)).join('\n'));
addTemplate(doc, 'data-evidence-content', '20_quality/linked.md', '[summary](../PR_REVIEW.md)');
const formatted = doc.createElement('template');
formatted.setAttribute('data-evidence-rendered', '20_quality/linked.md');
formatted.innerHTML = '<p><a href="../PR_REVIEW.md">Read summary</a></p>';
doc.body.append(formatted);
for (const path of ['20_quality/long.log', '20_quality/linked.md']) {
  const link = doc.createElement('a');
  link.setAttribute('data-evidence-path', path);
  link.textContent = path;
  doc.body.append(link);
}

dom.window.addEventListener('load', () => {
  try {
    const dialog = doc.getElementById('evidence-dialog');
    const body = doc.getElementById('evidence-body');
    for (const path of ['00_summary/MERGE_GATE.md', '00_summary/MERGE_GATE.json', '00_summary/PROVENANCE.json', '00_summary/FAILURES_SUMMARY.md', 'PR_REVIEW.md', 'REVIEW_SUMMARY.md', sarifPath, '10_diff/full.patch']) {
      click(doc.querySelector('[data-evidence-path="' + path + '"]'));
      assert(dialog.open, path + ' must open in the reader');
      assert.equal(doc.getElementById('evidence-title').textContent, path);
      assert(body.textContent.trim().length > 10, path + ' must have readable evidence');
      assert(!body.textContent.includes('not embedded'), path + ' must be embedded');
      assert.equal(dom.window.location.pathname, '/dashboard.html');
      if (path.endsWith('.md')) {
        assert(body.querySelector('article'), 'Markdown should have a formatted view');
        click(doc.getElementById('evidence-format'));
        assert(body.querySelector('.evidence-line'), 'Raw Markdown remains accessible');
      }
      click(doc.getElementById('evidence-close'));
      assert(!dialog.open);
    }
    click(doc.querySelector('[data-evidence-path="20_quality/linked.md"]'));
    click(body.querySelector('a'));
    assert.equal(doc.getElementById('evidence-title').textContent, 'PR_REVIEW.md', 'Nested evidence links resolve against their document directory');
    click(doc.getElementById('evidence-close'));

    click(doc.querySelector('[data-evidence-path="20_quality/long.log"]'));
    assert.equal(body.querySelectorAll('.evidence-line').length, 5000);
    click(Array.from(body.querySelectorAll('button')).find(button => button.textContent === 'Next page'));
    assert.equal(body.querySelector('.evidence-line').dataset.line, '5001');
    click(Array.from(body.querySelectorAll('button')).find(button => button.textContent === 'Next page'));
    assert.equal(body.querySelector('.evidence-line').dataset.line, '10001');
    assert.equal(body.querySelectorAll('.evidence-line').length, 2001);
    const search = doc.getElementById('evidence-search');
    search.value = 'line 12001';
    search.dispatchEvent(new dom.window.Event('input'));
    assert.equal(body.querySelector('.evidence-match').textContent, 'line 12001');
    click(doc.getElementById('evidence-close'));

    const source = Array.from(doc.querySelectorAll('[data-source-path]')).find(link => doc.querySelector('template[data-source-content="' + link.dataset.sourcePath + '"]'));
    assert(source, 'Real fixture must expose at least one committed source');
    click(source);
    assert(body.querySelector('.evidence-line'));
    assert(!doc.getElementById('evidence-original').hidden);
    assert(doc.getElementById('evidence-original').href.startsWith('blob:'));
    assert(doc.getElementById('evidence-note').textContent.includes('Committed target'));
    click(doc.getElementById('evidence-close'));

    const polish = doc.getElementById('lang-toggle-pl');
    click(polish);
    assert.equal(doc.documentElement.lang, 'pl');
    assert(!doc.body.textContent.includes('Nie przeszły 1 check'));
    assert.equal(doc.querySelector('[data-i18n="evidence.readingPath"]').textContent, 'Przejdź przez review');
    for (const element of doc.querySelectorAll('[data-i18n], [data-i18n-template]')) {
      assert(!element.textContent.includes('<span data-i18n'), 'Translation markup must not appear as text');
    }
    assert.equal(fetches, 0, 'Reader must not fetch artifacts');
    assert.deepEqual(errors, [], 'Dashboard scripts must execute without errors');
    console.log('PASS: ' + (actualSarif ? 'eight pack surfaces' : 'seven pack surfaces + synthetic SARIF; real SARIF absence explained') + ', Markdown/raw, nested links, pagination, search, target source, Polish locale; zero fetches and script errors.');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    dom.window.close();
  }
});
