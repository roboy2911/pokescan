/* Collection folders (portfolios): binders, "Graded", "To sell", … Each collection entry can sit
 * in one folder (`entry.folder`, a name), so folders sync with the account and go into backups
 * with the cards. The folder list itself (order, empty folders) is kept on this device. */

const FOLDERS_KEY = 'pokescan.folders';
const FOLDER_PICK_KEY = 'pokescan.folderPick';
const NO_FOLDER = '__none';
let folderPick = '';
try { folderPick = localStorage.getItem(FOLDER_PICK_KEY) || ''; } catch { /* no storage */ }

function savedFolders() {
  try { return (JSON.parse(localStorage.getItem(FOLDERS_KEY)) || []).filter((f) => typeof f === 'string'); } catch { return []; }
}
function saveFolders(names) {
  try { localStorage.setItem(FOLDERS_KEY, JSON.stringify([...new Set(names)])); } catch { /* storage full */ }
}
/* Saved folders first (their order), then any that only came in from another device. */
function allFolders(list = loadCollection()) {
  const names = savedFolders();
  for (const e of list) if (e.folder && !names.includes(e.folder)) names.push(e.folder);
  return names;
}
function setFolderPick(v) {
  folderPick = v;
  try { localStorage.setItem(FOLDER_PICK_KEY, v); } catch { /* no storage */ }
}
const inPickedFolder = (e) => !folderPick || (folderPick === NO_FOLDER ? !e.folder : e.folder === folderPick);

function askFolderName(current = '') {
  const name = (prompt(current ? 'Rename folder' : 'New folder name (e.g. Binder 1, Graded, To sell)', current) || '').trim().slice(0, 40);
  if (!name || name === current) return null;
  if (name === NO_FOLDER) return null;
  if (allFolders().includes(name)) { toast(`There's already a folder called ${name}`); return null; }
  return name;
}
function newFolder() {
  const name = askFolderName();
  if (!name) return null;
  saveFolders([...allFolders(), name]);
  return name;
}

/* Folder chips above the cards, and the bar for the open folder. Called by renderCollection
 * after prices are worked out (e.total). */
function renderFolders(list, rate) {
  const row = $('folderRow');
  const names = allFolders(list);
  if (folderPick && folderPick !== NO_FOLDER && !names.includes(folderPick)) setFolderPick('');
  const loose = list.filter((e) => !e.folder);
  if (folderPick === NO_FOLDER && (!names.length || !loose.length)) setFolderPick('');
  const stat = (items) => {
    const n = items.reduce((s, e) => s + e.qty, 0);
    const usd = items.reduce((s, e) => s + (e.total ?? 0), 0);
    return { n, usd, text: rate && usd ? formatAud(usd, rate.rate) : '' };
  };
  const chip = (v, label, items) => {
    const s = stat(items);
    return `<button type="button" class="folder-chip${folderPick === v ? ' active' : ''}" data-f="${esc(v)}" aria-pressed="${folderPick === v}">
      <span class="fname">${v && v !== NO_FOLDER ? '📁 ' : ''}${esc(label)}</span><small>${s.n}${s.text ? ` · ${esc(s.text)}` : ''}</small></button>`;
  };
  row.innerHTML = chip('', 'All cards', list)
    + names.map((f) => chip(f, f, list.filter((e) => e.folder === f))).join('')
    + (names.length && loose.length ? chip(NO_FOLDER, 'Not in a folder', loose) : '')
    + '<button type="button" class="folder-chip add" data-new="1"><span class="fname">＋ Folder</span><small>new</small></button>';
  row.querySelector('.folder-chip.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  const bar = $('folderBar');
  const open = folderPick && folderPick !== NO_FOLDER;
  bar.hidden = !open;
  if (!open) return;
  const s = stat(list.filter((e) => e.folder === folderPick));
  $('folderTitle').innerHTML = `📁 ${esc(folderPick)} <small>${s.n} card${s.n === 1 ? '' : 's'}${s.text ? ` · ${esc(s.text)}` : ''}</small>`;
}

$('folderRow').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  if (b.dataset.new) {
    const name = newFolder();
    if (!name) return;
    setFolderPick(name);
    renderCollection();
    folderAddCards(name);
    return;
  }
  setFolderPick(folderPick === b.dataset.f ? '' : b.dataset.f);
  renderCollection();
});

