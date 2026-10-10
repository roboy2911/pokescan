/* Accounts: log in (or sign up) to use the app; your collection is saved to your account and
 * synced between devices. Server side: tools/account-worker.mjs (in the Cloudflare worker).
 *
 * The password never leaves the phone: a key is derived from it here (PBKDF2-SHA256, 150,000
 * rounds, salted with the username) and only that is sent. The session token is remembered
 * on this device until you log out.
 *
 * Sync: on start, when the app comes back to the front, and a few seconds after any change,
 * the account's copy is fetched and merged with this device's: entries changed or added here
 * win, entries changed or added elsewhere come in, and entries deleted on either side (since
 * the last sync) stay deleted. Then the merged list is saved to both. Offline, the app works
 * from this device's copy and syncs later.
 *
 * Note: this is a gate in the app — its code is public, so it can't hide the app itself. Your
 * collection is what's protected: only your session can read or change it. */

const ACCOUNT_URL = new URL('./', AU_SOLD_URL).href;
const SESSION_KEY = 'pokescan.session.v1';   // { username, token }
const SYNC_KEY = 'pokescan.sync.v1';         // { user, rev, snapshot: { entryKey: JSON } }
const SYNC_DELAY = 4000;                     // ms after a change

const acct = { session: null, syncing: null, timer: null, applying: false, again: false };
try { acct.session = JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch { /* storage blocked */ }

// Automated tests on this computer skip the gate (unless a test asks for it).
const acctTestBypass = location.hostname === 'localhost' && navigator.webdriver
  && (() => { try { return localStorage.getItem('pokescan.testGate') !== '1'; } catch { return true; } })();

const acctEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function acctKey(username, password) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(`pokescan:${username}`), iterations: 150000 }, base, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function acctApi(method, path, body) {
  const res = await fetch(new URL(path, ACCOUNT_URL), {
    method,
    headers: { 'content-type': 'application/json', ...(acct.session && { authorization: `Bearer ${acct.session.token}` }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, data: data || {} };
}

/* ---------- Login / sign-up screen ---------- */

function acctGate(message = '') {
  if (document.getElementById('loginGate')) return;
  const el = document.createElement('div');
  el.id = 'loginGate';
  el.className = 'login-gate';
  el.innerHTML = `<form class="login-card" novalidate>
      <img src="icon.svg" alt="" class="login-logo">
      <h1>PokeScan</h1>
      <div class="seg login-tabs" role="tablist">
        <button type="button" data-mode="login" class="active" role="tab">Log in</button>
        <button type="button" data-mode="signup" role="tab">Sign up</button>
      </div>
      <label>Username<input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="20" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" minlength="8" required></label>
      <label class="login-confirm" hidden>Password again<input name="confirm" type="password" autocomplete="new-password"></label>
      <button type="submit" class="btn primary">Log in</button>
      <p class="login-msg" role="alert">${acctEsc(message)}</p>
      <p class="login-note">Your collection is saved to your account, so it's safe if you change phones.</p>
    </form>`;
  document.body.appendChild(el);
  document.body.classList.add('gated');
  const form = el.querySelector('form');
  let mode = 'login';
  const setMode = (m) => {
    mode = m;
    el.querySelectorAll('.login-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    el.querySelector('.login-confirm').hidden = m !== 'signup';
    form.password.autocomplete = m === 'signup' ? 'new-password' : 'current-password';
    form.querySelector('[type=submit]').textContent = m === 'signup' ? 'Create account' : 'Log in';
    el.querySelector('.login-msg').textContent = m === 'signup' ? 'Username: 3–20 letters, numbers or _. Password: at least 8 characters.' : '';
  };
  el.querySelectorAll('.login-tabs button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = el.querySelector('.login-msg');
    const username = form.username.value.trim().toLowerCase();
    const password = form.password.value;
    if (!/^[a-z0-9_]{3,20}$/.test(username)) { msg.textContent = 'Username: 3–20 letters, numbers or _ (no spaces).'; return; }
    if (password.length < 8) { msg.textContent = 'Password: at least 8 characters.'; return; }
    if (mode === 'signup' && password !== form.confirm.value) { msg.textContent = "The passwords don't match."; return; }
    if (!crypto?.subtle) { msg.textContent = 'Logging in needs a secure (https) page.'; return; }
    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    msg.textContent = mode === 'signup' ? 'Creating your account…' : 'Logging in…';
    try {
      const { status, data } = await acctApi('POST', mode === 'signup' ? 'auth/signup' : 'auth/login', { username, key: await acctKey(username, password) });
      if (data.ok) {
        acctSignedIn(data.username, data.token);
        return;
      }
      msg.textContent = ({
        taken: 'That username is taken — try another, or log in.',
        wrong: 'Wrong username or password.',
        'too-many-tries': 'Too many tries — wait 15 minutes and try again.',
        'too-many-signups': 'Too many new accounts from this network today.',
        username: 'Username: 3–20 letters, numbers or _ (no spaces).',
      })[data.reason] || `Something went wrong (${status}). Try again.`;
    } catch {
      msg.textContent = "Couldn't reach the server — check your connection.";
    } finally {
      button.disabled = false;
    }
  });
  setTimeout(() => form.username.focus(), 50);
}

function acctSignedIn(username, token) {
  acct.session = { username, token };
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(acct.session)); } catch { /* storage blocked */ }
  document.getElementById('loginGate')?.remove();
  document.body.classList.remove('gated');
  navigator.storage?.persist?.().catch(() => {});
  acctShowAccount();
  acctSync();
}

/* "Signed in as …" and Log out in the Collection ••• menu. */
function acctShowAccount() {
  const list = document.querySelector('#collectionMenu .menu-list');
  if (list && !document.getElementById('accountRow')) {
    const row = document.createElement('button');
    row.type = 'button';
    row.id = 'accountRow';
    row.addEventListener('click', acctLogout);
    list.prepend(row);
  }
  const row = document.getElementById('accountRow');
  if (row) row.textContent = acct.session ? `Log out (${acct.session.username})` : 'Log in';
  const note = document.querySelector('#view-collection .small-note');
  if (note && acct.session) note.textContent = `Saved to your account (${acct.session.username}) and this device. Tap a card to change its finish or quantity.`;
}

async function acctLogout() {
  if (!acct.session) { acctGate(); return; }
  if (!confirm(`Log out of ${acct.session.username}? Your collection stays in your account; it's removed from this device.`)) return;
  try { await acctSync(); } catch { /* best effort */ }
  try { await acctApi('POST', 'auth/logout'); } catch { /* offline: the session just expires */ }
  acct.session = null;
  try {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(SYNC_KEY);
    localStorage.removeItem(COLLECTION_KEY);
  } catch { /* storage blocked */ }
  location.reload();
}

/* ---------- Sync ---------- */

function acctMeta() {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || null; } catch { return null; }
}

