# DueDates — offline-capable web app (PWA)

DueDates is a single-page web app backed by Supabase. This build is an installable
Progressive Web App (PWA): after the first online visit it opens and works with no
internet, and any changes made offline sync automatically when you reconnect.

## Folder structure

```
index.html              Page markup only
styles.css              Application styles
app.js                  Main application logic
offline.js              Offline layer (read cache, write queue, session handling)
ui.js                   Modal / sidebar helpers
effects.js              Cursor glow and scroll-lock effects
sw.js                   Service worker (caches the app so it loads offline)
manifest.webmanifest    Install metadata (name, colours, icons)
icon-192.png            App icon
icon-512.png            App icon
apple-touch-icon.png    iPhone/iPad home-screen icon (180x180)
vendor/
  tailwind.css          Pre-built Tailwind CSS (replaces the Tailwind CDN)
  fonts.css             @font-face rules for the bundled fonts
  fonts/                Inter, Plus Jakarta Sans, JetBrains Mono (.woff2)
  chart.umd.js          Chart.js
  xlsx.full.min.js      SheetJS (Excel import/export)
  supabase.js           Supabase JS client
```

**All file names must be lowercase.** GitHub Pages is case-sensitive, so `App.js`
and `app.js` are different files. Windows hides this problem; Pages does not.

## How offline works

| Part | Behaviour offline |
|---|---|
| App shell, libraries, fonts | Cached by `sw.js` on the first online visit |
| Reading data | Every successful Supabase read is saved in the browser (IndexedDB) and shown when offline |
| Adding / editing / deleting cards and transactions | Applied immediately in the app and queued; synced automatically when you are back online |
| Login | If you were signed in on this device, the app opens using the stored session |
| Status | A small pill in the bottom-left shows "Offline" and how many changes are waiting to sync |

### Limits

- The **first visit and signing in need internet** (login, signup and password reset use Supabase servers).
- Support chat, uploaded photos and admin features need internet and are not queued.
- Card rules, cashback reconciliation and custom categories sync later but do not appear in the app until you reconnect.
- If the same record is edited on two devices while offline, the last sync wins.
- If Supabase rejects a queued change on reconnect (for example a permissions error), it is dropped and logged in the browser console.

## Deploy on GitHub Pages

1. Create a **public** repository (Pages on private repos needs a paid plan).
2. Upload everything in this folder to the **repo root**, including the `vendor/` folder and its `fonts/` subfolder. Keep every name lowercase.
3. **Settings → Pages → Build and deployment**: Source = *Deploy from a branch*, Branch = `main`, folder = `/ (root)`, then Save.
4. After 1–2 minutes the site is live at `https://YOUR-USERNAME.github.io/REPO-NAME/`.
5. In Supabase, go to **Authentication → URL Configuration**. Set **Site URL** to the Pages address and add it under **Redirect URLs** (needed for password-reset links).

Service workers only run over HTTPS (or `localhost`). Opening `index.html` directly from disk will show the app but will not install or cache it.

## Install on a device

1. Open the site while online, sign in, and let the data load. Reload once.
2. **Android / desktop Chrome or Edge:** use the browser's *Install app* option.
   **iPhone / iPad Safari:** *Share → Add to Home Screen*.
3. Test: turn on airplane mode and open the app.

## Debit cards

Cards can be **Credit** or **Debit** (choose in *Add / Manage Cards*).

- A debit card has a **balance** instead of a limit, and no statement or payment day.
- Balance = opening balance − purchases − cash withdrawals (− fees, if enabled) + deposits + cashback credited.
- Enter the money in the account today as the card's **Current Balance** when you create the card.
- **Add money** on the card tile logs a deposit (stored as a `Repaid` transaction, so reports keep working; the transaction form shows it as "Deposit / top-up").
- Saving a purchase or withdrawal larger than the balance asks for confirmation. Overdrawn cards show an "Overdrawn" badge.
- The Saved Cards list shows Credit cards and Debit cards under separate headings.
- Fee and cashback settings (Fees & cashback caps, category cashback rates, and the transaction form's Service Fee and Cashback fields) are hidden for debit cards, and any values are ignored on save.
- Debit cards are left out of the credit totals (Total Card Limit / Total Outstanding) and credit-only planners. Their combined balance is shown under Total Card Limit.

**One-time Supabase step** (so the card type syncs across devices). Run in the SQL editor:

```sql
alter table cards add column if not exists card_type text not null default 'credit' check (card_type in ('credit', 'debit'));
```

Until it is run, the app still works: it remembers debit cards on that device only and shows a reminder with this SQL when you save one.

## Transaction types: "feels like"

A custom transaction type behaves like a built-in one, so its amount lands in the right section of balances, outstanding, charts and reports.

- When you add a type (Settings, or *+ Add new type...* in the transaction form) you must pick one radio button under **Feels like**: **Purchase** or **Repaid**. Nothing is pre-selected, and the type is not added until you choose.
  Example: **Annual Fee -> Purchase**, **Deposit -> Repaid**.
- Already configured types are not listed in the settings window; their choice is kept.
- Types without a saved choice (made before this existed, or created by a CSV import) are stored and shown but not counted.
- EMI plans stay limited to the real **Purchase** type.

Database: `shared_options.behaves_like` (already in `duedates_full_setup.sql`; for an existing database run `duedates_update_debit_and_types.sql` once).

## Updating the app

1. Edit the files and commit them.
2. **Bump `VERSION` in `sw.js`** (for example `dd-v13` → `dd-v14`) in the same commit. Without this, installed devices keep serving the old cached files.
3. Devices pick up the new version the next time they open the app online; it may need one extra reload to show.

If you change any CSS class names in the HTML/JS, rebuild `vendor/tailwind.css` (Tailwind v3 CLI, `darkMode: 'class'`, content = `index.html` and the `.js` files), otherwise new utility classes will be missing.

## Changing the icon

iOS saves the icon when the shortcut is created and never updates it afterwards. To change it:
replace the three icon PNGs (square, solid background, artwork kept inside the centre), bump `VERSION` in `sw.js`, then delete the old shortcut and add it again. Your data lives in Supabase, so nothing is lost by re-adding. Open the old shortcut online once before deleting it so any unsynced offline changes are sent first.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Stuck on "Loading your data…" | Open F12 → Console / Network. Look for 404s: usually a wrongly capitalised or missing file, or a missing `vendor/` folder |
| Old version keeps showing | F12 → Application → Service Workers → Unregister, then Storage → Clear site data; reload twice. Also confirm `VERSION` was bumped |
| Works locally but not on Pages | Almost always file-name case or a missing file (see above) |
| Password reset link goes to the wrong place | Check Site URL / Redirect URLs in Supabase |
| Offline changes did not sync | Open the app online and signed in; sync runs on load and when the connection returns. Check the Console for "Offline change rejected" |

## Security notes

- The Supabase URL and publishable (anon) key are visible in the page source. That is normal for browser apps and safe **only if Row Level Security is enabled on every table**.
- Never put a `service_role` key in these files.
- Cached data lives in the browser on that device. Signing out clears the cached data, but use a screen lock on shared devices.
