/* BMAD Dashboard - frontend (vanilla JS, sin build)
 * Fuentes de datos:
 *  - browser: carpeta elegida en el navegador (File System Access API o <input webkitdirectory>)
 *  - local:   ruta del disco, solo cuando la app corre en tu equipo
 *  - cloud:   último snapshot guardado en Supabase (solo lectura)
 */
(() => {
  'use strict';

  const STATUSES = ['backlog', 'drafted', 'ready-for-dev', 'in-progress', 'review', 'done'];
  const STATUS_LABEL = {
    backlog: 'Backlog', drafted: 'Borrador', 'ready-for-dev': 'Listo p/ dev', 'in-progress': 'En progreso', review: 'En revisión', done: 'Hecho',
    contexted: 'Con contexto',
  };
  const VERSION_LABEL = { v6: 'BMAD v6', 'v6-alpha': 'BMAD v6 (alpha)', v4: 'BMAD v4', unknown: 'BMAD (no detectado)' };
  const TABS = ['resumen', 'tablero', 'epicas', 'comandos', 'nueva', 'alertas'];
  const STORY_FILE_RE = /^(\d+)[-.](\d+)(?:[-.](.+))?\.md$/i;
  const EPICS_FILE_RE = /^(epics?|epic[-_ ]?\d+.*|.*[-_]epics?)\.md$/i;
  const HAS_FS_ACCESS = typeof window.showDirectoryPicker === 'function';

  const state = {
    config: null,
    sb: null,
    session: null,
    source: null, // {kind:'browser', handle?, label, files: Map} | {kind:'local', path} | {kind:'cloud', projectId, name, at}
    data: null,
    style: null,
    filters: { epic: '', q: '' },
    autoTimer: null,
    specDraft: null,
    cloudProjectId: null,
    history: null,
    lastSync: null,
    busy: false,
  };

  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin storage */ } },
  };

  // ---------------- IndexedDB: carpetas recientes (FileSystemDirectoryHandle) ----------------
  const idb = {
    open() {
      return new Promise((resolve, reject) => {
        const r = indexedDB.open('bmad-dashboard', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    },
    async get(key) {
      try {
        const db = await idb.open();
        return await new Promise((res, rej) => { const t = db.transaction('kv').objectStore('kv').get(key); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); });
      } catch { return undefined; }
    },
    async set(key, value) {
      try {
        const db = await idb.open();
        await new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(value, key); t.oncomplete = res; t.onerror = () => rej(t.error); });
      } catch { /* sin IndexedDB */ }
    },
  };

  // ---------------- HTTP ----------------
  async function token() {
    if (!state.sb) return null;
    try { const { data } = await state.sb.auth.getSession(); return data.session?.access_token ?? null; } catch { return null; }
  }
  async function api(url, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (url.startsWith('/api/projects')) { const t = await token(); if (t) headers.Authorization = `Bearer ${t}`; }
    const res = await fetch(url, { ...opts, headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(Array.isArray(body.message) ? body.message.join(' ') : body.message || `Error ${res.status}`), { status: res.status });
    return body;
  }
  const q = (params) => new URLSearchParams(params).toString();
  const post = (url, body) => api(url, { method: 'POST', body: JSON.stringify(body) });

  function toast(msg, err = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (err ? ' err' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), 3600);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Copiado al portapapeles'); }
    catch {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Copiado'); } catch { toast('No se pudo copiar', true); }
      ta.remove();
    }
  }
  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const timeAgo = (ms) => {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return 'hace segundos';
    if (s < 3600) return `hace ${Math.round(s / 60)} min`;
    if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
    return `hace ${Math.round(s / 86400)} días`;
  };
  const pill = (status) => `<span class="pill s-${esc(status)}">${esc(STATUS_LABEL[status] ?? status)}</span>`;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const readOnly = () => state.source?.kind === 'cloud';

  // =====================================================================
  //  Lectura de la carpeta en el navegador
  // =====================================================================
  function needsContent(rel) {
    const name = rel.split('/').pop();
    if (state.config.scan.configFiles.includes(rel)) return true;
    if (/^sprint-status\.ya?ml$/i.test(name)) return true;
    if (STORY_FILE_RE.test(name) && !/context|tech-spec|retro/i.test(name)) return true;
    if (EPICS_FILE_RE.test(name) && !/tech-spec|retro|context/i.test(name)) return true;
    return false;
  }
  function skipDir(name, depth) {
    const s = state.config.scan;
    if (s.ignoredDirs.includes(name) || s.methodDirs.includes(name)) return true;
    if (depth === 0 && name === 'bmad') return true;
    return name.startsWith('.') && name !== '.bmad-output';
  }

  async function readHandle(root) {
    const files = [];
    const markers = [];
    const maxSize = state.config.scan.maxFileSize;
    for await (const [name] of root.entries()) markers.push(name);
    if (markers.includes('bmad')) {
      try { await (await root.getDirectoryHandle('bmad')).getDirectoryHandle('bmm'); markers.push('bmad/bmm'); } catch { /* no */ }
    }
    async function walk(dir, prefix, depth) {
      for await (const [name, h] of dir.entries()) {
        if (h.kind === 'directory') {
          if (skipDir(name, depth) || depth >= state.config.scan.maxDepth) continue;
          await walk(h, prefix + name + '/', depth + 1);
        } else if (/\.(md|ya?ml)$/i.test(name)) {
          const file = await h.getFile();
          const rel = prefix + name;
          const f = { path: rel, mtime: file.lastModified, size: file.size };
          if (file.size <= maxSize && needsContent(rel)) f.content = await file.text();
          files.push(f);
        }
      }
    }
    await walk(root, '', 0);
    for (const c of state.config.scan.configFiles) {
      try {
        const file = await (await getFileHandle(root, c, false)).getFile();
        files.push({ path: c, mtime: file.lastModified, size: file.size, content: await file.text() });
      } catch { /* no existe */ }
    }
    return { files, markers };
  }

  /** Fallback (<input webkitdirectory>): lectura única, sin escritura. */
  async function readFileList(list) {
    const all = Array.from(list);
    if (!all.length) throw new Error('La carpeta está vacía.');
    const label = all[0].webkitRelativePath.split('/')[0];
    const files = [];
    const markers = new Set();
    const maxSize = state.config.scan.maxFileSize;
    for (const file of all) {
      const parts = file.webkitRelativePath.split('/').slice(1);
      if (!parts.length) continue;
      markers.add(parts[0]);
      if (parts[0] === 'bmad' && parts[1] === 'bmm') markers.add('bmad/bmm');
      const rel = parts.join('/');
      const isConfig = state.config.scan.configFiles.includes(rel);
      if (!isConfig && parts.slice(0, -1).some((d, i) => skipDir(d, i))) continue;
      if (!/\.(md|ya?ml)$/i.test(file.name)) continue;
      const f = { path: rel, mtime: file.lastModified, size: file.size };
      if (file.size <= maxSize && (isConfig || needsContent(rel))) f.content = await file.text();
      files.push(f);
    }
    return { label, files, markers: [...markers] };
  }

  async function getFileHandle(root, rel, create) {
    const parts = rel.split('/').filter((p) => p && p !== '.');
    const name = parts.pop();
    let dir = root;
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
    return dir.getFileHandle(name, { create });
  }
  async function writeText(root, rel, content) {
    const fh = await getFileHandle(root, rel, true);
    const w = await fh.createWritable();
    await w.write(content);
    await w.close();
  }
  async function fileExists(root, rel) {
    try { await getFileHandle(root, rel, false); return true; } catch { return false; }
  }
  async function ensurePermission(handle, mode) {
    const opts = { mode };
    if (typeof handle.queryPermission !== 'function') return true; // p. ej. OPFS
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    return (await handle.requestPermission(opts)) === 'granted';
  }

  // =====================================================================
  //  Pantalla de inicio
  // =====================================================================
  function showStart(msg) {
    stopAuto();
    state.source = null;
    state.data = null;
    $('#app').classList.add('hidden');
    $('#start').classList.remove('hidden');
    $('#open-form').classList.toggle('hidden', !state.config.localMode);
    $('#path-input').value = store.get('bmad.lastPath', '') || '';
    $('#pick-btn').textContent = HAS_FS_ACCESS ? '📁 Seleccionar carpeta del proyecto' : '📁 Cargar carpeta del proyecto';
    if (!HAS_FS_ACCESS) $('#pick-help').innerHTML += '<br><b>Tu navegador no permite escribir en carpetas</b>: podrás ver el dashboard y descargar historias. Usa Chrome o Edge para guardarlas directamente.';
    renderRecents();
    renderAccount();
    setHint('#pick-hint', msg || '', msg ? 'err' : '');
  }

  function setHint(sel, msg, cls = '') {
    const h = $(sel);
    h.textContent = msg || '';
    h.className = 'hint ' + cls;
  }

  async function renderRecents() {
    const el = $('#recents');
    const handles = HAS_FS_ACCESS ? (await idb.get('recents')) || [] : [];
    const paths = state.config.localMode ? store.get('bmad.recents', []) : [];
    if (!handles.length && !paths.length) { el.innerHTML = ''; return; }
    el.innerHTML = `<h3>Recientes</h3>` +
      handles.map((r, i) => `<div class="recent" data-h="${i}"><span>📁</span><strong>${esc(r.name)}</strong><span class="mono">${esc(r.label)} · carpeta del navegador</span><span class="x" data-delh="${i}" title="Quitar">×</span></div>`).join('') +
      paths.map((r, i) => `<div class="recent" data-p="${i}"><span>🖥️</span><strong>${esc(r.name)}</strong><span class="mono">${esc(r.path)}</span><span class="x" data-delp="${i}" title="Quitar">×</span></div>`).join('');
    el.querySelectorAll('.recent').forEach((d) => d.addEventListener('click', async (e) => {
      const t = e.target.dataset;
      if (t.delh !== undefined) { handles.splice(Number(t.delh), 1); await idb.set('recents', handles); return renderRecents(); }
      if (t.delp !== undefined) { paths.splice(Number(t.delp), 1); store.set('bmad.recents', paths); return renderRecents(); }
      if (d.dataset.h !== undefined) {
        const r = handles[Number(d.dataset.h)];
        try {
          if (!(await ensurePermission(r.handle, 'readwrite')) && !(await ensurePermission(r.handle, 'read'))) throw new Error('Permiso denegado para leer la carpeta.');
          openBrowserHandle(r.handle);
        } catch (err) { setHint('#pick-hint', err.message, 'err'); }
      } else openLocal(paths[Number(d.dataset.p)].path);
    }));
  }

  async function rememberHandle(handle, name) {
    if (!HAS_FS_ACCESS) return;
    const list = (await idb.get('recents')) || [];
    const kept = [];
    for (const r of list) { try { if (!(await r.handle.isSameEntry(handle))) kept.push(r); } catch { kept.push(r); } }
    kept.unshift({ handle, label: handle.name, name, at: Date.now() });
    await idb.set('recents', kept.slice(0, 8));
  }
  function rememberPath(path, name) {
    const rec = store.get('bmad.recents', []).filter((r) => r.path !== path);
    rec.unshift({ path, name, at: Date.now() });
    store.set('bmad.recents', rec.slice(0, 8));
    store.set('bmad.lastPath', path);
  }

  $('#pick-btn').addEventListener('click', async () => {
    if (!HAS_FS_ACCESS) return $('#dir-input').click();
    try {
      const handle = await window.showDirectoryPicker({ id: 'bmad-project', mode: 'readwrite' });
      openBrowserHandle(handle);
    } catch (err) {
      if (err.name !== 'AbortError') setHint('#pick-hint', err.message, 'err');
    }
  });
  $('#dir-input').addEventListener('change', async (e) => {
    if (!e.target.files.length) return;
    setHint('#pick-hint', 'Leyendo archivos…');
    try {
      const { label, files, markers } = await readFileList(e.target.files);
      state.source = { kind: 'browser', handle: null, label, files: new Map(files.map((f) => [f.path, f])), markers };
      await enterDashboard();
    } catch (err) { setHint('#pick-hint', err.message, 'err'); }
    e.target.value = '';
  });

  async function openBrowserHandle(handle) {
    setHint('#pick-hint', `Leyendo ${handle.name}…`);
    state.source = { kind: 'browser', handle, label: handle.name, files: new Map(), markers: [] };
    try {
      await enterDashboard();
      rememberHandle(handle, state.data.projectName);
    } catch (err) { setHint('#pick-hint', err.message, 'err'); showStart(err.message); }
  }
  async function openLocal(path) {
    setHint('#detect-hint', 'Analizando proyecto…');
    state.source = { kind: 'local', path };
    try {
      await enterDashboard();
      state.source.path = state.data.root;
      rememberPath(state.data.root, state.data.projectName);
    } catch (err) { setHint('#detect-hint', err.message, 'err'); showStart(); setHint('#detect-hint', err.message, 'err'); }
  }
  async function openCloud(project) {
    state.source = { kind: 'cloud', projectId: project.id, name: project.name, label: project.root_label };
    try { await enterDashboard(); } catch (err) { toast(err.message, true); showStart(); }
  }

  // --- Modo local: ruta + explorador ---
  let detectTimer;
  $('#path-input').addEventListener('input', (e) => {
    clearTimeout(detectTimer);
    const v = e.target.value.trim();
    if (!v) return setHint('#detect-hint', '');
    detectTimer = setTimeout(async () => {
      try {
        const d = await api('/api/local/detect?' + q({ path: v }));
        setHint('#detect-hint', d.isBmad ? `✓ ${VERSION_LABEL[d.version]} detectado en ${d.root}` : `Carpeta encontrada, pero no se detectó BMAD (${d.root}).`, d.isBmad ? 'ok' : '');
      } catch (err) { setHint('#detect-hint', err.message, 'err'); }
    }, 400);
  });
  $('#open-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#path-input').value.trim();
    if (!v) return setHint('#detect-hint', 'Escribe la ruta del proyecto o usa "Explorar…"', 'err');
    openLocal(v);
  });
  let browserPath = null;
  $('#browse-btn').addEventListener('click', () => {
    const b = $('#browser');
    b.classList.toggle('hidden');
    if (!b.classList.contains('hidden')) loadDir($('#path-input').value.trim() || '');
  });
  $('#browser-up').addEventListener('click', () => browserPath && loadDir(browserPath.parent || ''));
  $('#browser-select').addEventListener('click', () => {
    if (!browserPath) return;
    $('#path-input').value = browserPath.path;
    $('#path-input').dispatchEvent(new Event('input'));
    $('#browser').classList.add('hidden');
  });
  $('#browser-roots').addEventListener('change', (e) => e.target.value && loadDir(e.target.value));
  async function loadDir(p) {
    try {
      const d = await api('/api/local/fs?' + q({ path: p }));
      browserPath = { path: d.path, parent: d.parent };
      $('#browser-path').textContent = d.path + (d.isBmad ? '  · BMAD ✓' : '');
      $('#browser-up').disabled = !d.parent;
      $('#browser-roots').innerHTML = `<option value="">Ir a…</option><option value="${esc(d.home)}">Inicio (${esc(d.home)})</option>` + d.roots.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('');
      const list = $('#browser-list');
      list.innerHTML = d.entries.length
        ? d.entries.map((e) => `<li data-p="${esc(e.path)}">📁 <span>${esc(e.name)}</span>${e.isBmad ? ' <span class="tag">BMAD</span>' : ''}</li>`).join('')
        : '<li class="muted">Sin subcarpetas</li>';
      list.querySelectorAll('li[data-p]').forEach((li) => li.addEventListener('click', () => loadDir(li.dataset.p)));
    } catch (err) { toast(err.message, true); }
  }

  // =====================================================================
  //  Cuenta (Supabase Auth) y proyectos en la nube
  // =====================================================================
  async function renderAccount() {
    const el = $('#account');
    if (!state.sb) {
      $('#account-card').classList.add('hidden');
      return;
    }
    $('#account-card').classList.remove('hidden');
    const user = state.session?.user;
    if (!user) {
      el.innerHTML = `
        <h2>☁ Guarda tu historial en la nube</h2>
        <p class="muted small-text">Inicia sesión para guardar el avance de tus proyectos, ver la tendencia del sprint, consultar el último estado desde cualquier dispositivo y conservar las especificaciones que generes.</p>
        <form id="login-form" class="account-row" style="margin-top:12px">
          <input type="email" id="login-email" required placeholder="tu@email.com" autocomplete="email" />
          <button class="btn primary" type="submit">Enviarme enlace de acceso</button>
        </form>
        <div id="login-hint" class="hint"></div>`;
      $('#login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = $('#login-email').value.trim();
        setHint('#login-hint', 'Enviando…');
        const { error } = await state.sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
        if (error) setHint('#login-hint', error.message, 'err');
        else setHint('#login-hint', `✓ Revisa ${email} y abre el enlace en este mismo navegador.`, 'ok');
      });
      return;
    }
    el.innerHTML = `
      <div class="account-row"><h2 style="flex:1">☁ Mis proyectos en la nube</h2><span class="muted">${esc(user.email)}</span><button class="btn small ghost" id="logout-btn">Cerrar sesión</button></div>
      <div class="list cloud-list" id="cloud-list"><div class="muted">Cargando…</div></div>`;
    $('#logout-btn').addEventListener('click', async () => { await state.sb.auth.signOut(); });
    try {
      const projects = await api('/api/projects');
      const list = $('#cloud-list');
      if (!projects.length) { list.innerHTML = '<div class="muted small-text">Aún no hay proyectos. Abre una carpeta y se sincronizará automáticamente.</div>'; return; }
      list.innerHTML = projects.map((p, i) => `
        <div class="row-item" data-cloud="${i}">
          <span class="tag">${esc(VERSION_LABEL[p.bmad_version] || 'BMAD')}</span>
          <div class="grow"><div class="title">${esc(p.name)}</div><div class="meta mono">${esc(p.root_label)}</div></div>
          ${p.latest ? `<span class="meta">${p.latest.done_stories}/${p.latest.total_stories} hechas</span>` : ''}
          <span class="meta">${p.last_synced_at ? timeAgo(Date.parse(p.last_synced_at)) : ''}</span>
          <button class="btn small ghost" data-del="${i}" title="Eliminar de la nube">🗑</button>
        </div>`).join('');
      list.querySelectorAll('[data-cloud]').forEach((row) => row.addEventListener('click', async (e) => {
        const p = projects[Number(row.dataset.cloud)];
        if (e.target.dataset.del !== undefined) {
          e.stopPropagation();
          if (row.dataset.confirm !== '1') { row.dataset.confirm = '1'; e.target.textContent = '¿Eliminar?'; return; }
          try { await api('/api/projects/' + p.id, { method: 'DELETE' }); toast('Proyecto eliminado de la nube'); renderAccount(); } catch (err) { toast(err.message, true); }
          return;
        }
        openCloud(p);
      }));
    } catch (err) { $('#cloud-list').innerHTML = `<div class="hint err">${esc(err.message)}</div>`; }
  }

  async function syncToCloud() {
    if (!state.session || !state.data || readOnly()) { renderSyncState(); return; }
    const rootLabel = state.source.kind === 'local' ? state.source.path || state.data.root : state.source.label;
    try {
      const r = await post('/api/projects/sync', { rootLabel, dashboard: state.data });
      state.cloudProjectId = r.project.id;
      state.lastSync = { at: Date.now(), ok: true, created: r.snapshotCreated };
      await loadHistory();
    } catch (err) {
      state.lastSync = { at: Date.now(), ok: false, error: err.message };
    }
    renderSyncState();
  }
  async function loadHistory() {
    const id = state.cloudProjectId;
    if (!id || !state.session) { state.history = null; return; }
    try { state.history = await api(`/api/projects/${id}/history`); } catch { state.history = null; }
    if (currentTab() === 'resumen' && $('#trend-slot')) renderTrend($('#trend-slot'));
  }
  function renderSyncState() {
    const el = $('#sync-state');
    if (!el) return;
    if (!state.sb) { el.textContent = ''; return; }
    if (readOnly()) { el.className = 'sync-state'; el.textContent = '☁ Vista guardada'; return; }
    if (!state.session) { el.className = 'sync-state'; el.innerHTML = '☁ <a href="#" id="sync-login">Inicia sesión</a> para guardar historial'; $('#sync-login')?.addEventListener('click', (e) => { e.preventDefault(); showStart(); }); return; }
    const s = state.lastSync;
    if (!s) { el.className = 'sync-state'; el.textContent = '☁ Sincronizando…'; return; }
    el.className = 'sync-state ' + (s.ok ? 'ok' : 'err');
    el.textContent = s.ok ? `☁ Sincronizado ${new Date(s.at).toLocaleTimeString()}` : '☁ Error al sincronizar';
    el.title = s.error || '';
  }

  // =====================================================================
  //  Dashboard
  // =====================================================================
  async function loadData() {
    const src = state.source;
    const style = state.style || undefined;
    if (src.kind === 'local') {
      return api('/api/local/dashboard?' + q(style ? { path: src.path, style } : { path: src.path }));
    }
    if (src.kind === 'browser') {
      if (src.handle) {
        const { files, markers } = await readHandle(src.handle);
        src.files = new Map(files.map((f) => [f.path, f]));
        src.markers = markers;
      }
      return post('/api/analyze', { root: src.label, files: [...src.files.values()], markers: src.markers, style });
    }
    const snap = await api(`/api/projects/${src.projectId}/latest`);
    src.at = snap.created_at;
    return snap.dashboard;
  }

  async function enterDashboard() {
    const key = 'bmad.style.' + (state.source.label || state.source.path || state.source.projectId);
    state.style = store.get(key, null);
    state.styleKey = key;
    state.cloudProjectId = state.source.kind === 'cloud' ? state.source.projectId : null;
    state.history = null;
    state.lastSync = null;
    state.data = await loadData();
    if (state.style && state.data.commandStyle !== state.style && readOnly()) state.style = state.data.commandStyle;
    state.style = state.data.commandStyle;
    $('#start').classList.add('hidden');
    $('#app').classList.remove('hidden');
    if (!TABS.includes(location.hash.slice(1))) history.replaceState(null, '', '#resumen');
    render();
    const canAuto = state.source.kind === 'local' || (state.source.kind === 'browser' && state.source.handle);
    $('#auto-wrap').classList.toggle('hidden', !canAuto);
    $('#refresh-btn').classList.toggle('hidden', !canAuto && !readOnly());
    if (canAuto && store.get('bmad.auto', false)) { $('#auto-refresh').checked = true; startAuto(); } else stopAuto();
    if (readOnly()) loadHistory(); else syncToCloud();
  }

  async function reload(silent = false) {
    if (state.busy) return;
    state.busy = true;
    try {
      state.data = await loadData();
      render(true);
      if (!silent) toast('Dashboard actualizado');
      if (!readOnly()) syncToCloud();
    } catch (err) { if (!silent) toast(err.message, true); }
    finally { state.busy = false; }
  }

  function startAuto() { stopAuto(); state.autoTimer = setInterval(() => document.visibilityState === 'visible' && reload(true), 15000); }
  function stopAuto() { if (state.autoTimer) clearInterval(state.autoTimer); state.autoTimer = null; }

  $('#refresh-btn').addEventListener('click', () => reload());
  $('#change-btn').addEventListener('click', () => showStart());
  $('#auto-refresh').addEventListener('change', (e) => { store.set('bmad.auto', e.target.checked); e.target.checked ? startAuto() : stopAuto(); });
  $('#style-select').addEventListener('change', async (e) => {
    state.style = e.target.value;
    store.set(state.styleKey, state.style);
    if (readOnly()) { toast('El formato de comandos se aplica al abrir la carpeta del proyecto.'); return; }
    await reload(true);
  });
  window.addEventListener('hashchange', () => state.data && render());

  function currentTab() { const t = location.hash.slice(1); return TABS.includes(t) ? t : 'resumen'; }

  function render(keepScroll = false) {
    const d = state.data;
    if (!d) return;
    const y = window.scrollY;
    const src = state.source;
    $('#project-name').innerHTML = `${esc(d.projectName)} <span class="tag">${esc(VERSION_LABEL[d.version])}</span>`;
    $('#project-path').textContent = src.kind === 'local' ? d.root : src.kind === 'browser' ? `📁 ${src.label}${src.handle ? '' : ' (solo lectura)'}` : `☁ ${src.label}`;
    $('#style-select').value = d.commandStyle;
    $('#style-select').disabled = readOnly();
    const banner = $('#readonly-banner');
    if (readOnly()) {
      banner.classList.remove('hidden');
      banner.innerHTML = `<span>☁ Vista de solo lectura del último snapshot (${src.at ? new Date(src.at).toLocaleString() : ''}). Para ver el estado en vivo y crear historias, abre la carpeta del proyecto.</span><button class="btn small" id="banner-open">Abrir carpeta</button>`;
      $('#banner-open').addEventListener('click', () => showStart());
    } else banner.classList.add('hidden');
    $('#alert-count').textContent = d.alerts.filter((a) => a.level !== 'info').length || '';
    const tab = currentTab();
    document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
    const view = $('#view');
    if (!(tab === 'nueva' && keepScroll && $('#spec-form'))) {
      ({ resumen: renderSummary, tablero: renderBoard, epicas: renderEpics, comandos: renderCommands, nueva: renderSpec, alertas: renderAlerts })[tab](view, d);
    }
    $('#foot').textContent = `${d.scannedFiles} archivos analizados · sprint-status: ${d.sprintStatusFile || 'no encontrado'} · historias en ${d.storiesDirRelative} · actualizado ${new Date(d.generatedAt).toLocaleTimeString()}`;
    renderSyncState();
    if (keepScroll) window.scrollTo(0, y);
  }

  // ---------------- Resumen ----------------
  function renderSummary(view, d) {
    const s = d.stats;
    const active = d.stories.filter((x) => ['in-progress', 'review'].includes(x.status));
    const next = d.suggestions.slice(0, 3);
    view.innerHTML = `
      <div class="grid kpis">
        ${kpi('Historias', s.totalStories, `${s.epicsTotal} épicas · ${s.epicsDone} terminadas`)}
        ${kpi('Completado', s.donePercent + '%', `${s.byStatus.done} de ${s.totalStories} historias`)}
        ${kpi('En progreso', s.byStatus['in-progress'], `${s.byStatus.review} en revisión`)}
        ${kpi('Listas / borrador', s.byStatus['ready-for-dev'] + ' / ' + s.byStatus.drafted, `${s.byStatus.backlog} en backlog`)}
        ${kpi('Tareas', `${s.tasksDone}/${s.tasksTotal}`, `${pct(s.tasksDone, s.tasksTotal)}% de subtareas marcadas`)}
      </div>

      <div class="panel" style="margin-top:16px">
        <div class="panel-head"><h2>Distribución por estado</h2></div>
        <div class="stack">${STATUSES.map((st) => s.byStatus[st] ? `<span title="${STATUS_LABEL[st]}: ${s.byStatus[st]}" style="width:${pct(s.byStatus[st], s.totalStories)}%;background:var(--s-${st})"></span>` : '').join('')}</div>
        <div class="legend">${STATUSES.map((st) => `<span><i class="dot" style="background:var(--s-${st})"></i>${STATUS_LABEL[st]} · <b>${s.byStatus[st]}</b></span>`).join('')}</div>
      </div>

      <div class="panel" style="margin-top:16px" id="trend-slot"></div>

      <div class="grid two" style="margin-top:16px">
        <div class="panel">
          <div class="panel-head"><h2>Foco actual</h2><span class="muted">${active.length} historia(s) activas</span></div>
          <div class="list">${active.length ? active.map(storyRow).join('') : '<div class="empty">No hay historias en progreso ni en revisión.</div>'}</div>
          <div class="panel-head" style="margin-top:18px"><h2>Progreso por épica</h2></div>
          <div class="list">${d.epics.map((e) => `
            <div class="row-item" data-epic="${e.number}">
              <span class="tag">E${e.number}</span>
              <div class="grow"><div class="title">${esc(e.title)}</div><div class="bar" style="margin-top:6px"><span style="width:${e.progress}%"></span></div></div>
              <span class="meta">${e.counts.done}/${e.stories.length}</span>${pill(e.status)}
            </div>`).join('')}</div>
        </div>
        <div class="grid" style="align-content:start">
          <div class="panel">
            <div class="panel-head"><h2>Siguiente paso</h2><span class="spacer"></span><a href="#comandos">Ver todos →</a></div>
            ${next.length ? next.map(suggestionCard).join('') : '<div class="empty">Sin sugerencias.</div>'}
          </div>
          <div class="panel">
            <div class="panel-head"><h2>Actividad reciente</h2></div>
            <div class="list">${d.activity.length ? d.activity.map((a) => `
              <div class="row-item" ${a.storyId ? `data-story="${esc(a.storyId)}"` : ''}>
                <div class="grow"><div class="title">${esc(a.label)}</div><div class="meta mono">${esc(a.relativePath)}</div></div>
                <span class="meta">${timeAgo(a.mtime)}</span>
              </div>`).join('') : '<div class="empty">Sin actividad.</div>'}</div>
          </div>
          <div class="panel">
            <div class="panel-head"><h2>Artefactos de planificación</h2></div>
            ${artifactsBlock(d)}
          </div>
        </div>
      </div>`;
    renderTrend($('#trend-slot'));
    bindCommon(view);
  }

  /** Tendencia de historias hechas vs total a partir de los snapshots guardados. */
  function renderTrend(slot) {
    if (!slot) return;
    const h = state.history;
    if (!state.sb) { slot.classList.add('hidden'); return; }
    slot.classList.remove('hidden');
    const head = '<div class="panel-head"><h2>Tendencia del sprint</h2><span class="muted">historias hechas vs. total, según los snapshots guardados</span></div>';
    if (!state.session) { slot.innerHTML = head + '<div class="muted small-text">Inicia sesión para guardar snapshots y ver cómo avanza el sprint en el tiempo.</div>'; return; }
    if (!h || h.length < 2) { slot.innerHTML = head + `<div class="muted small-text">Se guarda un snapshot cada vez que cambia el estado del proyecto. ${h && h.length === 1 ? 'Hay 1 snapshot; la tendencia aparecerá con el siguiente cambio.' : ''}</div>`; return; }

    const W = Math.max(420, Math.round(slot.clientWidth - 40)), H = 190, L = 34, R = 78, T = 12, B = 26;
    const t0 = Date.parse(h[0].created_at), t1 = Date.parse(h[h.length - 1].created_at);
    const maxY = Math.max(1, ...h.map((p) => p.total_stories));
    const x = (p) => L + (t1 === t0 ? 0 : ((Date.parse(p.created_at) - t0) / (t1 - t0)) * (W - L - R));
    const y = (v) => T + (1 - v / maxY) * (H - T - B);
    const line = (key) => h.map((p, i) => `${i ? 'L' : 'M'}${x(p).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
    const ticks = [0, Math.round(maxY / 2), maxY];
    const fmt = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const last = h[h.length - 1];
    slot.innerHTML = head + `
      <div class="legend" style="margin:0 0 6px"><span><i class="swatch" style="background:var(--c-total)"></i>Total</span><span><i class="swatch" style="background:var(--c-done)"></i>Hechas</span></div>
      <div class="trend">
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Historias hechas y total a lo largo del tiempo">
          ${ticks.map((t) => `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="axis-label" x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join('')}
          <text class="axis-label" x="${L}" y="${H - 6}">${fmt(t0)}</text>
          <text class="axis-label" x="${W - R}" y="${H - 6}" text-anchor="end">${fmt(t1)}</text>
          <path d="${line('total_stories')}" fill="none" stroke="var(--c-total)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
          <path d="${line('done_stories')}" fill="none" stroke="var(--c-done)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
          <text class="end-label" x="${W - R + 6}" y="${y(last.total_stories) + 4}">Total ${last.total_stories}</text>
          <text class="end-label" x="${W - R + 6}" y="${y(last.done_stories) + (last.done_stories === last.total_stories ? 16 : 4)}">Hechas ${last.done_stories}</text>
          <line id="trend-cross" class="grid-line" y1="${T}" y2="${H - B}" style="display:none"/>
          <rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent" id="trend-hit"/>
        </svg>
        <div class="tip hidden" id="trend-tip"></div>
      </div>
      <details style="margin-top:8px"><summary class="muted small-text" style="cursor:pointer">Ver tabla</summary>
        <table class="trend-table"><tr><th>Fecha</th><th>Total</th><th>Hechas</th><th>En progreso</th><th>En revisión</th></tr>
        ${h.slice().reverse().map((p) => `<tr><td>${new Date(p.created_at).toLocaleString()}</td><td>${p.total_stories}</td><td>${p.done_stories}</td><td>${p.in_progress_stories}</td><td>${p.review_stories}</td></tr>`).join('')}</table>
      </details>`;
    const svg = slot.querySelector('svg'), tip = $('#trend-tip', slot), cross = $('#trend-cross', slot);
    $('#trend-hit', slot).addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect();
      const vx = ((e.clientX - r.left) / r.width) * W;
      let best = h[0];
      for (const p of h) if (Math.abs(x(p) - vx) < Math.abs(x(best) - vx)) best = p;
      const bx = x(best);
      cross.setAttribute('x1', bx); cross.setAttribute('x2', bx); cross.style.display = '';
      tip.classList.remove('hidden');
      tip.innerHTML = `<b>${new Date(best.created_at).toLocaleString()}</b><br><i class="swatch" style="background:var(--c-total)"></i>Total: ${best.total_stories}<br><i class="swatch" style="background:var(--c-done)"></i>Hechas: ${best.done_stories}<br>En progreso: ${best.in_progress_stories} · En revisión: ${best.review_stories}`;
      const px = (bx / W) * r.width;
      tip.style.left = Math.min(Math.max(px + 12, 0), r.width - tip.offsetWidth) + 'px';
      tip.style.top = '8px';
    });
    $('#trend-hit', slot).addEventListener('mouseleave', () => { tip.classList.add('hidden'); cross.style.display = 'none'; });
  }

  function artifactsBlock(d) {
    const expected = [['brief', 'Product Brief'], ['prd', 'PRD'], ['ux', 'Diseño UX'], ['architecture', 'Arquitectura'], ['epics', 'Épicas'], ['sprint-status', 'Sprint Status']];
    return `<div class="list">${expected.map(([t, label]) => {
      const a = d.artifacts.find((x) => x.type === t);
      return `<div class="row-item" style="cursor:default">
        <span>${a ? '✅' : '⬜'}</span>
        <div class="grow"><div class="title">${label}</div><div class="meta mono">${a ? esc(a.relativePath) : 'no encontrado'}</div></div>
        ${a ? `<span class="meta">${timeAgo(a.mtime)}</span>` : ''}
      </div>`;
    }).join('')}</div>`;
  }

  const kpi = (label, value, sub) => `<div class="panel kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;

  function storyRow(s) {
    return `<div class="row-item" data-story="${esc(s.id)}">
      <span class="tag">${esc(s.id)}</span>
      <div class="grow">
        <div class="title">${esc(s.title)} ${s.warnings.length ? `<span class="warn-ico" title="${esc(s.warnings.join('\n'))}">⚠</span>` : ''}</div>
        ${s.tasksTotal ? `<div class="bar" style="margin-top:6px"><span style="width:${pct(s.tasksDone, s.tasksTotal)}%;background:var(--s-${s.status})"></span></div>` : ''}
      </div>
      ${s.tasksTotal ? `<span class="meta">${s.tasksDone}/${s.tasksTotal}</span>` : ''}
      ${pill(s.status)}
    </div>`;
  }

  // ---------------- Tablero ----------------
  function renderBoard(view, d) {
    const f = state.filters;
    view.innerHTML = `
      <div class="filters">
        <input type="text" id="f-q" placeholder="Buscar historia…" value="${esc(f.q)}" />
        <select id="f-epic"><option value="">Todas las épicas</option>${d.epics.map((e) => `<option value="${e.number}" ${String(e.number) === f.epic ? 'selected' : ''}>Épica ${e.number}: ${esc(e.title)}</option>`).join('')}</select>
      </div>
      <div class="board" id="board"></div>`;
    const draw = () => {
      const qv = f.q.toLowerCase();
      const items = d.stories.filter((s) => (!f.epic || String(s.epic) === f.epic) && (!qv || (s.id + ' ' + s.title).toLowerCase().includes(qv)));
      $('#board').innerHTML = STATUSES.map((st) => {
        const col = items.filter((s) => s.status === st);
        return `<div class="col"><div class="col-head"><i class="dot" style="background:var(--s-${st})"></i>${STATUS_LABEL[st]}<span class="count">${col.length}</span></div>
          ${col.map((s) => `
            <div class="card" style="--c:var(--s-${st})" data-story="${esc(s.id)}">
              <div class="id">${esc(s.id)} <span class="tag">E${s.epic}</span>${s.warnings.length ? `<span class="warn-ico" title="${esc(s.warnings.join('\n'))}">⚠</span>` : ''}${!s.hasFile && st !== 'backlog' ? '<span class="muted" title="Sin archivo">∅</span>' : ''}</div>
              <div class="t">${esc(s.title)}</div>
              <div class="foot2">
                ${s.tasksTotal ? `<div class="bar"><span style="width:${pct(s.tasksDone, s.tasksTotal)}%;background:var(--s-${st})"></span></div><span>${s.tasksDone}/${s.tasksTotal}</span>` : `<span>${s.hasFile ? 'sin tareas' : s.planned ? 'planificada' : ''}</span>`}
                ${s.pendingReviewItems ? `<span title="Hallazgos de revisión pendientes" style="color:var(--s-review)">● ${s.pendingReviewItems}</span>` : ''}
              </div>
            </div>`).join('') || '<div class="muted" style="font-size:12px;padding:6px">—</div>'}
        </div>`;
      }).join('');
      bindCommon($('#board'));
    };
    $('#f-q').addEventListener('input', (e) => { f.q = e.target.value; draw(); });
    $('#f-epic').addEventListener('change', (e) => { f.epic = e.target.value; draw(); });
    draw();
  }

  // ---------------- Épicas ----------------
  function renderEpics(view, d) {
    if (!d.epics.length) { view.innerHTML = '<div class="panel empty">No se encontraron épicas. Ejecuta create-epics-and-stories y sprint-planning.</div>'; return; }
    view.innerHTML = d.epics.map((e) => `
      <div class="panel epic" id="epic-${e.number}">
        <div class="epic-head">
          <span class="tag">Épica ${e.number}</span>
          <h2>${esc(e.title)}</h2>
          ${pill(e.status)}
          <span class="pill neutral" title="Retrospectiva">Retro: ${e.retrospective === 'completed' ? 'hecha' : e.retrospective === 'optional' ? 'pendiente' : '—'}</span>
          ${readOnly() ? '' : `<button class="btn small ghost" data-new-in="${e.number}">+ Historia</button>`}
        </div>
        ${e.description ? `<div class="epic-desc">${esc(e.description.slice(0, 400))}</div>` : ''}
        <div class="bar"><span style="width:${e.progress}%"></span></div>
        <div class="mini-counts">
          <b>${e.progress}% completado</b>
          ${STATUSES.filter((st) => e.counts[st]).map((st) => `<span><i class="dot" style="background:var(--s-${st})"></i>${STATUS_LABEL[st]}: ${e.counts[st]}</span>`).join('')}
        </div>
        ${e.warnings.length ? `<div class="tip">⚠ ${e.warnings.map(esc).join(' · ')}</div>` : ''}
        <div class="list" style="margin-top:12px">${e.stories.map(storyRow).join('') || '<div class="empty">Sin historias</div>'}</div>
      </div>`).join('');
    bindCommon(view);
    view.querySelectorAll('[data-new-in]').forEach((b) => b.addEventListener('click', () => {
      state.specDraft = { epic: Number(b.dataset.newIn) };
      location.hash = 'nueva';
    }));
  }

  // ---------------- Próximos pasos ----------------
  function renderCommands(view, d) {
    view.innerHTML = `
      <div class="grid two">
        <div>
          <div class="panel-head"><h2>Comandos sugeridos</h2><span class="muted">según el estado actual del sprint</span></div>
          ${d.suggestions.length ? d.suggestions.map(suggestionCard).join('') : '<div class="panel empty">Nada pendiente.</div>'}
        </div>
        <div class="panel" style="align-self:start">
          <h2>Ciclo de una historia en BMAD</h2>
          <ol style="padding-left:18px;color:var(--ink-2);font-size:13px">
            <li><b>sprint-planning</b> — genera <code>sprint-status.yaml</code> desde las épicas.</li>
            <li><b>create-story</b> (SM) — crea el archivo de la siguiente historia en backlog → <i>drafted</i>.</li>
            <li><b>story-context</b> / <b>story-ready</b> (SM) — contexto técnico y marca <i>ready-for-dev</i>.</li>
            <li><b>dev-story</b> (DEV) — implementa tareas y pruebas → <i>in-progress</i> → <i>review</i>.</li>
            <li><b>code-review</b> (DEV, idealmente otro LLM) — aprueba o devuelve con hallazgos.</li>
            <li><b>story-done</b> — marca la historia como <i>done</i>.</li>
            <li><b>retrospective</b> (SM) — al terminar todas las historias de la épica.</li>
          </ol>
          <p class="tip">Si el alcance cambia a mitad del sprint usa <b>correct-course</b>. Abre un chat nuevo para cada workflow para no arrastrar contexto.</p>
          <p class="tip">Los nombres de comandos cambian entre versiones de BMAD: elige el formato en el selector <b>Comandos</b> de la barra superior.</p>
        </div>
      </div>`;
    bindCommon(view);
  }

  function suggestionCard(s) {
    return `<div class="sugg ${s.priority}">
      <div class="sugg-head">
        <span class="prio">${s.priority}</span>
        <h3>${esc(s.title)}</h3>
        ${s.agent ? `<span class="tag">${esc(s.agent)}</span>` : ''}
        ${s.storyId ? `<button class="btn small ghost" data-story="${esc(s.storyId)}">Ver historia</button>` : ''}
      </div>
      <p>${esc(s.reason)}</p>
      ${s.steps.map((c, i) => `<div class="cmd">${s.steps.length > 1 ? `<span class="step">Paso ${i + 1}</span>` : ''}<pre>${esc(c)}</pre><button class="btn small" data-copy="${esc(c)}">Copiar</button></div>`).join('')}
      ${s.argument && !s.steps.some((c) => c.includes(s.argument)) ? `<div class="tip">Archivo: <code>${esc(s.argument)}</code> <button class="btn small ghost" data-copy="${esc(s.argument)}">Copiar ruta</button></div>` : ''}
      ${s.tip ? `<div class="tip">💡 ${esc(s.tip)}</div>` : ''}
    </div>`;
  }

  // ---------------- Alertas ----------------
  function renderAlerts(view, d) {
    view.innerHTML = `<div class="panel-head"><h2>Alertas y consistencia</h2><span class="muted">${d.alerts.length} hallazgo(s)</span></div>` +
      (d.alerts.length
        ? d.alerts.map((a) => `<div class="alert ${a.level} ${a.storyId ? 'clickable' : ''}" ${a.storyId ? `data-story="${esc(a.storyId)}"` : ''}><span class="lvl">${{ error: 'Error', warning: 'Aviso', info: 'Info' }[a.level]}</span><span>${esc(a.message)}</span></div>`).join('')
        : '<div class="panel empty">✓ Todo consistente: sprint-status y archivos de historias coinciden.</div>');
    bindCommon(view);
  }

  // ---------------- Nueva historia ----------------
  function saveMode() {
    const src = state.source;
    if (src.kind === 'local') return 'local';
    if (src.kind === 'browser' && src.handle) return 'folder';
    return 'download';
  }

  function renderSpec(view, d) {
    const ctx = d.specContext;
    if (!ctx) { view.innerHTML = '<div class="panel empty">Este snapshot no incluye el contexto para generar historias. Abre la carpeta del proyecto.</div>'; return; }
    const draftKey = 'bmad.specDraft.' + (state.source.label || state.source.path || state.source.projectId);
    const draft = Object.assign({ epic: ctx.plannedEpics[0]?.number ?? 1 }, store.get(draftKey, {}), state.specDraft || {});
    state.specDraft = null;
    const v4 = d.version === 'v4';
    const mode = saveMode();
    const saveLabel = { local: 'Guardar en el proyecto', folder: 'Guardar en la carpeta', download: 'Descargar historia (.md)' }[mode];

    view.innerHTML = `
      <div class="spec">
        <div class="panel">
          <div class="panel-head"><h2>Especificación de nueva historia</h2></div>
          <form id="spec-form" class="form-grid" autocomplete="off">
            <div>
              <label>Épica</label>
              <select name="epic">${ctx.plannedEpics.map((e) => `<option value="${e.number}">${e.number}. ${esc(e.title)}</option>`).join('')}<option value="__new">+ Nueva épica…</option></select>
            </div>
            <div>
              <label>Número de historia</label>
              <input type="number" name="number" min="1" />
              <div class="help">Sugerido: siguiente número libre de la épica.</div>
            </div>
            <div class="full" id="planned-wrap">
              <label>Partir de una historia planificada (epics.md)</label>
              <select name="planned"></select>
            </div>
            <div class="full"><label>Título</label><input type="text" name="title" placeholder="Ej: Login con JWT" /></div>
            <div><label>Como (rol)</label><input type="text" name="role" placeholder="usuario registrado" /></div>
            <div><label>Quiero</label><input type="text" name="want" placeholder="iniciar sesión con email y contraseña" /></div>
            <div class="full"><label>Para (beneficio)</label><input type="text" name="benefit" placeholder="acceder a mi historial de pedidos" /></div>
            <div class="full">
              <label>Criterios de aceptación (uno por línea)</label>
              <textarea name="acceptanceCriteria" rows="5" placeholder="Given un usuario válido, When envía credenciales correctas, Then recibe un JWT con expiración de 1h&#10;Tras 5 intentos fallidos la cuenta se bloquea 15 minutos"></textarea>
            </div>
            <div class="full">
              <label>Tareas / subtareas</label>
              <textarea name="tasks" rows="6" placeholder="Crear endpoint POST /auth/login (AC: 1)&#10;  - Validar DTO&#10;  - Pruebas unitarias del servicio&#10;Implementar bloqueo de cuenta (AC: 2)"></textarea>
              <div class="help">Una tarea por línea. Subtareas con sangría o "-". Vincula criterios con "(AC: 1, 2)".</div>
            </div>
            <div class="full"><label>Dev Notes (contexto técnico)</label><textarea name="devNotes" rows="4" placeholder="Usar el módulo Auth existente; contraseñas con bcrypt; seguir el patrón de repositorios de architecture.md"></textarea></div>
            <div class="full"><label>Referencias (una por línea)</label><textarea name="references" rows="2" placeholder="[Source: architecture.md#Seguridad]"></textarea></div>
            <div>
              <label>Estado inicial</label>
              <select name="status">
                <option value="drafted">drafted${v4 ? ' (Draft)' : ''}</option>
                <option value="ready-for-dev">ready-for-dev${v4 ? ' (Approved)' : ''}</option>
                <option value="backlog">backlog</option>
              </select>
            </div>
            <div>
              <label>Plantilla</label>
              <select name="template"><option value="v6">BMAD v6</option><option value="v4">BMAD v4</option></select>
            </div>
            <div><label>Autor</label><input type="text" name="author" value="${esc(ctx.author)}" /></div>
            <div style="display:flex;flex-direction:column;justify-content:flex-end;gap:6px">
              <label class="toggle"><input type="checkbox" name="updateSprintStatus" ${ctx.hasSprintStatus && mode !== 'download' ? 'checked' : 'disabled'} /> Registrar en sprint-status.yaml</label>
              <label class="toggle"><input type="checkbox" name="overwrite" /> Sobrescribir si existe</label>
            </div>
          </form>
        </div>

        <div class="panel preview">
          <div class="panel-head"><h2>Vista previa</h2><span class="spacer"></span><span class="mono muted" id="spec-file" style="font-size:12px"></span></div>
          <ul class="checks" id="spec-checks"></ul>
          <pre id="spec-md"></pre>
          <div class="actions">
            ${readOnly() ? '' : `<button class="btn primary" id="spec-save">${saveLabel}</button>`}
            <button class="btn" id="spec-copy">Copiar markdown</button>
            ${mode !== 'download' ? '<button class="btn" id="spec-download">Descargar .md</button>' : ''}
            <button class="btn ghost" id="spec-prompt">Copiar prompt para el SM</button>
            ${state.session && state.cloudProjectId ? '<button class="btn ghost" id="spec-cloud">Guardar en mi cuenta</button>' : ''}
            <button class="btn ghost" id="spec-clear">Limpiar</button>
          </div>
          <div class="tip" id="spec-target"></div>
          ${mode === 'download' && !readOnly() ? '<div class="tip">Tu navegador no permite escribir en la carpeta: descarga el .md y cópialo en la ruta indicada (y añade la clave a sprint-status.yaml).</div>' : ''}
          <div id="saved-specs" class="saved-specs"></div>
        </div>
      </div>`;

    const form = $('#spec-form');
    const F = (n) => form.elements[n];
    let lastPreview = null;
    let newEpic = null;

    for (const k of ['title', 'role', 'want', 'benefit', 'acceptanceCriteria', 'tasks', 'devNotes', 'references', 'status', 'author']) if (draft[k] !== undefined && F(k)) F(k).value = draft[k];
    F('template').value = draft.template || (v4 ? 'v4' : 'v6');
    if (ctx.plannedEpics.some((e) => e.number === Number(draft.epic))) F('epic').value = String(draft.epic);
    else if (draft.epic) { newEpic = Number(draft.epic); addNewEpicOption(newEpic); }

    function addNewEpicOption(n) {
      const opt = document.createElement('option');
      opt.value = String(n); opt.textContent = `${n}. (nueva épica)`;
      F('epic').insertBefore(opt, F('epic').lastElementChild);
      F('epic').value = String(n);
    }
    const epicInfo = () => ctx.plannedEpics.find((e) => e.number === Number(F('epic').value));
    function refreshPlanned(keepNumber) {
      const e = epicInfo();
      const planned = e ? e.plannedStories : [];
      $('#planned-wrap').classList.toggle('hidden', planned.length === 0);
      F('planned').innerHTML = '<option value="">— Historia nueva desde cero —</option>' + planned.map((p) => `<option value="${esc(p.id)}">${esc(p.id)} · ${esc(p.title)}</option>`).join('');
      if (!keepNumber || !F('number').value) F('number').value = e ? e.nextNumber : 1;
    }
    F('epic').addEventListener('change', () => {
      if (F('epic').value === '__new') {
        newEpic = Math.max(0, ...ctx.plannedEpics.map((e) => e.number), newEpic || 0) + 1;
        addNewEpicOption(newEpic);
        F('number').value = 1;
      }
      refreshPlanned(false);
      schedule();
    });
    F('planned').addEventListener('change', () => {
      const p = epicInfo()?.plannedStories.find((x) => x.id === F('planned').value);
      if (!p) return;
      F('number').value = p.number;
      F('title').value = p.title;
      const us = parseUserStory(p.userStory || '');
      if (us) { F('role').value = us.role; F('want').value = us.want; F('benefit').value = us.benefit; }
      if (p.acceptanceCriteria.length) F('acceptanceCriteria').value = p.acceptanceCriteria.join('\n');
      F('references').value = `[Source: epics.md#Story-${p.id}]`;
      schedule();
    });
    refreshPlanned(true);
    if (draft.number) F('number').value = draft.number;

    function values() {
      const v = Object.fromEntries(new FormData(form).entries());
      return {
        epic: Number(F('epic').value === '__new' ? newEpic : F('epic').value),
        number: Number(v.number) || undefined,
        title: v.title || '',
        role: v.role, want: v.want, benefit: v.benefit,
        acceptanceCriteria: v.acceptanceCriteria, tasks: v.tasks, devNotes: v.devNotes, references: v.references,
        status: v.status, template: v.template, author: v.author,
        overwrite: F('overwrite').checked,
        updateSprintStatus: F('updateSprintStatus').checked,
      };
    }

    let timer;
    function schedule() { clearTimeout(timer); timer = setTimeout(preview, 350); }
    form.addEventListener('input', schedule);

    async function preview() {
      const v = values();
      store.set(draftKey, v);
      if (!v.title.trim()) {
        $('#spec-md').textContent = 'Escribe al menos un título para ver la vista previa.';
        $('#spec-checks').innerHTML = ''; $('#spec-file').textContent = ''; lastPreview = null; return;
      }
      try {
        lastPreview = await post('/api/spec/build', { spec: v, context: ctx });
        $('#spec-md').textContent = lastPreview.markdown;
        $('#spec-file').textContent = lastPreview.fileName;
        $('#spec-target').innerHTML = `Ruta en el proyecto: <code>${esc(lastPreview.relativeTarget)}</code>`;
        const icon = { ok: '✓', warning: '!', error: '✕' };
        $('#spec-checks').innerHTML = lastPreview.quality.map((c) => `<li><span class="${c.level}">${icon[c.level]}</span><span>${esc(c.message)}</span></li>`).join('');
        if ($('#spec-save')) $('#spec-save').disabled = lastPreview.quality.some((c) => c.level === 'error');
      } catch (err) { $('#spec-md').textContent = err.message; }
    }

    async function recordInCloud(result, savedToDisk) {
      if (!state.session || !state.cloudProjectId) return false;
      try {
        await post(`/api/projects/${state.cloudProjectId}/specs`, {
          storyId: result.storyId, storyKey: result.storyKey, title: values().title, status: result.status,
          fileName: result.fileName, markdown: result.markdown, quality: result.quality, savedToDisk,
        });
        loadSavedSpecs();
        return true;
      } catch { return false; }
    }

    $('#spec-copy').addEventListener('click', () => lastPreview && copy(lastPreview.markdown));
    $('#spec-download')?.addEventListener('click', () => lastPreview && download(lastPreview.fileName, lastPreview.markdown));
    $('#spec-prompt').addEventListener('click', () => lastPreview && copy(lastPreview.prompt));
    $('#spec-cloud')?.addEventListener('click', async () => {
      if (!lastPreview) return;
      toast((await recordInCloud(lastPreview, false)) ? 'Especificación guardada en tu cuenta' : 'No se pudo guardar en la nube', false);
    });
    $('#spec-clear').addEventListener('click', () => {
      store.set(draftKey, {});
      state.specDraft = { epic: Number(F('epic').value) || undefined };
      renderSpec(view, d);
    });
    $('#spec-save')?.addEventListener('click', async () => {
      const btn = $('#spec-save');
      btn.disabled = true;
      const v = values();
      try {
        let result;
        if (mode === 'local') {
          result = await post('/api/local/spec/save', { path: state.source.path, spec: v });
          toast(`Historia guardada en ${result.savedPath}${result.sprintUpdated ? ' · sprint-status actualizado' : ''}`);
        } else if (mode === 'folder') {
          const root = state.source.handle;
          if (!(await ensurePermission(root, 'readwrite'))) throw new Error('Necesito permiso de escritura en la carpeta para guardar la historia.');
          const sprintFile = ctx.sprintStatusFile && state.source.files.get(ctx.sprintStatusFile);
          result = await post('/api/spec/build', { spec: v, context: ctx, sprintStatusContent: v.updateSprintStatus && sprintFile ? sprintFile.content : undefined });
          if (result.quality.some((c) => c.level === 'error')) throw new Error(result.quality.filter((c) => c.level === 'error').map((c) => c.message).join(' '));
          if (!v.overwrite && (await fileExists(root, result.relativeTarget))) throw new Error(`Ya existe ${result.relativeTarget}. Activa "sobrescribir" para reemplazarlo.`);
          await writeText(root, result.relativeTarget, result.markdown);
          if (result.sprintStatusChanged) await writeText(root, ctx.sprintStatusFile, result.sprintStatusContent);
          toast(`Historia guardada en ${result.relativeTarget}${result.sprintStatusChanged ? ' · sprint-status actualizado' : ''}`);
        } else {
          result = await post('/api/spec/build', { spec: v, context: ctx });
          download(result.fileName, result.markdown);
          await recordInCloud(result, false);
          btn.disabled = false;
          return;
        }
        await recordInCloud(result, true);
        store.set(draftKey, {});
        await reload(true);
        location.hash = 'tablero';
        setTimeout(() => openStory(result.storyId), 250);
      } catch (err) { toast(err.message, true); btn.disabled = false; }
    });

    async function loadSavedSpecs() {
      const el = $('#saved-specs');
      if (!el || !state.session || !state.cloudProjectId) return;
      try {
        const specs = await api(`/api/projects/${state.cloudProjectId}/specs`);
        if (!specs.length) { el.innerHTML = ''; return; }
        el.innerHTML = `<h3>Especificaciones guardadas en tu cuenta</h3><div class="list" style="margin-top:8px">${specs.slice(0, 10).map((s, i) => `
          <div class="row-item" data-spec="${i}"><span class="tag">${esc(s.story_id)}</span><div class="grow"><div class="title">${esc(s.title)}</div><div class="meta">${new Date(s.created_at).toLocaleString()} · ${s.saved_to_disk ? 'guardada en el proyecto' : 'solo en la nube'}</div></div>
          <button class="btn small ghost" data-copyspec="${i}">Copiar</button><button class="btn small ghost" data-dlspec="${i}">.md</button></div>`).join('')}</div>`;
        el.querySelectorAll('[data-copyspec]').forEach((b) => b.addEventListener('click', () => copy(specs[Number(b.dataset.copyspec)].markdown)));
        el.querySelectorAll('[data-dlspec]').forEach((b) => b.addEventListener('click', () => { const s = specs[Number(b.dataset.dlspec)]; download(s.file_name || `${s.story_id}.md`, s.markdown); }));
      } catch { /* sin conexión */ }
    }

    preview();
    loadSavedSpecs();
  }

  function parseUserStory(text) {
    const t = text.replace(/\*\*/g, '');
    let m = /As an?\s+(.+?),\s*I want\s+(.+?),\s*so that\s+(.+?)\.?$/i.exec(t);
    if (m) return { role: m[1], want: m[2], benefit: m[3] };
    m = /Como\s+(.+?),\s*quiero\s+(.+?),\s*para\s+(.+?)\.?$/i.exec(t);
    return m ? { role: m[1], want: m[2], benefit: m[3] } : null;
  }

  // ---------------- Detalle de historia (modal) ----------------
  async function storyMarkdown(p) {
    if (!p) return null;
    const src = state.source;
    if (src.kind === 'browser') return src.files.get(p.relativePath)?.content ?? null;
    if (src.kind === 'local') { try { return (await api('/api/local/story?' + q({ path: src.path, file: p.relativePath }))).markdown; } catch { return null; } }
    return null;
  }

  async function openStory(id) {
    const d = state.data;
    const s = d.stories.find((x) => x.id === id);
    const p = d.details?.[id] || null;
    const planned = d.specContext?.plannedEpics.flatMap((e) => e.plannedStories).find((x) => x.id === id) || null;
    const body = $('#modal-body');
    $('#modal').classList.remove('hidden');
    body.innerHTML = '<div class="loading">Cargando…</div>';
    const markdown = await storyMarkdown(p);
    const sugg = d.suggestions.filter((x) => x.storyId === id);
    const tasks = p ? p.tasks : [];
    const acs = p ? p.acceptanceCriteria : planned ? planned.acceptanceCriteria : [];

    body.innerHTML = `
      <div class="detail-head">
        <span class="tag">Historia ${esc(id)}</span>
        <h2>${esc(s ? s.title : p?.title || planned?.title || id)}</h2>
        ${s ? pill(s.status) : ''}
      </div>
      <div class="muted mono" style="font-size:12px">${p ? esc(p.relativePath) : 'Sin archivo todavía (solo en planificación / sprint-status)'}</div>
      ${s?.sprintStatus || s?.fileStatus ? `<div class="tip">sprint-status: <b>${esc(s.sprintStatus || '—')}</b> · archivo: <b>${esc(s.fileStatus || '—')}</b>${p ? ` · modificado ${timeAgo(p.mtime)}` : ''}</div>` : ''}
      ${s?.warnings.length ? `<div class="alert warning" style="margin-top:10px"><span class="lvl">Aviso</span><span>${s.warnings.map(esc).join('<br>')}</span></div>` : ''}
      ${p?.userStory || planned?.userStory ? `<p style="margin-top:12px;font-style:italic;color:var(--ink-2)">${esc(p?.userStory || planned.userStory)}</p>` : ''}
      ${sugg.length ? `<div style="margin-top:14px">${sugg.map(suggestionCard).join('')}</div>` : ''}
      <div class="detail-grid">
        <div>
          <h3>Tareas ${tasks.length ? `<span class="muted">(${p.tasksDone}/${p.tasksTotal})</span>` : ''}</h3>
          ${tasks.length ? `<div class="bar" style="margin:6px 0 10px"><span style="width:${pct(p.tasksDone, p.tasksTotal)}%"></span></div>` + tasks.map((t) => `<div class="task ${t.done ? 'done' : ''}" style="padding-left:${t.level * 18}px"><span class="box">${t.done ? '☑' : '☐'}</span><span>${t.reviewFollowUp ? '<span class="tag" style="color:var(--s-review)">AI-Review</span> ' : ''}${esc(t.text)}</span></div>`).join('') : '<div class="muted">Sin tareas definidas.</div>'}
        </div>
        <div>
          <h3>Criterios de aceptación</h3>
          ${acs.length ? `<ol style="padding-left:18px;font-size:13px">${acs.map((a) => `<li>${esc(a)}</li>`).join('')}</ol>` : '<div class="muted">Sin criterios.</div>'}
          ${p?.reviewOutcome ? `<h3 style="margin-top:12px">Revisión</h3><div>Resultado: <b>${esc(p.reviewOutcome)}</b> · ${p.pendingReviewItems} acción(es) pendientes</div>` : ''}
          ${p?.fileList?.length ? `<h3 style="margin-top:12px">Archivos tocados</h3><ul class="mono" style="font-size:12px;padding-left:18px">${p.fileList.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
        </div>
      </div>
      ${!p && s && !readOnly() ? `<div class="actions"><button class="btn primary" id="create-from">Crear especificación de esta historia</button></div>` : ''}
      ${markdown ? `
        <div class="actions"><button class="btn small" id="toggle-raw">Ver markdown original</button><button class="btn small ghost" id="copy-raw">Copiar</button>${p ? `<button class="btn small ghost" data-copy="${esc(p.relativePath)}">Copiar ruta</button>` : ''}</div>
        <div class="md" id="md-render">${renderMd(markdown)}</div>
        <pre class="md hidden" id="md-raw" style="white-space:pre-wrap">${esc(markdown)}</pre>` : ''}`;

    bindCopy(body);
    body.querySelectorAll('[data-story]').forEach((b) => b.remove());
    $('#toggle-raw')?.addEventListener('click', () => { $('#md-render').classList.toggle('hidden'); $('#md-raw').classList.toggle('hidden'); });
    $('#copy-raw')?.addEventListener('click', () => copy(markdown));
    $('#create-from')?.addEventListener('click', () => {
      closeModal();
      const us = parseUserStory(planned?.userStory || '');
      state.specDraft = {
        epic: s.epic, number: s.number, title: s.title,
        role: us?.role || '', want: us?.want || '', benefit: us?.benefit || '',
        acceptanceCriteria: (planned?.acceptanceCriteria || []).join('\n'), tasks: '', devNotes: '', references: planned ? `[Source: epics.md#Story-${s.id}]` : '',
      };
      if (location.hash === '#nueva') render(); else location.hash = 'nueva';
    });
  }

  function closeModal() { $('#modal').classList.add('hidden'); }
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  function bindCopy(root) {
    root.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); copy(b.dataset.copy); }));
  }
  function bindCommon(root) {
    bindCopy(root);
    root.querySelectorAll('[data-story]').forEach((el) => el.addEventListener('click', (e) => { if (e.target.closest('[data-copy]')) return; openStory(el.dataset.story); }));
    root.querySelectorAll('[data-epic]').forEach((el) => el.addEventListener('click', () => {
      location.hash = 'epicas';
      setTimeout(() => document.getElementById('epic-' + el.dataset.epic)?.scrollIntoView({ behavior: 'smooth' }), 50);
    }));
  }

  // ---------------- Markdown mínimo ----------------
  function renderMd(md) {
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    let html = '', inCode = false, inList = false, inTable = false;
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
    const closeTable = () => { if (inTable) { html += '</table>'; inTable = false; } };
    for (const line of lines) {
      if (/^\s*```/.test(line)) { closeList(); closeTable(); html += inCode ? '</pre>' : '<pre>'; inCode = !inCode; continue; }
      if (inCode) { html += esc(line) + '\n'; continue; }
      let m;
      if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { closeList(); closeTable(); const n = Math.min(m[1].length, 4); html += `<h${n}>${inline(m[2])}</h${n}>`; continue; }
      if (/^\s*\|/.test(line)) {
        closeList();
        if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
        if (!inTable) { html += '<table>'; inTable = true; }
        html += '<tr>' + line.trim().replace(/^\||\|$/g, '').split('|').map((c) => `<td>${inline(c.trim())}</td>`).join('') + '</tr>';
        continue;
      }
      closeTable();
      if ((m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
        if (!inList) { html += '<ul>'; inList = true; }
        let t = m[3];
        const cb = /^\[( |x|X)\]\s+(.*)$/.exec(t);
        if (cb) t = (cb[1].trim() ? '☑ ' : '☐ ') + cb[2];
        html += `<li style="margin-left:${Math.floor(m[1].length / 2) * 16}px;${cb ? 'list-style:none' : ''}">${inline(t)}</li>`;
        continue;
      }
      closeList();
      if (line.trim() === '') continue;
      html += `<p>${inline(line)}</p>`;
    }
    closeList(); closeTable();
    if (inCode) html += '</pre>';
    return html;
  }

  // ---------------- Arranque ----------------
  async function init() {
    try { state.config = await api('/api/config'); }
    catch (err) { document.body.innerHTML = `<div class="loading">No se pudo conectar con el servidor: ${esc(err.message)}</div>`; return; }

    if (state.config.supabase && window.supabase?.createClient) {
      state.sb = window.supabase.createClient(state.config.supabase.url, state.config.supabase.key, {
        auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      });
      const { data } = await state.sb.auth.getSession();
      state.session = data.session;
      // Limpia ?code=… del enlace de acceso
      if (/[?&]code=/.test(location.search)) history.replaceState(null, '', location.pathname + location.hash);
      state.sb.auth.onAuthStateChange((event, session) => {
        const was = !!state.session;
        state.session = session;
        if (was === !!session) return; // p. ej. TOKEN_REFRESHED / INITIAL_SESSION sin cambios
        if (!state.source) renderAccount();
        else if (session) syncToCloud();
        else renderSyncState();
        if (event === 'SIGNED_IN' && !was) toast('Sesión iniciada');
      });
    }

    const path = new URLSearchParams(location.search).get('path');
    if (path && state.config.localMode) openLocal(path);
    else showStart();
  }

  init();
})();
