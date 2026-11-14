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
  const TABS = ['resumen', 'tablero', 'epicas', 'metricas', 'calidad', 'comandos', 'nueva', 'alertas', 'asistente'];
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
    ai: { convo: [], focus: null, prefill: '', streaming: null, index: null },
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

  /**
   * Lee la carpeta. Con `prev` (lectura anterior) es incremental: solo vuelve a leer el contenido
   * de los archivos BMAD cuya fecha o tamaño cambió, y devuelve una firma para detectar cambios.
   */
  async function readHandle(root, prev) {
    const files = [];
    const markers = [];
    const maxSize = state.config.scan.maxFileSize;
    for await (const [name] of root.entries()) markers.push(name);
    if (markers.includes('bmad')) {
      try { await (await root.getDirectoryHandle('bmad')).getDirectoryHandle('bmm'); markers.push('bmad/bmm'); } catch { /* no */ }
    }
    const load = async (rel, getFile, need) => {
      const old = prev?.get(rel);
      if (!need && old) return old; // archivos no BMAD: basta con la metadata de la primera lectura
      const file = await getFile();
      const f = { path: rel, mtime: file.lastModified, size: file.size };
      if (need && file.size <= maxSize) {
        f.content = old && old.mtime === f.mtime && old.size === f.size && old.content !== undefined ? old.content : await file.text();
      }
      return f;
    };
    async function walk(dir, prefix, depth) {
      for await (const [name, h] of dir.entries()) {
        if (h.kind === 'directory') {
          if (skipDir(name, depth) || depth >= state.config.scan.maxDepth) continue;
          await walk(h, prefix + name + '/', depth + 1);
        } else if (/\.(md|ya?ml)$/i.test(name)) {
          const rel = prefix + name;
          files.push(await load(rel, () => h.getFile(), needsContent(rel)));
        }
      }
    }
    await walk(root, '', 0);
    for (const c of state.config.scan.configFiles) {
      try {
        const fh = await getFileHandle(root, c, false);
        files.push(await load(c, () => fh.getFile(), true));
      } catch { /* no existe */ }
    }
    const signature = files.filter((f) => f.content !== undefined).map((f) => `${f.path}|${f.mtime}|${f.size}`).sort().join('\n') + `#${files.length}`;
    return { files, markers, signature };
  }

  /** Fallback (<input webkitdirectory>): lectura única, sin escritura. */
  async function readFileList(list) {
    const all = Array.from(list);
    if (!all.length) throw new Error('La carpeta está vacía.');
    const label = all[0].webkitRelativePath.split('/')[0];
    const files = [];
    const markers = new Set();
    const raw = new Map();
    const testFiles = [];
    const maxSize = state.config.scan.maxFileSize;
    for (const file of all) {
      const parts = file.webkitRelativePath.split('/').slice(1);
      if (!parts.length) continue;
      markers.add(parts[0]);
      if (parts[0] === 'bmad' && parts[1] === 'bmm') markers.add('bmad/bmm');
      const rel = parts.join('/');
      if (isTestReportPath(rel)) testFiles.push({ path: rel, file });
      const isConfig = state.config.scan.configFiles.includes(rel);
      if (!isConfig && parts.slice(0, -1).some((d, i) => skipDir(d, i))) continue;
      if (!/\.(md|ya?ml)$/i.test(file.name)) continue;
      const f = { path: rel, mtime: file.lastModified, size: file.size };
      if (file.size <= maxSize && (isConfig || needsContent(rel))) f.content = await file.text();
      files.push(f);
      raw.set(rel, file);
    }
    return { label, files, markers: [...markers], raw, testFiles };
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
    stopWatching();
    clearInterval(state.intTimer);
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
      const { label, files, markers, raw, testFiles } = await readFileList(e.target.files);
      state.source = { kind: 'browser', handle: null, label, files: new Map(files.map((f) => [f.path, f])), markers, raw, testFiles };
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
  /**
   * Carga los datos de la fuente actual. Con `onlyIfChanged` devuelve null si nada cambió
   * (firma de archivos idéntica), para no recalcular ni repintar.
   */
  async function loadData(onlyIfChanged = false) {
    const src = state.source;
    const style = state.style || undefined;
    if (src.kind === 'local') {
      if (onlyIfChanged) {
        const { signature } = await api('/api/local/signature?' + q({ path: src.path }));
        if (signature === src.signature) return null;
        src.signature = signature;
      } else {
        api('/api/local/signature?' + q({ path: src.path })).then((r) => (src.signature = r.signature)).catch(() => {});
      }
      return api('/api/local/dashboard?' + q(style ? { path: src.path, style } : { path: src.path }));
    }
    if (src.kind === 'browser') {
      if (src.handle) {
        const { files, markers, signature } = await readHandle(src.handle, src.files);
        if (onlyIfChanged && signature === src.signature) return null;
        src.files = new Map(files.map((f) => [f.path, f]));
        src.markers = markers;
        src.signature = signature;
      } else if (onlyIfChanged) return null;
      return post('/api/analyze', { root: src.label, files: [...src.files.values()], markers: src.markers, style });
    }
    const snap = await api(`/api/projects/${src.projectId}/latest`);
    if (onlyIfChanged && snap.created_at === src.at) return null;
    src.at = snap.created_at;
    return snap.dashboard;
  }

  async function enterDashboard() {
    stopWatching();
    const key = 'bmad.style.' + (state.source.label || state.source.path || state.source.projectId);
    state.style = store.get(key, null);
    state.styleKey = key;
    state.cloudProjectId = state.source.kind === 'cloud' ? state.source.projectId : null;
    state.history = null;
    state.lastSync = null;
    state.changes = [];
    state.flash = new Set();
    state.data = await loadData();
    state.style = state.data.commandStyle;
    $('#start').classList.add('hidden');
    $('#app').classList.remove('hidden');
    if (!TABS.includes(location.hash.slice(1))) history.replaceState(null, '', '#resumen');
    render();
    $('#live-toggle').checked = store.get('bmad.live', true);
    if ($('#live-toggle').checked) startWatching(); else renderLiveState();
    if (readOnly()) loadHistory(); else syncToCloud();
    clearInterval(state.intTimer);
    state.gh = null; state.tests = null;
    if (!readOnly()) {
      refreshIntegrations();
      state.intTimer = setInterval(() => document.visibilityState === 'visible' && state.watch?.mode !== 'none' && refreshIntegrations(), 60000);
    }
  }

  // ---------------- Actualización en vivo ----------------
  /** Compara dos estados y devuelve los cambios por historia. */
  function diffStories(prev, next) {
    const before = new Map(prev.stories.map((s) => [s.id, s]));
    const after = new Set(next.stories.map((s) => s.id));
    const out = [];
    for (const s of next.stories) {
      const o = before.get(s.id);
      if (!o) out.push({ id: s.id, title: s.title, kind: 'new', to: s.status });
      else if (o.status !== s.status) out.push({ id: s.id, title: s.title, kind: 'status', from: o.status, to: s.status });
      else if (o.tasksDone !== s.tasksDone || o.tasksTotal !== s.tasksTotal) out.push({ id: s.id, title: s.title, kind: 'tasks', from: `${o.tasksDone}/${o.tasksTotal}`, to: `${s.tasksDone}/${s.tasksTotal}` });
      else if (o.pendingReviewItems !== s.pendingReviewItems) out.push({ id: s.id, title: s.title, kind: 'review', from: o.pendingReviewItems, to: s.pendingReviewItems });
    }
    for (const o of prev.stories) if (!after.has(o.id)) out.push({ id: o.id, title: o.title, kind: 'removed', from: o.status });
    return out;
  }

  function describeChange(c) {
    const st = (x) => STATUS_LABEL[x] ?? x;
    switch (c.kind) {
      case 'status': return `${c.id} ${c.title}: ${st(c.from)} → ${st(c.to)}`;
      case 'new': return `${c.id} ${c.title}: nueva (${st(c.to)})`;
      case 'tasks': return `${c.id} ${c.title}: tareas ${c.from} → ${c.to}`;
      case 'review': return `${c.id} ${c.title}: hallazgos de revisión ${c.from} → ${c.to}`;
      case 'removed': return `${c.id} ${c.title}: ya no aparece en el proyecto`;
      default: return c.id;
    }
  }

  /** Aplica un estado nuevo: detecta cambios, avisa, resalta y sincroniza. */
  function applyData(next, { announce = true } = {}) {
    const prev = state.data;
    const changes = prev ? diffStories(prev, next) : [];
    state.data = next;
    if (changes.length) {
      const at = Date.now();
      state.changes = [...changes.map((c) => ({ ...c, at })), ...(state.changes || [])].slice(0, 30);
      state.flash = new Set(changes.map((c) => c.id));
      setTimeout(() => { state.flash = new Set(); document.querySelectorAll('.flash').forEach((el) => el.classList.remove('flash')); }, 4000);
      if (announce) {
        const first = describeChange(changes[0]);
        toast(changes.length === 1 ? `Cambio detectado · ${first}` : `${changes.length} cambios · ${first} (y ${changes.length - 1} más)`);
      }
      if (document.visibilityState !== 'visible') {
        state.unseen = (state.unseen || 0) + changes.length;
        document.title = `(${state.unseen}) BMAD Dashboard`;
      }
    }
    render(true);
    if (!readOnly()) syncToCloud();
    return changes;
  }

  /** Busca cambios; si hay, recalcula y repinta. `force` = recarga manual. */
  async function check(force = false) {
    if (!state.source || !state.data) return;
    if (state.busy) { state.pending = true; return; }
    state.busy = true;
    try {
      const next = await loadData(!force);
      if (next) {
        const changes = applyData(next, { announce: !force });
        if (force) toast(changes.length ? `Actualizado · ${changes.length} cambio(s)` : 'Sin cambios');
      }
      state.liveError = null;
    } catch (err) {
      state.liveError = err.message;
      if (force) toast(err.message, true);
    } finally {
      state.busy = false;
      state.lastCheck = Date.now();
      renderLiveState();
      if (state.pending) { state.pending = false; scheduleCheck(300); }
    }
  }
  function scheduleCheck(ms = 400) { clearTimeout(state.checkTimer); state.checkTimer = setTimeout(() => check(), ms); }
  const reload = (silent = false) => (silent ? check() : check(true));

  /** Vigila la fuente actual: FileSystemObserver / sondeo / Supabase Realtime. */
  async function startWatching() {
    stopWatching();
    const src = state.source;
    state.watch = { mode: 'none' };
    if (src.kind === 'browser' && src.handle) {
      if (typeof window.FileSystemObserver === 'function') {
        try {
          const obs = new window.FileSystemObserver(() => scheduleCheck(500));
          await obs.observe(src.handle, { recursive: true });
          state.watch = { mode: 'observer', observer: obs, timer: setInterval(() => check(), 30000) };
        } catch { /* sin observer: sondeo */ }
      }
      if (state.watch.mode === 'none') state.watch = { mode: 'poll', timer: setInterval(() => document.visibilityState === 'visible' && check(), 4000) };
    } else if (src.kind === 'local') {
      state.watch = { mode: 'poll', timer: setInterval(() => check(), 3000) };
    } else if (src.kind === 'cloud' && state.sb && state.session) {
      const channel = state.sb
        .channel('snapshots-' + src.projectId)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'snapshots', filter: `project_id=eq.${src.projectId}` }, () => { scheduleCheck(200); loadHistory(); })
        .subscribe((status) => { state.watch.status = status; renderLiveState(); });
      state.watch = { mode: 'realtime', channel, timer: setInterval(() => check(), 60000) };
    }
    renderLiveState();
  }
  function stopWatching() {
    const w = state.watch;
    if (!w) return;
    if (w.timer) clearInterval(w.timer);
    try { w.observer?.disconnect(); } catch { /* ignorar */ }
    if (w.channel && state.sb) state.sb.removeChannel(w.channel);
    clearTimeout(state.checkTimer);
    state.watch = null;
  }

  function renderLiveState() {
    const el = $('#live-state');
    if (!el || !state.source) return;
    const src = state.source;
    const canWatch = src.kind === 'local' || (src.kind === 'browser' && src.handle) || (src.kind === 'cloud' && state.session);
    $('#live-wrap').classList.toggle('hidden', !canWatch);
    $('#refresh-btn').classList.toggle('hidden', src.kind === 'browser' && !src.handle);
    if (!canWatch) {
      el.className = 'live-state off';
      el.textContent = src.kind === 'browser' ? 'Instantánea · vuelve a cargar la carpeta para actualizar' : '';
      return;
    }
    const w = state.watch;
    if (!w || w.mode === 'none') { el.className = 'live-state off'; el.textContent = 'Pausado'; el.title = 'Actualización automática desactivada'; return; }
    if (state.liveError) { el.className = 'live-state err'; el.textContent = 'Error'; el.title = state.liveError; return; }
    el.className = 'live-state on';
    el.textContent = 'En vivo';
    el.title = {
      observer: 'Vigilando la carpeta: los cambios se detectan al instante',
      poll: src.kind === 'local' ? 'Revisando la carpeta cada 3 s' : 'Revisando la carpeta cada 4 s',
      realtime: `Supabase Realtime (${w.status || 'conectando'}): se actualiza cuando otro dispositivo sincroniza`,
    }[w.mode] + (state.lastCheck ? ` · última revisión ${new Date(state.lastCheck).toLocaleTimeString()}` : '');
  }

  $('#refresh-btn').addEventListener('click', () => check(true));
  $('#change-btn').addEventListener('click', () => showStart());
  $('#live-toggle').addEventListener('change', (e) => {
    store.set('bmad.live', e.target.checked);
    if (e.target.checked) { startWatching(); check(); } else { stopWatching(); renderLiveState(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (state.unseen) { state.unseen = 0; document.title = 'BMAD Dashboard'; }
    if (state.watch && state.watch.mode !== 'none') check();
  });
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
    $('#alert-count').textContent = alertCount(d) || '';
    const tab = currentTab();
    document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
    const view = $('#view');
    const editing = keepScroll && ((tab === 'nueva' && $('#spec-form')) || (tab === 'asistente' && $('#ai-chat')));
    if (!editing) {
      ({ resumen: renderSummary, tablero: renderBoard, epicas: renderEpics, metricas: renderMetrics, calidad: renderQuality, comandos: renderCommands, nueva: renderSpec, alertas: renderAlerts, asistente: renderAssistant })[tab](view, d);
    }
    $('#foot').textContent = `${d.scannedFiles} archivos analizados · sprint-status: ${d.sprintStatusFile || 'no encontrado'} · historias en ${d.storiesDirRelative} · actualizado ${new Date(d.generatedAt).toLocaleTimeString()}`;
    renderSyncState();
    renderLiveState();
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
          ${changesPanel()}
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
    $('#clear-changes')?.addEventListener('click', () => { state.changes = []; render(true); });
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

  function changesPanel() {
    const list = state.changes || [];
    if (!list.length) return '';
    const icon = { status: '⇄', new: '＋', tasks: '☑', review: '●', removed: '－' };
    return `<div class="panel changes">
      <div class="panel-head"><h2>Cambios detectados</h2><span class="muted">desde que abriste el proyecto</span><span class="spacer"></span><button class="btn small ghost" id="clear-changes">Limpiar</button></div>
      <div class="list">${list.slice(0, 8).map((c) => `
        <div class="row-item ${c.kind === 'removed' ? '' : ''}" ${c.kind !== 'removed' ? `data-story="${esc(c.id)}"` : ''}>
          <span class="chg-ico">${icon[c.kind] || '•'}</span>
          <div class="grow"><div class="title">${esc(c.id)} · ${esc(c.title)}</div>
            <div class="meta">${c.kind === 'status' ? `${esc(STATUS_LABEL[c.from] ?? c.from)} → <b>${esc(STATUS_LABEL[c.to] ?? c.to)}</b>` : esc(describeChange(c).split(': ').slice(1).join(': '))}</div></div>
          <span class="meta">${timeAgo(c.at)}</span>
        </div>`).join('')}</div>
    </div>`;
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
    return `<div class="row-item ${state.flash?.has(s.id) ? 'flash' : ''}" data-story="${esc(s.id)}">
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
      ${canEdit() ? '<div class="tip" style="margin:-6px 0 10px">Arrastra una tarjeta a otra columna para cambiar su estado: se actualizan <code>sprint-status.yaml</code> y el archivo de la historia.</div>' : ''}
      <div class="board" id="board"></div>`;
    const draw = () => {
      const qv = f.q.toLowerCase();
      const items = d.stories.filter((s) => (!f.epic || String(s.epic) === f.epic) && (!qv || (s.id + ' ' + s.title).toLowerCase().includes(qv)));
      $('#board').innerHTML = STATUSES.map((st) => {
        const col = items.filter((s) => s.status === st);
        return `<div class="col" data-col="${st}"><div class="col-head"><i class="dot" style="background:var(--s-${st})"></i>${STATUS_LABEL[st]}<span class="count">${col.length}</span></div>
          ${col.map((s) => `
            <div class="card ${state.flash?.has(s.id) ? 'flash' : ''}" style="--c:var(--s-${st})" data-story="${esc(s.id)}">
              <div class="id">${esc(s.id)} <span class="tag">E${s.epic}</span>${s.warnings.length ? `<span class="warn-ico" title="${esc(s.warnings.join('\n'))}">⚠</span>` : ''}${!s.hasFile && st !== 'backlog' ? '<span class="muted" title="Sin archivo">∅</span>' : ''}</div>
              <div class="t">${esc(s.title)}</div>
              <div class="foot2">
                ${s.tasksTotal ? `<div class="bar"><span style="width:${pct(s.tasksDone, s.tasksTotal)}%;background:var(--s-${st})"></span></div><span>${s.tasksDone}/${s.tasksTotal}</span>` : `<span>${s.hasFile ? 'sin tareas' : s.planned ? 'planificada' : ''}</span>`}
                ${s.pendingReviewItems ? `<span title="Hallazgos de revisión pendientes" style="color:var(--s-review)">● ${s.pendingReviewItems}</span>` : ''}
                ${integrationBadges(s)}
              </div>
            </div>`).join('') || '<div class="muted" style="font-size:12px;padding:6px">—</div>'}
        </div>`;
      }).join('');
      bindCommon($('#board'));
      bindBoardDnD($('#board'));
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
    const row = (a) => {
      const s = a.storyId && /desincronizado/i.test(a.message) ? d.stories.find((x) => x.id === a.storyId) : null;
      return `<div class="alert ${a.level} ${a.storyId ? 'clickable' : ''}" ${a.storyId ? `data-story="${esc(a.storyId)}"` : ''}><span class="lvl">${{ error: 'Error', warning: 'Aviso', info: 'Info' }[a.level]}</span><span class="grow">${esc(a.message)}</span>${s ? desyncFixHtml(s) : ''}</div>`;
    };
    const git = gitAlerts(), tests = testAlerts();
    view.innerHTML = `<div class="panel-head"><h2>Alertas y consistencia</h2><span class="muted">${d.alerts.length + git.length + tests.length} hallazgo(s)</span></div>` +
      (d.alerts.length ? d.alerts.map(row).join('') : '<div class="panel empty">✓ Todo consistente: sprint-status y archivos de historias coinciden.</div>') +
      (git.length ? `<div class="panel-head" style="margin-top:18px"><h2>GitHub</h2></div>${git.map(row).join('')}` : '') +
      (tests.length ? `<div class="panel-head" style="margin-top:18px"><h2>Pruebas</h2></div>${tests.map(row).join('')}` : '');
    bindFixButtons(view);
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
          <div class="panel-head"><h2>Especificación de nueva historia</h2><span class="spacer"></span>
            <button class="btn ai" type="button" id="ai-draft" title="La IA completa la historia usando la épica, el PRD y la arquitectura">✨ Redactar con IA</button></div>
          <div id="ai-draft-status" class="ai-status hidden"></div>
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
          <div class="actions" style="margin:0 0 10px"><button class="btn ai small" type="button" id="ai-review-btn">✨ Revisar con IA</button></div>
          <div id="ai-review" class="ai-review md hidden"></div>
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

    // ---- Claude: redactar y revisar ----
    const needKey = () => {
      if (aiKey.get()) return false;
      toast('Configura tu API key en la pestaña Asistente', true);
      location.hash = 'asistente';
      return true;
    };
    $('#ai-draft').addEventListener('click', async () => {
      if (needKey()) return;
      const btn = $('#ai-draft');
      const status = $('#ai-draft-status');
      const v = values();
      const e = epicInfo();
      const planned = e?.plannedStories.find((x) => x.id === F('planned').value) || e?.plannedStories.find((x) => x.number === v.number);
      const specDraft = {
        epic: v.epic, epicTitle: e?.title, epicSource: e?.sourceFile, storyNumber: v.number,
        plannedStory: planned ? { id: planned.id, title: planned.title, body: planned.body } : undefined,
        title: v.title, role: v.role, want: v.want, benefit: v.benefit,
        acceptanceCriteria: v.acceptanceCriteria, tasks: v.tasks, devNotes: v.devNotes, references: v.references,
        storiesDir: ctx.storiesDir, template: v.template,
      };
      if (!v.title.trim() && !planned) { toast('Escribe al menos un título o elige una historia planificada', true); return; }
      btn.disabled = true;
      status.classList.remove('hidden');
      status.textContent = 'Leyendo la épica, el PRD y la arquitectura…';
      try {
        const { ctx: context, sources } = await buildAiContext({ task: 'draft-story', specDraft });
        status.textContent = sources.length ? `Usando: ${sources.join(' · ')}` : 'Redactando…';
        const r = await aiStream({ task: 'draft-story', context, onText: (full) => { status.textContent = `Redactando… ${full.length} caracteres`; } });
        const out = extractJson(r.text);
        if (out.title) F('title').value = out.title;
        if (out.role) F('role').value = out.role;
        if (out.want) F('want').value = out.want;
        if (out.benefit) F('benefit').value = String(out.benefit).replace(/\.$/, '');
        if (Array.isArray(out.acceptanceCriteria)) F('acceptanceCriteria').value = out.acceptanceCriteria.join('\n');
        if (out.tasks) F('tasks').value = Array.isArray(out.tasks) ? out.tasks.join('\n') : out.tasks;
        if (out.devNotes) F('devNotes').value = out.devNotes;
        if (Array.isArray(out.references)) F('references').value = out.references.join('\n');
        status.innerHTML = `✓ Borrador generado con IA. Revísalo antes de guardar. ${esc(usageLine(r.usage))}${sourcesHtml(sources)}`;
        schedule();
      } catch (err) {
        status.innerHTML = `<span class="hint err">${esc(err instanceof SyntaxError ? 'La IA no devolvió un JSON válido. Inténtalo de nuevo o prueba otro modelo.' : err.message)}</span>`;
      } finally { btn.disabled = false; }
    });
    $('#ai-review-btn').addEventListener('click', async () => {
      if (needKey() || !lastPreview) { if (!lastPreview) toast('Escribe la historia antes de revisarla', true); return; }
      const btn = $('#ai-review-btn');
      const box = $('#ai-review');
      btn.disabled = true;
      box.classList.remove('hidden');
      box.innerHTML = '<p class="muted">Revisando la historia…</p>';
      try {
        const { ctx: context, sources } = await buildAiContext({ task: 'review-story', specMarkdown: lastPreview.markdown });
        const r = await aiStream({ task: 'review-story', context, onText: (full) => { box.innerHTML = renderMd(full); } });
        box.innerHTML = renderMd(r.text) + `<p class="muted small-text">${esc(usageLine(r.usage))}</p>${sourcesHtml(sources)}`;
      } catch (err) { box.innerHTML = `<p class="hint err">${esc(err.message)}</p>`; }
      finally { btn.disabled = false; }
    });

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
        ${s && canEdit() && (s.hasFile || s.status === 'backlog') ? `<label class="field-inline small-text">Mover a <select id="story-status">${STATUSES.map((st) => `<option value="${st}" ${st === s.status ? 'selected' : ''}>${STATUS_LABEL[st]}</option>`).join('')}</select></label>` : ''}
      </div>
      <div class="muted mono" style="font-size:12px">${p ? esc(p.relativePath) : 'Sin archivo todavía (solo en planificación / sprint-status)'}</div>
      ${s?.sprintStatus || s?.fileStatus ? `<div class="tip">sprint-status: <b>${esc(s.sprintStatus || '—')}</b> · archivo: <b>${esc(s.fileStatus || '—')}</b>${p ? ` · modificado ${timeAgo(p.mtime)}` : ''}</div>` : ''}
      ${s?.warnings.length ? `<div class="alert warning" style="margin-top:10px"><span class="lvl">Aviso</span><span class="grow">${s.warnings.map(esc).join('<br>')}</span>${desyncFixHtml(s)}</div>` : ''}
      ${p?.userStory || planned?.userStory ? `<p style="margin-top:12px;font-style:italic;color:var(--ink-2)">${esc(p?.userStory || planned.userStory)}</p>` : ''}
      ${sugg.length ? `<div style="margin-top:14px">${sugg.map(suggestionCard).join('')}</div>` : ''}
      <div class="detail-grid">
        <div>
          <h3>Tareas ${tasks.length ? `<span class="muted">(${p.tasksDone}/${p.tasksTotal})</span>` : ''}</h3>
          ${tasks.length ? `<div class="bar" style="margin:6px 0 10px"><span style="width:${pct(p.tasksDone, p.tasksTotal)}%"></span></div>` + tasks.map((t, i) => `<div class="task ${t.done ? 'done' : ''}" style="padding-left:${t.level * 18}px">${canEdit() ? `<input type="checkbox" class="task-cb" data-ti="${i}" ${t.done ? 'checked' : ''} title="Marcar / desmarcar en el archivo" />` : `<span class="box">${t.done ? '☑' : '☐'}</span>`}<span>${t.reviewFollowUp ? '<span class="tag" style="color:var(--s-review)">AI-Review</span> ' : ''}${esc(t.text)}</span></div>`).join('') : '<div class="muted">Sin tareas definidas.</div>'}
        </div>
        <div>
          <h3>Criterios de aceptación</h3>
          ${acs.length ? `<ol style="padding-left:18px;font-size:13px">${acs.map((a) => `<li>${esc(a)}</li>`).join('')}</ol>` : '<div class="muted">Sin criterios.</div>'}
          ${p?.reviewOutcome ? `<h3 style="margin-top:12px">Revisión</h3><div>Resultado: <b>${esc(p.reviewOutcome)}</b> · ${p.pendingReviewItems} acción(es) pendientes</div>` : ''}
          ${p?.fileList?.length ? `<h3 style="margin-top:12px">Archivos tocados</h3><ul class="mono" style="font-size:12px;padding-left:18px">${p.fileList.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
        </div>
      </div>
      ${s && !readOnly() ? storyIntegrationHtml(id) : ''}
      <div class="actions">
        <button class="btn ai" id="ask-claude">✨ Preguntar al asistente sobre esta historia</button>
        ${!p && s && !readOnly() ? `<button class="btn primary" id="create-from">Crear especificación de esta historia</button>` : ''}
      </div>
      ${markdown ? `
        <div class="actions"><button class="btn small" id="toggle-raw">Ver markdown original</button><button class="btn small ghost" id="copy-raw">Copiar</button>${p ? `<button class="btn small ghost" data-copy="${esc(p.relativePath)}">Copiar ruta</button>` : ''}</div>
        <div class="md" id="md-render">${renderMd(markdown)}</div>
        <pre class="md hidden" id="md-raw" style="white-space:pre-wrap">${esc(markdown)}</pre>` : ''}`;

    bindCopy(body);
    body.querySelectorAll('[data-story]').forEach((b) => b.remove());
    $('#toggle-raw')?.addEventListener('click', () => { $('#md-render').classList.toggle('hidden'); $('#md-raw').classList.toggle('hidden'); });
    $('#copy-raw')?.addEventListener('click', () => copy(markdown));
    $('#story-status')?.addEventListener('change', async (e) => { e.target.disabled = true; if (await changeStoryStatus(id, e.target.value)) openStory(id); else e.target.disabled = false; });
    body.querySelectorAll('.task-cb').forEach((cb) => cb.addEventListener('change', async () => {
      body.querySelectorAll('.task-cb').forEach((x) => (x.disabled = true));
      await toggleTask(id, Number(cb.dataset.ti), cb.checked);
      openStory(id);
    }));
    bindFixButtons(body, () => openStory(id));
    $('#ask-claude')?.addEventListener('click', () => {
      closeModal();
      state.ai.focus = id;
      state.ai.prefill = `Explícame el estado de la historia ${id} y qué falta para terminarla. ¿Cuál es el siguiente comando BMAD que debo ejecutar?`;
      if (location.hash === '#asistente') render(); else location.hash = 'asistente';
    });
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

  // =====================================================================
  //  Asistente con Claude (API key de cada usuario, solo en su navegador)
  // =====================================================================
  const AI_PROVIDERS = {
    groq: {
      label: 'Groq (gratis)', keyPrefix: 'gsk_', keyName: 'bmad.groqKey', consoleUrl: 'https://console.groq.com/keys', consoleText: 'console.groq.com → API Keys',
      intro: 'Groq tiene un plan gratuito sin tarjeta de crédito, con límites de peticiones y tokens por minuto y por día. Usa modelos abiertos (p. ej. GPT-OSS 120B) muy rápidos.',
      defaultModels: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
    },
    claude: {
      label: 'Claude (de pago)', keyPrefix: 'sk-ant-', keyName: 'bmad.anthropicKey', consoleUrl: 'https://console.anthropic.com/settings/keys', consoleText: 'console.anthropic.com → Settings → API Keys',
      intro: 'La API de Claude se paga con créditos prepagados en tu cuenta de Anthropic (independiente de la suscripción a Claude.ai).',
      defaultModels: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'],
    },
  };
  const MODEL_LABELS = {
    'claude-sonnet-5-5': 'Claude Sonnet 5.5 (recomendado)', 'claude-opus-5-5': 'Claude Opus 5.5 (más capaz)', 'claude-haiku-5-5': 'Claude Haiku 5.5 (más rápido)',
    'openai/gpt-oss-120b': 'GPT-OSS 120B (recomendado)', 'openai/gpt-oss-20b': 'GPT-OSS 20B (más rápido)',
  };
  const aiProvider = () => (store.get('bmad.aiProvider', 'groq') === 'claude' ? 'claude' : 'groq');
  const aiKey = {
    get(provider = aiProvider()) {
      const n = AI_PROVIDERS[provider].keyName;
      try { return sessionStorage.getItem(n) || localStorage.getItem(n) || ''; } catch { return ''; }
    },
    set(k, remember, provider = aiProvider()) {
      const n = AI_PROVIDERS[provider].keyName;
      try {
        sessionStorage.removeItem(n); localStorage.removeItem(n);
        (remember ? localStorage : sessionStorage).setItem(n, k);
      } catch { /* sin storage */ }
    },
    clear(provider = aiProvider()) { const n = AI_PROVIDERS[provider].keyName; try { sessionStorage.removeItem(n); localStorage.removeItem(n); } catch { /* */ } },
    masked(k) { return k ? `${k.slice(0, 6)}…${k.slice(-4)}` : ''; },
  };
  const aiModels = (provider = aiProvider()) => store.get('bmad.aiModels.' + provider, AI_PROVIDERS[provider].defaultModels);
  const aiModel = (provider = aiProvider()) => {
    const saved = store.get('bmad.aiModel.' + provider, null);
    const list = aiModels(provider);
    return saved && list.includes(saved) ? saved : list[0];
  };

  /** Lee un archivo del proyecto (para dar contexto a Claude). */
  async function readProjectFile(rel) {
    const src = state.source;
    try {
      if (src.kind === 'browser') {
        const cached = src.files.get(rel)?.content;
        if (cached !== undefined) return cached;
        if (src.handle) return await (await (await getFileHandle(src.handle, rel, false)).getFile()).text();
        if (src.raw?.get(rel)) return await src.raw.get(rel).text();
        return null;
      }
      if (src.kind === 'local') return (await api('/api/local/story?' + q({ path: src.path, file: rel }))).markdown;
    } catch { /* no disponible */ }
    return null;
  }

  // ---------------- Contexto de documentación: búsqueda de secciones relevantes (BM25) ----------------
  const STOPWORDS = new Set(('de la que el en y a los del se las por un para con no una su al lo como mas pero sus le ya o este si porque esta entre cuando muy sin sobre tambien me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mi antes algunos unos yo otro otras otra el tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros mis tu te ti tus ellas cada debe deben debo puede pueden hace hacer hacerlo como que cual cuales segun ser son fue era sera estan esta estoy tiene tienen tener the and or of to in for on with is are be by as at from that this it its into should must can will how what which when where who why does do story stories historia historias proyecto sistema usuario dashboard bmad sobre explica explicame dime quiero necesito ahora luego despues favor hola gracias'.split(' ')));
  const BUDGET_DOCS = { groq: { chars: 7000, max: 5, always: 4000 }, claude: { chars: 36000, max: 14, always: 20000 } };

  function tokenize(text) {
    return (text || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
      .map((t) => (t.length > 5 && t.endsWith('es') ? t.slice(0, -2) : t.length > 4 && t.endsWith('s') ? t.slice(0, -1) : t));
  }

  /** Divide un markdown en secciones por encabezados (#, ##, ###), con el título del padre para dar contexto. */
  function splitDocSections(path, md) {
    const out = [];
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    let h2 = '', cur = { heading: 'Introducción', lines: [] }, inCode = false;
    const push = () => {
      const text = cur.lines.join('\n').trim();
      if (text.replace(/^#+.*$/gm, '').trim().length < 40) return;
      if (text.length <= 3000) out.push({ heading: cur.heading, text });
      else {
        // Secciones muy largas: trozos de ~2.000 caracteres por párrafos
        let chunk = '', part = 1;
        for (const para of text.split(/\n{2,}/)) {
          if (chunk && chunk.length + para.length > 2000) { out.push({ heading: `${cur.heading} (parte ${part++})`, text: chunk.trim() }); chunk = ''; }
          chunk += para + '\n\n';
        }
        if (chunk.trim()) out.push({ heading: part > 1 ? `${cur.heading} (parte ${part})` : cur.heading, text: chunk.trim() });
      }
    };
    for (const line of lines) {
      if (/^\s*```/.test(line)) inCode = !inCode;
      const m = !inCode && /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
      if (m) {
        push();
        const title = m[2].replace(/[*_`]/g, '');
        if (m[1].length === 1) { h2 = ''; cur = { heading: title, lines: [line] }; }
        else if (m[1].length === 2) { h2 = title; cur = { heading: title, lines: [line] }; }
        else cur = { heading: h2 ? `${h2} › ${title}` : title, lines: [line] };
      } else cur.lines.push(line);
    }
    push();
    const file = path.split('/').pop();
    return out.map((s) => ({ ...s, path, source: `${file}#${s.heading}` }));
  }

  /** Índice BM25 de las secciones de PRD/arquitectura/UX/épicas (se reconstruye solo si cambian los documentos). */
  async function docIndex() {
    const docs = state.data.planningDocs || [];
    const key = docs.map((d) => `${d.path}|${d.mtime}|${d.size}`).join(';');
    if (state.ai.index?.key === key) return state.ai.index;
    const always = [];
    const sections = [];
    for (const d of docs) {
      const content = await readProjectFile(d.path);
      if (!content) continue;
      if (d.kind === 'context' || d.kind === 'always') always.push({ path: d.path, content });
      else for (const s of splitDocSections(d.path, content)) sections.push({ ...s, kind: d.kind });
    }
    const df = new Map();
    let totalLen = 0;
    for (const s of sections) {
      const toks = [...tokenize(s.heading), ...tokenize(s.heading), ...tokenize(s.text)]; // el título cuenta doble
      s.tf = new Map();
      for (const t of toks) s.tf.set(t, (s.tf.get(t) || 0) + 1);
      s.len = toks.length;
      totalLen += s.len;
      for (const t of s.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    }
    state.ai.index = { key, always, sections, df, avgLen: sections.length ? totalLen / sections.length : 1 };
    return state.ai.index;
  }

  function bm25(index, query) {
    const q = [...new Set(tokenize(query))];
    const N = index.sections.length;
    return index.sections.map((s) => {
      let score = 0;
      for (const t of q) {
        const f = s.tf.get(t);
        if (!f) continue;
        const n = index.df.get(t) || 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += idf * ((f * 2.2) / (f + 1.2 * (1 - 0.75 + (0.75 * s.len) / index.avgLen)));
      }
      return { s, score };
    });
  }

  /**
   * Elige qué documentación enviar. mode: 'auto' | 'always' | 'never'.
   * En 'auto' una pregunta general no lleva documentos; una pregunta técnica, una historia o una redacción sí.
   */
  async function selectDocContext({ task, query, mode }) {
    if (mode === 'never' || state.source.kind === 'cloud') return { alwaysDocs: [], sections: [], sources: [] };
    const index = await docIndex();
    const budget = BUDGET_DOCS[aiProvider()];
    // Al redactar o revisar, la historia y su épica ya van en el formulario: epics.md solo añadiría ruido
    const isStoryTask = task !== 'chat';
    const scored = bm25(index, query)
      .filter((x) => x.score > 0 && !(isStoryTask && x.s.kind === 'epics'))
      .sort((a, b) => b.score - a.score);
    const top = scored[0]?.score || 0;
    const needsDocs = mode === 'always' || isStoryTask || top >= 2.5;
    const picked = [];
    let used = 0;
    const take = (s) => {
      if (picked.includes(s) || picked.length >= budget.max) return;
      if (used + s.text.length > budget.chars && picked.length) return;
      picked.push(s);
      used += s.text.length;
    };
    if (needsDocs) {
      // Para historias: la mejor sección de cada documento (PRD, arquitectura, UX) aunque puntúe menos
      if (isStoryTask) for (const kind of ['architecture', 'prd', 'ux']) { const best = scored.find((x) => x.s.kind === kind); if (best) take(best.s); }
      const minRel = mode === 'always' ? 0 : isStoryTask ? 0.2 : 0.3;
      for (const { s, score } of scored) {
        if (score < top * minRel) break;
        take(s);
      }
    }
    const alwaysDocs = index.always;
    return {
      alwaysDocs,
      sections: picked.map((s) => ({ source: s.source, content: s.text })),
      sources: [...alwaysDocs.map((d) => d.path.split('/').pop()), ...picked.map((s) => s.source)],
    };
  }

  const docsMode = () => store.get('bmad.aiDocsMode', 'auto');

  async function buildAiContext({ task = 'chat', query = '', focusId = null, specDraft = null, specMarkdown = null } = {}) {
    const d = state.data;
    const ctx = {
      project: {
        name: d.projectName, version: d.version, commandStyle: d.commandStyle, storiesDir: d.storiesDirRelative, sprintStatusFile: d.sprintStatusFile,
        communicationLanguage: d.config?.communication_language, documentLanguage: d.config?.document_output_language,
      },
      stats: { ...d.stats },
      epics: d.epics.map((e) => ({ number: e.number, title: e.title, status: e.status, progress: e.progress, description: e.description })),
      stories: d.stories.map((s) => ({ id: s.id, title: s.title, status: s.status, tasksDone: s.tasksDone, tasksTotal: s.tasksTotal, warnings: s.warnings, relativePath: s.relativePath })),
      suggestions: d.suggestions.map((s) => ({ priority: s.priority, title: s.title, steps: s.steps, reason: s.reason })),
      alerts: d.alerts.filter((a) => a.level !== 'info').map((a) => a.message),
    };
    let q = query;
    if (focusId) {
      const p = d.details?.[focusId];
      const md = p ? await readProjectFile(p.relativePath) : null;
      const planned = d.specContext?.plannedEpics.flatMap((e) => e.plannedStories).find((x) => x.id === focusId);
      const text = md || (planned ? `### Story ${planned.id}: ${planned.title}\n\n${planned.body}` : null);
      if (text) { ctx.focusStory = { id: focusId, markdown: text }; q += '\n' + text.slice(0, 1500); }
      const epic = d.epics.find((e) => String(e.number) === focusId.split('.')[0]);
      if (epic) q += '\n' + epic.title;
    }
    if (specDraft) {
      ctx.specDraft = specDraft;
      q += '\n' + [specDraft.title, specDraft.want, specDraft.benefit, specDraft.acceptanceCriteria, specDraft.epicTitle, specDraft.plannedStory?.title, specDraft.plannedStory?.body].filter(Boolean).join('\n');
    }
    if (specMarkdown) { ctx.specMarkdown = specMarkdown; q += '\n' + specMarkdown.slice(0, 3000); }
    const docs = await selectDocContext({ task, query: q, mode: docsMode() });
    ctx.alwaysDocs = docs.alwaysDocs;
    ctx.sections = docs.sections;
    return { ctx, sources: docs.sources };
  }

  /** Llama a /api/ai/chat y procesa el stream NDJSON. */
  async function aiStream({ task = 'chat', messages = [], context, onText, signal }) {
    const provider = aiProvider();
    const key = aiKey.get(provider);
    if (!key) throw Object.assign(new Error(`Configura tu API key de ${provider === 'groq' ? 'Groq' : 'Anthropic'} en la pestaña Asistente.`), { needsKey: true });
    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ai-key': key },
      body: JSON.stringify({ provider, task, model: aiModel(provider), messages, context }),
      signal,
    });
    if (!res.ok || !res.body) {
      const b = await res.json().catch(() => ({}));
      throw new Error(b.message || `Error ${res.status}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', text = '', done = null;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'text') { text += ev.text; onText?.(text, ev.text); }
        else if (ev.type === 'done') done = ev;
        else if (ev.type === 'error') throw Object.assign(new Error(ev.message), { status: ev.status, retryAfter: ev.retryAfter });
      }
    }
    return { text, usage: done?.usage, stopReason: done?.stopReason, model: done?.model };
  }

  function extractJson(text) {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    const raw = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    return JSON.parse(raw);
  }
  const sourcesHtml = (src) => (src?.length ? `<details class="ai-sources"><summary>📎 Contexto: ${src.length} fuente(s)</summary><ul>${src.map((x) => `<li class="mono">${esc(x)}</li>`).join('')}</ul></details>` : '<span class="ai-sources muted">📎 Sin documentos (solo estado del sprint)</span>');
  const usageLine = (u) => (u ? `${aiProvider() === 'groq' ? 'Groq' : 'Claude'} · ${u.input + u.cacheRead + u.cacheWrite} tokens de entrada${u.cacheRead ? ` (${u.cacheRead} desde caché)` : ''} · ${u.output} de salida` : '');

  function providerSelectHtml(id = 'ai-provider') {
    const cur = aiProvider();
    return `<select id="${id}" title="Proveedor de IA">${Object.entries(AI_PROVIDERS).map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${v.label}</option>`).join('')}</select>`;
  }
  function keySetupHtml() {
    const prov = aiProvider();
    const P = AI_PROVIDERS[prov];
    return `
      <div class="panel ai-setup">
        <div class="panel-head"><h2>✨ Conecta el asistente</h2><span class="spacer"></span>${providerSelectHtml('ai-provider-setup')}</div>
        <p class="muted small-text">${P.intro}</p>
        <p class="muted small-text">Tu API key se guarda solo en este navegador y se envía en cada petición al servidor del dashboard, que la reenvía a ${prov === 'groq' ? 'Groq' : 'Anthropic'} sin almacenarla.</p>
        <p class="small-text">Crea una key en <a href="${P.consoleUrl}" target="_blank" rel="noopener">${P.consoleUrl.replace('https://', '')}</a> (${P.consoleText}).</p>
        <form id="ai-key-form" class="account-row" style="margin-top:10px">
          <input type="password" id="ai-key-input" placeholder="${P.keyPrefix}…" autocomplete="off" spellcheck="false" style="max-width:420px" />
          <label class="toggle"><input type="checkbox" id="ai-key-remember" checked /> Recordar en este navegador</label>
          <button class="btn primary" type="submit">Guardar y verificar</button>
        </form>
        <div id="ai-key-hint" class="hint"></div>
      </div>`;
  }
  function bindKeySetup(onDone) {
    $('#ai-provider-setup')?.addEventListener('change', (e) => { store.set('bmad.aiProvider', e.target.value); onDone(); });
    $('#ai-key-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const prov = aiProvider();
      const P = AI_PROVIDERS[prov];
      const k = $('#ai-key-input').value.trim();
      if (!k.startsWith(P.keyPrefix)) return setHint('#ai-key-hint', `La key de ${prov === 'groq' ? 'Groq' : 'Anthropic'} debe empezar por "${P.keyPrefix}".`, 'err');
      setHint('#ai-key-hint', 'Verificando…');
      try {
        const r = await fetch('/api/ai/validate', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-ai-key': k }, body: JSON.stringify({ provider: prov }) });
        const b = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(b.message || `Error ${r.status}`);
        aiKey.set(k, $('#ai-key-remember').checked, prov);
        if (Array.isArray(b.models) && b.models.length) store.set('bmad.aiModels.' + prov, b.models);
        toast('API key verificada');
        onDone();
      } catch (err) { setHint('#ai-key-hint', err.message, 'err'); }
    });
  }

  // ---------------- Pestaña Asistente ----------------
  function renderAssistant(view, d) {
    const key = aiKey.get();
    if (!key) {
      view.innerHTML = keySetupHtml();
      bindKeySetup(() => renderAssistant(view, d));
      return;
    }
    const ai = state.ai;
    const prov = aiProvider();
    const model = aiModel(prov);
    const focus = ai.focus ? d.stories.find((s) => s.id === ai.focus) : null;
    const quick = [
      '¿Qué debería hacer ahora?',
      'Resume el estado del sprint en 5 líneas',
      '¿Qué riesgos o bloqueos ves?',
      'Prepara el plan para la siguiente historia del backlog',
      'Explica los hallazgos de revisión pendientes y cómo resolverlos',
    ];
    const canDocs = state.source.kind !== 'cloud';
    view.innerHTML = `
      <div class="ai-wrap">
        <div class="ai-toolbar">
          <h2>✨ Asistente</h2>
          ${providerSelectHtml()}
          <select id="ai-model">${aiModels(prov).map((v) => `<option value="${esc(v)}" ${v === model ? 'selected' : ''}>${esc(MODEL_LABELS[v] || v)}</option>`).join('')}</select>
          ${canDocs ? `<label class="field-inline small-text" title="Auto: solo envía las secciones de PRD/arquitectura/UX relevantes para cada pregunta (las preguntas generales no llevan documentos). Siempre: envía las secciones más relevantes aunque la pregunta sea general. Nunca: solo el estado del sprint.">Docs
            <select id="ai-docs-mode">${[['auto', 'Auto (secciones relevantes)'], ['always', 'Siempre'], ['never', 'Nunca']].map(([v, l]) => `<option value="${v}" ${docsMode() === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : '<span class="muted small-text">Vista guardada: sin documentos de planificación</span>'}
          <span class="spacer"></span>
          <span class="muted small-text" title="${d.config?.communication_language ? 'communication_language en ' + esc(d.config._file || 'la configuración BMAD') : 'El proyecto no define communication_language'}">🌐 ${d.config?.communication_language ? esc(d.config.communication_language) + ' (BMAD)' : 'Idioma del usuario'}</span>
          <button class="btn small ghost" id="ai-new">Nueva conversación</button>
          <span class="muted small-text" title="API key de ${prov === 'groq' ? 'Groq' : 'Anthropic'}">🔑 ${esc(aiKey.masked(key))}</span>
          <button class="btn small ghost" id="ai-key-clear">Quitar key</button>
        </div>
        <div class="ai-chat panel" id="ai-chat">
          <div id="ai-messages" class="ai-messages"></div>
          ${ai.convo.length ? '' : `<div class="ai-empty" id="ai-empty"><p class="muted">Pregunta lo que quieras sobre <b>${esc(d.projectName)}</b>. El asistente conoce el estado de todas las historias, las alertas y los comandos sugeridos${canDocs ? ', y puede leer el PRD y la arquitectura' : ''}.</p>
            <div class="chips">${quick.map((t) => `<button class="chip" data-quick="${esc(t)}">${esc(t)}</button>`).join('')}</div></div>`}
        </div>
        <form id="ai-form" class="ai-input">
          ${focus ? `<div class="ai-focus"><span class="tag">Historia ${esc(focus.id)}</span> ${esc(focus.title)} en contexto <button type="button" class="x" id="ai-unfocus" title="Quitar">×</button></div>` : ''}
          <div class="row">
            <textarea id="ai-text" rows="2" placeholder="Escribe tu pregunta… (Enter para enviar, Shift+Enter para nueva línea)"></textarea>
            <button class="btn primary" type="submit" id="ai-send">Enviar</button>
            <button class="btn hidden" type="button" id="ai-stop">Detener</button>
          </div>
          <div class="muted small-text" id="ai-usage"></div>
        </form>
      </div>`;

    const list = $('#ai-messages');
    const drawMessages = () => {
      list.innerHTML = ai.convo.map((m, i) => m.role === 'user'
        ? `<div class="msg user"><div class="bubble">${esc(m.content).replace(/\n/g, '<br>')}</div></div>`
        : `<div class="msg assistant"><div class="bubble md">${renderMd(m.content || '…')}</div>${m.content ? `<div class="msg-actions"><button class="btn small ghost" data-copymsg="${i}">Copiar</button>${sourcesHtml(m.sources)}</div>` : ''}</div>`).join('');
      list.querySelectorAll('[data-copymsg]').forEach((b) => b.addEventListener('click', () => copy(ai.convo[Number(b.dataset.copymsg)].content)));
      const chat = $('#ai-chat'); chat.scrollTop = chat.scrollHeight;
    };
    drawMessages();

    const text = $('#ai-text');
    if (ai.prefill) { text.value = ai.prefill; ai.prefill = ''; }
    text.focus();

    async function send(content) {
      if (!content.trim() || ai.streaming) return;
      $('#ai-empty')?.remove();
      ai.convo.push({ role: 'user', content });
      const reply = { role: 'assistant', content: '' };
      ai.convo.push(reply);
      drawMessages();
      text.value = '';
      const ctrl = new AbortController();
      ai.streaming = ctrl;
      $('#ai-send').classList.add('hidden'); $('#ai-stop').classList.remove('hidden');
      $('#ai-usage').textContent = 'Pensando…';
      try {
        const prevUser = ai.convo.filter((m) => m.role === 'user').slice(-2, -1)[0]?.content || '';
        const { ctx: context, sources } = await buildAiContext({ task: 'chat', query: `${content}\n${prevUser}`, focusId: ai.focus });
        reply.sources = sources;
        const history = ai.convo.slice(0, -1).map((m) => ({ role: m.role, content: m.content }));
        let last = 0;
        const r = await aiStream({
          task: 'chat', messages: history, context, signal: ctrl.signal,
          onText: (full) => {
            reply.content = full;
            if (Date.now() - last > 60) { last = Date.now(); const b = list.lastElementChild?.querySelector('.bubble'); if (b) { b.innerHTML = renderMd(full); const chat = $('#ai-chat'); chat.scrollTop = chat.scrollHeight; } }
          },
        });
        reply.content = r.text;
        $('#ai-usage').textContent = usageLine(r.usage) + (r.stopReason === 'max_tokens' ? ' · respuesta recortada por longitud' : '');
      } catch (err) {
        if (err.name === 'AbortError') { reply.content = (reply.content || '') + '\n\n_(detenido)_'; $('#ai-usage').textContent = 'Respuesta detenida'; }
        else {
          ai.convo.splice(ai.convo.indexOf(reply), 1);
          ai.convo.pop();
          text.value = content;
          $('#ai-usage').innerHTML = `<span class="hint err">${esc(err.message)}</span>`;
          if (/API key/i.test(err.message) && /inválida/i.test(err.message)) aiKey.clear();
        }
      } finally {
        ai.streaming = null;
        if ($('#ai-send')) { $('#ai-send').classList.remove('hidden'); $('#ai-stop').classList.add('hidden'); drawMessages(); }
      }
    }

    $('#ai-form').addEventListener('submit', (e) => { e.preventDefault(); send(text.value); });
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(text.value); } });
    $('#ai-stop').addEventListener('click', () => ai.streaming?.abort());
    view.querySelectorAll('[data-quick]').forEach((b) => b.addEventListener('click', () => send(b.dataset.quick)));
    $('#ai-model').addEventListener('change', (e) => store.set('bmad.aiModel.' + aiProvider(), e.target.value));
    $('#ai-provider').addEventListener('change', (e) => { store.set('bmad.aiProvider', e.target.value); renderAssistant(view, d); });
    $('#ai-docs-mode')?.addEventListener('change', (e) => store.set('bmad.aiDocsMode', e.target.value));
    $('#ai-new').addEventListener('click', () => { ai.streaming?.abort(); ai.convo = []; ai.focus = null; renderAssistant(view, d); });
    $('#ai-unfocus')?.addEventListener('click', () => { ai.focus = null; renderAssistant(view, d); });
    $('#ai-key-clear').addEventListener('click', () => { aiKey.clear(); toast('API key eliminada de este navegador'); renderAssistant(view, d); });
  }

  // =====================================================================
  //  1. Edición desde el dashboard: estados, tareas y desincronizaciones
  // =====================================================================
  const canEdit = () => !readOnly() && (state.source?.kind === 'local' || (state.source?.kind === 'browser' && !!state.source.handle));
  const STATUS_NORM = { draft: 'drafted', approved: 'ready-for-dev', ready: 'ready-for-dev', inprogress: 'in-progress', 'ready-for-review': 'review', 'in-review': 'review', completed: 'done', complete: 'done', todo: 'backlog' };
  function normStatus(raw) {
    const s = String(raw || '').toLowerCase().replace(/[*_`"']/g, '').trim().replace(/\s+/g, '-');
    return STATUSES.includes(s) ? s : STATUS_NORM[s] || STATUS_NORM[s.replace(/-/g, '')] || null;
  }
  async function readFresh(rel) {
    return (await (await getFileHandle(state.source.handle, rel, false)).getFile()).text();
  }

  /** Cambia el estado de una historia. scope: 'both' | 'sprint' (solo sprint-status) | 'file' (solo el archivo). */
  async function changeStoryStatus(id, status, scope = 'both') {
    const d = state.data;
    const s = d.stories.find((x) => x.id === id);
    if (!s || !canEdit()) return false;
    if (scope === 'both' && s.status === status && normStatus(s.fileStatus) === status) return false;
    if (!s.hasFile && status !== 'backlog') {
      toast(`La historia ${id} aún no tiene archivo: créala en "Nueva historia" antes de moverla.`, true);
      return false;
    }
    const t = state.tests?.byStory?.[id];
    if ((status === 'done' || status === 'review') && t?.failed && !window.confirm(`La historia ${id} tiene ${t.failed} prueba(s) fallando.\n¿Moverla a "${STATUS_LABEL[status]}" de todos modos?`)) return false;
    const g = state.gh?.byStory?.[id];
    if (status === 'done' && g?.prs?.some((p) => p.state === 'open') && !window.confirm(`La historia ${id} tiene un PR abierto sin fusionar.\n¿Marcarla como hecha de todos modos?`)) return false;
    try {
      if (state.source.kind === 'local') {
        await post('/api/local/story/status', { path: state.source.path, id, status, scope });
      } else {
        const root = state.source.handle;
        if (!(await ensurePermission(root, 'readwrite'))) throw new Error('Necesito permiso de escritura en la carpeta para cambiar el estado.');
        const body = { key: s.key, status };
        if (scope !== 'file' && s.sprintStatus !== undefined && d.sprintStatusFile) body.sprintStatus = await readFresh(d.sprintStatusFile);
        if (scope !== 'sprint' && s.hasFile && s.relativePath) body.storyFile = await readFresh(s.relativePath);
        const r = await post('/api/edit/status', body);
        if (r.sprintChanged) await writeText(root, d.sprintStatusFile, r.sprintStatus);
        if (r.storyChanged) await writeText(root, s.relativePath, r.storyFile);
      }
      await check();
      return true;
    } catch (err) { toast(err.message, true); return false; }
  }

  async function toggleTask(id, index, done) {
    const s = state.data.stories.find((x) => x.id === id);
    if (!s?.hasFile || !canEdit()) return;
    try {
      if (state.source.kind === 'local') await post('/api/local/story/task', { path: state.source.path, id, index, done });
      else {
        const root = state.source.handle;
        if (!(await ensurePermission(root, 'readwrite'))) throw new Error('Necesito permiso de escritura en la carpeta.');
        const r = await post('/api/edit/task', { storyFile: await readFresh(s.relativePath), index, done });
        if (r.changed) await writeText(root, s.relativePath, r.content);
      }
      await check();
    } catch (err) { toast(err.message, true); }
  }

  /** Botones para resolver una desincronización entre sprint-status y el archivo. */
  function desyncFixHtml(s) {
    if (!canEdit() || !s?.sprintStatus || !s?.fileStatus) return '';
    const sp = normStatus(s.sprintStatus), fi = normStatus(s.fileStatus);
    if (!sp || !fi || sp === fi) return '';
    return `<span class="fix-btns">
      <button class="btn small" data-fix="${esc(s.id)}" data-status="${sp}" data-scope="file" title="Escribe '${sp}' en el archivo de la historia">Usar "${esc(STATUS_LABEL[sp])}" (sprint-status)</button>
      <button class="btn small" data-fix="${esc(s.id)}" data-status="${fi}" data-scope="sprint" title="Escribe '${fi}' en sprint-status.yaml">Usar "${esc(STATUS_LABEL[fi])}" (archivo)</button></span>`;
  }
  function bindFixButtons(root, after) {
    root.querySelectorAll('[data-fix]').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      b.disabled = true;
      if (await changeStoryStatus(b.dataset.fix, b.dataset.status, b.dataset.scope)) after?.();
      b.disabled = false;
    }));
  }

  /** Arrastrar y soltar en el tablero. */
  function bindBoardDnD(board) {
    if (!canEdit()) return;
    board.querySelectorAll('.card[data-story]').forEach((c) => {
      c.draggable = true;
      c.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', c.dataset.story); e.dataTransfer.effectAllowed = 'move'; c.classList.add('dragging'); });
      c.addEventListener('dragend', () => c.classList.remove('dragging'));
    });
    board.querySelectorAll('.col[data-col]').forEach((col) => {
      col.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; col.classList.add('drop'); });
      col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drop'); });
      col.addEventListener('drop', (e) => {
        e.preventDefault();
        col.classList.remove('drop');
        const id = e.dataTransfer.getData('text/plain');
        if (id) changeStoryStatus(id, col.dataset.col);
      });
    });
  }

  // =====================================================================
  //  2. Métricas del sprint (eventos guardados en Supabase)
  // =====================================================================
  const DAY = 86400000;
  function fmtDur(ms) {
    if (ms == null || !isFinite(ms)) return '—';
    if (ms < 3600000) return `${Math.max(1, Math.round(ms / 60000))} min`;
    if (ms < 2 * DAY) return `${(ms / 3600000).toFixed(1)} h`;
    return `${(ms / DAY).toFixed(1)} días`;
  }
  const weekStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };

  function computeMetrics(events, stories) {
    const now = Date.now();
    const seqs = new Map();
    for (const e of events) {
      if (!seqs.has(e.story_id)) seqs.set(e.story_id, []);
      seqs.get(e.story_id).push({ status: e.to_status, at: Date.parse(e.occurred_at), kind: e.kind, title: e.story_title, epic: e.epic });
    }
    const statusTime = {};
    const cycles = [];
    const stuck = [];
    for (const [id, seq] of seqs) {
      seq.sort((a, b) => a.at - b.at);
      for (let i = 0; i < seq.length - 1; i++) {
        const st = seq[i].status;
        if (seq[i].kind === 'baseline' && i === 0) continue; // no sabemos cuándo entró en ese estado
        (statusTime[st] ||= []).push(seq[i + 1].at - seq[i].at);
      }
      const start = seq.find((x) => x.kind === 'change' && x.status === 'in-progress');
      const done = start && seq.find((x) => x.kind === 'change' && x.status === 'done' && x.at >= start.at);
      if (start && done) cycles.push({ id, title: seq[0].title, ms: done.at - start.at, doneAt: done.at });
      const last = seq[seq.length - 1];
      if (['in-progress', 'review'].includes(last.status) && last.kind === 'change' && now - last.at > 2 * DAY) stuck.push({ id, title: last.title, status: last.status, ms: now - last.at });
    }
    const doneEvents = events.filter((e) => e.kind === 'change' && e.to_status === 'done');
    const firstAt = events.length ? Date.parse(events[0].occurred_at) : now;
    const thisWeek = weekStart(now);
    const weeks = [];
    for (let i = 7; i >= 0; i--) {
      const ws = thisWeek - i * 7 * DAY;
      weeks.push({ start: ws, count: doneEvents.filter((e) => { const t = Date.parse(e.occurred_at); return t >= ws && t < ws + 7 * DAY; }).length, tracked: ws + 7 * DAY > firstAt });
    }
    // Ritmo: historias terminadas por semana en las últimas 4 semanas con datos
    const span = Math.min(4, Math.max(1, Math.ceil((now - firstAt) / (7 * DAY))));
    const recent = doneEvents.filter((e) => Date.parse(e.occurred_at) >= now - span * 7 * DAY).length;
    const rate = recent / span;
    const epics = new Map();
    for (const s of stories) {
      if (!epics.has(s.epic)) epics.set(s.epic, { epic: s.epic, pending: 0, total: 0 });
      const e = epics.get(s.epic);
      e.total++;
      if (s.status !== 'done') e.pending++;
    }
    const forecast = [...epics.values()].sort((a, b) => a.epic - b.epic).map((e) => ({ ...e, weeks: rate > 0 ? e.pending / rate : null }));
    let cum = 0;
    for (const f of forecast) { if (f.weeks != null) { cum += f.weeks; f.cumWeeks = cum; f.date = now + cum * 7 * DAY; } }
    const avg = (arr) => (arr?.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
    return {
      firstAt, rate, weeks, stuck: stuck.sort((a, b) => b.ms - a.ms), forecast,
      cycles: cycles.sort((a, b) => b.doneAt - a.doneAt),
      avgCycle: avg(cycles.map((c) => c.ms)),
      statusAvg: ['drafted', 'ready-for-dev', 'in-progress', 'review'].map((st) => ({ status: st, avg: avg(statusTime[st]), n: statusTime[st]?.length || 0 })),
      doneTotal: doneEvents.length,
    };
  }

  function throughputChart(weeks) {
    const W = 560, H = 180, L = 28, B = 26, T = 22;
    const max = Math.max(1, ...weeks.map((w) => w.count));
    const bw = (W - L) / weeks.length;
    const y = (v) => T + (1 - v / max) * (H - T - B);
    const fmt = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    return `<svg viewBox="0 0 ${W} ${H}" class="tp-chart" role="img" aria-label="Historias terminadas por semana">
      ${[0, Math.ceil(max / 2), max].map((t) => `<line class="grid-line" x1="${L}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text class="axis-label" x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join('')}
      ${weeks.map((w, i) => {
        const x = L + i * bw + bw * 0.2, h = H - B - y(w.count);
        return `<g><title>Semana del ${fmt(w.start)}: ${w.count} historia(s) terminada(s)${w.tracked ? '' : ' (sin datos)'}</title>
          ${w.count ? `<path d="M${x},${H - B} v${-(h - 4)} q0,-4 4,-4 h${bw * 0.6 - 8} q4,0 4,4 v${h - 4} z" fill="var(--c-done)"/>` : ''}
          <text class="axis-label" x="${x + bw * 0.3}" y="${H - 8}" text-anchor="middle">${fmt(w.start)}</text>
          ${w.count ? `<text class="end-label" x="${x + bw * 0.3}" y="${y(w.count) - 4}" text-anchor="middle">${w.count}</text>` : ''}</g>`;
      }).join('')}
    </svg>`;
  }

  async function renderMetrics(view, d) {
    const head = '<div class="panel-head"><h2>Métricas del sprint</h2><span class="muted">a partir de los cambios de estado registrados</span></div>';
    if (!state.sb) { view.innerHTML = head + '<div class="panel empty">Las métricas necesitan Supabase configurado en el servidor.</div>'; return; }
    if (!state.session) { view.innerHTML = head + '<div class="panel empty">Inicia sesión (pantalla de inicio → "Guarda tu historial en la nube") para registrar los cambios de estado y ver métricas.</div>'; return; }
    if (!state.cloudProjectId) { view.innerHTML = head + '<div class="panel empty">Sincronizando el proyecto con la nube…</div>'; setTimeout(() => currentTab() === 'metricas' && state.cloudProjectId && render(), 1500); return; }
    view.innerHTML = head + '<div class="loading">Calculando métricas…</div>';
    let events;
    try { events = await api(`/api/projects/${state.cloudProjectId}/events`); }
    catch (err) { view.innerHTML = head + `<div class="panel empty">${esc(err.message)}</div>`; return; }
    if (currentTab() !== 'metricas') return;
    const m = computeMetrics(events, d.stories);
    const changes = events.filter((e) => e.kind === 'change').length;
    const epicTitle = (n) => d.epics.find((e) => e.number === n)?.title || `Épica ${n}`;
    view.innerHTML = head + `
      <div class="tip" style="margin:-6px 0 14px">Datos desde ${new Date(m.firstAt).toLocaleDateString()} · ${changes} cambio(s) de estado registrados. Los cambios se registran cada vez que el dashboard sincroniza (proyecto abierto y sesión iniciada).</div>
      <div class="grid kpis">
        ${kpi('Terminadas (registradas)', m.doneTotal, 'pasaron a done mientras se medía')}
        ${kpi('Cycle time medio', fmtDur(m.avgCycle), 'de in-progress a done')}
        ${kpi('Ritmo', `${m.rate.toFixed(1)}/sem`, 'historias terminadas por semana')}
        ${kpi('Detenidas', m.stuck.length, 'más de 2 días en progreso o revisión')}
      </div>
      <div class="grid two" style="margin-top:16px">
        <div class="panel">
          <div class="panel-head"><h2>Historias terminadas por semana</h2></div>
          ${m.doneTotal ? throughputChart(m.weeks) : '<div class="empty">Aún no se ha registrado ninguna historia terminada.</div>'}
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Tiempo medio en cada estado</h2></div>
          <table class="trend-table"><tr><th>Estado</th><th>Tiempo medio</th><th>Muestras</th></tr>
          ${m.statusAvg.map((x) => `<tr><td>${pill(x.status)}</td><td>${fmtDur(x.avg)}</td><td>${x.n}</td></tr>`).join('')}</table>
          <p class="tip">Solo cuenta los tramos completos observados (no el estado inicial al empezar a medir).</p>
        </div>
      </div>
      <div class="grid two" style="margin-top:16px">
        <div class="panel">
          <div class="panel-head"><h2>Previsión por épica</h2><span class="muted">al ritmo actual, en orden de épicas</span></div>
          ${m.rate > 0 ? `<table class="trend-table"><tr><th>Épica</th><th>Pendientes</th><th>Semanas</th><th>Fecha estimada</th></tr>
            ${m.forecast.filter((f) => f.pending).map((f) => `<tr><td>${f.epic}. ${esc(epicTitle(f.epic))}</td><td>${f.pending}/${f.total}</td><td>${f.weeks.toFixed(1)}</td><td>${new Date(f.date).toLocaleDateString()}</td></tr>`).join('') || '<tr><td colspan="4">Todas las épicas terminadas 🎉</td></tr>'}</table>
            <p class="tip">Estimación lineal con el ritmo de las últimas semanas; tómala como orientación.</p>` : '<div class="empty">Se necesita al menos una historia terminada mientras se mide para estimar fechas.</div>'}
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Historias detenidas</h2></div>
          <div class="list">${m.stuck.length ? m.stuck.map((x) => `<div class="row-item" data-story="${esc(x.id)}"><span class="tag">${esc(x.id)}</span><div class="grow"><div class="title">${esc(x.title || '')}</div></div>${pill(x.status)}<span class="meta">${fmtDur(x.ms)}</span></div>`).join('') : '<div class="empty">Ninguna historia lleva más de 2 días en progreso o revisión.</div>'}</div>
          <div class="panel-head" style="margin-top:16px"><h2>Cycle time por historia</h2></div>
          ${m.cycles.length ? `<table class="trend-table"><tr><th>Historia</th><th>Cycle time</th><th>Terminada</th></tr>${m.cycles.slice(0, 15).map((c) => `<tr><td>${esc(c.id)} ${esc(c.title || '')}</td><td>${fmtDur(c.ms)}</td><td>${new Date(c.doneAt).toLocaleDateString()}</td></tr>`).join('')}</table>` : '<div class="empty">Aparecerá cuando una historia pase de in-progress a done mientras se mide.</div>'}
        </div>
      </div>`;
    bindCommon(view);
  }

  // =====================================================================
  //  3. GitHub: ramas y PRs vinculados a las historias
  // =====================================================================
  const projKey = () => state.source?.label || state.source?.path || state.source?.projectId || '';
  const ghToken = {
    get() { try { return sessionStorage.getItem('bmad.ghToken') || localStorage.getItem('bmad.ghToken') || ''; } catch { return ''; } },
    set(t, remember) { try { sessionStorage.removeItem('bmad.ghToken'); localStorage.removeItem('bmad.ghToken'); if (t) (remember ? localStorage : sessionStorage).setItem('bmad.ghToken', t); } catch { /* */ } },
  };
  function parseGitRemote(config) {
    if (!config) return null;
    const section = /\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/.exec(config)?.[1] ?? config;
    const m = /url\s*=\s*(?:https?:\/\/(?:[^@/\s]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\s*$/m.exec(section);
    return m ? `${m[1]}/${m[2]}` : null;
  }
  async function detectRepo() {
    const src = state.source;
    try {
      if (src.kind === 'browser' && src.handle) return parseGitRemote(await (await (await (await src.handle.getDirectoryHandle('.git')).getFileHandle('config')).getFile()).text());
      if (src.kind === 'local') return parseGitRemote((await api('/api/local/git?' + q({ path: src.path }))).config);
    } catch { /* sin .git */ }
    return null;
  }
  async function ghFetch(path) {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    const t = ghToken.get();
    if (t) headers.Authorization = `Bearer ${t}`;
    const res = await fetch(`https://api.github.com${path}`, { headers });
    if (res.ok) return res.json();
    if (res.status === 401) throw new Error('Token de GitHub inválido o caducado.');
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') throw new Error('Límite de la API de GitHub alcanzado. Añade un token para tener más cupo.');
    if (res.status === 404) throw new Error('Repositorio no encontrado. Si es privado, añade un token con permiso de lectura.');
    throw new Error(`GitHub respondió ${res.status}.`);
  }
  function storyRefMatch(s, text, isTitle = false) {
    const l = String(text || '').toLowerCase();
    if (!l) return false;
    const [e, n] = s.id.split('.');
    const slug = (s.key || '').toLowerCase();
    if (slug && slug.split('-').length > 2 && l.includes(slug)) return true;
    if (isTitle) return new RegExp(`(\\b(story|historia)\\s*#?\\s*${e}[.-]${n}\\b)|(^\\[?${e}\\.${n}[\\]:\\s])|(\\[${e}\\.${n}\\])`).test(l);
    if (/^(release|hotfix\/v|v\d)/.test(l)) return false;
    return new RegExp(`(^|[/_-])(story[-_]?)?${e}[-.]${n}([-_]|$)`).test(l.replace(/^.*\//, '/'));
  }
  function matchGitHub() {
    const gh = state.gh;
    if (!gh?.prs) return;
    gh.byStory = {};
    for (const s of state.data.stories) {
      const prs = gh.prs.filter((p) => storyRefMatch(s, p.head?.ref) || storyRefMatch(s, p.title, true)).map((p) => ({ number: p.number, title: p.title, url: p.html_url, branch: p.head?.ref, state: p.merged_at ? 'merged' : p.state, updated: p.updated_at }));
      const branches = gh.branches.filter((b) => storyRefMatch(s, b.name)).map((b) => b.name);
      if (prs.length || branches.length) gh.byStory[s.id] = { prs, branches };
    }
  }
  async function loadGitHub(force = false) {
    if (readOnly() || !state.data) return;
    const saved = store.get('bmad.gh.' + projKey(), {});
    state.gh = state.gh && state.gh.key === projKey() ? state.gh : { key: projKey(), repo: saved.repo || null, status: 'idle' };
    const gh = state.gh;
    if (!gh.repo && !gh.detected) { gh.detected = true; gh.repo = await detectRepo(); if (gh.repo) store.set('bmad.gh.' + projKey(), { repo: gh.repo }); }
    if (!gh.repo) { gh.status = 'norepo'; return; }
    if (!force && gh.fetchedAt && Date.now() - gh.fetchedAt < 5 * 60000) { matchGitHub(); return; }
    gh.status = 'loading';
    try {
      const [prs, branches] = await Promise.all([ghFetch(`/repos/${gh.repo}/pulls?state=all&per_page=100&sort=updated&direction=desc`), ghFetch(`/repos/${gh.repo}/branches?per_page=100`)]);
      Object.assign(gh, { prs, branches, status: 'ok', error: null, fetchedAt: Date.now() });
      matchGitHub();
    } catch (err) { Object.assign(gh, { status: 'error', error: err.message }); }
  }
  function gitAlerts() {
    const out = [];
    const gh = state.gh;
    if (gh?.status !== 'ok') return out;
    for (const s of state.data.stories) {
      const g = gh.byStory?.[s.id];
      const open = g?.prs.filter((p) => p.state === 'open') || [];
      const merged = g?.prs.filter((p) => p.state === 'merged') || [];
      if (s.status === 'done' && open.length) out.push({ level: 'warning', storyId: s.id, message: `${s.id}: está en done pero su PR #${open[0].number} sigue abierto.` });
      if (['backlog', 'drafted', 'ready-for-dev'].includes(s.status) && open.length) out.push({ level: 'warning', storyId: s.id, message: `${s.id}: hay un PR abierto (#${open[0].number}) pero la historia está en ${s.status}. Muévela a in-progress o review.` });
      if (merged.length && !open.length && s.status !== 'done') out.push({ level: 'warning', storyId: s.id, message: `${s.id}: el PR #${merged[0].number} ya está fusionado pero la historia sigue en ${s.status}.` });
      if (s.status === 'done' && !g) out.push({ level: 'info', storyId: s.id, message: `${s.id}: está en done y no se encontró ninguna rama ni PR asociado en ${gh.repo}.` });
    }
    return out;
  }

  // =====================================================================
  //  4. Resultados de pruebas por historia (JUnit / Surefire / Gradle / TRX)
  // =====================================================================
  function isTestReportPath(rel) {
    const p = rel.toLowerCase();
    if (p.includes('node_modules/')) return false;
    if (p.endsWith('.trx')) return true;
    if (!p.endsWith('.xml')) return false;
    return /(surefire|failsafe)-reports\/test-[^/]+\.xml$/.test(p) || /build\/test-results\/[^/]+\/[^/]+\.xml$/.test(p) || /(^|\/)(junit|test-results?|testresults)[^/]*\.xml$/.test(p) || /(^|\/)test-results\/[^/]+\.xml$/.test(p);
  }
  async function findReportsInHandle(root) {
    const out = [];
    const skip = ['node_modules', '.git', '_bmad', '.bmad-core', 'obj', '.gradle', '.idea', '.vs', '.vscode', 'bin'];
    async function walk(dir, prefix, depth) {
      if (depth > 7 || out.length >= 400) return;
      for await (const [name, h] of dir.entries()) {
        if (h.kind === 'directory') { if (!skip.includes(name)) await walk(h, prefix + name + '/', depth + 1); }
        else if (isTestReportPath(prefix + name)) out.push({ path: prefix + name, handle: h });
      }
    }
    await walk(root, '', 0);
    return out;
  }
  function parseTestReport(path, xml, mtime) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return [];
    const out = [];
    if (path.toLowerCase().endsWith('.trx') || doc.documentElement.localName === 'TestRun') {
      const defs = new Map();
      for (const ut of doc.getElementsByTagNameNS('*', 'UnitTest')) defs.set(ut.getAttribute('id'), ut.getElementsByTagNameNS('*', 'TestMethod')[0]?.getAttribute('className') || '');
      for (const r of doc.getElementsByTagNameNS('*', 'UnitTestResult')) {
        const o = (r.getAttribute('outcome') || '').toLowerCase();
        out.push({
          cls: (defs.get(r.getAttribute('testId')) || '').split(',')[0].trim(), file: '', name: r.getAttribute('testName') || '',
          status: o === 'passed' ? 'passed' : ['failed', 'error', 'timeout', 'aborted'].includes(o) ? 'failed' : 'skipped',
          message: (r.getElementsByTagNameNS('*', 'Message')[0]?.textContent || '').trim().split('\n')[0].slice(0, 300),
          report: path, at: Date.parse(r.getAttribute('endTime') || '') || mtime,
        });
      }
    } else {
      for (const tc of doc.getElementsByTagName('testcase')) {
        const suite = tc.parentElement;
        const fail = tc.getElementsByTagName('failure')[0] || tc.getElementsByTagName('error')[0];
        out.push({
          cls: tc.getAttribute('classname') || suite?.getAttribute('name') || '', file: tc.getAttribute('file') || suite?.getAttribute('file') || '', name: tc.getAttribute('name') || '',
          status: fail ? 'failed' : tc.getElementsByTagName('skipped')[0] ? 'skipped' : 'passed',
          message: fail ? (fail.getAttribute('message') || fail.textContent || '').trim().split('\n')[0].slice(0, 300) : '',
          report: path, at: Date.parse(suite?.getAttribute('timestamp') || '') || mtime,
        });
      }
    }
    return out;
  }
  const baseName = (p) => String(p || '').split(/[\\/]/).pop().replace(/\$.*$/, '').replace(/\.(test|spec|tests|it)\.[a-z]+$/i, '').replace(/\.[a-z0-9]+$/i, '').toLowerCase();
  function mapTestsToStories() {
    const t = state.tests;
    t.byStory = {};
    const all = [...t.reports.values()].flatMap((r) => r.tests);
    t.total = all.length;
    t.failed = all.filter((x) => x.status === 'failed').length;
    t.lastRun = all.reduce((m, x) => Math.max(m, x.at || 0), 0);
    for (const s of state.data.stories) {
      const files = state.data.details?.[s.id]?.fileList || [];
      if (!files.length) continue;
      const bases = new Set(files.map(baseName).filter((b) => b.length > 2));
      const match = (x) => {
        const simple = baseName(x.cls.split('.').pop()) || '';
        const fileBase = baseName(x.file);
        for (const b of bases) {
          if (simple === b || fileBase === b) return true;
          if (['test', 'tests', 'it', 'spec', 'integrationtest', 'integrationtests'].some((suf) => simple === b + suf)) return true;
        }
        return false;
      };
      const tests = all.filter(match);
      if (!tests.length) continue;
      t.byStory[s.id] = {
        total: tests.length, passed: tests.filter((x) => x.status === 'passed').length, failed: tests.filter((x) => x.status === 'failed').length,
        skipped: tests.filter((x) => x.status === 'skipped').length, lastRun: tests.reduce((m, x) => Math.max(m, x.at || 0), 0),
        failures: tests.filter((x) => x.status === 'failed').slice(0, 10),
      };
    }
  }
  async function loadTests() {
    if (readOnly() || !state.data) return;
    const src = state.source;
    state.tests = state.tests && state.tests.key === projKey() ? state.tests : { key: projKey(), reports: new Map() };
    const t = state.tests;
    try {
      const seen = new Set();
      if (src.kind === 'browser' && src.handle) {
        for (const f of await findReportsInHandle(src.handle)) {
          const file = await f.handle.getFile();
          seen.add(f.path);
          const prev = t.reports.get(f.path);
          if (prev && prev.mtime === file.lastModified) continue;
          t.reports.set(f.path, { mtime: file.lastModified, tests: parseTestReport(f.path, await file.text(), file.lastModified) });
        }
      } else if (src.kind === 'browser' && src.testFiles) {
        for (const f of src.testFiles) { seen.add(f.path); if (!t.reports.has(f.path)) t.reports.set(f.path, { mtime: f.file.lastModified, tests: parseTestReport(f.path, await f.file.text(), f.file.lastModified) }); }
      } else if (src.kind === 'local') {
        for (const r of await api('/api/local/tests?' + q({ path: src.path }))) { seen.add(r.path); t.reports.set(r.path, { mtime: r.mtime, tests: parseTestReport(r.path, r.content, r.mtime) }); }
      }
      for (const k of [...t.reports.keys()]) if (!seen.has(k)) t.reports.delete(k);
      t.status = 'ok';
      mapTestsToStories();
    } catch (err) { t.status = 'error'; t.error = err.message; }
  }
  function testAlerts() {
    const out = [];
    const t = state.tests;
    if (t?.status !== 'ok') return out;
    for (const s of state.data.stories) {
      const x = t.byStory?.[s.id];
      if (x?.failed && ['review', 'done'].includes(s.status)) out.push({ level: 'warning', storyId: s.id, message: `${s.id}: está en ${s.status} con ${x.failed} prueba(s) fallando.` });
      else if (x?.failed) out.push({ level: 'info', storyId: s.id, message: `${s.id}: ${x.failed} prueba(s) fallando (historia en ${s.status}).` });
    }
    return out;
  }

  // ---------------- Integraciones: carga, badges y paneles ----------------
  async function refreshIntegrations(force = false) {
    if (readOnly() || !state.data) return;
    await Promise.all([loadTests(), loadGitHub(force)]);
    if (['tablero', 'alertas', 'calidad', 'resumen'].includes(currentTab())) render(true);
    else $('#alert-count').textContent = alertCount(state.data) || '';
  }
  function extraAlerts() { return state.data ? [...gitAlerts(), ...testAlerts()] : []; }
  function alertCount(d) { return d.alerts.filter((a) => a.level !== 'info').length + extraAlerts().filter((a) => a.level !== 'info').length; }

  function integrationBadges(s) {
    const t = state.tests?.byStory?.[s.id];
    const g = state.gh?.byStory?.[s.id];
    let html = '';
    if (t) html += t.failed ? `<span class="ib fail" title="${t.failed} prueba(s) fallando de ${t.total}">✕ ${t.failed}</span>` : `<span class="ib ok" title="${t.passed} de ${t.total} pruebas pasan">✓ ${t.passed}</span>`;
    if (g?.prs?.length) {
      const p = g.prs[0];
      html += `<span class="ib pr ${p.state}" title="PR #${p.number} (${p.state}): ${esc(p.title)}">${p.state === 'merged' ? '✔' : p.state === 'open' ? '⇡' : '✕'} #${p.number}</span>`;
    } else if (g?.branches?.length) html += `<span class="ib br" title="Rama: ${esc(g.branches[0])}">⑂</span>`;
    return html;
  }

  function storyIntegrationHtml(id) {
    const t = state.tests?.byStory?.[id];
    const g = state.gh?.byStory?.[id];
    const gh = state.gh;
    let html = '<div class="detail-grid">';
    html += '<div><h3>GitHub</h3>';
    if (!gh || gh.status === 'norepo') html += '<div class="muted small-text">Sin repositorio de GitHub configurado (pestaña "Git y pruebas").</div>';
    else if (gh.status === 'error') html += `<div class="hint err">${esc(gh.error)}</div>`;
    else if (!g) html += `<div class="muted small-text">No hay ramas ni PRs que mencionen ${esc(id)} en ${esc(gh.repo)}.</div>`;
    else {
      html += g.prs.map((p) => `<div class="small-text"><span class="ib pr ${p.state}">${p.state}</span> <a href="${esc(p.url)}" target="_blank" rel="noopener">#${p.number} ${esc(p.title)}</a> <span class="mono muted">${esc(p.branch || '')}</span></div>`).join('');
      if (g.branches.length) html += `<div class="small-text muted" style="margin-top:4px">Ramas: ${g.branches.map((b) => `<span class="mono">${esc(b)}</span>`).join(', ')}</div>`;
    }
    html += '</div><div><h3>Pruebas</h3>';
    if (!t) html += `<div class="muted small-text">${state.tests?.total ? 'Ninguna prueba coincide con los archivos de la File List de esta historia.' : 'No se encontraron reportes de pruebas (JUnit/Surefire/Gradle/TRX) en el proyecto.'}</div>`;
    else {
      html += `<div class="small-text"><b class="${t.failed ? 'fail-text' : 'ok-text'}">${t.failed ? `${t.failed} fallando` : 'Todas pasan'}</b> · ${t.passed}/${t.total} pasan${t.skipped ? ` · ${t.skipped} omitidas` : ''} · ejecutadas ${timeAgo(t.lastRun)}</div>`;
      if (t.failures.length) html += `<ul class="small-text" style="padding-left:18px;margin:6px 0 0">${t.failures.map((f) => `<li><span class="mono">${esc((f.cls.split('.').pop() || '') + '.' + f.name)}</span>${f.message ? ` — <span class="muted">${esc(f.message)}</span>` : ''}</li>`).join('')}</ul>`;
    }
    return html + '</div></div>';
  }

  // ---------------- Pestaña "Git y pruebas" ----------------
  async function renderQuality(view, d) {
    if (readOnly()) { view.innerHTML = '<div class="panel empty">Abre la carpeta del proyecto para ver GitHub y las pruebas.</div>'; return; }
    const gh = state.gh || {};
    const t = state.tests || {};
    const token = ghToken.get();
    view.innerHTML = `
      <div class="grid two">
        <div class="panel">
          <div class="panel-head"><h2>GitHub</h2><span class="spacer"></span><button class="btn small ghost" id="gh-refresh">⟳ Actualizar</button></div>
          <form id="gh-form" class="form-grid">
            <div><label>Repositorio (owner/repo)</label><input type="text" id="gh-repo" value="${esc(gh.repo || '')}" placeholder="usuario/mi-proyecto" /><div class="help">${gh.detected && gh.repo ? 'Detectado desde .git/config' : 'Se detecta desde .git/config si existe'}</div></div>
            <div><label>Token (opcional, para repos privados)</label><input type="password" id="gh-token" placeholder="${token ? 'Token guardado — escribe para reemplazarlo' : 'github_pat_…'}" autocomplete="off" />
              <div class="help">Token de solo lectura (Contents y Pull requests: Read). Se guarda solo en este navegador.</div></div>
            <div class="full actions" style="margin-top:0"><button class="btn primary" type="submit">Guardar y cargar</button>${token ? '<button class="btn ghost" type="button" id="gh-token-clear">Quitar token</button>' : ''}</div>
          </form>
          <div class="tip">${gh.status === 'ok' ? `✓ ${gh.prs.length} PRs y ${gh.branches.length} ramas leídos de ${esc(gh.repo)} ${timeAgo(gh.fetchedAt)}.` : gh.status === 'error' ? `<span class="hint err">${esc(gh.error)}</span>` : gh.status === 'loading' ? 'Cargando…' : 'Sin repositorio configurado.'}</div>
          <p class="tip">Una rama o PR se vincula a una historia si su nombre contiene la clave (<code>1-3-login-con-jwt</code>) o el id (<code>story-1.3</code>, <code>feature/1-3-…</code>), o si el título del PR la menciona (<code>[1.3]</code>, <code>Story 1.3</code>).</p>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Pruebas</h2><span class="spacer"></span><button class="btn small ghost" id="tests-refresh">⟳ Releer reportes</button></div>
          ${t.status === 'error' ? `<div class="hint err">${esc(t.error)}</div>` : t.reports?.size ? `
            <div class="grid kpis">${kpi('Pruebas', t.total, `${t.reports.size} reporte(s)`)}${kpi('Fallando', t.failed, t.failed ? 'revisa las historias afectadas' : 'todo en verde')}${kpi('Última ejecución', t.lastRun ? timeAgo(t.lastRun) : '—', '')}</div>
            <p class="tip">Las pruebas se asocian a una historia comparando las clases de prueba con los archivos de su <i>File List</i> (p. ej. <code>LoginService.java</code> ↔ <code>LoginServiceTest</code>).</p>`
            : `<div class="empty">No se encontraron reportes. El dashboard lee:<br><code>target/surefire-reports/TEST-*.xml</code> · <code>target/failsafe-reports</code> (Maven) · <code>build/test-results/**/*.xml</code> (Gradle) · <code>*.trx</code> (.NET, <code>dotnet test --logger trx</code>) · <code>junit*.xml</code></div>`}
        </div>
      </div>
      <div class="panel" style="margin-top:16px">
        <div class="panel-head"><h2>Historias</h2><span class="muted">estado, GitHub y pruebas</span></div>
        <table class="trend-table q-table"><tr><th>Historia</th><th>Estado</th><th>GitHub</th><th>Pruebas</th></tr>
        ${d.stories.filter((s) => s.status !== 'backlog').map((s) => {
          const g = state.gh?.byStory?.[s.id]; const x = state.tests?.byStory?.[s.id];
          return `<tr data-story="${esc(s.id)}" class="clickable"><td><b>${esc(s.id)}</b> ${esc(s.title)}</td><td>${pill(s.status)}</td>
            <td>${g?.prs?.length ? g.prs.map((p) => `<span class="ib pr ${p.state}">#${p.number} ${p.state}</span>`).join(' ') : g?.branches?.length ? `<span class="mono small-text">${esc(g.branches[0])}</span>` : '<span class="muted">—</span>'}</td>
            <td>${x ? (x.failed ? `<span class="ib fail">✕ ${x.failed} de ${x.total}</span>` : `<span class="ib ok">✓ ${x.passed}/${x.total}</span>`) : '<span class="muted">—</span>'}</td></tr>`;
        }).join('')}</table>
      </div>`;
    bindCommon(view);
    $('#gh-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const repo = $('#gh-repo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
      if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) return toast('El repositorio debe tener el formato owner/repo', true);
      const tok = $('#gh-token').value.trim();
      if (tok) ghToken.set(tok, true);
      store.set('bmad.gh.' + projKey(), { repo });
      state.gh = { key: projKey(), repo: repo || null, status: 'idle', detected: true };
      await loadGitHub(true);
      renderQuality(view, d);
      if (state.gh.status === 'ok') toast('GitHub conectado');
    });
    $('#gh-token-clear')?.addEventListener('click', () => { ghToken.set(''); toast('Token eliminado'); renderQuality(view, d); });
    $('#gh-refresh').addEventListener('click', async () => { await loadGitHub(true); renderQuality(view, d); });
    $('#tests-refresh').addEventListener('click', async () => { await loadTests(); renderQuality(view, d); toast('Reportes de pruebas releídos'); });
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
