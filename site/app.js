(function () {
  'use strict';

  var DATA = JSON.parse(document.getElementById('data').textContent);
  var TEMPLATES = DATA.templates;
  var ACCENTS = ['#E8505B', '#3B7BF6', '#11A37F', '#8B5CF6', '#F2A93B', '#EC4899', '#0EA5B7'];
  var STICKERS = ['#F2A93B', '#7FE0BF', '#FFB3B8', '#B9CFFF', '#F2A93B', '#7FE0BF'];
  var TINT = { doc: 'var(--doc-tint)', slides: 'var(--slides-tint)', pdf: 'var(--pdf-tint)', html: 'var(--html-tint)' };
  var SLOTS = [
    { l: 0, t: 4, w: 40, r: -7 }, { l: 34, t: 0, w: 44, r: 4 }, { l: 72, t: 8, w: 30, r: 8 },
    { l: 4, t: 50, w: 42, r: 3 }, { l: 42, t: 42, w: 32, r: -6 }, { l: 66, t: 56, w: 36, r: -3 }
  ];

  TEMPLATES.forEach(function (t, i) {
    t.accent = ACCENTS[i % ACCENTS.length];
    t.haystack = [t.title, t.origin, t.description || '', t.outputs.map(function (o) { return o.format; }).join(' ')].join(' ').toLowerCase();
  });

  var state = {
    types: { doc: true, slides: true },
    outs: { pdf: true, html: true },
    query: '',
    open: null,     // id of the template shown in the dialog
    view: null,     // format shown in the dialog
    path: 'new',    // setup path for extensions: 'new' | 'add'
    seed: Math.floor(Math.random() * 9973)
  };
  var lastFocus = null;

  // --- helpers --------------------------------------------------------------

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(id) { return document.getElementById(id); }
  function byId(id) { return TEMPLATES.filter(function (t) { return t.id === id; })[0]; }
  function shapeOf(t, out) { return t.kind === 'slides' ? 'slide' : (out.output === 'pdf' ? 'page' : 'web'); }
  function ext(out) { return out.output; }

  var ICON = {
    doc: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 10h16M4 14h10M4 18h13"/></svg>',
    slides: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M12 16v4M8 20h8"/></svg>',
    pdf: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2h8l5 5v15H6z"/><path d="M14 2v5h5"/></svg>',
    html: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/></svg>',
    builtin: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#11A37F" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/></svg>',
    ext: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8B5CF6" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0z"/><path d="M12 17v5"/></svg>',
    copy: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/></svg>',
    check: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3 3 7-7"/></svg>',
    external: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 2h7v7M12 2L5.5 8.5M10 12H2V4"/></svg>',
    code: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/></svg>',
    book: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z"/></svg>',
    terminal: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8B5CF6" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 9l3 3-3 3M12.5 15H17"/></svg>'
  };

  function kindTag(t) {
    return '<span class="tag">' + (t.kind === 'doc' ? ICON.doc.replace('currentColor', '#11A37F') : ICON.slides.replace('currentColor', '#D68A12')) +
      (t.kind === 'doc' ? 'Document' : 'Slides') + '</span>';
  }
  function outTag(o) { return '<span class="tag c-' + o + '">' + ICON[o] + o.toUpperCase() + '</span>'; }
  function outputsOf(t) {
    var seen = {};
    return t.outputs.map(ext).filter(function (o) { return seen[o] ? false : (seen[o] = true); });
  }

  // A rendered thumbnail, or a drawn stand-in when the build had none.
  function preview(t, out) {
    var shape = shapeOf(t, out);
    var bar = shape === 'web' ? '<div class="pv-bar"><i></i><i></i><i></i></div>' : '';
    if (out.thumb) {
      return '<div class="pv pv-' + shape + '">' + bar + '<img src="' + esc(out.thumb) + '" width="' + (out.w || 640) +
        '" height="' + (out.h || 480) + '" alt="" loading="lazy" decoding="async"></div>';
    }
    return '<div class="pv pv-' + shape + '">' + bar + mock(shape, t.accent) + '</div>';
  }
  function mock(shape, a) {
    if (shape === 'slide') {
      return '<div class="mock mock-slide" style="background:' + a + '"><b style="height:6cqw;width:64%;background:#fff"></b>' +
        '<b style="height:6cqw;width:40%;background:#fff"></b><b style="height:2.4cqw;width:28%;background:rgba(255,255,255,.65);margin-top:2cqw"></b></div>';
    }
    if (shape === 'web') {
      return '<div class="mock mock-web"><div style="height:22cqw;background:' + a + ';padding:5cqw 6cqw;display:flex;flex-direction:column;justify-content:flex-end;gap:2cqw">' +
        '<b style="height:4cqw;width:60%;background:#fff"></b><b style="height:2cqw;width:34%;background:rgba(255,255,255,.7)"></b></div>' +
        '<div style="padding:5cqw 6cqw;display:flex;flex-direction:column;gap:2.2cqw;flex:1"><b></b><b></b><b style="width:80%"></b>' +
        '<div style="flex:1;background:' + a + '33;border-radius:1.5cqw;margin-top:1cqw"></div></div></div>';
    }
    return '<div class="mock mock-page"><b style="height:4.2cqw;width:78%;background:#1B1A3A;align-self:center"></b>' +
      '<b style="height:2cqw;width:38%;background:' + a + ';align-self:center;margin:1cqw 0 3cqw"></b>' +
      '<b></b><b></b><b style="width:70%"></b><div style="height:26cqw;background:' + a + '33;border-radius:1.5cqw;margin:1.5cqw 0"></div>' +
      '<b></b><b></b><b style="width:80%"></b></div>';
  }

  // --- filtering --------------------------------------------------------------

  function matchesQuery(t) {
    var q = state.query.toLowerCase().trim();
    return !q || q.split(/\s+/).every(function (w) { return t.haystack.indexOf(w) > -1; });
  }
  function visible() {
    return TEMPLATES.filter(function (t) {
      return matchesQuery(t) && state.types[t.kind] && outputsOf(t).some(function (o) { return state.outs[o]; });
    });
  }
  function allOn() { return state.types.doc && state.types.slides && state.outs.pdf && state.outs.html; }
  function resetFilters() {
    state.types = { doc: true, slides: true };
    state.outs = { pdf: true, html: true };
    state.query = '';
    $('q').value = '';
    renderList();
  }

  // --- hero -----------------------------------------------------------------

  function renderCollage() {
    var s = state.seed;
    function rnd() { s = (s * 9301 + 49297) % 233280; return s / 233280; }
    var pool = TEMPLATES.slice();
    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1)); var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }
    var box = $('collage');
    box.querySelectorAll('.tile').forEach(function (n) { n.remove(); });
    var html = SLOTS.slice(0, pool.length).map(function (sl, k) {
      var t = pool[k], out = t.outputs[0], shape = shapeOf(t, out);
      var w = shape === 'page' ? Math.round(sl.w * 0.72) : sl.w;
      return '<button type="button" class="tile" data-open="' + esc(t.id) + '" aria-label="Open ' + esc(t.title) + '" style="left:' + sl.l +
        '%;top:' + sl.t + '%;width:' + w + '%;transform:rotate(' + sl.r + 'deg);z-index:' + (k + 1) + '">' +
        '<div class="tile-frame">' + preview(t, out) + '</div>' +
        '<span class="tile-sticker" style="background:' + STICKERS[k] + ';transform:rotate(' + (sl.r > 0 ? -4 : 3) + 'deg)">' + esc(t.title) + '</span></button>';
    }).join('');
    box.insertAdjacentHTML('afterbegin', html);
  }

  function renderQuick() {
    var byQuery = TEMPLATES.filter(matchesQuery);
    document.querySelectorAll('[data-quick]').forEach(function (b) {
      var p = b.getAttribute('data-quick').split(':'), kind = p[0], fmt = p[1];
      var on = state.types[kind] && state.outs[fmt];
      var only = on && !state.types[kind === 'doc' ? 'slides' : 'doc'] && !state.outs[fmt === 'pdf' ? 'html' : 'pdf'];
      var n = byQuery.filter(function (t) { return t.kind === kind && outputsOf(t).indexOf(fmt) > -1; }).length;
      b.classList.toggle('off', !on);
      b.setAttribute('aria-pressed', only ? 'true' : 'false');
      b.setAttribute('aria-label', (kind === 'doc' ? 'Documents' : 'Slides') + ' as ' + fmt.toUpperCase() + ', ' + n + (n === 1 ? ' template' : ' templates'));
    });
  }

  // --- grid -----------------------------------------------------------------

  function card(t, i) {
    var outs = t.outputs, first = outs[0], shape = shapeOf(t, first);
    var combo = outs.length > 1 && shapeOf(t, outs[1]) !== shape ? outs[1] : null;
    var pw = shape === 'page' ? '64%' : (shape === 'web' ? '72%' : '78%');
    var ty = shape === 'page' ? '0%' : '8%';
    var rot = i % 2 ? 2.5 : -2.5;
    return '<button type="button" class="card" data-open="' + esc(t.id) + '" aria-haspopup="dialog">' +
      '<div class="card-thumb dots' + (shape === 'page' ? ' is-page' : '') + '" style="background-color:' + TINT[t.kind] + '">' +
        '<div class="card-main" style="width:' + pw + ';transform:translate(' + (combo ? '-20%' : '0%') + ',' + ty + ') rotate(' + rot + 'deg)">' + preview(t, first) + '</div>' +
        (combo ? '<div class="card-second">' + preview(t, combo) + '</div>' : '') +
        '<div class="tags">' + kindTag(t) + outputsOf(t).map(outTag).join('') + '</div>' +
      '</div>' +
      '<div class="card-body"><span class="card-title">' + esc(t.title) + '</span>' +
        '<span class="origin">' + (t.builtin ? ICON.builtin : ICON.ext) + '<span>' + esc(t.origin) + '</span></span></div>' +
      '</button>';
  }

  function renderList() {
    var list = visible();
    $('grid').innerHTML = list.map(card).join('');
    $('empty').hidden = list.length > 0;
    $('count').textContent = list.length + (list.length === 1 ? ' template' : ' templates');
    $('clear').hidden = allOn() && !state.query.trim();
    document.querySelectorAll('[data-toggle]').forEach(function (b) {
      var p = b.getAttribute('data-toggle').split(':');
      b.setAttribute('aria-pressed', state[p[0]][p[1]] ? 'true' : 'false');
    });
    renderQuick();
  }

  // --- dialog ---------------------------------------------------------------

  function steps(t, out) {
    var fmt = out.format;
    var yamlStep = { text: 'Set the format in your front matter', cmd: out.yaml, yaml: true };
    if (t.setup === 'builtin') {
      return [yamlStep, { text: 'Render', cmd: 'quarto render document.qmd' }];
    }
    if (t.setup === 'clone') {
      var name = t.repo.split('/')[1];
      var parts = t.file.split('/');
      var file = parts.pop();
      return [
        { text: 'Download the template', cmd: 'git clone https://github.com/' + t.repo + '.git' },
        { text: 'Go to its folder', cmd: 'cd ' + [name].concat(parts).join('/') },
        { text: 'Render it', cmd: 'quarto render ' + file + ' --to ' + fmt }
      ];
    }
    if (state.path === 'new') {
      var s = [{ text: 'Create a project from the template', cmd: 'quarto use template ' + t.repo }];
      if (!out.native) s.push({ text: 'Set the format in the new document', cmd: out.yaml, yaml: true });
      s.push({ text: 'Preview it', cmd: 'quarto preview' });
      return s;
    }
    return [
      { text: 'Install the extension', cmd: 'quarto add ' + t.repo },
      yamlStep,
      { text: 'Render', cmd: 'quarto render document.qmd' }
    ];
  }

  function renderDialog() {
    var modal = $('modal');
    var t = byId(state.open);
    if (!t) {
      modal.hidden = true;
      modal.innerHTML = '';
      document.body.classList.remove('modal-open');
      return;
    }
    var list = visible().some(function (v) { return v.id === t.id; }) ? visible() : TEMPLATES;
    var idx = Math.max(0, list.indexOf(t));
    var out = t.outputs.filter(function (o) { return o.format === state.view; })[0] ||
      t.outputs.filter(function (o) { return state.outs[o.output]; })[0] || t.outputs[0];
    var shape = shapeOf(t, out);
    var url = out.url;
    var frameSrc = out.output === 'pdf' ? url + '#view=FitH' : url;
    var srcShort = t.src.replace(/^https:\/\//, '');
    var st = steps(t, out);

    var h = '';
    h += '<button type="button" class="backdrop" data-close tabindex="-1" aria-label="Close"></button>';
    h += '<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title">';

    // stage
    h += '<section class="stage dots" aria-label="Rendered output" style="background-color:' + TINT[out.output] + '">';
    h += '<div class="stage-top"><span class="filechip">' + ICON[out.output].replace('currentColor', out.output === 'pdf' ? '#E8505B' : '#3B7BF6') +
      esc(out.format + '.' + out.output) + '</span>';
    h += '<a class="btn-small pop" href="' + esc(url) + '" target="_blank" rel="noopener">Open in new tab' + ICON.external + '</a></div>';
    h += '<div class="stage-body"><div class="stage-fit"><div class="frame' + (shape === 'slide' ? ' is-slide' : '') + '">';
    h += '<iframe src="' + esc(frameSrc) + '" title="' + esc(t.title) + ' (' + out.output.toUpperCase() + ')" loading="lazy"></iframe>';
    h += '<a class="frame-img" href="' + esc(url) + '" target="_blank" rel="noopener" aria-label="Open the rendered ' + out.output.toUpperCase() + '">' + preview(t, out) + '</a>';
    h += '</div></div>';
    if (list.length > 1) {
      h += '<button type="button" class="nav nav-prev pop" data-step="-1" aria-label="Previous template"><svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3L5 8l5 5"/></svg></button>';
      h += '<button type="button" class="nav nav-next pop" data-step="1" aria-label="Next template"><svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3l5 5-5 5"/></svg></button>';
    }
    h += '<span class="position">' + (idx + 1) + ' / ' + list.length + '</span>';
    h += '</div></section>';

    // aside
    h += '<aside class="aside">';
    h += '<div class="aside-head"><div class="tags">';
    h += '<span class="tag tinted c-' + t.kind + '">' + (t.kind === 'doc' ? ICON.doc : ICON.slides) + (t.kind === 'doc' ? 'Document' : 'Slides') + '</span>';
    h += t.builtin ? '<span class="tag">' + ICON.builtin.replace('2.2', '2.6').replace(/16/g, '14') + 'Built-in</span>'
                   : '<span class="tag">' + ICON.ext.replace('2.2', '2.6').replace(/16/g, '14') + 'Extension</span>';
    h += '</div><button type="button" class="close" data-close aria-label="Close"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15"/></svg></button></div>';

    h += '<div class="titles"><h2 id="dlg-title">' + esc(t.title) + '</h2><span class="origin-line">' + esc(t.origin) + '</span>' +
      (t.description ? '<p>' + esc(t.description) + '</p>' : '') + '</div>';

    h += '<div class="views" role="group" aria-label="Rendered format">';
    t.outputs.forEach(function (o) {
      h += '<button type="button" class="chip c-' + o.output + '" data-view="' + esc(o.format) + '" aria-pressed="' + (o === out) + '">' +
        ICON[o.output].replace(/14/g, '16') + (t.outputs.filter(function (x) { return x.output === o.output; }).length > 1 ? esc(o.format) : o.output.toUpperCase()) + '</button>';
    });
    h += '</div>';

    h += '<div class="setup"><div class="setup-head"><h3>' + ICON.terminal + 'Set it up</h3>' +
      (t.builtin ? '<span class="pill">Nothing to install</span>' : '') + '</div>';
    if (t.setup === 'extension') {
      h += '<div class="paths" role="group" aria-label="Setup path">' +
        [['new', 'New project'], ['add', 'Existing project']].map(function (p) {
          return '<button type="button" data-path="' + p[0] + '" aria-pressed="' + (state.path === p[0]) + '">' + p[1] + '</button>';
        }).join('') + '</div>';
    }
    h += '<ol class="steps">';
    st.forEach(function (s, i) {
      h += '<li><span class="step-text"><span class="step-n">' + (i + 1) + '</span>' + esc(s.text) + '</span>' +
        '<div class="cmd"><span class="cmd-prompt" style="color:' + (s.yaml ? '#B9CFFF' : '#F2A93B') + '">' + (s.yaml ? 'yaml' : '$') + '</span>' +
        '<code>' + esc(s.cmd) + '</code>' +
        '<button type="button" class="copy" data-copy="' + i + '" aria-label="Copy: ' + esc(s.cmd) + '">' + ICON.copy + '</button></div></li>';
    });
    h += '</ol></div>';

    h += '<div class="aside-foot"><a class="btn-primary pop" href="' + esc(t.src) + '" target="_blank" rel="noopener">' +
      (t.builtin ? ICON.book + 'Read the docs' : ICON.code + 'View source') + '</a>';
    h += '<span class="meta">' + esc(srcShort) + '<br>' + 'Rendered ' + esc(t.rendered || '') + ' with Quarto ' + esc(DATA.quarto) +
      (t.rev ? ' from <a href="https://github.com/' + esc(t.repo) + '/commit/' + esc(t.rev) + '" target="_blank" rel="noopener">' + esc(t.rev.slice(0, 7)) + '</a>' : '') + '</span>';
    h += '</div></aside></div>';

    modal.innerHTML = h;
    modal.hidden = false;
    modal._steps = st;
    modal._list = list;
    modal._idx = idx;
    document.body.classList.add('modal-open');
  }

  function open(id, view) {
    if (!state.open) lastFocus = document.activeElement;
    state.open = id;
    state.view = view || null;
    state.path = 'new';
    renderDialog();
    syncHash();
    var close = document.querySelector('#modal .close');
    if (close) close.focus();
  }
  function close() {
    state.open = null;
    renderDialog();
    syncHash();
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }
  function step(delta) {
    var m = $('modal'), list = m._list;
    var next = list[(m._idx + delta + list.length) % list.length];
    state.open = next.id;
    state.view = null;
    renderDialog();
    syncHash();
    var btn = document.querySelector('#modal [data-step="' + delta + '"]');
    if (btn) btn.focus();
  }

  // Deep links: #<id> or #<id>/<format>
  function syncHash() {
    var h = state.open ? '#' + state.open + (state.view ? '/' + state.view : '') : ' ';
    if (location.hash !== h) history.replaceState(null, '', h === ' ' ? location.pathname + location.search : h);
  }
  function fromHash() {
    var m = decodeURIComponent(location.hash.slice(1)).split('/');
    if (m[0] && byId(m[0])) open(m[0], m[1]);
    else if (state.open) close();
  }

  // --- events ---------------------------------------------------------------

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-open],[data-toggle],[data-quick],[data-close],[data-step],[data-view],[data-path],[data-copy]');
    if (!el) return;
    if (el.hasAttribute('data-open')) return open(el.getAttribute('data-open'));
    if (el.hasAttribute('data-close')) return close();
    if (el.hasAttribute('data-step')) return step(+el.getAttribute('data-step'));
    if (el.hasAttribute('data-view')) { state.view = el.getAttribute('data-view'); renderDialog(); syncHash(); return focusSame('data-view', state.view); }
    if (el.hasAttribute('data-path')) { state.path = el.getAttribute('data-path'); renderDialog(); return focusSame('data-path', state.path); }
    if (el.hasAttribute('data-copy')) {
      var cmd = $('modal')._steps[+el.getAttribute('data-copy')].cmd;
      if (navigator.clipboard) navigator.clipboard.writeText(cmd).catch(function () {});
      document.querySelectorAll('#modal .copy.done').forEach(function (b) { b.classList.remove('done'); b.innerHTML = ICON.copy; });
      el.classList.add('done');
      el.innerHTML = ICON.check;
      return;
    }
    if (el.hasAttribute('data-toggle')) {
      var p = el.getAttribute('data-toggle').split(':');
      var g = Object.assign({}, state[p[0]]);
      g[p[1]] = !g[p[1]];
      if (!Object.keys(g).some(function (k) { return g[k]; })) Object.keys(g).forEach(function (k) { g[k] = true; });
      state[p[0]] = g;
      return renderList();
    }
    if (el.hasAttribute('data-quick')) {
      var q = el.getAttribute('data-quick').split(':'), kind = q[0], fmt = q[1];
      if (el.getAttribute('aria-pressed') === 'true') {
        state.types = { doc: true, slides: true };
        state.outs = { pdf: true, html: true };
      } else {
        state.types = { doc: kind === 'doc', slides: kind === 'slides' };
        state.outs = { pdf: fmt === 'pdf', html: fmt === 'html' };
      }
      return renderList();
    }
  });
  function focusSame(attr, val) {
    var b = document.querySelector('#modal [' + attr + '="' + val + '"]');
    if (b) b.focus();
  }

  // Hovering a half pushes the diagonal toward its sibling.
  document.querySelectorAll('.split').forEach(function (split) {
    split.querySelectorAll('.half').forEach(function (half) {
      var fmt = half.classList.contains('half-html') ? 'html' : 'pdf';
      function enter() { split.setAttribute('data-hov', fmt); }
      function leave() { if (split.getAttribute('data-hov') === fmt) split.removeAttribute('data-hov'); }
      half.addEventListener('mouseenter', enter);
      half.addEventListener('focus', enter);
      half.addEventListener('mouseleave', leave);
      half.addEventListener('blur', leave);
    });
  });

  $('q').addEventListener('input', function (e) { state.query = e.target.value; renderList(); });
  $('clear').addEventListener('click', resetFilters);
  $('empty-clear').addEventListener('click', resetFilters);
  $('shuffle').addEventListener('click', function () { state.seed = (state.seed * 31 + 17) % 9973; renderCollage(); });

  document.addEventListener('keydown', function (e) {
    if (!state.open) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
      if ($('modal')._list.length > 1) { e.preventDefault(); step(e.key === 'ArrowLeft' ? -1 : 1); }
    } else if (e.key === 'Tab') {
      // keep focus inside the dialog
      var f = Array.prototype.filter.call($('modal').querySelectorAll('.dialog a[href], .dialog button, .dialog iframe'), function (n) { return n.offsetParent !== null; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  window.addEventListener('hashchange', fromHash);

  renderCollage();
  renderList();
  fromHash();
})();
