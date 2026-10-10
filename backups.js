/* Automatic backups — nothing to remember to do.
 *
 *  - On this phone: a copy of the collection and want list once a day (the last
 *    DEVICE_BACKUPS days), and one just before "Remove everything" or a restore.
 *  - In your account (when logged in): the server keeps a copy of each day's starting point
 *    for 30 days (tools/account-worker.mjs), so a phone that's lost or wiped, or a bad change
 *    that synced everywhere, can be undone.
 * Collection → ••• → "Automatic backups" lists them; tap one to put it back.
 *
 * Uses app.js, wants.js and account.js (loaded first). */

const AUTO_BACKUP_KEY = 'pokescan.autobackup.v1'; // [{ at, reason, collection, wants }] newest first
const DEVICE_BACKUPS = 7;

function deviceBackups() {
  try {
    const list = JSON.parse(localStorage.getItem(AUTO_BACKUP_KEY));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

/* Save a copy now. `reason`: 'daily' | 'before-clear' | 'before-restore'. */
function backupNow(reason = 'daily') {
  const collection = loadCollection();
  const wants = loadWants();
  if (!collection.length && !wants.length) return;
  let list = deviceBackups();
  const same = list[0] && JSON.stringify(list[0].collection) === JSON.stringify(collection)
    && JSON.stringify(list[0].wants ?? []) === JSON.stringify(wants);
  if (same && reason === 'daily') { list[0].at = new Date().toISOString(); } else {
    list.unshift({ at: new Date().toISOString(), reason, collection, wants });
  }
  list = list.slice(0, DEVICE_BACKUPS);
  // Phone storage full: keep fewer copies rather than none.
  while (list.length) {
    try { localStorage.setItem(AUTO_BACKUP_KEY, JSON.stringify(list)); return; } catch { list.pop(); }
  }
}

function dailyBackup() {
  const last = deviceBackups().find((b) => b.reason === 'daily');
  if (!last || last.at.slice(0, 10) !== new Date().toISOString().slice(0, 10)) backupNow('daily');
}

const countOf = (collection) => (collection ?? []).reduce((n, e) => n + (Number(e?.qty) || 1), 0);
const backupWhen = (iso) => new Date(iso).toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const backupDay = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
const backupWhat = (n, w) => `${n} card${n === 1 ? '' : 's'}${w ? ` · ${w} wanted` : ''}`;

/* Replace the collection and want list with a backup's (a copy of the current ones is kept). */
function restoreBackup(b, label) {
  if (!confirm(`Put back the backup from ${label}?\n\nYour collection and want list now are replaced by it (${backupWhat(countOf(b.collection), (b.wants ?? []).length)}). A copy of what you have now is kept in Automatic backups.`)) return;
  backupNow('before-restore');
  saveCollection(Array.isArray(b.collection) ? b.collection : []);
  if (Array.isArray(b.wants)) saveWants(b.wants);
  els.detail.close();
  refreshCollection();
  if (wantMode) renderWants();
  toast(`Restored the backup from ${label}`);
}

async function openBackups() {
  $('collectionMenu').open = false;
  const token = ++sheetToken;
  const reasons = { daily: '', 'before-clear': ' · before “Remove everything”', 'before-restore': ' · before a restore' };
  const device = deviceBackups();
  els.detailBody.innerHTML = `
    <p class="detail-title">Automatic backups</p>
    <p class="price-note">Your collection and want list are backed up by themselves — no need to do anything. Tap one to put it back.</p>
    <h3 class="sub-title">On this phone</h3>
    <div class="results" id="deviceBackups">${device.length ? '' : '<p class="muted">None yet — one is made each day you open the app.</p>'}</div>
    <h3 class="sub-title">In your account</h3>
    <div class="results" id="accountBackups"><p class="muted">${acct.session ? '<span class="spinner"></span>Loading…' : 'Log in to keep backups in your account too.'}</p></div>
    <div class="detail-actions"><button type="button" class="btn ghost" id="backupsClose">Close</button></div>`;
  const row = (title, sub, onClick) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'card-row backup-row';
    btn.innerHTML = `<div class="meta"><div class="name">${esc(title)}</div><div class="sub">${esc(sub)}</div></div><span class="row-price">Restore</span>`;
    btn.addEventListener('click', onClick);
    return btn;
  };
  for (const b of device) {
    const label = backupWhen(b.at);
    $('deviceBackups').appendChild(row(label, backupWhat(countOf(b.collection), (b.wants ?? []).length) + (reasons[b.reason] ?? ''), () => restoreBackup(b, label)));
  }
  $('backupsClose').addEventListener('click', () => els.detail.close());
  els.detail.showModal();

  if (!acct.session) return;
  const box = $('accountBackups');
  try {
    const { status, data } = await acctApi('GET', 'backups');
    if (token !== sheetToken) return;
    if (status === 401) { box.innerHTML = '<p class="muted">Log in again to see them.</p>'; return; }
    if (!data.ok) throw new Error(data.reason);
    box.innerHTML = data.backups.length ? '' : '<p class="muted">None yet — the first is kept the next day you make a change.</p>';
    for (const b of data.backups) {
      const label = backupDay(b.date);
      box.appendChild(row(`Start of ${label}`, b.count == null ? '' : backupWhat(b.count, b.wants), async () => {
        try {
          const got = await acctApi('GET', `backups?d=${b.date}`);
          if (!got.data.ok) throw new Error(got.data.reason);
          restoreBackup(got.data, `the start of ${label}`);
        } catch { toast("Couldn't load that backup — check your connection."); }
      }));
    }
  } catch {
    if (token === sheetToken) box.innerHTML = "<p class=\"muted\">Couldn't reach your account — check your connection.</p>";
  }
}

$('backupsBtn')?.addEventListener('click', openBackups);
dailyBackup();
