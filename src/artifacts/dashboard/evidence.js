// Evidence stays in this document and never requires fetch() on a file URL.
function installEvidenceReader(t) {
    var dialog = document.getElementById('evidence-dialog');
    if (!dialog) return;
    var body = document.getElementById('evidence-body');
    var title = document.getElementById('evidence-title');
    var note = document.getElementById('evidence-note');
    var search = document.getElementById('evidence-search');
    var original = document.getElementById('evidence-original');
    var artifacts = new Map();
    var sources = new Map();
    var rendered = new Map();
    var active;
    var rawView = false;
    var sourceUrl;
    var format = document.getElementById('evidence-format');
    document.querySelectorAll('template[data-evidence-content]').forEach(function(el) { artifacts.set(el.dataset.evidenceContent, el); });
    document.querySelectorAll('template[data-source-content]').forEach(function(el) { sources.set(el.dataset.sourceContent, el); });
    document.querySelectorAll('template[data-evidence-rendered]').forEach(function(el) { rendered.set(el.dataset.evidenceRendered, el); });
    var opener;
    var matchIndex = -1;
    function relativeUrl(path) { return './' + path.split('/').map(encodeURIComponent).join('/'); }
    function show(path, source, line, trigger, raw, pageStart) {
        active = [path, source, line, trigger];
        rawView = Boolean(raw);
        format.hidden = source || !rendered.has(path);
        format.textContent = t(rawView ? 'evidence.formatted' : 'evidence.raw');
        var entry = (source ? sources : artifacts).get(path);
        if (!dialog.contains(trigger)) opener = trigger;
        title.textContent = path;
        note.textContent = source ? t('evidence.source') + (entry ? ' · ' + entry.dataset.revision : '') : '';
        body.replaceChildren();
        search.value = '';
        matchIndex = -1;
        if (sourceUrl) { URL.revokeObjectURL(sourceUrl); sourceUrl = undefined; }
        original.hidden = source && !entry;
        if (source && entry) {
            sourceUrl = URL.createObjectURL(new Blob([entry.content.textContent], {type:'text/plain;charset=utf-8'}));
            original.href = sourceUrl;
            original.download = path.split('/').pop();
        } else if (!source) {
            original.href = relativeUrl(path);
            original.download = path.split('/').pop();
        }
        if (entry && !source && !rawView && rendered.has(path)) {
            var article = document.createElement('article');
            article.className = 'narrative-rendered';
            article.appendChild(rendered.get(path).content.cloneNode(true));
            body.appendChild(article);
        } else if (entry) {
            var text = entry.content.textContent;
            if (/\.(json|sarif)$/.test(path)) {
                try { text = JSON.stringify(JSON.parse(text), null, 2); } catch (_) { /* Preserve original evidence. */ }
            }
            var pre = document.createElement('pre');
            var lines = text.split('\n');
            var start = pageStart === undefined ? Math.max(0, Math.min(lines.length - 5000, Number(line || 1) - 2500)) : pageStart;
            if (lines.length > 5000) {
                var limited = document.createElement('p');
                limited.textContent = t('evidence.limited').replace('{from}', start + 1).replace('{to}', Math.min(lines.length, start + 5000)).replace('{total}', lines.length);
                body.appendChild(limited);
                var paging = document.createElement('div');
                [[-5000, 'evidence.previousPage'], [5000, 'evidence.nextPage']].forEach(function(item) {
                    var button = document.createElement('button');
                    button.type = 'button';
                    button.textContent = t(item[1]);
                    button.disabled = item[0] < 0 ? start === 0 : start + 5000 >= lines.length;
                    button.addEventListener('click', function() { show(path, source, line, trigger, rawView, Math.max(0, start + item[0])); });
                    paging.appendChild(button);
                });
                body.appendChild(paging);
            }
            lines.slice(start, start + 5000).forEach(function(value, offset) {
                var index = start + offset;
                var row = document.createElement('span');
                row.className = 'evidence-line';
                row.dataset.line = String(index + 1);
                row.textContent = value || ' ';
                if (index + 1 === Number(line)) row.classList.add('evidence-selected');
                pre.appendChild(row);
            });
            body.appendChild(pre);
        } else {
            var message = document.createElement('p');
            message.textContent = t(source ? 'evidence.sourceUnavailable' : 'evidence.unavailable');
            body.appendChild(message);
        }
        if (!dialog.open) dialog.showModal();
        var selected = body.querySelector('.evidence-selected');
        if (selected) selected.scrollIntoView({block:'center'});
        search.focus();
    }
    document.addEventListener('click', function(event) {
        var link = event.target.closest('[data-evidence-path], [data-source-path], a[href], [data-patch-path]');
        if (!link || link === original || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        var source = link.dataset.sourcePath;
        var path = link.dataset.evidencePath || link.dataset.patchPath;
        if (path && path.startsWith('./')) path = path.slice(2);
        if (!path && !source && link.tagName === 'A') {
            var href = link.getAttribute('href');
            if (!href || href[0] === '#' || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return;
            try { path = decodeURIComponent(href.split('#')[0]).replace(/^\.\//, ''); } catch (_) { return; }
            if (dialog.contains(link) && active && !active[1]) {
                var parts = active[0].split('/').slice(0, -1);
                var invalid = false;
                path.split('/').forEach(function(part) {
                    if (part === '..') { if (parts.length) parts.pop(); else invalid = true; }
                    else if (part && part !== '.') parts.push(part);
                });
                if (invalid) { event.preventDefault(); return; }
                path = parts.join('/');
            }
            if (!artifacts.has(path)) return;
        }
        if (!path && !source) return;
        // Keys are pack-relative evidence names, never arbitrary URLs/paths.
        var key = source || path;
        if (key.startsWith('/') || key.split('/').includes('..') || /^[a-z][a-z0-9+.-]*:/i.test(key)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        show(key, Boolean(source), link.dataset.sourceLine, link);
    }, true);
    document.getElementById('evidence-close').addEventListener('click', function() { dialog.close(); });
    dialog.addEventListener('close', function() { if (opener) opener.focus(); });
    format.addEventListener('click', function() { if (active) show(active[0], active[1], active[2], active[3], !rawView); });
    function findNext(reset) {
        if (reset) matchIndex = -1;
        var query = search.value.toLocaleLowerCase();
        var rows = Array.from(body.querySelectorAll('.evidence-line, article p, article li, article tr, article h1, article h2, article h3'));
        var matches = rows.filter(function(row) { return query && row.textContent.toLocaleLowerCase().includes(query); });
        rows.forEach(function(row) { row.classList.remove('evidence-match'); });
        if (matches.length) {
            matchIndex = (matchIndex + 1) % matches.length;
            matches[matchIndex].classList.add('evidence-match');
            matches[matchIndex].scrollIntoView({block:'center'});
        }
    }
    search.addEventListener('input', function() { findNext(true); });
    search.addEventListener('keydown', function(event) { if (event.key === 'Enter') { event.preventDefault(); findNext(false); } });
    document.getElementById('evidence-next').addEventListener('click', function() { findNext(false); });
}
