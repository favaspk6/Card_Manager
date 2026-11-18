/* DueDates offline layer: caches Supabase reads in IndexedDB and queues writes made without internet.
   Must load BEFORE app.js (app.js passes DDO.ddFetch to the Supabase client). */
// ===== OFFLINE SUPPORT =====
// Reads: every successful Supabase GET is cached in IndexedDB and served back when offline.
// Writes (cards, transactions, rules, recon, shared options): when offline they are queued
// in an outbox, shown immediately in the app, and replayed automatically when back online.
/* Session-expiry shim. supabase-js tries to refresh an expired token on every call and, with no internet,
   keeps retrying for ~30s each time (the app then hangs on "Loading your data..."). While offline we push the
   stored expiry forward so it never tries; the real expiry is kept and restored as soon as we are online. */
function ddFixSessionExpiry() {
    try {
        const RK = 'dd-real-exp', now = Math.floor(Date.now() / 1000);
        const saved = JSON.parse(localStorage.getItem(RK) || 'null');
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!/^sb-.*-auth-token$/.test(k)) continue;
            const s = JSON.parse(localStorage.getItem(k));
            if (!s || !s.expires_at) continue;
            if (navigator.onLine) {
                if (saved && saved.k === k) { s.expires_at = saved.exp; localStorage.setItem(k, JSON.stringify(s)); }
                localStorage.removeItem(RK);
            } else if (s.expires_at < now + 90) {
                if (!(saved && saved.k === k)) localStorage.setItem(RK, JSON.stringify({ k, exp: s.expires_at }));
                s.expires_at = now + 86400; localStorage.setItem(k, JSON.stringify(s));
            }
        }
    } catch (e) { /* ignore */ }
}
ddFixSessionExpiry();
window.addEventListener('offline', ddFixSessionExpiry);
window.addEventListener('online', ddFixSessionExpiry);   // registered before DDO's own online handler, so it runs first

// Watchdog: never sit on the loading screen forever.
setTimeout(() => {
    const ov = document.getElementById('app-loading-overlay');
    if (ov && !ov.classList.contains('hidden')) { ov.classList.add('hidden'); ov.style.display = 'none'; console.warn('Loading took too long - showing the app with whatever data is available.'); }
}, 15000);