/* Three-way merge of this device's list and the account's, against the last synced snapshot. */
function acctMerge(local, remote, snapshot) {
  const L = new Map(local.map((e) => [e.key, e]));
  const R = new Map(remote.map((e) => [e.key, e]));
  const out = [];
  const keys = new Set([...L.keys(), ...R.keys()]);
  for (const k of keys) {
    const l = L.get(k), r = R.get(k), was = snapshot[k];
    const lChanged = l ? JSON.stringify(l) !== was : was !== undefined;
    if (l && r) out.push(lChanged || was === undefined ? l : r);       // both have it: this device's edit wins
    else if (l) { if (was === undefined || lChanged) out.push(l); }     // only here: new here (keep) or deleted there (drop)
    else if (r) { if (was === undefined || JSON.stringify(r) !== was) out.push(r); } // only there: new there, or deleted here
  }
  // Keep this device's order, then anything new from the account.
  const order = new Map(local.map((e, i) => [e.key, i]));
  return out.sort((a, b) => (order.get(a.key) ?? 1e9) - (order.get(b.key) ?? 1e9));
}

async function acctSyncOnce() {
  const meta = acctMeta();
  const mine = meta && meta.user === acct.session.username ? meta : { rev: 0, snapshot: {} };
  for (let attempt = 0; attempt < 3; attempt++) {
    const got = await acctApi('GET', 'sync');
    if (got.status === 401) { acctExpired(); return; }
    if (!got.data.ok) throw new Error(got.data.reason || got.status);
    const remote = got.data.collection || [];
    const local = loadCollection();
    const merged = acctMerge(local, remote, mine.snapshot);
    const same = (a, b) => a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
    if (!same(merged, local)) {
      acct.applying = true;
      saveCollection(merged);
      acct.applying = false;
      if (typeof renderCollection === 'function') { try { renderCollection(); } catch { /* not ready yet */ } }
    }
    let rev = got.data.rev;
    if (!same(merged, remote)) {
      const put = await acctApi('PUT', 'sync', { base: rev, collection: merged });
      if (put.status === 409) continue; // saved from another device meanwhile: merge again
      if (put.status === 401) { acctExpired(); return; }
      if (!put.data.ok) throw new Error(put.data.reason || put.status);
      rev = put.data.rev;
    }
    const snapshot = Object.fromEntries(merged.map((e) => [e.key, JSON.stringify(e)]));
    try { localStorage.setItem(SYNC_KEY, JSON.stringify({ user: acct.session.username, rev, snapshot, at: Date.now() })); } catch { /* storage full */ }
    return;
  }
}

function acctSync() {
  if (!acct.session || acctTestBypass) return Promise.resolve();
  if (acct.syncing) { acct.again = true; return acct.syncing; }
  acct.syncing = acctSyncOnce().catch(() => { /* offline: try again later */ }).finally(() => {
    acct.syncing = null;
    if (acct.again) { acct.again = false; acctSync(); }
  });
  return acct.syncing;
}

/* Called by saveCollection (app.js) after every change. */
function accountChanged() {
  if (acct.applying || !acct.session) return;
  clearTimeout(acct.timer);
  acct.timer = setTimeout(acctSync, SYNC_DELAY);
}

function acctExpired() {
  acct.session = null;
  try { localStorage.removeItem(SESSION_KEY); } catch { /* storage blocked */ }
  acctGate('Please log in again.');
}

/* ---------- Start ---------- */

if (!acctTestBypass) {
  if (acct.session) {
    // After app.js has loaded (it has the collection functions).
    addEventListener('DOMContentLoaded', () => { acctShowAccount(); acctSync(); });
  } else {
    acctGate();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) acctSync(); });
  addEventListener('pagehide', () => { if (acct.timer) { clearTimeout(acct.timer); acctSync(); } });
}
