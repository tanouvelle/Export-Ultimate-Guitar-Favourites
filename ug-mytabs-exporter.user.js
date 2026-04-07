// ==UserScript==
// @name         Export UG Favourites .JSON for Freetar
// @namespace    http://tan.local/
// @version      3.2.1
// @description  Export Ultimate-guitar.com Favourites into a .JSON file for import into Freetar
// @author       Tan
// @match        https://www.ultimate-guitar.com/user/mytabs*
// @match         https://www.ultimate-guitar.com/tab/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=ultimate-guitar.com
// @run-at       document-idle
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// ==/UserScript==


(function () {
    'use strict';

    const BUTTON_ID = 'ug-mytabs-export-btn';
    const TOGGLE_ID = 'ug-mytabs-toggle-btn';
    const CANCEL_ID = 'ug-mytabs-cancel-btn';
    const STATUS_ID = 'ug-mytabs-status-pill';

    const LIBRARY_KEY = 'ug_library_v5';
    const META_KEY = 'ug_library_meta_v5';
    const HIDDEN_KEY = 'ug_export_button_hidden_v3';

    const DEBUG = false;
    const ERROR_RETRY_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours
    const SAVE_EVERY_N_TABS = 10;
    const UI_UPDATE_EVERY_N_TABS = 5;
    const IFRAME_LOAD_WAIT_MS = 1400;
    const IFRAME_TIMEOUT_MS = 20000;

    const runState = {
        running: false,
        canceled: false,
        processed: 0,
        total: 0,
        skipped: 0,
        failed: 0,
        succeeded: 0,
        mode: '',
        startedAt: null
    };

    function log(...args) {
        if (DEBUG) console.log('[UG Exporter Light]', ...args);
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function cleanText(value) {
        return (value || '').replace(/\s+/g, ' ').trim();
    }

    function nowIso() {
        return new Date().toISOString();
    }

    function nowMs() {
        return Date.now();
    }

    async function getValue(key, fallback) {
        const v = await GM_getValue(key, fallback);
        return v ?? fallback;
    }

    async function setValue(key, value) {
        await GM_setValue(key, value);
    }

    async function deleteValue(key) {
        await GM_deleteValue(key);
    }

    function downloadJSON(filename, data) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
    }

    function parseTabInfoFromPath(pathname) {
        const parts = pathname.split('/').filter(Boolean);
        if (parts.length < 3 || parts[0] !== 'tab') return null;

        const artistSlug = parts[1];
        const tabSlug = parts[2];

        const artist = artistSlug
            .split('-')
            .map(w => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');

        let type = '';
        if (/chords/i.test(tabSlug)) type = 'Chords';
        else if (/ukulele/i.test(tabSlug)) type = 'Ukulele';
        else if (/bass/i.test(tabSlug)) type = 'Bass';
        else if (/drums/i.test(tabSlug)) type = 'Drums';
        else if (/official/i.test(tabSlug)) type = 'Official';
        else type = 'Tab';

        const song = tabSlug
            .replace(/-(chords|tab|tabs|ukulele|bass|drums|official|pro)-\d+$/i, '')
            .replace(/-\d+$/i, '')
            .split('-')
            .map(w => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');

        return {
            artist_name: artist,
            song,
            type,
            rating: '',
            tab_url: pathname
        };
    }

    function findBestContainer(el) {
        return (
            el.closest('article') ||
            el.closest('section') ||
            el.closest('[data-testid]') ||
            el.closest('li') ||
            el.closest('div')
        );
    }

    function getTextFromContainer(container, selectors) {
        for (const sel of selectors) {
            const node = container.querySelector(sel);
            if (node) {
                const text = cleanText(node.textContent);
                if (text) return text;
            }
        }
        return '';
    }

    function extractRating(container) {
        const direct = getTextFromContainer(container, [
            '[class*="rating"]',
            '[data-testid*="rating"]',
            '[aria-label*="rating"]',
            '[title*="rating"]'
        ]);
        if (direct) {
            const m = direct.match(/\b(\d(?:\.\d)?)\b/);
            return m ? m[1] : direct;
        }
        return '';
    }

    function extractVisibleEntries() {
        const anchors = [...document.querySelectorAll('a[href*="/tab/"]')];
        const out = {};

        for (const a of anchors) {
            try {
                const url = new URL(a.href, location.origin);
                if (!url.pathname.startsWith('/tab/')) continue;
                if (out[url.pathname]) continue;

                const entry = parseTabInfoFromPath(url.pathname);
                if (!entry) continue;

                const container = findBestContainer(a);
                if (container) {
                    const nearbyArtist = getTextFromContainer(container, [
                        '[class*="artist"]',
                        '[data-testid*="artist"]'
                    ]);
                    const nearbySong = getTextFromContainer(container, [
                        '[class*="song"]',
                        '[class*="title"]',
                        '[data-testid*="title"]',
                        'h1', 'h2', 'h3'
                    ]);
                    const nearbyType = getTextFromContainer(container, [
                        '[class*="type"]',
                        '[data-testid*="type"]',
                        '[class*="tag"]'
                    ]);
                    const nearbyRating = extractRating(container);

                    if (nearbyArtist) entry.artist_name = nearbyArtist;
                    if (nearbySong) entry.song = nearbySong;
                    if (nearbyType) entry.type = nearbyType;
                    if (nearbyRating) entry.rating = nearbyRating;
                }

                out[url.pathname] = entry;
            } catch (err) {
                log('extractVisibleEntries error', err);
            }
        }

        return out;
    }

    async function autoScrollLoad() {
        let lastHeight = -1;
        let stable = 0;

        for (let i = 0; i < 35; i++) {
            if (runState.canceled) return;

            window.scrollTo(0, document.body.scrollHeight);
            await sleep(700);

            const currentHeight = document.body.scrollHeight;
            if (currentHeight === lastHeight) {
                stable++;
                if (stable >= 3) break;
            } else {
                stable = 0;
            }
            lastHeight = currentHeight;
        }

        window.scrollTo(0, 0);
        await sleep(200);
    }

    function makeHiddenIframe(url) {
        const iframe = document.createElement('iframe');
        iframe.src = url;
        iframe.style.position = 'fixed';
        iframe.style.left = '-99999px';
        iframe.style.top = '0';
        iframe.style.width = '1200px';
        iframe.style.height = '900px';
        iframe.style.opacity = '0';
        iframe.style.pointerEvents = 'none';
        iframe.style.border = '0';
        document.body.appendChild(iframe);
        return iframe;
    }

    function deepFindString(obj, wantedKeys = []) {
        const seen = new WeakSet();
        let best = '';

        function walk(value, keyPath = []) {
            if (!value || typeof value !== 'object') return;
            if (seen.has(value)) return;
            seen.add(value);

            if (Array.isArray(value)) {
                for (const item of value) walk(item, keyPath);
                return;
            }

            for (const [k, v] of Object.entries(value)) {
                const nextPath = keyPath.concat(k);

                if (typeof v === 'string') {
                    const lowerPath = nextPath.join('.').toLowerCase();
                    const looksWanted = wantedKeys.some(w => lowerPath.includes(w));
                    const looksLikeTabText =
                        v.length > 200 &&
                        /(\[ch\]|\[\/ch\]|\[tab\]|\[\/tab\]|^\s*[A-G][#bm0-9/+\-]*)/m.test(v);

                    if ((looksWanted || looksLikeTabText) && v.length > best.length) {
                        best = v;
                    }
                } else if (v && typeof v === 'object') {
                    walk(v, nextPath);
                }
            }
        }

        walk(obj);
        return best;
    }

    function tryParseJson(text) {
        try {
            return JSON.parse(text);
        } catch {
            return null;
        }
    }

    function tryExtractFromScripts(doc, pathname) {
        const scripts = [...doc.scripts];
        const fallback = parseTabInfoFromPath(pathname) || {};

        for (const s of scripts) {
            const txt = s.textContent || '';
            if (!txt || txt.length < 100) continue;

            if (s.type && s.type.includes('json')) {
                const parsed = tryParseJson(txt);
                if (parsed) {
                    const chordText = deepFindString(parsed, ['content', 'tab', 'wiki_tab', 'tab_view']);
                    if (chordText) {
                        return {
                            chord_text: chordText,
                            artist_name: fallback.artist_name,
                            song: fallback.song,
                            type: fallback.type
                        };
                    }
                }
            }

            if (
                txt.includes('window.__PRELOADED_STATE__') ||
                txt.includes('window.__INITIAL_STATE__') ||
                txt.includes('__NEXT_DATA__') ||
                txt.includes('wiki_tab') ||
                txt.includes('tab_view')
            ) {
                const contentMatch =
                    txt.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/) ||
                    txt.match(/"wiki_tab"\s*:\s*\{[\s\S]*?"content"\s*:\s*"((?:[^"\\]|\\.)*)"/) ||
                    txt.match(/"tab_view"\s*:\s*\{[\s\S]*?"content"\s*:\s*"((?:[^"\\]|\\.)*)"/);

                if (contentMatch) {
                    const raw = contentMatch[1]
                        .replace(/\\"/g, '"')
                        .replace(/\\n/g, '\n')
                        .replace(/\\r/g, '\r')
                        .replace(/\\t/g, '\t')
                        .replace(/\\\\/g, '\\');

                    if (raw && raw.length > 50) {
                        return {
                            chord_text: raw,
                            artist_name: fallback.artist_name,
                            song: fallback.song,
                            type: fallback.type
                        };
                    }
                }
            }
        }

        return null;
    }

    function tryExtractFromDom(doc, pathname) {
        const fallback = parseTabInfoFromPath(pathname) || {};
        const candidates = [
            ...doc.querySelectorAll('pre'),
            ...doc.querySelectorAll('[class*="tab-content"]'),
            ...doc.querySelectorAll('[class*="js-tab-content"]'),
            ...doc.querySelectorAll('[data-content]'),
            ...doc.querySelectorAll('code')
        ];

        let best = '';
        for (const el of candidates) {
            const t = cleanText(el.textContent);
            if (t.length > best.length) best = t;
        }

        if (best.length > 100) {
            return {
                chord_text: best,
                artist_name: fallback.artist_name,
                song: fallback.song,
                type: fallback.type
            };
        }

        return null;
    }

    async function parseTabPageThroughIframe(fullUrl) {
        return new Promise((resolve) => {
            const iframe = makeHiddenIframe(fullUrl);

            const finish = (result) => {
                try { iframe.remove(); } catch (_) {}
                resolve(result);
            };

            const timeout = setTimeout(() => {
                finish({ ok: false, error: 'Timed out loading page' });
            }, IFRAME_TIMEOUT_MS);

            iframe.onload = async () => {
                try {
                    if (runState.canceled) {
                        clearTimeout(timeout);
                        finish({ ok: false, error: 'Canceled' });
                        return;
                    }

                    await sleep(IFRAME_LOAD_WAIT_MS);

                    const doc = iframe.contentDocument;
                    if (!doc) {
                        clearTimeout(timeout);
                        finish({ ok: false, error: 'No iframe document' });
                        return;
                    }

                    const pathname = new URL(fullUrl).pathname;
                    const byScript = tryExtractFromScripts(doc, pathname);
                    const parsed = byScript || tryExtractFromDom(doc, pathname);

                    clearTimeout(timeout);

                    if (!parsed || !parsed.chord_text) {
                        finish({ ok: false, error: 'Page loaded but tab content not found' });
                        return;
                    }

                    finish({
                        ok: true,
                        ...parsed,
                        cached_at: nowIso()
                    });
                } catch (err) {
                    clearTimeout(timeout);
                    finish({ ok: false, error: err.message });
                }
            };
        });
    }

    async function getLibrary() {
        return await getValue(LIBRARY_KEY, {});
    }

    async function setLibrary(library) {
        const entryCount = Object.keys(library).length;
        await setValue(LIBRARY_KEY, library);
        await setValue(META_KEY, {
            updated_at: nowIso(),
            entry_count: entryCount
        });
    }

    function mergeVisibleMetadataIntoLibrary(library, visibleEntries) {
        const ts = nowIso();

        for (const [path, visible] of Object.entries(visibleEntries)) {
            library[path] = {
                ...(library[path] || {}),
                ...visible,
                first_seen_at: library[path]?.first_seen_at || ts,
                last_seen_at: ts
            };
        }

        return library;
    }

    function shouldSkipPath(path, libraryEntry, forceRefreshVisible) {
        if (forceRefreshVisible) return false;
        if (!libraryEntry) return false;

        if (libraryEntry.parse_status === 'ok' && libraryEntry.chord_text) {
            return true;
        }

        if (libraryEntry.parse_status === 'error' && libraryEntry.checked_at) {
            const checkedMs = new Date(libraryEntry.checked_at).getTime();
            if (!Number.isNaN(checkedMs) && (nowMs() - checkedMs) < ERROR_RETRY_COOLDOWN_MS) {
                return true;
            }
        }

        return false;
    }

    function getTargetPaths(library, visibleEntries, forceRefreshVisible) {
        const allPaths = Object.keys(visibleEntries);
        const targetPaths = [];
        let skipped = 0;

        for (const path of allPaths) {
            if (shouldSkipPath(path, library[path], forceRefreshVisible)) {
                skipped++;
            } else {
                targetPaths.push(path);
            }
        }

        runState.skipped = skipped;
        return targetPaths;
    }

    async function enrichPaths(library, paths, modeLabel) {
        runState.processed = 0;
        runState.total = paths.length;
        runState.mode = modeLabel;
        runState.failed = 0;
        runState.succeeded = 0;
        updateRunUi();

        for (let i = 0; i < paths.length; i++) {
            if (runState.canceled) break;

            const path = paths[i];
            const fullUrl = new URL(path, location.origin).href;
            const parsed = await parseTabPageThroughIframe(fullUrl);

            if (runState.canceled) break;

            if (parsed.ok) {
                library[path] = {
                    ...(library[path] || {}),
                    artist_name: parsed.artist_name || library[path]?.artist_name || '',
                    song: parsed.song || library[path]?.song || '',
                    type: parsed.type || library[path]?.type || '',
                    rating: library[path]?.rating || '',
                    tab_url: path,
                    chord_text: parsed.chord_text,
                    cached_at: parsed.cached_at,
                    parse_status: 'ok',
                    checked_at: nowIso(),
                    cache_error: ''
                };
                runState.succeeded++;
            } else {
                library[path] = {
                    ...(library[path] || {}),
                    tab_url: path,
                    parse_status: 'error',
                    cache_error: parsed.error,
                    checked_at: nowIso()
                };
                runState.failed++;
            }

            runState.processed = i + 1;

            if ((i + 1) % SAVE_EVERY_N_TABS === 0 || i === paths.length - 1) {
                await setLibrary(library);
            }

            if ((i + 1) % UI_UPDATE_EVERY_N_TABS === 0 || i === paths.length - 1) {
                updateRunUi();
            }

            await sleep(450);
        }
    }

    async function exportMergedLibrary({ forceRefreshVisible = false, exportNewOnly = false } = {}) {
        if (runState.running) {
            alert('An export is already running.');
            return;
        }

        const btn = document.getElementById(BUTTON_ID);
        runState.running = true;
        runState.canceled = false;
        runState.processed = 0;
        runState.total = 0;
        runState.skipped = 0;
        runState.failed = 0;
        runState.succeeded = 0;
        runState.mode = 'Loading';
        runState.startedAt = nowIso();
        updateRunUi();

        try {
            if (btn) btn.disabled = true;

            await autoScrollLoad();
            if (runState.canceled) throw new Error('Export canceled.');

            const visibleEntries = extractVisibleEntries();
            const visibleCount = Object.keys(visibleEntries).length;

            if (!visibleCount) {
                throw new Error('No tabs were detected on /user/mytabs.');
            }

            let library = await getLibrary();
            library = mergeVisibleMetadataIntoLibrary(library, visibleEntries);
            await setLibrary(library);

            const targetPaths = getTargetPaths(library, visibleEntries, forceRefreshVisible);

            if (targetPaths.length) {
                await enrichPaths(
                    library,
                    targetPaths,
                    forceRefreshVisible ? 'Refreshing' : 'Caching'
                );
            }

            if (runState.canceled) throw new Error('Export canceled.');

            library = await getLibrary();

            const exportObject = exportNewOnly
                ? Object.fromEntries(
                    Object.entries(library).filter(([path]) => visibleEntries[path])
                  )
                : library;

            const date = new Date().toISOString().slice(0, 10);
            const filename = exportNewOnly
                ? `ultimate-guitar-visible-tabs-${date}.json`
                : `ultimate-guitar-library-${date}.json`;

            downloadJSON(filename, exportObject);

            const totalCount = Object.keys(library).length;

            alert(
                `Visible tabs on page: ${visibleCount}\n` +
                `Skipped: ${runState.skipped}\n` +
                `Parsed this run: ${targetPaths.length}\n` +
                `Succeeded: ${runState.succeeded}\n` +
                `Failed: ${runState.failed}\n` +
                `Total cached library entries: ${totalCount}`
            );
        } catch (err) {
            if (String(err.message).toLowerCase().includes('canceled')) {
                alert('Export canceled.');
            } else {
                console.error(err);
                alert(`Export failed: ${err.message}`);
            }
        } finally {
            runState.running = false;
            runState.canceled = false;
            runState.processed = 0;
            runState.total = 0;
            runState.mode = '';
            runState.startedAt = null;

            if (btn) btn.disabled = false;
            await updateButtonLabel();
            updateRunUi();
        }
    }

    async function updateButtonLabel() {
        const btn = document.getElementById(BUTTON_ID);
        if (!btn) return;

        const hidden = await getValue(HIDDEN_KEY, false);
        btn.style.display = hidden ? 'none' : 'block';

        const meta = await getValue(META_KEY, { entry_count: 0 });
        const count = meta?.entry_count || 0;
        btn.textContent = `Export UG JSON (${count})`;

        const toggle = document.getElementById(TOGGLE_ID);
        if (toggle) {
            toggle.textContent = hidden ? 'Show' : 'Hide';
        }
    }

    function updateRunUi() {
        const status = document.getElementById(STATUS_ID);
        const cancelBtn = document.getElementById(CANCEL_ID);
        if (!status || !cancelBtn) return;

        if (!runState.running) {
            status.textContent = 'Idle';
            cancelBtn.style.display = 'none';
            return;
        }

        const parts = [
            runState.mode,
            `${runState.processed}/${runState.total}`
        ];

        if (runState.skipped) parts.push(`Skipped ${runState.skipped}`);
        if (runState.succeeded) parts.push(`OK ${runState.succeeded}`);
        if (runState.failed) parts.push(`Fail ${runState.failed}`);

        status.textContent = parts.join(' · ');
        cancelBtn.style.display = 'block';
    }

    async function clearLibrary() {
        if (runState.running) {
            alert('Cancel the current export first.');
            return;
        }

        await deleteValue(LIBRARY_KEY);
        await deleteValue(META_KEY);
        await updateButtonLabel();
        alert('UG library cache cleared.');
    }

    async function toggleMainButton() {
        const hidden = await getValue(HIDDEN_KEY, false);
        await setValue(HIDDEN_KEY, !hidden);
        await updateButtonLabel();
    }

    function cancelCurrentRun() {
        if (!runState.running) return;
        runState.canceled = true;
        updateRunUi();
    }

    function baseButtonStyle(extra = {}) {
        return Object.assign({
            position: 'fixed',
            left: '20px',
            zIndex: '2147483647',
            border: '1px solid rgba(0,0,0,0.2)',
            borderRadius: '10px',
            color: '#fff',
            cursor: 'pointer',
            boxShadow: '0 4px 12px rgba(0,0,0,0.20)',
            fontWeight: '600'
        }, extra);
    }

    function makeStatusPill() {
        if (document.getElementById(STATUS_ID)) return;

        const el = document.createElement('div');
        el.id = STATUS_ID;
        el.textContent = 'Idle';

        Object.assign(el.style, baseButtonStyle({
            bottom: '116px',
            padding: '8px 12px',
            background: '#333',
            fontSize: '12px',
            cursor: 'default',
            maxWidth: '320px'
        }));

        document.body.appendChild(el);
    }

    function makeCancelButton() {
        if (document.getElementById(CANCEL_ID)) return;

        const btn = document.createElement('button');
        btn.id = CANCEL_ID;
        btn.type = 'button';
        btn.textContent = 'Cancel';

        Object.assign(btn.style, baseButtonStyle({
            bottom: '68px',
            padding: '8px 12px',
            background: '#8b1e1e',
            fontSize: '12px',
            display: 'none'
        }));

        btn.addEventListener('click', cancelCurrentRun);
        document.body.appendChild(btn);
    }

    function makeToggleButton() {
        if (document.getElementById(TOGGLE_ID)) return;

        const btn = document.createElement('button');
        btn.id = TOGGLE_ID;
        btn.type = 'button';
        btn.textContent = 'Hide';

        Object.assign(btn.style, baseButtonStyle({
            bottom: '20px',
            padding: '8px 12px',
            background: '#222',
            fontSize: '12px'
        }));

        btn.addEventListener('click', toggleMainButton);
        document.body.appendChild(btn);
    }

    function makeButton() {
        if (document.getElementById(BUTTON_ID)) return;

        const btn = document.createElement('button');
        btn.id = BUTTON_ID;
        btn.textContent = 'Export UG JSON';
        btn.type = 'button';

        Object.assign(btn.style, baseButtonStyle({
            bottom: '20px',
            left: '86px',
            padding: '12px 16px',
            background: '#111',
            fontSize: '14px'
        }));

        btn.addEventListener('click', () => exportMergedLibrary());
        document.body.appendChild(btn);
    }

    let observerScheduled = false;

    function installObservers() {
        const observer = new MutationObserver(() => {
            if (observerScheduled) return;
            observerScheduled = true;

            setTimeout(() => {
                observerScheduled = false;

                if (!location.pathname.startsWith('/user/mytabs')) return;
                if (!document.getElementById(STATUS_ID)) makeStatusPill();
                if (!document.getElementById(CANCEL_ID)) makeCancelButton();
                if (!document.getElementById(TOGGLE_ID)) makeToggleButton();
                if (!document.getElementById(BUTTON_ID)) makeButton();
            }, 300);
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    async function init() {
        if (!location.pathname.startsWith('/user/mytabs')) return;

        while (!document.body) {
            await sleep(100);
        }

        makeStatusPill();
        makeCancelButton();
        makeToggleButton();
        makeButton();
        installObservers();

        await updateButtonLabel();
        updateRunUi();

        if (typeof GM_registerMenuCommand === 'function') {
            GM_registerMenuCommand('Export full merged UG library', () => exportMergedLibrary());
            GM_registerMenuCommand('Export visible tabs only', () => exportMergedLibrary({ exportNewOnly: true }));
            GM_registerMenuCommand('Force refresh visible tabs', () => exportMergedLibrary({ forceRefreshVisible: true, exportNewOnly: true }));
            GM_registerMenuCommand('Hide/Show export button', toggleMainButton);
            GM_registerMenuCommand('Cancel current export', cancelCurrentRun);
            GM_registerMenuCommand('Clear UG library cache', clearLibrary);
        }
    }

    init();
})();