const DDO = (() => {
    const QUEUE_RE = /\/rest\/v1\/(cards|transactions|card_rules|cashback_recon|shared_options)(\?|$)/;
    const MERGE_TABLES = ['cards', 'transactions'];
    const RESERVED = ['select', 'on_conflict', 'columns', 'order', 'limit', 'offset'];
    let dbp = null, flushing = false;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
        const r = indexedDB.open('dd-offline', 1);
        r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('cache'); d.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true }); };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    }));
    const run = async (store, mode, fn) => {
        const db = await open();
        return new Promise((res, rej) => {
            const t = db.transaction(store, mode);
            const r = fn(t.objectStore(store));
            t.oncomplete = () => res(r && r.result);
            t.onerror = () => rej(t.error);
            t.onabort = () => rej(t.error);
        });
    };
    const keyOf = req => req.url + '|' + (req.headers.get('accept') || '');
    const tableOf = url => (url.match(/\/rest\/v1\/([a-z_]+)/) || [])[1];

    function matches(row, params) {
        for (const [k, v] of params) {
            if (RESERVED.includes(k)) continue;
            const m = /^(eq|neq|in)\.(.*)$/.exec(v);
            if (!m) return false;
            const cell = String(row[k]);
            if (m[1] === 'eq' && cell !== m[2]) return false;
            if (m[1] === 'neq' && cell === m[2]) return false;
            if (m[1] === 'in') {
                const list = m[2].replace(/^\(|\)$/g, '').split(',').map(s => s.trim().replace(/^"|"$/g, ''));
                if (!list.includes(cell)) return false;
            }
        }
        return true;
    }
    function applyOutbox(rows, table, items) {
        for (const it of items) {
            if (tableOf(it.url) !== table) continue;
            const params = [...new URL(it.url).searchParams];
            let body = null; try { body = it.body ? JSON.parse(it.body) : null; } catch (e) { /* ignore */ }
            if (it.method === 'POST' || it.method === 'PUT') {
                for (const row of (Array.isArray(body) ? body : [body])) {
                    if (!row) continue;
                    const i = rows.findIndex(r => String(r.id) === String(row.id));
                    if (i >= 0) rows[i] = { ...rows[i], ...row }; else rows.push(row);
                }
            } else if (it.method === 'PATCH' && body) {
                rows = rows.map(r => matches(r, params) ? { ...r, ...body } : r);
            } else if (it.method === 'DELETE') {
                rows = rows.filter(r => !matches(r, params));
            }
        }
        return rows;
    }
    async function queue(req) {
        const body = await req.clone().text();
        const headers = {}; req.headers.forEach((v, k) => { headers[k] = v; });
        await run('outbox', 'readwrite', s => s.add({ url: req.url, method: req.method.toUpperCase(), headers, body, t: Date.now() }));
        updateBanner();
        return new Response(null, { status: 204 });
    }
    const outboxAll = () => run('outbox', 'readonly', s => s.getAll()).then(r => r || []);

    async function ddFetch(input, init) {
        const req = new Request(input, init);
        const method = req.method.toUpperCase();
        if (!req.url.includes('/rest/v1/')) return fetch(req);
        if (method === 'GET') {
            try {
                const res = await fetch(req.clone());
                if (res.ok) {
                    const body = await res.clone().text();
                    run('cache', 'readwrite', s => s.put({ status: res.status, ct: res.headers.get('content-type') || 'application/json', body }, keyOf(req))).catch(() => {});
                }
                return res;
            } catch (err) {
                const hit = await run('cache', 'readonly', s => s.get(keyOf(req))).catch(() => null);
                if (!hit) throw err;
                let body = hit.body;
                const table = tableOf(req.url);
                if (MERGE_TABLES.includes(table)) {
                    try { body = JSON.stringify(applyOutbox(JSON.parse(body), table, await outboxAll())); } catch (e) { /* serve raw cache */ }
                }
                return new Response(body, { status: hit.status, headers: { 'Content-Type': hit.ct } });
            }
        }
        if (QUEUE_RE.test(req.url) && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
            if (!navigator.onLine) return queue(req);
            try { return await fetch(req.clone()); } catch (err) { return queue(req); }
        }
        return fetch(req);
    }

    async function flush() {
        if (flushing || !navigator.onLine) return 0;
        flushing = true; let n = 0;
        try {
            const items = await outboxAll();
            if (!items.length) return 0;
            let token = null;
            try { const { data: { session } } = await _supabase.auth.getSession(); token = session && session.access_token; } catch (e) { /* offline */ }
            if (!token) return 0;
            for (const it of items) {
                const h = new Headers(it.headers); h.set('Authorization', 'Bearer ' + token);
                let res;
                try { res = await fetch(it.url, { method: it.method, headers: h, body: it.body || undefined }); } catch (e) { break; }
                if (res.status >= 500 || res.status === 401) break;
                if (!res.ok) console.warn('Offline change rejected by server and dropped:', res.status, it.method, it.url);
                await run('outbox', 'readwrite', s => s.delete(it.seq));
                n++;
            }
        } finally { flushing = false; updateBanner(); }
        return n;
    }

    // ---- tiny status pill ----
    let pill = null;
    async function updateBanner(msg) {
        if (!pill) {
            pill = document.createElement('div');
            pill.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99999;padding:6px 12px;border-radius:999px;font:600 12px/1.2 system-ui,sans-serif;background:#f59e0b;color:#111;box-shadow:0 2px 10px rgba(0,0,0,.35);display:none;pointer-events:none';
            (document.body || document.documentElement).appendChild(pill);
        }
        const pending = (await outboxAll().catch(() => [])).length;
        const text = msg || (!navigator.onLine ? 'Offline' + (pending ? ' · ' + pending + ' change(s) waiting to sync' : ' · changes will sync later') : (pending ? pending + ' change(s) waiting to sync' : ''));
        pill.textContent = text; pill.style.display = text ? 'block' : 'none';
    }
    window.addEventListener('offline', () => updateBanner());
    window.addEventListener('online', async () => {
        const n = await flush();
        if (n > 0) { try { await initData(); } catch (e) { console.warn(e); } updateBanner('Synced ' + n + ' change(s)'); setTimeout(() => updateBanner(), 2500); }
        else updateBanner();
    });
    window.addEventListener('DOMContentLoaded', () => updateBanner());

    // Session fallback: supabase-js can't refresh an expired token without internet,
    // so reuse the last stored session just to open the app on this device.
    function cachedSession() {
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (/^sb-.*-auth-token$/.test(k)) { const s = JSON.parse(localStorage.getItem(k)); if (s && s.user) return s; }
            }
        } catch (e) { /* ignore */ }
        return null;
    }
    const clearCache = () => run('cache', 'readwrite', s => s.clear()).catch(() => {});
    return { ddFetch, flush, cachedSession, clearCache };
})();

