(function () {
  'use strict';

  var DATA = JSON.parse(document.getElementById('data').textContent);
  var TEMPLATES = DATA.templates;
  var ACCENTS = ['#E8505B', '#3B7BF6', '#11A37F', '#8B5CF6', '#F2A93B', '#EC4899', '#0EA5B7'];
  var STICKERS = ['#F2A93B', '#7FE0BF', '#FFB3B8', '#B9CFFF', '#F2A93B', '#7FE0BF'];
  var TINT = { doc: 'var(--doc-tint)', slides: 'var(--slides-tint)', pdf: 'var(--pdf-tint)', html: 'var(--html-tint)' };
  var ENGINE = { latex: 'LaTeX', typst: 'Typst' };
  var PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/';
  var COLLAGE_MAX = 6;
  var ZOOM_MIN = 48;    // smallest PDF page size, in % of full width; at the bottom pages sit two to a row

  TEMPLATES.forEach(function (t, i) {
    t.accent = ACCENTS[i % ACCENTS.length];
    t.haystack = [t.title, t.origin, t.description || '', t.format, ENGINE[t.engine] || ''].join(' ').toLowerCase();
  });

  var state = {
    types: { doc: true, slides: true },
    outs: { pdf: true, html: true },
    query: '',
    open: null,     // id of the template shown in the dialog
    tab: 'output',  // what the dialog's stage shows: 'output' | 'source'
    zoom: 100,      // PDF page size in %, from ZOOM_MIN up to 100 (filling the stage)
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
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).catch(function () {});
    // e.g. served over plain http: copy through a temporary selection
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    var focused = document.activeElement;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* nothing more to try */ }
    ta.remove();
    if (focused) focused.focus();
  }
  function byId(id) { return TEMPLATES.filter(function (t) { return t.id === id; })[0]; }
  function shapeOf(t) { return t.kind === 'slides' ? 'slide' : (t.output === 'pdf' ? 'page' : 'web'); }
  // "PDF · Typst", "PDF · LaTeX" or "HTML": what the template renders to, and with what.
  function outLabel(t) { return t.output.toUpperCase() + (t.engine ? ' · ' + ENGINE[t.engine] : ''); }
  function reducedMotion() { return window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches; }

  var ICON = {
    doc: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 10h16M4 14h10M4 18h13"/></svg>',
    slides: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M12 16v4M8 20h8"/></svg>',
    pdf: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2h8l5 5v15H6z"/><path d="M14 2v5h5"/></svg>',
    html: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/></svg>',
    builtin: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#11A37F" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/></svg>',
    ext: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8B5CF6" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0z"/><path d="M12 17v5"/></svg>',
    page: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="1.75" width="9" height="12.5" rx="1"/></svg>',
    spread: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="4" width="5.5" height="8" rx=".8"/><rect x="9" y="4" width="5.5" height="8" rx=".8"/></svg>',
    copy: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/></svg>',
    check: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3 3 7-7"/></svg>',
    external: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 2h7v7M12 2L5.5 8.5M10 12H2V4"/></svg>',
    code: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/></svg>',
    book: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z"/></svg>',
    github: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>',
    terminal: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8B5CF6" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 9l3 3-3 3M12.5 15H17"/></svg>'
  };

  function kindTag(t) {
    return '<span class="tag">' + (t.kind === 'doc' ? ICON.doc.replace('currentColor', '#11A37F') : ICON.slides.replace('currentColor', '#D68A12')) +
      (t.kind === 'doc' ? 'Document' : 'Slides') + '</span>';
  }
  function outTag(t) { return '<span class="tag c-' + t.output + '">' + ICON[t.output] + outLabel(t) + '</span>'; }

  // A rendered thumbnail, or a drawn stand-in when the build had none.
  // Small previews (grid, collage) let 1x screens pick the smaller thumbnail;
  // eager ones are on screen at load (the collage), the rest wait for scrolling.
  function preview(t, opts) {
    opts = opts || {};
    var shape = shapeOf(t);
    var bar = shape === 'web' ? '<div class="pv-bar"><i></i><i></i><i></i></div>' : '';
    if (t.thumb) {
      var w = t.w || 640;
      var set = opts.small && t.thumb_sm ? ' srcset="' + esc(t.thumb_sm) + ' 360w, ' + esc(t.thumb) + ' ' + w + 'w"' +
        ' sizes="(max-width: 640px) 75vw, 260px"' : '';
      return '<div class="pv pv-' + shape + '">' + bar + '<img src="' + esc(t.thumb) + '"' + set + ' width="' + w +
        '" height="' + (t.h || 480) + '" alt="" loading="' + (opts.eager ? 'eager' : 'lazy') + '" decoding="async"></div>';
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
      return matchesQuery(t) && state.types[t.kind] && state.outs[t.output];
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

  // The collage: up to six of the templates matching the current filters,
  // picked by the seed, laid out on a loose grid. When fewer match, the grid
  // shrinks around them and stays centred rather than filling up with others.
  // Each tile is sized from its thumbnail's proportions so tall pages and wide
  // slides get a similar footprint, whatever the draw.
  function seeded() {
    var s = state.seed;
    return function () { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  }
  function collagePicks() {
    var rnd = seeded();
    var pool = TEMPLATES.slice();
    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1)); var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }
    var shown = visible();
    return pool.filter(function (t) { return shown.indexOf(t) > -1; }).slice(0, COLLAGE_MAX);
  }
  function collageKey() { return state.seed + ':' + collagePicks().map(function (t) { return t.id; }).join(','); }

  function renderCollage(animate) {
    var rnd = seeded();
    for (var i = 1; i < TEMPLATES.length; i++) rnd();  // skip past the draw, so the jitter matches it
    var picks = collagePicks();
    state.collage = collageKey();
    var order = picks.map(function (_, k) { return k; }).sort(function () { return rnd() - 0.5; });
    var html = picks.map(function (t, k) {
      var r = (k % 2 ? 1 : -1) * (2 + rnd() * 6);
      return '<button type="button" class="tile' + (animate ? ' entering' : '') + '" data-open="' + esc(t.id) + '" aria-label="Open ' + esc(t.title) +
        '" data-jx="' + (rnd() * 2 - 1).toFixed(3) + '" data-jy="' + (rnd() * 2 - 1).toFixed(3) +
        '" style="--r:' + r.toFixed(1) + 'deg;--d:' + (k * 60) + 'ms;z-index:' + (order[k] + 1) + '">' +
        '<div class="tile-frame">' + preview(t, { small: true, eager: true }) + '</div>' +
        '<span class="tile-sticker" style="background:' + STICKERS[k] + ';transform:rotate(' + (r > 0 ? -4 : 3) + 'deg)">' + esc(t.title) + '</span></button>';
    }).join('');
    var box = $('collage');
    box.querySelectorAll('.tile').forEach(function (n) { n.remove(); });
    box.insertAdjacentHTML('afterbegin', html);
    $('shuffle').hidden = !picks.length;
    layoutCollage();
  }

  function layoutCollage() {
    var box = $('collage'), tiles = box.querySelectorAll('.tile');
    var W = box.clientWidth, H = box.clientHeight - 16;  // room for the stickers below the bottom row
    var n = tiles.length;
    if (!n || !W) return;
    var rows = n > 3 ? 2 : 1, cols = Math.ceil(n / rows);
    // Cells are sized as for a full 3 x 2 collage, give or take, so fewer
    // tiles don't balloon to fill the space; the grid then sits centred.
    var fw = W / 3, fh = H / 2;
    var cw = Math.min(W / cols, fw * 1.3), ch = Math.min(H / rows, fh * 1.3), grow = 1.15;  // tiles may spill a little into their neighbours
    var x0 = (W - cols * cw) / 2, y0 = (H - rows * ch) / 2;
    var area = cw * ch * 0.64;  // every tile gets about the same area, whatever its shape
    tiles.forEach(function (el, k) {
      var t = byId(el.getAttribute('data-open'));
      var shape = shapeOf(t);
      var ratio = t.thumb && t.w ? t.h / t.w : { page: 1.414, slide: 0.5625, web: 0.75 }[shape];
      var chrome = 8 + (shape === 'web' ? 14 : 0);  // frame border, browser bar
      var w = Math.min(Math.sqrt(area / ratio), cw * grow, (ch * grow - chrome) / ratio + 8);
      var h = (w - 8) * ratio + chrome;
      var row = Math.floor(k / cols), col = k % cols;
      var inRow = Math.min(cols, n - row * cols);  // a short last row sits centred
      var cx = x0 + (col + 0.5 + (cols - inRow) / 2) * cw + (+el.getAttribute('data-jx')) * cw * 0.12 + (rows > 1 ? (row ? cw * 0.1 : -cw * 0.04) : 0);
      var cy = y0 + (row + 0.5) * ch + (+el.getAttribute('data-jy')) * ch * 0.1;
      var left = Math.max(0, Math.min(W - w, cx - w / 2));
      var top = Math.max(0, Math.min(H - h, cy - h / 2));
      el.style.left = (left / W * 100) + '%';
      el.style.top = top + 'px';
      el.style.width = (w / W * 100) + '%';
    });
  }

  function shuffle() {
    state.seed = (state.seed * 31 + 17) % 9973;
    var btn = $('shuffle');
    if (reducedMotion()) return renderCollage(false);
    btn.classList.remove('spin');
    void btn.offsetWidth;  // restart the icon's spin
    btn.classList.add('spin');
    swapCollage();
  }

  // Redraw the collage when the filters change which templates it shows.
  function refreshCollage() {
    if (state.collage === collageKey()) return;
    if (reducedMotion()) return renderCollage(false);
    swapCollage();
  }

  function swapCollage() {
    state.collage = collageKey();  // what the pending redraw will show
    $('collage').querySelectorAll('.tile').forEach(function (n) { n.classList.remove('entering'); n.classList.add('leaving'); });
    clearTimeout(shuffle.timer);
    shuffle.timer = setTimeout(function () { renderCollage(true); }, 200);
  }

  function renderQuick() {
    var byQuery = TEMPLATES.filter(matchesQuery);
    document.querySelectorAll('[data-quick]').forEach(function (b) {
      var p = b.getAttribute('data-quick').split(':'), kind = p[0], fmt = p[1];
      var on = state.types[kind] && state.outs[fmt];
      var only = on && !state.types[kind === 'doc' ? 'slides' : 'doc'] && !state.outs[fmt === 'pdf' ? 'html' : 'pdf'];
      var n = byQuery.filter(function (t) { return t.kind === kind && t.output === fmt; }).length;
      b.classList.toggle('off', !on);
      b.setAttribute('aria-pressed', only ? 'true' : 'false');
      b.setAttribute('aria-label', (kind === 'doc' ? 'Documents' : 'Slides') + ' as ' + fmt.toUpperCase() + ', ' + n + (n === 1 ? ' template' : ' templates'));
    });
  }

  // --- grid -----------------------------------------------------------------

  function card(t, i) {
    var shape = shapeOf(t);
    var pw = shape === 'page' ? '70%' : (shape === 'web' ? '72%' : '78%');
    var ty = shape === 'page' ? '0%' : '8%';
    var rot = i % 2 ? 2.5 : -2.5;
    return '<button type="button" class="card" data-open="' + esc(t.id) + '" aria-haspopup="dialog">' +
      '<div class="card-thumb dots' + (shape === 'page' ? ' is-page' : '') + '" style="background-color:' + TINT[t.kind] + '">' +
        '<div class="card-main" style="width:' + pw + ';transform:translate(0%,' + ty + ') rotate(' + rot + 'deg)">' + preview(t, { small: true }) + '</div>' +
        '<div class="tags">' + kindTag(t) + outTag(t) + '</div>' +
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
    refreshCollage();
  }

  // --- dialog ---------------------------------------------------------------

  // Setup instructions, as groups of steps (extensions get one per path).
  function setupGroups(t) {
    var yamlStep = { text: 'Set the front matter of your document', cmd: t.yaml, yaml: true };
    if (t.setup === 'builtin') {
      return [{ steps: [yamlStep, { text: 'Render', cmd: 'quarto render document.qmd' }] }];
    }
    if (t.setup === 'clone') {
      var name = t.repo.split('/')[1];
      var parts = t.file.split('/');
      var file = parts.pop();
      var s = [
        { text: 'Download the template', cmd: 'git clone https://github.com/' + t.repo + '.git' },
        { text: 'Go to its folder', cmd: 'cd ' + [name].concat(parts).join('/') }
      ];
      if (!t.native) s.push({ text: 'Set the front matter of ' + file, cmd: t.yaml, yaml: true });
      s.push({ text: 'Render it', cmd: 'quarto render ' + file });
      return [{ steps: s }];
    }
    if (t.setup === 'example') {
      // an example document for an extension that ships no template
      return [{ steps: [
        { text: 'Install the extension', cmd: 'quarto add ' + t.repo },
        yamlStep,
        { text: 'Render', cmd: 'quarto render document.qmd' }
      ] }];
    }
    var fresh = [{ text: 'Create a project from the template', cmd: 'quarto use template ' + t.repo }];
    if (!t.native) fresh.push({ text: 'Set the front matter of the new document', cmd: t.yaml, yaml: true });
    fresh.push({ text: 'Preview it', cmd: 'quarto preview' });
    return [
      { title: 'New project', steps: fresh },
      { title: 'Existing project', steps: [
        { text: 'Install the extension', cmd: 'quarto add ' + t.repo },
        yamlStep,
        { text: 'Render', cmd: 'quarto render document.qmd' }
      ] }
    ];
  }

  function renderDialog() {
    var modal = $('modal');
    closePdf();
    var t = byId(state.open);
    if (!t) {
      modal.hidden = true;
      modal.innerHTML = '';
      document.body.classList.remove('modal-open');
      return;
    }
    var list = visible().some(function (v) { return v.id === t.id; }) ? visible() : TEMPLATES;
    var idx = Math.max(0, list.indexOf(t));
    var shape = shapeOf(t);
    var pdf = t.output === 'pdf';

    var h = '';
    h += '<button type="button" class="backdrop" data-close tabindex="-1" aria-label="Close"></button>';
    var nav = list.length > 1;
    h += '<div class="shell">';
    if (nav) h += '<button type="button" class="nav nav-prev pop" data-step="-1" aria-label="Previous template"><svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3L5 8l5 5"/></svg></button>';
    h += '<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title">';

    // stage
    h += '<section class="stage dots" aria-label="Rendered output" style="background-color:' + TINT[t.output] + '">';
    h += '<div class="stage-top"><span class="outchip">' + ICON[t.output].replace('currentColor', pdf ? '#E8505B' : '#3B7BF6') +
      esc(outLabel(t)) + '</span>';
    if (pdf) {
      // left is full size; sliding right shrinks the pages
      h += '<label class="zoom" title="Page size">' + ICON.page +
        '<input type="range" min="' + ZOOM_MIN + '" max="100" step="1" value="' + (100 + ZOOM_MIN - state.zoom) + '" data-zoom aria-label="Shrink pages">' +
        ICON.spread + '</label>';
    }
    h += '<a class="btn-small open-out" href="' + esc(t.url) + '" target="_blank" rel="noopener">Open in new tab' + ICON.external + '</a>';
    if (t.source) {
      h += '<div class="tabs" role="group" aria-label="Show">' + [['output', 'Output'], ['source', 'Source']].map(function (b) {
        return '<button type="button" data-tab="' + b[0] + '" aria-pressed="false">' + b[1] + '</button>';
      }).join('') + '</div>';
    }
    h += '</div>';
    h += '<div class="stage-body' + (pdf ? ' is-pdf' : '') + '">';
    if (pdf) {
      h += '<div class="pdf-view pane-out" tabindex="0" aria-label="' + esc(t.title) + ' (PDF)"></div>';
    } else {
      h += '<div class="stage-fit pane-out"><div class="frame' + (shape === 'slide' ? ' is-slide' : '') + '">';
      h += '<iframe src="' + esc(t.url) + '" title="' + esc(t.title) + ' (HTML)" loading="lazy"></iframe>';
      h += '<a class="frame-img" href="' + esc(t.url) + '" target="_blank" rel="noopener" aria-label="Open the rendered HTML">' + preview(t) + '</a>';
      h += '</div></div>';
    }
    if (t.source) h += '<div class="src-view" hidden></div>';
    h += '<span class="position">' + (idx + 1) + ' / ' + list.length + '</span>';
    h += '</div></section>';

    h += '<aside class="aside"></aside></div>';
    if (nav) h += '<button type="button" class="nav nav-next pop" data-step="1" aria-label="Next template"><svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3l5 5-5 5"/></svg></button>';
    h += '</div>';

    modal.innerHTML = h;
    modal.hidden = false;
    modal._list = list;
    modal._idx = idx;
    document.body.classList.add('modal-open');
    renderAside(t);
    if (pdf) openPdf(modal.querySelector('.pdf-view'), t);
    else quietDeck(modal.querySelector('.frame iframe'));
    applyTab(t);
  }

  // Quarto decks write each slide into their URL (reveal.js `hash`/`history`), which pushes
  // a history entry per slide and makes the preview flicker; keep the embedded deck's URL still.
  function quietDeck(iframe) {
    iframe.addEventListener('load', function () {
      try {
        var R = iframe.contentWindow.Reveal;
        if (R && R.configure) R.configure({ hash: false, history: false });
      } catch (e) { /* not same-origin */ }
    });
  }

  // Switch the stage between the rendered output and its source, keeping both alive.
  function applyTab(t) {
    var modal = $('modal'), src = modal.querySelector('.src-view');
    var showSrc = state.tab === 'source' && !!src;
    modal.querySelector('.pane-out').hidden = showSrc;
    modal.querySelector('.stage-body').classList.toggle('is-src', showSrc);
    modal.querySelector('.open-out').hidden = showSrc;
    var zoom = modal.querySelector('.zoom');
    if (zoom) zoom.hidden = showSrc || !modal.querySelector('.pdf-view');
    modal.querySelectorAll('[data-tab]').forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-tab') === (showSrc ? 'source' : 'output') ? 'true' : 'false');
    });
    if (!src) return;
    src.hidden = !showSrc;
    if (showSrc && !src.firstChild) loadSource(src, t);
  }

  // --- source view --------------------------------------------------------------
  // The code is one plain <pre>, and the line numbers sit in a separate column drawn
  // with CSS, so selecting text and copying gives exactly the source.

  function loadSource(box, t) {
    var head = '<div class="src-head"><span class="src-name">' + esc(t.source_name || 'source.qmd') + '</span>';
    box.innerHTML = '<div class="src-card">' + head + '</div><div class="src-msg">Loading…</div></div>';
    fetch(t.source).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.text();
    }).then(function (text) {
      if (state.open !== t.id) return;
      var lines = window.highlightQmd(text);
      box._text = text;
      box.innerHTML = '<div class="src-card">' + head +
        '<button type="button" class="src-copy" data-src-copy>' + ICON.copy + '<span>Copy</span></button></div>' +
        '<div class="src-code"><div class="src-gutter" aria-hidden="true">' +
        lines.map(function (_, i) { return '<span data-n="' + (i + 1) + '"></span>'; }).join('') +
        '</div><pre class="src-pre" tabindex="0" aria-label="Source of ' + esc(t.title) + '"><code>' + lines.join('\n') + '\n</code></pre></div></div>';
    }).catch(function () {
      if (state.open !== t.id) return;
      box.querySelector('.src-msg').textContent = 'The source could not be loaded.';
    });
  }

  function renderAside(t) {
    var cmds = [];
    var h = '';
    h += '<div class="aside-head"><div class="tags">';
    h += '<span class="tag tinted c-' + t.kind + '">' + (t.kind === 'doc' ? ICON.doc : ICON.slides) + (t.kind === 'doc' ? 'Document' : 'Slides') + '</span>';
    h += t.builtin ? '<span class="tag">' + ICON.builtin.replace('2.2', '2.6').replace(/16/g, '14') + 'Built-in</span>'
                   : '<span class="tag">' + ICON.ext.replace('2.2', '2.6').replace(/16/g, '14') + 'Extension</span>';
    h += '</div><button type="button" class="close" data-close aria-label="Close"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15"/></svg></button></div>';

    h += '<div class="titles"><h2 id="dlg-title">' + esc(t.title) + '</h2>' +
      '<a class="origin-line" href="' + esc(t.src) + '" target="_blank" rel="noopener">' +
      (/^https:\/\/github\.com\//.test(t.src) ? ICON.github : '') + '<span class="origin-text">' + esc(t.origin) + ICON.external + '</span></a>' +
      (t.description ? '<p>' + esc(t.description) + '</p>' : '') + '</div>';

    h += '<div class="setup"><div class="setup-head"><h3>' + ICON.terminal + 'Set it up</h3>' +
      (t.builtin ? '<span class="pill">Nothing to install</span>' : '') + '</div>';
    setupGroups(t).forEach(function (g) {
      if (g.title) h += '<h4 class="path-title">' + esc(g.title) + '</h4>';
      h += '<ol class="steps">';
      g.steps.forEach(function (s, i) {
        h += '<li><span class="step-text"><span class="step-n">' + (i + 1) + '</span>' + esc(s.text) + '</span>' +
          '<div class="cmd' + (s.yaml ? ' cmd-yaml' : '') + '">' + (s.yaml ? '' : '<span class="cmd-prompt">$</span>') +
          '<code>' + esc(s.cmd) + '</code>' +
          '<button type="button" class="copy" data-copy="' + cmds.length + '" aria-label="Copy: ' + esc(s.cmd) + '">' + ICON.copy + '</button></div></li>';
        cmds.push(s.cmd);
      });
      h += '</ol>';
    });
    h += '</div>';

    h += '<div class="aside-foot"><a class="btn-primary pop" href="' + esc(t.src) + '" target="_blank" rel="noopener">' +
      (t.builtin ? ICON.book + 'Read the docs' : ICON.code + 'View source') + '</a>';
    h += '<span class="meta">Rendered ' + esc(t.rendered || '') + ' with Quarto ' + esc(DATA.quarto) +
      (t.rev ? ' from <a href="https://github.com/' + esc(t.repo) + '/commit/' + esc(t.rev) + '" target="_blank" rel="noopener">' + esc(t.rev.slice(0, 7)) + '</a>' : '') + '</span>';
    h += '</div>';

    $('modal').querySelector('.aside').innerHTML = h;
    $('modal')._cmds = cmds;
  }

  // --- PDF viewer -------------------------------------------------------------
  // pdf.js draws the pages straight onto the stage: no toolbar, just pages to scroll.

  var pdfjs = null;     // promise of the pdf.js library, loaded on first use
  var pdfWorker = null; // one worker for every PDF, rather than starting one per document
  var viewer = null;    // the PDF on the stage: { task, observer }

  function loadPdfjs() {
    if (!pdfjs) {
      pdfjs = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = PDFJS + 'pdf.min.js';
        s.onload = function () {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
          resolve(window.pdfjsLib);
        };
        s.onerror = function () { pdfjs = null; s.remove(); reject(new Error('pdf.js failed to load')); };
        document.head.appendChild(s);
      });
    }
    return pdfjs;
  }

  function closePdf() {
    if (!viewer) return;
    if (viewer.observer) viewer.observer.disconnect();
    if (viewer.task) viewer.task.destroy();
    viewer = null;
  }

  // Size the pages: the slider scales them down from filling the stage, and at its
  // bottom end they pair up two to a row for skimming. The reading position is kept.
  function applyZoom(box) {
    var spread = state.zoom <= ZOOM_MIN + 1;
    var at = box.scrollHeight > box.clientHeight ? box.scrollTop / (box.scrollHeight - box.clientHeight) : 0;
    box.style.setProperty('--zoom', state.zoom / 100);
    box.classList.toggle('is-spread', spread);
    box.scrollTop = at * (box.scrollHeight - box.clientHeight);
    // pages drawn while smaller than they are now get redrawn sharper, once the slider settles
    clearTimeout(box._redraw);
    box._redraw = setTimeout(function () {
      if (!viewer || !viewer.observer) return;
      box.querySelectorAll('.pdf-page').forEach(function (el) {
        if (el._drawn && el._drawW && el.clientWidth > el._drawW * 1.15) {
          el._drawn = false;
          viewer.observer.observe(el);
        }
      });
    }, 250);
  }

  function openPdf(box, t) {
    var v = viewer = {};
    applyZoom(box);
    loadPdfjs().then(function (lib) {
      if (viewer !== v) return null;
      if (!pdfWorker) pdfWorker = new lib.PDFWorker();
      v.task = lib.getDocument({ url: t.url, worker: pdfWorker });
      return v.task.promise;
    }).then(function (doc) {
      if (!doc || viewer !== v) return;
      return doc.getPage(1).then(function (first) {
        if (viewer !== v) return;
        var vp = first.getViewport({ scale: 1 });
        var pages = [];
        for (var i = 1; i <= doc.numPages; i++) {
          var el = document.createElement('div');
          el.className = 'pdf-page';
          el.style.aspectRatio = vp.width + ' / ' + vp.height;  // until the page itself is loaded
          if (vp.width > vp.height) el.classList.add('is-wide');
          el._n = i;
          box.appendChild(el);
          pages.push(el);
        }
        // Draw pages as they come near the viewport.
        v.observer = new IntersectionObserver(function (entries) {
          entries.forEach(function (e) {
            if (!e.isIntersecting || e.target._drawn) return;
            e.target._drawn = true;
            v.observer.unobserve(e.target);
            drawPage(doc, e.target, v);
          });
        }, { root: box, rootMargin: '800px 0px' });
        pages.forEach(function (el) { v.observer.observe(el); });
      });
    }).catch(function (err) {
      if (viewer !== v) return;
      // pdf.js unavailable (offline, blocked CDN): fall back to the browser's own viewer.
      if (window.console) console.warn(err);
      var zoom = document.querySelector('#modal .zoom');
      if (zoom) zoom.remove();
      box.outerHTML = '<div class="stage-fit pane-out"' + (box.hidden ? ' hidden' : '') + '><div class="frame"><iframe src="' + esc(t.url) + '#view=FitH" title="' + esc(t.title) + ' (PDF)"></iframe>' +
        '<a class="frame-img" href="' + esc(t.url) + '" target="_blank" rel="noopener" aria-label="Open the rendered PDF">' + preview(t) + '</a></div></div>';
    });
  }

  function drawPage(doc, el, v) {
    doc.getPage(el._n).then(function (page) {
      if (viewer !== v) return;
      var base = page.getViewport({ scale: 1 });
      el.style.aspectRatio = base.width + ' / ' + base.height;
      var dpr = Math.min(window.devicePixelRatio || 1, 3);
      var w = el.clientWidth;
      var vp = page.getViewport({ scale: Math.max(w, 300) * dpr / base.width });
      var canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      return page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise.then(function () {
        if (viewer !== v) return;
        var old = el.querySelector('canvas');
        if (old) el.replaceChild(canvas, old); else el.appendChild(canvas);
        el._drawW = w;
      });
    }).catch(function () { el._drawn = false; });
  }

  function open(id, tab) {
    if (!state.open) lastFocus = document.activeElement;
    state.open = id;
    state.tab = tab === 'source' ? 'source' : 'output';
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
    renderDialog();
    syncHash();
    var btn = document.querySelector('#modal [data-step="' + delta + '"]');
    if (btn) btn.focus();
  }

  // Deep links: #<id>, or #<id>/source for the source view
  function syncHash() {
    var h = state.open ? '#' + state.open + (state.tab === 'source' && byId(state.open).source ? '/source' : '') : ' ';
    if (location.hash !== h) history.replaceState(null, '', h === ' ' ? location.pathname + location.search : h);
  }
  function fromHash() {
    // (older links may carry a format instead: #<id>/<format>)
    var parts = decodeURIComponent(location.hash.slice(1)).split('/');
    if (parts[0] && byId(parts[0])) {
      if (parts[0] === state.open) { state.tab = parts[1] === 'source' ? 'source' : 'output'; applyTab(byId(state.open)); }
      else open(parts[0], parts[1]);
    }
    else if (state.open) close();
  }

  // --- events ---------------------------------------------------------------

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-open],[data-toggle],[data-quick],[data-close],[data-step],[data-copy],[data-tab],[data-src-copy]');
    if (!el) return;
    if (el.hasAttribute('data-open')) return open(el.getAttribute('data-open'));
    if (el.hasAttribute('data-close')) return close();
    if (el.hasAttribute('data-tab')) { state.tab = el.getAttribute('data-tab'); applyTab(byId(state.open)); return syncHash(); }
    if (el.hasAttribute('data-src-copy')) {
      copyText(el.closest('.src-view')._text);
      el.classList.add('done');
      el.innerHTML = ICON.check + '<span>Copied</span>';
      clearTimeout(el._timer);
      el._timer = setTimeout(function () {
        el.classList.remove('done');
        el.innerHTML = ICON.copy + '<span>Copy</span>';
      }, 1600);
      return;
    }
    if (el.hasAttribute('data-step')) return step(+el.getAttribute('data-step'));
    if (el.hasAttribute('data-copy')) {
      var cmd = $('modal')._cmds[+el.getAttribute('data-copy')];
      copyText(cmd);
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

  document.addEventListener('input', function (e) {
    if (!e.target.hasAttribute('data-zoom')) return;
    state.zoom = 100 + ZOOM_MIN - e.target.value;
    var box = document.querySelector('#modal .pdf-view');
    if (box) applyZoom(box);
  });
  $('q').addEventListener('input', function (e) { state.query = e.target.value; renderList(); });
  $('clear').addEventListener('click', resetFilters);
  $('empty-clear').addEventListener('click', resetFilters);
  $('shuffle').addEventListener('click', shuffle);
  var resizeTimer;
  window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(layoutCollage, 100); });

  document.addEventListener('keydown', function (e) {
    if (!state.open) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
      if ($('modal')._list.length > 1) { e.preventDefault(); step(e.key === 'ArrowLeft' ? -1 : 1); }
    } else if (e.key === 'Tab') {
      // keep focus inside the dialog
      var f = Array.prototype.filter.call($('modal').querySelectorAll('.nav, .dialog a[href], .dialog button, .dialog iframe, .dialog .pdf-view, .dialog .src-pre'), function (n) { return n.getClientRects().length > 0; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  window.addEventListener('hashchange', fromHash);

  renderCollage(true);
  renderList();
  if (document.fonts) document.fonts.ready.then(layoutCollage);  // the hero's height settles once fonts load
  fromHash();
})();
