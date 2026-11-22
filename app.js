        // Set up Supabase Connection
        // Keep chart text and grid colors in step with the selected theme.
        {
            const darkTheme = document.documentElement.classList.contains('dark');
            Chart.defaults.color = darkTheme ? '#94a3b8' : '#64748b';
            Chart.defaults.borderColor = darkTheme ? '#1e2333' : '#e2e8f0';
            Chart.defaults.font.family = "'Inter', ui-sans-serif, system-ui, sans-serif";
        }

        const SUPABASE_URL = 'https://ngkmqtqzmvkfzvwegflf.supabase.co';
        const SUPABASE_ANON_KEY = 'sb_publishable_RXdmwR8oCdgfOak4SbPqPA_ASVAH4hx';
        // Password-reset links land back on this page with the result in the URL hash.
        // Read it NOW, before supabase-js processes it, so boot() knows we arrived from a reset email.
        let recoveryPending = /type=recovery/.test(window.location.hash);
        const authLinkError = (() => {
            const h = window.location.hash;
            if (!/error(_code|_description)?=/.test(h)) return '';
            return /otp_expired|expired|invalid/i.test(h)
                ? 'That reset link is invalid or has expired. Please request a new one.'
                : 'Could not use that link. Please request a new password reset.';
        })();
        const _supabase = (SUPABASE_URL !== 'YOUR_SUPABASE_URL') ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { fetch: DDO.ddFetch } }) : null;
        // Subscribe immediately (before any await): supabase-js emits PASSWORD_RECOVERY while it starts up,
        // which is before boot() subscribes. Without this, the reset link silently signs the user in.
        if (_supabase) {
            _supabase.auth.onAuthStateChange((event) => {
                if (event === 'PASSWORD_RECOVERY') recoveryPending = true;
            });
        }

        let cards = [];
        let showSavedCards = (() => { try { return localStorage.getItem('cb_show_saved_cards') !== '0'; } catch (e) { return true; } })();

        // ---- DISABLED CARDS ----
        // A disabled card is hidden from the saved-cards list, the card filters, the recommender and the
        // "new transaction" dropdown, but NOTHING is deleted: every transaction stays in the history,
        // charts and totals. Enable it again at any time.
        let showDisabledCards = (() => { try { return localStorage.getItem('cb_show_disabled') === '1'; } catch (e) { return false; } })();
        const activeCards = () => cards.filter(c => !c.disabled);
        const disabledCardNames = () => new Set(cards.filter(c => c.disabled).map(c => (c.name || '').trim()));
        // Backup for databases that don't have the is_disabled column yet (this device only).
        function readLocalDisabledIds() {
            try { return new Set(JSON.parse(localStorage.getItem('cb_disabled_cards') || '[]').map(String)); } catch (e) { return new Set(); }
        }
        function writeLocalDisabledIds() {
            try { localStorage.setItem('cb_disabled_cards', JSON.stringify(cards.filter(c => c.disabled).map(c => String(c.id)))); } catch (e) { /* private mode */ }
        }
        // ---- DEBIT CARDS ----
        // A card is 'credit' (default) or 'debit'. For a debit card, availableLimit holds the OPENING BALANCE
        // and balance = opening balance - purchases - withdrawals - fees + deposits ('Repaid' rows) + cashback credited.
        const isDebit = c => !!c && c.cardType === 'debit'; // same field the withdrawal planner / forecast already check
        function readLocalDebitIds() {
            try { return new Set(JSON.parse(localStorage.getItem('cb_debit_cards') || '[]').map(String)); } catch (e) { return new Set(); }
        }
        function writeLocalDebitIds() { // backup for databases that don't have the card_type column yet (this device only)
            try { localStorage.setItem('cb_debit_cards', JSON.stringify(cards.filter(isDebit).map(c => String(c.id)))); } catch (e) { /* private mode */ }
        }
        function debitBalance(c, asOf, ignoreTxId) {
            const ignoredIds = new Set((Array.isArray(ignoreTxId) ? ignoreTxId : [ignoreTxId])
                .filter(id => id !== undefined && id !== null && id !== '')
                .map(String));
            const list = cardTxList(c).filter(t => !ignoredIds.has(String(t.id)));
            return (Number(c.availableLimit) || 0) - calculateOutstanding(list, asOf || localDateKey(), c).outstanding;
        }
        // Card names that should appear in the card filters (chips + history dropdown).
        function filterableCardNames() {
            const off = disabledCardNames();
            let names = Array.from(new Set(transactions.map(t => (t.cardName || '').trim()))).filter(Boolean);
            if (!showDisabledCards) names = names.filter(n => !off.has(n) || n === activeCardFilter);
            return names;
        }
        function setShowDisabledCards(value) {
            showDisabledCards = !!value;
            try { localStorage.setItem('cb_show_disabled', showDisabledCards ? '1' : '0'); } catch (e) { /* private mode */ }
            render();
        }
        function toggleSavedCardsVisibility() {
            showSavedCards = !showSavedCards;
            try { localStorage.setItem('cb_show_saved_cards', showSavedCards ? '1' : '0'); } catch (e) { console.warn('Could not save saved-card visibility preference:', e); }
            renderCardsList();
        }
        async function toggleCardDisabled(id) {
            const card = cards.find(c => c.id === String(id));
            if (!card) return;
            const disabling = !card.disabled;
            if (disabling) {
                const ok = await showConfirm(
                    'Disable this card?',
                    `"${card.name}" will be hidden from the card list, filters and recommender, and can't be picked for new transactions. All of its transactions are kept. You can enable it again any time.`,
                    { confirmLabel: 'Disable' }
                );
                if (!ok) return;
            }
            card.disabled = disabling;
            writeLocalDisabledIds();
            const saved = await saveCardToDB(card);
            if (saved === false) { card.disabled = !disabling; writeLocalDisabledIds(); render(); return; }
            showToast(disabling
                ? `${card.name} disabled. Its transactions are kept.`
                : `${card.name} enabled.`, { tone: 'success', duration: 3000 });
            render();
        }
        let transactions = [];
        let categoryDonutInstance = null;
        let cardDonutInstance = null;
        let monthlyChartInstance = null;
        let activeCardFilter = 'ALL';
        let selectedCategories = []; // empty array = "All Categories"; otherwise one or more category names
        let selectedMonths = []; // empty array = "All Months"; otherwise one or more 'YYYY-MM' keys, e.g. last 2 months
        let searchQuery = '';
        const TRANSFER_OUT_TYPE = 'Transfer Out';
        const TRANSFER_IN_TYPE = 'Transfer In';
        const TRANSFER_NOTE_PREFIX = 'Transfer group: ';
        const TYPE_FILTER_OPTIONS = ['Purchase', 'Cash Withdrawal', 'Repaid', 'Cashback', TRANSFER_OUT_TYPE, TRANSFER_IN_TYPE];
        let activeTypeFilter = 'ALL'; // 'ALL' or one of TYPE_FILTER_OPTIONS
        let transactionEntryKind = '';
        let financialPeriod = 'month';
        let currentReportTransactions = [];
        const customTransactionTypes = [];
        // "Feels like": every transaction type behaves like one of four built-in kinds. Custom types
        // (e.g. 'Annual Fee' -> Purchase, 'Deposit' -> Repaid) are mapped here; 'None' = record only.
        const TX_KINDS = ['Purchase', 'Cash Withdrawal', 'Repaid', 'Cashback'];
        const customTypeBehavior = {};
        function txKind(type) {
            if (TX_KINDS.includes(type)) return type;
            const k = customTypeBehavior[type];
            return TX_KINDS.includes(k) ? k : null;
        }
        const isSpendKind = type => { const k = txKind(type); return k === 'Purchase' || k === 'Cash Withdrawal'; };
        const transferGroupId = transaction => {
            const match = String(transaction && transaction.notes || '').match(/(?:^|\n)Transfer group: ([^\r\n]+)/);
            return match ? match[1] : '';
        };
        const isTransferType = type => type === TRANSFER_OUT_TYPE || type === TRANSFER_IN_TYPE;
        function persistTypeBehaviors() {
            try { localStorage.setItem('cb_custom_type_behaviors', JSON.stringify(customTypeBehavior)); } catch (e) { /* private mode */ }
        }

        // ---- HISTORY TABLE: sort, pagination, bulk-select ----
        let txSortColumn = 'date';
        let txSortDir = 'desc'; // 'asc' | 'desc'
        const TX_PAGE_SIZE = 25;
        let txCurrentPage = 1;
        const TX_SORT_COLUMNS = { date: 'date', card: 'cardName', amount: 'amount', cashback: 'cashback', net: '__net' };

        function toggleTxSort(column) {
            if (txSortColumn === column) {
                txSortDir = txSortDir === 'asc' ? 'desc' : 'asc';
            } else {
                txSortColumn = column;
                txSortDir = 'asc';
            }
            txCurrentPage = 1;
            renderTransactionsAndMetrics();
        }

        function sortArrow(column) {
            if (txSortColumn !== column) return '<span class="text-slate-300 dark:text-slate-600">↕</span>';
            return txSortDir === 'asc' ? '<span class="text-indigo-600">↑</span>' : '<span class="text-indigo-600">↓</span>';
        }

        function goToTxPage(page) {
            txCurrentPage = page;
            renderTransactionsAndMetrics();
        }

        function txCardIsDisabled(t) {
            const card = cards.find(c => t.cardId && String(c.id) === String(t.cardId))
                || cards.find(c => normCardName(c.name) === normCardName(t.cardName));
            return !!(card && card.disabled);
        }

        function transactionMatchesFilters(t) {
            const matchesCard = (activeCardFilter === 'ALL' || t.cardName.trim() === activeCardFilter);
            const matchesCategory = (selectedCategories.length === 0 || (t.category && selectedCategories.includes(t.category.trim())));
            const matchesMonth = (selectedMonths.length === 0 || (t.date && selectedMonths.includes(t.date.substring(0, 7))));
            const matchesSearch = (!searchQuery || (t.desc && t.desc.toLowerCase().includes(searchQuery.toLowerCase())));
            const matchesType = (activeTypeFilter === 'ALL' || t.type === activeTypeFilter);
            return matchesCard && matchesCategory && matchesMonth && matchesSearch && matchesType;
        }

        // ---- Custom dropdowns for the history filter bar (replaces the browser's native <select> popup) ----
        const thDd = {};          // key -> { options: [{value,label}], selected, onSelect }
        let thDdOpenKey = null;

        function thTrigger(key, iconHtml, label) {
            return `<button type="button" class="th-trigger" data-dd="${key}" aria-haspopup="listbox" aria-expanded="false" onclick="openThDropdown(event, '${key}')">
                ${iconHtml}<span class="th-trigger-label">${escapeHtml(label)}</span>
                <svg class="th-tchev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
            </button>`;
        }

        function closeThDropdown() {
            const pop = document.getElementById('th-dd');
            if (pop) pop.classList.add('hidden');
            document.querySelectorAll('.th-trigger[aria-expanded="true"]').forEach(b => { b.setAttribute('aria-expanded', 'false'); b.parentElement.classList.remove('open'); });
            thDdOpenKey = null;
        }

        function openThDropdown(event, key) {
            event.stopPropagation();
            const wasOpen = thDdOpenKey === key;
            closeTxMenu();
            closeThDropdown();
            if (wasOpen) return;
            const data = thDd[key];
            if (!data) return;
            const trigger = event.currentTarget;
            let pop = document.getElementById('th-dd');
            if (!pop) {
                pop = document.createElement('div');
                pop.id = 'th-dd';
                pop.setAttribute('role', 'listbox');
                pop.className = 'th-dd hidden';
                document.body.appendChild(pop);
            }
            const check = '<svg class="th-opt-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
            pop.innerHTML = data.options.map((o, i) => {
                const sel = String(o.value) === String(data.selected);
                return `<button type="button" role="option" aria-selected="${sel}" class="th-opt ${sel ? 'selected' : ''}" onclick="pickThOption('${key}', ${i})"><span class="th-opt-label">${escapeHtml(o.label)}</span>${sel ? check : ''}</button>`;
            }).join('');
            thDdOpenKey = key;
            trigger.setAttribute('aria-expanded', 'true');
            trigger.parentElement.classList.add('open');

            const rect = trigger.parentElement.getBoundingClientRect();
            pop.style.width = `${Math.max(rect.width, 200)}px`;
            pop.classList.remove('hidden');
            const h = pop.offsetHeight;
            let top = rect.bottom + 6;
            if (top + h > window.innerHeight - 8 && rect.top - h - 6 > 8) top = rect.top - h - 6; // flip up if there's room
            pop.style.top = `${top}px`;
            pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - pop.offsetWidth - 8))}px`;
            const sel = pop.querySelector('.th-opt.selected');
            if (sel) sel.scrollIntoView({ block: 'nearest' });
        }

        function pickThOption(key, index) {
            const data = thDd[key];
            closeThDropdown();
            if (!data || !data.options[index]) return;
            data.onSelect(data.options[index].value);
        }

        document.addEventListener('click', e => { if (!e.target.closest('#th-dd')) closeThDropdown(); });
        document.addEventListener('keydown', e => {
            if (!thDdOpenKey) return;
            if (e.key === 'Escape') { const k = thDdOpenKey; closeThDropdown(); const t = document.querySelector(`.th-trigger[data-dd="${k}"]`); if (t) t.focus(); return; }
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            e.preventDefault();
            const items = [...document.querySelectorAll('#th-dd .th-opt')];
            if (!items.length) return;
            const i = items.indexOf(document.activeElement);
            const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
            items[next].focus();
        });
        window.addEventListener('resize', closeThDropdown);
        window.addEventListener('scroll', e => {
            const t = e.target;
            if (t && t.nodeType === 1 && t.closest('#th-dd')) return; // scrolling the list itself keeps it open
            closeThDropdown();
        }, true);

        const TH_ICON_FILTER = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a5b4fc" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M7 12h10M10 17h4"/></svg>';
        const TH_ICON_SHAPES = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 4 7H8l4-7Z"/><rect x="3.5" y="14" width="7" height="7" rx="1.2"/><circle cx="17.5" cy="17.5" r="3.5"/></svg>';
        const TH_CHEVRON = '<svg class="th-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

        const TH_ICON_CARD = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7dd3fc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3 10h18M7 15h3"/></svg>';

        // Card dropdown for the history toolbar. Same state (activeCardFilter) as the card chips
        // in the Filters section, so both stay in sync.
        function renderHistoryCardFilter() {
            const el = document.getElementById('history-card-container');
            if (!el) return;
            const names = filterableCardNames().sort((a, b) => a.localeCompare(b));
            if (activeCardFilter !== 'ALL' && !names.includes(activeCardFilter)) names.push(activeCardFilter);
            const offNames = disabledCardNames();
            thDd.card = {
                options: [{ value: 'ALL', label: 'Filter: All Cards' }, ...names.map(n => ({ value: n, label: offNames.has(n) ? `${n} (disabled)` : n }))],
                selected: activeCardFilter,
                onSelect: v => setCardFilter(v)
            };
            el.innerHTML = thTrigger('card', TH_ICON_CARD, activeCardFilter === 'ALL' ? 'Filter: All Cards' : activeCardFilter);
        }

        function renderTypeFilter() {
            const el = document.getElementById('type-filter-container');
            if (!el) return;
            thDd.type = {
                options: [{ value: 'ALL', label: 'All Types' }, ...TYPE_FILTER_OPTIONS.map(t => ({ value: t, label: t }))],
                selected: activeTypeFilter,
                onSelect: v => setTypeFilter(v)
            };
            el.innerHTML = thTrigger('type', TH_ICON_FILTER, activeTypeFilter === 'ALL' ? 'All Types' : activeTypeFilter);
        }

        // Category dropdown for the history toolbar. Uses the same selectedCategories state as the
        // category chips in the Filters section, so both stay in sync.
        function renderHistoryCategoryFilter() {
            const el = document.getElementById('history-category-container');
            if (!el) return;
            const names = Array.from(new Set(
                transactions
                    .filter(t => t.category && (activeCardFilter === 'ALL' || (t.cardName || '').trim() === activeCardFilter))
                    .map(t => t.category.trim())
            )).sort((a, b) => a.localeCompare(b));
            selectedCategories.forEach(c => { if (!names.includes(c)) names.push(c); });
            const multi = selectedCategories.length > 1;
            const current = multi ? '__multi' : (selectedCategories[0] || '');
            const options = [{ value: '', label: 'All Categories' }]
                .concat(multi ? [{ value: '__multi', label: `${selectedCategories.length} categories` }] : [])
                .concat(names.map(n => ({ value: n, label: n })));
            thDd.category = { options, selected: current, onSelect: v => setHistoryCategory(v) };
            const cur = options.find(o => o.value === current);
            el.innerHTML = thTrigger('category', TH_ICON_SHAPES, cur ? cur.label : 'All Categories');
        }

        function setHistoryCategory(value) {
            if (value === '__multi') return;
            selectedCategories = value ? [value] : [];
            renderCardFilters();
            renderTransactionsAndMetrics();
        }

        function setTypeFilter(type) {
            activeTypeFilter = type;
            renderTypeFilter();
            renderCardFilters(); // refreshes the "Filter: ..." label
            renderTransactionsAndMetrics();
        }

        function setSearchQuery(value) {
            searchQuery = value.trim();
            renderTransactionsAndMetrics();
        }
        let currentUserId = null;
        let currentUsername = '';

        // ---- SINGLE SOURCE OF TRUTH FOR CATEGORIES ----
        // Add/remove/rename a category here ONLY. Every dropdown and the
        // card rate-input grid are generated from these two lists, so
        // nothing can drift out of sync again.
        const RATE_CATEGORIES = ['Dining', 'Grocery', 'Travel', 'Gas/Fuel', 'Online Shopping', 'Govt', 'All Other Spend'];
        const TX_ONLY_CATEGORIES = ['Cashback', 'Monthly Payment', 'Annual Fee']; // bookkeeping labels, not spend rates
        const customCategories = [];
        const WITHDRAWAL_CHARGE_PERCENTAGES = {
            Dining: 3,
            Grocery: 2.25,
            Travel: 3,
            'Gas/Fuel': 3,
            'Online Shopping': 3,
            Govt: 3,
            'All Other Spend': 3,
            Education: 3,
            Others: 3,
            'Service Fee': 3,
            Pharmacy: 3,
            'Wala Points': 3,
            'Share Points': 3,
            Entertainment: 3
        };
        let withdrawalChargePercentagesLoaded = false;

        function loadWithdrawalChargePercentages() {
            if (withdrawalChargePercentagesLoaded) return;
            withdrawalChargePercentagesLoaded = true;
            try {
                const saved = JSON.parse(localStorage.getItem('dd-withdrawal-charge-percentages') || '{}');
                Object.entries(saved).forEach(([category, percentage]) => {
                    const value = Number(percentage);
                    if (Number.isFinite(value) && value >= 0 && value < 100) {
                        WITHDRAWAL_CHARGE_PERCENTAGES[category] = value;
                    }
                });
            } catch (error) {
                console.warn('Could not load saved withdrawal charge percentages:', error);
            }
        }

        function ensureWithdrawalChargePercentages(categories) {
            categories.forEach(category => {
                if (!Object.prototype.hasOwnProperty.call(WITHDRAWAL_CHARGE_PERCENTAGES, category)) {
                    WITHDRAWAL_CHARGE_PERCENTAGES[category] = 3;
                }
            });
        }

        // ---- CARD COLOR PALETTE ----
        // Card-like colourways (metals, jewel tones, dark finishes). Old keys (none, carbon, ocean, sunrise,
        // mint, lavender, peach, sky, rose) are kept so cards that already saved a colour still work.
        // A colour is stored as a preset key, or as "custom:#rrggbb" when picked with the colour wheel.
        const CARD_COLOR_PRESETS = [
            { key: 'none',     label: 'Titanium',        h: 215, s: 10, l: 26, neutral: true },
            { key: 'carbon',   label: 'Midnight Black',  h: 220, s: 8,  l: 13, neutral: true },
            { key: 'silver',   label: 'Platinum Silver', h: 214, s: 14, l: 38, neutral: true },
            { key: 'sunrise',  label: 'Royal Gold',      h: 41,  s: 78, l: 27 },
            { key: 'rosegold', label: 'Rose Gold',       h: 14,  s: 46, l: 33 },
            { key: 'peach',    label: 'Copper',          h: 24,  s: 72, l: 27 },
            { key: 'ocean',    label: 'Sapphire Blue',   h: 222, s: 74, l: 31 },
            { key: 'navy',     label: 'Navy',            h: 226, s: 66, l: 21 },
            { key: 'sky',      label: 'Sky Cyan',        h: 196, s: 80, l: 26 },
            { key: 'teal',     label: 'Teal',            h: 174, s: 68, l: 23 },
            { key: 'mint',     label: 'Emerald',         h: 152, s: 70, l: 22 },
            { key: 'forest',   label: 'Forest Green',    h: 142, s: 42, l: 20 },
            { key: 'ruby',     label: 'Ruby Red',        h: 352, s: 72, l: 30 },
            { key: 'rose',     label: 'Berry',           h: 330, s: 62, l: 28 },
            { key: 'lavender', label: 'Amethyst',        h: 265, s: 62, l: 30 },
            { key: 'orchid',   label: 'Orchid',          h: 292, s: 56, l: 28 }
        ];

        function hexToHsl(hex) {
            const m = /^#([0-9a-f]{6})$/i.exec(String(hex || '').trim());
            if (!m) return null;
            const n = parseInt(m[1], 16);
            const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
            const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
            let h = 0;
            if (d) {
                if (max === r) h = ((g - b) / d) % 6;
                else if (max === g) h = (b - r) / d + 2;
                else h = (r - g) / d + 4;
                h = Math.round(h * 60); if (h < 0) h += 360;
            }
            const l = (max + min) / 2;
            const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
            return { h, s: s * 100, l: l * 100 };
        }

        // Saved value -> palette entry. Custom colours derive a dark card tone from the chosen hue.
        function resolveCardColor(value) {
            const v = String(value || '');
            if (v.startsWith('custom:')) {
                const hsl = hexToHsl(v.slice(7));
                if (hsl) {
                    return { key: 'custom', label: 'Custom', hex: v.slice(7), h: hsl.h,
                             s: Math.min(85, Math.max(18, hsl.s)), l: Math.min(34, Math.max(15, hsl.l * 0.55)), neutral: hsl.s < 12 };
                }
            }
            return CARD_COLOR_PRESETS.find(p => p.key === (v || 'none')) || CARD_COLOR_PRESETS[0];
        }

        // CSS variables that theme a .cc tile (or the small recommender thumbnail) from a palette entry.
        function cardThemeVars(theme) {
            const { h, s, l, neutral } = theme;
            const hsl = (hh, ss, ll, a = 1) => `hsla(${Math.round(((hh % 360) + 360) % 360)},${Math.round(ss)}%,${Math.round(ll)}%,${a})`;
            const bg = `linear-gradient(145deg, ${hsl(h, s, l, .9)}, ${hsl(h, s, Math.max(8, l * .52), .94)} 58%, ${hsl(h, s * .9, Math.max(6, l * .32), .96)})`;
            const v = {
                '--cc-bg': bg,
                '--cc-bd': neutral ? 'rgba(255,255,255,.15)' : hsl(h, s, 64, .4),
                '--cc-glow': neutral ? 'rgba(148,163,184,.10)' : hsl(h, s, 52, .2),
                '--cc-bar': neutral ? 'linear-gradient(90deg,#94a3b8,#e2e8f0)' : `linear-gradient(90deg, ${hsl(h, s, 52)}, ${hsl(h + 24, Math.min(90, s + 6), 70)})`,
                '--cc-lim': neutral ? '#cbd5e1' : hsl(h, 78, 86),
                '--cc-lbl': neutral ? '#8b93a7' : hsl(h, 26, 66),
                '--cc-pill-bg': neutral ? 'rgba(255,255,255,.07)' : hsl(h, s, 55, .16),
                '--cc-pill-bd': neutral ? 'rgba(255,255,255,.22)' : hsl(h, s, 68, .5),
                '--cc-pill-c': neutral ? '#cbd5e1' : hsl(h, 84, 78)
            };
            return Object.entries(v).map(([k, val]) => `${k}:${val}`).join(';');
        }
        // Every colour gets its own chip: a metal finish AND a contact-pad pattern, so no two colours share the same chip.
        const CARD_CHIP_BY_PRESET = {
            none:     { f: 'silver',    p: 'dots'  },
            carbon:   { f: 'gold',      p: 'grid'  },
            silver:   { f: 'graphite',  p: 'lines' },
            sunrise:  { f: 'silver',    p: 'lines' },
            rosegold: { f: 'platinum',  p: 'grid'  },
            peach:    { f: 'champagne', p: 'lines' },
            ocean:    { f: 'gold',      p: 'lines' },
            navy:     { f: 'ice',       p: 'grid'  },
            sky:      { f: 'rosegold',  p: 'lines' },
            teal:     { f: 'amber',     p: 'cross' },
            mint:     { f: 'gold',      p: 'cross' },
            forest:   { f: 'bronze',    p: 'grid'  },
            ruby:     { f: 'champagne', p: 'dots'  },
            rose:     { f: 'rosegold',  p: 'grid'  },
            lavender: { f: 'lilac',     p: 'lines' },
            orchid:   { f: 'platinum',  p: 'cross' }
        };
        function cardChipSpec(theme) {
            if (CARD_CHIP_BY_PRESET[theme.key]) return CARD_CHIP_BY_PRESET[theme.key];
            // custom colours: finish from the hue, pattern from the hue band
            const h = theme.h;
            const p = ['lines', 'grid', 'cross', 'dots'][Math.floor(h / 45) % 4];
            if (theme.neutral) return { f: 'silver', p };
            if (h >= 10 && h < 70) return { f: 'silver', p };
            if (h >= 70 && h < 200) return { f: 'champagne', p };
            if (h >= 200 && h < 260) return { f: 'gold', p };
            if (h >= 260 && h < 345) return { f: 'rosegold', p };
            return { f: 'platinum', p };
        }
        function cardChipClass(theme) {
            const c = cardChipSpec(theme);
            return `chip-f-${c.f} chip-p-${c.p}`;
        }
        // ---- Card background icons: every colour has its own watermark (Royal Gold = shield, Midnight Black = moon, ...) ----
        const CARD_WM_ICONS = {
            shield: '<path d="M50 8 L87 22 V50 C87 74 69 90 50 96 C31 90 13 74 13 50 V22 Z"/>',
            moon: '<path d="M62 10 C40 14 24 33 24 56 C24 79 42 94 64 94 C75 94 85 90 91 82 C69 82 54 66 54 45 C54 31 57 19 62 10 Z"/><path d="M80 20 l3.2 8.4 8.4 3.2 -8.4 3.2 -3.2 8.4 -3.2 -8.4 -8.4 -3.2 8.4 -3.2 z"/>',
            star: '<path d="M50 8 L61.5 36.5 L92 39 L68.8 58.9 L76 88.5 L50 72.5 L24 88.5 L31.2 58.9 L8 39 L38.5 36.5 Z"/>',
            hexagon: '<path d="M50 8 L86 29 V71 L50 92 L14 71 V29 Z"/><path d="M50 30 L68 40 V60 L50 70 L32 60 V40 Z" opacity=".6"/>',
            flower: '<circle cx="50" cy="50" r="9"/><circle cx="50" cy="25" r="15"/><circle cx="73.8" cy="42.3" r="15"/><circle cx="64.7" cy="70.2" r="15"/><circle cx="35.3" cy="70.2" r="15"/><circle cx="26.2" cy="42.3" r="15"/>',
            flame: '<path d="M50 6 C52 24 72 34 72 58 C72 76 62 92 50 92 C38 92 28 78 28 62 C28 50 34 44 40 38 C40 48 44 52 48 52 C46 38 44 22 50 6 Z"/><path d="M50 92 C43 92 40 84 40 78 C40 70 46 66 50 60 C54 66 60 70 60 78 C60 84 57 92 50 92 Z" opacity=".6"/>',
            gem: '<path d="M26 14 H74 L94 38 L50 92 L6 38 Z"/><path d="M6 38 H94 M36 38 L50 92 L64 38 M36 38 L26 14 M64 38 L74 14 M36 38 L50 14 L64 38" />',
            anchor: '<circle cx="50" cy="19" r="8"/><path d="M50 27 V88 M33 40 H67"/><path d="M14 62 C16 82 32 90 50 90 C68 90 84 82 86 62 M14 62 L8 72 M14 62 L24 70 M86 62 L92 72 M86 62 L76 70"/>',
            cloud: '<path d="M28 78 C14 78 8 68 10 58 C12 49 20 44 28 45 C30 32 40 24 52 24 C65 24 74 33 75 46 C86 46 92 55 91 64 C90 73 83 78 74 78 Z"/><path d="M34 90 H66" opacity=".55"/>',
            drop: '<path d="M50 8 C50 8 20 40 20 62 C20 80 33 92 50 92 C67 92 80 80 80 62 C80 40 50 8 50 8 Z"/><path d="M36 64 C36 74 42 80 50 80" opacity=".6"/>',
            emeraldcut: '<path d="M30 10 H70 L92 30 V70 L70 90 H30 L8 70 V30 Z"/><path d="M34 26 H66 L78 38 V62 L66 74 H34 L22 62 V38 Z" opacity=".7"/><path d="M30 10 L34 26 M70 10 L66 26 M92 30 L78 38 M92 70 L78 62 M70 90 L66 74 M30 90 L34 74 M8 70 L22 62 M8 30 L22 38" opacity=".55"/>',
            tree: '<path d="M50 6 L72 36 H60 L80 62 H64 L88 88 H12 L36 62 H20 L40 36 H28 Z"/><path d="M50 88 V96" />',
            heart: '<path d="M50 90 C22 70 8 52 8 34 C8 20 19 10 32 10 C40 10 47 14 50 22 C53 14 60 10 68 10 C81 10 92 20 92 34 C92 52 78 70 50 90 Z"/><path d="M26 30 C26 24 30 21 35 21" opacity=".6"/>',
            berries: '<circle cx="34" cy="62" r="17"/><circle cx="66" cy="62" r="17"/><circle cx="50" cy="36" r="17"/><path d="M50 19 C50 10 56 6 62 6 C62 14 58 18 50 19 Z"/>',
            sparkle: '<path d="M44 8 C46 32 56 42 80 44 C56 46 46 56 44 80 C42 56 32 46 8 44 C32 42 42 32 44 8 Z"/><path d="M78 62 C79 74 84 79 94 80 C84 81 79 86 78 96 C77 86 72 81 62 80 C72 79 77 74 78 62 Z"/>',
            butterfly: '<path d="M50 30 C40 10 14 12 12 34 C10 50 26 56 44 52 C28 58 22 80 36 88 C46 94 50 80 50 62 Z"/><path d="M50 30 C60 10 86 12 88 34 C90 50 74 56 56 52 C72 58 78 80 64 88 C54 94 50 80 50 62 Z"/><path d="M50 30 V62 M46 18 L40 8 M54 18 L60 8"/>'
        };
        const CARD_WM_BY_PRESET = {
            none: 'hexagon', carbon: 'moon', silver: 'star', sunrise: 'shield', rosegold: 'flower', peach: 'flame',
            ocean: 'gem', navy: 'anchor', sky: 'cloud', teal: 'drop', mint: 'emeraldcut', forest: 'tree',
            ruby: 'heart', rose: 'berries', lavender: 'sparkle', orchid: 'butterfly'
        };
        function cardWatermarkName(theme) {
            if (CARD_WM_BY_PRESET[theme.key]) return CARD_WM_BY_PRESET[theme.key];
            const order = Object.keys(CARD_WM_ICONS);                      // custom colours: icon follows the hue
            return order[Math.floor(theme.h / 22.5) % order.length];
        }
        // Set to true to bring the background icons back (the icon set above is kept for that).
        const CARD_WATERMARKS_ENABLED = false;
        function cardWatermarkHtml(theme) {
            if (!CARD_WATERMARKS_ENABLED) return '';
            const name = cardWatermarkName(theme);
            return `<span class="cc-wm" aria-hidden="true" style="color:${cardAccentColor(theme)}"><svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round">${CARD_WM_ICONS[name]}</svg></span>`;
        }

        function cardAccentColor(theme) {
            return theme.neutral ? '#e2e8f0' : `hsl(${Math.round(theme.h)},${Math.round(Math.min(90, theme.s + 12))}%,66%)`;
        }
        function cardSwatchBg(theme) {
            const { h, s, l } = theme;
            return `linear-gradient(135deg, hsl(${Math.round(h)},${Math.round(s)}%,${Math.round(l + 14)}%), hsl(${Math.round(h)},${Math.round(s)}%,${Math.round(Math.max(7, l * .45))}%))`;
        }

        function renderColorPicker(selected = 'none') {
            const container = document.getElementById('card-color-picker');
            if (!container) return;
            const cur = resolveCardColor(selected === 'none' ? '' : selected);
            const isCustom = cur.key === 'custom';
            const swatches = CARD_COLOR_PRESETS.map(p => `
                <button type="button" onclick="setCardColorGradient('${p.key}')" title="${p.label}" aria-label="${p.label}"
                    class="cp-sw ${!isCustom && cur.key === p.key ? 'active' : ''}" style="background:${cardSwatchBg(p)}"></button>`).join('');
            container.innerHTML = swatches + `
                <label class="cp-sw cp-custom ${isCustom ? 'active' : ''}" title="Custom colour" ${isCustom ? `style="background:${cardSwatchBg(cur)}"` : ''}>
                    <input type="color" id="card-custom-color" value="${isCustom ? cur.hex : '#3b82f6'}" oninput="setCustomCardColor(this.value)" aria-label="Pick a custom colour">
                    <span class="cp-custom-plus">${isCustom ? '' : '+'}</span>
                </label>`;
            const preview = document.getElementById('card-color-preview');
            if (preview) {
                preview.innerHTML = `
                    <div class="cp-prev" style="${cardThemeVars(cur)}">
                        ${cardWatermarkHtml(cur)}
                        <span class="cc-chip ${cardChipClass(cur)}" style="transform:scale(.8);transform-origin:left center"></span>
                        <div class="min-w-0 flex-1">
                            <p class="cp-prev-name">${escapeHtml(cur.label)}</p>
                            <div class="cc-track" style="height:5px;margin-top:6px"><div class="cc-fill" style="width:38%"></div></div>
                        </div>
                    </div>
                    <p class="text-[10px] text-slate-400 dark:text-slate-500 mt-1.5">Tip: pick the shade closest to your physical card, or use the round swatch with the + for any custom colour.</p>`;
            }
        }

        function setCardColorGradient(key) {
            document.getElementById('card-color-gradient').value = (key === 'none' || !key) ? '' : key;
            renderColorPicker(key || 'none');
        }
        function setCustomCardColor(hex) {
            // Re-render the previews without rebuilding the <input type="color"> the user is dragging in.
            const value = `custom:${hex}`;
            document.getElementById('card-color-gradient').value = value;
            const cur = resolveCardColor(value);
            const picker = document.getElementById('card-color-picker');
            picker.querySelectorAll('.cp-sw').forEach(el => el.classList.remove('active'));
            const custom = picker.querySelector('.cp-custom');
            if (custom) { custom.classList.add('active'); custom.style.background = cardSwatchBg(cur); const plus = custom.querySelector('.cp-custom-plus'); if (plus) plus.textContent = ''; }
            const prev = document.querySelector('#card-color-preview .cp-prev');
            if (prev) {
                prev.setAttribute('style', cardThemeVars(cur));
                const n = prev.querySelector('.cp-prev-name'); if (n) n.textContent = 'Custom';
                const wm = prev.querySelector('.cc-wm'); if (wm) wm.outerHTML = cardWatermarkHtml(cur);
                const chip = prev.querySelector('.cc-chip'); if (chip) chip.className = `cc-chip ${cardChipClass(cur)}`;
            }
        }

        // ---- OUTSTANDING BALANCE ----
        // Cashback is credited on a configured day in the month after purchase, or the next day.
        // Service fees were never part of your Remaining Pay figure; flip this to true if the
        // fees are also billed to the card and should count towards what you owe.
        const INCLUDE_FEES_IN_OUTSTANDING = false;

        function localMonthKey(d = new Date()) {
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        }
        function localDateKey(d = new Date()) {
            return `${localMonthKey(d)}-${String(d.getDate()).padStart(2, '0')}`;
        }
        function nextMonthKey(monthKey) {
            const [y, m] = monthKey.split('-').map(Number);
            return localMonthKey(new Date(y, m, 1)); // m is 1-based, so this is the following month
        }
        function monthLabel(monthKey) {
            const [y, m] = monthKey.split('-').map(Number);
            return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
        }
        function formatAED(n) {
            return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }

        // A plain Date.now() timestamp is NOT guaranteed unique — two rows created in the same
        // millisecond (e.g. two rows in a fast import loop, or a retried save) collide, and a
        // Supabase upsert can't tell them apart, sometimes even colliding with another user's
        // row and getting blocked by Row Level Security. crypto.randomUUID() (falling back to a
        // timestamp+random string on very old browsers) avoids this entirely.
        function newId() {
            if (window.crypto && typeof window.crypto.randomUUID === 'function') {
                return window.crypto.randomUUID();
            }
            return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        }

        // ---- TOASTS ----
        // Lightweight, non-blocking feedback for things that used to be alert(). Pass
        // { actionLabel, onAction } to show an action button (e.g. "Undo") instead of
        // an OK button; the toast auto-dismisses after `duration` ms either way.
        function showToast(message, { actionLabel, onAction, duration = 4000, tone = 'default' } = {}) {
            const container = document.getElementById('toast-container');
            if (!container) { console.log(message); return; }

            const toneClasses = {
                default: 'bg-slate-800 dark:bg-slate-700 text-white',
                success: 'bg-emerald-600 text-white',
                error: 'bg-red-600 text-white'
            };

            const toast = document.createElement('div');
            toast.className = `pointer-events-auto flex items-center gap-3 ${toneClasses[tone] || toneClasses.default} text-xs font-medium px-4 py-3 rounded-lg shadow-lg max-w-sm transition-all duration-200 opacity-0 translate-y-1`;
            toast.innerHTML = `
                <span class="flex-1 whitespace-pre-line">${escapeHtml(message)}</span>
                ${actionLabel ? `<button class="toast-action underline font-semibold whitespace-nowrap">${escapeHtml(actionLabel)}</button>` : ''}
                <button class="toast-dismiss text-white/70 hover:text-white font-bold leading-none">&times;</button>
            `;
            container.appendChild(toast);
            requestAnimationFrame(() => toast.classList.remove('opacity-0', 'translate-y-1'));

            let dismissed = false;
            const dismiss = () => {
                if (dismissed) return;
                dismissed = true;
                toast.classList.add('opacity-0');
                setTimeout(() => toast.remove(), 200);
            };

            const timer = setTimeout(dismiss, duration);
            toast.querySelector('.toast-dismiss').addEventListener('click', () => { clearTimeout(timer); dismiss(); });
            if (actionLabel && onAction) {
                toast.querySelector('.toast-action').addEventListener('click', () => {
                    clearTimeout(timer);
                    dismiss();
                    onAction();
                });
            }
        }

        // ---- STYLED CONFIRM ----
        // Promise-based replacement for window.confirm() so destructive actions match the
        // app's look. Usage: if (!(await showConfirm('Delete card?', 'This cannot be undone.'))) return;
        function showConfirm(title, message, { confirmLabel = 'Confirm' } = {}) {
            return new Promise((resolve) => {
                const modal = document.getElementById('confirm-modal');
                document.getElementById('confirm-modal-title').textContent = title;
                document.getElementById('confirm-modal-message').textContent = message;
                const okBtn = document.getElementById('confirm-modal-ok');
                const cancelBtn = document.getElementById('confirm-modal-cancel');
                okBtn.textContent = confirmLabel;
                modal.classList.remove('hidden');

                const cleanup = (result) => {
                    modal.classList.add('hidden');
                    okBtn.removeEventListener('click', onOk);
                    cancelBtn.removeEventListener('click', onCancel);
                    document.removeEventListener('keydown', onKey);
                    resolve(result);
                };
                const onOk = () => cleanup(true);
                const onCancel = () => cleanup(false);
                const onKey = (e) => { if (e.key === 'Escape') cleanup(false); };

                okBtn.addEventListener('click', onOk);
                cancelBtn.addEventListener('click', onCancel);
                document.addEventListener('keydown', onKey);
            });
        }

        // ---- UNDOABLE DELETE ----
        // Deleting hides the transaction immediately (it's excluded from every render via
        // hiddenTxIds) and only calls deleteTransactionFromDB() after the toast's timeout
        // expires. Clicking Undo before then just un-hides it — nothing was sent to the DB.
        const hiddenTxIds = new Set();
        const pendingDeleteTimers = new Map();
        const UNDO_WINDOW_MS = 5000;

        function softDeleteTransactions(ids) {
            ids.forEach(id => hiddenTxIds.add(id));
            render();

            const label = ids.length === 1 ? 'Transaction will be deleted in 5 seconds' : `${ids.length} transactions will be deleted in 5 seconds`;
            const timer = setTimeout(async () => {
                const deleted = ids.length > 1
                    ? await deleteTransactionsFromDB(ids)
                    : await deleteTransactionFromDB(ids[0]);
                if (deleted === false) {
                    ids.forEach(id => hiddenTxIds.delete(id));
                    ids.forEach(id => pendingDeleteTimers.delete(id));
                    render();
                    return;
                }
                for (const id of ids) {
                    hiddenTxIds.delete(id);
                    pendingDeleteTimers.delete(id);
                }
                render();
            }, UNDO_WINDOW_MS);
            ids.forEach(id => pendingDeleteTimers.set(id, timer));

            showToast(label, {
                actionLabel: 'Undo',
                duration: UNDO_WINDOW_MS,
                onAction: () => {
                    ids.forEach(id => {
                        clearTimeout(pendingDeleteTimers.get(id));
                        pendingDeleteTimers.delete(id);
                        hiddenTxIds.delete(id);
                    });
                    render();
                }
            });
        }

        // txList: transactions for ONE card (or any set you want a balance for).
        // Entries dated after asOfDate are ignored - they are not owed yet.
        function cardCashbackMode(card) {
            if (card && (card.cashbackCreditMode === 'monthly' || card.cashbackCreditMode === 'next_day')) return card.cashbackCreditMode;
            return card && (card.cashbackNextMonth === false || card.cashback_next_month === false) ? 'next_day' : 'monthly';
        }
        function cardCashbackCreditDay(card) {
            const day = Number(card && card.cashbackCreditDay);
            return Number.isInteger(day) && day >= 1 && day <= 31 ? day : 1;
        }
        function isImmediateCashbackTransaction(tx) {
            return txKind(tx.type) === 'Cashback' || tx.category === 'Cashback';
        }
        function cashbackCreditDate(tx, card = resolveCardForTransaction(tx)) {
            const date = tx.date || '';
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
            if (isImmediateCashbackTransaction(tx)) return date;
            if (cardCashbackMode(card) === 'next_day') {
                const [year, month, day] = date.split('-').map(Number);
                return localDateKey(new Date(year, month - 1, day + 1));
            }
            const creditMonth = nextMonthKey(date.substring(0, 7));
            const [year, month] = creditMonth.split('-').map(Number);
            const day = Math.min(cardCashbackCreditDay(card), new Date(year, month, 0).getDate());
            return `${creditMonth}-${String(day).padStart(2, '0')}`;
        }
        function formatCashbackCreditDate(dateKey) {
            const [year, month, day] = dateKey.split('-').map(Number);
            return new Date(year, month - 1, day).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        }
        function isCashbackCredited(tx, asOfDate, card = resolveCardForTransaction(tx)) {
            const creditDate = cashbackCreditDate(tx, card);
            return !!creditDate && creditDate <= asOfDate;
        }
        function calculateOutstanding(txList, asOfDate = localDateKey(), card = null) {
            const r = { purchases: 0, withdrawals: 0, fees: 0, repaid: 0, transferOut: 0, transferIn: 0, cashbackCredited: 0, cashbackPending: 0, cashbackPendingByDate: {} };

            txList.forEach(t => {
                const date = t.date || '';
                if (date > asOfDate) return;

                const amount = parseFloat(t.amount) || 0;
                const cashback = parseFloat(t.cashback) || 0;
                const fee = parseFloat(t.serviceCharge) || 0;

                const immediateCashback = isImmediateCashbackTransaction(t);
                if (!immediateCashback && txKind(t.type) === 'Purchase') r.purchases += amount;
                else if (!immediateCashback && txKind(t.type) === 'Cash Withdrawal') r.withdrawals += amount;
                else if (!immediateCashback && txKind(t.type) === 'Repaid') r.repaid += amount;
                else if (t.type === TRANSFER_OUT_TYPE) r.transferOut += amount;
                else if (t.type === TRANSFER_IN_TYPE) r.transferIn += amount;
                r.fees += fee;

                if (immediateCashback) {
                    r.cashbackCredited += amount;
                } else {
                    const creditDate = cashbackCreditDate(t, card || undefined);
                    if (creditDate && creditDate <= asOfDate) r.cashbackCredited += cashback;
                    else if (date && date <= asOfDate) {
                        r.cashbackPending += cashback;
                        if (creditDate && cashback > 0) {
                            r.cashbackPendingByDate[creditDate] = (r.cashbackPendingByDate[creditDate] || 0) + cashback;
                        }
                    }
                }
            });

            r.outstanding = r.purchases + r.withdrawals + r.transferOut + (INCLUDE_FEES_IN_OUTSTANDING ? r.fees : 0)
                          - r.repaid - r.transferIn - r.cashbackCredited;
            r.afterPending = r.outstanding - r.cashbackPending;
            return r;
        }

        // ---- STATEMENT / PAYMENT DATES ----
        const PAYMENT_WARNING_DAYS = 5; // card turns orange this many days before the payment day, red on the day

        // Next date (today or later) that falls on the given day-of-month. Days that don't exist in a
        // short month (e.g. 31 in June, 30 in February) roll back to that month's last day.
        function nextOccurrence(day, fromDate) {
            const from = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
            const inMonth = (y, m) => new Date(y, m, Math.min(day, new Date(y, m + 1, 0).getDate()));
            let d = inMonth(from.getFullYear(), from.getMonth());
            if (d < from) d = inMonth(from.getFullYear(), from.getMonth() + 1);
            return d;
        }
        function daysBetween(a, b) { return Math.round((b - a) / 86400000); }
        function shortDate(d) { return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); }
        function countdownText(n) { return n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`; }

        // Returns the card's container colours plus the statement / payment row shown inside it.
        function getCardDateInfo(c, todayDate = new Date()) {
            const today = new Date(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate());
            let wrapperClass = 'border-[#232a3b]';
            let bgClass = 'bg-[#0d1017]';
            let isAlert = false;
            let statementHtml = '';
            let badgeHtml = '';

            if (c.statementDay) {
                const st = nextOccurrence(c.statementDay, today);
                const n = daysBetween(today, st);
                statementHtml = `<span class="mono text-slate-400">🧾 Statement: ${shortDate(st)} · ${countdownText(n)}</span>`;
            }

            if (c.paymentDay) {
                const due = nextOccurrence(c.paymentDay, today);
                const n = daysBetween(today, due);
                let badgeClass, label;
                if (n === 0) {
                    wrapperClass = 'border-red-500/80 ring-1 ring-red-500/50'; bgClass = 'bg-red-950/30';
                    isAlert = true;
                    badgeClass = 'bg-red-600 text-white';
                    label = `🚨 Payment due TODAY · ${shortDate(due)}`;
                } else if (n <= PAYMENT_WARNING_DAYS) {
                    wrapperClass = 'border-amber-500/60'; bgClass = 'bg-amber-950/20';
                    isAlert = true;
                    badgeClass = 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200';
                    label = `⏰ Payment due ${countdownText(n)} · ${shortDate(due)}`;
                } else {
                    badgeClass = 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300';
                    label = `Payment: ${shortDate(due)} · ${countdownText(n)}`;
                }
                badgeHtml = `<span class="px-2 py-0.5 rounded-full font-semibold ${badgeClass}">${label}</span>`;
            }

            let rowHtml;
            if (statementHtml || badgeHtml) {
                rowHtml = `<div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 text-[11px]">${statementHtml}${badgeHtml}</div>`;
            } else {
                rowHtml = `<p class="text-[11px] text-slate-400 dark:text-slate-500">Add a statement &amp; payment day (Edit) to get due-date alerts.</p>`;
            }
            return { wrapperClass, bgClass, rowHtml, isAlert };
        }

        const openCalcCards = new Set(); // remembers which "How it's calculated" panels are open across re-renders
        const openCardDetails = new Set();
        function setCalcOpen(cardId, isOpen) {
            if (isOpen) openCalcCards.add(cardId); else openCalcCards.delete(cardId);
        }

        function closeCardMenu() {
            const m = document.getElementById('cc-menu');
            if (m) m.remove();
            document.querySelectorAll('.cc-dots[aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
        }
        function toggleCardMenu(id, ev, btn) {
            if (ev) ev.stopPropagation();
            const open = document.getElementById('cc-menu');
            const same = open && open.dataset.card === String(id);
            closeCardMenu();
            if (same) return;
            const card = cards.find(c => c.id === String(id));
            if (!card) return;
            const m = document.createElement('div');
            m.id = 'cc-menu';
            m.dataset.card = String(id);
            m.setAttribute('role', 'menu');
            m.innerHTML = '<button type="button" role="menuitem" data-act="edit">✏️ Edit</button>'
                + '<button type="button" role="menuitem" data-act="toggle" class="' + (card.disabled ? 'ok' : 'warn') + '">' + (card.disabled ? '✅ Enable' : '⏸️ Disable') + '</button>'
                + '<button type="button" role="menuitem" data-act="delete" class="danger">🗑️ Delete</button>';
            m.addEventListener('click', e => {
                const b = e.target.closest('button[data-act]');
                if (!b) return;
                e.stopPropagation();
                const act = b.dataset.act;
                closeCardMenu();
                if (act === 'edit') editCard(id);
                else if (act === 'toggle') toggleCardDisabled(id);
                else if (act === 'delete') deleteCard(id);
            });
            document.body.appendChild(m);
            const r = btn.getBoundingClientRect();
            const w = m.offsetWidth, h = m.offsetHeight;
            let left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
            let top = r.bottom + 6;
            if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
            m.style.left = left + 'px';
            m.style.top = top + 'px';
            btn.setAttribute('aria-expanded', 'true');
            const first = m.querySelector('button');
            if (first) first.focus({ preventScroll: true });
        }
        document.addEventListener('click', e => { if (!e.target.closest('#cc-menu')) closeCardMenu(); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCardMenu(); });
        window.addEventListener('resize', closeCardMenu);
        window.addEventListener('scroll', e => { if (!(e.target && e.target.closest && e.target.closest('#cc-menu'))) closeCardMenu(); }, true);
        function toggleCardDetails(cardId, button) {
            const details = document.getElementById(`card-details-${cardId}`);
            if (!details) return;
            const isOpen = details.classList.toggle('hidden') === false;
            if (isOpen) openCardDetails.add(cardId); else openCardDetails.delete(cardId);
            if (button) {
                button.setAttribute('aria-expanded', String(isOpen));
                button.textContent = isOpen ? 'Less' : 'More';
            }
        }

        function escapeHtml(str) {
            if (str === null || str === undefined) return '';
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        function categorySlug(cat) {
            return cat.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        }

        function defaultRates(fallbackRate = 1) {
            const rates = {};
            RATE_CATEGORIES.forEach(cat => { rates[cat] = cat === 'Govt' ? 0.15 : fallbackRate; });
            return rates;
        }

        function renderRateInputs(existingRates = {}, newlyAddedCategory = '', existingCaps = null) {
            const container = document.getElementById('rate-inputs-container');
            const select = document.getElementById('card-rate-category-select');
            const categoryCaps = existingCaps || getCardCategoryCapsFromForm();
            const rateCategories = Object.keys(existingRates).filter(category => RATE_CATEGORIES.includes(category));
            const isLegacyFullMap = rateCategories.length === RATE_CATEGORIES.length;
            const selectedCategories = rateCategories.filter(category =>
                category === newlyAddedCategory || !isLegacyFullMap || Number(existingRates[category]) > 0
            );
            Object.keys(categoryCaps).forEach(category => {
                if (RATE_CATEGORIES.includes(category) && !selectedCategories.includes(category)) selectedCategories.push(category);
            });
            if (newlyAddedCategory && RATE_CATEGORIES.includes(newlyAddedCategory) && !selectedCategories.includes(newlyAddedCategory)) {
                selectedCategories.push(newlyAddedCategory);
            }

            const rateRows = selectedCategories.map(category => {
                const value = category === newlyAddedCategory ? '' : (existingRates[category] ?? '');
                const cap = categoryCaps[category] ?? '';
                const capEnabled = Object.prototype.hasOwnProperty.call(categoryCaps, category);
                const encoded = encodeURIComponent(category).replace(/'/g, '%27');
                return `
                    <div class="group rounded-xl border border-slate-200/90 bg-white/80 p-2.5 shadow-sm transition duration-200 hover:-translate-y-px hover:border-indigo-200 hover:shadow-md dark:border-slate-700 dark:bg-slate-800/70 dark:hover:border-indigo-500/40">
                        <div class="mb-2 flex min-w-0 items-center justify-between gap-2">
                            <label for="rate-${categorySlug(category)}" class="flex min-w-0 items-center gap-2.5 font-semibold text-slate-700 dark:text-slate-200">
                                <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 ring-1 ring-inset ring-indigo-100 dark:bg-indigo-400/10 dark:text-indigo-300 dark:ring-indigo-400/15">
                                    <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 13.5 13 21l-10-10V3h8l9.5 9.5a.7.7 0 0 1 0 1Z"/><circle cx="7.5" cy="7.5" r="1"/></svg>
                                </span>
                                <span class="truncate">${escapeHtml(category)}</span>
                            </label>
                            <button type="button" onclick="removeCardRate(decodeURIComponent('${encoded}'))" aria-label="Remove ${escapeHtml(category)} rate" title="Remove category" class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-red-50 hover:text-red-600 focus:outline-none focus:ring-2 focus:ring-red-400/40 dark:text-slate-500 dark:hover:bg-red-950/40 dark:hover:text-red-300">
                                <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m18 6-12 12M6 6l12 12"/></svg>
                            </button>
                        </div>
                        <div class="grid grid-cols-2 gap-2">
                            <label class="min-w-0 text-[10px] font-medium text-slate-500 dark:text-slate-400">
                                Cashback rate (%)
                                <span class="relative mt-1 block">
                                    <input type="number" step="any" min="0" data-rate-category="${escapeHtml(category)}"
                                        id="rate-${categorySlug(category)}" placeholder="0.00" value="${escapeHtml(value)}" aria-label="${escapeHtml(category)} cashback percentage"
                                        class="w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-sm font-semibold tabular-nums text-slate-900 outline-none transition placeholder:font-normal placeholder:text-slate-400 focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-500/10 dark:border-slate-600 dark:bg-slate-700/80 dark:text-slate-100 dark:focus:border-indigo-400 dark:focus:bg-slate-700">
                                </span>
                            </label>
                            <div data-cap-control class="rounded-lg border border-slate-200 p-1.5 transition dark:border-slate-700">
                                <label class="flex items-center gap-1.5 text-[10px] font-medium text-slate-500 dark:text-slate-400">
                                    <input type="checkbox" ${capEnabled ? 'checked' : ''} onchange="toggleCardCapInput(this)" aria-label="Set monthly cashback cap for ${escapeHtml(category)}" class="h-3.5 w-3.5 shrink-0 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500">
                                    Monthly cap
                                </label>
                                <input type="number" step="any" min="0.01" data-category-cap="${escapeHtml(category)}"
                                    aria-label="${escapeHtml(category)} monthly cashback cap in AED" placeholder="Enter cap" value="${escapeHtml(cap)}"
                                    ${capEnabled ? 'required' : 'disabled'}
                                    class="mt-1 w-full rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm font-semibold tabular-nums text-slate-900 outline-none transition placeholder:font-normal placeholder:text-slate-400 focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-500/10 dark:border-slate-600 dark:bg-slate-700/80 dark:text-slate-100 dark:focus:border-indigo-400 dark:focus:bg-slate-700">
                            </div>
                        </div>
                    </div>`;
            }).join('');
            container.innerHTML = `${rateRows}
                <button type="button" onclick="showCardRateCategoryPicker()"
                    class="group col-span-full flex w-full items-center justify-center gap-2.5 rounded-xl border border-dashed border-indigo-300 bg-indigo-50/60 px-3 py-3 text-sm font-bold text-indigo-700 shadow-sm transition duration-200 hover:-translate-y-px hover:border-indigo-400 hover:bg-indigo-100/80 hover:shadow-md focus:outline-none focus:ring-4 focus:ring-indigo-500/15 dark:border-indigo-500/30 dark:bg-indigo-400/[0.07] dark:text-indigo-300 dark:hover:border-indigo-400/60 dark:hover:bg-indigo-400/[0.12]">
                    <span class="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-100 transition group-hover:scale-110 dark:bg-indigo-400/15">
                        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
                    </span>
                    Add cashback category
                </button>`;
            container.querySelectorAll('[data-cap-control]').forEach(control => {
                const checkbox = control.querySelector('input[type="checkbox"]');
                toggleCardCapInput(checkbox);
            });

            if (select) {
                const remainingCategories = RATE_CATEGORIES.filter(category => !selectedCategories.includes(category));
                select.innerHTML = `<option value="">Choose a category…</option>${remainingCategories.map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('')}<option value="__add_new_category__">+ Add new category…</option>`;
            }
        }

        function showCardRateCategoryPicker() {
            const select = document.getElementById('card-rate-category-select');
            if (!select) return;
            select.hidden = false;
            select.focus();
        }

        function handleCardRateCategorySelection() {
            const select = document.getElementById('card-rate-category-select');
            if (select?.value === '__add_new_category__') {
                select.value = '';
                select.hidden = true;
                openCardCategorySettings();
                return;
            }
            addSelectedCardRate();
        }

        function addSelectedCardRate() {
            const select = document.getElementById('card-rate-category-select');
            const category = select?.value;
            if (!category || !RATE_CATEGORIES.includes(category)) return;
            const rates = getCardRatesFromForm();
            const caps = getCardCategoryCapsFromForm();
            rates[category] = '';
            renderRateInputs(rates, category, caps);
            select.hidden = true;
            document.getElementById(`rate-${categorySlug(category)}`)?.focus();
        }

        function removeCardRate(category) {
            const rates = getCardRatesFromForm();
            const caps = getCardCategoryCapsFromForm();
            delete rates[category];
            delete caps[category];
            renderRateInputs(rates, '', caps);
        }

        function getCardRatesFromForm() {
            const rates = {};
            document.querySelectorAll('#rate-inputs-container [data-rate-category]').forEach(input => {
                const parsed = parseFloat(input.value);
                rates[input.dataset.rateCategory] = isNaN(parsed) || parsed < 0 ? 0 : parsed;
            });
            return rates;
        }

        function getCardCategoryCapsFromForm() {
            const caps = {};
            document.querySelectorAll('#rate-inputs-container [data-category-cap]').forEach(input => {
                const checkbox = input.closest('[data-cap-control]').querySelector('input[type="checkbox"]');
                if (checkbox.checked) caps[input.dataset.categoryCap] = input.value;
            });
            return caps;
        }

        function populateCategorySelects() {
            populateTransactionTypes();
            document.getElementById('rec-category').innerHTML =
                RATE_CATEGORIES.map(cat => `<option value="${cat}">${cat}</option>`).join('');
            renderRecommendationCategoryPills();

            populateTransactionCategorySelect();
        }

        function populateTransactionCategorySelect(preferredCategory) {
            const select = document.getElementById('exp-category');
            if (!select) return;
            const previousValue = preferredCategory !== undefined
                ? preferredCategory
                : (select.value || select.dataset.previousValue || '');
            const options = ['<option value="">None / Default</option>'];
            RATE_CATEGORIES.forEach(category => {
                options.push(`<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`);
            });
            TX_ONLY_CATEGORIES.forEach(category => {
                options.push(`<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`);
            });
            options.push('<option value="__add_new_category__">+ Add new category...</option>');
            select.innerHTML = options.join('');
            if (previousValue && [...select.options].some(option => option.value === previousValue)) {
                select.value = previousValue;
            } else {
                select.value = '';
            }
            select.dataset.previousValue = select.value;
        }

        function populateTransactionTypes() {
            const select = document.getElementById('exp-type');
            if (!select) return;
            const selected = select.value;
            const types = transactionEntryKind === 'income'
                ? TYPE_FILTER_OPTIONS.filter(type => ['Repaid', 'Cashback'].includes(txKind(type)))
                : transactionEntryKind === 'expense'
                    ? TYPE_FILTER_OPTIONS.filter(type => !isTransferType(type) && (isSpendKind(type) || !txKind(type)))
                    : [];
            const hasTransactionType = ['income', 'expense'].includes(transactionEntryKind);
            select.innerHTML = hasTransactionType
                ? `<option value="">Select type...</option>${types.map(type => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join('')}<option value="__add_new_type__">+ Add new type...</option>`
                : '<option value="">Choose transaction kind first</option>';
            select.disabled = !hasTransactionType;
            select.required = hasTransactionType;
            if (types.some(type => type === selected)) select.value = selected;
            else select.value = transactionEntryKind === 'income' ? 'Repaid' : transactionEntryKind === 'expense' ? 'Purchase' : '';
        }

        function groupedCardOptions(cardList) {
            return ['Debit', 'Credit'].map(type => {
                const group = cardList.filter(card => (isDebit(card) ? 'Debit' : 'Credit') === type);
                return group.length
                    ? `<optgroup label="${type}">${group.map(card => `<option value="${escapeHtml(card.id)}">${escapeHtml(card.name)}</option>`).join('')}</optgroup>`
                    : '';
            }).join('');
        }

        function populateTransferCardSelects(sourceId = '', destinationId = '', allowInactive = false) {
            const sourceSelect = document.getElementById('exp-transfer-source');
            const destinationSelect = document.getElementById('exp-transfer-destination');
            if (!sourceSelect || !destinationSelect) return;
            const sourceCards = activeCards();
            const destinationCards = activeCards();
            [sourceId, destinationId].forEach((id, index) => {
                if (!id) return;
                const card = cards.find(c => String(c.id) === String(id));
                const list = index === 0 ? sourceCards : destinationCards;
                if (card && !list.some(c => String(c.id) === String(card.id)) && allowInactive) list.push(card);
            });
            sourceSelect.innerHTML = `<option value="">Select source card...</option>${groupedCardOptions(sourceCards)}`;
            sourceSelect.disabled = sourceCards.length === 0;
            const availableDestinations = destinationCards.filter(card => String(card.id) !== String(sourceId));
            destinationSelect.innerHTML = `<option value="">Select destination card...</option>${groupedCardOptions(availableDestinations)}`;
            destinationSelect.disabled = availableDestinations.length === 0;
            sourceSelect.required = transactionEntryKind === 'transfer';
            destinationSelect.required = transactionEntryKind === 'transfer';
            sourceSelect.value = sourceCards.some(card => String(card.id) === String(sourceId)) ? String(sourceId) : '';
            destinationSelect.value = availableDestinations.some(card => String(card.id) === String(destinationId)) ? String(destinationId) : '';
        }

        function setTransactionEntryKind(kind) {
            transactionEntryKind = ['income', 'expense', 'transfer'].includes(kind) ? kind : '';
            const isTransfer = transactionEntryKind === 'transfer';
            const isEntry = transactionEntryKind === 'income' || transactionEntryKind === 'expense';
            if (!document.getElementById('editing-tx-id').value) {
                document.getElementById('tx-submit-btn').textContent = isTransfer ? 'Log Transfer' : 'Log Entry';
            }
            document.querySelectorAll('input[name="entry-kind"]').forEach(input => {
                input.checked = input.value === transactionEntryKind;
            });
            document.getElementById('exp-date-type-row').classList.toggle('grid-cols-1', isTransfer);
            document.getElementById('exp-date-type-row').classList.toggle('grid-cols-2', !isTransfer);
            document.getElementById('exp-type-wrapper').classList.toggle('hidden', isTransfer);
            document.getElementById('exp-card-wrapper').classList.toggle('hidden', isTransfer);
            document.getElementById('exp-transfer-cards').classList.toggle('hidden', !isTransfer);
            document.getElementById('exp-card').required = isEntry;
            document.getElementById('exp-category-wrapper').classList.toggle('hidden', isTransfer);
            document.getElementById('exp-amount-category-row').classList.toggle('grid-cols-1', isTransfer);
            document.getElementById('exp-amount-category-row').classList.toggle('grid-cols-2', !isTransfer);
            document.getElementById('exp-fee-cashback-row').classList.toggle('hidden', isTransfer);
            document.getElementById('exp-emi-wrapper').classList.toggle('hidden', isTransfer);
            if (isTransfer) {
                document.getElementById('exp-service').value = '0';
                document.getElementById('exp-cashback').value = '0';
                document.getElementById('exp-is-emi').checked = false;
                document.getElementById('exp-emi-details').classList.add('hidden');
            }
            populateTransactionTypes();
            const selectedType = document.getElementById('exp-type').value;
            if (isEntry && selectedType) syncCategoryState(selectedType);
            if (isTransfer) {
                populateTransferCardSelects(
                    document.getElementById('exp-transfer-source').value,
                    document.getElementById('exp-transfer-destination').value,
                    !!document.getElementById('editing-tx-id').value
                );
            }
            syncRepaidLabel();
        }

        function entryKindForType(type) {
            if (isTransferType(type)) return 'transfer';
            return ['Repaid', 'Cashback'].includes(txKind(type)) ? 'income' : 'expense';
        }

        // Merge a list of saved types/categories into the live in-memory lists.
        function applyCustomSettings(savedTypes, savedCategories) {
            (savedTypes || []).filter(t => typeof t === 'string' && t.trim()).forEach(type => {
                if (!customTransactionTypes.includes(type)) customTransactionTypes.push(type);
                if (!TYPE_FILTER_OPTIONS.includes(type)) TYPE_FILTER_OPTIONS.push(type);
            });
            (savedCategories || []).filter(c => typeof c === 'string' && c.trim()).forEach(category => {
                if (!customCategories.includes(category)) customCategories.push(category);
                if (!RATE_CATEGORIES.includes(category) && !TX_ONLY_CATEGORIES.includes(category)) {
                    RATE_CATEGORIES.push(category);
                }
            });
            ensureWithdrawalChargePercentages(RATE_CATEGORIES);
        }

        // Categories / transaction types are SHARED by every user of the app and live in the
        // Supabase table "shared_options" (kind = 'category' | 'transaction_type').
        // localStorage is only an offline / local-mode cache.
        function refreshOptionUI() {
            populateTransactionTypes();
            renderTypeFilter();
            populateCategorySelects();
            const cardModal = document.getElementById('card-modal');
            if (!cardModal || cardModal.classList.contains('hidden')) renderRateInputs({}); // don't wipe a card form being edited
        }

        async function loadCustomSettings() {
            try {
                Object.assign(customTypeBehavior, JSON.parse(localStorage.getItem('cb_custom_type_behaviors') || '{}'));
            } catch (error) { /* ignore */ }
            try {
                applyCustomSettings(
                    JSON.parse(localStorage.getItem('cb_custom_transaction_types') || '[]'),
                    JSON.parse(localStorage.getItem('cb_custom_categories') || '[]')
                );
            } catch (error) {
                console.warn('Could not read cached custom settings:', error);
            }
            if (_supabase && currentUserId) {
                let { data, error } = await _supabase
                    .from('shared_options')
                    .select('kind, name, behaves_like')
                    .order('created_at', { ascending: true });
                if (error && /behaves_like/.test(error.message || '')) { // column not added yet: fall back to the old query
                    ({ data, error } = await _supabase.from('shared_options').select('kind, name').order('created_at', { ascending: true }));
                }
                if (error) {
                    console.warn('Could not load shared_options from Supabase (table missing?):', error.message);
                } else if (data) {
                    applyCustomSettings(
                        data.filter(r => r.kind === 'transaction_type').map(r => r.name),
                        data.filter(r => r.kind === 'category').map(r => r.name)
                    );
                    data.filter(r => r.kind === 'transaction_type' && r.behaves_like).forEach(r => { customTypeBehavior[r.name] = r.behaves_like; });
                    persistTypeBehaviors();
                    localStorage.setItem('cb_custom_transaction_types', JSON.stringify(customTransactionTypes));
                    localStorage.setItem('cb_custom_categories', JSON.stringify(customCategories));
                }
            }
        }

        // Insert ONE shared option. A duplicate (same kind + name, any case) is treated as success.
        let warnedMissingSettingsTable = false;
        let warnedMissingBehaviorColumn = false;
        async function saveSharedOption(kind, name, behavesLike) {
            localStorage.setItem('cb_custom_transaction_types', JSON.stringify(customTransactionTypes));
            localStorage.setItem('cb_custom_categories', JSON.stringify(customCategories));
            if (!_supabase || !currentUserId) return true;
            // Check exact names case-insensitively before inserting, without treating % or _
            // in a category name as SQL wildcard characters.
            try {
                const existing = await _supabase
                    .from('shared_options')
                    .select('id, name')
                    .eq('kind', kind);
                if (!existing.error && existing.data && existing.data.some(option =>
                    String(option.name || '').trim().toLowerCase() === name.trim().toLowerCase()
                )) return true;
            } catch (error) {
                console.warn('Could not check existing shared option:', error);
            }
            const row = { kind, name, created_by: currentUserId };
            if (kind === 'transaction_type' && behavesLike) row.behaves_like = behavesLike;
            let { error } = await _supabase.from('shared_options').insert(row);
            if (error && 'behaves_like' in row && /behaves_like/.test(error.message || '')) {
                delete row.behaves_like; // column missing: save the type itself, keep the behaviour on this device
                if (!warnedMissingBehaviorColumn) {
                    warnedMissingBehaviorColumn = true;
                    alert('The type was saved, but its "Feels like" setting is only remembered on this device until you run this once in the Supabase SQL editor:\n\n' +
                          "alter table public.shared_options add column if not exists behaves_like text check (behaves_like in ('Purchase','Cash Withdrawal','Repaid','Cashback','None'));\n" +
                          "create policy shared_options_update on public.shared_options for update to authenticated using (created_by = auth.uid() or public.is_admin()) with check (created_by = auth.uid() or public.is_admin());\n" +
                          "grant update on public.shared_options to authenticated;");
                }
                ({ error } = await _supabase.from('shared_options').insert(row));
            }
            if (error && error.code !== '23505') {
                console.error('Saving shared option failed:', error);
                if (!warnedMissingSettingsTable) {
                    warnedMissingSettingsTable = true;
                    alert('Saved on this device only. The "shared_options" table is missing or blocked in Supabase.\n\nRun shared_options.sql once in the Supabase SQL editor, then add the item again.');
                }
                return false;
            }
            return true;
        }

        async function syncUsedSharedOptions(categories, types) {
            const categoryNames = [...new Set((categories || []).map(name => String(name || '').trim()).filter(Boolean))];
            const typeNames = [...new Set((types || []).map(name => String(name || '').trim()).filter(Boolean))];
            const existingCategories = new Map([...RATE_CATEGORIES, ...TX_ONLY_CATEGORIES].map(name => [name.toLowerCase(), name]));
            const existingTypes = new Map(TYPE_FILTER_OPTIONS.map(name => [name.toLowerCase(), name]));
            const newCategories = [];
            const newTypes = [];

            categoryNames.forEach(name => {
                const key = name.toLowerCase();
                if (!existingCategories.has(key)) {
                    existingCategories.set(key, name);
                    newCategories.push(name);
                }
            });
            typeNames.forEach(name => {
                const key = name.toLowerCase();
                if (!existingTypes.has(key)) {
                    existingTypes.set(key, name);
                    newTypes.push(name);
                }
            });

            if (newCategories.length || newTypes.length) applyCustomSettings(newTypes, newCategories);

            let failures = 0;
            for (const name of categoryNames) {
                try {
                    if ((await saveSharedOption('category', name)) === false) failures++;
                } catch (error) {
                    console.error(`Could not sync category "${name}" to shared_options:`, error);
                    failures++;
                }
            }
            for (const name of typeNames) {
                try {
                    if ((await saveSharedOption('transaction_type', name)) === false) failures++;
                } catch (error) {
                    console.error(`Could not sync transaction type "${name}" to shared_options:`, error);
                    failures++;
                }
            }
            if (newCategories.length || newTypes.length) refreshOptionUI();
            return { categories: newCategories.length, types: newTypes.length, failures };
        }

        // Live updates: when any user adds an option, everyone else gets it without a refresh.
        // (Needs Realtime enabled for the table — the SQL script does this. Harmless if it isn't.)
        let sharedOptionsChannel = null;
        function subscribeSharedOptions() {
            if (!_supabase || sharedOptionsChannel) return;
            sharedOptionsChannel = _supabase.channel('shared-options')
                .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'shared_options' }, payload => {
                    const r = payload.new || {};
                    if (r.kind === 'category') applyCustomSettings([], [r.name]);
                    else if (r.kind === 'transaction_type') { applyCustomSettings([r.name], []); if (r.behaves_like) { customTypeBehavior[r.name] = r.behaves_like; persistTypeBehaviors(); } }
                    refreshOptionUI();
                })
                .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'shared_options' }, payload => {
                    const r = payload.new || {};
                    if (r.kind === 'transaction_type' && r.behaves_like) {
                        customTypeBehavior[r.name] = r.behaves_like; persistTypeBehaviors();
                        refreshOptionUI(); render();
                    }
                })
                .subscribe();
        }

        async function openSettings() {
            document.getElementById('settings-modal').classList.remove('hidden');
            await loadCustomSettings(); // pick up anything other users added meanwhile
            refreshOptionUI();
        }

        let transactionSettingsReturn = null;
        let cardRateSettingsReturn = null;
        let cardRateCapsSettingsReturn = null;

        async function openCardCategorySettings() {
            cardRateSettingsReturn = Object.fromEntries(
                [...document.querySelectorAll('#rate-inputs-container [data-rate-category]')]
                    .map(input => [input.dataset.rateCategory, input.value])
            );
            cardRateCapsSettingsReturn = getCardCategoryCapsFromForm();
            await openSettings();
            document.getElementById('new-category').focus();
        }

        async function openTransactionSettings(kind) {
            const select = document.getElementById(kind === 'type' ? 'exp-type' : 'exp-category');
            const defaultValue = kind === 'type' ? (transactionEntryKind === 'income' ? 'Repaid' : 'Purchase') : '';
            transactionSettingsReturn = { kind, previousValue: select.dataset.previousValue || defaultValue };
            document.getElementById('tx-modal').classList.add('hidden');
            await openSettings();
            document.getElementById(kind === 'type' ? 'new-transaction-type' : 'new-category').focus();
        }

        function returnToTransactionSettingsSelection(kind, value) {
            if (!transactionSettingsReturn) return;
            document.getElementById('settings-modal').classList.add('hidden');
            document.getElementById('tx-modal').classList.remove('hidden');
            const select = document.getElementById(kind === 'type' ? 'exp-type' : 'exp-category');
            if (kind === 'type' && transactionEntryKind !== entryKindForType(value)) {
                setTransactionEntryKind(entryKindForType(value));
            }
            select.value = value;
            select.dataset.previousValue = value;
            if (kind === 'type') syncCategoryState(value);
            calculateDynamicCashback();
            transactionSettingsReturn = null;
        }

        function closeSettings() {
            document.getElementById('settings-modal').classList.add('hidden');
            cardRateSettingsReturn = null;
            cardRateCapsSettingsReturn = null;
            if (transactionSettingsReturn) {
                const { kind, previousValue } = transactionSettingsReturn;
                document.getElementById('tx-modal').classList.remove('hidden');
                const select = document.getElementById(kind === 'type' ? 'exp-type' : 'exp-category');
                select.value = previousValue;
                select.dataset.previousValue = previousValue;
                transactionSettingsReturn = null;
            }
        }

        function addCustomTransactionType() {
            const input = document.getElementById('new-transaction-type');
            const value = input.value.trim();
            if (!value) return;
            if (TYPE_FILTER_OPTIONS.some(type => type.toLowerCase() === value.toLowerCase())) {
                showToast('That transaction type already exists.');
                return;
            }
            const chosen = document.querySelector('input[name="new-type-behavior"]:checked');
            if (!chosen) {
                showToast('Choose what this type feels like: Purchase or Repaid.', { tone: 'error', duration: 4500 });
                const group = document.getElementById('new-transaction-type-behavior-group');
                if (group) group.scrollIntoView({ block: 'nearest' });
                return;
            }
            const behavior = chosen.value;
            TYPE_FILTER_OPTIONS.push(value);
            customTransactionTypes.push(value);
            customTypeBehavior[value] = behavior;
            persistTypeBehaviors();
            saveSharedOption('transaction_type', value, behavior);
            populateTransactionTypes();
            renderTypeFilter();
            input.value = '';
            chosen.checked = false; // next type starts with nothing selected
            showToast(`Added transaction type: ${value} (feels like ${behavior === 'None' ? 'nothing — record only' : behavior})`, { tone: 'success' });
            returnToTransactionSettingsSelection('type', value);
        }

        function addCustomCategory() {
            const input = document.getElementById('new-category');
            const value = input.value.trim();
            if (!value) return;
            if ([...RATE_CATEGORIES, ...TX_ONLY_CATEGORIES].some(category => category.toLowerCase() === value.toLowerCase())) {
                showToast('That category already exists.');
                return;
            }
            RATE_CATEGORIES.push(value);
            customCategories.push(value);
            ensureWithdrawalChargePercentages([value]);
            saveSharedOption('category', value);
            populateCategorySelects();
            if (cardRateSettingsReturn) {
                const rates = { ...cardRateSettingsReturn };
                const caps = { ...cardRateCapsSettingsReturn };
                cardRateSettingsReturn = null;
                cardRateCapsSettingsReturn = null;
                rates[value] = '';
                renderRateInputs(rates, value, caps);
                document.getElementById('settings-modal').classList.add('hidden');
                document.getElementById(`rate-${categorySlug(value)}`)?.focus();
            } else {
                renderRateInputs({});
            }
            input.value = '';
            showToast(`Added category: ${value}`, { tone: 'success' });
            returnToTransactionSettingsSelection('category', value);
        }

        // ---- BEST CARD RECOMMENDER ----
        const REC_ICONS = {
            dining:  { color: '#fbbf24', svg: '<path d="M7 3v8M4.5 3v5a2.5 2.5 0 0 0 5 0V3M7 11v10"/><path d="M17 3c-1.7 1.4-2.5 3.6-2.5 6 0 1.4.9 2.4 2.5 2.5V21"/>' },
            grocery: { color: '#34d399', svg: '<path d="M3 10h18l-1.6 9a2 2 0 0 1-2 1.6H6.6a2 2 0 0 1-2-1.6L3 10Z"/><path d="M8 10l3-6M16 10l-3-6"/>' },
            travel:  { color: '#7dd3fc', svg: '<path d="M2 22h20"/><path d="M6.36 17.4 4 17l-2-4 1.1-.55a2 2 0 0 1 1.8 0l.17.1a2 2 0 0 0 1.8 0L8 12 5 6l.9-.45a2 2 0 0 1 2.09.2l4.02 3a2 2 0 0 0 2.1.2l4.19-2.06a2.41 2.41 0 0 1 1.73-.17L21 7a1.4 1.4 0 0 1 .87 1.99l-.38.76c-.23.46-.6.84-1.07 1.08L7.58 17.2a2 2 0 0 1-1.22.18Z"/>' },
            fuel:    { color: '#fb923c', svg: '<path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16"/><path d="M3 21h12"/><path d="M14 9h2a2 2 0 0 1 2 2v5a1.5 1.5 0 0 0 3 0v-7l-3-3"/><path d="M7 8h4"/>' },
            online:  { color: '#c7d2fe', svg: '<path d="M6 7h12l1 13H5L6 7Z"/><path d="M9 10V6a3 3 0 0 1 6 0v4"/>' },
            govt:    { color: '#94a3b8', svg: '<path d="M3 21h18M5 21V10M9 21V10M15 21V10M19 21V10M2 10l10-6 10 6H2Z"/>' },
            utility: { color: '#fde047', svg: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>' },
            general: { color: '#c4b5fd', svg: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>' },
            custom:  { color: '#f9a8d4', svg: '<path d="M20 12 12 20 4 12V4h8l8 8Z"/><circle cx="8.5" cy="8.5" r="1.2"/>' }
        };
        function recKeyFor(category) {
            const c = String(category).toLowerCase();
            return /din|restaurant|food/.test(c) ? 'dining'
                : /groc|super/.test(c) ? 'grocery'
                : /travel|flight|airline|hotel/.test(c) ? 'travel'
                : /gas|fuel|petrol/.test(c) ? 'fuel'
                : /online|shop/.test(c) ? 'online'
                : /govt|government/.test(c) ? 'govt'
                : /utilit|bill/.test(c) ? 'utility'
                : /other|general/.test(c) ? 'general' : 'custom';
        }
        function recIconFor(category, size = 20) {
            const i = REC_ICONS[recKeyFor(category)];
            return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="color:${i.color}">${i.svg}</svg>`;
        }
        // Small tinted icon tile used in the Cashback by Category list.
        function categoryTileHtml(category) {
            const i = REC_ICONS[recKeyFor(category)];
            return `<span class="fp-cat-ico" style="background:${i.color}1f;border-color:${i.color}4d">${recIconFor(category, 17)}</span>`;
        }
        function cardRateFor(card, cat) {
            const r = card.rates && card.rates[cat] !== undefined ? card.rates[cat] : (card.rates ? card.rates['All Other Spend'] : 0);
            return Number(r) || 0;
        }
        function bestRateForCategory(cat) {
            const pool = activeCards();
            if (!pool.length) return null;
            return Math.max(...pool.map(c => cardRateFor(c, cat)));
        }
        const fmtRate = r => String(Number(Number(r).toFixed(2)));

        function getDefaultCardId() {
            const dbDefault = cards.find(c => c.isDefault);
            if (dbDefault) return String(dbDefault.id);
            try { return localStorage.getItem('cb_default_card_id') || ''; } catch (e) { return ''; }
        }
        // "Default" = the card pre-selected when you add a new transaction (synced to Supabase when the is_default column exists).
        function setDefaultCard(id) {
            const card = cards.find(c => String(c.id) === String(id));
            if (!card) return;
            try { localStorage.setItem('cb_default_card_id', String(card.id)); } catch (e) { /* private mode */ }
            cards.forEach(c => { c.isDefault = String(c.id) === String(card.id); });
            if (_supabase && currentUserId) {
                (async () => {
                    const clear = await _supabase.from('cards').update({ is_default: false }).eq('user_id', currentUserId);
                    if (clear.error) {
                        console.warn('Could not sync default card:', clear.error.message);
                        showToast('Default card saved on this device only. Run cards_full_details.sql in Supabase to sync it.', { tone: 'error', duration: 8000 });
                        return;
                    }
                    await _supabase.from('cards').update({ is_default: true }).eq('id', String(card.id));
                })();
            }
            showToast(`${card.name} is now your default card for new transactions.`, { tone: 'success' });
            recommendBestCard();
        }

        function renderRecommendationCategoryPills() {
            const pills = document.getElementById('rec-category-pills');
            const select = document.getElementById('rec-category');
            if (!pills || !select) return;
            const selected = select.value || RATE_CATEGORIES[0];
            pills.innerHTML = RATE_CATEGORIES.map(category => {
                const encoded = encodeURIComponent(category);
                const active = category === selected;
                const best = bestRateForCategory(category);
                return `<button type="button" onclick="setRecommendationCategory(decodeURIComponent('${encoded}'))" class="rec-pill ${active ? 'active' : ''}">${recIconFor(category)}<span>${escapeHtml(category)}${best === null ? '' : ` (${fmtRate(best)}%)`}</span></button>`;
            }).join('');
        }

        function setRecommendationCategory(category) {
            const select = document.getElementById('rec-category');
            if (!select) return;
            select.value = category;
            renderRecommendationCategoryPills();
            recommendBestCard();
        }

        // ---- AUTH GATE ----
        // With Row Level Security enabled on 'cards' and 'transactions' (see the
        // accompanying SQL), each signed-in user can only read/write rows where
        // user_id = auth.uid(). Nothing loads from Supabase until a session exists.
        // Credit / debit switch in the card form: debit cards have a balance instead of a limit and no statement/payment day.
        function toggleCardType() {
            const debit = (document.querySelector('input[name="card-type"]:checked') || {}).value === 'debit';
            const label = document.getElementById('card-limit-label');
            const input = document.getElementById('card-limit');
            const dates = document.getElementById('card-dates-field');
            if (label) label.textContent = debit ? 'Current Balance' : 'Available Limit';
            if (input) input.placeholder = debit ? 'e.g., 5000 (balance in the account today)' : 'e.g., 15000';
            if (dates) dates.classList.toggle('hidden', debit);
            // Debit cards have no fees or cashback: hide those sections and disable their inputs
            // (disabled inputs are skipped by form validation, so hidden 'required' fields can't block saving).
            ['card-rules-section', 'card-rates-section'].forEach(id => {
                const section = document.getElementById(id);
                if (!section) return;
                section.style.display = debit ? 'none' : '';
                section.querySelectorAll('input, select, textarea, button').forEach(el => {
                    if (debit) {
                        if (!el.disabled) { el.disabled = true; el.dataset.ddDebitOff = '1'; }
                    } else if (el.dataset.ddDebitOff) {
                        el.disabled = false; delete el.dataset.ddDebitOff;
                    }
                });
            });
        }
        // In the transaction form, 'Repaid' reads as 'Deposit / top-up' while a debit card is selected (stored value stays 'Repaid').
        function syncRepaidLabel() {
            const sel = document.getElementById('exp-card');
            const opt = document.querySelector('#exp-type option[value="Repaid"]');
            if (!sel || !opt) return;
            const debit = isDebit(cards.find(c => String(c.id) === String(sel.value)));
            opt.textContent = debit ? 'Deposit / top-up' : 'Repaid';
            const row = document.getElementById('exp-fee-cashback-row');
            if (row) {
                row.style.display = debit ? 'none' : '';
                if (debit) {
                    document.getElementById('exp-service').value = '';
                    document.getElementById('exp-cashback').value = '0.00';
                }
            }
        }
        ['exp-card'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', syncRepaidLabel);
        });
        ['mousedown', 'touchstart', 'focus'].forEach(ev => { const el = document.getElementById('exp-type'); if (el) el.addEventListener(ev, syncRepaidLabel); });

        function openCardModal() {
            if (!document.getElementById('editing-card-id').value) {
                const credit = document.querySelector('input[name="card-type"][value="credit"]');
                if (credit) credit.checked = true;
                toggleCardType();
                renderRateInputs({}, '', {});
                ddFillRulesForm(null);
            }
            document.getElementById('card-modal').classList.remove('hidden');
            setTimeout(() => document.getElementById('card-name').focus(), 50);
        }

        function onTopSearch(value) {
            const inp = document.getElementById('tx-search-input');
            if (inp) inp.value = value;
            setSearchQuery(value);
        }

        // Sidebar / top-bar readouts that summarise the same data the panels show.
        // Show all EMI purchases, partitioned by whether installments remain.
        function renderEmiSection() {
            const wrap = document.getElementById('emi-section');
            const list = document.getElementById('emi-list');
            if (!wrap || !list) return;
            const plans = transactions.filter(t =>
                !hiddenTxIds.has(t.id) && t.type === 'Purchase' && Number(t.emiTotalMonths) > 0
            );
            if (!plans.length) { wrap.classList.add('hidden'); list.innerHTML = ''; return; }
            wrap.classList.remove('hidden');
            const countEl = document.getElementById('emi-count');
            const getProgress = t => {
                const total = Number(t.emiTotalMonths) || 0;
                const paid = Math.min(Number(t.emiPaidMonths) || 0, total);
                const remaining = t.emiRemainingMonths === null || t.emiRemainingMonths === undefined
                    ? Math.max(total - paid, 0)
                    : Math.max(Number(t.emiRemainingMonths) || 0, 0);
                return { total, paid, remaining, active: remaining > 0 };
            };
            const activePlans = plans.filter(t => getProgress(t).active);
            const expiredPlans = plans.filter(t => !getProgress(t).active);
            if (countEl) countEl.textContent = `${activePlans.length} active · ${expiredPlans.length} expired`;
            const planLabel = t => t.emiChargeType === 'fee' ? 'Processing fee' : t.emiChargeType === 'interest' ? 'Interest plan' : '0% APR plan';
            const renderPlan = t => {
                const { total, paid, remaining, active } = getProgress(t);
                const width = total ? Math.min(100, Math.round((paid / total) * 100)) : 0;
                const card = cards.find(c => c.id === t.cardId);
                const name = (t.description || t.desc || t.category || 'Installment plan');
                return `
                    <div class="emi-card ${active ? '' : 'expired'}">
                        <div class="flex items-center justify-between gap-2">
                            <span class="emi-eyebrow">${escapeHtml(planLabel(t))}</span>
                            <span class="emi-status ${active ? 'active' : 'expired'}">${active ? 'Active' : 'Completed'}</span>
                        </div>
                        <p class="emi-name">${escapeHtml(name)}</p>
                        <p class="emi-sub">${active
                            ? `AED ${formatAED(Number(t.emiMonthlyAmount) || 0)}/mo · ${remaining} of ${total} payments left`
                            : `${total} payments completed · AED ${formatAED(Number(t.emiMonthlyAmount) || 0)}/mo`}</p>
                        <div class="emi-track"><div class="emi-fill" style="width:${width}%"></div></div>
                        <div class="flex items-center justify-between gap-2 mt-2.5">
                            <span class="emi-card-name">${card ? escapeHtml(card.name) : '&nbsp;'}</span>
                            ${active ? `<button type="button" class="emi-log" onclick="logEmiInstallment('${t.id}')">Log payment</button>` : '<span class="emi-card-name">Paid in full</span>'}
                        </div>
                    </div>`;
            };
            list.innerHTML = `
                ${activePlans.length ? `<div class="emi-group"><h4 class="emi-group-title">Active <span class="emi-status active">${activePlans.length}</span></h4></div>${activePlans.map(renderPlan).join('')}` : ''}
                ${expiredPlans.length ? `<div class="emi-group"><h4 class="emi-group-title">Expired <span class="emi-status expired">${expiredPlans.length}</span></h4></div>${expiredPlans.map(renderPlan).join('')}` : ''}`;
        }

        function updateShellWidgets(outstanding, pending) {
            renderEmiSection();
            const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
            set('pill-outstanding', formatAED(outstanding));
            set('pill-pending', formatAED(pending));
            const activeCount = activeCards().length, offCount = cards.length - activeCount;
            set('deck-subtitle', `Real-time yield optimization across ${activeCount} registered card${activeCount === 1 ? '' : 's'}${offCount ? ` (${offCount} disabled)` : ''}`);
            set('sync-badge', _supabase ? 'LIVE SYNC' : 'LOCAL MODE');
            const now = new Date();
            const year = String(now.getFullYear());
            const currentMonth = `${year}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            let cb = 0, spend = 0;
            let mtdCb = 0, mtdSpend = 0;
            transactions.forEach(t => {
                if (hiddenTxIds.has(t.id) || !(t.date || '').startsWith(year)) return;
                const cashback = parseFloat(t.cashback) || 0;
                const amount = parseFloat(t.amount) || 0;
                cb += cashback;
                if (txKind(t.type) === 'Purchase' || txKind(t.type) === 'Cash Withdrawal') spend += amount;
                if ((t.date || '').startsWith(currentMonth)) {
                    mtdCb += cashback;
                    if (txKind(t.type) === 'Purchase' || txKind(t.type) === 'Cash Withdrawal') mtdSpend += amount;
                }
            });
            const ret = spend > 0 ? (cb / spend) * 100 : 0;
            const mtdRet = mtdSpend > 0 ? (mtdCb / mtdSpend) * 100 : 0;
            set('ytd-cashback', formatAED(cb));
            set('ytd-return', `+${ret.toFixed(2)}% RET`);
            set('mtd-cashback', formatAED(mtdCb));
            set('mtd-return', `+${mtdRet.toFixed(2)}% RET`);
            const bar = document.getElementById('ytd-bar');
            if (bar) bar.style.width = Math.min(100, (ret / 5) * 100) + '%';
            const mtdBar = document.getElementById('mtd-bar');
            if (mtdBar) mtdBar.style.width = Math.min(100, (mtdRet / 5) * 100) + '%';
        }

        function toggleHeaderMenu() {
            const dropdown = document.getElementById('header-menu-dropdown');
            const opening = dropdown.classList.contains('hidden');
            dropdown.classList.toggle('hidden');
            if (opening) dropdown.scrollTop = 0;
        }
        // Close the header dropdown on an outside click, without swallowing the click
        // that just opened it (that one is handled by toggleHeaderMenu itself).
        document.addEventListener('click', (e) => {
            const dropdown = document.getElementById('header-menu-dropdown');
            const btn = document.getElementById('header-menu-btn');
            if (!dropdown || dropdown.classList.contains('hidden')) return;
            if (!dropdown.contains(e.target) && !btn.contains(e.target)) {
                dropdown.classList.add('hidden');
            }
        });

        function hideLoadingOverlay() {
            const overlay = document.getElementById('app-loading-overlay');
            if (overlay) { overlay.classList.add('hidden'); overlay.style.display = 'none'; }
        }

        async function boot() {
            if (!_supabase) {
                // No Supabase configured -> fall back to plain localStorage, no auth needed.
                await initData();
                hideLoadingOverlay();
                return;
            }

            let session = null;
            if (!navigator.onLine) {
                session = DDO.cachedSession(); // offline: never wait on a token refresh
            } else {
                try { ({ data: { session } } = await _supabase.auth.getSession()); } catch (e) { console.warn('getSession failed:', e); }
            }
            await new Promise(r => setTimeout(r, 0)); // let the early recovery listener run
            if (recoveryPending && session) {
                // Opened from a password-reset email: ask for a new password instead of entering the app.
                hideLoadingOverlay();
                document.getElementById('auth-gate').classList.remove('hidden');
                setAuthMode('recovery');
                history.replaceState(null, '', window.location.pathname + window.location.search);
            } else if (session) {
                await onSignedIn(session);
            } else {
                hideLoadingOverlay();
                document.getElementById('auth-gate').classList.remove('hidden');
                if (authLinkError) {
                    setAuthMode('forgot');
                    showAuthMessage(authLinkError, 'error');
                    history.replaceState(null, '', window.location.pathname + window.location.search);
                }
            }

            _supabase.auth.onAuthStateChange((event, session) => {
                // Subscribing fires once immediately with whatever the CURRENT session already
                // is — since we just handled that exact session above via getSession(), skip it
                // here or every page load re-runs onSignedIn (and its initData() fetch) twice.
                if (event === 'PASSWORD_RECOVERY') {
                    recoveryPending = true;
                    hideLoadingOverlay();
                    document.getElementById('auth-gate').classList.remove('hidden');
                    setAuthMode('recovery');
                } else if (event === 'SIGNED_IN' && session && !recoveryPending && session.user.id !== currentUserId) {
                    onSignedIn(session);
                } else if (event === 'SIGNED_OUT') {
                    location.reload();
                }
            });
        }

        async function onSignedIn(session) {
            currentUserId = session.user.id;
            document.getElementById('auth-gate').classList.add('hidden');
            document.getElementById('sign-out-btn').classList.remove('hidden');
            document.getElementById('change-pw-btn').classList.remove('hidden');
            const label = document.getElementById('user-email-label');
            const email = session.user.email || '';
            label.textContent = email.split('@')[0]; // show just the username part, not the full address
            label.title = email; // full email still available on hover
            label.classList.remove('hidden');
            let username = ((session.user.user_metadata && session.user.user_metadata.username) || '').trim();
            try {
                const { data: prof } = await _supabase.from('profiles').select('username').eq('user_id', session.user.id).maybeSingle();
                if (prof && prof.username) username = prof.username;
            } catch (e) { console.warn('Could not load username:', e); }
            currentUsername = username;
            if (username) { label.textContent = username; }
            const nameEl = document.getElementById('user-name-label'); if (nameEl) nameEl.textContent = username || email.split('@')[0] || 'Account';
            const avEl = document.getElementById('user-avatar'); if (avEl) avEl.textContent = ((username || email)[0] || 'U').toUpperCase();
            const subEl = document.getElementById('user-sub-label'); if (subEl) subEl.textContent = 'Signed in';
            await initData();
            hideLoadingOverlay();
            await ddLoadFromDB();
            try { checkDueNotifications(); } catch (e) { console.warn(e); }
            try { await spInit(); } catch (e) { console.warn('Support chat init:', e); }
        }

        // ---- FORGOT / RESET PASSWORD ----
        // authMode: 'signin' | 'forgot' (request reset email) | 'recovery' (set new password after clicking the email link)
        let authMode = 'signin';

        function showAuthMessage(text, type) {
            const err = document.getElementById('auth-error');
            const info = document.getElementById('auth-info');
            err.classList.add('hidden');
            info.classList.add('hidden');
            if (!text) return;
            const el = type === 'info' ? info : err;
            el.textContent = text;
            el.classList.remove('hidden');
        }

        function setAuthMode(mode) {
            authMode = mode;
            const show = (id, on) => document.getElementById(id).classList.toggle('hidden', !on);
            show('auth-email-wrap', mode !== 'recovery');
            show('auth-password-wrap', mode === 'signin');
            show('auth-recovery-fields', mode === 'recovery');
            show('auth-actions-signin', mode === 'signin');
            show('auth-actions-forgot', mode === 'forgot');
            show('auth-actions-recovery', mode === 'recovery');

            // Hidden required fields would block form submission, so only require what is visible.
            document.getElementById('auth-email').required = mode !== 'recovery';
            document.getElementById('auth-password').required = mode === 'signin';
            document.getElementById('auth-new-password').required = mode === 'recovery';
            document.getElementById('auth-confirm-password').required = mode === 'recovery';

            const titles = {
                signin: ['Sign in to your Cashback Tracker', 'Your cards and transactions are private to your account.'],
                forgot: ['Reset your password', "Enter your account email or username and we'll send a link to the account email to set a new password."],
                recovery: ['Set a new password', 'Choose a new password for your account.']
            };
            document.getElementById('auth-title').textContent = titles[mode][0];
            document.getElementById('auth-subtitle').textContent = titles[mode][1];
            showAuthMessage('');
        }

        document.getElementById('auth-forgot-link').addEventListener('click', () => setAuthMode('forgot'));
        document.getElementById('auth-back-btn').addEventListener('click', () => setAuthMode('signin'));

        document.getElementById('auth-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            if (authMode === 'forgot') await handleForgotPassword();
            else if (authMode === 'recovery') await handleUpdatePassword();
            else await handleAuth('signin');
        });

        async function handleForgotPassword() {
            const identifier = document.getElementById('auth-email').value.trim();
            const btn = document.getElementById('auth-reset-btn');
            if (!identifier) { showAuthMessage('Please enter your email or username.', 'error'); return; }
            showAuthMessage('');
            btn.disabled = true;
            // The reset email links back to this page. This exact URL must be listed under
            // Supabase > Authentication > URL Configuration > Redirect URLs.
            const redirectTo = window.location.origin + window.location.pathname;
            const email = await resolveLoginEmail(identifier);
            let error = null;
            if (email) ({ error } = await _supabase.auth.resetPasswordForEmail(email, { redirectTo }));
            btn.disabled = false;
            if (error) { showAuthMessage(error.message, 'error'); return; }
            // Same message whether or not the account exists, so accounts can't be probed.
            showAuthMessage('If an account exists for that email or username, a password reset link has been sent to the account email. Check your inbox (and spam folder).', 'info');
        }

        async function handleUpdatePassword() {
            const pw = document.getElementById('auth-new-password').value;
            const pw2 = document.getElementById('auth-confirm-password').value;
            const btn = document.getElementById('auth-update-btn');
            if (pw.length < 6) { showAuthMessage('Password must be at least 6 characters.', 'error'); return; }
            if (pw !== pw2) { showAuthMessage('Passwords do not match.', 'error'); return; }
            showAuthMessage('');
            btn.disabled = true;
            const { error } = await _supabase.auth.updateUser({ password: pw });
            btn.disabled = false;
            if (error) { showAuthMessage(error.message, 'error'); return; }

            recoveryPending = false;
            document.getElementById('auth-new-password').value = '';
            document.getElementById('auth-confirm-password').value = '';
            const { data: { session } } = await _supabase.auth.getSession();
            if (session) {
                await onSignedIn(session); // already authenticated by the reset link — go straight into the app
            } else {
                setAuthMode('signin');
                showAuthMessage('Password updated. Please sign in with your new password.', 'info');
            }
        }
        document.getElementById('auth-signup-btn').addEventListener('click', openSignup);

        // ---- CREATE ACCOUNT POPUP ----
        const suEl = id => document.getElementById(id);
        let suUserOk = null, suUserTimer = null, suUserSeq = 0;
        const SU_USERNAME_RE = /^[a-z0-9_.]{3,20}$/;
        function suUserStatus(text, tone) {
            const el = suEl('su-user-status'); el.textContent = text;
            el.style.color = tone === 'ok' ? '#059669' : tone === 'bad' ? '#dc2626' : '#64748b';
        }
        function suCheckUsername() {
            const raw = suEl('su-username').value.trim().toLowerCase();
            clearTimeout(suUserTimer); suUserOk = null;
            if (!raw) { suUserStatus('3–20 characters: letters, numbers, dot or underscore. You can sign in with it instead of your email.'); return; }
            if (!SU_USERNAME_RE.test(raw)) { suUserStatus(raw.length < 3 ? 'Too short — use at least 3 characters.' : 'Only letters, numbers, dot and underscore are allowed (max 20).', 'bad'); return; }
            suUserStatus('Checking availability…');
            const seq = ++suUserSeq;
            suUserTimer = setTimeout(async () => {
                const { data, error } = await _supabase.rpc('username_available', { p_username: raw });
                if (seq !== suUserSeq) return;
                if (error) { suUserOk = null; suUserStatus('Could not check availability right now — it will be checked when you create the account.'); return; }
                suUserOk = !!data;
                suUserStatus(data ? `“${raw}” is available` : `“${raw}” is already taken`, data ? 'ok' : 'bad');
            }, 350);
        }
        function suMessage(t) { const e = suEl('su-error'); e.textContent = t || ''; e.classList.toggle('hidden', !t); }
        function openSignup() {
            suEl('signup-form').reset();
            suEl('signup-form').classList.remove('hidden');
            suEl('signup-success').classList.add('hidden');
            const typed = suEl('auth-email').value.trim();
            suEl('su-email').value = typed.includes('@') ? typed : '';
            suEl('su-username').value = (!typed.includes('@') && /^[A-Za-z0-9_.]{3,20}$/.test(typed)) ? typed.toLowerCase() : '';
            suUserOk = null; suCheckUsername();
            suEl('su-password').type = 'password';
            suMessage(''); suStrength('');
            suEl('signup-modal').classList.remove('hidden');
            setTimeout(() => suEl('su-username').focus(), 60);
        }
        function closeSignup() {
            suEl('signup-modal').classList.add('hidden');
            const em = suEl('su-email').value.trim();
            if (em) suEl('auth-email').value = em;
            suEl('auth-password').value = '';
            suEl('auth-email').focus();
        }
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && !suEl('signup-modal').classList.contains('hidden')) closeSignup(); });
        function suToggle(id, btn) {
            const i = suEl(id), show = i.type === 'password';
            i.type = show ? 'text' : 'password'; btn.textContent = show ? 'Hide' : 'Show';
        }
        function suScore(pw) {
            return (pw.length >= 8 ? 1 : 0) + (/[a-z]/.test(pw) && /[A-Z]/.test(pw) ? 1 : 0) + (/\d/.test(pw) ? 1 : 0) + (/[^A-Za-z0-9]/.test(pw) ? 1 : 0);
        }
        function suStrength(pw) {
            const meter = suEl('su-meter');
            if (!pw) { meter.classList.add('hidden'); return; }
            meter.classList.remove('hidden');
            const sc = pw.length < 8 ? Math.min(1, suScore(pw)) : suScore(pw);
            const colors = ['#ef4444', '#f59e0b', '#84cc16', '#10b981'], labels = ['Too weak', 'Weak', 'Fair', 'Good', 'Strong'];
            const idx = Math.max(0, sc - 1);
            meter.querySelectorAll('.su-seg').forEach((seg, i) => { seg.style.background = i < sc ? colors[idx] : 'rgba(148,163,184,.35)'; });
            suEl('su-meter-label').textContent = pw.length < 8 ? 'Too short — use at least 8 characters' : labels[sc];
        }
        suEl('signup-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = suEl('su-username').value.trim().toLowerCase(), email = suEl('su-email').value.trim();
            const pw = suEl('su-password').value, pw2 = suEl('su-confirm').value;
            if (!SU_USERNAME_RE.test(username)) { suMessage('Choose a username of 3–20 characters using letters, numbers, dot or underscore.'); suEl('su-username').focus(); return; }
            if (suUserOk === false) { suMessage('That username is already taken. Please choose another.'); suEl('su-username').focus(); return; }
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { suMessage('Please enter a valid email address.'); suEl('su-email').focus(); return; }
            if (pw.length < 8) { suMessage('Password must be at least 8 characters.'); suEl('su-password').focus(); return; }
            if (pw !== pw2) { suMessage('Passwords do not match.'); suEl('su-confirm').focus(); return; }
            suMessage('');
            const btn = suEl('su-submit'); btn.disabled = true; btn.textContent = 'Creating account…';
            const options = { data: { username } };
            if (/^https?:/.test(location.protocol)) options.emailRedirectTo = location.origin + location.pathname;
            const { data, error } = await _supabase.auth.signUp({ email, password: pw, options });
            btn.disabled = false; btn.textContent = 'Create Account';
            if (error) {
                suMessage(/database error|duplicate|unique/i.test(error.message) ? 'That username was just taken. Please choose another.' : error.message);
                return;
            }
            // Supabase returns an empty identities list (and no error) when the email is already registered.
            if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
                suMessage('This email is already registered. Close this window and sign in, or use “Forgot password?”.');
                return;
            }
            if (data.session) { suEl('signup-modal').classList.add('hidden'); return; } // confirmations off: signed in already, onAuthStateChange takes over
            suEl('su-sent-email').textContent = email;
            suEl('signup-form').classList.add('hidden');
            suEl('signup-success').classList.remove('hidden');
            suCooldown();
        });
        let suTimer = null;
        function suCooldown() {
            let left = 30; const b = suEl('su-resend'); b.disabled = true; clearInterval(suTimer);
            suTimer = setInterval(() => { left--; if (left <= 0) { clearInterval(suTimer); b.disabled = false; b.textContent = 'Resend email'; } else b.textContent = `Resend in ${left}s`; }, 1000);
            b.textContent = `Resend in ${left}s`;
        }
        async function suResend() {
            const email = suEl('su-sent-email').textContent, info = suEl('su-resend-info');
            const { error } = await _supabase.auth.resend({ type: 'signup', email });
            info.textContent = error ? error.message : 'Email sent again — check your inbox and spam folder.';
            info.classList.toggle('text-red-600', !!error); info.classList.toggle('text-emerald-600', !error);
            info.classList.remove('hidden');
            if (!error) suCooldown();
        }

        // Sign-in accepts an email or a username. A username is looked up to its account email first.
        async function resolveLoginEmail(identifier) {
            const id = (identifier || '').trim();
            if (id.includes('@')) return id;
            try {
                const { data, error } = await _supabase.rpc('email_for_username', { p_username: id });
                if (error) { console.warn('username lookup failed:', error.message); return null; }
                return data || null;
            } catch (e) { return null; }
        }
        async function handleAuth(mode) {
            const identifier = document.getElementById('auth-email').value.trim();
            const email = mode === 'signin' ? (await resolveLoginEmail(identifier)) : identifier;
            const password = document.getElementById('auth-password').value;
            const errorEl = document.getElementById('auth-error');
            errorEl.classList.add('hidden');
            document.getElementById('auth-info').classList.add('hidden');

            if (!email) { // unknown username: same wording as a wrong password so usernames can't be probed
                errorEl.textContent = 'Invalid login credentials';
                errorEl.classList.remove('hidden');
                return;
            }
            const { data, error } = mode === 'signup'
                ? await _supabase.auth.signUp({ email, password })
                : await _supabase.auth.signInWithPassword({ email, password });

            if (error) {
                errorEl.textContent = error.message;
                errorEl.classList.remove('hidden');
                return;
            }
            if (mode === 'signup' && !data.session) {
                errorEl.textContent = 'Account created — check your email to confirm, then sign in.';
                errorEl.classList.remove('hidden');
            }
            // onAuthStateChange fires onSignedIn automatically once a session exists.
        }

        // ---- CHANGE PASSWORD (signed-in users; verifies the current password first) ----
        function cpMessage(text, type) {
            const err = document.getElementById('cp-error'), info = document.getElementById('cp-info');
            err.classList.add('hidden'); info.classList.add('hidden');
            if (!text) return;
            const el = type === 'info' ? info : err;
            el.textContent = text; el.classList.remove('hidden');
        }
        function openChangePassword() {
            document.getElementById('header-menu-dropdown').classList.add('hidden');
            document.getElementById('change-pw-form').reset();
            cpMessage('');
            document.getElementById('change-pw-modal').classList.remove('hidden');
            setTimeout(() => document.getElementById('cp-current').focus(), 50);
        }
        function closeChangePassword() {
            document.getElementById('change-pw-modal').classList.add('hidden');
        }
        document.getElementById('change-pw-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const current = document.getElementById('cp-current').value;
            const next = document.getElementById('cp-new').value;
            const confirmPw = document.getElementById('cp-confirm').value;
            const btn = document.getElementById('cp-save-btn');
            if (next.length < 6) { cpMessage('New password must be at least 6 characters.', 'error'); return; }
            if (next !== confirmPw) { cpMessage('New passwords do not match.', 'error'); return; }
            if (next === current) { cpMessage('New password must be different from the current one.', 'error'); return; }
            cpMessage('');
            btn.disabled = true;
            try {
                const { data: { user } } = await _supabase.auth.getUser();
                // Re-verify the current password before allowing the change.
                const { error: verifyError } = await _supabase.auth.signInWithPassword({ email: user.email, password: current });
                if (verifyError) { cpMessage('Current password is incorrect.', 'error'); return; }
                const { error } = await _supabase.auth.updateUser({ password: next });
                if (error) { cpMessage(error.message, 'error'); return; }
                document.getElementById('change-pw-form').reset();
                cpMessage('Password updated successfully.', 'info');
                setTimeout(closeChangePassword, 1500);
            } finally {
                btn.disabled = false;
            }
        });

        async function signOut() {
            await DDO.clearCache();
            if (_supabase) await _supabase.auth.signOut();
        }

        async function initData() {
            try { await DDO.flush(); } catch (e) { console.warn('Offline sync:', e); }
            if (_supabase) {
                const { data: dbCards, error: cardError } = await _supabase.from('cards').select('*');
                const { data: dbTx, error: txError } = await _supabase.from('transactions').select('*');
                
                if (!cardError && dbCards) {
                    const localDisabled = readLocalDisabledIds();
                    const localDebit = readLocalDebitIds();
                    cards = dbCards.map(c => ({
                        id: String(c.id),
                        cardType: (c.card_type === 'debit' || c.card_type === 'credit') ? c.card_type : (localDebit.has(String(c.id)) ? 'debit' : 'credit'),
                        name: c.name,
                        availableLimit: c.available_limit,
                        rates: c.rates || {},
                        cashbackCreditMode: c.cashback_credit_mode || (c.cashback_next_month === false ? 'next_day' : 'monthly'),
                        cashbackCreditDay: c.cashback_credit_day ?? 1,
                        statementDay: c.statement_day ?? null, // present once the statement_day / payment_day columns exist
                        paymentDay: c.payment_day ?? null,
                        colorGradient: c.color_gradient ?? null, // present once the color_gradient column exists
                        network: c.card_network ?? '',            // '', 'none' or visa / mastercard / amex / rupay / diners
                        netVariant: c.card_network_variant ?? '',
                        tier: c.card_tier ?? '',
                        last4: c.card_last4 ?? '',                // last 4 digits only, never the full number
                        isDefault: ('is_default' in c) ? !!c.is_default : false, // default card for new transactions (synced once the is_default column exists)
                        // DB column is the source of truth once it exists; before that, fall back to this device's copy
                        disabled: ('is_disabled' in c && c.is_disabled !== null) ? !!c.is_disabled : localDisabled.has(String(c.id))
                    }));
                } else {
                    cards = []; // new account, or the cards table couldn't be reached — start empty, not with demo cards
                }

                if (!txError && dbTx) {
                    transactions = dbTx.map(t => ({
                        id: String(t.id),
                        date: t.date,
                        cardName: t.card_name,
                        cardId: t.card_id || undefined, // present once the card_id column + SQL migration are applied
                        type: t.type,
                        desc: t.description,
                        category: t.category,
                        amount: t.amount,
                        serviceCharge: t.service_charge,
                        cashback: t.cashback,
                        notes: t.notes,
                        emiTotalMonths: t.emi_total_months ?? null,     // present once the emi_* columns exist
                        emiMonthlyAmount: t.emi_monthly_amount ?? null,
                        emiPaidMonths: t.emi_paid_months ?? null,
                        emiRemainingMonths: t.emi_remaining_months ?? null,
                        emiChargeType: t.emi_charge_type ?? null,
                        emiChargePercentage: t.emi_charge_percentage ?? null,
                        emiChargeAmount: t.emi_charge_amount ?? null,
                        emiFirstMonthAmount: t.emi_first_month_amount ?? null
                    }));
                }
            } else {
                cards = JSON.parse(localStorage.getItem('cb_cards')) || []; // new/local-only account — start empty, no demo cards
                transactions = JSON.parse(localStorage.getItem('cb_transactions')) || [];
            }
            await loadCustomSettings();
            const optionSync = await syncUsedSharedOptions(
                transactions.map(transaction => transaction.category),
                transactions.map(transaction => transaction.type)
            );
            if (_supabase && currentUserId && optionSync.failures > 0) {
                showToast(`${optionSync.failures} category/type option(s) from saved transactions could not be synced to Supabase.`, { tone: 'error', duration: 10000 });
            }
            subscribeSharedOptions();
            populateTransactionTypes();
            renderTypeFilter();
            populateCategorySelects();
            renderRateInputs({});
            renderColorPicker();
            render();
        }

        async function saveData() {
            if (!_supabase) {
                localStorage.setItem('cb_cards', JSON.stringify(cards));
                localStorage.setItem('cb_transactions', JSON.stringify(transactions));
            }
            render();
        }

        let warnedMissingDayColumns = false;
        let warnedMissingColorColumn = false;
        let warnedMissingIdentityColumns = false;
        let warnedMissingDisabledColumn = false;
        let warnedMissingCashbackCreditColumns = false;
        let warnedMissingCardTypeColumn = false;
        async function _saveCardToDBImpl(c) {
            writeLocalDebitIds();
            if (_supabase) {
                const base = {
                    id: String(c.id),
                    name: c.name,
                    available_limit: c.availableLimit,
                    rates: c.rates,
                    user_id: currentUserId
                };
                // onConflict: 'id' is explicit on purpose — without it, Supabase falls back to
                // whatever unique constraint the table actually has (e.g. a unique "name" column),
                // which can silently reroute this into an UPDATE on a DIFFERENT user's row with a
                // matching card name, and RLS correctly (but confusingly) blocks that as a security
                // violation rather than a normal insert.
                const payload = {
                    ...base,
                    statement_day: c.statementDay ?? null,
                    payment_day: c.paymentDay ?? null,
                    color_gradient: c.colorGradient ?? null,
                    card_network: c.network || null,
                    card_network_variant: c.netVariant || null,
                    card_tier: c.tier || null,
                    card_last4: c.last4 || null,
                    card_type: isDebit(c) ? 'debit' : 'credit',
                    is_disabled: !!c.disabled,
                    cashback_credit_mode: cardCashbackMode(c),
                    cashback_credit_day: cardCashbackCreditDay(c)
                };

                // Try the full payload first; if a column doesn't exist yet (migration not run),
                // drop just that group and retry rather than failing the whole save.
                let succeeded = false;
                for (let attempt = 0; attempt < 6; attempt++) {
                    const { error } = await _supabase.from('cards').upsert(payload, { onConflict: 'id' });
                    if (!error) { succeeded = true; break; }

                    const msg = error.message || '';
                    if (/statement_day|payment_day/.test(msg) && 'statement_day' in payload) {
                        delete payload.statement_day;
                        delete payload.payment_day;
                        if (!warnedMissingDayColumns && (c.statementDay || c.paymentDay)) {
                            warnedMissingDayColumns = true;
                            alert('Card saved, but the statement/payment day could not be stored in Supabase yet.\n\nRun this once in the Supabase SQL editor, then save the card again:\n\n' +
                                  'alter table cards add column if not exists statement_day int check (statement_day between 1 and 31);\n' +
                                  'alter table cards add column if not exists payment_day int check (payment_day between 1 and 31);');
                        }
                        continue;
                    }
                    if (/is_disabled/.test(msg) && 'is_disabled' in payload) {
                        delete payload.is_disabled;
                        if (!warnedMissingDisabledColumn && c.disabled) {
                            warnedMissingDisabledColumn = true;
                            alert('Card disabled on this device, but Supabase has no column to store it yet, so it will not sync to other devices.\n\nRun this once in the Supabase SQL editor, then disable the card again:\n\n' +
                                  'alter table cards add column if not exists is_disabled boolean not null default false;');
                        }
                        continue;
                    }
                    if (/cashback_credit_mode|cashback_credit_day/.test(msg) && 'cashback_credit_mode' in payload) {
                        delete payload.cashback_credit_mode;
                        delete payload.cashback_credit_day;
                        if (!warnedMissingCashbackCreditColumns) {
                            warnedMissingCashbackCreditColumns = true;
                            alert('Card saved, but its cashback credit timing could not be stored in Supabase yet, so it will not sync to other devices.\n\nRun this once in the Supabase SQL editor, then save the card again:\n\n' +
                                  "alter table cards add column if not exists cashback_credit_mode text not null default 'monthly' check (cashback_credit_mode in ('monthly', 'next_day'));\n" +
                                  'alter table cards add column if not exists cashback_credit_day smallint not null default 1 check (cashback_credit_day between 1 and 31);\n\n' +
                                  "do $$ begin if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cards' and column_name = 'cashback_next_month') then execute 'update public.cards set cashback_credit_mode = ''next_day'' where cashback_next_month = false'; end if; end $$;");
                        }
                        continue;
                    }
                    if (/card_type/.test(msg) && 'card_type' in payload) {
                        delete payload.card_type;
                        if (!warnedMissingCardTypeColumn && isDebit(c)) {
                            warnedMissingCardTypeColumn = true;
                            alert('Card saved, but its type (debit) could not be stored in Supabase yet, so it will only be remembered on this device.\n\nRun this once in the Supabase SQL editor, then save the card again:\n\n' +
                                  "alter table cards add column if not exists card_type text not null default 'credit' check (card_type in ('credit', 'debit'));");
                        }
                        continue;
                    }
                    if (/color_gradient/.test(msg) && 'color_gradient' in payload) {
                        delete payload.color_gradient;
                        if (!warnedMissingColorColumn && c.colorGradient) {
                            warnedMissingColorColumn = true;
                            alert('Card saved, but its color could not be stored in Supabase yet.\n\nRun this once in the Supabase SQL editor, then save the card again:\n\n' +
                                  'alter table cards add column if not exists color_gradient text;');
                        }
                        continue;
                    }
                    if (/card_network|card_tier|card_last4/.test(msg) && 'card_tier' in payload) {
                        delete payload.card_network; delete payload.card_network_variant; delete payload.card_tier; delete payload.card_last4;
                        if (!warnedMissingIdentityColumns && (c.network || c.netVariant || c.tier || c.last4)) {
                            warnedMissingIdentityColumns = true;
                            alert('Card saved, but its logo / badge / last-4 could not be stored in Supabase yet.\n\nRun cards_identity.sql once in the Supabase SQL editor, then save the card again.');
                        }
                        continue;
                    }
                    console.error('Saving card failed:', error);
                    showToast(`Save failed on Supabase: ${error.message}`, { tone: 'error', duration: 10000 });
                    break;
                }
                if (!succeeded) { saveData(); return false; }
            }
            saveData();
            return true;
        }

        // If a save for this exact card id is already in flight (a double-click before the
        // button disabled, a duplicate event handler, a retried auth callback — whatever the
        // cause), piggyback on the existing request instead of sending a second one. Two
        // concurrent inserts of the same id is what produced the confusing "duplicate key" /
        // RLS errors chased down earlier — this makes that class of bug impossible outright.
        const cardSaveInFlight = new Map();
        function saveCardToDB(c) {
            const key = String(c.id);
            if (cardSaveInFlight.has(key)) return cardSaveInFlight.get(key);
            const promise = _saveCardToDBImpl(c).finally(() => cardSaveInFlight.delete(key));
            cardSaveInFlight.set(key, promise);
            return promise;
        }

        async function deleteCardFromDB(id) {
            if (_supabase) {
                const { error } = await _supabase.from('cards').delete().eq('id', String(id));
                if (error) {
                    console.error('Deleting card failed:', error);
                    showToast(`Delete failed on Supabase: ${error.message}`, { tone: 'error', duration: 10000 });
                    return false; // don't remove it locally if the DB still has it — they'd look out of sync
                }
            }
            cards = cards.filter(c => c.id !== String(id));
            saveData();
            return true;
        }

        let warnedMissingEmiColumns = false;
        async function _saveTransactionToDBImpl(t) {
            if (_supabase) {
                const payload = {
                    id: String(t.id),
                    date: t.date,
                    card_name: t.cardName,
                    card_id: t.cardId || null,
                    type: t.type,
                    description: t.desc,
                    category: t.category,
                    amount: t.amount,
                    service_charge: t.serviceCharge,
                    cashback: t.cashback,
                    notes: t.notes,
                    emi_total_months: t.emiTotalMonths ?? null,
                    emi_monthly_amount: t.emiMonthlyAmount ?? null,
                    emi_paid_months: t.emiPaidMonths ?? null,
                    emi_remaining_months: t.emiRemainingMonths ?? null,
                    emi_charge_type: t.emiChargeType ?? null,
                    emi_charge_percentage: t.emiChargePercentage ?? null,
                    emi_charge_amount: t.emiChargeAmount ?? null,
                    emi_first_month_amount: t.emiFirstMonthAmount ?? null,
                    user_id: currentUserId
                };

                // Try the full payload first; if Supabase rejects it because a column doesn't
                // exist yet (migration not run), drop just that group of columns and retry
                // rather than failing the whole save.
                let succeeded = false;
                for (let attempt = 0; attempt < 3; attempt++) {
                    const { error } = await _supabase.from('transactions').upsert(payload, { onConflict: 'id' });
                    if (!error) { succeeded = true; break; }

                    const msg = error.message || '';
                    if (/card_id/i.test(msg) && 'card_id' in payload) {
                        delete payload.card_id;
                        continue;
                    }
                    if (/emi_/i.test(msg) && 'emi_total_months' in payload) {
                        delete payload.emi_total_months;
                        delete payload.emi_monthly_amount;
                        delete payload.emi_paid_months;
                        delete payload.emi_remaining_months;
                        delete payload.emi_charge_type;
                        delete payload.emi_charge_percentage;
                        delete payload.emi_charge_amount;
                        delete payload.emi_first_month_amount;
                        if (!warnedMissingEmiColumns && t.emiTotalMonths) {
                            warnedMissingEmiColumns = true;
                            alert('Transaction saved, but the EMI details could not be stored in Supabase yet.\n\nRun this once in the Supabase SQL editor, then save the entry again:\n\n' +
                                  'alter table transactions add column if not exists emi_total_months int;\n' +
                                  'alter table transactions add column if not exists emi_monthly_amount numeric;\n' +
                                  'alter table transactions add column if not exists emi_paid_months int;\n' +
                                  'alter table transactions add column if not exists emi_remaining_months int;\n' +
                                  'alter table transactions add column if not exists emi_charge_type text;\n' +
                                  'alter table transactions add column if not exists emi_charge_percentage numeric;\n' +
                                  'alter table transactions add column if not exists emi_charge_amount numeric;\n' +
                                  'alter table transactions add column if not exists emi_first_month_amount numeric;');
                        }
                        continue;
                    }
                    console.error('Saving transaction failed:', error);
                    showToast(`Save failed on Supabase: ${error.message}`, { tone: 'error', duration: 10000 });
                    break;
                }
                if (!succeeded) { saveData(); return false; }
            }
            saveData();
            return true;
        }

        // Same reasoning as cardSaveInFlight above, for transactions.
        const txSaveInFlight = new Map();
        function saveTransactionToDB(t) {
            const key = String(t.id);
            if (txSaveInFlight.has(key)) return txSaveInFlight.get(key);
            const promise = _saveTransactionToDBImpl(t).finally(() => txSaveInFlight.delete(key));
            txSaveInFlight.set(key, promise);
            return promise;
        }

        async function deleteTransactionFromDB(id) {
            if (_supabase) {
                const { error } = await _supabase.from('transactions').delete().eq('id', String(id));
                if (error) {
                    console.error('Deleting transaction failed:', error);
                    showToast(`Delete failed on Supabase: ${error.message}`, { tone: 'error', duration: 10000 });
                    return false;
                }
            }
            transactions = transactions.filter(t => t.id !== String(id));
            saveData();
            return true;
        }

        async function deleteTransactionsFromDB(ids) {
            const idSet = new Set(ids.map(String));
            if (_supabase) {
                const { error } = await _supabase.from('transactions').delete().in('id', [...idSet]);
                if (error) {
                    console.error('Deleting transactions failed:', error);
                    showToast(`Delete failed on Supabase: ${error.message}`, { tone: 'error', duration: 10000 });
                    return false;
                }
            }
            transactions = transactions.filter(tx => !idSet.has(String(tx.id)));
            saveData();
            return true;
        }

        function calculateDynamicCashback() {
            const type = document.getElementById('exp-type').value;
            const amount = parseFloat(document.getElementById('exp-amount').value) || 0;
            const category = document.getElementById('exp-category').value;
            const cardId = document.getElementById('exp-card').value;
            const cashbackInput = document.getElementById('exp-cashback');

            if (txKind(type) === 'Cashback' || category === 'Cashback' || isDebit(cards.find(c => c.id === cardId))) {
                cashbackInput.value = '0.00';
                return;
            }

            // Force cashback to 0.00 for Repaid entries regardless of category selection
            if (txKind(type) === 'Repaid') {
                cashbackInput.value = '0.00';
                return;
            }

            if (isSpendKind(type)) {
                if (!category) {
                    // "None / Default" — no category means no rate to apply, so no cashback.
                    // Pick an actual category if this purchase should earn something.
                    cashbackInput.value = '0.00';
                    return;
                }
                const selectedCard = cards.find(c => c.id === cardId);
                if (selectedCard && amount > 0) {
                    const rate = selectedCard.rates[category] !== undefined ? selectedCard.rates[category] : (selectedCard.rates['All Other Spend'] || 0);
                    let eligibleSpend = amount;
                    const cardRules = ddRule(selectedCard);
                    if (cardRules.limitCashbackSpendToMonthlyLimit !== false && !isDebit(selectedCard)) {
                        const month = (document.getElementById('exp-date').value || localDateKey()).slice(0, 7);
                        const editingId = document.getElementById('editing-tx-id').value;
                        const monthTx = cardTxList(selectedCard).filter(t => t.id !== editingId && (t.date || '').startsWith(month));
                        const spent = ddSum(monthTx.filter(t => txKind(t.type) === 'Purchase' || txKind(t.type) === 'Cash Withdrawal'), t => t.amount);
                        eligibleSpend = Math.min(amount, Math.max(0, ddNum(selectedCard.availableLimit) - spent));
                    }
                    let cashbackValue = eligibleSpend * (rate / 100);
                    // Enforce the monthly cashback caps configured for this card (category cap and/or "All").
                    const caps = ddCaps(ddRule(selectedCard));
                    const month = (document.getElementById('exp-date').value || localDateKey()).slice(0, 7);
                    const editingId = document.getElementById('editing-tx-id').value;
                    const monthTx = cardTxList(selectedCard).filter(t => t.id !== editingId && (t.date || '').startsWith(month));
                    const capNotes = [];
                    if (eligibleSpend < amount && rate > 0) capNotes.push(`Monthly card-limit cashback allowance reached (AED ${formatAED(Math.max(0, ddNum(selectedCard.availableLimit)))} eligible spend per month)`);
                    [category, 'All'].forEach(k => {
                        if (!(k in caps)) return;
                        const used = ddSum(monthTx.filter(t => k === 'All' || t.category === k), t => t.cashback);
                        const left = Math.max(0, caps[k] - used);
                        if (cashbackValue > left) { cashbackValue = left; capNotes.push(`${k === 'All' ? 'Overall monthly' : k} cap AED ${formatAED(caps[k])} reached (AED ${formatAED(used)} earned this month)`); }
                    });
                    cashbackInput.value = Math.max(0, cashbackValue).toFixed(2);
                    cashbackInput.title = capNotes.join('; ');
                    if (capNotes.length && cashbackInput.dataset.capNote !== capNotes.join('|')) showToast('Cashback limited: ' + capNotes.join('; '), { duration: 5000 });
                    cashbackInput.dataset.capNote = capNotes.join('|');
                }
            }
        }

        document.querySelectorAll('input[name="entry-kind"]').forEach(input => {
            input.addEventListener('change', event => setTransactionEntryKind(event.target.value));
        });
        document.getElementById('exp-transfer-source').addEventListener('change', () => {
            populateTransferCardSelects(
                document.getElementById('exp-transfer-source').value,
                document.getElementById('exp-transfer-destination').value,
                !!document.getElementById('editing-tx-id').value
            );
        });
        ['exp-amount', 'exp-category', 'exp-card', 'exp-date'].forEach(id => {
            document.getElementById(id).addEventListener('input', calculateDynamicCashback);
            document.getElementById(id).addEventListener('change', calculateDynamicCashback);
        });
        document.getElementById('exp-type').addEventListener('change', event => {
            if (event.target.value === '__add_new_type__') openTransactionSettings('type');
            else event.target.dataset.previousValue = event.target.value;
        });
        document.getElementById('exp-category').addEventListener('change', event => {
            if (event.target.value === '__add_new_category__') {
                openTransactionSettings('category');
                return;
            }
            event.target.dataset.previousValue = event.target.value;
            if (event.target.value === 'Cashback' && document.getElementById('exp-type').value !== 'Cashback') {
                if (transactionEntryKind !== 'income') setTransactionEntryKind('income');
                document.getElementById('exp-type').value = 'Cashback';
                syncCategoryState('Cashback');
            }
            updateImmediateCashbackNote();
        });
        ['exp-type', 'exp-category'].forEach(id => {
            document.getElementById(id).addEventListener('focus', event => {
                if (!event.target.value.startsWith('__add_new_')) {
                    event.target.dataset.previousValue = event.target.value;
                }
            });
        });

        function openTxModal(prefillLast = true) {
            document.getElementById('tx-modal').classList.remove('hidden');
            if (prefillLast) document.getElementById('tx-form-subtitle').textContent = 'Record a purchase, payment, or reward';
            const dateField = document.getElementById('exp-date');
            if (!dateField.value) {
                dateField.value = new Date().toISOString().slice(0, 10);
            }

            // For a genuinely new entry (not editing/duplicating), preselect the last-used card.
            if (prefillLast) {
                try {
                    const lastCardId = localStorage.getItem('lastUsedCardId');
                    const cardSelect = document.getElementById('exp-card');
                    // the card chosen with "Set as Default" wins; otherwise the last-used card
                    const preferredCardId = [getDefaultCardId(), lastCardId].find(id => id && [...cardSelect.options].some(o => o.value === id));
                    if (preferredCardId) {
                        cardSelect.value = preferredCardId;
                    }
                } catch (err) { /* localStorage may be unavailable (e.g. private mode) — safe to skip */ }
            }

            populateTransactionCategorySelect();
            setTransactionEntryKind(transactionEntryKind);
            syncRepaidLabel();
            calculateDynamicCashback();
            // Description is the next thing that needs typing (date/type/card already have
            // sensible defaults), so put the cursor there.
            setTimeout(() => document.getElementById('exp-desc').focus(), 50);
        }

        function closeTxModal() {
            document.getElementById('tx-modal').classList.add('hidden');
            cancelEditTransaction();
        }

        function cancelEditTransaction() {
            document.getElementById('editing-tx-id').value = "";
            document.getElementById('editing-transfer-peer-id').value = "";
            document.getElementById('expense-form').reset();
            setTransactionEntryKind('');
            document.getElementById('exp-form-title').innerHTML = `<span>➕</span> Log New Transaction`;
            document.getElementById('tx-form-subtitle').textContent = 'Record a purchase, payment, or reward';
            document.getElementById('tx-submit-btn').textContent = "Log Entry";
            document.getElementById('exp-emi-details').classList.add('hidden');
            document.getElementById('exp-emi-custom-wrapper').classList.add('hidden');
            document.getElementById('exp-emi-charge-input-wrapper').classList.add('hidden');
            document.getElementById('exp-emi-preview').textContent = '';
            populateTransactionCategorySelect('');
            syncCategoryState(document.getElementById('exp-type').value);
        }

        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeTxModal();
                if (!document.getElementById('card-modal').classList.contains('hidden')) cancelEditCard();
            }
        });

        function syncCategoryState(typeVal) {
            const catSelect = document.getElementById('exp-category');
            // Enable category dropdown for Repaid transactions as well
            catSelect.disabled = false;
            catSelect.classList.remove('bg-slate-100', 'dark:bg-slate-700', 'cursor-not-allowed');

            // A pure Cashback entry (the bank crediting cashback with nothing purchased that
            // day) has no spend amount of its own, so don't force one to be entered.
            const amountInput = document.getElementById('exp-amount');
            const amountLabel = document.getElementById('exp-amount-label');
            if (txKind(typeVal) === 'Cashback') {
                amountInput.required = false;
                amountInput.min = '0';
                amountInput.placeholder = '0.00 (optional)';
                if (amountLabel) amountLabel.textContent = 'Amount (optional)';
            } else {
                amountInput.required = true;
                amountInput.min = '0.01';
                amountInput.placeholder = '0.00';
                if (amountLabel) amountLabel.textContent = 'Amount';
            }

            // EMI conversion only makes sense for a Purchase. Switching away from Purchase
            // hides and clears it so a stray EMI plan can't attach itself to the wrong type.
            const emiWrapper = document.getElementById('exp-emi-wrapper');
            if (typeVal === 'Purchase') {
                emiWrapper.classList.remove('hidden');
            } else {
                emiWrapper.classList.add('hidden');
                document.getElementById('exp-is-emi').checked = false;
                document.getElementById('exp-emi-details').classList.add('hidden');
            }

            calculateDynamicCashback();
            updateImmediateCashbackNote();
        }

        function updateImmediateCashbackNote() {
            const isCashback = txKind(document.getElementById('exp-type').value) === 'Cashback' ||
                document.getElementById('exp-category').value === 'Cashback';
            document.getElementById('exp-immediate-cashback-note').classList.toggle('hidden', !isCashback);
        }

        // ---- EMI / INSTALLMENTS ----
        function toggleEmiDetails() {
            const checked = document.getElementById('exp-is-emi').checked;
            document.getElementById('exp-emi-details').classList.toggle('hidden', !checked);
            updateEmiPreview();
        }

        function toggleEmiCustomMonths() {
            const isCustom = document.getElementById('exp-emi-tenure').value === 'custom';
            document.getElementById('exp-emi-custom-wrapper').classList.toggle('hidden', !isCustom);
            updateEmiPreview();
        }

        function getEmiTenureMonths() {
            const tenureSelect = document.getElementById('exp-emi-tenure').value;
            if (tenureSelect === 'custom') {
                const n = parseInt(document.getElementById('exp-emi-custom-months').value, 10);
                return (Number.isInteger(n) && n >= 1) ? n : null;
            }
            const n = parseInt(tenureSelect, 10);
            return (Number.isInteger(n) && n >= 1) ? n : null;
        }

        // ---- EMI CHARGE TYPE HANDLING ----
        function onEmiChargeTypeChange() {
            const chargeType = document.querySelector('input[name="emi-charge-type"]:checked').value;
            const inputWrapper = document.getElementById('exp-emi-charge-input-wrapper');
            const chargeLabel = document.getElementById('exp-emi-charge-label');
            const chargeNote = document.getElementById('exp-emi-charge-note');
            const chargeInput = document.getElementById('exp-emi-charge-percentage');

            if (chargeType === 'none') {
                inputWrapper.classList.add('hidden');
            } else {
                inputWrapper.classList.remove('hidden');
                if (chargeType === 'fee') {
                    chargeLabel.textContent = 'Processing Fee';
                    chargeInput.placeholder = 'e.g., 200';
                    chargeNote.textContent = 'Fixed amount charged on first month\'s payment';
                } else {
                    chargeLabel.textContent = 'Interest Rate (%)';
                    chargeInput.placeholder = 'e.g., 5';
                    chargeNote.textContent = 'Percentage spread evenly across all monthly installments';
                }
            }
            updateEmiPreview();
        }

        function getEmiChargeDetails() {
            const chargeType = document.querySelector('input[name="emi-charge-type"]:checked').value;
            const percentage = parseFloat(document.getElementById('exp-emi-charge-percentage').value) || 0;

            return { chargeType, percentage };
        }

        function calculateEmiWithCharges(principal, months, chargeType, chargeValue) {
            let totalAmount = principal;
            let chargeAmount = 0;
            let monthlyAmount = principal / months;
            let firstMonthAmount = monthlyAmount;
            let monthlyChargeAmount = 0;

            if (chargeType === 'fee' && chargeValue > 0) {
                // Processing fee is a fixed amount added to first month only
                chargeAmount = chargeValue;
                totalAmount = principal + chargeAmount;
                firstMonthAmount = monthlyAmount + chargeAmount; // First month includes fee
                monthlyChargeAmount = 0; // No charge on other months
            } else if (chargeType === 'interest' && chargeValue > 0) {
                // Interest is a percentage spread across all months
                chargeAmount = (principal * chargeValue) / 100;
                monthlyChargeAmount = chargeAmount / months; // Spread interest across all months
                totalAmount = principal + chargeAmount;
                monthlyAmount = (principal / months) + monthlyChargeAmount; // Each month includes interest portion
                firstMonthAmount = monthlyAmount;
            }

            return {
                totalAmount,
                chargeAmount,
                monthlyAmount,      // Amount including charge (for interest) or without charge (for fee)
                firstMonthAmount,    // First month amount (includes fee if processing fee mode)
                monthlyChargeAmount, // Charge portion per month (for interest breakdown)
                remainingMonths: months
            };
        }

        function updateEmiPreview() {
            const preview = document.getElementById('exp-emi-preview');
            if (!preview) return;

            const amount = parseFloat(document.getElementById('exp-amount').value) || 0;
            const months = getEmiTenureMonths();

            if (!document.getElementById('exp-is-emi').checked || amount <= 0 || !months) {
                preview.textContent = '';
                return;
            }

            const { chargeType, percentage } = getEmiChargeDetails();
            const emiCalc = calculateEmiWithCharges(amount, months, chargeType, percentage);

            let previewText = '';

            if (chargeType === 'none') {
                previewText = `≈ AED ${emiCalc.monthlyAmount.toFixed(2)} / month for ${months} months (AED ${amount.toFixed(2)} total). The last installment is adjusted for rounding.`;
            } else if (chargeType === 'fee') {
                // Processing Fee: Show first month with fee + installment, rest without fee
                previewText = `Principal: AED ${amount.toFixed(2)} + Processing Fee: AED ${emiCalc.chargeAmount.toFixed(2)} = AED ${emiCalc.totalAmount.toFixed(2)} total.\n`;
                previewText += `📍 Month 1 (with fee): AED ${emiCalc.firstMonthAmount.toFixed(2)} (AED ${emiCalc.monthlyAmount.toFixed(2)} + AED ${emiCalc.chargeAmount.toFixed(2)} fee)\n`;
                previewText += `Months 2-${months} (without fee): AED ${emiCalc.monthlyAmount.toFixed(2)} each`;
            } else if (chargeType === 'interest') {
                // Interest: Show that each month includes interest portion
                const principalPortion = (amount / months).toFixed(2);
                previewText = `Principal: AED ${amount.toFixed(2)} + Interest (${percentage}%): AED ${emiCalc.chargeAmount.toFixed(2)} = AED ${emiCalc.totalAmount.toFixed(2)} total.\n`;
                previewText += `Each Month: AED ${emiCalc.monthlyAmount.toFixed(2)} (AED ${principalPortion} principal + AED ${emiCalc.monthlyChargeAmount.toFixed(2)} interest) × ${months} months`;
            }

            preview.textContent = previewText;
        }

        document.getElementById('exp-is-emi').addEventListener('change', toggleEmiDetails);
        document.getElementById('exp-emi-tenure').addEventListener('change', toggleEmiCustomMonths);
        document.getElementById('exp-emi-custom-months').addEventListener('input', updateEmiPreview);
        document.getElementById('exp-amount').addEventListener('input', updateEmiPreview);

        // Charge type radio button listeners
        document.querySelectorAll('input[name="emi-charge-type"]').forEach(radio => {
            radio.addEventListener('change', onEmiChargeTypeChange);
        });

        // Percentage input listener
        document.getElementById('exp-emi-charge-percentage').addEventListener('input', updateEmiPreview);

        document.getElementById('exp-type').addEventListener('change', (e) => {
            syncCategoryState(e.target.value);
        });

        function formatExcelDate(excelDate) {
            if (!excelDate) return '';
            if (typeof excelDate === 'number') {
                const dateObj = XLSX.SSF.parse_date_code(excelDate);
                if (dateObj) {
                    const y = dateObj.y;
                    const m = String(dateObj.m).padStart(2, '0');
                    const d = String(dateObj.d).padStart(2, '0');
                    return `${y}-${m}-${d}`;
                }
            }
            return String(excelDate);
        }

        function downloadExcelTemplate() {
            const headers = ['Date', 'Card', 'Type', 'Description', 'Category', 'Amount', 'Service Charge', 'Cashback', 'Notes'];
            const transactionsSheet = XLSX.utils.aoa_to_sheet([headers]);
            transactionsSheet['!cols'] = headers.map(header => ({ wch: Math.max(header.length + 3, 16) }));

            const guideRows = [
                ['Column', 'Required', 'Details'],
                ['Date', 'No', 'Transaction date; use YYYY-MM-DD.'],
                ['Card', 'Yes', 'Card name. Required for every transaction.'],
                ['Type', 'No', 'Purchase, Cash Withdrawal, Repaid, Cashback, or your own type. A new type is added to the app (and database) on import. Defaults to Purchase.'],
                ['Description', 'No', 'Transaction description. The importer also accepts the header Desc.'],
                ['Category', 'No', 'Use any category. A category the app does not have yet is added to the app (and database) on import.'],
                ['Amount', 'Yes', 'Numeric transaction amount. Required for every transaction.'],
                ['Service Charge', 'No', 'Numeric fee; the importer also accepts the header Service Fee.'],
                ['Cashback', 'No', 'Numeric cashback amount. Defaults to zero when blank; Repaid rows always use zero.'],
                ['Notes', 'No', 'Optional notes.'],
                ['', '', 'Import reads the first worksheet (Transactions). Keep the header row unchanged.']
            ];
            const guideSheet = XLSX.utils.aoa_to_sheet(guideRows);
            guideSheet['!cols'] = [{ wch: 20 }, { wch: 12 }, { wch: 92 }];

            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, transactionsSheet, 'Transactions');
            XLSX.utils.book_append_sheet(workbook, guideSheet, 'Field Guide');
            XLSX.writeFile(workbook, 'DueDates-transaction-import-template.xlsx');
        }

        function handleExcelDrop(event) {
            event.preventDefault();
            const input = document.getElementById('excel-file-input');
            const files = event.dataTransfer && event.dataTransfer.files;
            if (!input || !files || !files.length) return;
            input.files = files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }

        // Step 1: choosing (or dropping) a file only SELECTS it. The bottom button switches from
        // "Add Transaction Manually" to "Upload"; nothing is imported until Upload is pressed.
        let pendingImportFile = null;
        let importInProgress = false;

        function formatFileSize(bytes) {
            if (bytes < 1024) return `${bytes} B`;
            if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
            return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        }

        function refreshImportModalUI() {
            const has = !!pendingImportFile;
            const chip = document.getElementById('import-file-chip');
            const uploadBtn = document.getElementById('import-upload-btn');
            const manualBtn = document.getElementById('import-manual-btn');
            if (!chip || !uploadBtn || !manualBtn) return;
            chip.classList.toggle('hidden', !has);
            chip.classList.toggle('flex', has);
            uploadBtn.classList.toggle('hidden', !has);
            uploadBtn.classList.toggle('flex', has);
            manualBtn.classList.toggle('hidden', has);
            if (has) {
                document.getElementById('import-file-name').textContent = pendingImportFile.name;
                document.getElementById('import-file-size').textContent = formatFileSize(pendingImportFile.size);
            }
        }

        function setPendingImportFile(file) {
            if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
                showToast('Please choose an .xlsx, .xls or .csv file.', { tone: 'error' });
                return;
            }
            pendingImportFile = file;
            refreshImportModalUI();
        }

        function clearPendingImportFile() {
            pendingImportFile = null;
            const input = document.getElementById('excel-file-input');
            if (input) input.value = '';
            refreshImportModalUI();
        }

        document.getElementById('excel-file-input').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) setPendingImportFile(file);
        });

        // Step 2: Upload — close the dialog, land on the dashboard, and import in the background.
        function startExcelImport() {
            if (!pendingImportFile || importInProgress) return;
            const file = pendingImportFile;
            clearPendingImportFile();
            closeUtilityModal('import-modal');
            window.scrollTo({ top: 0, behavior: 'smooth' });
            showToast(`Importing ${file.name}…`, { duration: 3000 });
            runExcelImport(file);
        }

        function runExcelImport(file) {
            importInProgress = true;
            const reader = new FileReader();
            reader.onerror = () => {
                importInProgress = false;
                showToast('Could not read that file.', { tone: 'error' });
            };
            reader.onload = async (evt) => {
                const bstr = evt.target.result;
                const workbook = XLSX.read(bstr, { type: 'binary' });
                const firstSheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[firstSheetName];
                const rawData = XLSX.utils.sheet_to_json(worksheet, { defval: '' });

                // Case-insensitive lookups so "dining" / "DINING" reuse the existing "Dining".
                const categoryLookup = new Map([...RATE_CATEGORIES, ...TX_ONLY_CATEGORIES].map(c => [c.toLowerCase(), c]));
                const typeLookup = new Map(TYPE_FILTER_OPTIONS.map(t => [t.toLowerCase(), t]));
                const newCategories = [], newTypes = []; // brand-new names found in this file
                const usedCategories = [], usedTypes = [];
                let imported = 0, skipped = 0, dbFailed = 0;

                for (let i = 0; i < rawData.length; i++) {
                    const row = rawData[i];
                    try {
                        const date = formatExcelDate(row['Date']);
                        const cardName = String(row['Card'] || '').trim();
                        const typeRaw = String(row['Type'] || '').trim().replace(/\s+/g, ' ') || 'Purchase';
                        let type = typeLookup.get(typeRaw.toLowerCase()) || typeRaw;
                        const desc = row['Description'] || row['Desc'] || '';
                        let category = String(row['Category'] || '').trim().replace(/\s+/g, ' ');
                        category = categoryLookup.get(category.toLowerCase()) || category;
                        const amount = parseFloat(row['Amount']);
                        const serviceCharge = parseFloat(row['Service Charge']) || parseFloat(row['Service Fee']) || 0;
                        const cashbackRaw = row['Cashback'];
                        const cashback = (txKind(type) === 'Repaid' || cashbackRaw === '-' || cashbackRaw === '' || cashbackRaw === undefined) ? 0 : parseFloat(cashbackRaw);
                        const notes = row['Notes'] || '';

                        // A row with no card name and no usable amount is not salvageable — skip it
                        // rather than silently recording a zero-amount "Unknown Card" transaction.
                        if (!cardName || isNaN(amount)) {
                            skipped++;
                            continue;
                        }

                        // Only now that the row is known to be valid: remember any new type / category
                        // so it is created in the app and in the shared_options table.
                        if (!typeLookup.has(type.toLowerCase())) {
                            typeLookup.set(type.toLowerCase(), type);
                            newTypes.push(type);
                        }
                        if (category && !categoryLookup.has(category.toLowerCase())) {
                            categoryLookup.set(category.toLowerCase(), category);
                            newCategories.push(category);
                        }
                        if (category) usedCategories.push(category);
                        usedTypes.push(type);

                        let rowFailed = false;
                        let matchedCard = cards.find(c => c.name.trim().toLowerCase() === cardName.toLowerCase());
                        if (!matchedCard) {
                            matchedCard = {
                                id: newId(),
                                name: cardName,
                                availableLimit: 20000,
                                rates: defaultRates(1)
                            };
                            cards.push(matchedCard);
                            if ((await saveCardToDB(matchedCard)) === false) rowFailed = true;
                        }

                        const newTx = {
                            id: newId(),
                            date, cardName, cardId: matchedCard.id, type, desc, category, amount,
                            serviceCharge, cashback, notes
                        };
                        transactions.push(newTx);
                        if ((await saveTransactionToDB(newTx)) === false) rowFailed = true;

                        if (rowFailed) dbFailed++; else imported++;
                    } catch (err) {
                        console.error(`Row ${i + 2} failed to import:`, err);
                        skipped++;
                    }
                }

                // Sync every category/type used by imported rows to shared_options.
                // Existing names are matched case-insensitively, so they are not inserted again.
                const syncResult = await syncUsedSharedOptions(usedCategories, usedTypes);
                const optionsFailed = syncResult.failures;

                let summary = `Imported ${imported} of ${rawData.length} rows.`;
                if (newCategories.length) summary += `\nAdded ${newCategories.length} new categor${newCategories.length === 1 ? 'y' : 'ies'}: ${newCategories.join(', ')}.`;
                if (newTypes.length) summary += `\nAdded ${newTypes.length} new type${newTypes.length === 1 ? '' : 's'}: ${newTypes.join(', ')}.`;
                if (optionsFailed > 0) summary += `\n${optionsFailed} imported categor${optionsFailed === 1 ? 'y/type could' : 'ies/types could'} not be saved to Supabase and remain available on this device only.`;
                if (dbFailed > 0) summary += `\n${dbFailed} row(s) parsed fine but failed to save to Supabase — see the error above.`;
                if (skipped > 0) summary += `\n${skipped} row(s) skipped — missing a Card name or a valid Amount.`;
                showToast(summary, { tone: (dbFailed > 0 || optionsFailed > 0) ? 'error' : 'success', duration: (dbFailed > 0 || optionsFailed > 0) ? 10000 : 6000 });
                importInProgress = false;
                render();
            };
            reader.readAsBinaryString(file);
        }

        function toggleCardCashbackCreditDay() {
            const mode = document.querySelector('input[name="card-cashback-mode"]:checked')?.value || 'monthly';
            const dayInput = document.getElementById('card-cashback-credit-day');
            const enabled = mode === 'monthly';
            dayInput.disabled = !enabled;
            dayInput.required = enabled;
            document.getElementById('card-cashback-credit-day-field').classList.toggle('hidden', !enabled);
        }

        document.getElementById('card-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const editingId = document.getElementById('editing-card-id').value;
            const name = document.getElementById('card-name').value.trim();
            const limitInput = document.getElementById('card-limit');
            const availableLimit = parseFloat(limitInput.value);

            if (!name) { alert('Please enter a card name.'); return; }
            if (isNaN(availableLimit) || availableLimit < 0) {
                alert('Available Limit must be a number of 0 or more.');
                limitInput.focus();
                return;
            }
            if (cards.some(c => c.id !== editingId && c.name.trim().toLowerCase() === name.toLowerCase())) {
                alert('A card with this name already exists. Use a distinct name so transactions link to the right card.');
                return;
            }

            const parseDay = (id) => {
                const raw = document.getElementById(id).value.trim();
                if (raw === '') return null;
                const n = Number(raw);
                return (Number.isInteger(n) && n >= 1 && n <= 31) ? n : NaN;
            };
            const cardType = ((document.querySelector('input[name="card-type"]:checked') || {}).value === 'debit') ? 'debit' : 'credit';
            const statementDay = cardType === 'debit' ? null : parseDay('card-statement-day');
            const paymentDay = cardType === 'debit' ? null : parseDay('card-payment-day');
            if (Number.isNaN(statementDay) || Number.isNaN(paymentDay)) {
                alert('Statement Day and Payment Day must be whole numbers between 1 and 31, or left blank.');
                return;
            }
            const cashbackCreditMode = cardType === 'debit' ? 'monthly' : document.querySelector('input[name="card-cashback-mode"]:checked').value;
            const cashbackCreditDayInput = document.getElementById('card-cashback-credit-day');
            const cashbackCreditDay = cardType === 'debit' ? 1 : Number(cashbackCreditDayInput.value);
            if (cardType !== 'debit' && cashbackCreditMode === 'monthly' &&
                (!Number.isInteger(cashbackCreditDay) || cashbackCreditDay < 1 || cashbackCreditDay > 31)) {
                alert('Cashback credit day must be a whole number between 1 and 31.');
                cashbackCreditDayInput.focus();
                return;
            }

            const rates = cardType === 'debit' ? {} : getCardRatesFromForm();
            const colorGradient = document.getElementById('card-color-gradient').value || null;
            const network = document.getElementById('card-network').value;
            const netVariant = document.getElementById('card-network-variant').value.trim();
            const tier = document.getElementById('card-tier').value.trim();
            const last4 = document.getElementById('card-last4').value.trim();
            if (last4 && !/^\d{4}$/.test(last4)) {
                alert('Last 4 digits must be exactly 4 numbers, or left blank.');
                return;
            }

            let cardObj;
            let renamedTx = [];
            let nameChanged = false;
            if (editingId) {
                const index = cards.findIndex(c => c.id === editingId);
                if (index !== -1) {
                    if (cards[index].name !== name) { nameChanged = true; renamedTx = transactions.filter(t => txBelongsToCard(t, cards[index])); }
                    cards[index].name = name;
                    cards[index].availableLimit = availableLimit;
                    cards[index].cardType = cardType;
                    cards[index].rates = rates;
                    cards[index].cashbackCreditMode = cashbackCreditMode;
                    cards[index].cashbackCreditDay = cashbackCreditDay || 1;
                    delete cards[index].cashbackNextMonth;
                    cards[index].statementDay = statementDay;
                    cards[index].paymentDay = paymentDay;
                    cards[index].colorGradient = colorGradient;
                    Object.assign(cards[index], { network, netVariant, tier, last4 });
                    cardObj = cards[index];
                }
            } else {
                cardObj = {
                    id: newId(), name, availableLimit, cardType, rates,
                    cashbackCreditMode, cashbackCreditDay: cashbackCreditDay || 1,
                    statementDay, paymentDay, colorGradient, network, netVariant, tier, last4
                };
                cards.push(cardObj);
            }

            if (cardObj) {
                const submitBtn = document.getElementById('card-submit-btn');
                const originalLabel = submitBtn.textContent;
                submitBtn.disabled = true;
                submitBtn.innerHTML = `<span class="inline-block w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin align-[-2px] mr-1.5"></span>Saving…`;
                try {
                    const saved = await saveCardToDB(cardObj);
                    if (saved !== false) {
                        // Keep every transaction attached to the renamed card (name + link), and save the change.
                        if (renamedTx.length || nameChanged) {
                            const synced = await renameCardTransactionsInDB(renamedTx, cardObj);
                            showToast(synced
                                ? `Card renamed on Supabase${renamedTx.length ? ' — ' + renamedTx.length + ' transaction(s) updated' : ''}.`
                                : 'Card renamed, but some transactions could not be updated on Supabase. Use "Fix Card Links" to retry.',
                                { tone: synced ? 'success' : 'error', duration: 6000 });
                        }
                        showToast('Card saved.', { tone: 'success', duration: 2500 });
                    }
                } finally {
                    submitBtn.disabled = false;
                    submitBtn.textContent = originalLabel;
                }
            }
            if (cardObj) ddSaveRulesFromForm(cardObj.id);
            cancelEditCard();
            render();
        });

        function editCard(id) {
            const card = cards.find(c => c.id === id);
            if (!card) return;

            document.getElementById('editing-card-id').value = card.id;
            document.getElementById('card-name').value = card.name;
            document.getElementById('card-limit').value = card.availableLimit ?? '';
            const typeRadio = document.querySelector(`input[name="card-type"][value="${isDebit(card) ? 'debit' : 'credit'}"]`);
            if (typeRadio) typeRadio.checked = true;
            toggleCardType();
            document.querySelector(`input[name="card-cashback-mode"][value="${cardCashbackMode(card)}"]`).checked = true;
            document.getElementById('card-cashback-credit-day').value = cardCashbackCreditDay(card);
            toggleCardCashbackCreditDay();
            document.getElementById('card-statement-day').value = card.statementDay ?? '';
            document.getElementById('card-payment-day').value = card.paymentDay ?? '';
            renderRateInputs(card.rates || {}, '', ddCaps(ddRule(card)));
            document.getElementById('card-rates-section').open = Object.values(card.rates || {}).some(v => Number(v) > 0);
            ddFillRulesForm(card);
            setCardColorGradient(card.colorGradient || 'none');
            document.getElementById('card-network').value = card.network || '';
            document.getElementById('card-network-variant').value = card.netVariant || '';
            document.getElementById('card-tier').value = card.tier || '';
            document.getElementById('card-last4').value = card.last4 || '';

            document.getElementById('card-form-title').textContent = 'Edit Card';
            document.getElementById('card-submit-btn').textContent = "Update Card";
            document.getElementById('cancel-edit-btn').classList.remove('hidden');
            openCardModal();
        }

        function cancelEditCard() {
            document.getElementById('editing-card-id').value = "";
            document.getElementById('card-form').reset();
            toggleCardCashbackCreditDay();
            renderRateInputs({}, '', {});
            document.getElementById('card-rates-section').open = true;
            ddFillRulesForm(null);
            setCardColorGradient('none');
            document.getElementById('card-form-title').textContent = 'Add / Manage Cards';
            document.getElementById('card-submit-btn').textContent = "Save Card";
            document.getElementById('cancel-edit-btn').classList.add('hidden');
            document.getElementById('card-modal').classList.add('hidden');
        }

        async function saveTransferFromForm() {
            const sourceId = document.getElementById('exp-transfer-source').value;
            const destinationId = document.getElementById('exp-transfer-destination').value;
            const sourceCard = cards.find(card => String(card.id) === sourceId);
            const destinationCard = cards.find(card => String(card.id) === destinationId);
            const amount = Number(document.getElementById('exp-amount').value);
            const editingOutId = document.getElementById('editing-tx-id').value;
            const editingInId = document.getElementById('editing-transfer-peer-id').value;
            const allowInactive = !!editingOutId && !!editingInId;
            if (!sourceCard || !destinationCard || sourceId === destinationId ||
                (!allowInactive && (!activeCards().includes(sourceCard) || !activeCards().includes(destinationCard)))) {
                showToast('Choose two different active cards for the transfer.', { tone: 'error' });
                return;
            }
            if (!Number.isFinite(amount) || amount <= 0) {
                showToast('Enter a transfer amount above 0.', { tone: 'error' });
                return;
            }

            const previousOut = editingOutId ? transactions.find(tx => tx.id === editingOutId) : null;
            const previousIn = editingInId ? transactions.find(tx => tx.id === editingInId) : null;
            if ((editingOutId && (!previousOut || !previousIn)) ||
                (previousOut && previousOut.type !== TRANSFER_OUT_TYPE) ||
                (previousIn && previousIn.type !== TRANSFER_IN_TYPE)) {
                showToast('This transfer is incomplete and cannot be edited safely.', { tone: 'error' });
                return;
            }

            const balance = debitBalance(sourceCard, localDateKey(), [editingOutId, editingInId]);
            if (amount > balance + 0.005) {
                const proceed = await showConfirm(
                    'Not enough balance',
                    `${sourceCard.name} has AED ${formatAED(balance)} ${isDebit(sourceCard) ? 'available in its balance' : 'available credit'} but this transfer needs AED ${formatAED(amount)}. Save it anyway?`,
                    { confirmLabel: 'Save anyway' }
                );
                if (!proceed) return;
            }

            const groupId = transferGroupId(previousOut || previousIn) || newId();
            const description = document.getElementById('exp-desc').value.trim();
            const date = document.getElementById('exp-date').value;
            const outTx = {
                id: editingOutId || newId(),
                date,
                cardName: sourceCard.name,
                cardId: sourceCard.id,
                type: TRANSFER_OUT_TYPE,
                desc: description,
                category: '',
                amount,
                serviceCharge: 0,
                cashback: 0,
                notes: `${TRANSFER_NOTE_PREFIX}${groupId}`
            };
            const inTx = {
                id: editingInId || newId(),
                date,
                cardName: destinationCard.name,
                cardId: destinationCard.id,
                type: TRANSFER_IN_TYPE,
                desc: description,
                category: '',
                amount,
                serviceCharge: 0,
                cashback: 0,
                notes: `${TRANSFER_NOTE_PREFIX}${groupId}`
            };

            const outIndex = previousOut ? transactions.indexOf(previousOut) : -1;
            const inIndex = previousIn ? transactions.indexOf(previousIn) : -1;
            if (previousOut) transactions[outIndex] = outTx;
            if (previousIn) transactions[inIndex] = inTx;
            if (!previousOut && !previousIn) transactions.unshift(outTx, inTx);
            else if (!previousOut) transactions.unshift(outTx);
            else if (!previousIn) transactions.unshift(inTx);

            const submitBtn = document.getElementById('tx-submit-btn');
            const originalLabel = submitBtn.textContent;
            submitBtn.disabled = true;
            submitBtn.textContent = 'Saving transfer…';
            let outSaved = false;
            let inSaved = false;
            try {
                outSaved = await saveTransactionToDB(outTx);
                if (outSaved === false) throw new Error('The source-card side could not be saved.');
                inSaved = await saveTransactionToDB(inTx);
                if (inSaved === false) throw new Error('The destination-card side could not be saved.');
                try { localStorage.setItem('lastUsedCardId', String(sourceCard.id)); } catch (error) { /* private mode */ }
                showToast(previousOut ? 'Transfer updated.' : 'Transfer logged on both cards.', { tone: 'success' });
                closeTxModal();
            } catch (error) {
                console.error('Saving paired transfer failed:', error);
                if (previousOut && previousIn) {
                    transactions[outIndex] = previousOut;
                    transactions[inIndex] = previousIn;
                    if (outSaved || inSaved) {
                        try {
                            const restoredOut = await saveTransactionToDB(previousOut);
                            const restoredIn = await saveTransactionToDB(previousIn);
                            if (restoredOut === false || restoredIn === false) {
                                showToast('Could not fully restore the previous transfer; check both cards in transaction history.', { tone: 'error', duration: 10000 });
                            }
                        } catch (rollbackError) {
                            console.error('Restoring previous transfer failed:', rollbackError);
                            showToast('Could not fully restore the previous transfer; check both cards in transaction history.', { tone: 'error', duration: 10000 });
                        }
                    }
                } else {
                    transactions = transactions.filter(tx => tx.id !== outTx.id && tx.id !== inTx.id);
                    let rollbackFailed = false;
                    if (outSaved && await deleteTransactionFromDB(outTx.id) === false) rollbackFailed = true;
                    if (inSaved && await deleteTransactionFromDB(inTx.id) === false) rollbackFailed = true;
                    if (rollbackFailed) showToast('The transfer could not be fully rolled back; check both cards in transaction history.', { tone: 'error', duration: 10000 });
                    render();
                }
                showToast(`Transfer was not fully saved: ${error.message || error}`, { tone: 'error', duration: 10000 });
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = originalLabel;
            }
        }

        document.getElementById('expense-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            if (transactionEntryKind === 'transfer') {
                await saveTransferFromForm();
                return;
            }
            if (!['income', 'expense'].includes(transactionEntryKind)) {
                showToast('Choose Income, Expense, or Transfer before logging.', { tone: 'error' });
                return;
            }
            const editingTxId = document.getElementById('editing-tx-id').value;
            const date = document.getElementById('exp-date').value;
            const type = document.getElementById('exp-type').value;
            const desc = document.getElementById('exp-desc').value;
            const amount = parseFloat(document.getElementById('exp-amount').value) || 0;
            const category = document.getElementById('exp-category').value;
            const cardId = document.getElementById('exp-card').value;
            const cardForFees = cards.find(c => c.id === cardId);
            const serviceCharge = isDebit(cardForFees) ? 0 : (parseFloat(document.getElementById('exp-service').value) || 0);
            const cashback = (txKind(type) === 'Repaid' || isDebit(cardForFees)) ? 0 : (parseFloat(document.getElementById('exp-cashback').value) || 0);

            const selectedCard = cards.find(c => c.id === cardId);

            if (isDebit(selectedCard) && isSpendKind(type)) {
                const bal = debitBalance(selectedCard, localDateKey(), editingTxId);
                const needed = amount + (INCLUDE_FEES_IN_OUTSTANDING ? serviceCharge : 0);
                if (needed > bal + 0.005) {
                    const proceed = await showConfirm(
                        'Not enough balance',
                        `${selectedCard.name} has AED ${formatAED(bal)} but this needs AED ${formatAED(needed)}. Save it anyway?`,
                        { confirmLabel: 'Save anyway' }
                    );
                    if (!proceed) return;
                }
            }
            if (selectedCard && !isDebit(selectedCard) && isSpendKind(type)) {
                const maxAllowedSpend = (selectedCard.availableLimit || 0) * 0.97;
                const monthKey = date ? date.substring(0, 7) : new Date().toISOString().substring(0, 7);
                
                const currentMonthCardSpend = transactions
                    .filter(t => t.id !== editingTxId &&
                                 t.cardName.trim().toLowerCase() === selectedCard.name.trim().toLowerCase() && 
                                 t.date && t.date.startsWith(monthKey) && 
                                 (txKind(t.type) === 'Purchase' || txKind(t.type) === 'Cash Withdrawal'))
                    .reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);

                if (currentMonthCardSpend + amount > maxAllowedSpend) {
                    const proceed = await showConfirm(
                        'Over your 97% target limit',
                        `This pushes ${selectedCard.name}'s monthly spend past the 97% target limit (AED ${maxAllowedSpend.toFixed(2)}). Proceed anyway?`,
                        { confirmLabel: 'Proceed' }
                    );
                    if (!proceed) return;
                }
            }

            const existingTx = editingTxId ? transactions.find(t => t.id === editingTxId) : null;

            // EMI: only meaningful on a Purchase. Editing an existing EMI purchase keeps
            // whatever installments were already paid and just recomputes what's left.
            let emiFields = { emiTotalMonths: null, emiMonthlyAmount: null, emiPaidMonths: 0, emiRemainingMonths: null, emiChargeType: null, emiChargePercentage: null, emiChargeAmount: null, emiFirstMonthAmount: null };
            if (type === 'Purchase' && document.getElementById('exp-is-emi').checked) {
                const months = getEmiTenureMonths();
                if (!months) {
                    alert('Enter a valid number of months for the installment plan (or uncheck EMI).');
                    return;
                }
                const paidMonths = (existingTx && existingTx.emiTotalMonths) ? (existingTx.emiPaidMonths || 0) : 0;

                // Get charge details
                const { chargeType, percentage } = getEmiChargeDetails();
                const emiCalc = calculateEmiWithCharges(amount, months, chargeType, percentage);

                emiFields = {
                    emiTotalMonths: months,
                    emiMonthlyAmount: Math.round(emiCalc.monthlyAmount * 100) / 100,
                    emiFirstMonthAmount: Math.round(emiCalc.firstMonthAmount * 100) / 100,
                    emiPaidMonths: Math.min(paidMonths, months),
                    emiRemainingMonths: Math.max(months - paidMonths, 0),
                    emiChargeType: chargeType,
                    emiChargePercentage: percentage,
                    emiChargeAmount: Math.round(emiCalc.chargeAmount * 100) / 100
                };
            }

            const txObj = {
                id: editingTxId || newId(),
                date,
                cardName: selectedCard ? selectedCard.name : 'Unknown',
                cardId: selectedCard ? selectedCard.id : undefined,
                type,
                desc,
                category,
                amount,
                serviceCharge,
                cashback,
                ...emiFields,
                notes: existingTx ? (existingTx.notes || '') : '' // form has no Notes field yet, so preserve what was already there
            };

            if (editingTxId) {
                const idx = transactions.findIndex(t => t.id === editingTxId);
                if (idx !== -1) transactions[idx] = txObj;
            } else {
                transactions.unshift(txObj);
            }

            // Auto-create fee/interest transaction if EMI has charges
            if (!editingTxId && type === 'Purchase' && document.getElementById('exp-is-emi').checked) {
                const { chargeType, percentage } = getEmiChargeDetails();
                if (chargeType !== 'none' && percentage > 0) {
                    const emiCalc = calculateEmiWithCharges(amount, document.getElementById('exp-emi-tenure').value === 'custom'
                        ? parseInt(document.getElementById('exp-emi-custom-months').value)
                        : parseInt(document.getElementById('exp-emi-tenure').value), chargeType, percentage);

                    let feeDesc = '';
                    if (chargeType === 'fee') {
                        feeDesc = `Processing Fee - ${desc}`;
                    } else if (chargeType === 'interest') {
                        feeDesc = `Interest Rate (${percentage}%) - ${desc}`;
                    }

                    // Create automatic fee/interest transaction
                    const feeTransaction = {
                        id: newId(),
                        date: txObj.date,
                        cardName: txObj.cardName,
                        cardId: txObj.cardId,
                        type: 'Purchase',
                        desc: feeDesc,
                        category: 'Service Fee',
                        amount: emiCalc.chargeAmount,
                        serviceCharge: 0,
                        cashback: 0,
                        notes: `Auto-created ${chargeType === 'fee' ? 'processing fee' : 'interest'} for EMI plan`
                    };
                    transactions.unshift(feeTransaction);
                    await saveTransactionToDB(feeTransaction);
                }
            }

            // Remember the last-used card; transaction kind must be chosen for each new entry.
            try {
                localStorage.setItem('lastUsedCardId', txObj.cardId || '');
            } catch (err) { /* localStorage may be unavailable (e.g. private mode) — safe to skip */ }

            const submitBtn = document.getElementById('tx-submit-btn');
            const originalLabel = submitBtn.textContent;
            submitBtn.disabled = true;
            submitBtn.innerHTML = `<span class="inline-block w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin align-[-2px] mr-1.5"></span>Saving…`;
            try {
                const saved = await saveTransactionToDB(txObj);
                if (saved !== false) {
                    showToast(editingTxId ? 'Transaction updated.' : 'Transaction logged.', { tone: 'success', duration: 2500 });
                }
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = originalLabel;
            }
            closeTxModal();
        });

        function resolveCardForTransaction(tx) {
            if (tx.cardId) {
                const byId = cards.find(c => c.id === tx.cardId);
                if (byId) return byId;
            }
            // Legacy fallback for transactions saved before cardId existed
            return cards.find(c => tx.cardId && String(c.id) === String(tx.cardId)) || cards.find(c => normCardName(c.name) === normCardName(tx.cardName));
        }

        function transferPairFor(tx) {
            const groupId = transferGroupId(tx);
            if (!groupId) return null;
            const pair = transactions.filter(item => transferGroupId(item) === groupId);
            return {
                out: pair.find(item => item.type === TRANSFER_OUT_TYPE) || null,
                incoming: pair.find(item => item.type === TRANSFER_IN_TYPE) || null
            };
        }

        function editTransaction(id) {
            const tx = transactions.find(t => t.id === id);
            if (!tx) return;

            if (isTransferType(tx.type)) {
                const pair = transferPairFor(tx);
                if (!pair || !pair.out || !pair.incoming) {
                    showToast('This transfer is missing its matching entry and cannot be edited safely.', { tone: 'error' });
                    return;
                }
                document.getElementById('editing-tx-id').value = pair.out.id;
                document.getElementById('editing-transfer-peer-id').value = pair.incoming.id;
                document.getElementById('exp-date').value = pair.out.date;
                document.getElementById('exp-desc').value = pair.out.desc;
                document.getElementById('exp-amount').value = pair.out.amount || '';
                setTransactionEntryKind('transfer');
                populateTransferCardSelects(pair.out.cardId, pair.incoming.cardId, true);
                document.getElementById('exp-form-title').innerHTML = `<span>✏️</span> Edit Transfer`;
                document.getElementById('tx-form-subtitle').textContent = 'Update both sides of this card transfer';
                document.getElementById('tx-submit-btn').textContent = 'Update Transfer';
                openTxModal(false);
                return;
            }

            document.getElementById('editing-tx-id').value = tx.id;
            document.getElementById('editing-transfer-peer-id').value = '';
            document.getElementById('exp-date').value = tx.date;
            setTransactionEntryKind(entryKindForType(tx.type));
            document.getElementById('exp-type').value = tx.type;
            document.getElementById('exp-desc').value = tx.desc;
            document.getElementById('exp-amount').value = tx.amount || '';
            document.getElementById('exp-service').value = tx.serviceCharge || '';

            const cardMatch = resolveCardForTransaction(tx);
            if (cardMatch) {
                ensureCardOption(cardMatch);
                document.getElementById('exp-card').value = cardMatch.id;
            }

            syncCategoryState(tx.type);
            document.getElementById('exp-category').value = tx.category || '';
            document.getElementById('exp-cashback').value = tx.cashback || '0.00';

            // Restore this purchase's EMI plan (if any) into the checkbox/tenure controls
            const isEmiChecked = document.getElementById('exp-is-emi');
            isEmiChecked.checked = !!(tx.type === 'Purchase' && tx.emiTotalMonths);
            if (isEmiChecked.checked) {
                const standardTenures = ['3', '6', '9', '12', '18', '24'];
                const tenureStr = String(tx.emiTotalMonths);
                const tenureSelect = document.getElementById('exp-emi-tenure');
                if (standardTenures.includes(tenureStr)) {
                    tenureSelect.value = tenureStr;
                    document.getElementById('exp-emi-custom-wrapper').classList.add('hidden');
                } else {
                    tenureSelect.value = 'custom';
                    document.getElementById('exp-emi-custom-months').value = tx.emiTotalMonths;
                    document.getElementById('exp-emi-custom-wrapper').classList.remove('hidden');
                }

                // Restore the charge type radio (No Charge / Processing Fee / Interest Rate) and
                // its percentage — otherwise editing an EMI purchase that had a fee or interest
                // would silently keep whatever the radio/field last showed from a prior session.
                const chargeType = tx.emiChargeType || 'none';
                const chargeRadio = document.getElementById(
                    chargeType === 'fee' ? 'exp-emi-charge-fee' :
                    chargeType === 'interest' ? 'exp-emi-charge-interest' : 'exp-emi-charge-none'
                );
                chargeRadio.checked = true;
                document.getElementById('exp-emi-charge-percentage').value = tx.emiChargePercentage || 0;
                onEmiChargeTypeChange();
            }
            toggleEmiDetails();

            document.getElementById('exp-form-title').innerHTML = `<span>✏️</span> Edit Transaction`;
            document.getElementById('tx-form-subtitle').textContent = 'Update the details for this transaction';
            document.getElementById('tx-submit-btn').textContent = "Update Transaction";
            
            openTxModal(false);
        }

        function duplicateTransaction(id) {
            const tx = transactions.find(t => t.id === id);
            if (!tx) return;

            if (isTransferType(tx.type)) {
                const pair = transferPairFor(tx);
                if (!pair || !pair.out || !pair.incoming) {
                    showToast('This transfer is missing its matching entry and cannot be repeated safely.', { tone: 'error' });
                    return;
                }
                document.getElementById('editing-tx-id').value = '';
                document.getElementById('editing-transfer-peer-id').value = '';
                document.getElementById('exp-date').value = new Date().toISOString().slice(0, 10);
                document.getElementById('exp-desc').value = pair.out.desc;
                document.getElementById('exp-amount').value = pair.out.amount || '';
                setTransactionEntryKind('transfer');
                populateTransferCardSelects(pair.out.cardId, pair.incoming.cardId);
                document.getElementById('exp-form-title').innerHTML = `<span>↻</span> Repeat Transfer`;
                document.getElementById('tx-form-subtitle').textContent = 'Review both cards before logging the transfer';
                document.getElementById('tx-submit-btn').textContent = 'Log Transfer';
                openTxModal(false);
                return;
            }

            document.getElementById('editing-tx-id').value = ""; // blank = this creates a NEW transaction, not an edit
            document.getElementById('editing-transfer-peer-id').value = '';
            document.getElementById('exp-date').value = new Date().toISOString().slice(0, 10);
            setTransactionEntryKind(entryKindForType(tx.type));
            document.getElementById('exp-type').value = tx.type;
            document.getElementById('exp-desc').value = tx.desc;
            document.getElementById('exp-amount').value = tx.amount || '';
            document.getElementById('exp-service').value = tx.serviceCharge || '';

            const cardMatch = resolveCardForTransaction(tx);
            // a disabled card can't take NEW transactions, so a duplicate falls back to the default card
            if (cardMatch && [...document.getElementById('exp-card').options].some(o => o.value === String(cardMatch.id))) {
                document.getElementById('exp-card').value = cardMatch.id;
            }

            syncCategoryState(tx.type);
            document.getElementById('exp-category').value = tx.category || '';
            calculateDynamicCashback(); // recompute cashback for today's rates rather than copying the old value

            // A duplicated purchase is a fresh transaction — don't inherit the original's EMI plan/paid months
            document.getElementById('exp-is-emi').checked = false;
            document.getElementById('exp-emi-details').classList.add('hidden');
            document.getElementById('exp-emi-preview').textContent = '';
            document.getElementById('exp-emi-charge-none').checked = true;
            document.getElementById('exp-emi-charge-percentage').value = '';
            document.getElementById('exp-emi-charge-input-wrapper').classList.add('hidden');

            document.getElementById('exp-form-title').innerHTML = `<span>↻</span> Repeat Transaction`;
            document.getElementById('tx-form-subtitle').textContent = 'Review the copied details before logging';
            document.getElementById('tx-submit-btn').textContent = "Log Transaction";

            openTxModal(false);
        }

        async function deleteTransaction(id) {
            const tx = transactions.find(transaction => String(transaction.id) === String(id));
            const pair = tx && isTransferType(tx.type) ? transferPairFor(tx) : null;
            if (tx && transferGroupId(tx) && (!pair || !pair.out || !pair.incoming)) {
                showToast('This transfer is missing its matching entry; it cannot be deleted as a pair.', { tone: 'error' });
                return;
            }
            const ids = pair ? [pair.out.id, pair.incoming.id] : [String(id)];
            const ok = await showConfirm(
                pair ? 'Delete this transfer?' : 'Delete this transaction?',
                pair ? 'Both sides of the transfer will be deleted in 5 seconds. You can undo the deletion during that time.' : 'The transaction will be deleted in 5 seconds. You can undo the deletion during that time.',
                { confirmLabel: 'Delete' }
            );
            if (!ok) return;
            if (ids.includes(document.getElementById('editing-tx-id').value)) {
                cancelEditTransaction();
            }
            softDeleteTransactions(ids);
        }

        // Logs this month's installment on an EMI purchase as a Repaid transaction (the same
        // way you'd pay it off manually) and decrements how many months are left.
        async function logEmiInstallment(id) {
            const original = transactions.find(t => t.id === id);
            if (!original || !original.emiTotalMonths || (original.emiRemainingMonths || 0) <= 0) return;

            const paidSoFar = original.emiPaidMonths || 0;
            const isLastInstallment = original.emiRemainingMonths === 1;
            // True up the final installment to whatever principal is actually left, so rounding
            // across the plan doesn't leave a few fils unpaid or overpaid.
            let installmentAmount;

            // For first month with processing fee, use emiFirstMonthAmount
            if (paidSoFar === 0 && original.emiChargeType === 'fee' && original.emiFirstMonthAmount) {
                installmentAmount = original.emiFirstMonthAmount;
            } else if (isLastInstallment) {
                // Calculate remaining balance for last month
                const totalPaid = original.emiFirstMonthAmount
                    ? original.emiFirstMonthAmount + (original.emiMonthlyAmount * (paidSoFar - 1))
                    : original.emiMonthlyAmount * paidSoFar;
                installmentAmount = Math.round((original.amount + (original.emiChargeAmount || 0) - totalPaid) * 100) / 100;
            } else {
                installmentAmount = original.emiMonthlyAmount;
            }

            const ok = await showConfirm(
                'Log this installment?',
                `Records a Repaid entry of AED ${formatAED(installmentAmount)} on ${original.cardName} for "${original.desc}" (installment ${paidSoFar + 1} of ${original.emiTotalMonths}).`,
                { confirmLabel: 'Log Payment' }
            );
            if (!ok) return;

            const repaymentTx = {
                id: newId(),
                date: new Date().toISOString().slice(0, 10),
                cardName: original.cardName,
                cardId: original.cardId,
                type: 'Repaid',
                desc: `EMI installment ${paidSoFar + 1}/${original.emiTotalMonths} — ${original.desc}`,
                category: '',
                amount: installmentAmount,
                serviceCharge: 0,
                cashback: 0,
                notes: `Auto-logged installment for transaction ${original.id}`
            };
            transactions.unshift(repaymentTx);
            const savedRepayment = await saveTransactionToDB(repaymentTx);

            const idx = transactions.findIndex(t => t.id === id);
            let savedOriginal = true;
            if (idx !== -1) {
                transactions[idx] = {
                    ...transactions[idx],
                    emiPaidMonths: paidSoFar + 1,
                    emiRemainingMonths: original.emiRemainingMonths - 1
                };
                savedOriginal = await saveTransactionToDB(transactions[idx]);
            }

            render();
            if (savedRepayment !== false && savedOriginal !== false) {
                showToast(
                    isLastInstallment ? `Final installment logged — "${original.desc}" is fully paid off.` : `Installment logged (${paidSoFar + 1} of ${original.emiTotalMonths}).`,
                    { tone: 'success' }
                );
            }
        }

        async function deleteCard(id) {
            id = String(id);
            if (pendingCardDeleteTimers.has(id)) {
                showToast('This card is already scheduled for deletion.', { duration: 2500 });
                return;
            }
            const card = cards.find(c => c.id === id);
            if (!card) return;
            const isLinked = t => t.cardId ? t.cardId === card.id : (t.cardName || '').trim().toLowerCase() === card.name.trim().toLowerCase();
            const linkedIds = new Set(transactions.filter(isLinked).map(t => String(t.id)));
            transactions.filter(isLinked).forEach(tx => {
                const groupId = transferGroupId(tx);
                if (!groupId) return;
                transactions.filter(item => transferGroupId(item) === groupId).forEach(item => linkedIds.add(String(item.id)));
            });
            const linked = transactions.filter(t => linkedIds.has(String(t.id)));

            const message = linked.length > 0
                ? `Deleting "${card.name}" will also permanently delete its ${linked.length} linked transaction(s), including both sides of any card transfers, along with its saved rules. This cannot be undone.`
                : `Are you sure you want to delete "${card.name}"?`;

            const ok = await showConfirm('Delete this card and its transactions?', message, { confirmLabel: 'Delete all' });
            if (!ok) return;

            const timer = setTimeout(() => {
                pendingCardDeleteTimers.delete(id);
                completeCardDeletion(id, card, linked).catch(error => {
                    console.error('Deleting card failed:', error);
                    showToast(`Could not complete card deletion: ${error.message || error}`, { tone: 'error', duration: 10000 });
                });
            }, CARD_DELETE_UNDO_WINDOW_MS);
            pendingCardDeleteTimers.set(id, timer);
            showToast(`Deleting "${card.name}" in 5 seconds.`, {
                actionLabel: 'Undo',
                duration: CARD_DELETE_UNDO_WINDOW_MS,
                onAction: () => {
                    clearTimeout(pendingCardDeleteTimers.get(id));
                    pendingCardDeleteTimers.delete(id);
                    showToast(`Deletion of "${card.name}" cancelled.`, { duration: 3000 });
                }
            });
        }

        const pendingCardDeleteTimers = new Map();
        const CARD_DELETE_UNDO_WINDOW_MS = 5000;

        async function completeCardDeletion(id, card, linked) {
            const ids = linked.map(t => String(t.id));
            if (linked.length) {
                if (_supabase) {
                    for (let k = 0; k < ids.length; k += 100) {
                        const { error } = await _supabase.from('transactions').delete().in('id', ids.slice(k, k + 100));
                        if (error) {
                            console.error('Deleting card transactions failed:', error);
                            showToast(`Could not delete the card's transactions: ${error.message}`, { tone: 'error', duration: 10000 });
                            // Earlier batches may already have been deleted; restore them because
                            // the card itself must remain available when transaction cleanup fails.
                            let restored = true;
                            for (const transaction of linked) {
                                try {
                                    if (await saveTransactionToDB(transaction) === false) restored = false;
                                } catch (restoreError) {
                                    console.error('Restoring card transaction failed:', restoreError);
                                    restored = false;
                                }
                            }
                            if (!restored) {
                                showToast('Some transactions could not be restored. Check the transaction history.', { tone: 'error', duration: 10000 });
                            }
                            return;
                        }
                    }
                }
            }

            const deletedCard = await deleteCardFromDB(id);
            if (!deletedCard) {
                // The transaction rows have already been removed to satisfy foreign-key
                // constraints. Put them back if the card deletion itself fails.
                let restored = true;
                for (const transaction of linked) {
                    try {
                        if (await saveTransactionToDB(transaction) === false) restored = false;
                    } catch (restoreError) {
                        console.error('Restoring card transaction failed:', restoreError);
                        restored = false;
                    }
                }
                if (!restored) {
                    showToast('Some transactions could not be restored. Check the transaction history.', { tone: 'error', duration: 10000 });
                }
                return;
            }

            if (linked.length) {
                const gone = new Set(ids);
                transactions = transactions.filter(t => !gone.has(String(t.id)));
                saveData();
            }

            // clean up this card's saved rules and cashback reconciliation entries
            try {
                const rules = ddLoad('dd-card-rules'), recon = ddLoad('dd-recon');
                delete rules[id]; delete recon[id];
                ddSave('dd-card-rules', rules); ddSave('dd-recon', recon);
                if (_supabase) {
                    await _supabase.from('card_rules').delete().eq('card_id', String(id));
                    await _supabase.from('cashback_recon').delete().eq('card_id', String(id));
                }
            } catch (e) { console.warn(e); }

            render();
            showToast(linked.length ? `Card and ${linked.length} transaction(s) deleted.` : 'Card deleted.', { tone: 'success' });
        }

        // ---- BACKUP: EXPORT / IMPORT (independent of localStorage vs Supabase) ----
        function csvEscape(value) {
            const str = value === null || value === undefined ? '' : String(value);
            if (/[",\n]/.test(str)) {
                return '"' + str.replace(/"/g, '""') + '"';
            }
            return str;
        }

        function exportFilteredCsv() {
            const filtered = transactions.filter(transactionMatchesFilters);
            if (filtered.length === 0) {
                alert('No transactions match the current filter — nothing to export.');
                return;
            }

            const headers = ['Date', 'Card', 'Type', 'Description', 'Category', 'Amount', 'Service Charge', 'Cashback', 'Notes'];
            const rows = filtered.map(t => [
                t.date, t.cardName, t.type, t.desc, t.category || '', t.amount, t.serviceCharge || 0, t.cashback || 0, t.notes || ''
            ]);

            const csvContent = [headers, ...rows].map(row => row.map(csvEscape).join(',')).join('\n');
            const blob = new Blob([csvContent], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `cashback-tracker-filtered-${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        }

        function exportBackup() {
            const backup = {
                exportedAt: new Date().toISOString(),
                cards,
                transactions
            };
            const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `cashback-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        }

        document.getElementById('backup-file-input').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = async (evt) => {
                let parsed;
                try {
                    parsed = JSON.parse(evt.target.result);
                } catch (err) {
                    alert('That file is not valid JSON — please choose a backup exported from this app.');
                    e.target.value = '';
                    return;
                }

                if (!Array.isArray(parsed.cards) || !Array.isArray(parsed.transactions)) {
                    alert('This file does not look like a Cashback Tracker backup (missing cards/transactions arrays).');
                    e.target.value = '';
                    return;
                }

                const proceedImport = await showConfirm(
                    'Import backup?',
                    `This backup has ${parsed.cards.length} card(s) and ${parsed.transactions.length} transaction(s). Importing will ADD to what you already have (duplicates possible if you import the same backup twice).`,
                    { confirmLabel: 'Import' }
                );
                if (!proceedImport) {
                    e.target.value = '';
                    return;
                }

                for (const c of parsed.cards) {
                    if (!cards.some(existing => existing.id === c.id)) {
                        cards.push(c);
                        await saveCardToDB(c);
                    }
                }
                // Any category / type in the backup that this account doesn't have yet gets created
                // (in-memory, dropdowns and the shared_options table), matched case-insensitively.
                const bCatLookup = new Map([...RATE_CATEGORIES, ...TX_ONLY_CATEGORIES].map(c => [c.toLowerCase(), c]));
                const bTypeLookup = new Map(TYPE_FILTER_OPTIONS.map(t => [t.toLowerCase(), t]));
                const bNewCats = [], bNewTypes = [];
                const usedCategories = [], usedTypes = [];
                for (const t of parsed.transactions) {
                    const cat = String(t.category || '').trim();
                    if (cat) {
                        t.category = bCatLookup.get(cat.toLowerCase()) || cat;
                        if (!bCatLookup.has(cat.toLowerCase())) { bCatLookup.set(cat.toLowerCase(), cat); bNewCats.push(cat); }
                        usedCategories.push(t.category);
                    }
                    const typ = String(t.type || '').trim();
                    if (typ) {
                        t.type = bTypeLookup.get(typ.toLowerCase()) || typ;
                        if (!bTypeLookup.has(typ.toLowerCase())) { bTypeLookup.set(typ.toLowerCase(), typ); bNewTypes.push(typ); }
                        usedTypes.push(t.type);
                    }
                    if (transactions.some(existing => existing.id === t.id)) continue;
                    transactions.push(t);
                    await saveTransactionToDB(t);
                }
                const optionsSync = await syncUsedSharedOptions(usedCategories, usedTypes);
                showToast(optionsSync.failures
                    ? `Backup imported, but ${optionsSync.failures} category/type option(s) could not be saved to Supabase.`
                    : 'Backup imported.', { tone: optionsSync.failures ? 'error' : 'success', duration: optionsSync.failures ? 10000 : 4000 });
                e.target.value = '';
                render();
            };
            reader.readAsText(file);
        });

        // Repairs transactions that were saved with a card name but no card_id — this affects
        // anything imported before the CSV importer started setting cardId, and any row saved
        // while the emi_*/card_id columns hadn't been migrated in yet. Matches purely by name,
        // so it can't recover a transaction whose card was since renamed or deleted.
        // After a card is renamed, push the new name (and the card link) to every one of its transactions on Supabase.
        async function renameCardTransactionsInDB(txs, card) {
            txs.forEach(t => { t.cardName = card.name; t.cardId = card.id; });
            if (!_supabase) { saveData(); return true; }
            let ok = true;
            const run = async (build) => {
                let { error } = await build({ card_name: card.name, card_id: String(card.id) });
                if (error && /card_id/i.test(error.message || '')) ({ error } = await build({ card_name: card.name }));
                if (error) { console.error('Renaming card on Supabase failed:', error); ok = false; }
            };
            // 1) the transactions this session knows about, in batches
            const ids = txs.map(t => String(t.id));
            for (let k = 0; k < ids.length; k += 100) {
                const chunk = ids.slice(k, k + 100);
                await run(payload => _supabase.from('transactions').update(payload).in('id', chunk));
            }
            // 2) any other rows already linked to this card id (e.g. beyond what was loaded)
            await run(payload => _supabase.from('transactions').update({ card_name: payload.card_name }).eq('card_id', String(card.id)));
            saveData();
            return ok;
        }
        async function repairMissingCardLinks() {
            const cardOf = t => (t.cardId ? cards.find(c => String(c.id) === String(t.cardId)) : null)
                || cards.find(c => normCardName(c.name) === normCardName(t.cardName));
            const orphaned = transactions.filter(t => {
                if (!t.cardId && !t.cardName) return false;
                const c = cardOf(t);
                return !c || String(t.cardId) !== String(c.id) || t.cardName !== c.name;
            });
            if (orphaned.length === 0) {
                showToast('Nothing to fix — every transaction already has a linked card.', { tone: 'success' });
                return;
            }

            let matched = 0, unmatched = 0, failed = 0;
            for (const t of orphaned) {
                const card = cardOf(t);
                if (!card) { unmatched++; continue; }
                t.cardId = card.id;
                t.cardName = card.name;
                if ((await saveTransactionToDB(t)) === false) failed++;
                else matched++;
            }

            render();
            let summary = `Linked ${matched} of ${orphaned.length} transaction(s) to their card.`;
            if (unmatched > 0) summary += `\n${unmatched} had no card matching their saved name (renamed or deleted card).`;
            if (failed > 0) summary += `\n${failed} matched but failed to save — see the error above.`;
            showToast(summary, { tone: failed > 0 ? 'error' : 'success', duration: 8000 });
        }

        async function clearAllData() {
            const ok = await showConfirm('Clear all data?', 'This permanently deletes every stored card and transaction. This cannot be undone.', { confirmLabel: 'Clear Everything' });
            if (ok) {
                if (_supabase) {
                    // Once RLS is enabled with the accompanying policies, these
                    // deletes are restricted to rows where user_id = auth.uid(),
                    // so this only ever clears the signed-in user's own data.
                    await _supabase.from('transactions').delete().neq('id', '0');
                    await _supabase.from('cards').delete().neq('id', '0');
                }
                localStorage.clear();
                cards = [];
                transactions = [];
                activeCardFilter = 'ALL';
                selectedCategories = [];
                selectedMonths = [];
                searchQuery = '';
                const searchInput = document.getElementById('tx-search-input');
                if (searchInput) searchInput.value = '';
                render();
            }
        }

        function bestRateForCategory(category) {
            const pool = activeCards();
            if (pool.length === 0) return 0;
            const cat = category || 'All Other Spend';
            return Math.max(...pool.map(c => {
                if (!c.rates) return 0;
                return c.rates[cat] !== undefined ? c.rates[cat] : (c.rates['All Other Spend'] || 0);
            }));
        }

        function recommendBestCard() {
            const cat = document.getElementById('rec-category').value || RATE_CATEGORIES[0];
            const resultDiv = document.getElementById('recommendation-result');
            renderRecommendationCategoryPills(); // pill percentages follow the current card rates

            if (cards.length === 0) {
                resultDiv.innerHTML = `<div class="rec-row"><span class="text-slate-400">Add cards above to calculate choices.</span></div>`;
                return;
            }

            if (activeCards().length === 0) {
                resultDiv.innerHTML = `<div class="rec-row"><span class="text-slate-400">All your cards are disabled. Enable a card to get recommendations.</span></div>`;
                return;
            }

            const ranked = activeCards()
                .map(card => ({ card, name: card.name, rate: cardRateFor(card, cat) }))
                .sort((a, b) => b.rate - a.rate);
            const best = ranked[0];
            const second = ranked[1];

            let sub;
            if (!second) sub = 'Your only card so far. Add more cards to compare rates.';
            else if (second.rate === best.rate) sub = `Tied with ${escapeHtml(second.name)} at ${fmtRate(second.rate)}%`;
            else sub = `Highest of ${ranked.length} cards · next best ${escapeHtml(second.name)} at ${fmtRate(second.rate)}%`;

            const label = /^all other/i.test(cat) ? 'General Spend' : cat;
            const theme = resolveCardColor(best.card.colorGradient);
            const shortName = String(best.name).trim().split(/\s+/)[0].slice(0, 7).toUpperCase();
            const isDefault = getDefaultCardId() === String(best.card.id);
            const handIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11V5a2 2 0 0 1 4 0v6"/><path d="M13 9.5a2 2 0 0 1 4 0V13a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L3.6 13.6a1.8 1.8 0 0 1 3-2L9 14"/></svg>';

            resultDiv.innerHTML = `
                <div class="rec-row">
                    <span class="rec-mini" style="${cardThemeVars(theme)}"><span class="rec-mini-chip ${cardChipClass(theme)}"></span><span class="rec-mini-name">${escapeHtml(shortName)}</span></span>
                    <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                            <span class="rec-name">${escapeHtml(best.name)}</span>
                            <span class="rec-badge">${fmtRate(best.rate)}% ${escapeHtml(label)}</span>
                        </div>
                        <p class="rec-sub">${sub}</p>
                    </div>
                    <!--
                    <button type="button" class="rec-btn ${isDefault ? 'is-default' : ''}" ${isDefault ? 'disabled' : ''} onclick="setDefaultCard('${best.card.id}')">${isDefault ? '✓ Default card' : handIcon + ' Set as Default'}</button>
                    -->
                </div>`;
        }

        function updateCardDropdowns() {
            const select = document.getElementById('exp-card');
            const pool = activeCards();
            if (pool.length === 0) {
                select.innerHTML = `<option value="">${cards.length === 0 ? 'No cards available' : 'No active cards (all disabled)'}</option>`;
                return;
            }
            select.innerHTML = groupedCardOptions(pool);
        }
        // Editing an old transaction that belongs to a disabled card: keep that card selectable for this edit only.
        function ensureCardOption(card) {
            const select = document.getElementById('exp-card');
            if (!card || !select || [...select.options].some(o => o.value === String(card.id))) return;
            const type = isDebit(card) ? 'Debit' : 'Credit';
            let group = [...select.querySelectorAll('optgroup')].find(optionGroup => optionGroup.label === type);
            if (!group) {
                group = document.createElement('optgroup');
                group.label = type;
                const creditGroup = [...select.querySelectorAll('optgroup')].find(optionGroup => optionGroup.label === 'Credit');
                if (type === 'Debit' && creditGroup) select.insertBefore(group, creditGroup);
                else select.appendChild(group);
            }
            const opt = document.createElement('option');
            opt.value = card.id;
            opt.textContent = `${card.name} (disabled)`;
            group.appendChild(opt);
        }

        // ---- PREMIUM CARD TILE HELPERS ----
        // Map the colour a card was saved with (existing keys) to a tile theme.
        const CARD_NETWORKS = [
            { key: 'amex',       re: /\b(american\s+express|amex)\b/i },
            { key: 'visa',       re: /\bvisa\b/i },
            { key: 'mastercard', re: /\bmaster\s?card\b/i },
            { key: 'rupay',      re: /\brupay\b/i },
            { key: 'diners',     re: /\bdiners(\s+club)?\b/i }
        ];
        const CARD_VARIANT_RE = /\b(infinite|signature)\b/i;
        const CARD_TIER_RE = /\b(preferred|reserve|gold|platinum|titanium|premier|select|classic|world|black|diamond|elite|prime|infinite|signature)\b/i;

        // Reads the network / tier out of the card's name so the tile can show a badge + logo.
        function parseCardIdentity(rawName, o = {}) {
            const name = String(rawName || '').trim();
            let network = null, netMatch = '';
            for (const n of CARD_NETWORKS) { const m = name.match(n.re); if (m) { network = n.key; netMatch = m[0]; break; } }
            const varM = name.match(CARD_VARIANT_RE);
            const variant = (varM && (network === 'visa' || network === 'mastercard')) ? varM[0] : '';
            const tierM = name.match(CARD_TIER_RE);
            const tier = (tierM && tierM[0].toLowerCase() !== variant.toLowerCase()) ? tierM[0] : '';
            const strip = (str, words) => {
                let out = str;
                words.filter(Boolean).forEach(w => { out = out.replace(new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') + '\\b', 'i'), ''); });
                return out.replace(/\s{2,}/g, ' ').replace(/^[\s\-–|·]+|[\s\-–|·]+$/g, '');
            };
            // "ENBD Visa Platinum" -> title "ENBD"; "American Express Gold" -> "American Express"
            const title = strip(name, [netMatch, variant, tier]) || strip(name, [variant, tier]) || name;
            // Values typed in the card form win over what was read from the name.
            if (o.network === 'none') { network = null; }
            else if (o.network) { network = o.network; }
            const finalVariant = o.netVariant ? o.netVariant : ((network === 'visa' || network === 'mastercard') ? variant : '');
            return { title, network, variant: finalVariant, tier: o.tier ? o.tier : tier };
        }

        function networkMarkHtml(id) {
            const v = id.variant ? `<span class="cc-net-var">${escapeHtml(id.variant.charAt(0).toUpperCase() + id.variant.slice(1).toLowerCase())}</span>` : '';
            switch (id.network) {
                case 'visa':       return `<span class="cc-net"><span class="cc-visa">VISA</span>${v}</span>`;
                case 'amex':       return `<span class="cc-net"><span class="cc-amex">AMEX</span></span>`;
                case 'mastercard': return `<span class="cc-net"><span class="cc-mc"><i></i><i></i></span>${v}</span>`;
                case 'rupay':      return `<span class="cc-net"><span class="cc-textnet">RuPay</span></span>`;
                case 'diners':     return `<span class="cc-net"><span class="cc-textnet">Diners</span></span>`;
                default:           return '';
            }
        }

        function ordinalDay(n) {
            const v = n % 100;
            if (v >= 11 && v <= 13) return n + 'th';
            return n + (['th', 'st', 'nd', 'rd'][n % 10] || 'th');
        }

        const CC_ICON = {
            clock: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
            check: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.2 12.4l2.6 2.6 5-5.4"/></svg>',
            alert: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.2v.01"/></svg>',
        };

        // Footer row: "Stmt: 15th" on the left, due-date badge on the right.
        // ---- Due-date tools: mark paid, utilization, calendar export, reminders ----
        // Names are compared ignoring case, spaces and punctuation, so "ADCB - 365" and "ADCB 365" are the same card.
        const normCardName = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
        function txBelongsToCard(t, c) {
            if (t.cardId && String(t.cardId) === String(c.id)) return true;
            return !!t.cardName && normCardName(t.cardName) === normCardName(c.name);
        }
        function cardTxList(c) {
            return transactions.filter(t => txBelongsToCard(t, c));
        }
        async function markCardPaid(cardId) {
            const c = cards.find(x => String(x.id) === String(cardId));
            if (!c) return;
            const due = Math.max(0, calculateOutstanding(cardTxList(c), localDateKey(), c).outstanding);
            const input = prompt(`Payment made to ${c.name}. Outstanding today: ${formatAED(due)}`, due.toFixed(2));
            if (input === null) return;
            const amount = parseFloat(input);
            if (isNaN(amount) || amount <= 0) { showToast('Enter a payment amount above 0.', { tone: 'error' }); return; }
            const tx = {
                id: newId(), date: localDateKey(), cardName: c.name, cardId: c.id, type: 'Repaid',
                desc: 'Card payment', category: '', amount, serviceCharge: 0, cashback: 0,
                notes: amount < due ? `Partial payment (AED ${formatAED(due - amount)} still outstanding)` : 'Marked as paid'
            };
            transactions.unshift(tx);
            const ok = await saveTransactionToDB(tx);
            render();
            if (ok !== false) showToast(amount < due - 0.005 ? `Partial payment logged. AED ${formatAED(due - amount)} still outstanding.` : `${c.name} marked as paid.`, { tone: 'success' });
        }
        function exportDueDatesIcs() {
            const pad = n => String(n).padStart(2, '0');
            const today = new Date();
            const stamp = `${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}T000000Z`;
            const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DueDates//EN', 'CALSCALE:GREGORIAN'];
            const visible = activeCards();
            let n = 0;
            visible.forEach(c => {
                [['paymentDay', 'Payment due', true], ['statementDay', 'Statement date', false]].forEach(([key, label, alarm]) => {
                    const day = Number(c[key]);
                    if (!day) return;
                    const next = nextOccurrence(day, new Date(today.getFullYear(), today.getMonth(), today.getDate()));
                    const ds = `${next.getFullYear()}${pad(next.getMonth() + 1)}${pad(next.getDate())}`;
                    lines.push('BEGIN:VEVENT', `UID:${c.id}-${key}@duedates`, `DTSTAMP:${stamp}`,
                        `DTSTART;VALUE=DATE:${ds}`, `RRULE:FREQ=MONTHLY;BYMONTHDAY=${Math.min(day, 28)}`,
                        `SUMMARY:${label}: ${String(c.name).replace(/[,;\n]/g, ' ')}`, 'TRANSP:TRANSPARENT');
                    if (alarm) [3, 1, 0].forEach(d => lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${label}`, `TRIGGER:${d ? '-P' + d + 'D' : '-PT0S'}`, 'END:VALARM'));
                    lines.push('END:VEVENT'); n++;
                });
            });
            lines.push('END:VCALENDAR');
            if (!n) { showToast('Set statement/payment days on your cards first.', { tone: 'error' }); return; }
            const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar' });
            const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'card-due-dates.ics';
            document.body.appendChild(a); a.click(); a.remove();
            showToast(`Exported ${n} recurring calendar events.`, { tone: 'success' });
        }
        async function enableDueReminders() {
            if (!('Notification' in window)) { showToast('This browser does not support notifications.', { tone: 'error' }); return; }
            const p = await Notification.requestPermission();
            if (p === 'granted') { showToast('Due reminders on (shown when the app is open).', { tone: 'success' }); checkDueNotifications(true); }
        }
        function checkDueNotifications(force) {
            if (!('Notification' in window) || Notification.permission !== 'granted') return;
            const key = 'dd-notified-' + localDateKey();
            if (!force && localStorage.getItem(key)) return;
            const t0 = new Date(); t0.setHours(0, 0, 0, 0);
            const soon = cards.filter(c => c.paymentDay).map(c => ({ c, n: daysBetween(t0, nextOccurrence(Number(c.paymentDay), t0)) }))
                .filter(x => x.n <= 3).sort((a, b) => a.n - b.n);
            if (!soon.length) return;
            localStorage.setItem(key, '1');
            new Notification('Card payments due', { body: soon.map(x => `${x.c.name}: ${x.n === 0 ? 'today' : 'in ' + x.n + 'd'}`).join('\n') });
        }

        // ---- Card rules, insights, privacy (rules stored per device in localStorage) ----
        const ddLoad = k => { try { return JSON.parse(localStorage.getItem(k) || '{}'); } catch (e) { return {}; } };
        const ddSave = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
        const ddSum = (a, f) => a.reduce((n, t) => n + (parseFloat(f(t)) || 0), 0);
        const ddNum = v => parseFloat(v) || 0;
        function ddModal(title, html) {
            document.getElementById('dd-modal')?.remove();
            const d = document.createElement('div'); d.id = 'dd-modal';
            d.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px';
            d.innerHTML = `<div class="bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] overflow-y-auto p-5 sm:p-7"><div class="flex justify-between items-center mb-5"><h3 class="font-bold text-lg">${title}</h3><button type="button" onclick="document.getElementById('dd-modal').remove()" aria-label="Close dialog" class="grid h-9 w-9 place-items-center rounded-xl text-slate-400 transition hover:bg-white/10 hover:text-white">✕</button></div>${html}</div>`;
            document.body.appendChild(d);
        }
        function ddRule(c) { return ddLoad('dd-card-rules')[c.id] || {}; }
        function ddCaps(r) {
            const caps = {};
            const addCap = (category, value) => {
                const amount = ddNum(value);
                if (category && amount > 0) caps[String(category).trim()] = amount;
            };
            if (r.caps && typeof r.caps === 'object' && !Array.isArray(r.caps)) {
                Object.entries(r.caps).forEach(([category, value]) => addCap(category, value));
            } else {
                String(r.caps || '').split(',').forEach(entry => {
                    const separator = entry.indexOf(':');
                    if (separator > 0) addCap(entry.slice(0, separator).trim(), entry.slice(separator + 1));
                });
            }
            return caps;
        }
        function ddYearWindow(r) {
            const now = new Date(), m = ddNum(r.renewal); if (!m) return null;
            let y = now.getFullYear(); if (m - 1 > now.getMonth()) y--;
            return `${y}-${String(m).padStart(2, '0')}-01`;
        }
        function ddTileExtras(c) {
            const r = ddRule(c), L = [], now = localDateKey(), ym = now.slice(0, 7), txs = cardTxList(c);
            const mTx = txs.filter(t => (t.date || '').startsWith(ym));
            const caps = ddCaps(r);
            Object.keys(caps).forEach(k => {
                const used = ddSum(mTx.filter(t => k === 'All' || t.category === k), t => t.cashback), left = caps[k] - used;
                const label = k === 'All' ? 'overall monthly cashback' : escapeHtml(k);
                L.push(`<span class="${left <= 0 ? 'text-red-400' : ''}">${left <= 0 ? '⛔ ' + label + ' cap reached' : 'AED ' + formatAED(left) + ' cap left on ' + label}</span>`);
            });
            if (ddNum(r.minSpend)) { const sp = ddSum(mTx.filter(t => txKind(t.type) === 'Purchase' || txKind(t.type) === 'Cash Withdrawal'), t => t.amount); L.push(`Min spend: AED ${formatAED(sp)} / ${formatAED(ddNum(r.minSpend))}${sp >= ddNum(r.minSpend) ? ' ✓' : ''}`); }
            const ws = ddYearWindow(r);
            if (ddNum(r.fee)) {
                const yt = txs.filter(t => t.date >= (ws || '0000'));
                const sp = ddSum(yt.filter(t => txKind(t.type) === 'Purchase' || txKind(t.type) === 'Cash Withdrawal'), t => t.amount), cb = ddSum(yt, t => t.cashback);
                if (ddNum(r.waiver)) L.push(`Fee waiver: AED ${formatAED(sp)} / ${formatAED(ddNum(r.waiver))} (${Math.min(100, sp / ddNum(r.waiver) * 100).toFixed(0)}%)${sp >= ddNum(r.waiver) ? ' ✓ waived' : ''}`);
                if (cb < ddNum(r.fee) && !(ddNum(r.waiver) && sp >= ddNum(r.waiver))) L.push(`<span class="text-amber-400">⚠ Fee AED ${formatAED(ddNum(r.fee))} exceeds cashback AED ${formatAED(cb)} this year</span>`);
            }
            return L.length ? `<div class="mt-2 text-[10px] leading-4 opacity-90">${L.join('<br>')}</div>` : '';
        }
        let ddWithdrawalCardId = '';
        let ddWithdrawalCategory = 'Travel';
        let warnedWithdrawalChargeStorage = false;
        function saveWithdrawalChargePercentages() {
            try {
                localStorage.setItem('dd-withdrawal-charge-percentages', JSON.stringify(WITHDRAWAL_CHARGE_PERCENTAGES));
            } catch (error) {
                console.warn('Could not save withdrawal charge percentages:', error);
                if (!warnedWithdrawalChargeStorage) {
                    warnedWithdrawalChargeStorage = true;
                    showToast('Could not save charge percentages on this device.', { tone: 'error' });
                }
            }
        }
        // Remaining cashback cap for a category (tightest of category cap and overall 'All' cap); null = no cap.
        function ddWithdrawalCapRemaining(card, category, monthTxs) {
            const caps = ddCaps(ddRule(card));
            const remaining = [category, 'All']
                .filter(key => Object.prototype.hasOwnProperty.call(caps, key))
                .map(key => Math.max(0, caps[key] - ddSum(monthTxs.filter(t => key === 'All' || t.category === key), t => t.cashback)));
            return remaining.length ? Math.min(...remaining) : null;
        }
        function ddWithdrawalAvailability(card, monthTxs) {
            const limit = Math.max(0, ddNum(card.availableLimit));
            const usesMonthlySpend = ddRule(card).limitCashbackSpendToMonthlyLimit !== false;
            const used = usesMonthlySpend
                ? ddSum(monthTxs.filter(t => txKind(t.type) === 'Purchase' || txKind(t.type) === 'Cash Withdrawal'), t => t.amount)
                : Math.max(0, calculateOutstanding(cardTxList(card), localDateKey(), card).outstanding);
            return {
                amount: Math.max(0, limit - used),
                description: usesMonthlySpend
                    ? 'Available to withdraw is the card limit minus current-month purchases and cash withdrawals.'
                    : "Available to withdraw is the card limit minus the card's current outstanding balance."
            };
        }
        // Withdrawal amount that exactly uses the remaining cashback cap for the selected category
        // (limited by what is still available on the card). No cap set -> based on available limit only.
        function ddSuggestedWithdrawal(card, category, monthTxs, availableToWithdraw, chargePercentage) {
            const factor = 1 - chargePercentage / 100;
            const rate = cardRateFor(card, category);
            const capRemaining = ddWithdrawalCapRemaining(card, category, monthTxs);
            const availableWithdrawal = Math.max(0, availableToWithdraw * factor);
            let amount = availableWithdrawal, basis = 'available';
            if (capRemaining !== null) {
                if (rate > 0) {
                    // cashback = charged * rate% ; charged = withdrawal / factor
                    amount = Math.min(availableWithdrawal, (capRemaining * 100 / rate) * factor);
                    basis = 'cap';
                } else {
                    amount = 0; basis = 'norate';
                }
            }
            return { amount: Math.max(0, Math.floor(amount + 1e-9)), capRemaining, basis };
        }
        function ddWithdrawalCategories(card) {
            return Object.entries(card.rates || {})
                .filter(([category, value]) => category.trim() && Number.isFinite(Number(value)) && Number(value) >= 3)
                .map(([category]) => category);
        }
        function ddWithdrawalPlannerHtml(act) {
            if (!act.length) return '<p class="rounded-xl border border-dashed border-slate-300 px-4 py-6 text-center text-xs text-slate-500 dark:border-white/10">No active credit cards have a configured cashback category at 3% or higher.</p>';
            const selectedCard = act.find(c => String(c.id) === String(ddWithdrawalCardId))
                || act.find(c => String(c.id) === getDefaultCardId())
                || act.reduce((best, card) => cardRateFor(card, 'Travel') > cardRateFor(best, 'Travel') ? card : best, act[0]);
            ddWithdrawalCardId = String(selectedCard.id);
            const categories = ddWithdrawalCategories(selectedCard);
            loadWithdrawalChargePercentages();
            ensureWithdrawalChargePercentages(categories);
            const selectedCategory = categories.includes(ddWithdrawalCategory) ? ddWithdrawalCategory : (categories[0] || '');
            ddWithdrawalCategory = selectedCategory;
            const cardOptions = act.map(c => `<option value="${escapeHtml(c.id)}" ${String(c.id) === ddWithdrawalCardId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
            const categoryOptions = categories.length
                ? categories.map(category => `<option value="${escapeHtml(category)}" ${category === selectedCategory ? 'selected' : ''}>${escapeHtml(category)} · ${fmtRate(cardRateFor(selectedCard, category))}%</option>`).join('')
                : '<option value="">No configured categories at 3% or higher</option>';
            const result = (id, label, color = 'text-slate-900 dark:text-slate-100') => `<div class="rounded-xl border border-slate-200 bg-white p-3 dark:border-white/[.07] dark:bg-black/15"><p class="text-[10px] uppercase tracking-wider text-slate-500">${label}</p><p id="${id}" class="mono mt-1 text-sm font-semibold ${color}">AED 0.00</p></div>`;
            const selectedMonth = localDateKey().slice(0, 7);
            const suggestedMonthTxs = cardTxList(selectedCard).filter(t => (t.date || '').startsWith(selectedMonth));
            const suggestedAvailability = ddWithdrawalAvailability(selectedCard, suggestedMonthTxs);
            const suggestedAvailable = suggestedAvailability.amount;
            const suggestedWithdrawal = selectedCategory
                ? ddSuggestedWithdrawal(selectedCard, selectedCategory, suggestedMonthTxs, suggestedAvailable, WITHDRAWAL_CHARGE_PERCENTAGES[selectedCategory]).amount
                : 0;
            const availabilityDescription = suggestedAvailability.description;
            return `<div class="grid gap-3 sm:grid-cols-2">
                    <label class="block text-xs font-medium text-slate-600 dark:text-slate-400">Card
                        <select id="dd-withdrawal-card" onchange="ddUpdateWithdrawalPlanner(this)" class="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 dark:border-white/10 dark:bg-slate-900 dark:text-slate-100">${cardOptions}</select>
                    </label>
                    <div class="grid grid-cols-[minmax(0,1fr)_112px] items-end gap-2">
                        <label class="block min-w-0 text-xs font-medium text-slate-600 dark:text-slate-400">Cashback category
                            <select id="dd-withdrawal-category" onchange="ddUpdateWithdrawalPlanner(this)" ${categories.length ? '' : 'disabled'} class="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 dark:border-white/10 dark:bg-slate-900 dark:text-slate-100">${categoryOptions}</select>
                        </label>
                        <label class="block text-xs font-medium text-slate-600 dark:text-slate-400">Charge %
                            <input id="dd-withdrawal-charge-percent" type="number" min="0" max="99.99" step="0.01" value="${selectedCategory ? WITHDRAWAL_CHARGE_PERCENTAGES[selectedCategory] : ''}" ${selectedCategory ? '' : 'disabled'} oninput="ddUpdateWithdrawalPlanner(this)" aria-label="Withdrawal charge percentage" class="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 dark:border-white/10 dark:bg-slate-900 dark:text-slate-100">
                        </label>
                    </div>
                </div>
                <p id="dd-withdrawal-charge-error" class="mt-2 hidden text-xs text-rose-600 dark:text-rose-300" role="alert">Enter a charge percentage from 0% up to (but not including) 100%.</p>
                <div class="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    ${result('dd-withdrawal-limit', 'Total credit card limit')}
                    ${result('dd-withdrawal-spend', 'Current month spend')}
                    ${result('dd-withdrawal-available', 'Available to withdraw', 'text-indigo-700 dark:text-indigo-500')}
                    <div class="rounded-xl border border-slate-200 bg-white p-3 dark:border-white/[.07] dark:bg-black/15">
                        <p class="text-[10px] uppercase tracking-wider text-slate-500">Estimated withdrawal amount</p>
                        <p id="dd-withdrawal-amount-text" class="mono mt-1 text-sm font-semibold text-indigo-700 dark:text-indigo-500">AED ${formatAED(suggestedWithdrawal)}</p>
                        <input id="dd-withdrawal-amount-input" type="hidden" value="${suggestedWithdrawal}">
                        <p id="dd-withdrawal-amount-error" class="mt-1 hidden text-[10px] text-rose-600 dark:text-rose-300" role="alert">Enter a withdrawal amount of zero or more.</p>
                        <p id="dd-withdrawal-availability-warning" class="mt-1 hidden text-[10px] text-amber-700 dark:text-amber-300" role="status">This amount exceeds the card's estimated available amount.</p>
                    </div>
                    ${result('dd-withdrawal-deducted', 'Amount charged to card')}
                    ${result('dd-withdrawal-rate', 'Cashback rate')}
                    ${result('dd-withdrawal-cashback-used', 'Cashback earned this month')}
                    ${result('dd-withdrawal-cap-remaining', 'Cashback cap remaining')}
                    ${result('dd-withdrawal-cashback', 'Estimated cashback after caps', 'text-emerald-700 dark:text-emerald-300')}
                    ${result('dd-withdrawal-charge', 'Withdrawal charge estimate', 'text-amber-700 dark:text-amber-300')}
                    ${result('dd-withdrawal-net', 'Estimated cashback received', 'text-emerald-700 dark:text-emerald-300')}
                </div>
                <p id="dd-withdrawal-suggestion-note" class="mt-3 text-xs font-bold text-indigo-700 dark:text-indigo-200"></p>
                <p id="dd-withdrawal-availability-description" class="mt-2 text-[10px] leading-5 text-slate-500">${availabilityDescription}</p>
                <p class="mt-1 text-[10px] leading-5 text-slate-500">The estimated withdrawal amount is limited by the available amount and the remaining cashback cap for the selected category. Cashback is also limited by the overall monthly cap configured for the card, after subtracting cashback already earned this month. Set the charge percentage for the selected category; the amount charged is calculated as withdrawal amount ÷ (1 − charge percentage ÷ 100). This does not account for issuer holds; confirm actual fees and cashback with your card issuer.</p>`;
        }
        function ddUpdateWithdrawalPlanner(source) {
            const cardSelect = document.getElementById('dd-withdrawal-card');
            const categorySelect = document.getElementById('dd-withdrawal-category');
            if (!cardSelect || !categorySelect) return;
            const card = activeCards().find(c => String(c.id) === cardSelect.value && c.cardType !== 'debit');
            if (!card) return;
            ddWithdrawalCardId = String(card.id);
            const categories = ddWithdrawalCategories(card);
            loadWithdrawalChargePercentages();
            ensureWithdrawalChargePercentages(categories);
            if (source && source.id === 'dd-withdrawal-category') {
                ddWithdrawalCategory = categorySelect.value;
            }
            ddWithdrawalCategory = categories.includes(ddWithdrawalCategory) ? ddWithdrawalCategory : (categories[0] || '');
            categorySelect.innerHTML = categories.length
                ? categories.map(category => `<option value="${escapeHtml(category)}" ${category === ddWithdrawalCategory ? 'selected' : ''}>${escapeHtml(category)} · ${fmtRate(cardRateFor(card, category))}%</option>`).join('')
                : '<option value="">No configured categories at 3% or higher</option>';
            categorySelect.disabled = categories.length === 0;
            categorySelect.value = ddWithdrawalCategory;
            const chargeInput = document.getElementById('dd-withdrawal-charge-percent');
            if (chargeInput) chargeInput.disabled = categories.length === 0;
            const ym = localDateKey().slice(0, 7);
            const monthTxs = cardTxList(card).filter(t => (t.date || '').startsWith(ym));
            const monthSpend = ddSum(monthTxs.filter(t =>
                txKind(t.type) === 'Purchase' || txKind(t.type) === 'Cash Withdrawal'
            ), t => t.amount);
            const limit = Math.max(0, ddNum(card.availableLimit));
            const availability = ddWithdrawalAvailability(card, monthTxs);
            const availableToWithdraw = availability.amount;
            const availabilityDescription = document.getElementById('dd-withdrawal-availability-description');
            if (availabilityDescription) availabilityDescription.textContent = availability.description;
            const amountInput = document.getElementById('dd-withdrawal-amount-input');
            if (!amountInput) return;
            if (!ddWithdrawalCategory) {
                amountInput.value = '0';
                const amountText = document.getElementById('dd-withdrawal-amount-text');
                if (amountText) amountText.textContent = 'AED 0.00';
                const suggestionNote = document.getElementById('dd-withdrawal-suggestion-note');
                if (suggestionNote) suggestionNote.textContent = 'This card has no configured cashback categories at 3% or higher.';
                document.getElementById('dd-withdrawal-amount-error').classList.add('hidden');
                document.getElementById('dd-withdrawal-availability-warning').classList.add('hidden');
                document.getElementById('dd-withdrawal-charge-error').classList.add('hidden');
                const emptyCategoryValues = {
                    'dd-withdrawal-limit': `AED ${formatAED(limit)}`,
                    'dd-withdrawal-spend': `AED ${formatAED(monthSpend)}`,
                    'dd-withdrawal-available': `AED ${formatAED(availableToWithdraw)}`,
                    'dd-withdrawal-deducted': '—',
                    'dd-withdrawal-rate': '—',
                    'dd-withdrawal-cashback-used': '—',
                    'dd-withdrawal-cap-remaining': '—',
                    'dd-withdrawal-cashback': '—',
                    'dd-withdrawal-charge': '—',
                    'dd-withdrawal-net': '—'
                };
                Object.entries(emptyCategoryValues).forEach(([id, value]) => {
                    const element = document.getElementById(id);
                    if (element) element.textContent = value;
                });
                return;
            }
            // Prefill the withdrawal amount from the remaining cashback cap of the selected category
            // whenever the card, category or charge % changes.
            const chargeEl = chargeInput;
            const resetAmount = !!chargeEl;
            const suggestionNote = document.getElementById('dd-withdrawal-suggestion-note');
            if (resetAmount) {
                let suggestPct = WITHDRAWAL_CHARGE_PERCENTAGES[ddWithdrawalCategory];
                if (source && source.id === 'dd-withdrawal-charge-percent') {
                    const typedPct = Number(chargeEl.value);
                    suggestPct = (chargeEl.value !== '' && Number.isFinite(typedPct) && typedPct >= 0 && typedPct < 100) ? typedPct : null;
                }
                if (suggestPct !== null) {
                    const suggestion = ddSuggestedWithdrawal(card, ddWithdrawalCategory, monthTxs, availableToWithdraw, suggestPct);
                    amountInput.value = String(suggestion.amount);
                    if (suggestionNote) {
                        suggestionNote.textContent =
                            suggestion.basis === 'cap' ? `Prefilled to use the remaining AED ${formatAED(suggestion.capRemaining)} cashback cap for ${ddWithdrawalCategory}.`
                            : suggestion.basis === 'norate' ? `No cashback rate for ${ddWithdrawalCategory} on this card.`
                            : 'No cashback cap set for this category; prefilled from the available limit.';
                        if (suggestion.basis === 'cap' && suggestion.capRemaining <= 0) suggestionNote.textContent = `No cashback cap remaining for ${ddWithdrawalCategory} this month.`;
                    }
                }
            }
            const amountText = document.getElementById('dd-withdrawal-amount-text');
            if (amountText) amountText.textContent = `AED ${formatAED(Number(amountInput.value) || 0)}`;
            const enteredAmount = Number(amountInput.value);
            const validAmount = amountInput.value !== '' && Number.isFinite(enteredAmount) && enteredAmount >= 0;
            amountInput.setCustomValidity(validAmount ? '' : 'Enter a withdrawal amount of zero or more.');
            amountInput.setAttribute('aria-invalid', String(!validAmount));
            document.getElementById('dd-withdrawal-amount-error').classList.toggle('hidden', validAmount);
            document.getElementById('dd-withdrawal-availability-warning').classList.toggle('hidden', !validAmount || enteredAmount <= availableToWithdraw);
            const chargeError = document.getElementById('dd-withdrawal-charge-error');
            if (!chargeInput) return;
            let validPercentage;
            if (source && source.id === 'dd-withdrawal-charge-percent') {
                const enteredPercentage = Number(chargeInput.value);
                validPercentage = chargeInput.value !== '' && Number.isFinite(enteredPercentage) && enteredPercentage >= 0 && enteredPercentage < 100;
                chargeInput.setCustomValidity(validPercentage ? '' : 'Enter a charge percentage from 0% up to (but not including) 100%.');
                chargeInput.setAttribute('aria-invalid', String(!validPercentage));
                chargeError.classList.toggle('hidden', validPercentage);
                if (validPercentage) {
                    WITHDRAWAL_CHARGE_PERCENTAGES[ddWithdrawalCategory] = enteredPercentage;
                    saveWithdrawalChargePercentages();
                }
            } else {
                chargeInput.value = String(WITHDRAWAL_CHARGE_PERCENTAGES[ddWithdrawalCategory]);
                chargeInput.setCustomValidity('');
                chargeInput.setAttribute('aria-invalid', 'false');
                chargeError.classList.add('hidden');
                validPercentage = true;
            }
            const chargePercentage = WITHDRAWAL_CHARGE_PERCENTAGES[ddWithdrawalCategory];
            if (!validAmount || !validPercentage) {
                ['dd-withdrawal-deducted', 'dd-withdrawal-cashback', 'dd-withdrawal-charge', 'dd-withdrawal-net'].forEach(id => {
                    document.getElementById(id).textContent = '—';
                });
                return;
            }
            const withdrawalAmount = enteredAmount;
            const chargeFactor = 1 - chargePercentage / 100;
            const amountCharged = withdrawalAmount / chargeFactor;
            const rate = cardRateFor(card, ddWithdrawalCategory);
            const potentialCashback = amountCharged * rate / 100;
            const cashbackUsedThisMonth = ddSum(monthTxs, t => t.cashback);
            const capRemaining = ddWithdrawalCapRemaining(card, ddWithdrawalCategory, monthTxs);
            const cashback = capRemaining === null ? potentialCashback : Math.min(potentialCashback, capRemaining);
            const withdrawalCharge = amountCharged - withdrawalAmount;
            const netCashback = cashback - withdrawalCharge;
            const values = {
                'dd-withdrawal-limit': `AED ${formatAED(limit)}`,
                'dd-withdrawal-spend': `AED ${formatAED(monthSpend)}`,
                'dd-withdrawal-available': `AED ${formatAED(availableToWithdraw)}`,
                'dd-withdrawal-deducted': `AED ${formatAED(amountCharged)}`,
                'dd-withdrawal-rate': `${fmtRate(rate)}%`,
                'dd-withdrawal-cashback-used': `AED ${formatAED(cashbackUsedThisMonth)}`,
                'dd-withdrawal-cap-remaining': capRemaining === null ? 'No cap set' : `AED ${formatAED(capRemaining)}`,
                'dd-withdrawal-cashback': `AED ${formatAED(cashback)}`,
                'dd-withdrawal-charge': `AED ${formatAED(withdrawalCharge)}`,
                'dd-withdrawal-net': `AED ${formatAED(netCashback)}`
            };
            Object.entries(values).forEach(([id, value]) => {
                const element = document.getElementById(id);
                if (element) element.textContent = value;
            });
        }
        // ---- Withdrawal planner: multi-card plan popup (pick cards, see estimated withdrawal + amount charged) ----
        let ddWpSelected = null;
        const ddWpCategory = {};
        const ddWpCustom = {}; // cardId -> typed withdrawal amount (this session only)
        const ddWpRound = ddLoad('dd-wp-round'); // cardId -> 0 (exact) | 10 | 100, remembered on this device
        function ddWpDefaultCategory(card) {
            const cats = ddWithdrawalCategories(card);
            if (String(card.id) === String(ddWithdrawalCardId) && cats.includes(ddWithdrawalCategory)) return ddWithdrawalCategory;
            return cats.slice().sort((a, b) => cardRateFor(card, b) - cardRateFor(card, a))[0] || '';
        }
        function ddWpCalc(card, category, applyRound = true) {
            loadWithdrawalChargePercentages();
            ensureWithdrawalChargePercentages([category]);
            const pct = WITHDRAWAL_CHARGE_PERCENTAGES[category];
            const ym = localDateKey().slice(0, 7);
            const monthTxs = cardTxList(card).filter(t => (t.date || '').startsWith(ym));
            const available = ddWithdrawalAvailability(card, monthTxs).amount;
            let amount = ddSuggestedWithdrawal(card, category, monthTxs, available, pct).amount;
            const suggested = amount;
            // A typed withdrawal amount overrides the estimate. Otherwise optional rounding per card:
            // round DOWN so the plan never exceeds the cashback cap or available limit.
            const custom = applyRound ? (Number(ddWpCustom[String(card.id)]) || 0) : 0;
            const step = applyRound ? (Number(ddWpRound[String(card.id)]) || 0) : 0;
            if (custom > 0) amount = custom;
            else if (step > 0) amount = Math.floor(amount / step) * step;
            const charged = amount / (1 - pct / 100);
            return { amount, charged, pct, available, step, custom: custom > 0, suggested };
        }
        function ddWpActiveCards() {
            return activeCards().filter(c => c.cardType !== 'debit' && ddWithdrawalCategories(c).length > 0);
        }
        function ddWpRefresh() {
            const root = document.getElementById('dd-wp-multi');
            if (!root) return;
            const cardsById = {};
            ddWpActiveCards().forEach(c => { cardsById[String(c.id)] = c; });
            let n = 0, totalAmount = 0, totalCharged = 0;
            root.querySelectorAll('[data-wp-row]').forEach(row => {
                const id = row.dataset.wpRow;
                const card = cardsById[id];
                if (!card) return;
                const category = ddWpCategory[id] || ddWpDefaultCategory(card);
                const on = ddWpSelected.has(id);
                const r = ddWpCalc(card, category, on);
                const roundLine = row.querySelector('[data-wp-round]');
                if (roundLine) roundLine.style.display = on ? '' : 'none';
                row.querySelector('[data-wp-amount]').textContent = 'AED ' + formatAED(r.amount);
                row.querySelector('[data-wp-charged]').textContent = 'AED ' + formatAED(r.charged);
                let meta = 'Charge ' + fmtRate(r.pct) + '%\nAvailable AED ' + formatAED(r.available);
                row.querySelector('[data-wp-meta]').textContent = meta;
                const warn = row.querySelector('[data-wp-warn]');
                if (warn) {
                    let msg = '', kind = '';
                    if (r.custom && r.charged > r.available + 0.005) {
                        msg = '⛔ Exceeds available limit — AED ' + formatAED(r.charged) + ' is AED ' + formatAED(r.charged - r.available) + ' over the AED ' + formatAED(r.available) + ' available';
                        kind = 'err';
                    } else if (r.custom && r.amount > r.suggested + 0.005) {
                        msg = '⚠️ Above estimated cashback cap — AED ' + formatAED(r.amount - r.suggested) + ' over the AED ' + formatAED(r.suggested) + ' estimate';
                        kind = 'warn';
                    }
                    warn.textContent = msg;
                    warn.className = 'dd-wp-warn' + (kind ? ' ' + kind : '');
                    warn.style.display = msg ? '' : 'none';
                }
                const radios = row.querySelector('[data-wp-radios]');
                if (radios) radios.style.opacity = r.custom ? '.45' : '';
                row.classList.toggle('dd-sel', on);
                const box = row.querySelector('input[type=checkbox]');
                if (box) box.checked = on;
                if (on) { n++; totalAmount += r.amount; totalCharged += r.charged; }
            });
            const all = root.querySelector('[data-wp-all]');
            const total = root.querySelectorAll('[data-wp-row]').length;
            if (all) { all.checked = total > 0 && n === total; all.indeterminate = n > 0 && n < total; }
            root.querySelector('[data-wp-count]').textContent = n + (n === 1 ? ' card selected' : ' cards selected');
            root.querySelector('[data-wp-total-amount]').textContent = 'AED ' + formatAED(totalAmount);
            root.querySelector('[data-wp-total-charged]').textContent = 'AED ' + formatAED(totalCharged);
        }
        function ddWpToggle(id, checked) {
            if (checked) ddWpSelected.add(String(id)); else ddWpSelected.delete(String(id));
            ddWpRefresh();
        }
        function ddWpToggleAll(checked) {
            ddWpActiveCards().forEach(c => { if (checked) ddWpSelected.add(String(c.id)); else ddWpSelected.delete(String(c.id)); });
            ddWpRefresh();
        }
        function ddWpSetRound(id, step) {
            ddWpRound[String(id)] = Number(step) || 0;
            ddSave('dd-wp-round', ddWpRound);
            ddWpRefresh();
        }
        function ddWpSetCustom(id, value) {
            const n = parseFloat(String(value).replace(/[^0-9.]/g, ''));
            if (n > 0) ddWpCustom[String(id)] = n; else delete ddWpCustom[String(id)];
            ddWpRefresh();
        }
        function ddWpSetCategory(id, category) {
            ddWpCategory[String(id)] = category;
            ddWpRefresh();
        }
        // One line per selected card: "Card - Category - Estimated withdrawal - Charged to card" (plain numbers, no thousands separators).
        function ddWpCopyText() {
            const byId = {};
            ddWpActiveCards().forEach(c => { byId[String(c.id)] = c; });
            const num = n => String(Number((Math.round((Number(n) || 0) * 100) / 100).toFixed(2)));
            const lines = [];
            let totalAmount = 0, totalCharged = 0;
            document.querySelectorAll('#dd-wp-multi [data-wp-row]').forEach(row => {
                const id = row.dataset.wpRow;
                if (!ddWpSelected.has(id) || !byId[id]) return;
                const card = byId[id];
                const category = ddWpCategory[id] || ddWpDefaultCategory(card);
                const r = ddWpCalc(card, category);
                totalAmount += r.amount;
                totalCharged += r.charged;
                // "Card Name 1234 - Category - Estimate - Charged": the card's last 4 digits follow its name (omitted if none is saved).
                const cardLabel = card.name + (card.last4 ? ' ' + card.last4 : '');
                lines.push([cardLabel, category, num(r.amount), num(r.charged)].join(' - '));
            });
            if (!lines.length) return { text: '', count: 0 };
            // Same totals that are shown at the bottom of the popup.
            const text = lines.join('\n') + '\n\nTotal withdrawal - ' + num(totalAmount) + '\nTotal charged to cards - ' + num(totalCharged);
            return { text: text, count: lines.length };
        }
        async function ddWpCopySelection(btn) {
            const copied = ddWpCopyText();
            const text = copied.text;
            if (!text) { showToast('Select at least one card to copy.', { tone: 'error' }); return; }
            let ok = false;
            try {
                if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); ok = true; }
            } catch (e) { ok = false; }
            if (!ok) {
                const ta = document.createElement('textarea');
                ta.value = text; ta.setAttribute('readonly', '');
                ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
                document.body.appendChild(ta); ta.select();
                try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
                ta.remove();
            }
            if (!ok) { showToast('Could not copy automatically on this device.', { tone: 'error' }); return; }
            const count = copied.count;
            showToast(count === 1 ? 'Copied 1 card.' : 'Copied ' + count + ' cards.');
            if (btn) {
                const original = btn.textContent;
                btn.textContent = '✓ Copied';
                setTimeout(() => { if (btn.isConnected) btn.textContent = original; }, 1500);
            }
        }
        function ddCloseWithdrawalMulti() {
            document.getElementById('dd-wp-multi')?.remove();
        }
        function ddOpenWithdrawalMulti() {
            const act = ddWpActiveCards();
            if (!act.length) return;
            const ids = new Set(act.map(c => String(c.id)));
            ddWpSelected = new Set([...(ddWpSelected || [])].filter(id => ids.has(id)));
            if (!ddWpSelected.size && ids.has(String(ddWithdrawalCardId))) ddWpSelected.add(String(ddWithdrawalCardId));
            ddCloseWithdrawalMulti();
            const lbl = 'text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400';
            const rows = act.map(c => {
                const id = String(c.id);
                const cats = ddWithdrawalCategories(c);
                if (!cats.includes(ddWpCategory[id])) ddWpCategory[id] = ddWpDefaultCategory(c);
                const options = cats.map(cat => '<option value="' + escapeHtml(cat) + '"' + (cat === ddWpCategory[id] ? ' selected' : '') + '>' + escapeHtml(cat) + ' · ' + fmtRate(cardRateFor(c, cat)) + '%</option>').join('');
                return '<div data-wp-row="' + escapeHtml(id) + '" class="dd-glass-row p-4 sm:grid sm:grid-cols-[28px_minmax(0,1.3fr)_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)] sm:items-center sm:gap-4">'
                    + '<div class="flex items-center gap-3 sm:contents">'
                    + '<input type="checkbox" onchange="ddWpToggle(\'' + escapeHtml(id) + '\', this.checked)" aria-label="Select ' + escapeHtml(c.name) + '" class="h-5 w-5 shrink-0 cursor-pointer accent-indigo-500">'
                    + '<div class="min-w-0"><p class="truncate text-sm font-semibold">' + escapeHtml(c.name) + '</p><p data-wp-meta class="mt-0.5 whitespace-pre-line text-[11px] leading-4 text-slate-500 dark:text-slate-400"></p></div>'
                    + '</div>'
                    + '<div class="mt-3 grid grid-cols-2 gap-2 sm:contents">'
                    + '<label class="col-span-2 block sm:col-span-1"><span class="' + lbl + ' sm:hidden">Category</span>'
                    + '<select onchange="ddWpSetCategory(\'' + escapeHtml(id) + '\', this.value)" aria-label="Cashback category for ' + escapeHtml(c.name) + '" class="dd-glass-input mt-1 w-full px-3 py-2 text-sm sm:mt-0">' + options + '</select></label>'
                    + '<div><p class="' + lbl + ' sm:hidden">Est. withdrawal</p><p data-wp-amount class="mono text-sm font-semibold text-indigo-700 dark:text-indigo-400 sm:text-right"></p></div>'
                    + '<div><p class="' + lbl + ' sm:hidden">Charged to card</p><p data-wp-charged class="mono text-sm font-semibold sm:text-right"></p></div>'
                    + '</div>'
                    + '<div data-wp-round class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-300/40 pt-3 text-xs dark:border-white/10 sm:col-span-5 sm:mt-0">'
                    + '<span class="' + lbl + '">Round estimate</span>'
                    + '<span data-wp-radios class="inline-flex flex-wrap items-center gap-x-4 gap-y-2">'
                    + [[0, 'Exact'], [10, 'Round 10'], [100, 'Round 100']].map(function (o) {
                        return '<label class="inline-flex cursor-pointer items-center gap-1.5 font-medium"><input type="radio" name="wp-round-' + escapeHtml(id) + '" value="' + o[0] + '"' + ((Number(ddWpRound[id]) || 0) === o[0] ? ' checked' : '') + ' onchange="ddWpSetRound(\'' + escapeHtml(id) + '\', ' + o[0] + ')" class="h-4 w-4 accent-indigo-500"> ' + o[1] + '</label>';
                    }).join('')
                    + '</span>'
                    + '<div class="flex w-full flex-col items-start gap-2 sm:ml-auto sm:w-auto sm:items-end"><label class="inline-flex items-center gap-2"><span class="' + lbl + '">Withdrawal amount</span>'
                    + '<input type="text" inputmode="decimal" autocomplete="off" placeholder="Auto" value="' + (ddWpCustom[id] ? escapeHtml(String(ddWpCustom[id])) : '') + '" oninput="ddWpSetCustom(\'' + escapeHtml(id) + '\', this.value)" aria-label="Withdrawal amount for ' + escapeHtml(c.name) + '" class="dd-glass-input mono w-32 px-3 py-1.5 text-right text-sm"></label>'
                    + '<p data-wp-warn class="dd-wp-warn" role="alert" style="display:none"></p></div>'
                    + '</div></div>';
            }).join('');
            const o = document.createElement('div');
            o.id = 'dd-wp-multi';
            o.className = 'dd-glass-overlay';
            o.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px';
            o.setAttribute('role', 'dialog');
            o.setAttribute('aria-modal', 'true');
            o.setAttribute('aria-label', 'Select cards for withdrawal plan');
            o.addEventListener('click', e => { if (e.target === o) ddCloseWithdrawalMulti(); });
            o.innerHTML = '<div class="dd-glass-panel flex max-h-[90vh] w-full max-w-3xl flex-col p-5 text-slate-800 dark:text-slate-200 sm:p-7">'
                + '<div class="mb-5 flex items-start justify-between gap-3"><div><p class="text-[10px] font-semibold uppercase tracking-[.2em] text-indigo-500 dark:text-indigo-300">Multi-card plan</p>'
                + '<h4 class="mt-1 text-lg font-bold">Select cards to withdraw from</h4>'
                + '<p class="mt-1 text-xs text-slate-500">Tick the cards you want to include. Each shows its estimated withdrawal and the amount that will be charged to the card.</p></div>'
                + '<button type="button" onclick="ddCloseWithdrawalMulti()" aria-label="Close" class="rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/10">✕</button></div>'
                + '<label class="mb-2 flex cursor-pointer items-center gap-3 px-[22px] text-xs font-medium text-slate-600 dark:text-slate-300"><input type="checkbox" data-wp-all onchange="ddWpToggleAll(this.checked)" class="h-5 w-5 accent-indigo-500"> Select all cards</label>'
                + '<div class="mb-1 hidden gap-4 px-[22px] sm:grid sm:grid-cols-[28px_minmax(0,1.3fr)_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)] ' + lbl + '"><span></span><span>Card</span><span>Category</span><span class="text-right">Est. withdrawal</span><span class="text-right">Charged to card</span></div>'
                + '<div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-1.5">' + rows + '</div>'
                + '<div class="dd-glass-total mt-4 grid grid-cols-2 gap-3 p-4">'
                + '<p data-wp-count class="col-span-2 text-xs font-semibold text-indigo-700 dark:text-indigo-300"></p>'
                + '<div><p class="' + lbl + '">Total withdrawal</p><p data-wp-total-amount class="mono mt-0.5 text-sm font-bold text-indigo-700 dark:text-indigo-300"></p></div>'
                + '<div><p class="' + lbl + '">Total charged to cards</p><p data-wp-total-charged class="mono mt-0.5 text-sm font-bold"></p></div></div>'
                + '<div class="mt-4 flex justify-end"><button type="button" data-wp-copy onclick="ddWpCopySelection(this)" class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500">📋 Copy selection</button></div></div>';
            document.body.appendChild(o);
            ddWpRefresh();
        }
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && document.getElementById('dd-wp-multi')) { e.stopPropagation(); ddCloseWithdrawalMulti(); }
        }, true);
        function ddOpenWithdrawalPlanner() {
            const act = activeCards().filter(c => c.cardType !== 'debit' && ddWithdrawalCategories(c).length > 0);
            const content = `<div class="mb-5">
                    <p class="text-[10px] font-semibold uppercase tracking-[.2em] text-indigo-500 dark:text-indigo-300">Withdrawal estimate</p>
                    <h4 class="mt-1 text-xl font-bold text-slate-900 dark:text-white">Cash withdrawal &amp; cashback</h4>
                    <p class="mt-1 text-xs text-slate-500">Choose a card and cashback category, then enter its withdrawal charge percentage to see the estimate.</p>
                </div>
                ${ddWithdrawalPlannerHtml(act)}
                ${act.length ? `<div class="mt-5 flex justify-end"><button type="button" onclick="ddOpenWithdrawalMulti()" class="inline-flex items-center gap-2 rounded-lg border border-indigo-400/40 bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-indigo-500">☑️ Plan withdrawals</button></div>` : ''}`;
            ddModal('Withdrawal Planner', content);
            ddUpdateWithdrawalPlanner();
        }
        function ddInsights(target) {
            target = ddNum(target) || 30;
            const act = activeCards().filter(c => c.cardType !== 'debit'), now = new Date(), ym = localDateKey().slice(0, 7);
            const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1), pym = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
            const recon = ddLoad('dd-recon'), dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(), d = now.getDate();
            let tl = 0, to = 0, projectedSpendTotal = 0, projectedCashbackTotal = 0, pay = '', fc = '', rc = '';
            act.forEach(c => {
                const lim = ddNum(c.availableLimit), out = Math.max(0, calculateOutstanding(cardTxList(c), localDateKey(), c).outstanding), txs = cardTxList(c), r = ddRule(c);
                tl += lim; to += out;
                const need = Math.max(0, out - lim * target / 100);
                const utilization = lim ? Math.min(100, out / lim * 100) : 0;
                pay += `<tr class="border-t border-white/5"><td class="py-3 pr-4 font-medium text-slate-200">${escapeHtml(c.name)}</td><td class="w-2/5 py-3 pr-4"><div class="flex items-center gap-3"><div class="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10"><div class="h-full rounded-full ${utilization >= 70 ? 'bg-rose-400' : utilization >= 30 ? 'bg-amber-300' : 'bg-emerald-400'}" style="width:${utilization}%"></div></div><span class="mono w-10 text-right text-[11px] text-slate-400">${utilization.toFixed(0)}%</span></div></td><td class="py-3 text-right mono text-xs ${need > 0 ? 'text-indigo-200' : 'text-emerald-300'}">${need > 0 ? 'AED ' + formatAED(need) : 'On target'}</td></tr>`;
                const m = txs.filter(t => (t.date || '').startsWith(ym)), sp = ddSum(m.filter(t => txKind(t.type) === 'Purchase' || txKind(t.type) === 'Cash Withdrawal'), t => t.amount), cb = ddSum(m, t => t.cashback);
                const pj = sp / d * dim, pc = cb / d * dim, ms = ddNum(r.minSpend);
                projectedSpendTotal += pj;
                projectedCashbackTotal += pc;
                const projectedUtilization = lim ? Math.min(100, pj / lim * 100) : 0;
                const forecastStatus = ms
                    ? (pj >= ms ? '<span class="text-emerald-300">On track for minimum spend</span>' : `<span class="text-amber-300">AED ${formatAED(ms - pj)} below minimum spend</span>`)
                    : '<span class="text-slate-500">No spend target set</span>';
                fc += `<article class="rounded-xl border border-white/[.07] bg-white/[.025] p-4">
                    <div class="flex flex-wrap items-start justify-between gap-3">
                        <div class="min-w-0"><h5 class="truncate text-sm font-semibold text-slate-100">${escapeHtml(c.name)}</h5><p class="mt-1 text-[11px] text-slate-500">${forecastStatus}</p></div>
                        <div class="text-right"><p class="mono text-sm font-semibold text-indigo-200">AED ${formatAED(pj)}</p><p class="mt-0.5 text-[10px] text-slate-500">Projected spend</p></div>
                    </div>
                    <div class="mt-4 grid grid-cols-2 gap-3">
                        <div class="rounded-lg bg-black/15 px-3 py-2"><p class="text-[10px] uppercase tracking-wider text-slate-500">Projected cashback</p><p class="mono mt-1 text-xs font-semibold text-emerald-300">AED ${formatAED(pc)}</p></div>
                        <div class="rounded-lg bg-black/15 px-3 py-2"><p class="text-[10px] uppercase tracking-wider text-slate-500">Spend vs. limit</p><p class="mono mt-1 text-xs font-semibold ${projectedUtilization >= 97 ? 'text-rose-300' : 'text-slate-200'}">${lim ? projectedUtilization.toFixed(0) + '%' : 'No limit set'}${lim && pj / lim > .97 ? ' · Near limit' : ''}</p></div>
                    </div>
                    ${lim ? `<div class="mt-3 h-1 overflow-hidden rounded-full bg-white/10"><div class="h-full rounded-full ${projectedUtilization >= 97 ? 'bg-rose-400' : 'bg-indigo-400'}" style="width:${projectedUtilization}%"></div></div>` : ''}
                </article>`;
                const exp = ddSum(txs.filter(t => (t.date || '').startsWith(pym)), t => t.cashback), got = (recon[c.id] || {})[pym];
                const diff = got === undefined || got === '' ? null : ddNum(got) - exp;
                rc += `<tr class="border-t border-white/5"><td class="py-3 pr-3 font-medium text-slate-200">${escapeHtml(c.name)}</td><td class="py-3 pr-3 mono text-xs text-slate-300">AED ${formatAED(exp)}</td><td class="py-3 pr-3"><label class="sr-only" for="recon-${escapeHtml(c.id)}">Cashback received for ${escapeHtml(c.name)}</label><input id="recon-${escapeHtml(c.id)}" type="number" step="0.01" min="0" value="${got ?? ''}" onchange="ddSaveRecon('${c.id}','${pym}',this.value)" placeholder="Enter amount" class="w-28 rounded-lg border border-white/10 bg-black/20 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-600"></td><td class="py-3 text-right mono text-xs ${diff !== null && Math.abs(diff) > .01 ? 'text-rose-300' : 'text-emerald-300'}">${diff === null ? '—' : (diff > 0 ? '+' : '') + formatAED(diff)}</td></tr>`;
                const yt = txs.filter(t => (t.date || '').startsWith(String(now.getFullYear())));
                c._yr = ddSum(yt, t => t.cashback);
                c._ys = ddSum(yt.filter(t => txKind(t.type) === 'Purchase'), t => t.amount);
            });
            const ranked = [...act].sort((a, b) => b._yr - a._yr);
            const cats = {}; transactions.filter(t => txKind(t.type) === 'Purchase' && (t.date || '').startsWith(String(now.getFullYear()))).forEach(t => { const k = t.category || 'Uncategorised'; cats[k] = (cats[k] || 0) + ddNum(t.amount); });
            const totalCashback = ddSum(act, c => c._yr), totalYearSpend = ddSum(act, c => c._ys);
            const topCategories = Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 5);
            const section = (eyebrow, title, description, content) => `<section class="mt-6 rounded-2xl border border-white/[.07] bg-white/[.02] p-4 sm:p-5">
                <div class="mb-4"><p class="text-[10px] font-semibold uppercase tracking-[.18em] text-indigo-300/80">${eyebrow}</p><h4 class="mt-1 text-base font-semibold text-slate-100">${title}</h4>${description ? `<p class="mt-1 text-xs text-slate-500">${description}</p>` : ''}</div>${content}</section>`;
            const table = (headers, rows) => act.length
                ? `<div class="overflow-x-auto"><table class="w-full min-w-[440px] text-left text-xs"><thead><tr class="text-[10px] uppercase tracking-wider text-slate-500">${headers.map((header, index) => `<th class="pb-2 font-medium ${index === headers.length - 1 ? 'text-right' : ''}">${header}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`
                : `<p class="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-xs text-slate-500">No card data to show yet.</p>`;
            const overallUtilization = tl ? to / tl * 100 : 0;
            const availableCredit = Math.max(0, tl - to);
            const yearSummary = `<div class="grid gap-3 sm:grid-cols-2">
                    <div class="rounded-xl border border-white/[.07] bg-white/[.025] p-4"><p class="text-[10px] uppercase tracking-wider text-slate-500">Cashback earned · ${now.getFullYear()}</p><p class="mono mt-2 text-lg font-semibold text-emerald-300">AED ${formatAED(totalCashback)}</p></div>
                    <div class="rounded-xl border border-white/[.07] bg-white/[.025] p-4"><p class="text-[10px] uppercase tracking-wider text-slate-500">Purchase spend · ${now.getFullYear()}</p><p class="mono mt-2 text-lg font-semibold text-slate-100">AED ${formatAED(totalYearSpend)}</p></div>
                </div>
                <div class="mt-3 grid gap-3 sm:grid-cols-2">
                    <div class="rounded-xl border border-white/[.07] bg-white/[.025] p-4"><p class="text-[10px] uppercase tracking-wider text-slate-500">Top cashback card</p><p class="mt-2 truncate text-sm font-semibold text-slate-100">${escapeHtml(ranked[0]?.name || 'No card activity')}</p><p class="mono mt-1 text-xs text-emerald-300">AED ${formatAED(ranked[0]?._yr || 0)}</p></div>
                    <div class="rounded-xl border border-white/[.07] bg-white/[.025] p-4"><p class="text-[10px] uppercase tracking-wider text-slate-500">Categories by spend</p><div class="mt-2 flex flex-wrap gap-2">${topCategories.length ? topCategories.map(([name, amount], index) => `<span class="rounded-full border border-white/[.08] bg-white/[.04] px-2.5 py-1 text-[10px] text-slate-300">${index + 1}. ${escapeHtml(name)} · AED ${formatAED(amount)}</span>`).join('') : '<span class="text-xs text-slate-500">No purchase data yet.</span>'}</div></div>
                </div>`;
            const content = `<div class="mb-5 flex flex-wrap items-end justify-between gap-3">
                    <div><p class="text-[10px] font-semibold uppercase tracking-[.2em] text-indigo-300">Portfolio overview</p><h4 class="mt-1 text-xl font-bold text-white">Insights &amp; forecast</h4><p class="mt-1 text-xs text-slate-500">A snapshot of card utilization, projected month-end rewards, and cashback performance.</p></div>
                    <span class="rounded-full border border-white/[.08] bg-white/[.04] px-3 py-1.5 text-[10px] font-medium text-slate-400">${act.length} active card${act.length === 1 ? '' : 's'} · ${monthLabel(ym)}</span>
                </div>
                <div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
                    <div class="rounded-xl border border-indigo-400/15 bg-indigo-400/[.06] p-4"><p class="text-[10px] uppercase tracking-wider text-slate-400">Portfolio utilization</p><p class="mono mt-2 text-xl font-semibold text-indigo-200">${overallUtilization.toFixed(0)}%</p><p class="mt-1 text-[10px] text-slate-500">Across active cards</p></div>
                    <div class="rounded-xl border border-white/[.07] bg-white/[.025] p-4"><p class="text-[10px] uppercase tracking-wider text-slate-400">Outstanding</p><p class="mono mt-2 text-lg font-semibold text-slate-100">AED ${formatAED(to)}</p><p class="mt-1 text-[10px] text-slate-500">Current card balances</p></div>
                    <div class="rounded-xl border border-emerald-400/15 bg-emerald-400/[.05] p-4"><p class="text-[10px] uppercase tracking-wider text-slate-400">Available credit</p><p class="mono mt-2 text-lg font-semibold text-emerald-200">AED ${formatAED(availableCredit)}</p><p class="mt-1 text-[10px] text-slate-500">Of AED ${formatAED(tl)} total limit</p></div>
                    <div class="rounded-xl border border-white/[.07] bg-white/[.025] p-4"><p class="text-[10px] uppercase tracking-wider text-slate-400">Month-end cashback</p><p class="mono mt-2 text-lg font-semibold text-emerald-300">AED ${formatAED(projectedCashbackTotal)}</p><p class="mt-1 text-[10px] text-slate-500">Projected from month-to-date</p></div>
                </div>
                ${section('Credit health', 'Utilization & payoff', 'Estimate the payment needed to bring each card down to your target utilization.', `<div class="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-white/[.06] bg-black/10 p-3"><label for="dd-target" class="text-xs text-slate-400">Target utilization</label><div class="flex items-center gap-2"><input id="dd-target" type="number" min="1" max="100" step="1" value="${target}" class="w-20 rounded-lg border border-white/10 bg-black/20 px-2 py-1.5 text-sm text-slate-100"><span class="text-xs text-slate-500">%</span><button type="button" onclick="ddInsights(document.getElementById('dd-target').value)" class="rounded-lg bg-indigo-500/15 px-3 py-1.5 text-xs font-semibold text-indigo-200 transition hover:bg-indigo-500/25">Update</button></div><span class="ml-auto text-[10px] text-slate-500">Portfolio average: ${overallUtilization.toFixed(0)}%</span></div>${table(['Card', 'Current utilization', 'Payment to target'], pay)}`)}
                ${section('Month-end projection', 'Spend & cashback forecast', 'Estimates month-end totals by extending current daily spend and cashback through the remaining days.', fc ? `<div class="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-indigo-400/10 bg-indigo-400/[.04] px-4 py-3"><span class="text-xs text-slate-400">Projected portfolio spend</span><span class="mono text-sm font-semibold text-indigo-200">AED ${formatAED(projectedSpendTotal)}</span></div><div class="grid gap-3 md:grid-cols-2">${fc}</div>` : '<p class="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-xs text-slate-500">Add an active card to see a month-end forecast.</p>')}
                ${section('Cashback tracking', `Reconciliation · ${pym}`, 'Compare last month’s expected cashback with the amount received from your bank.', table(['Card', 'Expected', 'Received', 'Difference'], rc))}
                ${section('Year in review', String(now.getFullYear()), 'Your cashback and spending highlights for this year.', yearSummary)}`;
            ddModal('Insights & Forecast', content);
        }
        function ddSaveRecon(id, ym, v) { const r = ddLoad('dd-recon'); (r[id] = r[id] || {})[ym] = v; ddSave('dd-recon', r); ddPushRecon(id, ym, v); ddInsights(document.getElementById('dd-target')?.value); }
        // ---- Sync rules + reconciliation with Supabase (localStorage stays as an offline cache) ----
        let ddDbWarned = false;
        function ddDbFail(e) { console.warn('DueDates rules sync:', e); if (!ddDbWarned) { ddDbWarned = true; showToast('Rules saved on this device only. Run duedates_rules_tables.sql in Supabase to sync.', { tone: 'error' }); } }
        async function ddPushRules(id, rules) {
            try { const { error } = await _supabase.from('card_rules').upsert({ user_id: currentUserId, card_id: String(id), rules, updated_at: new Date().toISOString() }, { onConflict: 'user_id,card_id' }); if (error) ddDbFail(error); } catch (e) { ddDbFail(e); }
        }
        async function ddPushRecon(id, month, v) {
            try { const { error } = await _supabase.from('cashback_recon').upsert({ user_id: currentUserId, card_id: String(id), month, received: v === '' ? null : ddNum(v), updated_at: new Date().toISOString() }, { onConflict: 'user_id,card_id,month' }); if (error) ddDbFail(error); } catch (e) { ddDbFail(e); }
        }
        async function ddLoadFromDB() {
            try {
                const [r1, r2] = await Promise.all([_supabase.from('card_rules').select('card_id,rules'), _supabase.from('cashback_recon').select('card_id,month,received')]);
                if (r1.error || r2.error) { ddDbFail(r1.error || r2.error); return; }
                const lr = ddLoad('dd-card-rules'), lc = ddLoad('dd-recon');
                if (!r1.data.length && !r2.data.length && (Object.keys(lr).length || Object.keys(lc).length)) {
                    // first run after the migration: push this device's saved rules up
                    for (const id of Object.keys(lr)) await ddPushRules(id, lr[id]);
                    for (const id of Object.keys(lc)) for (const m of Object.keys(lc[id])) await ddPushRecon(id, m, lc[id][m]);
                    return;
                }
                const rules = {}, recon = {};
                r1.data.forEach(x => { rules[x.card_id] = x.rules || {}; });
                r2.data.forEach(x => { (recon[x.card_id] = recon[x.card_id] || {})[x.month] = x.received ?? ''; });
                ddSave('dd-card-rules', rules); ddSave('dd-recon', recon); render();
            } catch (e) { ddDbFail(e); }
        }
        function updatePrivacyToggle(on) {
            const toggle = document.getElementById('privacy-mode-toggle');
            const track = document.getElementById('privacy-mode-track');
            const thumb = document.getElementById('privacy-mode-thumb');
            if (toggle) toggle.setAttribute('aria-checked', String(on));
            if (track) {
                track.classList.toggle('bg-indigo-500', on);
                track.classList.toggle('bg-slate-600', !on);
            }
            if (thumb) {
                thumb.classList.toggle('translate-x-3.5', on);
                thumb.classList.toggle('translate-x-0', !on);
            }
        }
        function togglePrivacy() {
            const on = document.body.classList.toggle('dd-private');
            ddSave('dd-privacy', { on });
            updatePrivacyToggle(on);
        }
        function updateThemeToggle(dark) {
            const toggle = document.getElementById('theme-mode-toggle');
            const label = document.getElementById('theme-mode-label');
            const track = document.getElementById('theme-mode-track');
            const thumb = document.getElementById('theme-mode-thumb');
            if (toggle) {
                toggle.setAttribute('aria-checked', String(dark));
                toggle.setAttribute('aria-label', dark ? 'Dark theme' : 'Light theme');
                toggle.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
            }
            if (label) label.textContent = dark ? 'Dark' : 'Light';
            if (track) {
                track.classList.toggle('bg-indigo-500', dark);
                track.classList.toggle('bg-slate-400', !dark);
            }
            if (thumb) {
                thumb.classList.toggle('translate-x-3.5', dark);
                thumb.classList.toggle('translate-x-0', !dark);
            }
        }
        function toggleTheme() {
            const dark = document.documentElement.classList.toggle('dark');
            try {
                localStorage.setItem('dd-theme', dark ? 'dark' : 'light');
            } catch (error) {
                console.warn('Could not save theme preference:', error);
            }
            updateThemeToggle(dark);
            Chart.defaults.color = dark ? '#94a3b8' : '#64748b';
            Chart.defaults.borderColor = dark ? '#1e2333' : '#e2e8f0';
            Object.values(Chart.instances || {}).forEach(chart => chart.update('none'));
        }
        (function () {
            const st = document.createElement('style');
            st.textContent = `
                .dd-private .mono,
                .dd-private .cc-amt,
                .dd-private #financial-performance-report .fp-val,
                .dd-private #financial-performance-report .fp-note,
                .dd-private #financial-performance-report .fp-outflow,
                .dd-private #financial-performance-report .fp-legend {
                    filter: blur(7px);
                    transition: filter .15s;
                }
                .dd-private .mono:hover,
                .dd-private .cc-amt:hover,
                .dd-private #financial-performance-report .fp-val:hover,
                .dd-private #financial-performance-report .fp-note:hover,
                .dd-private #financial-performance-report .fp-outflow:hover,
                .dd-private #financial-performance-report .fp-legend:hover {
                    filter: none;
                }
            `;
            document.head.appendChild(st);
            document.addEventListener('DOMContentLoaded', () => {
                const on = !!ddLoad('dd-privacy').on;
                document.body.classList.toggle('dd-private', on);
                updatePrivacyToggle(on);
                updateThemeToggle(document.documentElement.classList.contains('dark'));
            });
        })();

        const DD_RULE_FIELDS = ['fee', 'renewal', 'waiver', 'minSpend'];
        function toggleCardCapInput(checkbox) {
            const control = checkbox.closest('[data-cap-control]');
            const input = control && control.querySelector('input[type="number"]');
            if (!control || !input) return;
            input.disabled = !checkbox.checked;
            input.required = checkbox.checked;
            input.classList.toggle('border-indigo-400', checkbox.checked);
            input.classList.toggle('bg-indigo-50', checkbox.checked);
            input.classList.toggle('ring-2', checkbox.checked);
            input.classList.toggle('ring-indigo-500/20', checkbox.checked);
            input.classList.toggle('dark:border-indigo-400', checkbox.checked);
            input.classList.toggle('dark:bg-indigo-950/40', checkbox.checked);
            control.classList.toggle('border-indigo-300', checkbox.checked);
            control.classList.toggle('dark:border-indigo-500/50', checkbox.checked);
            const inputWrapper = control.querySelector('[data-cap-input-wrapper]');
            if (inputWrapper) {
                inputWrapper.style.display = checkbox.checked ? '' : 'none';
                inputWrapper.classList.toggle('border-indigo-300', checkbox.checked);
                inputWrapper.classList.toggle('dark:border-indigo-500/50', checkbox.checked);
            } else {
                input.style.display = checkbox.checked ? '' : 'none';
            }
        }
        function toggleAnnualFeeFields() {
            const feeApplies = document.getElementById('cr-annual-fee-paid').checked;
            const fields = document.getElementById('cr-annual-fee-fields');
            const feeInput = document.getElementById('cr-fee');
            const renewalInput = document.getElementById('cr-renewal');
            const waiverInput = document.getElementById('cr-waiver');
            fields.hidden = !feeApplies;
            fields.style.display = feeApplies ? 'grid' : 'none';
            feeInput.disabled = !feeApplies;
            feeInput.required = feeApplies;
            renewalInput.disabled = !feeApplies;
            waiverInput.disabled = !feeApplies;
        }
        function ddFillRulesForm(card) {
            const r = card ? ddRule(card) : {};
            const caps = ddCaps(r);
            DD_RULE_FIELDS.forEach(k => { document.getElementById('cr-' + k).value = r[k] ?? ''; });
            const hasAnnualFee = r.annualFeeType === 'paid' || (!r.annualFeeType && [r.fee, r.renewal, r.waiver].some(value => ddNum(value) > 0));
            document.getElementById(hasAnnualFee ? 'cr-annual-fee-paid' : 'cr-annual-fee-free').checked = true;
            toggleAnnualFeeFields();
            document.getElementById('cr-limit-cashback-spend').checked = r.limitCashbackSpendToMonthlyLimit !== false;
            const overallCapEnabled = Object.prototype.hasOwnProperty.call(caps, 'All');
            const overallCapCheckbox = document.getElementById('cr-cap-all-enabled');
            overallCapCheckbox.checked = overallCapEnabled;
            document.getElementById('cr-cap-all').value = overallCapEnabled ? caps.All : '';
            toggleCardCapInput(overallCapCheckbox);
            document.getElementById('card-rules-section').open = hasAnnualFee || DD_RULE_FIELDS.some(k => r[k]) || Object.keys(caps).length > 0;
        }
        function ddSaveRulesFromForm(id) {
            if (isDebit(cards.find(c => String(c.id) === String(id)))) { // debit cards: no fees, caps or cashback rules
                const store = ddLoad('dd-card-rules'); delete store[id]; ddSave('dd-card-rules', store); ddPushRules(id, {});
                return;
            }
            const rules = {};
            DD_RULE_FIELDS.forEach(k => { rules[k] = document.getElementById('cr-' + k).value.trim(); });
            const annualFeeApplies = document.getElementById('cr-annual-fee-paid').checked;
            rules.annualFeeType = annualFeeApplies ? 'paid' : 'free';
            if (!annualFeeApplies) {
                rules.fee = '';
                rules.renewal = '';
                rules.waiver = '';
            }
            rules.limitCashbackSpendToMonthlyLimit = document.getElementById('cr-limit-cashback-spend').checked;
            const caps = {};
            const overallCapCheckbox = document.getElementById('cr-cap-all-enabled');
            const overallCap = ddNum(document.getElementById('cr-cap-all').value);
            if (overallCapCheckbox.checked && overallCap > 0) caps.All = overallCap;
            Object.entries(getCardCategoryCapsFromForm()).forEach(([category, value]) => {
                const amount = ddNum(value);
                if (amount > 0) caps[category] = amount;
            });
            rules.caps = caps;
            const all = ddLoad('dd-card-rules'); all[id] = rules; ddSave('dd-card-rules', all); ddPushRules(id, rules);
        }
        function cardFooterHtml(c, ident) {
            const today = new Date(); today.setHours(0, 0, 0, 0);
            const footParts = [];
            if (c.last4) footParts.push(`•••• ${escapeHtml(c.last4)}`);
            if (c.statementDay) footParts.push(`Stmt: ${ordinalDay(Number(c.statementDay))}`);
            const left = `<span class="cc-foot">${footParts.length ? footParts.join(' · ') : '&nbsp;'}</span>`;
            let badge = '', alert = false;
            if (c.paymentDay) {
                const due = nextOccurrence(Number(c.paymentDay), today);
                const n = daysBetween(today, due);
                const tip = escapeHtml(`Payment due ${shortDate(due)}`);
                if (n === 0)       { badge = `<span class="cc-badge red" title="${tip}">${CC_ICON.alert} Due today</span>`; alert = true; }
                else if (n <= 10)  { badge = `<span class="cc-badge amber" title="${tip}">${CC_ICON.clock} Due in ${n}d</span>`; }
                else               { badge = `<span class="cc-badge green" title="${tip}">${CC_ICON.check} Due in ${n}d</span>`; }
            } else {
                badge = `<span class="cc-badge muted" title="Use Edit to set the statement and payment day">Set due date</span>`;
            }
            const identity = ident ? `
                <div class="cc-footer-identity ml-auto">
                    ${ident.tier ? `<span class="cc-pill">${escapeHtml(ident.tier)}</span>` : ''}
                    ${networkMarkHtml(ident)}
                </div>` : '';
            return { html: `<div class="cc-footer-main">${left}${badge}</div>${identity ? `<div class="cc-pay-row mt-2 justify-end">${identity}</div>` : ''}`, alert };
        }

        // Debit card tile: balance instead of outstanding / limit, no statement or payment dates.
        function debitTileHtml(c, ob, balance, monthSpend) {
            const theme = resolveCardColor(c.colorGradient);
            const ident = parseCardIdentity(c.name, { network: c.network, netVariant: c.netVariant, tier: c.tier });
            const chipClass = cardChipClass(theme);
            const opening = Number(c.availableLimit) || 0;
            const funds = balance + monthSpend; // money available at the start of this month
            const pct = funds > 0 ? Math.min(100, Math.round(monthSpend / funds * 100)) : (monthSpend > 0 ? 100 : 0);
            const barStyle = balance < 0 ? 'background: linear-gradient(90deg,#ef4444,#fb7185);'
                           : pct >= 90 ? 'background: linear-gradient(90deg,#f59e0b,#fbbf24);' : '';
            const balClass = balance < 0 ? 'text-red-400' : 'text-white';
            const identityHtml = `
                <div class="cc-footer-identity ml-auto">
                    ${ident.tier ? `<span class="cc-pill">${escapeHtml(ident.tier)}</span>` : ''}
                    ${networkMarkHtml(ident)}
                </div>`;
            const row = (label, value, sign, cls) => `
                <div class="flex justify-between"><span class="text-slate-500 dark:text-slate-400">${label}</span>
                <span class="font-medium ${cls || 'text-slate-700 dark:text-slate-300'}">${sign} ${formatAED(value)}</span></div>`;
            return `
                <div class="cc ${c.disabled ? 'cc-disabled' : ''} text-xs space-y-5" style="${cardThemeVars(theme)}">
                    ${cardWatermarkHtml(theme)}
                    <div class="cc-head flex flex-wrap items-center gap-x-3 gap-y-2">
                        <span class="cc-title">${escapeHtml(ident.title)}</span>
                        <button type="button" onclick="event.stopPropagation(); debitTopUp('${c.id}')" class="cc-pay-btn cc-pay-top text-[10px] font-semibold px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition">Add money</button>
                        ${c.disabled ? '<span class="cc-off-pill">Disabled</span>' : ''}
                    </div>
                    <div class="flex items-center gap-3">
                        <span class="cc-chip ${chipClass}"></span>
                        <div class="ml-auto flex items-center gap-1.5">
                            <button type="button" onclick="toggleCardDetails('${c.id}', this)" aria-expanded="${openCardDetails.has(c.id)}" class="cc-btn">${openCardDetails.has(c.id) ? 'Less' : 'More'}</button>
                            <button type="button" onclick="toggleCardMenu('${c.id}', event, this)" class="cc-btn cc-dots" aria-label="Card actions" aria-haspopup="menu" aria-expanded="false" title="Edit, disable or delete"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></button>
                        </div>
                    </div>
                    <div class="cc-metrics">
                        <div class="cc-metric">
                            <p class="cc-lbl">Balance</p>
                            <p class="cc-amt mt-1 ${balClass}"><span class="cc-currency">AED</span> ${formatAED(balance)}</p>
                        </div>
                        <div class="cc-metric cc-metric-limit">
                            <p class="cc-lbl">Spent this month</p>
                            <p class="cc-limit mt-1"><span class="cc-currency">AED</span> ${formatAED(monthSpend)}</p>
                        </div>
                    </div>
                    <div class="cc-track" title="AED ${formatAED(monthSpend)} spent this month">
                        <div class="cc-fill" style="width: ${pct}%; ${barStyle}"></div>
                    </div>
                    <div class="cc-footer-main"><span class="cc-foot">${c.last4 ? '•••• ' + escapeHtml(c.last4) : '&nbsp;'}</span>${balance < 0 ? '<span class="cc-badge red">Overdrawn</span>' : ''}</div>
                    ${(ident.tier || ident.network) ? `<div class="cc-pay-row mt-2 justify-end">${identityHtml}</div>` : ''}
                    <div id="card-details-${c.id}" class="${openCardDetails.has(c.id) ? '' : 'hidden'} cc-more pt-4 space-y-2">
                        <details ${openCalcCards.has(c.id) ? 'open' : ''} ontoggle="setCalcOpen('${c.id}', this.open)">
                            <summary class="cursor-pointer text-[11px] text-indigo-300 hover:text-indigo-200 font-medium select-none">How it's calculated</summary>
                            <div class="mt-2 space-y-1 text-[11px]">
                                ${row('Opening balance', opening, '')}
                                ${row('Deposits / top-ups', ob.repaid, '+', 'text-emerald-600')}
                                ${row('Purchases', ob.purchases, '−')}
                                ${row('Cash withdrawals', ob.withdrawals, '−')}
                                ${row('Transfers in', ob.transferIn, '+', 'text-emerald-600')}
                                ${row('Transfers out', ob.transferOut, '−')}
                                <div class="flex justify-between pt-1 mt-1 border-t border-slate-200 dark:border-slate-600 font-semibold text-slate-800 dark:text-slate-200">
                                    <span>Balance today</span><span>= ${formatAED(balance)}</span>
                                </div>
                            </div>
                        </details>
                    </div>
                </div>`;
        }
        // "Add money" on a debit card: logs a deposit (stored as a 'Repaid' row so every report keeps working).
        async function debitTopUp(cardId) {
            const c = cards.find(x => String(x.id) === String(cardId));
            if (!c) return;
            const input = prompt(`Add money to ${c.name}. Amount (AED):`, '');
            if (input === null) return;
            const amount = parseFloat(input);
            if (isNaN(amount) || amount <= 0) { showToast('Enter an amount above 0.', { tone: 'error' }); return; }
            const tx = {
                id: newId(), date: localDateKey(), cardName: c.name, cardId: c.id, type: 'Repaid',
                desc: 'Deposit / top-up', category: '', amount, serviceCharge: 0, cashback: 0, notes: 'Added to debit card balance'
            };
            transactions.unshift(tx);
            const ok = await saveTransactionToDB(tx);
            render();
            if (ok !== false) showToast(`AED ${formatAED(amount)} added to ${c.name}.`, { tone: 'success' });
        }

        function renderCardsList() {
            const container = document.getElementById('cards-list');
            const totalEl = document.getElementById('total-outstanding');
            const totalLimitEl = document.getElementById('total-limit');
            const banner = document.getElementById('no-cards-banner');
            const toggleRow = document.getElementById('disabled-toggle-row');
            const disabledCount = cards.length - activeCards().length;
            const visibleCards = showDisabledCards ? cards : activeCards();
            const cardCountEl = document.getElementById('saved-card-count');
            const visibilityToggle = document.getElementById('saved-cards-visibility-toggle');
            if (cardCountEl) cardCountEl.textContent = `${cards.length} ${cards.length === 1 ? 'card' : 'cards'} saved`;
            if (visibilityToggle) {
                visibilityToggle.setAttribute('aria-checked', String(showSavedCards));
                visibilityToggle.setAttribute('aria-label', showSavedCards ? 'Hide saved cards' : 'Show saved cards');
                visibilityToggle.title = showSavedCards ? 'Hide saved cards' : 'Show saved cards';
                visibilityToggle.firstElementChild.textContent = showSavedCards ? 'Show' : 'Hide';
                visibilityToggle.setAttribute('aria-expanded', String(showSavedCards));
                visibilityToggle.classList.toggle('hidden', cards.length === 0);
            }
            if (container) container.classList.toggle('hidden', !showSavedCards);
            if (toggleRow) toggleRow.classList.toggle('hidden', !showSavedCards || disabledCount === 0);
            if (toggleRow) {
                toggleRow.innerHTML = disabledCount === 0 ? '' : `
                    <button type="button" role="switch" aria-checked="${showDisabledCards}" aria-label="${showDisabledCards ? 'Hide Disabled Cards' : 'Show Disabled Cards'}" title="${showDisabledCards ? 'Hide Disabled Cards' : 'Show Disabled Cards'}" onclick="setShowDisabledCards(!showDisabledCards)"
                        class="flex items-center gap-2 text-xs text-slate-400 hover:text-slate-200 transition select-none">
                        <span style="position:relative;display:inline-block;width:32px;height:18px;border-radius:999px;transition:background .2s;background:${showDisabledCards ? '#6366f1' : '#334155'}">
                            <span style="position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:999px;background:#fff;transition:transform .2s;transform:translateX(${showDisabledCards ? '14px' : '0'})"></span>
                        </span>
                        ${showDisabledCards ? 'Hide Disabled Cards' : 'Show Disabled Cards'}
                    </button>`;
            }
            if (cards.length === 0) {
                if (banner) banner.classList.remove('hidden');
                container.innerHTML = `
                    <div class="col-span-full text-center py-6 px-4 border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-xl">
                        <p class="text-2xl mb-1">💳</p>
                        <p class="text-sm font-semibold text-slate-600 dark:text-slate-400">No cards yet</p>
                        <p class="text-xs text-slate-400 dark:text-slate-500 mt-1">Click "+ Manage" above to add your first card — the dashboard, charts and recommender will fill in once you do.</p>
                    </div>`;
                totalEl.innerHTML = '';
                totalLimitEl.innerHTML = '';
                updateShellWidgets(0, 0);
                return;
            }
            if (banner) banner.classList.add('hidden');

            if (visibleCards.length === 0) {
                container.innerHTML = `
                    <div class="col-span-full text-center py-6 px-4 border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-xl">
                        <p class="text-2xl mb-1">⏸️</p>
                        <p class="text-sm font-semibold text-slate-600 dark:text-slate-400">All your cards are disabled</p>
                        <p class="text-xs text-slate-400 dark:text-slate-500 mt-1">Turn on "Show disabled cards" to see them and enable one again. Your transactions are untouched.</p>
                    </div>`;
                totalEl.innerHTML = '';
                totalLimitEl.innerHTML = '';
                updateShellWidgets(0, 0);
                return;
            }

            const todayKey = localDateKey();
            const currentMonthKey = todayKey.substring(0, 7);

            let grandOutstanding = 0;
            let grandPending = 0;
            let debitTotal = 0, debitCount = 0;

            const calcRow = (label, value, sign, cls = 'text-slate-700 dark:text-slate-300') => `
                <div class="flex justify-between">
                    <span class="text-slate-500 dark:text-slate-400">${label}</span>
                    <span class="font-medium ${cls}">${sign} ${formatAED(value)}</span>
                </div>`;

            // Debit cards first, then credit cards; each group gets a heading when both kinds exist.
            const orderedCards = [...visibleCards.filter(isDebit), ...visibleCards.filter(c => !isDebit(c))];
            const tileHtml = orderedCards.map(c => {
                const totalLimit = Number(c.availableLimit) || 0;
                const targetLimit = totalLimit * 0.97;

                const cardTx = cardTxList(c);

                const currentMonthSpend = cardTx
                    .filter(t => t.date && t.date.startsWith(currentMonthKey) &&
                                 (txKind(t.type) === 'Purchase' || txKind(t.type) === 'Cash Withdrawal'))
                    .reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);

                const percentage = targetLimit > 0 ? Math.min(Math.round((currentMonthSpend / targetLimit) * 100), 100) : 0;
                const rawPercentageOfTotal = totalLimit > 0 ? (currentMonthSpend / totalLimit) * 100 : 0;

                let barColor = 'bg-indigo-500';
                if (rawPercentageOfTotal >= 90 && rawPercentageOfTotal < 97) {
                    barColor = 'bg-amber-500';
                } else if (rawPercentageOfTotal >= 97) {
                    barColor = 'bg-red-500';
                }

                const ob = calculateOutstanding(cardTx, todayKey, c);
                if (isDebit(c)) {
                    const bal = totalLimit - ob.outstanding;
                    if (!c.disabled) { debitTotal += bal; debitCount++; }
                    return debitTileHtml(c, ob, bal, currentMonthSpend);
                }
                const dateInfo = getCardDateInfo(c);
                grandOutstanding += ob.outstanding;
                grandPending += ob.cashbackPending;

                const obClass = ob.outstanding < 0 ? 'text-emerald-400' : 'text-white';
                const obSuffix = ob.outstanding < 0 ? ' (credit)' : '';

                const pendingHtml = ob.cashbackPending > 0 ? `
                    <div class="space-y-1.5">
                        ${Object.entries(ob.cashbackPendingByDate).sort(([a], [b]) => a.localeCompare(b)).map(([date, amount]) => `
                            <div class="flex justify-between items-center rounded-md bg-emerald-50 dark:bg-emerald-950 px-2 py-1.5 text-[11px]">
                                <span class="text-emerald-700 dark:text-emerald-400">Cashback · ${formatCashbackCreditDate(date)}</span>
                                <span class="font-semibold text-emerald-700 dark:text-emerald-400">− ${formatAED(amount)}</span>
                            </div>`).join('')}
                    </div>
                    <div class="flex justify-between text-[11px]">
                        <span class="text-slate-500 dark:text-slate-400">Outstanding after all pending cashback credits</span>
                        <span class="font-semibold text-slate-800 dark:text-slate-200">AED ${formatAED(ob.afterPending)}</span>
                    </div>` : '';

                // Active EMI plans: Purchases on this card converted to installments that
                // still have unpaid months. The full purchase amount is already counted in
                // "Outstanding today" above (it hit the limit like any purchase) — this is
                // just a reminder of what's left to pay off and by how much each month.
                const activeEmis = cardTx.filter(t => t.type === 'Purchase' && t.emiTotalMonths && (t.emiRemainingMonths || 0) > 0);
                const emiHtml = activeEmis.length > 0 ? `
                    <div class="pt-2 border-t border-dashed border-slate-200 dark:border-slate-600 space-y-1.5">
                        <span class="text-[11px] font-semibold uppercase text-slate-500 dark:text-slate-400">Active Installments (${activeEmis.length})</span>
                        ${activeEmis.map(t => {
                            const paidSoFar = t.emiPaidMonths || 0;
                            // For first unpaid month with processing fee, show emiFirstMonthAmount
                            const nextPaymentAmount = (paidSoFar === 0 && t.emiChargeType === 'fee' && t.emiFirstMonthAmount)
                                ? t.emiFirstMonthAmount
                                : t.emiMonthlyAmount;
                            return `
                            <div class="flex items-center justify-between gap-2 text-[11px] bg-slate-100 dark:bg-slate-800 rounded-md px-2 py-1.5">
                                <div class="min-w-0">
                                    <p class="font-medium text-slate-700 dark:text-slate-300 truncate">${escapeHtml(t.desc || 'Purchase')}</p>
                                    <p class="text-slate-500 dark:text-slate-400">AED ${formatAED(nextPaymentAmount)}/mo · ${t.emiRemainingMonths} of ${t.emiTotalMonths} left</p>
                                </div>
                                <button onclick="logEmiInstallment('${t.id}')" class="shrink-0 bg-indigo-600 hover:bg-indigo-700 text-white font-medium px-2 py-1 rounded-md transition">Log Payment</button>
                            </div>
                        `;
                        }).join('')}
                    </div>` : '';

                // Premium tile: theme comes from the saved card colour, badge/logo from the card name.
                const theme = resolveCardColor(c.colorGradient);
                const ident = parseCardIdentity(c.name, { network: c.network, netVariant: c.netVariant, tier: c.tier });
                const footer = cardFooterHtml(c, ident);
                const chipClass = cardChipClass(theme);
                // spend bar keeps the theme colour; it only overrides when usage gets high
                const barStyle = rawPercentageOfTotal >= 97 ? 'background: linear-gradient(90deg,#ef4444,#fb7185);'
                               : rawPercentageOfTotal >= 90 ? 'background: linear-gradient(90deg,#f59e0b,#fbbf24);' : '';

                return `
                    <div class="cc ${footer.alert && !c.disabled ? 'cc-alert' : ''} ${c.disabled ? 'cc-disabled' : ''} text-xs space-y-5" style="${cardThemeVars(theme)}">
                        ${cardWatermarkHtml(theme)}
                        <div class="cc-head flex flex-wrap items-center gap-x-3 gap-y-2">
                            <span class="cc-title">${escapeHtml(ident.title)}</span>
                            <button type="button" onclick="event.stopPropagation(); markCardPaid('${c.id}')" class="cc-pay-btn cc-pay-top text-[10px] font-semibold px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition">Mark paid</button>
                            ${c.disabled ? '<span class="cc-off-pill">Disabled</span>' : ''}
                        </div>
                        <div class="flex items-center gap-3">
                            <span class="cc-chip ${chipClass}"></span>
                            <!--
                            ${CC_ICON.coins}
                            -->
                            <div class="ml-auto flex items-center gap-1.5">
                                <button type="button" onclick="toggleCardDetails('${c.id}', this)" aria-expanded="${openCardDetails.has(c.id)}" class="cc-btn">${openCardDetails.has(c.id) ? 'Less' : 'More'}</button>
                                <button type="button" onclick="toggleCardMenu('${c.id}', event, this)" class="cc-btn cc-dots" aria-label="Card actions" aria-haspopup="menu" aria-expanded="false" title="Edit, disable or delete"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></button>
                            </div>
                        </div>
                        <div class="cc-metrics">
                            <div class="cc-metric">
                                <p class="cc-lbl">Outstanding</p>
                                <p class="cc-amt mt-1 ${obClass}"><span class="cc-currency">AED</span> ${formatAED(ob.outstanding)}<span class="text-[10px] font-medium">${obSuffix}</span></p>
                            </div>
                            <div class="cc-metric cc-metric-limit">
                                <p class="cc-lbl">Limit</p>
                                <p class="cc-limit mt-1"><span class="cc-currency">AED</span> ${formatAED(totalLimit)}</p>
                            </div>
                        </div>
                        <div class="cc-track" title="AED ${currentMonthSpend.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} spent this month · ${rawPercentageOfTotal.toFixed(1)}% of limit">
                            <div class="cc-fill" style="width: ${percentage}%; ${barStyle}"></div>
                        </div>
                        ${footer.html}
                        <div id="card-details-${c.id}" class="${openCardDetails.has(c.id) ? '' : 'hidden'} cc-more pt-4 space-y-2">
                            <div class="flex justify-between text-[11px]">
                                <span class="text-slate-400">Remaining limit</span>
                                <span class="mono font-semibold text-slate-100">AED ${formatAED(totalLimit - ob.outstanding)}</span>
                            </div>
                            <div class="flex justify-between text-[11px]">
                                <span class="text-slate-400">Spend this month</span>
                                <span class="mono ${rawPercentageOfTotal >= 97 ? 'text-red-400 font-bold' : 'text-slate-200'}">AED ${currentMonthSpend.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} · ${rawPercentageOfTotal.toFixed(1)}%</span>
                            </div>
                            <details ${openCalcCards.has(c.id) ? 'open' : ''} ontoggle="setCalcOpen('${c.id}', this.open)">
                                <summary class="cursor-pointer text-[11px] text-indigo-300 hover:text-indigo-200 font-medium select-none">How it's calculated</summary>
                                <div class="mt-2 space-y-1 text-[11px]">
                                    ${calcRow('Purchases', ob.purchases, '+')}
                                    ${calcRow('Cash withdrawals', ob.withdrawals, '+')}
                                    ${INCLUDE_FEES_IN_OUTSTANDING ? calcRow('Service fees', ob.fees, '+') : ''}
                                    ${calcRow('Repaid', ob.repaid, '−', 'text-emerald-600')}
                                    ${calcRow('Transfers in', ob.transferIn, '−', 'text-emerald-600')}
                                    ${calcRow('Transfers out', ob.transferOut, '+')}
                                    ${calcRow('Cashback already credited', ob.cashbackCredited, '−', 'text-emerald-600')}
                                    <div class="flex justify-between pt-1 mt-1 border-t border-slate-200 dark:border-slate-600 font-semibold text-slate-800 dark:text-slate-200">
                                        <span>Outstanding today</span>
                                        <span>= ${formatAED(ob.outstanding)}</span>
                                    </div>
                                </div>
                            </details>
                            ${pendingHtml}
                            ${emiHtml}
                            ${ddTileExtras(c)}
                        </div>
                    </div>
                `;
            });
            const hasBoth = orderedCards.some(isDebit) && orderedCards.some(c => !isDebit(c));
            const groupHeading = text => `<div class="col-span-full text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">${text}</div>`;
            let tilesOut = '';
            orderedCards.forEach((c, i) => {
                if (hasBoth && (i === 0 || isDebit(c) !== isDebit(orderedCards[i - 1]))) tilesOut += groupHeading(isDebit(c) ? 'Debit cards' : 'Credit cards');
                tilesOut += tileHtml[i];
            });
            container.innerHTML = tilesOut;

            const grandLimit = visibleCards.filter(c => !isDebit(c)).reduce((sum, c) => sum + (Number(c.availableLimit) || 0), 0);
            const hiddenOffCount = showDisabledCards ? 0 : disabledCount;
            totalLimitEl.innerHTML = `
                <p class="text-[10px] font-semibold uppercase text-slate-500 dark:text-slate-400">Total Card Limit</p>
                <p class="text-xl font-bold text-slate-900 dark:text-slate-100">AED ${formatAED(grandLimit)}</p>
                ${debitCount > 0 ? `<p class="text-[10px] text-slate-500 dark:text-slate-400">Debit balance (${debitCount} card${debitCount === 1 ? '' : 's'}): AED ${formatAED(debitTotal)}</p>` : ''}
                ${hiddenOffCount > 0 ? `<p class="text-[10px] text-amber-400/80">${hiddenOffCount} disabled card${hiddenOffCount === 1 ? '' : 's'} excluded</p>` : ''}
            `;

            const totalClass = grandOutstanding < 0 ? 'text-emerald-600' : 'text-slate-900 dark:text-slate-100';
            totalEl.innerHTML = `
                <p class="text-[10px] font-semibold uppercase text-slate-500 dark:text-slate-400">Total Outstanding</p>
                <p class="text-xl font-bold ${totalClass}">AED ${formatAED(grandOutstanding)}</p>
                ${grandPending > 0 ? `<p class="text-[10px] text-emerald-600 dark:text-emerald-500">${formatAED(grandPending)} cashback pending across all cards</p>` : ''}
            `;
            updateShellWidgets(grandOutstanding, grandPending);
        }

        function renderCardFilters() {
            const container = document.getElementById('card-filter-container');
            const categoryWrapper = document.getElementById('category-filter-wrapper');
            const monthWrapper = document.getElementById('month-filter-container');
            const uniqueCardNames = filterableCardNames();
            const offNames = disabledCardNames();

            let html = `
                <button onclick="setCardFilter('ALL')" class="px-3 py-1.5 text-xs font-semibold rounded-lg transition whitespace-nowrap ${activeCardFilter === 'ALL' ? 'bg-indigo-600 text-white shadow-sm' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'}">
                    All Cards
                </button>
            `;

            uniqueCardNames.forEach(cardName => {
                const isActive = activeCardFilter === cardName;
                html += `
                    <button onclick="setCardFilter('${cardName.replace(/'/g, "\\'")}')" class="px-3 py-1.5 text-xs font-semibold rounded-lg transition whitespace-nowrap ${isActive ? 'bg-indigo-600 text-white shadow-sm' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'}">
                        💳 ${escapeHtml(cardName)}${offNames.has(cardName) ? ' <span class="opacity-70">· disabled</span>' : ''}
                    </button>
                `;
            });

            // Same switch as the Saved Cards header, kept next to the filters for convenience.
            if (offNames.size > 0) {
                html += `
                    <button onclick="setShowDisabledCards(!showDisabledCards)" title="Include cards you have disabled in the filter list"
                        class="px-3 py-1.5 text-xs font-semibold rounded-lg transition whitespace-nowrap border border-dashed ${showDisabledCards ? 'border-indigo-400 text-indigo-300 bg-indigo-500/10' : 'border-slate-500/60 text-slate-400 hover:text-slate-200'}">
                        ${showDisabledCards ? '✓ ' : ''}Show disabled (${offNames.size})
                    </button>`;
            }

            container.innerHTML = html;
            renderHistoryCardFilter();
            renderHistoryCategoryFilter();

            if (activeCardFilter === 'ALL') {
                categoryWrapper.classList.add('hidden');
            } else {
                categoryWrapper.classList.remove('hidden');
                const cardCategories = Array.from(new Set(
                    transactions
                        .filter(t => t.cardName.trim() === activeCardFilter && t.category)
                        .map(t => t.category.trim())
                ));

                const allCatsSelected = selectedCategories.length === 0;
                let catHtml = `
                    <button onclick="clearCategoryFilter()" class="px-2.5 py-1 text-[11px] font-medium rounded-md transition whitespace-nowrap ${allCatsSelected ? 'bg-indigo-500 dark:bg-indigo-600 text-white shadow-sm' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'}">
                        All Categories
                    </button>
                `;

                cardCategories.forEach(cat => {
                    const isCatActive = selectedCategories.includes(cat);
                    catHtml += `
                        <button onclick="toggleCategoryFilter('${cat.replace(/'/g, "\\'")}')" class="px-2.5 py-1 text-[11px] font-medium rounded-md transition whitespace-nowrap ${isCatActive ? 'bg-indigo-500 dark:bg-indigo-600 text-white shadow-sm' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'}">
                            ${isCatActive ? '✓ ' : '🏷️ '}${cat}
                        </button>
                    `;
                });

                categoryWrapper.innerHTML = catHtml;
            }

            const uniqueMonths = Array.from(new Set(
                transactions
                    .filter(t => {
                        const matchesCard = (activeCardFilter === 'ALL' || t.cardName.trim() === activeCardFilter);
                        const matchesCategory = (selectedCategories.length === 0 || (t.category && selectedCategories.includes(t.category.trim())));
                        return matchesCard && matchesCategory;
                    })
                    .map(t => t.date ? t.date.substring(0, 7) : '')
                    .filter(Boolean)
            )).sort().reverse(); // newest first

            const allSelected = selectedMonths.length === 0;

            let monthHtml = `
                <button onclick="clearMonthFilter()" class="px-2.5 py-1 text-[11px] font-medium rounded-md transition whitespace-nowrap ${allSelected ? 'bg-indigo-500 dark:bg-indigo-600 text-white shadow-sm' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'}">
                    All Months
                </button>
            `;

            /*
            if (uniqueMonths.length >= 2) {
                monthHtml += `
                    <button onclick="selectLastNMonths(2)" class="px-2.5 py-1 text-[11px] font-medium rounded-md transition whitespace-nowrap bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600">
                        Last 2 Months
                    </button>`;
            }
            if (uniqueMonths.length >= 3) {
                monthHtml += `
                    <button onclick="selectLastNMonths(3)" class="px-2.5 py-1 text-[11px] font-medium rounded-md transition whitespace-nowrap bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600">
                        Last 3 Months
                    </button>`;
            }
            */

            uniqueMonths.forEach(m => {
                const isMonthActive = selectedMonths.includes(m);
                monthHtml += `
                    <button onclick="toggleMonthFilter('${m}')" class="px-2.5 py-1 text-[11px] font-medium rounded-md transition whitespace-nowrap ${isMonthActive ? 'bg-indigo-500 dark:bg-indigo-600 text-white shadow-sm' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'}">
                        ${isMonthActive ? '✓ ' : '📅 '}${m}
                    </button>
                `;
            });

            monthWrapper.innerHTML = monthHtml;

            let filterText = `Filter: ${activeCardFilter === 'ALL' ? 'All Cards' : activeCardFilter}`;
            if (activeCardFilter !== 'ALL' && selectedCategories.length > 0) {
                filterText += ` → ${[...selectedCategories].sort().join(', ')}`;
            }
            if (selectedMonths.length > 0) {
                filterText += ` (${[...selectedMonths].sort().join(', ')})`;
            }
            if (activeTypeFilter !== 'ALL') {
                filterText += ` · ${activeTypeFilter}`;
            }
            document.getElementById('active-filter-label').textContent = filterText;
        }

        function setCardFilter(cardName) {
            activeCardFilter = cardName;
            selectedCategories = [];
            renderCardFilters();
            renderTransactionsAndMetrics();
        }

        function toggleCategoryFilter(categoryName) {
            if (selectedCategories.includes(categoryName)) {
                selectedCategories = selectedCategories.filter(c => c !== categoryName);
            } else {
                selectedCategories = [...selectedCategories, categoryName];
            }
            renderCardFilters();
            renderTransactionsAndMetrics();
        }

        function clearCategoryFilter() {
            selectedCategories = [];
            renderCardFilters();
            renderTransactionsAndMetrics();
        }

        function toggleMonthFilter(month) {
            if (selectedMonths.includes(month)) {
                selectedMonths = selectedMonths.filter(m => m !== month);
            } else {
                selectedMonths = [...selectedMonths, month];
            }
            renderCardFilters();
            renderTransactionsAndMetrics();
        }

        function clearMonthFilter() {
            selectedMonths = [];
            renderCardFilters();
            renderTransactionsAndMetrics();
        }

        function selectLastNMonths(n) {
            const availableMonths = Array.from(new Set(
                transactions
                    .filter(t => {
                        const matchesCard = (activeCardFilter === 'ALL' || t.cardName.trim() === activeCardFilter);
                        const matchesCategory = (selectedCategories.length === 0 || (t.category && selectedCategories.includes(t.category.trim())));
                        return matchesCard && matchesCategory;
                    })
                    .map(t => t.date ? t.date.substring(0, 7) : '')
                    .filter(Boolean)
            )).sort().reverse(); // newest first

            selectedMonths = availableMonths.slice(0, n);
            renderCardFilters();
            renderTransactionsAndMetrics();
        }

        function txSortValue(t, col) {
            if (col === 'date') return t.date || '';
            if (col === 'card') return (t.cardName || '').trim().toLowerCase();
            if (col === 'amount') return parseFloat(t.amount) || 0;
            if (col === 'cashback') return parseFloat(t.cashback) || 0;
            if (col === 'net') return (txKind(t.type) === 'Repaid') ? 0 : ((parseFloat(t.cashback) || 0) - (parseFloat(t.serviceCharge) || 0));
            return '';
        }

        function renderPagination(totalItems) {
            const el = document.getElementById('tx-pagination');
            if (!el) return;
            if (totalItems === 0) { el.innerHTML = ''; return; }
            const totalPages = Math.max(1, Math.ceil(totalItems / TX_PAGE_SIZE));
            const start = (txCurrentPage - 1) * TX_PAGE_SIZE + 1;
            const end = Math.min(txCurrentPage * TX_PAGE_SIZE, totalItems);
            const btn = (label, page, disabled) => `
                <button onclick="goToTxPage(${page})" ${disabled ? 'disabled' : ''}
                    class="px-2.5 py-1 rounded-md font-medium transition ${disabled ? 'text-slate-300 dark:text-slate-600 cursor-not-allowed' : 'text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950'}">
                    ${label}
                </button>`;
            el.innerHTML = `
                <span>Showing ${start}–${end} of ${totalItems}</span>
                <div class="flex items-center gap-1">
                    ${btn('‹ Prev', txCurrentPage - 1, txCurrentPage <= 1)}
                    <span class="px-1">Page ${txCurrentPage} of ${totalPages}</span>
                    ${btn('Next ›', txCurrentPage + 1, txCurrentPage >= totalPages)}
                </div>`;
        }

        // ---- Row action menu (⋯ → Edit / Repeat / Delete) ----
        // One shared menu, fixed-positioned next to the clicked button so the table's horizontal
        // scroll container can't clip it.
        let txMenuOpenId = null;

        function closeTxMenu() {
            const menu = document.getElementById('tx-menu');
            if (menu) menu.classList.add('hidden');
            txMenuOpenId = null;
        }

        function openTxMenu(event, id) {
            event.stopPropagation();
            closeThDropdown();
            if (txMenuOpenId === id) { closeTxMenu(); return; }
            let menu = document.getElementById('tx-menu');
            if (!menu) {
                menu = document.createElement('div');
                menu.id = 'tx-menu';
                menu.setAttribute('role', 'menu');
                menu.className = 'tx-menu hidden';
                document.body.appendChild(menu);
            }
            const icon = (d, color) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
            menu.innerHTML = `
                <button type="button" role="menuitem" class="tx-menu-item" onclick="txMenuAction('edit')">${icon('<path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>', '#a5b4fc')}Edit</button>
                <button type="button" role="menuitem" class="tx-menu-item" onclick="txMenuAction('repeat')">${icon('<path d="M20 11a8 8 0 0 0-14.3-4.6L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.6L20 16"/><path d="M20 20v-4h-4"/>', '#34d399')}Repeat</button>
                <div class="tx-menu-sep"></div>
                <button type="button" role="menuitem" class="tx-menu-item danger" onclick="txMenuAction('delete')">${icon('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>', '#f87171')}Delete</button>`;
            txMenuOpenId = id;
            menu.classList.remove('hidden');

            const rect = event.currentTarget.getBoundingClientRect();
            const w = menu.offsetWidth, h = menu.offsetHeight;
            let top = rect.bottom + 6;
            if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 6); // flip up near the bottom
            const left = Math.max(8, Math.min(rect.right - w, window.innerWidth - w - 8));
            menu.style.top = `${top}px`;
            menu.style.left = `${left}px`;
        }

        function txMenuAction(action) {
            const id = txMenuOpenId;
            closeTxMenu();
            if (!id) return;
            if (action === 'edit') editTransaction(id);
            else if (action === 'repeat') duplicateTransaction(id);
            else if (action === 'delete') deleteTransaction(id);
        }

        document.addEventListener('click', e => { if (!e.target.closest('#tx-menu')) closeTxMenu(); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') closeTxMenu(); });
        window.addEventListener('resize', closeTxMenu);
        window.addEventListener('scroll', closeTxMenu, true);

        // ---- Transaction table helpers ----
        // Coloured dot on the card chip follows the card's saved colour.
        function txCardDotColor(t) {
            const c = cards.find(x => x.id === t.cardId) || cards.find(x => (x.name || '').trim() === (t.cardName || '').trim());
            return cardAccentColor(resolveCardColor(c ? c.colorGradient : ''));
        }
        function txTypeClass(type) {
            const v = String(type || '').toLowerCase();
            if (/repa|payment|settle/.test(v)) return 'green';
            if (/purchase|spend/.test(v)) return 'indigo';
            if (/cash|withdraw/.test(v)) return 'amber';
            if (/fee|charge|interest/.test(v)) return 'red';
            return 'slate';
        }
        // Keep the full date visible in the transaction history table.
        function fmtTxDate(dateStr) {
            const d = new Date(`${dateStr}T00:00:00`);
            if (!dateStr || isNaN(d)) return escapeHtml(dateStr || '-');
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        }

        function renderTransactionsAndMetrics() {
            const tbody = document.getElementById('tx-table-body');
            const visibleTransactions = transactions.filter(t => !hiddenTxIds.has(t.id));
            document.getElementById('tx-count').textContent = `${visibleTransactions.length} entries`;

            if (visibleTransactions.length === 0) {
                tbody.innerHTML = `<tr><td colspan="10" class="p-6 text-center text-xs text-slate-400 dark:text-slate-500">No transactions recorded yet.</td></tr>`;
                renderPagination(0);
                currentReportTransactions = [];
                renderFinancialPerformance({}, {}, 0);
                renderSummaryTable();
                renderCardsList();
                return;
            }

            const filteredTransactions = visibleTransactions.filter(transactionMatchesFilters);

            let totalSpend = 0;
            let totalCashback = 0;
            let totalFees = 0;
            let totalMissed = 0;
            const categoryMap = {};
            const cardMap = {};
            const monthlyData = {};

            // Aggregates (metrics, donuts, monthly chart) are computed over EVERY filtered
            // transaction, not just the page currently on screen.
            filteredTransactions.forEach(t => {
                const amount = parseFloat(t.amount) || 0;
                const cashback = isImmediateCashbackTransaction(t) ? amount : (parseFloat(t.cashback) || 0);
                const fee = parseFloat(t.serviceCharge) || 0;
                const netReward = (txKind(t.type) === 'Repaid') ? 0 : (cashback - fee);

                if (!isImmediateCashbackTransaction(t) && (txKind(t.type) === 'Purchase' || txKind(t.type) === 'Cash Withdrawal')) {
                    totalSpend += amount;

                    // "Left on the table": what the best available card's rate would have
                    // earned on this same purchase vs. what was actually earned. This is an
                    // approximation from amount/cashback, not a tracked per-transaction rate,
                    // so treat it as directional rather than exact.
                    const actualRate = amount > 0 ? (cashback / amount) * 100 : 0;
                    const best = bestRateForCategory(t.category);
                    if (best > actualRate) {
                        totalMissed += amount * (best - actualRate) / 100;
                    }
                }
                totalCashback += cashback;
                totalFees += fee;

                const displayCategory = t.category ? t.category : 'Uncategorized';
                if (cashback > 0) {
                    categoryMap[displayCategory] = (categoryMap[displayCategory] || 0) + cashback;
                }

                const displayCard = t.cardName ? t.cardName.trim() : 'Unknown Card';
                if (cashback > 0) {
                    cardMap[displayCard] = (cardMap[displayCard] || 0) + cashback;
                }

                const monthKey = t.date ? t.date.substring(0, 7) : 'Unknown';
                if (!monthlyData[monthKey]) {
                    monthlyData[monthKey] = { purchase: 0, withdrawal: 0, repaid: 0, fee: 0, cashback: 0, netReward: 0 };
                }

                if (txKind(t.type) === 'Purchase') monthlyData[monthKey].purchase += amount;
                if (txKind(t.type) === 'Cash Withdrawal') monthlyData[monthKey].withdrawal += amount;
                if (txKind(t.type) === 'Repaid') monthlyData[monthKey].repaid += amount;
                monthlyData[monthKey].fee += fee;
                monthlyData[monthKey].cashback += cashback;
                monthlyData[monthKey].netReward += netReward;
            });

            // Sort (defaults to newest-first by date, same as before; click a column header to change it)
            const sorted = [...filteredTransactions].sort((a, b) => {
                const va = txSortValue(a, txSortColumn);
                const vb = txSortValue(b, txSortColumn);
                let cmp = (typeof va === 'string') ? va.localeCompare(vb) : (va - vb);
                if (cmp === 0) {
                    cmp = (a.date || '').localeCompare(b.date || '') || String(a.id).localeCompare(String(b.id));
                }
                return txSortDir === 'asc' ? cmp : -cmp;
            });

            // Paginate: only the current page is rendered as rows; totals above already cover everything filtered
            const totalPages = Math.max(1, Math.ceil(sorted.length / TX_PAGE_SIZE));
            if (txCurrentPage > totalPages) txCurrentPage = totalPages;
            if (txCurrentPage < 1) txCurrentPage = 1;
            const pageStart = (txCurrentPage - 1) * TX_PAGE_SIZE;
            const pageRows = sorted.slice(pageStart, pageStart + TX_PAGE_SIZE);

            if (sorted.length === 0) {
                tbody.innerHTML = `<tr><td colspan="10" class="p-6 text-center text-xs text-slate-400 dark:text-slate-500">No transactions match the current filter.</td></tr>`;
            } else {
                tbody.innerHTML = pageRows.map(t => {
                    const amount = parseFloat(t.amount) || 0;
                    const cashback = isImmediateCashbackTransaction(t) ? amount : (parseFloat(t.cashback) || 0);
                    const fee = parseFloat(t.serviceCharge) || 0;
                    const isRepaid = txKind(t.type) === 'Repaid';
                    const netReward = isRepaid ? 0 : (cashback - fee);
                    // Net Rewards = cashback − service fee (an amount, not a percentage)
                    const netCls = isRepaid ? 'muted' : netReward < 0 ? 'neg' : netReward === 0 ? 'muted' : 'pos';
                    const netRate = amount > 0 ? ((netReward / amount) * 100).toFixed(2) + '% of amount' : '';
                    const dash = '<span class="tx-dash">—</span>';

                    return `
                        <tr class="tx-row">
                            <td class="tx-td"><span class="tx-date" title="${escapeHtml(t.date)}">${fmtTxDate(t.date)}</span></td>
                            <td class="tx-td"><span class="tx-chip"><i class="tx-cdot" style="background:${txCardDotColor(t)}"></i>${escapeHtml(t.cardName)}</span></td>
                            <td class="tx-td"><span class="tx-type ${txTypeClass(t.type)}">${escapeHtml(t.type)}</span></td>
                            <td class="tx-td tx-desc">${escapeHtml(t.desc)}</td>
                            <td class="tx-td">${t.category ? `<span class="tx-cat">${escapeHtml(t.category)}</span>` : dash}</td>
                            <td class="tx-td right tx-num tx-amt ${isRepaid ? 'pos' : ''}">${amount ? (isRepaid ? '-' : '') + formatAED(amount) : dash}</td>
                            <td class="tx-td right tx-num ${fee ? 'warn' : 'muted'}">${formatAED(fee)}</td>
                            <td class="tx-td right tx-num ${cashback ? 'pos' : 'muted'}">${cashback ? '+' + formatAED(cashback) : dash}</td>
                            <td class="tx-td right tx-num ${netCls}" title="${netRate}">${isRepaid ? dash : (netReward > 0 ? '+' : netReward < 0 ? '-' : '') + formatAED(Math.abs(netReward))}</td>
                            <td class="tx-td center">
                                <button type="button" class="tx-dots" aria-label="Transaction actions" aria-haspopup="menu" onclick="openTxMenu(event, '${t.id}')">
                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>
                                </button>
                            </td>
                        </tr>
                    `;
                }).join('');
            }

            ['date', 'card', 'amount', 'cashback', 'net'].forEach(col => {
                const arrowEl = document.getElementById(`sort-arrow-${col}`);
                if (arrowEl) arrowEl.innerHTML = sortArrow(col);
            });
            renderPagination(sorted.length);

            currentReportTransactions = visibleTransactions;
            renderFinancialPerformance(monthlyData, categoryMap, totalSpend);
            renderSummaryTable();
            renderCardsList();
        }

        function setFinancialPeriod(period) {
            financialPeriod = period;
            renderTransactionsAndMetrics();
        }

        function renderFinancialPerformance(monthlyData, categoryMap, totalSpend) {
            const report = document.getElementById('financial-performance-report');
            if (!report) return;

            const now = new Date();
            const currentMonth = localMonthKey(now);
            const previousMonth = localMonthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
            const currentYear = String(now.getFullYear());
            const cutoff = new Date(now);
            cutoff.setDate(cutoff.getDate() - 89);
            const periodTransactions = currentReportTransactions.filter(transaction => {
                if (!transaction.date) return false;
                if (financialPeriod === 'all') return true;
                if (financialPeriod === 'month') return transaction.date.startsWith(currentMonth);
                if (financialPeriod === 'last-month') return transaction.date.startsWith(previousMonth);
                if (financialPeriod === 'ytd') return transaction.date.startsWith(currentYear);
                return new Date(`${transaction.date}T00:00:00`) >= cutoff;
            });
            monthlyData = {};
            categoryMap = {};
            totalSpend = 0;
            periodTransactions.forEach(transaction => {
                const amount = parseFloat(transaction.amount) || 0;
                const cashback = parseFloat(transaction.cashback) || 0;
                const fee = parseFloat(transaction.serviceCharge) || 0;
                const monthKey = transaction.date.substring(0, 7);
                if (!monthlyData[monthKey]) monthlyData[monthKey] = { purchase: 0, withdrawal: 0, repaid: 0, fee: 0, cashback: 0, netReward: 0 };
                if (txKind(transaction.type) === 'Purchase') {
                    monthlyData[monthKey].purchase += amount;
                    totalSpend += amount;
                }
                if (txKind(transaction.type) === 'Cash Withdrawal') {
                    monthlyData[monthKey].withdrawal += amount;
                    totalSpend += amount;
                }
                if (txKind(transaction.type) === 'Repaid') monthlyData[monthKey].repaid += amount;
                monthlyData[monthKey].fee += fee;
                monthlyData[monthKey].cashback += cashback;
                monthlyData[monthKey].netReward += cashback - fee;
                if (cashback > 0) {
                    const category = transaction.category || 'Uncategorized';
                    categoryMap[category] = (categoryMap[category] || 0) + cashback;
                }
            });
            const months = Object.keys(monthlyData).filter(month => month !== 'Unknown').sort();
            const latestMonth = months.length ? months[months.length - 1] : localMonthKey();
            const totals = months.reduce((summary, month) => {
                const data = monthlyData[month];
                summary.purchase += data.purchase;
                summary.withdrawal += data.withdrawal;
                summary.repaid += data.repaid;
                summary.fee += data.fee;
                summary.cashback += data.cashback;
                return summary;
            }, { purchase: 0, withdrawal: 0, repaid: 0, fee: 0, cashback: 0 });
            const gross = totals.purchase + totals.withdrawal;
            const outflow = gross + totals.fee;
            const netReward = totals.cashback - totals.fee;
            const capitalTotal = outflow + totals.repaid + totals.cashback || 1;
            const categories = Object.entries(categoryMap).sort((a, b) => b[1] - a[1]);
            const maxCategoryCashback = categories.length ? categories[0][1] : 1;
            const formatValue = value => formatAED(value);
            const pct = (value, base) => base > 0 ? `${((value / base) * 100).toFixed(1)}%` : '0.0%';
            const activeButton = period => financialPeriod === period ? 'fp-seg-btn active' : 'fp-seg-btn';

            // Segment widths for the capital bar
            const barTotal = (totals.purchase + totals.withdrawal + totals.repaid + totals.fee + totals.cashback) || 1;
            const seg = (value, cls) => value > 0 ? `<div class="fp-seg-fill ${cls}" style="width:${(value / barTotal) * 100}%"></div>` : '';
            const cur = '<span class="fp-cur">AED</span>';
            const feeClean = totals.fee <= 0;
            const catBar = (index, count) => index === 0 ? 'fp-bar-top' : (count >= 3 && index === count - 1) ? 'fp-bar-low' : 'fp-bar-mid';
            const shownCats = categories.slice(0, 6);

            report.innerHTML = `
                <div class="flex flex-wrap items-start justify-between gap-4">
                    <div>
                        <h3 class="fp-title"><span class="text-indigo-300"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 15l4.5-5.5 3.5 3L15 6.5"/><circle cx="17" cy="15" r="3.2"/><path d="m19.4 17.4 2.1 2.1"/></svg></span> Financial Performance</h3>
                        <p class="fp-sub">Dissection of purchases, cash drawdowns, repayments &amp; fee avoidance</p>
                    </div>
                    <div class="fp-seg">
                        <button type="button" onclick="setFinancialPeriod('month')" class="${activeButton('month')}">${monthLabel(currentMonth)}</button>
                        <button type="button" onclick="setFinancialPeriod('last-month')" class="${activeButton('last-month')}">Last Month</button>
                        <button type="button" onclick="setFinancialPeriod('90d')" class="${activeButton('90d')}">Last 3 Months</button>
                        <button type="button" onclick="setFinancialPeriod('ytd')" class="${activeButton('ytd')}">YTD</button>
                        <button type="button" onclick="setFinancialPeriod('all')" class="${activeButton('all')}">All</button>
                    </div>
                </div>

                <div class="space-y-3 marg">
                    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                        <span class="fp-eyebrow"><i class="fp-dot"></i>Capital Disposition Metric</span>
                        <span class="fp-outflow">AED ${formatValue(outflow)} Outflow / AED ${formatValue(totals.repaid)} Repaid</span>
                    </div>
                    <div class="fp-track">
                        ${seg(totals.purchase, 'fp-purchase')}${seg(totals.withdrawal, 'fp-withdraw')}${seg(totals.repaid, 'fp-repaid')}${seg(totals.cashback, 'fp-cash')}${seg(totals.fee, 'fp-fee')}
                    </div>
                    <div class="flex flex-wrap gap-x-6 gap-y-2 fp-legend">
                        <span><i class="fp-ldot" style="background:#6366f1"></i>Purchases (${formatValue(totals.purchase)})</span>
                        <span><i class="fp-ldot" style="background:#fbbf24"></i>Cash Withdrawals (${formatValue(totals.withdrawal)})</span>
                        <span><i class="fp-ldot" style="background:#34d399"></i>Repayments (${formatValue(totals.repaid)})</span>
                        <span><i class="fp-ldot" style="background:#22d3ee"></i>Cashback (${formatValue(totals.cashback)})</span>
                        <span class="${feeClean ? 'opacity-60' : ''}"><i class="fp-ldot" style="background:${feeClean ? '#475569' : '#f87171'}"></i>Fees (${formatValue(totals.fee)})</span>
                    </div>
                </div>

                <div class="fp-well marg-1">
                    <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
                        <div class="fp-tile">
                            <p class="fp-eyebrow">Gross Purchases</p>
                            <p class="fp-val">${cur}${formatValue(gross)}</p>
                            <p class="fp-note text-emerald-400">${pct(gross, outflow)} total volume</p>
                        </div>
                        <div class="fp-tile">
                            <p class="fp-eyebrow">Total Repaid</p>
                            <p class="fp-val text-emerald-400">${cur}${formatValue(totals.repaid)}</p>
                            <p class="fp-note text-slate-500">${pct(totals.repaid, gross)} debt rolled down</p>
                        </div>
                        <div class="fp-tile">
                            <p class="fp-eyebrow">Cashback Earned</p>
                            <p class="fp-val text-cyan-300">${cur}${formatValue(totals.cashback)}</p>
                            <p class="fp-note text-slate-500">Total cashback</p>
                        </div>
                        <div class="fp-tile">
                            <p class="fp-eyebrow">Service Fees</p>
                            <p class="fp-val">${cur}${formatValue(totals.fee)}</p>
                            <p class="fp-note ${feeClean ? 'text-emerald-400' : 'text-amber-300'}">${feeClean ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline;vertical-align:-2px;margin-right:5px"><circle cx="12" cy="12" r="9"/><path d="M8.2 12.4l2.6 2.6 5-5.4"/></svg>100% fee avoided' : 'Tracked fees'}</p>
                        </div>
                        <div class="fp-tile">
                            <p class="fp-eyebrow">Net Rewards</p>
                            <p class="fp-val" style="color:#c4b5fd">${cur}${netReward < 0 ? '−' : '+'}${formatValue(Math.abs(netReward))}</p>
                            <p class="fp-note text-slate-400">Cashback − fees</p>
                        </div>
                    </div>
                </div>

                <div class="fp-divider"></div>

                <div>
                    <div class="mb-5 flex items-center justify-between marg">
                        <h3 class="fp-cat-title">Cashback by Category</h3>
                        <span class="fp-yield">Yield Ranked</span>
                    </div>
                    <div class="space-y-5">
                        ${shownCats.length ? shownCats.map(([category, cashback], index) => `
                            <div>
                                <div class="mb-2.5 flex items-center justify-between gap-3">
                                    <span class="flex items-center gap-3 min-w-0">${categoryTileHtml(category)}<span class="fp-cat-name truncate">${escapeHtml(category)}</span></span>
                                    <span class="fp-cat-amt shrink-0">${formatValue(cashback)} <span class="text-slate-500">(${pct(cashback, totalSpend)})</span></span>
                                </div>
                                <div class="fp-cat-track"><div class="fp-cat-fill ${catBar(index, shownCats.length)}" style="width:${Math.max(3, (cashback / maxCategoryCashback) * 100)}%"></div></div>
                            </div>`).join('') : '<p class="text-xs text-slate-500">No cashback data for the current filters.</p>'}
                    </div>
                </div>`;
        }

        function renderMonthlyChart(monthlyData) {
            const ctx = document.getElementById('monthlyChart').getContext('2d');
            const months = Object.keys(monthlyData).sort();

            const purchaseData = months.map(m => monthlyData[m].purchase);
            const withdrawalData = months.map(m => monthlyData[m].withdrawal);
            const repaidData = months.map(m => monthlyData[m].repaid);
            const feeData = months.map(m => monthlyData[m].fee);
            const cashbackData = months.map(m => monthlyData[m].cashback);
            const netRewardData = months.map(m => monthlyData[m].netReward);
            // Effective rate trend: is the card mix actually earning more over time, or just spending more?
            const effRateData = months.map(m => {
                const spend = monthlyData[m].purchase + monthlyData[m].withdrawal;
                return spend > 0 ? Number(((monthlyData[m].cashback / spend) * 100).toFixed(2)) : 0;
            });

            if (monthlyChartInstance) monthlyChartInstance.destroy();

            monthlyChartInstance = new Chart(ctx, {
                data: {
                    labels: months.length > 0 ? months : ['No Data'],
                    datasets: [
                        { type: 'bar', label: 'Purchase', data: purchaseData, backgroundColor: '#3B82F6', yAxisID: 'y' },
                        { type: 'bar', label: 'Cash Withdrawal', data: withdrawalData, backgroundColor: '#F59E0B', yAxisID: 'y' },
                        { type: 'bar', label: 'Repaid', data: repaidData, backgroundColor: '#10B981', yAxisID: 'y' },
                        { type: 'bar', label: 'Service Fees', data: feeData, backgroundColor: '#EF4444', yAxisID: 'y' },
                        { type: 'bar', label: 'Cashback', data: cashbackData, backgroundColor: '#059669', yAxisID: 'y' },
                        { type: 'bar', label: 'Net Rewards', data: netRewardData, backgroundColor: '#6366F1', yAxisID: 'y' },
                        { type: 'line', label: 'Effective Rate (%)', data: effRateData, borderColor: '#DB2777', backgroundColor: '#DB2777', yAxisID: 'y1', tension: 0.3, pointRadius: 3 }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
                        tooltip: { mode: 'index', intersect: false }
                    },
                    scales: {
                        y: { beginAtZero: true, position: 'left', title: { display: true, text: 'AED' } },
                        y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'Effective Rate (%)' } },
                        x: { grid: { display: false } }
                    }
                }
            });
        }

        function updateSummaryNote(filteredTx, asOfDate) {
            const noteEl = document.getElementById('summary-cashback-note');
            if (!noteEl) return;
            const pendingByDate = new Map();
            filteredTx.forEach(t => {
                if (!t.date || t.date > asOfDate) return;
                const creditDate = cashbackCreditDate(t);
                if (!creditDate || creditDate <= asOfDate) return;
                const amount = parseFloat(t.cashback) || 0;
                if (amount > 0) pendingByDate.set(creditDate, (pendingByDate.get(creditDate) || 0) + amount);
            });
            const pending = [...pendingByDate.values()].reduce((sum, amount) => sum + amount, 0);
            if (pending > 0) {
                const timing = [...pendingByDate.entries()]
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([date, amount]) => `AED ${formatAED(amount)} on ${formatCashbackCreditDate(date)}`)
                    .join('; ');
                noteEl.textContent = `Remaining Pay excludes AED ${formatAED(pending)} of pending cashback — ${timing}.`;
                noteEl.classList.remove('hidden');
            } else {
                noteEl.textContent = '';
                noteEl.classList.add('hidden');
            }
        }

        // ---- Summary table helpers (same template as the transaction history) ----
        const SM_REMAINING_TIP = "Purchases + withdrawals − repayments − cashback already credited according to each card's configured cashback timing.";
        function smHeaderHtml(firstLabel) {
            return `
                <th class="tx-th">${firstLabel}</th>
                <th class="tx-th right">Purchase</th>
                <th class="tx-th right">Cash Withdrawal</th>
                <th class="tx-th right">Repaid</th>
                <th class="tx-th right">Service Charges</th>
                <th class="tx-th right">Cashback</th>
                <th class="tx-th right" title="${SM_REMAINING_TIP}">Remaining Pay</th>
                <th class="tx-th right">Net Rewards</th>`;
        }
        function smCardLabel(name) {
            return `<span class="tx-chip"><i class="tx-cdot" style="background:${txCardDotColor({ cardName: name })}"></i>${escapeHtml(name)}</span>`;
        }
        function smCatLabel(name) {
            return `<span class="tx-cat">${escapeHtml(name)}</span>`;
        }
        // Thousands separators + 2 decimals; zero values fade out so real numbers stand out.
        function smTd(value, cls) {
            const zero = Math.abs(value) < 0.005;
            return `<td class="tx-td right tx-num ${zero ? 'muted' : cls}">${formatAED(value)}</td>`;
        }
        function smRowHtml(labelHtml, d, remainingPay) {
            return `
                <tr class="tx-row">
                    <td class="tx-td">${labelHtml}</td>
                    ${smTd(d.purchase, 'plain')}
                    ${smTd(d.withdrawal, 'warn')}
                    ${smTd(d.repaid, 'pos')}
                    ${smTd(d.fee, 'neg')}
                    ${smTd(d.cashback, 'pos')}
                    ${smTd(remainingPay, 'strong')}
                    ${smTd(d.netReward, d.netReward < 0 ? 'neg' : 'pos')}
                </tr>`;
        }
        function smTotalHtml(t) {
            return `
                <tr class="tx-total">
                    <td class="tx-td">Total</td>
                    ${smTd(t.purchase, 'strong')}
                    ${smTd(t.withdrawal, 'warn')}
                    ${smTd(t.repaid, 'pos')}
                    ${smTd(t.fee, 'neg')}
                    ${smTd(t.cashback, 'pos')}
                    ${smTd(t.remaining, 'strong')}
                    ${smTd(t.net, t.net < 0 ? 'neg' : 'pos')}
                </tr>`;
        }

        function renderSummaryTable() {
            const tbody = document.getElementById('monthly-table-body');
            const titleEl = document.getElementById('summary-table-title');
            const headerTr = document.getElementById('summary-table-header');

            let filteredTx = transactions.filter(transactionMatchesFilters);
            // "Summary for All Cards" lists enabled cards only; disabled cards join in when "Show Disabled Cards" is on.
            if (activeCardFilter === 'ALL' && !showDisabledCards) filteredTx = filteredTx.filter(t => !txCardIsDisabled(t));
            const summaryCurrentDate = localDateKey();
            updateSummaryNote(filteredTx, summaryCurrentDate);

            if (filteredTx.length === 0) {
                headerTr.innerHTML = smHeaderHtml('Summary');
                tbody.innerHTML = `<tr><td colspan="8" class="tx-td center muted">No data available for selected filter.</td></tr>`;
                return;
            }

            if (activeCardFilter === 'ALL') {
                titleEl.textContent = 'Summary for All Cards';
                headerTr.innerHTML = smHeaderHtml('Card Name');

                const cardAgg = {};
                filteredTx.forEach(t => {
                    const cName = t.cardName ? t.cardName.trim() : 'Unknown Card';
                    if (!cardAgg[cName]) {
                        cardAgg[cName] = { purchase: 0, withdrawal: 0, repaid: 0, fee: 0, cashback: 0, cashbackCredited: 0, netReward: 0 };
                    }
                    const amount = parseFloat(t.amount) || 0;
                    const cashback = isImmediateCashbackTransaction(t) ? amount : (parseFloat(t.cashback) || 0);
                    const fee = parseFloat(t.serviceCharge) || 0;
                    const netReward = (txKind(t.type) === 'Repaid') ? 0 : (cashback - fee);

                    if (!isImmediateCashbackTransaction(t) && txKind(t.type) === 'Purchase') cardAgg[cName].purchase += amount;
                    if (!isImmediateCashbackTransaction(t) && txKind(t.type) === 'Cash Withdrawal') cardAgg[cName].withdrawal += amount;
                    if (txKind(t.type) === 'Repaid') cardAgg[cName].repaid += amount;
                    cardAgg[cName].fee += fee;
                    cardAgg[cName].cashback += cashback;
                    if (isCashbackCredited(t, summaryCurrentDate)) cardAgg[cName].cashbackCredited += cashback;
                    cardAgg[cName].netReward += netReward;
                });

                let totalPurchase = 0;
                let totalWithdrawal = 0;
                let totalRepaid = 0;
                let totalFee = 0;
                let totalCashback = 0;
                let totalRemainingPay = 0;
                let totalNetReward = 0;

                const rowsHtml = Object.keys(cardAgg).sort().map(cName => {
                    const d = cardAgg[cName];
                    const remainingPay = (d.purchase + d.withdrawal) - d.repaid - d.cashbackCredited;
                    
                    totalPurchase += d.purchase;
                    totalWithdrawal += d.withdrawal;
                    totalRepaid += d.repaid;
                    totalFee += d.fee;
                    totalCashback += d.cashback;
                    totalRemainingPay += remainingPay;
                    totalNetReward += d.netReward;

                    return smRowHtml(smCardLabel(cName), d, remainingPay);
                }).join('');

                const totalRowHtml = smTotalHtml({ purchase: totalPurchase, withdrawal: totalWithdrawal, repaid: totalRepaid, fee: totalFee, cashback: totalCashback, remaining: totalRemainingPay, net: totalNetReward });

                tbody.innerHTML = rowsHtml + totalRowHtml;

            } else {
                titleEl.textContent = `Summary for ${activeCardFilter}`;
                headerTr.innerHTML = smHeaderHtml('Category');

                const catAgg = {};
                filteredTx.forEach(t => {
                    const catName = t.category ? t.category.trim() : 'Uncategorized';
                    if (!catAgg[catName]) {
                        catAgg[catName] = { purchase: 0, withdrawal: 0, repaid: 0, fee: 0, cashback: 0, cashbackCredited: 0, netReward: 0 };
                    }
                    const amount = parseFloat(t.amount) || 0;
                    const cashback = isImmediateCashbackTransaction(t) ? amount : (parseFloat(t.cashback) || 0);
                    const fee = parseFloat(t.serviceCharge) || 0;
                    const netReward = (txKind(t.type) === 'Repaid') ? 0 : (cashback - fee);

                    if (!isImmediateCashbackTransaction(t) && txKind(t.type) === 'Purchase') catAgg[catName].purchase += amount;
                    if (!isImmediateCashbackTransaction(t) && txKind(t.type) === 'Cash Withdrawal') catAgg[catName].withdrawal += amount;
                    if (txKind(t.type) === 'Repaid') catAgg[catName].repaid += amount;
                    catAgg[catName].fee += fee;
                    catAgg[catName].cashback += cashback;
                    if (isCashbackCredited(t, summaryCurrentDate)) catAgg[catName].cashbackCredited += cashback;
                    catAgg[catName].netReward += netReward;
                });

                let totalPurchase = 0;
                let totalWithdrawal = 0;
                let totalRepaid = 0;
                let totalFee = 0;
                let totalCashback = 0;
                let totalRemainingPay = 0;
                let totalNetReward = 0;

                const rowsHtml = Object.keys(catAgg).sort().map(catName => {
                    const d = catAgg[catName];
                    const remainingPay = (d.purchase + d.withdrawal) - d.repaid - d.cashbackCredited;
                    
                    totalPurchase += d.purchase;
                    totalWithdrawal += d.withdrawal;
                    totalRepaid += d.repaid;
                    totalFee += d.fee;
                    totalCashback += d.cashback;
                    totalRemainingPay += remainingPay;
                    totalNetReward += d.netReward;

                    return smRowHtml(smCatLabel(catName), d, remainingPay);
                }).join('');

                const totalRowHtml = smTotalHtml({ purchase: totalPurchase, withdrawal: totalWithdrawal, repaid: totalRepaid, fee: totalFee, cashback: totalCashback, remaining: totalRemainingPay, net: totalNetReward });

                tbody.innerHTML = rowsHtml + totalRowHtml;
            }
        }

        function renderDonutCharts(categoryMap, cardMap) {
            const colors = ['#4F46E5', '#059669', '#3B82F6', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6'];

            const catCtx = document.getElementById('categoryDonutChart').getContext('2d');
            const catLabels = Object.keys(categoryMap);
            const catData = Object.values(categoryMap);

            if (categoryDonutInstance) categoryDonutInstance.destroy();
            categoryDonutInstance = new Chart(catCtx, {
                type: 'doughnut',
                data: {
                    labels: catLabels.length > 0 ? catLabels : ['No Data'],
                    datasets: [{
                        data: catData.length > 0 ? catData : [1],
                        backgroundColor: catData.length > 0 ? colors.slice(0, catData.length) : ['#E2E8F0'],
                        borderWidth: 2,
                        borderColor: '#0f121a'
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } },
                    cutout: '65%'
                }
            });

            const cardCtx = document.getElementById('cardDonutChart').getContext('2d');
            const cardLabels = Object.keys(cardMap);
            const cardData = Object.values(cardMap);

            if (cardDonutInstance) cardDonutInstance.destroy();
            cardDonutInstance = new Chart(cardCtx, {
                type: 'doughnut',
                data: {
                    labels: cardLabels.length > 0 ? cardLabels : ['No Data'],
                    datasets: [{
                        data: cardData.length > 0 ? cardData : [1],
                        backgroundColor: cardData.length > 0 ? colors.slice(0, cardData.length) : ['#E2E8F0'],
                        borderWidth: 2,
                        borderColor: '#0f121a'
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } },
                    cutout: '65%'
                }
            });
        }

        // ---- SUPPORT CHAT: users send doubts / suggestions, admin replies (run support_chat.sql and support_chat_features.sql) ----
        let spIsAdmin = false, spMsgs = [], spChannel = null, spActiveThread = null, spReady = false;
        let spSelectedImages = [], spHistoryClearedAt = null, spHistoryStateReady = false;
        let spAnnouncements = [], spAnnouncementsReadAt = null, spBroadcastMode = false, spAnnouncementsReadPending = false;
        let spAnnouncementsReady = false, spAnnouncementsError = '';
        let spNewChatMode = false, spUsers = [], spUsersLoading = false, spUsersError = '', spUsersLoadPromise = null;
        let spSelectedRecipients = new Set(), spUserSearch = '', spUserDropdownOpen = false;
        let spRenderVersion = 0;
        const SP_IMAGE_BUCKET = 'support-attachments';
        const SP_MAX_IMAGES = 4;
        const SP_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
        const spSignedUrlCache = new Map();
        const SP_KINDS = { doubt: '❓ Doubt', suggestion: '💡 Suggestion', other: '💬 Other' };
        const spModalOpen = () => !document.getElementById('sp-modal').classList.contains('hidden');
        const spIncoming = m => spIsAdmin ? m.sender_role === 'user' : m.sender_role === 'admin';
        const spUnreadOf = m => spIncoming(m) && !(spIsAdmin ? m.read_by_admin : m.read_by_user);
        const spVisibleToUser = m => spIsAdmin || !spHistoryClearedAt || new Date(m.created_at) > new Date(spHistoryClearedAt);

        async function spInit() {
            if (!_supabase || !currentUserId) return;
            try {
                const { data } = await _supabase.from('admins').select('user_id').eq('user_id', currentUserId).maybeSingle();
                spIsAdmin = !!data;
            } catch (e) { spIsAdmin = false; }
            document.getElementById('sp-menu-label').textContent = spIsAdmin ? '🛠 Admin Inbox' : '💬 Support & Feedback';
            document.getElementById('sp-menu-btn').classList.remove('hidden');
            await spLoadHistoryState();
            await spLoad();
            if (!spChannel) {
                spChannel = _supabase.channel('support-msgs')
                    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'support_messages' }, payload => {
                        const m = payload.new;
                        if (!m || spMsgs.some(x => x.id === m.id)) return;
                        spMsgs.push(m);
                        if (spIncoming(m) && !spModalOpen()) showToast(spIsAdmin ? `New message from ${m.user_label || 'a user'}` : 'New reply from admin', { tone: 'success' });
                        spChanged();
                    })
                    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'support_messages' }, payload => {
                        const id = payload.old?.id;
                        if (id == null) return;
                        spMsgs = spMsgs.filter(m => String(m.id) !== String(id));
                        spChanged();
                    })
                    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'support_announcements' }, payload => {
                        const announcement = payload.new;
                        if (!announcement || spAnnouncements.some(x => x.id === announcement.id)) return;
                        spAnnouncements.push(announcement);
                        spAnnouncements.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
                        if (!spIsAdmin && !spModalOpen()) showToast('New announcement from admin', { tone: 'success' });
                        spChanged();
                    })
                    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'support_announcements' }, payload => {
                        const id = payload.old?.id;
                        if (id == null) return;
                        spAnnouncements = spAnnouncements.filter(item => String(item.id) !== String(id));
                        spChanged();
                    })
                    .subscribe();
            }
        }
        async function spLoadHistoryState() {
            spHistoryClearedAt = null;
            spAnnouncementsReadAt = null;
            spHistoryStateReady = false;
            if (spIsAdmin) { spHistoryStateReady = true; return; }
            const { data, error } = await _supabase.from('support_thread_state')
                .select('history_cleared_at').eq('thread_user_id', currentUserId).maybeSingle();
            if (error) { console.warn('Support history state not available:', error.message); return; }
            spHistoryClearedAt = data?.history_cleared_at || null;
            spHistoryStateReady = true;
            const { data: announcementState, error: announcementStateError } = await _supabase.from('support_thread_state')
                .select('announcements_read_at').eq('thread_user_id', currentUserId).maybeSingle();
            if (announcementStateError) {
                console.warn('Support announcement read state not available:', announcementStateError.message);
                return;
            }
            spAnnouncementsReadAt = announcementState?.announcements_read_at || null;
        }
        async function spLoad() {
            const { data, error } = await _supabase.from('support_messages').select('*').order('created_at', { ascending: true }).limit(2000);
            if (error) { console.warn('Support chat not available:', error.message); spReady = false; return; }
            spReady = true;
            spMsgs = data || [];
            await spLoadAnnouncements();
            spChanged();
        }
        async function spLoadAnnouncements() {
            const { data, error } = await _supabase.from('support_announcements').select('*').order('created_at', { ascending: true }).limit(2000);
            if (error) {
                console.warn('Support announcements not available:', error.message);
                spAnnouncementsReady = false;
                spAnnouncementsError = error.message;
                spAnnouncements = [];
                return;
            }
            spAnnouncementsReady = true;
            spAnnouncementsError = '';
            spAnnouncements = data || [];
        }
        function spChanged() {
            spUpdateBadges();
            if (spModalOpen()) spRender();
        }
        function spUpdateBadges() {
            const unreadMessages = spMsgs.filter(m => spVisibleToUser(m) && spUnreadOf(m)).length;
            const unreadAnnouncements = spIsAdmin ? 0 : spAnnouncements.filter(a =>
                !spAnnouncementsReadAt || new Date(a.created_at) > new Date(spAnnouncementsReadAt)
            ).length;
            const n = unreadMessages + unreadAnnouncements;
            const b = document.getElementById('sp-badge');
            const avatarBadge = document.getElementById('sp-avatar-badge');
            const label = n > 99 ? '99+' : String(n);
            b.textContent = label;
            b.classList.toggle('hidden', n === 0);
            avatarBadge.textContent = label;
            avatarBadge.classList.toggle('hidden', n === 0);
            avatarBadge.setAttribute('aria-label', `${n} unread support ${n === 1 ? 'message' : 'messages'}`);
        }
        function spThreads() {
            const map = {};
            spMsgs.forEach(m => (map[m.thread_user_id] = map[m.thread_user_id] || []).push(m));
            return Object.entries(map).map(([id, arr]) => ({
                id, arr, last: arr[arr.length - 1],
                label: (arr.find(x => x.sender_role === 'user') || {}).user_label ||
                    (spUsers.find(user => user.user_id === id) || {}).user_label || id.slice(0, 8),
                unread: arr.filter(x => x.sender_role === 'user' && !x.read_by_admin).length
            })).sort((a, b) => new Date(b.last.created_at) - new Date(a.last.created_at));
        }
        function spOpen() {
            document.getElementById('header-menu-dropdown').classList.add('hidden');
            if (!spReady) { showToast('Support chat is not set up yet. Run support_chat.sql and support_chat_features.sql in Supabase, then reload.', { tone: 'error', duration: 8000 }); return; }
            document.getElementById('sp-modal').classList.remove('hidden');
            spBroadcastMode = false;
            spNewChatMode = false;
            spActiveThread = spIsAdmin ? null : currentUserId;
            spRender();
            if (spIsAdmin) {
                spFetchUsers().then(() => {
                    if (spModalOpen() && !spNewChatMode && !spActiveThread) spRender();
                });
            }
        }
        function spClose() { document.getElementById('sp-modal').classList.add('hidden'); }
        function spBack() {
            spClearSelectedImages();
            if (spBroadcastMode) document.getElementById('sp-input').value = '';
            spBroadcastMode = false;
            spNewChatMode = false;
            spActiveThread = null;
            spSelectedRecipients.clear();
            spUserSearch = '';
            spUserDropdownOpen = false;
            spRender();
        }
        function spOpenThread(id) {
            if (spActiveThread !== id || spBroadcastMode) spClearSelectedImages();
            if (spBroadcastMode) document.getElementById('sp-input').value = '';
            spBroadcastMode = false;
            spNewChatMode = false;
            spActiveThread = id;
            spRender();
        }
        async function spFetchUsers() {
            if (spUsersLoadPromise) return spUsersLoadPromise;
            spUsersLoading = true;
            spUsersError = '';
            spUsersLoadPromise = (async () => {
                try {
                    const { data, error } = await _supabase.rpc('support_admin_list_users');
                    if (error) throw error;
                    spUsers = (data || []).filter(user => typeof user.user_id === 'string' &&
                        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(user.user_id));
                    return true;
                } catch (error) {
                    spUsersError = error.message || 'Could not load users.';
                    console.warn('Could not load support users:', spUsersError);
                    return false;
                } finally {
                    spUsersLoading = false;
                    spUsersLoadPromise = null;
                }
            })();
            return spUsersLoadPromise;
        }
        async function spOpenNewChat() {
            if (!spIsAdmin) return;
            spClearSelectedImages();
            document.getElementById('sp-input').value = '';
            spActiveThread = null;
            spBroadcastMode = false;
            spNewChatMode = true;
            spSelectedRecipients.clear();
            spUserSearch = '';
            spUserDropdownOpen = true;
            spUsers = [];
            spRender();
            if (!(await spFetchUsers())) {
                showToast(`Could not load users: ${spUsersError}. Run support_admin_messaging.sql in Supabase, then reload.`, { tone: 'error', duration: 10000 });
            }
            if (spNewChatMode) spRender();
        }
        function spNewChatRecipientsHtml() {
            const body = document.getElementById('sp-body');
            const query = spUserSearch.trim().toLowerCase();
            const selectedUsers = spUsers.filter(user => spSelectedRecipients.has(user.user_id));
            const availableUsers = spUsers.filter(user => !spSelectedRecipients.has(user.user_id));
            const matchingUsers = availableUsers.filter(user =>
                !query || `${user.user_label || ''} ${user.email || ''}`.toLowerCase().includes(query)
            );
            const allUsers = spUsers.length === 0;
            body.innerHTML = `
                <div class="space-y-3">
                    <label class="block text-xs font-semibold text-slate-500 dark:text-slate-400" for="sp-user-search">Recipients</label>
                    ${selectedUsers.length ? `
                        <div class="flex flex-wrap gap-2" aria-label="Selected recipients">
                            ${selectedUsers.map(user => `
                                <span class="inline-flex max-w-full items-center gap-2 rounded-full border border-indigo-300/60 bg-indigo-50 px-3 py-1.5 text-xs text-indigo-800 dark:border-indigo-500/30 dark:bg-indigo-950/40 dark:text-indigo-200">
                                    <span class="min-w-0 truncate">${escapeHtml(user.user_label || user.email || 'User')}</span>
                                    <button type="button" data-sp-remove-user="${escapeHtml(user.user_id)}" aria-label="Remove ${escapeHtml(user.user_label || user.email || 'user')}" class="shrink-0 rounded-full px-1 text-sm leading-none hover:bg-indigo-200/70 dark:hover:bg-indigo-800/70">&times;</button>
                                </span>`).join('')}
                        </div>` : ''}
                    <div class="relative">
                        <input id="sp-user-search" type="search" value="${escapeHtml(spUserSearch)}" aria-expanded="${spUserDropdownOpen}" aria-controls="sp-user-list" autocomplete="off" placeholder="Select or search users…" class="w-full rounded-xl border border-slate-200 bg-white/70 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-800/70">
                        ${spUserDropdownOpen ? `
                            <div id="sp-user-list" class="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white p-1 shadow-xl dark:border-slate-700 dark:bg-slate-800" role="listbox" aria-label="Available users">
                                ${spUsersLoading
                                    ? '<p class="px-3 py-4 text-center text-sm text-slate-500">Loading users…</p>'
                                    : spUsersError && allUsers
                                        ? `<p class="px-3 py-4 text-center text-sm text-red-500">${escapeHtml(spUsersError)}</p>`
                                        : allUsers
                                            ? '<p class="px-3 py-4 text-center text-sm text-slate-500">No users found.</p>'
                                            : matchingUsers.length
                                                ? matchingUsers.map(user => `
                                                    <button type="button" data-sp-select-user="${escapeHtml(user.user_id)}" role="option" class="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left hover:bg-indigo-50 dark:hover:bg-indigo-950/50">
                                                        <span class="min-w-0">
                                                            <span class="block truncate text-sm font-medium text-slate-800 dark:text-slate-100">${escapeHtml(user.user_label || 'User')}</span>
                                                            <span class="block truncate text-xs text-slate-500">${escapeHtml(user.email || '')}</span>
                                                        </span>
                                                        <span class="text-xs text-indigo-600 dark:text-indigo-300">Add</span>
                                                    </button>`).join('')
                                                : '<p class="px-3 py-4 text-center text-sm text-slate-500">No matching users.</p>'}
                            </div>` : ''}
                    </div>
                    <p class="text-xs text-slate-500">${spSelectedRecipients.size} recipient${spSelectedRecipients.size === 1 ? '' : 's'} selected. Each receives a private message in their own support chat.</p>
                </div>`;
            const search = document.getElementById('sp-user-search');
            if (search) search.addEventListener('input', () => {
                spUserSearch = search.value;
                spUserDropdownOpen = true;
                const cursor = search.selectionStart;
                spNewChatRecipientsHtml();
                const refreshed = document.getElementById('sp-user-search');
                refreshed.focus();
                refreshed.setSelectionRange(cursor, cursor);
            });
            if (search) {
                search.addEventListener('focus', () => {
                    if (spUserDropdownOpen) return;
                    spUserDropdownOpen = true;
                    spNewChatRecipientsHtml();
                    document.getElementById('sp-user-search').focus();
                });
                search.addEventListener('keydown', event => {
                    if (event.key === 'Escape') {
                        spUserDropdownOpen = false;
                        spNewChatRecipientsHtml();
                    }
                });
            }
            body.querySelectorAll('[data-sp-select-user]').forEach(button => button.addEventListener('click', () => {
                spSelectedRecipients.add(button.dataset.spSelectUser);
                spUserSearch = '';
                spUserDropdownOpen = true;
                spNewChatRecipientsHtml();
                document.getElementById('sp-user-search').focus();
                spUpdateNewChatSendButton();
            }));
            body.querySelectorAll('[data-sp-remove-user]').forEach(button => button.addEventListener('click', () => {
                spSelectedRecipients.delete(button.dataset.spRemoveUser);
                spNewChatRecipientsHtml();
                spUpdateNewChatSendButton();
            }));
        }
        function spUpdateNewChatSendButton() {
            const button = document.getElementById('sp-send');
            if (!spNewChatMode || spSending) return;
            button.textContent = spSelectedRecipients.size ? `Send to ${spSelectedRecipients.size} user${spSelectedRecipients.size === 1 ? '' : 's'}` : 'Select recipients';
            button.disabled = spSelectedRecipients.size === 0 ||
                (!document.getElementById('sp-input').value.trim() && spSelectedImages.length === 0);
        }
        function spOpenBroadcast() {
            if (!spAnnouncementsReady) {
                showToast(`Announcements are unavailable: ${spAnnouncementsError || 'run support_chat_features.sql in Supabase, then reload'}`, { tone: 'error', duration: 8000 });
                return;
            }
            spClearSelectedImages();
            document.getElementById('sp-input').value = '';
            spActiveThread = null;
            spNewChatMode = false;
            spBroadcastMode = true;
            spRender();
        }
        function spFmt(ts) { const d = new Date(ts); return d.toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
        function spRenderSelectedImages() {
            const preview = document.getElementById('sp-attachments-preview');
            preview.classList.toggle('hidden', spSelectedImages.length === 0);
            preview.innerHTML = spSelectedImages.map((item, index) => `<div class="relative">
                <img src="${item.previewUrl}" alt="${escapeHtml(item.file.name)}" class="h-14 w-14 rounded-lg border border-slate-300 dark:border-slate-600 object-cover">
                <button type="button" onclick="spRemoveImage(${index})" aria-label="Remove ${escapeHtml(item.file.name)}" class="absolute -right-1.5 -top-1.5 h-5 w-5 rounded-full bg-red-600 text-xs text-white">×</button>
            </div>`).join('');
        }
        function spChooseImages(event) {
            const input = event.target;
            const files = Array.from(input.files || []);
            input.value = '';
            for (const file of files) {
                if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
                    showToast('Choose a JPEG, PNG, or WebP image.', { tone: 'error' });
                    continue;
                }
                if (file.size > SP_MAX_IMAGE_BYTES) {
                    showToast(`${file.name} is larger than 5 MB.`, { tone: 'error' });
                    continue;
                }
                if (spSelectedImages.length >= SP_MAX_IMAGES) {
                    showToast('You can attach up to 4 images per message.', { tone: 'error' });
                    break;
                }
                spSelectedImages.push({ file, previewUrl: URL.createObjectURL(file), storagePath: null });
            }
            spRenderSelectedImages();
            spUpdateNewChatSendButton();
        }
        function spRemoveImage(index) {
            const [removed] = spSelectedImages.splice(index, 1);
            if (removed) URL.revokeObjectURL(removed.previewUrl);
            spRenderSelectedImages();
            spUpdateNewChatSendButton();
        }
        function spClearSelectedImages() {
            spSelectedImages.forEach(item => URL.revokeObjectURL(item.previewUrl));
            spSelectedImages = [];
            spRenderSelectedImages();
            spUpdateNewChatSendButton();
        }
        async function spClearHistory() {
            if (spIsAdmin) return;
            const confirmed = await showConfirm(
                'Clear your chat history?',
                'Previous messages will disappear from your view, but support administrators will retain access to the full conversation.',
                { confirmLabel: 'Clear for me' }
            );
            if (!confirmed) return;
            if (!spHistoryStateReady) {
                showToast('History clearing is not set up. Run support_chat_features.sql in Supabase, then reload.', { tone: 'error', duration: 8000 });
                return;
            }
            const button = document.getElementById('sp-clear-history');
            button.disabled = true;
            try {
                const { data, error } = await _supabase.rpc('support_clear_history');
                if (error) throw error;
                const clearedAt = Array.isArray(data) ? data[0] : data;
                if (typeof clearedAt !== 'string' || !Number.isFinite(Date.parse(clearedAt))) {
                    throw new Error('The server did not return a valid clear timestamp.');
                }
                spHistoryClearedAt = clearedAt;
                spMsgs = spMsgs.filter(spVisibleToUser);
                spChanged();
                showToast('Your chat history is cleared. Support administrators can still see the full conversation.', { tone: 'success' });
            } catch (error) {
                showToast(`Could not clear chat history: ${error.message}`, { tone: 'error', duration: 8000 });
            } finally {
                button.disabled = false;
            }
        }
        function spBubble(m) {
            const mine = spIsAdmin ? m.sender_role === 'admin' : m.sender_role === 'user';
            const who = m.sender_role === 'admin' ? 'Admin' : (spIsAdmin ? (m.user_label || 'User') : 'You');
            const tag = m.kind && m.sender_role === 'user' ? `<span class="opacity-70">${SP_KINDS[m.kind] || ''} · </span>` : '';
            const images = (Array.isArray(m.image_paths) ? m.image_paths : [])
                .filter(path => typeof path === 'string' && path.startsWith(`${m.thread_user_id}/`))
                .map(path => `<img data-sp-image-path="${escapeHtml(path)}" alt="Attached image" class="mt-2 max-h-56 max-w-full rounded-lg object-contain bg-black/10">`).join('');
            const deleteButton = spIsAdmin && m.sender_role === 'admin' && m.sender_id === currentUserId
                ? `<button type="button" data-sp-delete-message="${escapeHtml(String(m.id))}" class="mt-2 text-[10px] underline opacity-75 hover:opacity-100" aria-label="Delete your reply">Delete reply</button>`
                : '';
            return `<div class="flex ${mine ? 'justify-end' : 'justify-start'}"><div class="sp-message-bubble ${mine ? 'sp-message-mine' : 'sp-message-other'} max-w-[85%] rounded-2xl px-3 py-2 text-sm ${mine ? 'bg-indigo-600 text-white' : 'bg-slate-100 dark:bg-slate-700'}">
                <div class="text-[10px] mb-0.5 ${mine ? 'text-indigo-100' : 'text-slate-500 dark:text-slate-400'}">${tag}${escapeHtml(who)} · ${spFmt(m.created_at)}</div>
                ${m.body ? `<div style="white-space:pre-wrap;word-break:break-word">${escapeHtml(m.body)}</div>` : ''}${images}${deleteButton}</div></div>`;
        }
        function spAnnouncementBubble(announcement) {
            const deleteButton = spIsAdmin
                ? `<button type="button" data-sp-delete-announcement="${escapeHtml(String(announcement.id))}" class="mt-2 text-[10px] underline opacity-75 hover:opacity-100" aria-label="Delete announcement">Delete announcement</button>`
                : '';
            const images = (Array.isArray(announcement.image_paths) ? announcement.image_paths : [])
                .filter(path => typeof path === 'string' && announcement.created_by && path.startsWith(`${announcement.created_by}/`))
                .map(path => `<img data-sp-image-path="${escapeHtml(path)}" alt="Announcement image" class="mt-2 max-h-56 max-w-full rounded-lg object-contain bg-black/10">`).join('');
            return `<div class="flex justify-start"><div class="max-w-[90%] rounded-2xl border border-amber-300/50 bg-amber-50 px-3 py-2 text-sm dark:border-amber-500/30 dark:bg-amber-950/30">
                <div class="mb-0.5 text-[10px] text-amber-700 dark:text-amber-300">📢 Admin announcement · ${spFmt(announcement.created_at)}</div>
                ${announcement.body ? `<div style="white-space:pre-wrap;word-break:break-word">${escapeHtml(announcement.body)}</div>` : ''}${images}${deleteButton}</div></div>`;
        }
        function spBindDeleteActions(body) {
            body.querySelectorAll('[data-sp-delete-message]').forEach(button => {
                button.addEventListener('click', () => spDeleteAdminReply(button.dataset.spDeleteMessage));
            });
            body.querySelectorAll('[data-sp-delete-announcement]').forEach(button => {
                button.addEventListener('click', () => spDeleteAnnouncement(button.dataset.spDeleteAnnouncement));
            });
        }
        async function spDeleteAdminReply(messageId) {
            if (!spIsAdmin || !messageId) return;
            const message = spMsgs.find(item => String(item.id) === String(messageId));
            if (!message || message.sender_role !== 'admin' || message.sender_id !== currentUserId) return;
            const confirmed = await showConfirm(
                'Delete your reply?',
                'This removes your reply from the conversation for you and the user.',
                { confirmLabel: 'Delete reply' }
            );
            if (!confirmed) return;
            try {
                const { data: imagePaths, error } = await _supabase.rpc('support_delete_admin_reply', { p_message_id: String(messageId) });
                if (error) throw error;
                spMsgs = spMsgs.filter(item => String(item.id) !== String(messageId));
                spChanged();
                if (Array.isArray(imagePaths) && imagePaths.length) {
                    const { error: cleanupError } = await _supabase.storage.from(SP_IMAGE_BUCKET).remove(imagePaths);
                    if (cleanupError) {
                        console.warn('Deleted reply but could not remove its attached images:', cleanupError.message);
                        showToast('Reply deleted, but its attached images could not be removed.', { tone: 'error', duration: 8000 });
                        return;
                    }
                }
                showToast('Reply deleted.', { tone: 'success' });
            } catch (error) {
                showToast(`Could not delete reply: ${error.message}`, { tone: 'error', duration: 8000 });
            }
        }
        async function spDeleteAnnouncement(announcementId) {
            if (!spIsAdmin || !announcementId || !spAnnouncements.some(item => String(item.id) === String(announcementId))) return;
            const confirmed = await showConfirm(
                'Delete this announcement?',
                'This removes the announcement from the announcements list for all users.',
                { confirmLabel: 'Delete announcement' }
            );
            if (!confirmed) return;
            try {
                const { data: imagePaths, error } = await _supabase.rpc('support_delete_announcement', { p_announcement_id: String(announcementId) });
                if (error) throw error;
                spAnnouncements = spAnnouncements.filter(item => String(item.id) !== String(announcementId));
                spChanged();
                if (Array.isArray(imagePaths) && imagePaths.length) {
                    const { error: cleanupError } = await _supabase.storage.from(SP_IMAGE_BUCKET).remove(imagePaths);
                    if (cleanupError) {
                        console.warn('Deleted announcement but could not remove its attached images:', cleanupError.message);
                        showToast('Announcement deleted, but its attached images could not be removed.', { tone: 'error', duration: 8000 });
                        return;
                    }
                }
                showToast('Announcement deleted.', { tone: 'success' });
            } catch (error) {
                showToast(`Could not delete announcement: ${error.message}`, { tone: 'error', duration: 8000 });
            }
        }
        async function spHydrateImages(body, renderVersion) {
            for (const img of body.querySelectorAll('[data-sp-image-path]')) {
                const path = img.dataset.spImagePath;
                try {
                    let url = spSignedUrlCache.get(path);
                    if (!url || url.expiresAt <= Date.now() + 30000) {
                        const { data, error } = await _supabase.storage.from(SP_IMAGE_BUCKET).createSignedUrl(path, 3600);
                        if (error) throw error;
                        url = { value: data.signedUrl, expiresAt: Date.now() + 3500000 };
                        spSignedUrlCache.set(path, url);
                    }
                    if (renderVersion !== spRenderVersion || !img.isConnected) continue;
                    img.src = url.value;
                } catch (error) {
                    console.warn('Could not load support image:', error.message);
                    if (renderVersion === spRenderVersion && img.isConnected) {
                        const unavailable = document.createElement('span');
                        unavailable.className = 'mt-2 block text-xs opacity-70';
                        unavailable.textContent = 'Image unavailable';
                        img.replaceWith(unavailable);
                    }
                }
            }
        }
        function spRender() {
            const body = document.getElementById('sp-body'), composer = document.getElementById('sp-composer');
            const title = document.getElementById('sp-title'), sub = document.getElementById('sp-sub'), back = document.getElementById('sp-back');
            const clearHistory = document.getElementById('sp-clear-history');
            const kind = document.getElementById('sp-kind');
            const imagePicker = document.getElementById('sp-image-picker');
            const input = document.getElementById('sp-input');
            const send = document.getElementById('sp-send');
            if (spIsAdmin && spNewChatMode) {
                title.textContent = 'New chat';
                sub.textContent = 'Send a private message to selected users';
                back.classList.remove('hidden');
                clearHistory.classList.add('hidden');
                composer.classList.remove('hidden');
                kind.classList.add('hidden');
                imagePicker.classList.remove('hidden');
                document.getElementById('sp-attachments-preview').classList.toggle('hidden', spSelectedImages.length === 0);
                input.placeholder = 'Write a message to selected users…';
                body.scrollTop = 0;
                spNewChatRecipientsHtml();
                spUpdateNewChatSendButton();
                input.oninput = spUpdateNewChatSendButton;
                return;
            }
            input.oninput = null;
            if (spIsAdmin && spBroadcastMode) {
                title.textContent = 'Announcements to all users';
                sub.textContent = 'Every signed-in user can see these messages';
                back.classList.remove('hidden');
                clearHistory.classList.add('hidden');
                composer.classList.remove('hidden');
                kind.classList.add('hidden');
                imagePicker.classList.remove('hidden');
                document.getElementById('sp-attachments-preview').classList.toggle('hidden', spSelectedImages.length === 0);
                input.placeholder = 'Write an update for all users…';
                send.textContent = 'Announce';
                body.innerHTML = spAnnouncements.length
                    ? spAnnouncements.map(spAnnouncementBubble).join('')
                    : '<p class="text-sm text-slate-500 text-center mt-8">No announcements yet. Send an update to all users.</p>';
                spBindDeleteActions(body);
                const renderVersion = ++spRenderVersion;
                spHydrateImages(body, renderVersion);
                body.scrollTop = body.scrollHeight;
                return;
            }
            if (spIsAdmin && !spActiveThread) {
                title.textContent = 'Admin Inbox'; sub.textContent = 'All user conversations'; back.classList.add('hidden'); composer.classList.add('hidden');
                clearHistory.classList.add('hidden');
                const th = spThreads();
                body.innerHTML = `<button onclick="spOpenNewChat()" class="sp-inbox-item mb-2 w-full rounded-xl border border-emerald-300/50 bg-emerald-50 px-3 py-3 text-left text-sm font-semibold text-emerald-700 hover:bg-emerald-100 dark:border-emerald-500/30 dark:bg-emerald-950/30 dark:text-emerald-200 dark:hover:bg-emerald-950/50">✉️ New chat<span class="mt-0.5 block text-xs font-normal opacity-75">Start a private chat with selected users</span></button>
                    <button onclick="spOpenBroadcast()" class="sp-inbox-item sp-inbox-announcement mb-2 w-full rounded-xl border border-indigo-300/50 bg-indigo-50 px-3 py-3 text-left text-sm font-semibold text-indigo-700 hover:bg-indigo-100 dark:border-indigo-500/30 dark:bg-indigo-950/30 dark:text-indigo-200 dark:hover:bg-indigo-950/50">📢 Announce to all users<span class="mt-0.5 block text-xs font-normal opacity-75">Share updates and changes in one message</span></button>`
                    + (th.length ? th.map(t => `<button onclick="spOpenThread('${t.id}')" class="sp-inbox-item w-full text-left rounded-xl border border-slate-200 dark:border-slate-700 px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition">
                    <div class="flex items-center justify-between gap-2"><span class="text-sm font-semibold truncate">${escapeHtml(t.label)}</span><span class="text-[10px] text-slate-500 shrink-0">${spFmt(t.last.created_at)}</span></div>
                    <div class="flex items-center justify-between gap-2 mt-0.5"><span class="text-xs text-slate-500 truncate">${t.last.sender_role === 'admin' ? 'You: ' : ''}${escapeHtml(t.last.body || (t.last.image_paths?.length ? '📷 Photo' : ''))}</span>${t.unread ? `<span class="rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold text-white shrink-0">${t.unread}</span>` : ''}</div></button>`).join('')
                    : '<p class="py-4 text-sm text-slate-500 text-center">No direct conversations yet.</p>');
                return;
            }
            const arr = spMsgs.filter(m => m.thread_user_id === spActiveThread && spVisibleToUser(m));
            const announcements = spIsAdmin ? [] : spAnnouncements;
            const timeline = arr.map(message => ({ ...message, isAnnouncement: false }))
                .concat(announcements.map(announcement => ({ ...announcement, isAnnouncement: true })))
                .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
            const th = spThreads().find(t => t.id === spActiveThread);
            title.textContent = spIsAdmin ? (th ? th.label : 'Conversation') : 'Chat with Admin';
            sub.textContent = spIsAdmin ? 'Reply goes to this user' : 'Messages to support.';
            back.classList.toggle('hidden', !spIsAdmin);
            clearHistory.classList.toggle('hidden', spIsAdmin);
            composer.classList.remove('hidden');
            kind.classList.toggle('hidden', spIsAdmin);
            imagePicker.classList.toggle('hidden', false);
            input.placeholder = 'Type your message…';
            send.textContent = 'Send';
            body.innerHTML = timeline.length ? timeline.map(item => item.isAnnouncement ? spAnnouncementBubble(item) : spBubble(item)).join('')
                : '<p class="text-sm text-slate-500 text-center mt-8">No messages yet. Say hello 👋</p>';
            spBindDeleteActions(body);
            const renderVersion = ++spRenderVersion;
            spHydrateImages(body, renderVersion);
            body.scrollTop = body.scrollHeight;
            if (arr.some(spUnreadOf)) spMarkRead(spActiveThread);
            if (!spIsAdmin && announcements.length) spMarkAnnouncementsRead();
        }
        async function spMarkRead(thread) {
            const { error } = await _supabase.rpc('support_mark_read', { p_thread: thread });
            if (error) { console.warn('mark read failed:', error.message); return; }
            spMsgs.forEach(m => { if (m.thread_user_id === thread && spIncoming(m)) { if (spIsAdmin) m.read_by_admin = true; else m.read_by_user = true; } });
            spUpdateBadges();
        }
        async function spMarkAnnouncementsRead() {
            if (spIsAdmin || spAnnouncementsReadPending || !spAnnouncements.length) return;
            const latest = spAnnouncements[spAnnouncements.length - 1].created_at;
            if (spAnnouncementsReadAt && new Date(latest) <= new Date(spAnnouncementsReadAt)) return;
            spAnnouncementsReadPending = true;
            try {
                const { data, error } = await _supabase.rpc('support_mark_announcements_read');
                if (error) throw error;
                const readAt = Array.isArray(data) ? data[0] : data;
                if (typeof readAt !== 'string' || !Number.isFinite(Date.parse(readAt))) {
                    throw new Error('The server did not return a valid read timestamp.');
                }
                spAnnouncementsReadAt = readAt;
                spUpdateBadges();
            } catch (error) {
                console.warn('Could not mark announcements as read:', error.message);
            } finally {
                spAnnouncementsReadPending = false;
            }
        }
        let spSending = false;
        async function spSend() {
            if (spIsAdmin && spNewChatMode) {
                await spSendNewChat();
                return;
            }
            if (spIsAdmin && spBroadcastMode) {
                await spSendAnnouncement();
                return;
            }
            const ta = document.getElementById('sp-input'), text = ta.value.trim();
            const thread = spIsAdmin ? spActiveThread : currentUserId;
            if ((!text && !spSelectedImages.length) || !thread || spSending) return;
            spSending = true; document.getElementById('sp-send').disabled = true;
            try {
                const imagePaths = [];
                for (const item of spSelectedImages) {
                    if (!item.storagePath) {
                        const extension = item.file.type === 'image/jpeg' ? 'jpg' : item.file.type === 'image/png' ? 'png' : 'webp';
                        const storagePath = `${thread}/${newId()}.${extension}`;
                        const { error: uploadError } = await _supabase.storage.from(SP_IMAGE_BUCKET)
                            .upload(storagePath, item.file, { contentType: item.file.type, upsert: false });
                        if (uploadError) throw uploadError;
                        item.storagePath = storagePath;
                    }
                    imagePaths.push(item.storagePath);
                }
                const label = currentUsername || (document.getElementById('user-email-label')?.title || '').split('@')[0] || 'user';
                const row = { thread_user_id: thread, sender_id: currentUserId, sender_role: spIsAdmin ? 'admin' : 'user', body: text,
                              kind: spIsAdmin ? null : document.getElementById('sp-kind').value, user_label: spIsAdmin ? null : label };
                if (imagePaths.length) row.image_paths = imagePaths;
                const { data, error } = await _supabase.from('support_messages').insert(row).select().single();
                if (error) throw error;
                ta.value = '';
                spClearSelectedImages();
                if (!spMsgs.some(x => x.id === data.id)) spMsgs.push(data);
                spChanged();
            } catch (error) {
                showToast(`Message not sent: ${error.message}`, { tone: 'error', duration: 8000 });
            } finally {
                spSending = false;
                document.getElementById('sp-send').disabled = false;
            }
        }
        async function spSendNewChat() {
            const input = document.getElementById('sp-input');
            const text = input.value.trim();
            const recipients = [...spSelectedRecipients];
            if (!spIsAdmin || (!text && !spSelectedImages.length) || !recipients.length || spSending) return;
            spSending = true;
            const send = document.getElementById('sp-send');
            send.disabled = true;
            send.textContent = 'Sending…';
            const sentRecipients = [];
            try {
                for (const recipient of recipients) {
                    const imagePaths = [];
                    try {
                        for (const item of spSelectedImages) {
                            const extension = item.file.type === 'image/jpeg' ? 'jpg' : item.file.type === 'image/png' ? 'png' : 'webp';
                            const storagePath = `${recipient}/${newId()}.${extension}`;
                            const { error: uploadError } = await _supabase.storage.from(SP_IMAGE_BUCKET)
                                .upload(storagePath, item.file, { contentType: item.file.type, upsert: false });
                            if (uploadError) throw uploadError;
                            imagePaths.push(storagePath);
                        }
                        const row = {
                            thread_user_id: recipient,
                            sender_id: currentUserId,
                            sender_role: 'admin',
                            body: text,
                            kind: null,
                            user_label: null
                        };
                        if (imagePaths.length) row.image_paths = imagePaths;
                        const { data, error } = await _supabase.from('support_messages').insert(row).select().single();
                        if (error) throw error;
                        if (!spMsgs.some(message => message.id === data.id)) spMsgs.push(data);
                        sentRecipients.push(recipient);
                    } catch (error) {
                        if (imagePaths.length) {
                            const { error: cleanupError } = await _supabase.storage.from(SP_IMAGE_BUCKET).remove(imagePaths);
                            if (cleanupError) {
                                console.warn('Could not remove images for an unsent private message:', cleanupError.message);
                                throw new Error(`${error.message}; uploaded images could not be removed`);
                            }
                        }
                        throw error;
                    }
                }
                input.value = '';
                spSelectedRecipients.clear();
                spClearSelectedImages();
                spNewChatMode = false;
                spActiveThread = null;
                await spLoad();
                spRender();
                showToast(`Private message sent to ${recipients.length} user${recipients.length === 1 ? '' : 's'}.`, { tone: 'success' });
            } catch (error) {
                sentRecipients.forEach(recipient => spSelectedRecipients.delete(recipient));
                if (sentRecipients.length) {
                    spNewChatRecipientsHtml();
                    spUpdateNewChatSendButton();
                    spChanged();
                    showToast(`Message sent to ${sentRecipients.length} of ${recipients.length} users. Remaining recipients are still selected. ${error.message}`, { tone: 'error', duration: 10000 });
                } else {
                    showToast(`Message not sent: ${error.message}`, { tone: 'error', duration: 10000 });
                }
            } finally {
                spSending = false;
                if (spNewChatMode) spUpdateNewChatSendButton();
                else send.disabled = false;
            }
        }
        async function spSendAnnouncement() {
            const input = document.getElementById('sp-input');
            const text = input.value.trim();
            if ((!text && !spSelectedImages.length) || spSending) return;
            spSending = true;
            document.getElementById('sp-send').disabled = true;
            try {
                const imagePaths = [];
                for (const item of spSelectedImages) {
                    if (!item.storagePath) {
                        const extension = item.file.type === 'image/jpeg' ? 'jpg' : item.file.type === 'image/png' ? 'png' : 'webp';
                        const storagePath = `${currentUserId}/${newId()}.${extension}`;
                        const { error: uploadError } = await _supabase.storage.from(SP_IMAGE_BUCKET)
                            .upload(storagePath, item.file, { contentType: item.file.type, upsert: false });
                        if (uploadError) throw uploadError;
                        item.storagePath = storagePath;
                    }
                    imagePaths.push(item.storagePath);
                }
                const announcementRow = { created_by: currentUserId, body: text };
                if (imagePaths.length) announcementRow.image_paths = imagePaths;
                const { data, error } = await _supabase.from('support_announcements')
                    .insert(announcementRow).select().single();
                if (error) throw error;
                if (!spAnnouncements.some(item => item.id === data.id)) {
                    spAnnouncements.push(data);
                    spAnnouncements.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
                }
                input.value = '';
                spClearSelectedImages();
                spChanged();
                showToast('Announcement sent to all users.', { tone: 'success' });
            } catch (error) {
                showToast(`Announcement not sent: ${error.message}`, { tone: 'error', duration: 8000 });
            } finally {
                spSending = false;
                document.getElementById('sp-send').disabled = false;
            }
        }

        function render() {
            renderTypeFilter();
            renderCardsList();
            updateCardDropdowns();
            recommendBestCard();
            renderCardFilters();
            renderTransactionsAndMetrics();
        }

        // If the tab was left open overnight, refresh the due-date colours when you come back to it.
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && cards.length > 0) renderCardsList();
        });

        function showLoadingError(message) {
            const overlay = document.getElementById('app-loading-overlay');
            if (!overlay) return;
            overlay.classList.remove('hidden');
            overlay.innerHTML = `
                <div class="text-center px-6">
                    <p class="text-3xl mb-2">⚠️</p>
                    <p class="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Couldn't load the app</p>
                    <p class="text-xs text-slate-500 dark:text-slate-400 mb-4 max-w-xs">${message}</p>
                    <button onclick="location.reload()" class="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium px-4 py-2 rounded-lg transition">Reload Page</button>
                </div>
            `;
        }

        // Safety net: if loading takes too long, stop spinning silently and say so.
        const bootWatchdog = setTimeout(() => {
            const overlay = document.getElementById('app-loading-overlay');
            if (overlay && !overlay.classList.contains('hidden')) {
                showLoadingError('This is taking much longer than expected — check your internet connection, or there may be an issue reaching the database. Open the browser console (F12) for details.');
            }
        }, 12000);

        const originalHideLoadingOverlay = hideLoadingOverlay;
        hideLoadingOverlay = function () {
            clearTimeout(bootWatchdog);
            originalHideLoadingOverlay();
        };

        boot().catch(err => {
            console.error('Boot failed:', err);
            showLoadingError(`An error occurred while starting the app: ${err.message || err}. Try reloading — if it keeps happening, check the browser console for details.`);
        });
