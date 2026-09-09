#!/usr/bin/env node
// Optional DOM gate: NODE_PATH=<jsdom node_modules> node tools/test_dashboard_reader.cjs <dashboard.html> [--current-ui]
// --current-ui substitutes current JS/locales in memory, never modifying the retained pack.
// jsdom does not validate browser layout, file-URL permissions, or native downloads.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Blob } = require('node:buffer');
const { JSDOM, VirtualConsole } = require('jsdom');
const htmlPath = process.argv[2];
assert(htmlPath, 'Pass a generated dashboard.html');
const currentUi = process.argv.includes('--current-ui');
let html = fs.readFileSync(htmlPath, 'utf8');
if (currentUi) {
  const root = path.resolve(__dirname, '..');
  const assets = fs.readFileSync(path.join(root, 'src/artifacts/dashboard/assets.rs'), 'utf8');
  function rawConstant(name) {
    const match = assets.match(new RegExp('const ' + name + ': &str = r(#+)"([\\s\\S]*?)"\\1;'));
    assert(match, 'Current JS constant missing: ' + name);
    return match[2];
  }
  const locale = lang => fs.readFileSync(path.join(root, 'locales/' + lang + '.json'), 'utf8').replace(/<\//g, '<\\/');
  const script = rawConstant('JS_PREFIX') + locale('en') + rawConstant('JS_BETWEEN_LOCALES') + locale('pl') + rawConstant('JS_SUFFIX') + fs.readFileSync(path.join(root, 'src/artifacts/dashboard/evidence.js'), 'utf8');
  assert.equal((html.match(/<script>/g) || []).length, 1, 'Expected one executable inline dashboard script');
  html = html.replace(/<script>[\s\S]*?<\/script>/, () => '<script>' + script + '</script>');
}

function createDom(url) {
  const state = { errors: [], fetches: 0, scrolls: [], historyCalls: 0, blobs: new Map(), revoked: [] };
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => state.errors.push(error.message));
  const dom = new JSDOM(html, {
    url, runScripts: 'dangerously', virtualConsole,
    beforeParse(window) {
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      window.HTMLElement.prototype.scrollIntoView = function () { state.scrolls.push(this.id); };
      window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
      window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
      window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      window.Blob = Blob;
      window.URL.createObjectURL = blob => {
        const key = 'blob:prview-test-' + (state.blobs.size + 1);
        state.blobs.set(key, blob);
        return key;
      };
      window.URL.revokeObjectURL = key => state.revoked.push(key);
      window.fetch = async () => { state.fetches++; throw new Error('Network access is forbidden in this test'); };
      window.CSS = { escape: value => value.replace(/[^a-zA-Z0-9_-]/g, character => '\\' + character) };
      const replace = window.history.replaceState.bind(window.history);
      window.history.replaceState = (...args) => { state.historyCalls++; return replace(...args); };
    },
  });
  return { dom, state, loaded: new Promise(resolve => dom.window.addEventListener('load', resolve)) };
}
function click(element) { assert(element, 'Expected a clickable control'); element.click(); }
function escapeHtml(text) { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function addTemplate(doc, attribute, filePath, text, encoded = true) {
  const template = doc.createElement('template');
  template.setAttribute(attribute, filePath);
  if (encoded) template.dataset.contentEncoding = 'json-string';
  // Parse the same wire representation emitted by evidence.rs, including HTML
  // entity decoding and line-ending normalization at the HTML-parser boundary.
  template.innerHTML = '<pre>' + escapeHtml(encoded ? JSON.stringify(text) : text) + '</pre>';
  doc.body.append(template);
  return template;
}
function addLink(doc, filePath) {
  const link = doc.createElement('a');
  link.setAttribute('data-evidence-path', filePath);
  link.textContent = filePath;
  doc.body.append(link);
  return link;
}
function setSearch(dom, value) {
  const input = dom.window.document.getElementById('evidence-search');
  input.value = value;
  input.dispatchEvent(new dom.window.Event('input'));
}
function checkNavigation(dom, state, fileOrigin) {
  const doc = dom.window.document;
  const initialUrl = dom.window.location.href;
  const reading = doc.querySelector('.reading-steps a[href^="#"]');
  const sidebar = Array.from(doc.querySelectorAll('.sidebar-nav a[href^="#"]')).find(link => {
    const target = doc.getElementById(link.getAttribute('href').slice(1));
    return target && target.closest('.section-collapsible');
  });
  const fileLink = doc.querySelector('a[href^="#file-"]');
  for (const link of [reading, sidebar, fileLink]) {
    assert(link, 'Fixture must contain reading-path, sidebar and file navigation');
    const id = link.getAttribute('href').slice(1);
    const target = doc.getElementById(id);
    assert(target, 'Navigation target must exist: ' + id);
    const section = target.closest('.section-collapsible');
    if (section) section.classList.remove('expanded');
    const directory = target.closest('.dir-files-wrap');
    if (directory) directory.classList.add('collapsed');
    const previousCalls = state.historyCalls;
    const previousScrolls = state.scrolls.length;
    click(link);
    assert(state.scrolls.slice(previousScrolls).includes(id), 'Must scroll to requested DOM target: ' + id);
    if (section) assert(section.classList.contains('expanded'), 'Must expand target section');
    if (directory) assert(!directory.classList.contains('collapsed'), 'Must expand target directory');
    if (fileOrigin) {
      assert.equal(state.historyCalls, previousCalls, 'file: navigation must not rewrite history');
      assert.equal(dom.window.location.href, initialUrl, 'file: navigation must stay in the existing document');
    } else {
      assert.equal(state.historyCalls, previousCalls + 1, 'HTTP navigation retains a shareable hash');
      assert.equal(dom.window.location.hash, '#' + id);
    }
  }
  assert.equal(state.fetches, 0, 'DOM navigation must not fetch');
}

function checkSidebarGeometry(dom) {
  const { document: doc } = dom.window;
  const rectangles = new Map();
  const surface = id => {
    const target = doc.getElementById(id);
    assert(target, 'Fixture must contain geometry target: ' + id);
    return target.closest('.section-collapsible') || target;
  };
  for (const link of doc.querySelectorAll('.sidebar-nav a[href^="#"]')) {
    const target = doc.getElementById(link.hash.slice(1));
    if (!target) continue;
    // Different offset parents can all expose offsetTop=0 even though their
    // panels occupy entirely different places in the document.
    Object.defineProperty(target, 'offsetTop', {configurable:true, get:() => 0});
    const panel = target.closest('.section-collapsible') || target;
    panel.classList.add('expanded');
    panel.getBoundingClientRect = () => rectangles.get(panel) || {top:0, bottom:0, height:0};
  }
  Object.defineProperty(dom.window, 'scrollY', {configurable:true, value:1400});
  Object.defineProperty(dom.window, 'innerHeight', {configurable:true, value:900});
  function place(id, top, height) { rectangles.set(surface(id), {top, bottom:top + height, height}); }
  function expectActive(id, event = 'scroll') {
    dom.window.dispatchEvent(new dom.window.Event(event));
    const active = [...doc.querySelectorAll('.sidebar-nav a.active')];
    assert.equal(active.length, 1, 'Only one section may represent the reading position');
    assert.equal(active[0].hash, '#' + id, 'Active section must follow viewport geometry, not offsetParent/menu order');
    assert.equal(active[0].getAttribute('aria-current'), 'location');
    assert.equal(doc.querySelectorAll('.sidebar-nav [aria-current="location"]').length, 1);
  }
  place('section-checks', 20, 500);
  place('section-files', 550, 500);
  place('section-statistics', 1100, 500);
  place('section-commits', 1700, 180);
  place('section-time-budget', 1950, 200);
  expectActive('section-checks');
  place('section-checks', -650, 500);
  place('section-files', -100, 500);
  place('section-statistics', 420, 500);
  expectActive('section-files');
  place('section-files', -750, 500);
  place('section-statistics', -100, 700);
  place('section-commits', 620, 180);
  place('section-time-budget', 820, 200);
  expectActive('section-statistics');
  // Visible panel positions can differ from the sidebar's semantic grouping.
  place('section-checks', 300, 200);
  place('section-files', 20, 240);
  place('section-statistics', 540, 200);
  expectActive('section-files', 'resize');
  // A collapsed body has no rect; its visible header still participates.
  const files = surface('section-files');
  files.classList.remove('expanded');
  doc.getElementById('section-files').getBoundingClientRect = () => ({top:0, bottom:0, height:0});
  place('section-files', 50, 60);
  expectActive('section-files');
  // An empty/hidden panel must not win simply because its top is zero.
  place('section-time-budget', 0, 0);
  expectActive('section-files');
  console.log('PASS: sidebar geometry tracks checks/files/structural panels across scrolling, resizing, reordered sections and collapsed headers; hidden sections excluded.');
}

async function runReaderGate() {
  const { dom, state, loaded } = createDom('https://prview.test/dashboard.html');
  const doc = dom.window.document;
  const actualSarif = doc.querySelector('[data-evidence-path="30_context/INLINE_FINDINGS.sarif"]');
  const sarifPath = actualSarif ? '30_context/INLINE_FINDINGS.sarif' : 'test-fixture/located.sarif';
  if (!actualSarif) {
    assert(doc.querySelector('[data-i18n="evidence.noLocated"]'), 'Absent SARIF must be explained, not linked');
    addTemplate(doc, 'data-evidence-content', sarifPath, JSON.stringify({version:'2.1.0', runs:[{results:[]}]}));
    addLink(doc, sarifPath);
  }
  const longText = Array.from({length: 12001}, (_, n) => 'line ' + (n + 1)).join('\r\n');
  addTemplate(doc, 'data-evidence-content', '20_quality/long.log', longText);
  const originalText = '\ufeff\nZażółć <&>\r\nneedle needle\rLone CR\n</template><script>unsafe()</script>\r\n';
  addTemplate(doc, 'data-evidence-content', '20_quality/original.log', originalText);
  const originalJson = '{ "message" : "Zażółć <&>", "count" : 2 }\r\n';
  addTemplate(doc, 'data-evidence-content', '20_quality/original.json', originalJson);
  addTemplate(doc, 'data-evidence-content', '20_quality/legacy.log', 'legacy\r\ntext', false);
  addTemplate(doc, 'data-evidence-content', '20_quality/search.md', '- needle needle [needle](../PR_REVIEW.md)\n\ncom**plete** a.* aX ŻÓŁĆ');
  const formatted = doc.createElement('template');
  formatted.setAttribute('data-evidence-rendered', '20_quality/search.md');
  formatted.innerHTML = '<ul><li><p>needle needle <a href="../PR_REVIEW.md">needle</a></p></li></ul><p>com<strong>plete</strong> a.* aX ŻÓŁĆ</p>';
  doc.body.append(formatted);
  for (const filePath of ['20_quality/long.log', '20_quality/original.log', '20_quality/original.json', '20_quality/legacy.log', '20_quality/search.md', '20_quality/not-embedded.log']) addLink(doc, filePath);
  await loaded;
  try {
    const dialog = doc.getElementById('evidence-dialog');
    const body = doc.getElementById('evidence-body');
    const original = doc.getElementById('evidence-original');
    const next = doc.getElementById('evidence-next');
    const count = doc.getElementById('evidence-match-count');
    const open = filePath => click(doc.querySelector('[data-evidence-path="' + filePath + '"]'));
    const close = () => click(doc.getElementById('evidence-close'));
    async function assertDownload(text, name, exact) {
      assert(!original.hidden);
      assert(original.href.startsWith('blob:'), 'Embedded original must use Blob, not a file: navigation');
      assert.equal(original.getAttribute('download'), name);
      assert(!original.hasAttribute('target'), 'Embedded download must not request a new tab');
      assert.equal(original.dataset.i18n, exact ? 'evidence.original' : 'evidence.downloadEmbeddedText');
      // jsdom 29 caches the href property for opaque blob: URLs after mutation;
      // read the current DOM attribute that the browser uses for the download.
      const blob = state.blobs.get(original.getAttribute('href'));
      assert(blob, 'Blob bytes must be available');
      assert.deepEqual(Buffer.from(await blob.arrayBuffer()), Buffer.from(text, 'utf8'), 'Download must preserve complete original UTF-8 bytes, not display text');
    }
    for (const filePath of ['00_summary/MERGE_GATE.md', '00_summary/MERGE_GATE.json', '00_summary/PROVENANCE.json', '00_summary/FAILURES_SUMMARY.md', 'PR_REVIEW.md', 'REVIEW_SUMMARY.md', sarifPath, '10_diff/full.patch']) {
      open(filePath);
      assert(dialog.open, filePath + ' must open in the reader');
      assert.equal(doc.getElementById('evidence-title').textContent, filePath);
      assert(body.textContent.trim().length > 10, filePath + ' must have readable evidence');
      // Reviewed source can itself contain the reader's unavailable-message text.
      // Inspect the content structure instead of treating evidence as UI state.
      assert(doc.querySelector('template[data-evidence-content="' + filePath + '"]'), filePath + ' must be embedded');
      assert(body.querySelector('.evidence-line, article'), filePath + ' must render its embedded content');
      assert.equal(dom.window.location.pathname, '/dashboard.html');
      if (filePath.endsWith('.md')) {
        assert(body.querySelector('article'), 'Markdown should have a formatted view');
        click(doc.getElementById('evidence-format'));
        assert(body.querySelector('.evidence-line'), 'Raw Markdown remains accessible');
      }
      close();
      assert(!dialog.open);
    }

    open('20_quality/search.md');
    const articleText = body.querySelector('article').textContent;
    const link = body.querySelector('a');
    setSearch(dom, 'needle');
    assert.equal(count.textContent, '1 of 3 matches on this page', 'Nested list/paragraph must not double-count hits');
    assert.equal(body.querySelectorAll('mark.evidence-match').length, 1);
    assert.equal(body.querySelector('mark.evidence-match').textContent, 'needle', 'Highlight only exact text, not the paragraph');
    click(next);
    assert.equal(count.textContent, '2 of 3 matches on this page');
    assert.equal(body.querySelector('p').childNodes[0].textContent, 'needle ');
    click(next);
    assert.equal(count.textContent, '3 of 3 matches on this page');
    assert.equal(body.querySelector('mark').closest('a'), link, 'Matching a link must preserve its node and URL');
    click(next);
    assert.equal(count.textContent, '1 of 3 matches on this page', 'Next wraps to the first occurrence');
    setSearch(dom, 'complete');
    assert.equal(count.textContent, '1 of 1 matches on this page');
    assert.equal(Array.from(body.querySelectorAll('mark')).map(mark => mark.textContent).join(''), 'complete', 'One occurrence can cross inline markup');
    assert(body.querySelector('strong'), 'Search must preserve inline formatting');
    setSearch(dom, 'a.*');
    assert.equal(count.textContent, '1 of 1 matches on this page');
    assert.equal(body.querySelector('mark').textContent, 'a.*', 'Search input is literal, not executable regex');
    setSearch(dom, 'żółć');
    assert.equal(body.querySelector('mark').textContent, 'ŻÓŁĆ');
    setSearch(dom, 'missing');
    assert.equal(count.textContent, 'No matches on this page');
    assert(next.disabled);
    assert.equal(body.querySelectorAll('mark').length, 0);
    setSearch(dom, '');
    assert.equal(count.textContent, '');
    assert.equal(body.querySelector('article').textContent, articleText, 'Clearing search restores unchanged content');
    assert.equal(body.querySelector('a'), link);
    click(link);
    assert.equal(doc.getElementById('evidence-title').textContent, 'PR_REVIEW.md', 'Nested evidence links remain functional after highlighting');
    close();

    open('20_quality/original.log');
    setSearch(dom, 'needle');
    assert.equal(count.textContent, '1 of 2 matches on this page', 'Two occurrences in one raw line are distinct');
    click(next);
    assert.equal(count.textContent, '2 of 2 matches on this page');
    await assertDownload(originalText, 'original.log', true);
    assert.equal(typeof dom.window.unsafe, 'undefined', 'Evidence never becomes executable markup');
    close();
    open('20_quality/original.json');
    assert(body.querySelectorAll('.evidence-line').length > 1, 'JSON is formatted for display');
    await assertDownload(originalJson, 'original.json', true);
    close();
    open('20_quality/legacy.log');
    await assertDownload('legacy\ntext', 'legacy.log', false);
    close();
    open('20_quality/not-embedded.log');
    assert.equal(original.dataset.i18n, 'evidence.openOriginalFile');
    assert(!original.hasAttribute('download'), 'Unavailable original is a separate file link, not a promised download');
    assert.equal(original.target, '_blank');
    assert(body.textContent.includes('complete original is not embedded'));
    close();

    open('20_quality/long.log');
    assert.equal(body.querySelectorAll('.evidence-line').length, 5000);
    setSearch(dom, 'line 12001');
    assert.equal(count.textContent, 'No matches on this page', 'Search scope must be honest about pagination');
    click(Array.from(body.querySelectorAll('button')).find(button => button.textContent === 'Next page'));
    assert.equal(body.querySelector('.evidence-line').dataset.line, '5001');
    assert.equal(doc.getElementById('evidence-search').value, 'line 12001', 'Page navigation preserves the query');
    assert.equal(count.textContent, 'No matches on this page');
    click(Array.from(body.querySelectorAll('button')).find(button => button.textContent === 'Next page'));
    assert.equal(body.querySelector('.evidence-line').dataset.line, '10001');
    assert.equal(body.querySelectorAll('.evidence-line').length, 2001);
    assert.equal(count.textContent, '1 of 1 matches on this page');
    assert.equal(body.querySelector('mark.evidence-match').textContent, 'line 12001');
    await assertDownload(longText, 'long.log', true);
    close();

    const source = Array.from(doc.querySelectorAll('[data-source-path]')).find(item => doc.querySelector('template[data-source-content="' + item.dataset.sourcePath + '"]'));
    assert(source, 'Real fixture must expose at least one committed source');
    click(source);
    assert(body.querySelector('.evidence-line'));
    assert(!original.hidden && original.href.startsWith('blob:'));
    assert(doc.getElementById('evidence-note').textContent.includes('Committed target'));
    close();
    const row = doc.querySelector('.file-row');
    assert(row, 'Fixture must expose changed-file rows');
    click(row);
    assert(dialog.open, 'Changed-file rows must use the evidence reader');
    assert.equal(doc.getElementById('evidence-title').textContent, row.dataset.patchPath?.replace(/^\.\//, '') || '10_diff/full.patch');
    close();
    const checkbox = doc.createElement('input');
    checkbox.type = 'checkbox';
    row.append(checkbox);
    const checked = checkbox.checked;
    click(checkbox);
    assert.equal(checkbox.checked, !checked);
    assert(!dialog.open, 'Review checkbox must not open evidence');
    const modifiedClick = new dom.window.MouseEvent('click', {bubbles:true, cancelable:true, ctrlKey:true});
    row.dispatchEvent(modifiedClick);
    assert(!dialog.open, 'Modified click must not open evidence');
    assert(!modifiedClick.defaultPrevented);
    checkNavigation(dom, state, false);

    click(doc.getElementById('lang-toggle-pl'));
    assert.equal(doc.documentElement.lang, 'pl');
    assert.equal(doc.querySelector('[data-i18n="evidence.readingPath"]').textContent, 'Przejdź przez review');
    const warningReason = doc.createElement('p');
    warningReason.dataset.decisionReason = '1 warning signal: 1 unclassified; 10 review signals need attention';
    doc.body.append(warningReason);
    const signals = doc.createElement('p');
    signals.dataset.reviewSignals = 'heuristics_loctree skipped: heuristics disabled · Semgrep analysis was partial; incompletely parsed files: src/example.rs · Rust API delta: 1 unknown finding';
    doc.body.append(signals);
    const skipped = doc.createElement('p');
    skipped.dataset.i18nTemplate = 'message.skippedCheckDetail';
    skipped.dataset.reason = 'tests disabled';
    doc.body.append(skipped);
    click(doc.getElementById('lang-toggle-en'));
    assert.equal(warningReason.textContent, warningReason.dataset.decisionReason, 'Switching to English retains original recorded wording');
    assert(skipped.textContent.includes('Reason: tests disabled.'));
    click(doc.getElementById('lang-toggle-pl'));
    assert.equal(warningReason.textContent, '1 sygnał ostrzegawczy: 1 bez ustalonego pochodzenia; 10 sygnałów wymaga uwagi');
    assert.equal(signals.textContent, 'heuristics_loctree — pominięto: analiza strukturalna wyłączona · Analiza Semgrep była częściowa; pliki sparsowane nie w pełni: src/example.rs · Zmiany API Rust: 1 obserwacja o nieustalonym znaczeniu');
    assert(skipped.textContent.includes('Powód: testy wyłączone.'));
    open('20_quality/search.md');
    setSearch(dom, 'needle');
    assert.equal(count.textContent, 'Trafienie 1 z 3 na tej stronie');
    for (const element of doc.querySelectorAll('[data-i18n], [data-i18n-template]')) {
      assert(!element.textContent.includes('<span data-i18n'), 'Translation markup must not appear as text');
    }
    assert.equal(state.fetches, 0, 'Reader must not fetch artifacts');
    assert.deepEqual(state.errors, [], 'Dashboard scripts must execute without errors');
    console.log('PASS: ' + (actualSarif ? 'eight pack surfaces' : 'seven pack surfaces + synthetic SARIF') + '; exact per-occurrence search, links, page-local counts, complete UTF-8 Blob bytes, original fallback, Markdown/raw, target source, Polish, HTTP hash navigation.');
  } finally { dom.window.close(); }
}
async function runFileNavigationGate() {
  const { dom, state, loaded } = createDom('file:///retained/dashboard.html');
  await loaded;
  try {
    checkNavigation(dom, state, true);
    checkSidebarGeometry(dom);
    assert.deepEqual(state.errors, []);
    console.log('PASS: file-origin DOM reading-path/sidebar/file navigation expands and scrolls without history rewrites or fetches (native file permissions untested).');
  } finally { dom.window.close(); }
}
(async () => {
  if (currentUi) console.log('MODE: current JS/locales over retained HTML in memory; not a regenerated pack or browser QA.');
  await runReaderGate();
  await runFileNavigationGate();
})().catch(error => { console.error(error); process.exitCode = 1; });