$('folderAdd').addEventListener('click', () => folderAddCards(folderPick));
$('folderRename').addEventListener('click', () => {
  const old = folderPick;
  const name = askFolderName(old);
  if (!name) return;
  saveFolders(allFolders().map((f) => (f === old ? name : f)));
  const list = loadCollection();
  for (const e of list) if (e.folder === old) e.folder = name;
  saveCollection(list);
  setFolderPick(name);
  renderCollection();
});
$('folderDelete').addEventListener('click', () => {
  const name = folderPick;
  const list = loadCollection();
  const n = list.filter((e) => e.folder === name).length;
  if (!confirm(`Delete the folder “${name}”?${n ? `\n\nIts ${n} card${n === 1 ? '' : 's'} stay in your collection, just not in a folder.` : ''}`)) return;
  for (const e of list) if (e.folder === name) delete e.folder;
  saveFolders(allFolders(list).filter((f) => f !== name));
  saveCollection(list);
  setFolderPick('');
  renderCollection();
  toast(`Deleted folder ${name}`);
});

/* Sheet: tick cards from the collection to put in a folder. */
function folderAddCards(folder) {
  const all = loadCollection().filter((e) => e.folder !== folder)
    .sort((a, b) => (!!a.folder - !!b.folder) || SORTS.recent(a, b));
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet folder-sheet';
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  const picked = new Set();
  dlg.innerHTML = `<form method="dialog"><button class="close" aria-label="Close">✕</button></form>
    <h2>Add to 📁 ${esc(folder)}</h2>
    ${all.length ? `<input type="search" class="folder-search" placeholder="Search your cards" aria-label="Search your cards" autocomplete="off">
    <div class="folder-picks"></div>
    <div class="result-actions"><button type="button" class="btn primary" data-act="move" disabled>Add cards</button></div>`
    : '<p class="muted">Every card in your collection is already in this folder.</p>'}`;
  const box = dlg.querySelector('.folder-picks');
  const btn = dlg.querySelector('[data-act=move]');
  const draw = () => {
    const q = normName(dlg.querySelector('.folder-search').value.trim());
    const shown = all.filter((e) => !q || normName(`${e.name} ${e.setName} ${e.number}`).includes(q));
    box.innerHTML = shown.length ? shown.map((e) => `<label class="card-row folder-pick">
      <input type="checkbox" data-k="${esc(e.key)}"${picked.has(e.key) ? ' checked' : ''}>
      <img src="${esc(e.image)}" alt="" loading="lazy">
      <div class="meta"><div class="name">${esc(e.name)}${e.qty > 1 ? ` <span class="qty-tag">×${e.qty}</span>` : ''}</div>
        <div class="sub">${esc(e.setName)}${e.kind === 'sealed' ? '' : ` · ${esc(numberText(e))}`}${e.variant ? ` · ${esc(variantLabel(e.variant))}` : ''}${e.folder ? ` · in 📁 ${esc(e.folder)}` : ''}</div></div>
    </label>`).join('') : '<p class="muted">No cards match.</p>';
  };
  const count = () => {
    btn.disabled = !picked.size;
    btn.textContent = picked.size ? `Add ${picked.size} to ${folder}` : 'Add cards';
  };
  if (box) {
    draw();
    dlg.querySelector('.folder-search').addEventListener('input', draw);
    box.addEventListener('change', (ev) => {
      const k = ev.target.dataset.k;
      if (!k) return;
      if (ev.target.checked) picked.add(k); else picked.delete(k);
      count();
    });
    btn.addEventListener('click', () => {
      const list = loadCollection();
      for (const e of list) if (picked.has(e.key)) e.folder = folder;
      saveCollection(list);
      dlg.close();
      renderCollection();
      toast(`Added ${picked.size} to ${folder}`);
    });
  }
  dlg.showModal();
}

/* The "Folder" picker in a collection item's sheet. */
function folderSelectHtml() {
  return `<label class="toggle-row folder-select"><span>Folder</span><select id="folderSelect" aria-label="Folder"></select></label>`;
}
function wireFolderSelect(getKey) {
  const sel = $('folderSelect');
  if (!sel) return;
  const draw = () => {
    const cur = loadCollection().find((e) => e.key === getKey())?.folder || '';
    sel.innerHTML = '<option value="">None</option>'
      + allFolders().map((f) => `<option value="${esc(f)}">📁 ${esc(f)}</option>`).join('')
      + '<option value="__new">＋ New folder…</option>';
    sel.value = cur;
  };
  draw();
  sel.addEventListener('change', () => {
    let v = sel.value;
    if (v === '__new') {
      v = newFolder();
      if (!v) { draw(); return; }
    }
    updateEntry(getKey(), (e) => { if (v) e.folder = v; else delete e.folder; });
    draw();
    renderCollection();
    toast(v ? `Moved to ${v}` : 'Taken out of its folder');
  });
}
