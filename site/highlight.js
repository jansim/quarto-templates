// A small syntax highlighter for Quarto documents: YAML front matter, Markdown
// with Pandoc/Quarto extensions (divs, attributes, shortcodes, math, cross
// references) and code chunks. highlightQmd(text) returns one HTML string per
// line, so the viewer can number and select lines.
(function () {
  'use strict';

  function esc(s) {
    return s.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  function span(cls, s) { return '<span class="hl-' + cls + '">' + esc(s) + '</span>'; }

  // Run a list of [class, regex] rules over a string: at each position the
  // earliest match wins (ties go to the earlier rule); unmatched text is plain.
  // A class may be a function returning the match's HTML.
  function tokenize(text, rules) {
    var out = '', pos = 0;
    while (pos < text.length) {
      var best = null;
      for (var i = 0; i < rules.length; i++) {
        var re = rules[i][1];
        re.lastIndex = pos;
        var m = re.exec(text);
        if (m && m[0] && (!best || m.index < best.m.index)) best = { m: m, rule: rules[i] };
      }
      if (!best) break;
      out += esc(text.slice(pos, best.m.index));
      var cls = best.rule[0];
      out += typeof cls === 'function' ? cls(best.m) : span(cls, best.m[0]);
      pos = best.m.index + best.m[0].length;
    }
    return out + esc(text.slice(pos));
  }

  // --- YAML -------------------------------------------------------------------

  var YAML_VALUE = [
    ['comment', /(^|\s)#.*$/g],
    ['string', /"(?:[^"\\]|\\.)*"?|'(?:[^']|'')*'?/g],
    ['number', /\b\d[\d.:-]*\b/g],
    ['literal', /\b(?:true|false|null|yes|no)\b|[|>][-+]?\s*$/g]
  ];
  function yaml(line) {
    var m = /^(\s*(?:-\s+)*)([^\s#:"'][^:#]*?|"[^"]*"|'[^']*')(\s*:)(?=\s|$)(.*)$/.exec(line);
    if (m) return esc(m[1]) + span('key', m[2]) + esc(m[3]) + tokenize(m[4], YAML_VALUE);
    return tokenize(line, YAML_VALUE);
  }

  // --- code chunks --------------------------------------------------------------

  var KEYWORDS = /\b(?:if|else|elif|for|while|repeat|in|function|return|def|class|import|from|as|with|try|except|finally|raise|lambda|yield|break|next|continue|pass|library|require|TRUE|FALSE|NULL|NA|Inf|NaN|True|False|None|and|or|not|is|let|const|var|new|this|end|using|module)\b/g;
  var COMMENT = {
    js: /\/\/.*$/g, ojs: /\/\/.*$/g, javascript: /\/\/.*$/g, typescript: /\/\/.*$/g, c: /\/\/.*$/g, cpp: /\/\/.*$/g,
    java: /\/\/.*$/g, rust: /\/\/.*$/g, go: /\/\/.*$/g, typst: /\/\/.*$/g, sql: /--.*$/g, latex: /%.*$/g, tex: /%.*$/g,
    mermaid: /%%.*$/g, dot: /\/\/.*$/g, css: /\/\*.*?\*\//g, scss: /\/\/.*$/g
  };
  function code(line, lang) {
    if (/^\s*(#\||\/\/\|)/.test(line)) {
      // chunk option, e.g. "#| echo: false"
      var m = /^(\s*(?:#\||\/\/\|)\s?)(.*)$/.exec(line);
      return span('punct', m[1]) + yaml(m[2]);
    }
    if (lang === 'yaml') return yaml(line);
    return tokenize(line, [
      ['comment', COMMENT[lang] || /#.*$/g],
      ['string', /"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`[^`]*`?/g],
      ['number', /\b\d+(?:\.\d+)?(?:e[+-]?\d+)?L?\b/gi],
      ['keyword', KEYWORDS],
      ['fn', lang === 'r' ? /\b[A-Za-z_.][\w.]*(?=\s*\()/g : /\b[A-Za-z_]\w*(?=\s*\()/g],  // R names may contain dots
      ['op', /<-|->|\|>|%>%|[=!<>]=|[+\-*/^=<>]/g]
    ]);
  }

  // --- Markdown -----------------------------------------------------------------

  function attrs(m) { return span('attr', m[0]); }
  var INLINE = [
    ['comment', /<!--.*?(?:-->|$)/g],
    ['code', /(`+)[^`]+?\1(?:\{[^}]*\})?/g],
    ['shortcode', /\{\{<.*?>\}\}/g],
    ['math', /\$\$.*?\$\$|\$(?=\S)(?:[^$\\]|\\.)+?\$(?!\d)/g],
    [function (m) { return span('link', m[1]) + span('url', m[2]) + (m[3] ? span('attr', m[3]) : ''); },
      /(!?\[(?:[^\]\\]|\\.)*\])(\([^)]*\))(\{[^}]*\})?/g],
    ['ref', /\[?-?@[\w:.#$%&+?<>~\/-]*\w\]?/g],
    [attrs, /\[[^\]]+\]\{[^}]*\}|\{[#.][^}]*\}|\{[\w-]+=[^}]*\}/g],
    ['strong', /\*\*(?=\S)[^*]+?\*\*|__(?=\S)[^_]+?__/g],
    ['em', /\*(?=\S)[^*]+?\*|\b_(?=\S)[^_]+?_\b/g],
    ['latex', /\\[A-Za-z]+/g],
    ['html', /<\/?[A-Za-z][^>]*>/g]
  ];
  function inline(text) { return tokenize(text, INLINE); }

  function markdown(line) {
    var m;
    if ((m = /^(#{1,6}\s)(.*?)(\s*\{[^}]*\})?\s*$/.exec(line))) {
      return span('heading', m[1]) + '<span class="hl-heading">' + inline(m[2]) + '</span>' + (m[3] ? span('attr', m[3]) : '');
    }
    if ((m = /^(\s*:{3,})(.*)$/.exec(line))) return span('div', m[1]) + span('attr', m[2]);
    if ((m = /^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/.exec(line))) return esc(m[1]) + span('punct', m[2]) + esc(m[3]) + inline(m[4]);
    if ((m = /^(\s*>+)(.*)$/.exec(line))) return span('punct', m[1]) + '<span class="hl-quote">' + inline(m[2]) + '</span>';
    if (/^\s*\|.*\|\s*$/.test(line)) return tokenize(line, [['punct', /[|:]?-{2,}:?|\|/g], ['code', /`[^`]+`/g], ['math', /\$[^$]+\$/g]]);
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return span('punct', line);
    if ((m = /^(:\s)(.*)$/.exec(line))) return span('punct', m[1]) + inline(m[2]);  // table/figure caption
    return inline(line);
  }

  // --- document -------------------------------------------------------------------

  window.highlightQmd = function (text) {
    var lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
    var out = [];
    var mode = /^---\s*$/.test(lines[0]) ? 'front' : 'md';
    var fence = null, lang = '';
    var block = -1;  // indent of a YAML key whose value is a block scalar (| or >) that continues
    lines.forEach(function (line, i) {
      var m;
      if (mode === 'front') {
        if (i > 0 && /^(---|\.\.\.)\s*$/.test(line)) { out.push(span('punct', line)); mode = 'md'; }
        else if (i === 0) out.push(span('punct', line));
        else if (block >= 0 && (!line.trim() || line.search(/\S/) > block)) out.push(span('string', line));
        else {
          out.push(yaml(line));
          block = /:\s*[|>][-+]?\d*\s*(#.*)?$/.test(line) ? line.search(/\S/) : -1;
        }
      } else if (mode === 'code') {
        if (line.trim().indexOf(fence) === 0 && /^\s*[`~]+\s*$/.test(line)) { out.push(span('fence', line)); mode = 'md'; }
        else out.push(code(line, lang));
      } else if (mode === 'math') {
        if ((m = /^(.*?\$\$)(.*)$/.exec(line))) { out.push(span('math', m[1]) + markdown(m[2])); mode = 'md'; }
        else out.push(span('math', line));
      } else if (mode === 'comment') {
        if ((m = /^(.*?-->)(.*)$/.exec(line))) { out.push(span('comment', m[1]) + markdown(m[2])); mode = 'md'; }
        else out.push(span('comment', line));
      } else if ((m = /^(\s*)(`{3,}|~{3,})\s*(\{[^}]*\}|[\w.+-]+)?(.*)$/.exec(line))) {
        fence = m[2];
        lang = (m[3] || '').replace(/^\{=?\.?/, '').split(/[\s,}]/)[0].toLowerCase();
        out.push(esc(m[1]) + span('fence', m[2]) + (m[3] ? span('lang', m[3]) : '') + span('attr', m[4]));
        mode = 'code';
      } else if (/^\s*\$\$\s*$/.test(line) || (/^\s*\$\$/.test(line) && !/\$\$.*\$\$/.test(line))) {
        out.push(span('math', line));
        mode = 'math';
      } else if (/<!--/.test(line) && !/<!--.*-->/.test(line)) {
        var at = line.indexOf('<!--');
        out.push(markdown(line.slice(0, at)) + span('comment', line.slice(at)));
        mode = 'comment';
      } else {
        out.push(markdown(line));
      }
    });
    return out;
  };
})();
