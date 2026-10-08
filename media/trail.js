// HariTrail Trail Map webview.
// Plain JS, no dependencies. All text is inserted with textContent (never innerHTML).
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const NS = 'http://www.w3.org/2000/svg';
  const saved = vscode.getState() || {};

  const state = {
    payload: null,
    hasSession: true,
    follow: true,
    view: saved.view === 'lanes' ? 'lanes' : 'map',
    cursor: -1,
    atLive: true,
    playing: false,
    playTimer: null,
    speed: saved.speed || 1,
    sync: !!saved.sync,
    selected: null,
    highlight: null, // Set of step ids from an insight / phase
    insightIdx: -1,
    vb: null, // map viewBox {x,y,w,h}
    userMoved: false,
    layout: null,
    lastScopeKey: '',
    newCount: 0,
    received: false,
  };

  function persist() {
    vscode.setState({ view: state.view, speed: state.speed, sync: state.sync });
  }

  // ------------------------------------------------------------------ helpers

  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    appendAll(el, children);
    return el;
  }

  function s(tag, attrs, children) {
    const el = document.createElementNS(NS, tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v === undefined || v === null || v === false) continue;
        if (k === 'text') el.textContent = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, String(v));
      }
    }
    appendAll(el, children);
    return el;
  }

  function appendAll(el, children) {
    if (children === undefined || children === null) return;
    if (!Array.isArray(children)) children = [children];
    for (const c of children) {
      if (c === undefined || c === null || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function oneLine(t, max) {
    const x = String(t || '').replace(/\s+/g, ' ').trim();
    return x.length > max ? x.slice(0, Math.max(1, max - 3)).trimEnd() + '...' : x;
  }

  function fmtDur(ms) {
    if (!isFinite(ms) || ms < 0) return '';
    if (ms < 1000) return Math.round(ms) + 'ms';
    const sec = ms / 1000;
    if (sec < 60) return (sec < 10 ? sec.toFixed(1) : Math.round(sec)) + 's';
    const m = Math.floor(sec / 60);
    if (m < 60) return m + 'm ' + Math.round(sec % 60) + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  const KIND_VAR = {
    read: '--k-read',
    edit: '--k-edit',
    create: '--k-create',
    search: '--k-search',
    web: '--k-search',
    run: '--k-run',
    test: '--k-run',
    build: '--k-run',
    git: '--k-run',
    install: '--k-run',
    delegate: '--k-delegate',
    mcp: '--k-delegate',
    skill: '--k-delegate',
    plan: '--k-plan',
    ask: '--k-you',
    other: '--k-plan',
  };
  const STATION = {
    'station:terminal': { v: '--k-run', g: '>_' },
    'station:search': { v: '--k-search', g: '?' },
    'station:web': { v: '--k-search', g: 'W' },
    'station:agents': { v: '--k-delegate', g: 'A' },
    'station:plan': { v: '--k-plan', g: 'P' },
    'station:tools': { v: '--k-delegate', g: 'T' },
    'station:you': { v: '--k-you', g: '@' },
  };
  const STATUS_VAR = { created: '--k-create', edited: '--k-edit', read: '--k-read', touched: '--k-plan' };
  const PHASE_VAR = { explore: '--k-read', change: '--k-edit', verify: '--k-run', other: '--k-plan' };
  const PHASE_NAME = { explore: 'Explore', change: 'Change', verify: 'Verify', other: 'Other' };

  function kindColor(kind) {
    return 'var(' + (KIND_VAR[kind] || '--k-plan') + ')';
  }

  function nodeColor(n) {
    if (n.kind === 'station') return 'var(' + ((STATION[n.id] && STATION[n.id].v) || '--k-plan') + ')';
    return 'var(' + (STATUS_VAR[n.status] || '--k-plan') + ')';
  }

  function stepColor(st) {
    if (st.status === 'error' || st.outcome === 'fail') return 'var(--k-error)';
    if (st.outcome === 'pass') return 'var(--k-create)';
    return kindColor(st.kind);
  }

  const ICONS = {
    fit: 'M2 2h4v1.2H3.2V6H2V2zm8 0h4v4h-1.2V3.2H10V2zM2 10h1.2v2.8H6V14H2v-4zm10.8 0H14v4h-4v-1.2h2.8V10z',
    plus: 'M7.4 2h1.2v5.4H14v1.2H8.6V14H7.4V8.6H2V7.4h5.4z',
    minus: 'M2 7.4h12v1.2H2z',
    play: 'M4 2.5v11l9-5.5z',
    pause: 'M4 2.5h3v11H4zm5 0h3v11H9z',
    first: 'M3 2.5h1.4v11H3zm2.4 5.5L13 2.5v11z',
    last: 'M11.6 2.5H13v11h-1.4zM3 2.5L10.6 8 3 13.5z',
    prev: 'M11 2.5v11L4 8z',
    next: 'M5 2.5v11L12 8z',
    side: 'M2 2.5h12v11H2zm1.2 1.2v8.6h6.6V3.7zm7.8 0v8.6h1.8V3.7z',
  };

  function icon(name) {
    return s('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' }, s('path', { d: ICONS[name] }));
  }

  function iconBtn(name, title, onclick) {
    const b = h('button', { class: 'icon-btn', title: title, 'aria-label': title, onclick: onclick });
    b.appendChild(icon(name));
    return b;
  }

  // ------------------------------------------------------------------ skeleton

  const app = document.getElementById('app');
  const els = {};

  function build() {
    els.title = h('div', { class: 'title' });
    els.live = h('span', { class: 'live', text: 'live' });
    els.scope = h('select', {
      title: 'Which prompt to show',
      onchange: function () {
        vscode.postMessage({ type: 'scope', scope: els.scope.value });
      },
    });
    els.mapBtn = h('button', { text: 'Map', title: 'Map of your codebase (M)', onclick: () => setView('map') });
    els.lanesBtn = h('button', { text: 'Lanes', title: 'Moves over time, one lane per file (L)', onclick: () => setView('lanes') });
    els.sideBtn = iconBtn('side', 'Toggle details panel', () => {
      els.main.classList.toggle('no-side');
      setTimeout(renderStage, 0);
    });
    const exportBtn = h('button', { class: 'btn', text: 'Export report', title: 'Markdown report of this journey', onclick: () => vscode.postMessage({ type: 'export' }) });
    const bar = h('div', { class: 'bar' }, [els.title, els.live, els.scope, h('div', { class: 'seg' }, [els.mapBtn, els.lanesBtn]), exportBtn, els.sideBtn]);

    els.stats = h('div', { class: 'stats' });
    els.ribbon = h('div', { class: 'ribbon', title: 'The shape of the work: Explore, then Change, then Verify' });

    els.stage = h('div', { class: 'stage' });
    els.side = h('div', { class: 'side' });
    els.main = h('div', { class: 'main' }, [els.stage, els.side]);

    els.slider = h('input', {
      type: 'range',
      min: 0,
      max: 0,
      value: 0,
      'aria-label': 'Replay position',
      oninput: function () {
        stop();
        setCursor(parseInt(els.slider.value, 10), true);
      },
    });
    els.playBtn = iconBtn('play', 'Replay (Space)', togglePlay);
    els.pos = h('span', { class: 'pos' });
    els.speed = h('select', {
      title: 'Replay speed',
      onchange: function () {
        state.speed = parseFloat(els.speed.value);
        persist();
      },
    });
    for (const v of [0.5, 1, 2, 4, 8]) {
      els.speed.appendChild(h('option', { value: v, text: v + '×', selected: v === state.speed }));
    }
    els.syncBox = h('input', {
      type: 'checkbox',
      checked: state.sync,
      onchange: function () {
        state.sync = els.syncBox.checked;
        persist();
      },
    });
    const replay = h('div', { class: 'replay' }, [
      iconBtn('first', 'First move (Home)', () => {
        stop();
        setCursor(0, true);
      }),
      iconBtn('prev', 'Previous move (Left arrow)', () => {
        stop();
        setCursor(state.cursor - 1, true);
      }),
      els.playBtn,
      iconBtn('next', 'Next move (Right arrow)', () => {
        stop();
        setCursor(state.cursor + 1, true);
      }),
      iconBtn('last', 'Latest move (End)', () => {
        stop();
        goLive();
      }),
      els.slider,
      els.pos,
      els.speed,
      h('label', { title: 'Open each file in the editor as the replay passes it' }, [els.syncBox, 'Sync editor']),
    ]);

    els.tip = h('div', { class: 'tip', role: 'tooltip' });
    appendAll(app, [bar, els.stats, els.ribbon, els.main, replay]);
    document.body.appendChild(els.tip);
    setView(state.view, true);
  }

  // ------------------------------------------------------------------ data in

  window.addEventListener('message', function (ev) {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'data') onData(msg);
    else if (msg.type === 'select') selectById(msg.id);
  });

  let pendingSelect = null;

  function onData(msg) {
    const p = msg.payload;
    state.hasSession = msg.hasSession;
    state.follow = msg.follow;
    const prev = state.payload;
    const scopeKey = p.scope + '|' + p.sessionTitle + '|' + (p.expeditions[0] ? p.expeditions[0].id : '');
    const n = p.steps.length;
    if (!prev || scopeKey !== state.lastScopeKey) {
      state.lastScopeKey = scopeKey;
      state.cursor = n - 1;
      state.atLive = true;
      state.selected = null;
      state.highlight = null;
      state.insightIdx = -1;
      state.userMoved = false;
      state.newCount = 0;
      stop();
    } else if (state.atLive && !state.playing) {
      state.cursor = n - 1;
    } else if (n > prev.steps.length) {
      state.newCount += n - prev.steps.length;
    }
    if (state.cursor > n - 1) state.cursor = n - 1;
    state.payload = p;
    state.received = true;
    renderAll();
    if (pendingSelect) {
      const id = pendingSelect;
      pendingSelect = null;
      selectById(id);
    }
  }

  function selectById(id) {
    const p = state.payload;
    if (!p) {
      pendingSelect = id;
      return;
    }
    const st = p.steps.find((x) => x.id === id);
    if (!st) {
      pendingSelect = id;
      return;
    }
    if (st.index > state.cursor) setCursor(st.index, false);
    state.selected = st.id;
    renderAll();
  }

  // ------------------------------------------------------------------ cursor / replay

  function steps() {
    return state.payload ? state.payload.steps : [];
  }

  function setCursor(i, select) {
    const n = steps().length;
    if (!n) return;
    i = Math.max(0, Math.min(n - 1, i));
    state.cursor = i;
    state.atLive = i === n - 1;
    if (state.atLive) state.newCount = 0;
    if (select) {
      state.selected = steps()[i].id;
      if (state.sync) {
        const st = steps()[i];
        if (st.hasFile) vscode.postMessage({ type: 'replayStep', id: st.id });
      }
    }
    renderAll();
  }

  function goLive() {
    const n = steps().length;
    state.newCount = 0;
    state.atLive = true;
    state.cursor = n - 1;
    state.selected = null;
    renderAll();
  }

  function togglePlay() {
    if (state.playing) {
      stop();
      renderReplay();
      return;
    }
    const n = steps().length;
    if (!n) return;
    if (state.cursor >= n - 1) state.cursor = -1;
    state.playing = true;
    state.atLive = false;
    tick();
  }

  function tick() {
    if (!state.playing) return;
    const n = steps().length;
    if (state.cursor >= n - 1) {
      stop();
      renderAll();
      return;
    }
    setCursor(state.cursor + 1, true);
    state.playTimer = setTimeout(tick, 900 / state.speed);
  }

  function stop() {
    state.playing = false;
    if (state.playTimer) clearTimeout(state.playTimer);
    state.playTimer = null;
  }

  function setView(v, quiet) {
    state.view = v;
    els.mapBtn.classList.toggle('on', v === 'map');
    els.lanesBtn.classList.toggle('on', v === 'lanes');
    persist();
    if (!quiet) renderStage();
  }

  // ------------------------------------------------------------------ render

  function renderAll() {
    renderHeader();
    renderStats();
    renderRibbon();
    renderStage();
    renderSide();
    renderReplay();
  }

  function renderHeader() {
    const p = state.payload;
    clear(els.title);
    if (!p) return;
    const exp = p.expeditions.find((e) => e.id === p.scope);
    if (p.scope === 'session') {
      els.title.appendChild(h('span', { class: 'prompt', text: oneLine(p.sessionTitle, 90) }));
      els.title.appendChild(h('span', { class: 'num', text: p.expeditions.length + ' prompts' }));
    } else if (exp) {
      els.title.appendChild(h('span', { class: 'num', text: '#' + exp.index }));
      els.title.appendChild(h('span', { class: 'prompt', text: oneLine(p.prompt || exp.prompt, 140), title: p.prompt || '' }));
    } else {
      els.title.appendChild(h('span', { class: 'prompt', text: 'Trail Map' }));
    }
    els.live.classList.toggle('on', !!p.live);

    clear(els.scope);
    els.scope.appendChild(h('option', { value: 'follow', text: 'Follow latest prompt', selected: state.follow }));
    els.scope.appendChild(h('option', { value: 'session', text: 'Whole session', selected: !state.follow && p.scope === 'session' }));
    for (let i = p.expeditions.length - 1; i >= 0; i--) {
      const e = p.expeditions[i];
      els.scope.appendChild(
        h('option', {
          value: e.id,
          text: '#' + e.index + ' ' + oneLine(e.prompt, 60) + (e.live ? '  ●' : ''),
          selected: !state.follow && p.scope === e.id,
        }),
      );
    }
  }

  function stat(value, label, color, title) {
    const el = h('span', { class: 'stat', title: title || '' });
    if (color) {
      const d = h('span', { class: 'dot' });
      d.style.background = color;
      el.appendChild(d);
    }
    el.appendChild(h('b', { text: String(value) }));
    el.appendChild(document.createTextNode(label));
    return el;
  }

  function renderStats() {
    const p = state.payload;
    clear(els.stats);
    if (!p) return;
    const st = p.stats;
    appendAll(els.stats, [
      stat(st.steps, st.steps === 1 ? 'move' : 'moves', null, st.subagentSteps ? '+' + st.subagentSteps + ' by subagents' : ''),
      stat(st.filesRead, 'read', 'var(--k-read)', 'Files only read'),
      stat(st.filesEdited, 'edited', 'var(--k-edit)', 'Existing files changed'),
      stat(st.filesCreated, 'created', 'var(--k-create)', 'New files'),
      stat(st.commands, st.commands === 1 ? 'command' : 'commands', 'var(--k-run)'),
      st.testsPassed + st.testsFailed ? stat(st.testsPassed + '✓ ' + st.testsFailed + '✗', ' tests', null, 'Test runs that looked passing / failing') : null,
      st.loopBacks ? stat(st.loopBacks, st.loopBacks === 1 ? ' fix loop' : ' fix loops', 'var(--k-error)', 'Changes made right after a failing check') : null,
      st.linesAdded + st.linesRemoved ? stat('+' + st.linesAdded + ' -' + st.linesRemoved, ' lines') : null,
      stat(fmtDur(st.durationMs) || '0s', '', null, 'Time from prompt to last move'),
      p.source ? h('span', { class: 'stat', title: 'Where this prompt was sent from', text: 'from the ' + p.source }) : null,
      st.outputTokens ? stat(st.outputTokens.toLocaleString(), ' output tokens') : null,
    ]);
  }

  function renderRibbon() {
    const p = state.payload;
    clear(els.ribbon);
    if (!p || !p.steps.length) return;
    const n = p.steps.length;
    const w = els.ribbon.clientWidth || 800;
    for (const run of p.phases) {
      const count = run.to - run.from + 1;
      const el = h('div', {
        class: 'run ' + run.phase + (run.from > state.cursor ? ' future' : ''),
        title: PHASE_NAME[run.phase] + ': moves #' + p.steps[run.from].label + ' to #' + p.steps[run.to].label,
        onclick: () => {
          const ids = new Set();
          for (let i = run.from; i <= run.to; i++) ids.add(p.steps[i].id);
          state.highlight = ids;
          state.insightIdx = -1;
          stop();
          setCursor(Math.max(state.cursor, run.to), false);
          state.selected = p.steps[run.from].id;
          renderAll();
        },
      });
      el.style.flex = count + ' 0 0';
      if ((count / n) * w > 64) el.appendChild(h('span', { text: PHASE_NAME[run.phase] + ' ' + count }));
      els.ribbon.appendChild(el);
    }
    const cur = h('div', { class: 'cursor' });
    cur.style.left = ((state.cursor + 1) / n) * 100 + '%';
    els.ribbon.appendChild(cur);
  }

  function renderStage() {
    clear(els.stage);
    hideTip();
    const p = state.payload;
    if (!state.received) return;
    if (!state.hasSession) {
      els.stage.appendChild(
        h('div', { class: 'empty' }, [
          h('h2', { text: 'No Claude Code session for this workspace yet' }),
          h('div', {}, ['Send a prompt from the Claude Code chat panel, or run ', h('code', { text: 'claude' }), ' in a terminal in this folder.']),
          h('div', { text: 'The map fills in live as Claude reads, edits and runs things.' }),
        ]),
      );
      return;
    }
    if (!p || !p.steps.length) {
      els.stage.appendChild(
        h('div', { class: 'empty' }, [
          h('h2', { text: p && p.live ? 'Claude is thinking...' : 'No moves in this prompt' }),
          h('div', { text: p && p.live ? 'Its first move will appear here as soon as it happens.' : 'Claude answered without touching files or running commands.' }),
        ]),
      );
      return;
    }
    if (state.view === 'map') renderMap();
    else renderLanes();
    const pill = h('button', {
      class: 'newpill' + (state.newCount > 0 ? ' on' : ''),
      text: '● ' + state.newCount + ' new move' + (state.newCount === 1 ? '' : 's') + ', jump to live',
      onclick: () => {
        stop();
        goLive();
      },
    });
    els.stage.appendChild(pill);
  }

  // ------------------------------------------------------------------ map

  function computeLayout(p) {
    const files = p.nodes.filter((n) => n.kind === 'file');
    const stations = p.nodes.filter((n) => n.kind === 'station');
    const pos = new Map();
    // Stations: a small hub in the middle.
    const hubR = stations.length <= 1 ? 0 : 34 + stations.length * 6;
    stations
      .slice()
      .sort((a, b) => a.firstIndex - b.firstIndex)
      .forEach((n, i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, stations.length);
        pos.set(n.id, { x: Math.cos(a) * hubR, y: Math.sin(a) * hubR, lx: 1 });
      });
    const placed = [{ x: 0, y: 0, r: hubR + (stations.length ? 70 : 10) }];
    // Folders: placed along a spiral in the order Claude first reached them.
    const groups = new Map();
    files
      .slice()
      .sort((a, b) => a.firstIndex - b.firstIndex)
      .forEach((n) => {
        if (!groups.has(n.group)) groups.set(n.group, []);
        groups.get(n.group).push(n);
      });
    const hulls = [];
    let t = 1.2;
    for (const [group, list] of groups) {
      const k = list.length;
      const ringR = k === 1 ? 0 : Math.max(30, (k * 34) / (2 * Math.PI));
      const longest = list.reduce((m, n) => Math.max(m, n.label.length), 0);
      const labelPad = Math.min(220, longest * 6.6 + 18);
      const need = ringR + labelPad;
      let cx = 0;
      let cy = 0;
      for (let guard = 0; guard < 4000; guard++) {
        const r = 26 * t;
        cx = Math.cos(t) * r * 1.35;
        cy = Math.sin(t) * r;
        let ok = true;
        for (const q of placed) {
          const d = Math.hypot(cx - q.x, cy - q.y);
          if (d < need + q.r + 14) {
            ok = false;
            break;
          }
        }
        if (ok) break;
        t += 0.08;
      }
      placed.push({ x: cx, y: cy, r: need });
      list.forEach((n, j) => {
        if (k === 1) {
          pos.set(n.id, { x: cx, y: cy, lx: 1 });
          return;
        }
        // Start facing the hub so the first file is closest to where Claude came from.
        const toHub = Math.atan2(-cy, -cx);
        const a = toHub + (j * 2 * Math.PI) / k;
        pos.set(n.id, { x: cx + Math.cos(a) * ringR, y: cy + Math.sin(a) * ringR, lx: Math.cos(a) >= -0.2 ? 1 : -1, ang: a });
      });
      hulls.push({ group: group, x: cx, y: cy, r: ringR + 22, files: k });
    }
    // Bounding box including labels.
    let minX = -hubR - 60;
    let maxX = hubR + 60;
    let minY = -hubR - 60;
    let maxY = hubR + 60;
    for (const n of p.nodes) {
      const q = pos.get(n.id);
      if (!q) continue;
      const lw = n.label.length * 6.6 + 20;
      minX = Math.min(minX, q.x - (q.lx < 0 ? lw : 20));
      maxX = Math.max(maxX, q.x + (q.lx > 0 ? lw : 20));
      minY = Math.min(minY, q.y - 40);
      maxY = Math.max(maxY, q.y + 30);
    }
    for (const hl of hulls) {
      minY = Math.min(minY, hl.y - hl.r - 26);
      minX = Math.min(minX, hl.x - hl.r - 10);
      maxX = Math.max(maxX, hl.x + hl.r + 10);
      maxY = Math.max(maxY, hl.y + hl.r + 10);
    }
    return { pos, hulls, box: { x: minX, y: minY, w: maxX - minX, h: maxY - minY }, key: p.nodes.map((n) => n.id).join('|') };
  }

  function fitBox(box) {
    const r = els.stage.getBoundingClientRect();
    const W = Math.max(200, r.width);
    const H = Math.max(160, r.height);
    const pad = 40;
    const scale = Math.max((box.w + pad * 2) / W, (box.h + pad * 2) / H, 0.8);
    const w = W * scale;
    const hh = H * scale;
    return { x: box.x + box.w / 2 - w / 2, y: box.y + box.h / 2 - hh / 2, w: w, h: hh };
  }

  function renderMap() {
    const p = state.payload;
    const layout = computeLayout(p);
    const layoutChanged = !state.layout || state.layout.key !== layout.key;
    state.layout = layout;
    if (!state.vb || (!state.userMoved && layoutChanged) || !state.userMoved) {
      state.vb = fitBox(layout.box);
    }
    const svg = s('svg', { class: 'map', role: 'img', 'aria-label': 'Map of the files and tools Claude visited' });
    svg.setAttribute('viewBox', [state.vb.x, state.vb.y, state.vb.w, state.vb.h].join(' '));
    const defs = s('defs');
    const kinds = ['--k-read', '--k-edit', '--k-create', '--k-search', '--k-run', '--k-delegate', '--k-plan', '--k-you', '--k-error'];
    for (const k of kinds) {
      defs.appendChild(
        s('marker', { id: 'arr' + k, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' }, [
          s('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'var(' + k + ')' }),
        ]),
      );
    }
    svg.appendChild(defs);
    const world = s('g');
    svg.appendChild(world);

    // Folder hulls.
    for (const hl of layout.hulls) {
      if (hl.files > 1) world.appendChild(s('circle', { class: 'hull', cx: hl.x, cy: hl.y, r: hl.r }));
      world.appendChild(
        s('text', {
          class: 'group-label',
          x: hl.x,
          y: hl.files > 1 ? hl.y - hl.r - 8 : hl.y - 22,
          'text-anchor': 'middle',
          text: oneLine(hl.group, 48),
        }),
      );
    }

    // Edges: one curve per hop, curving to the left of travel so there-and-back trips separate.
    const st = p.steps;
    const edges = s('g');
    world.appendChild(edges);
    const seen = new Map();
    const nums = s('g');
    let prevNode = null;
    const visibleLimit = state.cursor;
    const nodeById = new Map(p.nodes.map((n) => [n.id, n]));
    // Very long journeys: older hops are drawn as one plain path per color (no hover), recent ones fully.
    const DETAIL = 400;
    const bulk = new Map();
    for (let i = 0; i <= visibleLimit && i < st.length; i++) {
      const cur = st[i];
      if (prevNode && prevNode !== cur.node) {
        const a = layout.pos.get(prevNode);
        const b = layout.pos.get(cur.node);
        if (a && b) {
          const key = prevNode + '>' + cur.node;
          const k = seen.get(key) || 0;
          seen.set(key, k + 1);
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.hypot(dx, dy) || 1;
          const bend = len * (0.16 + Math.min(k, 6) * 0.07);
          const mx = (a.x + b.x) / 2 - (dy / len) * bend;
          const my = (a.y + b.y) / 2 + (dx / len) * bend;
          const colorVar = cur.status === 'error' || cur.outcome === 'fail' ? '--k-error' : KIND_VAR[cur.kind] || '--k-plan';
          const age = visibleLimit - i;
          const special = state.selected === cur.id || (state.highlight && state.highlight.has(cur.id));
          if (age >= DETAIL && !special) {
            bulk.set(colorVar, (bulk.get(colorVar) || '') + 'M' + a.x + ',' + a.y + ' Q' + mx + ',' + my + ' ' + b.x + ',' + b.y + ' ');
          } else {
            // Stop the arrow short of the target node.
            const tr = nodeRadius(nodeById.get(cur.node)) + 3;
            const dd = Math.hypot(b.x - mx, b.y - my) || 1;
            const ex = b.x - ((b.x - mx) / dd) * tr;
            const ey = b.y - ((b.y - my) / dd) * tr;
            let cls = 'edge';
            if (age === 0 && (state.atLive ? p.live : true)) cls += ' current';
            else if (age < 6) cls += ' recent';
            if (state.highlight) cls += state.highlight.has(cur.id) ? ' hl' : ' faded';
            if (state.selected === cur.id) cls += ' hl';
            const path = s('path', {
              class: cls,
              d: 'M' + a.x + ',' + a.y + ' Q' + mx + ',' + my + ' ' + ex + ',' + ey,
              stroke: 'var(' + colorVar + ')',
              'marker-end': 'url(#arr' + colorVar + ')',
            });
            path.addEventListener('mouseenter', (e) => showTip(e, tipForStep(cur)));
            path.addEventListener('mousemove', moveTip);
            path.addEventListener('mouseleave', hideTip);
            path.addEventListener('click', (e) => {
              e.stopPropagation();
              selectStep(cur);
            });
            edges.appendChild(path);
            if (age < 12 || special) {
              nums.appendChild(s('text', { class: 'edge-num', x: (a.x + 2 * mx + b.x) / 4, y: (a.y + 2 * my + b.y) / 4 + 3, 'text-anchor': 'middle', text: cur.label }));
            }
          }
        }
      }
      prevNode = cur.node;
    }
    for (const [colorVar, d] of bulk) {
      edges.insertBefore(s('path', { class: 'edge' + (state.highlight ? ' faded' : ''), d: d, stroke: 'var(' + colorVar + ')' }), edges.firstChild);
    }

    // Nodes.
    const visitedUpTo = new Map();
    for (let i = 0; i <= state.cursor && i < st.length; i++) visitedUpTo.set(st[i].node, (visitedUpTo.get(st[i].node) || 0) + 1);
    const here = st[state.cursor] ? st[state.cursor].node : null;
    const selNode = state.selected ? (st.find((x) => x.id === state.selected) || {}).node : null;
    const hlNodes = state.highlight ? new Set(st.filter((x) => state.highlight.has(x.id)).map((x) => x.node)) : null;
    const nodesG = s('g');
    for (const n of p.nodes) {
      const q = layout.pos.get(n.id);
      if (!q) continue;
      const visits = visitedUpTo.get(n.id) || 0;
      const future = visits === 0;
      const r = nodeRadius(n);
      const color = nodeColor(n);
      let cls = 'node';
      if (n.id === here && p.live && state.atLive) cls += ' here';
      if (n.id === selNode) cls += ' selected';
      if (future || (hlNodes && !hlNodes.has(n.id))) cls += ' dim';
      const g = s('g', { class: cls, transform: 'translate(' + q.x + ',' + q.y + ')', tabindex: 0 });
      g.appendChild(s('circle', { class: 'halo', r: r + 5, stroke: color }));
      if (n.kind === 'station') {
        g.appendChild(s('rect', { class: 'core', x: -r, y: -r, width: r * 2, height: r * 2, rx: 5, fill: color }));
        g.appendChild(s('text', { class: 'station-glyph', 'text-anchor': 'middle', y: 4, text: (STATION[n.id] && STATION[n.id].g) || '•' }));
      } else {
        g.appendChild(s('circle', { class: 'core', r: r, fill: color }));
      }
      g.addEventListener('mouseenter', (e) => showTip(e, tipForNode(n)));
      g.addEventListener('mousemove', moveTip);
      g.addEventListener('mouseleave', hideTip);
      g.addEventListener('click', (e) => {
        e.stopPropagation();
        const list = st.filter((x) => x.node === n.id && x.index <= state.cursor);
        const pick = list.length ? list[list.length - 1] : st.find((x) => x.node === n.id);
        if (pick) selectStep(pick);
      });
      g.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const pick = st.filter((x) => x.node === n.id).pop();
        if (pick) vscode.postMessage({ type: 'openStep', id: pick.id });
      });
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const pick = st.filter((x) => x.node === n.id).pop();
          if (pick) selectStep(pick);
        }
      });
      nodesG.appendChild(g);
      const lx = q.lx > 0 ? r + 6 : -(r + 6);
      const label = s('text', {
        class: 'node-label' + (future || (hlNodes && !hlNodes.has(n.id)) ? ' dim' : ''),
        x: q.x + lx,
        y: n.kind === 'station' ? q.y + r + 14 : q.y + 4,
        'text-anchor': n.kind === 'station' ? 'middle' : q.lx > 0 ? 'start' : 'end',
        text: n.label + (visits > 1 ? '  ×' + visits : ''),
      });
      if (n.kind === 'station') label.setAttribute('x', q.x);
      nodesG.appendChild(label);
    }
    world.appendChild(nodesG);
    world.appendChild(nums);

    // Comet on the current position.
    if (here && layout.pos.get(here)) {
      const q = layout.pos.get(here);
      const comet = s('g', { class: 'comet', transform: 'translate(' + q.x + ',' + q.y + ')' }, [s('circle', { r: 3 })]);
      world.appendChild(comet);
    }

    svg.addEventListener('click', () => {
      if (state.selected || state.highlight) {
        state.selected = null;
        state.highlight = null;
        state.insightIdx = -1;
        renderAll();
      }
    });
    attachPanZoom(svg);
    els.stage.appendChild(svg);
    els.stage.appendChild(
      h('div', { class: 'floating' }, [
        iconBtn('plus', 'Zoom in', () => zoomBy(0.8)),
        iconBtn('minus', 'Zoom out', () => zoomBy(1.25)),
        iconBtn('fit', 'Fit to view (F)', fitView),
      ]),
    );
  }

  function nodeRadius(n) {
    if (!n) return 8;
    if (n.kind === 'station') return 11;
    return Math.min(16, 6 + Math.sqrt(n.visits) * 2.2);
  }

  function fitView() {
    state.userMoved = false;
    if (state.layout) state.vb = fitBox(state.layout.box);
    renderStage();
  }

  function zoomBy(f, cx, cy) {
    const vb = state.vb;
    if (!vb) return;
    const px = cx === undefined ? vb.x + vb.w / 2 : cx;
    const py = cy === undefined ? vb.y + vb.h / 2 : cy;
    const w = Math.max(80, Math.min(40000, vb.w * f));
    const k = w / vb.w;
    state.vb = { x: px - (px - vb.x) * k, y: py - (py - vb.y) * k, w: w, h: vb.h * k };
    state.userMoved = true;
    const svg = els.stage.querySelector('svg.map');
    if (svg) svg.setAttribute('viewBox', [state.vb.x, state.vb.y, state.vb.w, state.vb.h].join(' '));
  }

  function attachPanZoom(svg) {
    let drag = null;
    svg.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = svg.getBoundingClientRect();
        const vb = state.vb;
        const cx = vb.x + ((e.clientX - r.left) / r.width) * vb.w;
        const cy = vb.y + ((e.clientY - r.top) / r.height) * vb.h;
        zoomBy(Math.pow(1.0015, e.deltaY), cx, cy);
      },
      { passive: false },
    );
    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, vb: Object.assign({}, state.vb), moved: false };
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const r = svg.getBoundingClientRect();
      const dx = ((e.clientX - drag.x) / r.width) * drag.vb.w;
      const dy = ((e.clientY - drag.y) / r.height) * drag.vb.h;
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3) {
        drag.moved = true;
        svg.classList.add('dragging');
      }
      if (drag.moved) {
        state.vb = { x: drag.vb.x - dx, y: drag.vb.y - dy, w: drag.vb.w, h: drag.vb.h };
        state.userMoved = true;
        svg.setAttribute('viewBox', [state.vb.x, state.vb.y, state.vb.w, state.vb.h].join(' '));
      }
    });
    const end = (e) => {
      if (drag && drag.moved) {
        // Swallow the click that ends a drag.
        const stopClick = (ev) => {
          ev.stopPropagation();
          svg.removeEventListener('click', stopClick, true);
        };
        svg.addEventListener('click', stopClick, true);
        setTimeout(() => svg.removeEventListener('click', stopClick, true), 0);
      }
      drag = null;
      svg.classList.remove('dragging');
      try {
        svg.releasePointerCapture(e.pointerId);
      } catch (_) {
        /* ignore */
      }
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('dblclick', (e) => {
      if (e.target === svg) fitView();
    });
  }

  // ------------------------------------------------------------------ lanes

  function renderLanes() {
    const p = state.payload;
    const st = p.steps;
    const rows = p.nodes.slice().sort((a, b) => a.firstIndex - b.firstIndex);
    const rowIndex = new Map(rows.map((n, i) => [n.id, i]));
    const multi = p.scope === 'session' && p.expeditions.length > 1;
    const ROW = 24;
    // Fit the whole journey when possible; long ones scroll with a minimum column width.
    const avail = (els.stage.clientWidth || 800) - 230 - 36;
    const COL = Math.max(14, Math.min(28, Math.floor(avail / Math.max(1, st.length))));
    const HEAD = multi ? 46 : 30;
    const PADL = 18;
    const W = PADL * 2 + st.length * COL;
    const H = HEAD + rows.length * ROW + 12;
    const cx = (i) => PADL + i * COL + COL / 2;
    const cy = (r) => HEAD + r * ROW + ROW / 2;

    const wrap = h('div', { class: 'lanes' });
    const inner = h('div', { class: 'lanes-inner' });
    const labels = h('div', { class: 'lane-labels' });
    const headLabel = h('div', { class: 'lane-label head', text: 'file / tool' });
    headLabel.style.height = HEAD + 'px';
    labels.appendChild(headLabel);
    for (const n of rows) {
      const sw = h('span', { class: 'sw' + (n.kind === 'station' ? ' station' : '') });
      sw.style.background = nodeColor(n);
      const dir = n.kind === 'file' && n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : '';
      const lab = h('div', { class: 'lane-label', title: n.path + ', ' + n.visits + ' visit' + (n.visits === 1 ? '' : 's') }, [
        sw,
        h('span', { text: n.label }),
        dir ? h('span', { class: 'dir', text: dir }) : null,
      ]);
      lab.style.height = ROW + 'px';
      lab.style.width = '230px';
      lab.addEventListener('click', () => {
        const pick = st.filter((x) => x.node === n.id && x.index <= state.cursor).pop() || st.find((x) => x.node === n.id);
        if (pick) selectStep(pick);
      });
      lab.addEventListener('dblclick', () => {
        const pick = st.filter((x) => x.node === n.id).pop();
        if (pick) vscode.postMessage({ type: 'openStep', id: pick.id });
      });
      labels.appendChild(lab);
    }

    const svg = s('svg', { class: 'lanes-svg', width: W, height: H, role: 'img', 'aria-label': 'Moves over time' });
    rows.forEach((n, i) => {
      if (i % 2 === 0) svg.appendChild(s('rect', { class: 'lane-row', x: 0, y: HEAD + i * ROW, width: W, height: ROW }));
    });
    for (const run of p.phases) {
      const r = s('rect', {
        class: 'lane-phase',
        x: cx(run.from) - COL / 2,
        y: HEAD - 4,
        width: (run.to - run.from + 1) * COL,
        height: rows.length * ROW + 8,
        fill: 'var(' + PHASE_VAR[run.phase] + ')',
      });
      svg.appendChild(r);
    }
    // Prompt separators in whole-session view.
    if (multi) {
      let last = -1;
      st.forEach((x, i) => {
        if (x.expeditionIndex !== last) {
          last = x.expeditionIndex;
          const xx = cx(i) - COL / 2;
          svg.appendChild(s('line', { class: 'lane-sep', x1: xx, x2: xx, y1: 0, y2: H }));
          const e = p.expeditions.find((q) => q.index === x.expeditionIndex);
          svg.appendChild(s('text', { class: 'lane-exp-label', x: xx + 4, y: 13, text: '#' + x.expeditionIndex + ' ' + oneLine(e ? e.prompt : '', 40) }));
        }
      });
    }
    // Column numbers.
    const every = COL >= 24 ? 1 : COL >= 18 ? 2 : 5;
    st.forEach((x, i) => {
      if (i % every === 0 || i === st.length - 1) svg.appendChild(s('text', { class: 'lane-col-label', x: cx(i), y: HEAD - 10, text: x.label }));
    });
    // The path.
    let dPast = '';
    let dFuture = '';
    for (let i = 1; i < st.length; i++) {
      const x0 = cx(i - 1);
      const y0 = cy(rowIndex.get(st[i - 1].node));
      const x1 = cx(i);
      const y1 = cy(rowIndex.get(st[i].node));
      const mx = (x0 + x1) / 2;
      const seg = 'M' + x0 + ',' + y0 + ' C' + mx + ',' + y0 + ' ' + mx + ',' + y1 + ' ' + x1 + ',' + y1 + ' ';
      if (i <= state.cursor) dPast += seg;
      else dFuture += seg;
    }
    if (dPast) svg.appendChild(s('path', { class: 'lane-path', d: dPast }));
    if (dFuture) svg.appendChild(s('path', { class: 'lane-path future', d: dFuture }));
    // Cursor.
    if (state.cursor >= 0) {
      svg.appendChild(s('line', { class: 'lane-cursor', x1: cx(state.cursor), x2: cx(state.cursor), y1: HEAD - 4, y2: H - 4 }));
    }
    // Dots.
    st.forEach((x, i) => {
      const r = rowIndex.get(x.node);
      const X = cx(i);
      const Y = cy(r);
      const future = i > state.cursor;
      const dim = state.highlight && !state.highlight.has(x.id);
      const dot = s('circle', {
        class: 'lane-dot' + (future ? ' future' : '') + (x.sub ? ' sub' : ''),
        cx: X,
        cy: Y,
        r: x.kind === 'edit' || x.kind === 'create' ? 6 : 5,
        fill: stepColor(x),
        opacity: dim ? 0.2 : 1,
      });
      dot.addEventListener('mouseenter', (e) => showTip(e, tipForStep(x)));
      dot.addEventListener('mousemove', moveTip);
      dot.addEventListener('mouseleave', hideTip);
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        selectStep(x);
      });
      dot.addEventListener('dblclick', () => vscode.postMessage({ type: 'openStep', id: x.id }));
      svg.appendChild(dot);
      if (x.status === 'running') {
        svg.appendChild(s('circle', { class: 'lane-ring', cx: X, cy: Y, r: 9, stroke: 'var(--k-create)', 'stroke-dasharray': '3 3' }));
      }
      if (x.afterFailure) {
        svg.appendChild(s('text', { class: 'lane-mark', x: X, y: Y - 9, 'text-anchor': 'middle', text: '⟲' }));
      } else if (x.revisitOf) {
        svg.appendChild(s('text', { class: 'lane-mark', x: X, y: Y - 9, 'text-anchor': 'middle', text: '↩' }));
      }
      if (state.selected === x.id) svg.appendChild(s('circle', { class: 'lane-sel', cx: X, cy: Y, r: 10 }));
    });
    svg.addEventListener('click', () => {
      if (state.selected || state.highlight) {
        state.selected = null;
        state.highlight = null;
        state.insightIdx = -1;
        renderAll();
      }
    });

    inner.appendChild(labels);
    inner.appendChild(svg);
    wrap.appendChild(inner);
    els.stage.appendChild(wrap);
    // Keep the cursor in view.
    const target = cx(Math.max(0, state.cursor)) + 230;
    const sel = state.selected ? st.find((x) => x.id === state.selected) : null;
    const focusX = sel ? cx(sel.index) + 230 : target;
    const prevScroll = state.lanesScroll;
    requestAnimationFrame(() => {
      const viewW = wrap.clientWidth;
      if (prevScroll !== undefined) wrap.scrollLeft = prevScroll;
      // Scroll as little as possible: keep the focused move just inside the visible area.
      if (focusX > wrap.scrollLeft + viewW - 40) {
        wrap.scrollLeft = Math.max(0, focusX - viewW + 80);
      } else if (focusX < wrap.scrollLeft + 230 + 40) {
        wrap.scrollLeft = Math.max(0, focusX - 230 - 80);
      }
      if (state.lanesScrollTop !== undefined) wrap.scrollTop = state.lanesScrollTop;
    });
    wrap.addEventListener('scroll', () => {
      state.lanesScroll = wrap.scrollLeft;
      state.lanesScrollTop = wrap.scrollTop;
    });
  }

  // ------------------------------------------------------------------ selection + side

  function selectStep(st) {
    stop();
    state.selected = st.id;
    if (st.index > state.cursor) {
      state.cursor = st.index;
      state.atLive = st.index === steps().length - 1;
    }
    renderAll();
  }

  function renderSide() {
    clear(els.side);
    const p = state.payload;
    if (!p) return;
    const st = state.selected ? p.steps.find((x) => x.id === state.selected) : null;
    if (st) renderStepDetail(st, p);
    else renderOverview(p);
  }

  function renderStepDetail(st, p) {
    const idx = st.index;
    els.side.appendChild(
      h('div', { class: 'navrow' }, [
        h('button', { class: 'btn', text: 'Back to overview', onclick: () => ((state.selected = null), renderAll()) }),
        h('span', {}, [
          iconBtn('prev', 'Previous move', () => idx > 0 && selectStep(p.steps[idx - 1])),
          h('span', { text: ' ' + (idx + 1) + ' / ' + p.steps.length + ' ' }),
          iconBtn('next', 'Next move', () => idx < p.steps.length - 1 && selectStep(p.steps[idx + 1])),
        ]),
      ]),
    );
    const chip = h('span', { class: 'chip', text: st.kind });
    chip.style.color = stepColor(st);
    els.side.appendChild(h('div', { class: 'step-head' }, [chip, h('div', { class: 'step-title', text: '#' + st.label + ' ' + st.verb + ' ' + st.title })]));
    const meta = h('div', { class: 'step-meta' });
    meta.appendChild(h('span', { text: st.tool }));
    if (st.sub) meta.appendChild(h('span', { text: 'by a subagent' }));
    if (st.endedAt) meta.appendChild(h('span', { text: fmtDur(st.endedAt - st.startedAt) }));
    else if (st.status === 'running') meta.appendChild(h('span', { class: 'good', text: 'running...' }));
    if (st.added || st.removed) meta.appendChild(h('span', { text: '+' + (st.added || 0) + ' -' + (st.removed || 0) }));
    if (st.status === 'error') meta.appendChild(h('span', { class: 'bad', text: 'failed' }));
    if (st.status === 'interrupted') meta.appendChild(h('span', { class: 'bad', text: 'stopped' }));
    if (st.outcome) meta.appendChild(h('span', { class: st.outcome === 'pass' ? 'good' : 'bad', text: st.outcome === 'pass' ? 'tests look green' : 'tests look red' }));
    if (p.scope === 'session') meta.appendChild(h('span', { text: 'prompt #' + st.expeditionIndex }));
    els.side.appendChild(meta);
    if (st.afterFailure) els.side.appendChild(h('div', { class: 'flag', text: '⟲ Fix loop: Claude came back to change code right after a failing check.' }));
    else if (st.revisitOf) els.side.appendChild(h('div', { class: 'flag', text: '↩ Back to a file it first visited at #' + st.revisitOf + '.' }));

    const actions = h('div', { class: 'actions' });
    if (st.hasFile) actions.appendChild(h('button', { class: 'btn primary', text: 'Open file', onclick: () => vscode.postMessage({ type: 'openStep', id: st.id }) }));
    if (st.canDiff) actions.appendChild(h('button', { class: 'btn' + (st.hasFile ? '' : ' primary'), text: 'Show change', onclick: () => vscode.postMessage({ type: 'diff', id: st.id }) }));
    if (['run', 'test', 'build', 'git', 'install'].includes(st.kind)) actions.appendChild(h('button', { class: 'btn primary', text: 'Show output', onclick: () => vscode.postMessage({ type: 'output', id: st.id }) }));
    actions.appendChild(h('button', { class: 'btn', text: 'Find in Journey', onclick: () => vscode.postMessage({ type: 'reveal', id: st.id }) }));
    els.side.appendChild(actions);

    if (st.narration) {
      els.side.appendChild(h('h3', { text: 'Claude said before this' }));
      els.side.appendChild(h('div', { class: 'say', text: st.narration }));
    }
    if (st.thinking) {
      els.side.appendChild(h('details', { class: 'think' }, [h('summary', { text: 'Thinking' }), h('div', { text: st.thinking })]));
    }
    if (st.detail) {
      els.side.appendChild(h('h3', { text: st.kind === 'edit' || st.kind === 'create' ? 'Change' : 'Input' }));
      els.side.appendChild(h('pre', { text: st.detail }));
    }
    if (st.result && st.kind !== 'read' && st.kind !== 'edit' && st.kind !== 'create') {
      els.side.appendChild(h('h3', { text: 'Result' }));
      els.side.appendChild(h('pre', { text: st.result }));
    }
  }

  function renderOverview(p) {
    if (p.prompt) {
      els.side.appendChild(h('h3', { text: 'Your prompt' }));
      els.side.appendChild(h('div', { class: 'prompt-full', text: p.prompt }));
    }
    if (p.interjections && p.interjections.length) {
      els.side.appendChild(h('h3', { text: 'You steered mid-run' }));
      for (const i of p.interjections) els.side.appendChild(h('div', { class: 'you', text: i.text }));
    }
    els.side.appendChild(h('h3', { text: 'What stood out' }));
    if (!p.insights.length) {
      els.side.appendChild(h('div', { class: 'step-meta', text: p.steps.length ? 'Nothing unusual. A straight path.' : 'Waiting for moves...' }));
    }
    const glyph = { compass: '◎', zap: '»', sync: '⟲', pass: '✓', error: '✗', info: 'ℹ', flame: '◉', organization: '⧉', warning: '⚠' };
    p.insights.forEach((ins, i) => {
      const el = h(
        'div',
        {
          class: 'insight ' + ins.tone + (state.insightIdx === i ? ' on' : ''),
          tabindex: 0,
          onclick: () => {
            if (state.insightIdx === i) {
              state.insightIdx = -1;
              state.highlight = null;
            } else {
              state.insightIdx = i;
              state.highlight = ins.stepIds.length ? new Set(ins.stepIds) : null;
            }
            renderAll();
          },
        },
        [h('span', { class: 'ic', text: glyph[ins.icon] || '•' }), h('span', { text: ins.text })],
      );
      els.side.appendChild(el);
    });
    if (p.finalText) {
      els.side.appendChild(h('h3', { text: 'Final answer' }));
      els.side.appendChild(h('div', { class: 'say', text: oneLine(p.finalText, 600) }));
    }
    els.side.appendChild(h('h3', { text: 'How to read it' }));
    const lg = h('div', { class: 'legend-grid' });
    const items = [
      ['--k-read', 'read'],
      ['--k-edit', 'edited'],
      ['--k-create', 'created'],
      ['--k-search', 'search / web'],
      ['--k-run', 'command / test'],
      ['--k-delegate', 'subagent / tool'],
      ['--k-error', 'failed'],
      ['--k-plan', 'plan / other'],
    ];
    for (const [v, t] of items) {
      const sp = h('span', { text: t });
      sp.style.setProperty('--c', 'var(' + v + ')');
      lg.appendChild(sp);
    }
    els.side.appendChild(lg);
    els.side.appendChild(
      h('div', {
        class: 'step-meta',
        text: 'Squares are tools (terminal, search...), dots are files grouped by folder. Arrows follow Claude in order. ↩ = came back to a file, ⟲ = fixed something after a failing check. Click to inspect, double-click to open.',
      }),
    );
  }

  function renderReplay() {
    const n = steps().length;
    els.slider.max = String(Math.max(0, n - 1));
    els.slider.value = String(Math.max(0, state.cursor));
    els.slider.disabled = n === 0;
    const cur = steps()[state.cursor];
    els.pos.textContent = n ? '#' + (cur ? cur.label : '-') + '  ·  ' + (state.cursor + 1) + ' / ' + n : 'no moves';
    clear(els.playBtn);
    els.playBtn.appendChild(icon(state.playing ? 'pause' : 'play'));
    els.playBtn.title = state.playing ? 'Pause (Space)' : 'Replay (Space)';
  }

  // ------------------------------------------------------------------ tooltips

  function tipForStep(x) {
    const lines = [];
    lines.push(h('div', {}, [h('b', { text: '#' + x.label + ' ' + x.verb + ' ' }), document.createTextNode(oneLine(x.title, 70))]));
    const bits = [];
    if (x.endedAt) bits.push(fmtDur(x.endedAt - x.startedAt));
    if (x.added || x.removed) bits.push('+' + (x.added || 0) + ' -' + (x.removed || 0));
    if (x.status === 'error') bits.push('failed');
    if (x.outcome) bits.push(x.outcome === 'pass' ? 'passing' : 'failing');
    if (x.afterFailure) bits.push('fix loop');
    else if (x.revisitOf) bits.push('back from #' + x.revisitOf);
    if (bits.length) lines.push(h('div', { class: 'm', text: bits.join(' · ') }));
    if (x.narration) lines.push(h('div', { text: oneLine(x.narration, 200) }));
    return lines;
  }

  function tipForNode(n) {
    const p = state.payload;
    const list = p.steps.filter((x) => x.node === n.id);
    const lines = [h('div', {}, [h('b', { text: n.label })])];
    if (n.kind === 'file') lines.push(h('div', { class: 'm', text: n.path }));
    lines.push(
      h('div', {
        class: 'm',
        text: list.length + ' visit' + (list.length === 1 ? '' : 's') + ': ' + list.slice(0, 10).map((x) => '#' + x.label + ' ' + x.verb.toLowerCase()).join(', ') + (list.length > 10 ? '...' : ''),
      }),
    );
    return lines;
  }

  function showTip(e, content) {
    clear(els.tip);
    appendAll(els.tip, content);
    els.tip.style.display = 'block';
    moveTip(e);
  }

  function moveTip(e) {
    const pad = 14;
    const r = els.tip.getBoundingClientRect();
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    if (x + r.width > window.innerWidth - 4) x = e.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 4) y = e.clientY - r.height - pad;
    els.tip.style.left = Math.max(4, x) + 'px';
    els.tip.style.top = Math.max(4, y) + 'px';
  }

  function hideTip() {
    if (els.tip) els.tip.style.display = 'none';
  }

  // ------------------------------------------------------------------ keyboard + resize

  window.addEventListener('keydown', (e) => {
    const tag = e.target && e.target.tagName;
    if ((tag === 'SELECT' || tag === 'INPUT') && e.key !== 'Escape') return;
    if (tag === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;
    if (e.key === 'ArrowRight') {
      stop();
      setCursor(state.cursor + 1, true);
    } else if (e.key === 'ArrowLeft') {
      stop();
      setCursor(state.cursor - 1, true);
    } else if (e.key === ' ') {
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'Home') {
      stop();
      setCursor(0, true);
    } else if (e.key === 'End') {
      stop();
      goLive();
    } else if (e.key === 'm' || e.key === 'M') {
      setView('map');
    } else if (e.key === 'l' || e.key === 'L') {
      setView('lanes');
    } else if (e.key === 'f' || e.key === 'F') {
      if (state.view === 'map') fitView();
    } else if (e.key === 'Escape') {
      state.selected = null;
      state.highlight = null;
      state.insightIdx = -1;
      renderAll();
    }
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      renderRibbon();
      if (state.view === 'map' && !state.userMoved) state.vb = null;
      renderStage();
    }, 80);
  });

  build();
  vscode.postMessage({ type: 'ready' });
})();
