// Evidence stays in this document and never requires fetch() on a file URL.
function installEvidenceReader(t) {
    var dialog = document.getElementById('evidence-dialog');
    if (!dialog) return;
    var body = document.getElementById('evidence-body');
    var title = document.getElementById('evidence-title');
    var note = document.getElementById('evidence-note');
    var search = document.getElementById('evidence-search');
    var original = document.getElementById('evidence-original');
    var next = document.getElementById('evidence-next');
    var matchCount = document.getElementById('evidence-match-count');
    // Retained reports can use the current reader without having this status node.
    if (!matchCount) {
        matchCount = document.createElement('span');
        matchCount.id = 'evidence-match-count';
        matchCount.setAttribute('role', 'status');
        matchCount.setAttribute('aria-live', 'polite');
        matchCount.setAttribute('aria-atomic', 'true');
        next.after(matchCount);
    }
    var artifacts = new Map();
    var sources = new Map();
    var rendered = new Map();
    var active;
    var rawView = false;
    var downloadUrl;
    var format = document.getElementById('evidence-format');
    document.querySelectorAll('template[data-evidence-content]').forEach(function(el) { artifacts.set(el.dataset.evidenceContent, el); });
    document.querySelectorAll('template[data-source-content]').forEach(function(el) { sources.set(el.dataset.sourceContent, el); });
    document.querySelectorAll('template[data-evidence-rendered]').forEach(function(el) { rendered.set(el.dataset.evidenceRendered, el); });
    var opener;
    var matchIndex = -1;
    function relativeUrl(path) { return './' + path.split('/').map(encodeURIComponent).join('/'); }
    function embeddedText(entry) {
        if (!entry) return undefined;
        if (!entry.dataset.contentEncoding) return {text: entry.content.textContent, exact: false};
        if (entry.dataset.contentEncoding !== 'json-string') return undefined;
        try {
            var text = JSON.parse(entry.content.textContent);
            return typeof text === 'string' ? {text: text, exact: true} : undefined;
        } catch (_) { return undefined; }
    }
    function setDownload(path, source, content) {
        if (downloadUrl) { URL.revokeObjectURL(downloadUrl); downloadUrl = undefined; }
        original.removeAttribute('target');
        original.removeAttribute('download');
        original.removeAttribute('href');
        original.hidden = source && !content;
        var key;
        if (content) {
            // Always use the complete stored text, never a formatted or paged view.
            downloadUrl = URL.createObjectURL(new Blob([content.text], {type:'text/plain;charset=utf-8', endings:'transparent'}));
            original.href = downloadUrl;
            original.download = path.split('/').pop();
            key = content.exact ? 'evidence.original' : 'evidence.downloadEmbeddedText';
        } else {
            key = 'evidence.openOriginalFile';
            if (!source) {
                original.href = relativeUrl(path);
                original.target = '_blank';
                original.rel = 'noopener';
            }
        }
        original.setAttribute('data-i18n', key);
        original.textContent = t(key);
    }
    function show(path, source, line, trigger, raw, pageStart) {
        var keepQuery = active && active[0] === path && active[1] === source && (pageStart !== undefined || raw !== undefined);
        var query = keepQuery ? search.value : '';
        active = [path, source, line, trigger];
        rawView = Boolean(raw);
        format.hidden = source || !rendered.has(path);
        format.textContent = t(rawView ? 'evidence.formatted' : 'evidence.raw');
        var entry = (source ? sources : artifacts).get(path);
        var content = embeddedText(entry);
        if (!dialog.contains(trigger)) opener = trigger;
        title.textContent = path;
        note.textContent = source ? t('evidence.source') + (entry ? ' · ' + entry.dataset.revision : '') : '';
        body.replaceChildren();
        search.value = query;
        matchIndex = -1;
        setDownload(path, source, content);
        if (content && !source && !rawView && rendered.has(path)) {
            var article = document.createElement('article');
            article.className = 'narrative-rendered';
            article.appendChild(rendered.get(path).content.cloneNode(true));
            body.appendChild(article);
        } else if (content) {
            var text = content.text;
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
            message.textContent = t(source ? 'evidence.sourceUnavailable' : 'evidence.originalNotEmbedded');
            body.appendChild(message);
        }
        if (!dialog.open) dialog.showModal();
        var selected = body.querySelector('.evidence-selected');
        if (selected) selected.scrollIntoView({block:'center'});
        findNext(true);
        search.focus();
    }
    document.addEventListener('click', function(event) {
        if (event.target.closest('button, input, select, textarea, label')) return;
        var link = event.target.closest('[data-evidence-path], [data-source-path], a[href], [data-patch-path], .file-row');
        if (!link || link === original || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        var source = link.dataset.sourcePath;
        var path = link.dataset.evidencePath || link.dataset.patchPath;
        if (!path && !source && link.classList.contains('file-row')) path = '10_diff/full.patch';
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
    function clearMatch() {
        body.querySelectorAll('mark[data-evidence-search-mark]').forEach(function(mark) {
            var parent = mark.parentNode;
            mark.replaceWith.apply(mark, Array.from(mark.childNodes));
            parent.normalize();
        });
    }
    function searchBlocks() {
        var groups = [];
        var walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        var node;
        var group;
        while ((node = walker.nextNode())) {
            var parent = node.parentElement;
            if (!parent || !parent.closest('.evidence-line, article')) continue;
            var block = parent.closest('.evidence-line, p, li, td, th, h1, h2, h3, h4, h5, h6, pre, blockquote, article');
            if (!group || group.block !== block) {
                group = {block: block, text: '', nodes: []};
                groups.push(group);
            }
            group.nodes.push({node: node, start: group.text.length, end: group.text.length + node.length});
            group.text += node.data;
        }
        return groups;
    }
    function highlightMatch(match) {
        // Split only text nodes: inline markup, links and their listeners survive.
        match.group.nodes.slice().reverse().forEach(function(part) {
            var start = Math.max(0, match.start - part.start);
            var end = Math.min(part.node.length, match.end - part.start);
            if (start >= end) return;
            if (end < part.node.length) part.node.splitText(end);
            var selected = start ? part.node.splitText(start) : part.node;
            var mark = document.createElement('mark');
            mark.className = 'evidence-match';
            mark.dataset.evidenceSearchMark = 'true';
            selected.parentNode.insertBefore(mark, selected);
            mark.appendChild(selected);
        });
        var first = body.querySelector('mark[data-evidence-search-mark]');
        if (first) first.scrollIntoView({block:'center'});
    }
    function findNext(reset) {
        clearMatch();
        var query = search.value;
        if (!query) {
            matchIndex = -1;
            matchCount.textContent = '';
            next.disabled = true;
            return;
        }
        var wanted = reset ? 0 : matchIndex + 1;
        var expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
        var total = 0;
        var first;
        var selected;
        searchBlocks().forEach(function(group) {
            expression.lastIndex = 0;
            var found;
            while ((found = expression.exec(group.text))) {
                var occurrence = {group: group, start: found.index, end: found.index + found[0].length};
                if (!first) first = occurrence;
                if (total === wanted) selected = occurrence;
                total++;
            }
        });
        next.disabled = total === 0;
        if (!total) {
            matchIndex = -1;
            matchCount.textContent = t('evidence.noMatches');
            return;
        }
        matchIndex = wanted % total;
        highlightMatch(selected || first);
        matchCount.textContent = t('evidence.matchCount').replace('{current}', matchIndex + 1).replace('{total}', total);
    }
    search.addEventListener('input', function() { findNext(true); });
    search.addEventListener('keydown', function(event) { if (event.key === 'Enter') { event.preventDefault(); findNext(false); } });
    next.addEventListener('click', function() { findNext(false); });
}
