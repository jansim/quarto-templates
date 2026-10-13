#!/usr/bin/env python3
"""Render every template in templates.toml and build the gallery site.

    python build.py                 # build _site/, re-rendering only what changed
    python build.py --only riso pdf # render just these entries (others from cache)
    python build.py --force         # ignore the render cache

Each entry is rendered in a scratch copy of its source, its outputs and
thumbnails are stored under .cache/renders/<id>/, and the site in site/ is
copied to _site/ with the collected template data inlined.

An entry is re-rendered only when its cache key changes. The key covers the
entry's config, the source repo's commit, the Quarto version and, for
built-in formats, the sample documents.
"""

from __future__ import annotations

import argparse
import base64
import fnmatch
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import tomllib
import urllib.parse
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / "templates.toml"
SAMPLES = ROOT / "samples"
SITE_SRC = ROOT / "site"
CACHE = ROOT / ".cache"

# Bump to invalidate every cached render (e.g. after changing how renders work).
RENDER_VERSION = "2"

# Base format -> (kind, output). Extension formats are "<name>-<base>".
BASE_FORMATS = {
    "html": ("doc", "html"),
    "pdf": ("doc", "pdf"),
    "typst": ("doc", "pdf"),
    "revealjs": ("slides", "html"),
    "beamer": ("slides", "pdf"),
}
DOCS = {
    "html": "https://quarto.org/docs/output-formats/html-basics.html",
    "pdf": "https://quarto.org/docs/output-formats/pdf-basics.html",
    "typst": "https://quarto.org/docs/output-formats/typst.html",
    "revealjs": "https://quarto.org/docs/presentations/revealjs/",
    "beamer": "https://quarto.org/docs/presentations/beamer.html",
}
# Base format -> the system that typesets it (None: HTML, no typesetting).
ENGINES = {"pdf": "latex", "beamer": "latex", "typst": "typst"}
RENDER_TIMEOUT = 20 * 60
THUMB_WIDTH = 640
THUMB_QUALITY = 80  # WebP


def log(msg: str) -> None:
    print(msg, flush=True)


def run(cmd: list[str], cwd: Path | None = None, timeout: int | None = None) -> str:
    """Run a command, returning its combined output; raise with that output on failure."""
    proc = subprocess.run(
        cmd, cwd=cwd, timeout=timeout, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"`{' '.join(cmd)}` failed:\n{proc.stdout[-6000:]}")
    return proc.stdout


# --- config -----------------------------------------------------------------


def base_of(fmt: str) -> str:
    base = fmt.rsplit("-", 1)[-1]
    if base not in BASE_FORMATS:
        raise ValueError(f"unsupported format {fmt!r} (base format must be one of {', '.join(BASE_FORMATS)})")
    return base


def load_config() -> list[dict]:
    with CONFIG.open("rb") as f:
        raw = tomllib.load(f)
    entries = []
    for tid, e in raw.items():
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", tid):
            raise ValueError(f"[{tid}]: ids may only contain a-z, 0-9, - and _")
        for key in ("title", "format"):
            if key not in e:
                raise ValueError(f"[{tid}]: missing required key {key!r}")
        if not isinstance(e["format"], str):
            raise ValueError(f"[{tid}]: format must be a single format; add one entry per format")
        kind = e.get("kind", BASE_FORMATS[base_of(e["format"])][0])
        if kind not in ("doc", "slides"):
            raise ValueError(f"[{tid}]: kind must be 'doc' or 'slides'")
        repo = e.get("repo")
        if repo and not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
            raise ValueError(f"[{tid}]: repo must look like 'owner/name'")
        remove = e.get("remove-options", [])
        if not (isinstance(remove, list) and all(isinstance(k, str) for k in remove)):
            raise ValueError(f"[{tid}]: remove-options must be a list of option names")
        replace = e.get("replace", [])
        if not (isinstance(replace, list) and all(
                isinstance(r, list) and len(r) == 2 and all(isinstance(x, str) for x in r) and r[0]
                for r in replace)):
            raise ValueError(f"[{tid}]: replace must be a list of [old, new] string pairs")
        builtin = repo is None
        if builtin:
            file = e.get("file") or ("slides.qmd" if kind == "slides" else "document.qmd")
        else:
            file = e.get("file", "template.qmd")
        entries.append({
            "id": tid,
            "title": e["title"],
            "format": e["format"],
            "repo": repo,
            "ref": e.get("ref"),
            "file": file,
            "options": e.get("options") or {},
            "remove_options": remove,
            "replace": replace,
            "description": e.get("description", ""),
            "preview_page": int(e.get("preview-page", 1)),
            "builtin": builtin,
            "kind": kind,
        })
    return entries


# --- sources ----------------------------------------------------------------


def repo_url(repo: str) -> str:
    return f"https://github.com/{repo}.git"


_revisions: dict[tuple, str] = {}


def remote_revision(repo: str, ref: str | None) -> str:
    """Commit the repo's ref currently points to (cheap: no clone)."""
    key = (repo, ref)
    if key not in _revisions:
        out = run(["git", "ls-remote", repo_url(repo), ref or "HEAD"], timeout=120)
        lines = [l.split() for l in out.splitlines() if l.strip()]
        if not lines:
            raise RuntimeError(f"{repo}: ref {ref or 'HEAD'!r} not found")
        # Prefer a peeled tag (^{}) if present.
        peeled = [l[0] for l in lines if l[1].endswith("^{}")]
        _revisions[key] = peeled[0] if peeled else lines[0][0]
    return _revisions[key]


def checkout(repo: str, ref: str | None, rev: str) -> Path:
    """Shallow clone of repo at rev, reused across entries and builds."""
    dest = CACHE / "repos" / repo.replace("/", "__")
    if dest.exists():
        head = run(["git", "rev-parse", "HEAD"], cwd=dest).strip()
        if head == rev:
            return dest
        shutil.rmtree(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["git", "clone", "--quiet", "--depth", "1"]
    if ref:
        cmd += ["--branch", ref]
    run(cmd + [repo_url(repo), str(dest)], timeout=600)
    return dest


def apply_quartoignore(workdir: Path) -> None:
    """Drop files `quarto use template` would not copy (see .quartoignore).

    The extension is installed separately and never filtered, so _extensions/
    is left alone.
    """
    ignore = workdir / ".quartoignore"
    if not ignore.exists():
        return
    patterns = [l.strip() for l in ignore.read_text().splitlines() if l.strip() and not l.startswith("#")]
    # "!pattern" keeps files an earlier pattern would drop
    keep = [p[1:].strip("/") for p in patterns if p.startswith("!")]

    def matches(path: Path, rel: str, pattern: str) -> bool:
        return fnmatch.fnmatch(rel, pattern) or ("/" not in pattern and fnmatch.fnmatch(path.name, pattern))

    for pattern in patterns:
        if pattern.startswith("!"):
            continue
        pattern = pattern.strip("/")
        for path in list(workdir.rglob("*")):
            rel = path.relative_to(workdir).as_posix()
            if rel.split("/")[0] == "_extensions":
                continue
            if matches(path, rel, pattern) and not any(matches(path, rel, k) for k in keep):
                if path.is_dir():
                    shutil.rmtree(path, ignore_errors=True)
                elif path.exists():
                    path.unlink()


# --- rendering --------------------------------------------------------------


_quarto_version: str | None = None


def quarto_version() -> str:
    global _quarto_version
    if _quarto_version is None:
        _quarto_version = run(["quarto", "--version"]).strip()
    return _quarto_version


_latex_checked = False


def ensure_latex() -> None:
    global _latex_checked
    if _latex_checked:
        return
    _latex_checked = True
    has_tex = any(shutil.which(t) for t in ("xelatex", "lualatex", "pdflatex"))
    if not has_tex and not (Path.home() / ".TinyTeX").exists():
        log("  installing TinyTeX (first LaTeX render)")
        run(["quarto", "install", "tinytex", "--no-prompt"], timeout=1200)


def deep_merge(base: dict, extra: dict) -> dict:
    out = dict(base)
    for k, v in extra.items():
        out[k] = deep_merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


FRONT_MATTER = re.compile(r"\A---[ \t]*\n(.*?\n)---[ \t]*\n", re.S)


def declared_formats(doc: Path) -> list[str]:
    """Formats listed in a document's front matter."""
    m = FRONT_MATTER.match(doc.read_text(encoding="utf-8"))
    try:
        meta = (yaml.safe_load(m.group(1)) if m else None) or {}
    except yaml.YAMLError:
        return []
    formats = meta.get("format") if isinstance(meta, dict) else None
    if isinstance(formats, str):
        return [formats]
    return [str(f) for f in formats] if isinstance(formats, (list, dict)) else []


def remove_option(options: dict, path: str) -> None:
    """Delete a dotted key path (e.g. "titlepage-theme.vrule-color") if present."""
    *parents, last = path.split(".")
    for key in parents:
        options = options.get(key)
        if not isinstance(options, dict):
            return
    options.pop(last, None)


def with_options(src: Path, fmt: str, options: dict, remove: list[str]) -> Path:
    """Copy of src with options merged into, and the keys in remove dropped from, format fmt's front matter."""
    text = src.read_text(encoding="utf-8")
    m = FRONT_MATTER.match(text)
    meta = (yaml.safe_load(m.group(1)) if m else None) or {}
    body = text[m.end():] if m else text
    formats = meta.get("format")
    if isinstance(formats, str):
        formats = {formats: "default"}
    elif isinstance(formats, list):
        formats = {f: "default" for f in formats}
    elif not isinstance(formats, dict):
        formats = {}
    current = formats.get(fmt)
    formats[fmt] = deep_merge(current if isinstance(current, dict) else {}, options)
    for path in remove:
        remove_option(formats[fmt], path)
    meta["format"] = formats
    dumped = yaml.safe_dump(meta, sort_keys=False, allow_unicode=True, width=1000)
    dest = src.with_name(f"gallery-{src.stem}.qmd")
    dest.write_text(f"---\n{dumped}---\n{body}", encoding="utf-8")
    return dest


SOURCE_NAME = "source.qmd"


def apply_replacements(doc: Path, replace: list[list[str]]) -> None:
    """Replace text in doc, e.g. to swap a code chunk for one with fewer dependencies.

    Every occurrence is replaced; trailing whitespace on a line doesn't affect matching.
    A `*` in old matches any text, across lines (`\\*` is a literal asterisk).
    """
    text = doc.read_text(encoding="utf-8")
    for old, new in replace:
        pattern = ".*?".join(
            r"[ \t]*\n".join(re.escape(line.rstrip()) for line in part.replace(r"\*", "*").split("\n"))
            for part in re.split(r"(?<!\\)\*", old)
        )
        text, n = re.subn(pattern, lambda _: new, text, flags=re.S)
        if not n:
            # upstream changed: fail rather than render something unintended
            raise ValueError(f"replace: {old.splitlines()[0]!r}... not found in {doc.name}")
    doc.write_text(text, encoding="utf-8")


def install_extensions(source: Path, workdir: Path, owner: str) -> bool:
    """Install the repo's root extensions into workdir where `quarto add` and
    `quarto use template` put them: _extensions/<owner>/<name>. Returns whether
    there were any."""
    src = source / "_extensions"
    if not src.is_dir():
        return False
    dest = workdir / "_extensions"
    shutil.rmtree(dest, ignore_errors=True)
    for ext in (d for d in src.iterdir() if d.is_dir()):
        # a folder without _extension.yml is already an <owner> level
        target = dest / owner / ext.name if (ext / "_extension.yml").exists() else dest / ext.name
        shutil.copytree(ext, target)
    return True


def prepare_source(entry: dict, rev: str | None, tmp: Path) -> tuple[Path, bool]:
    """Copy an entry's source into tmp; return the document to render, options
    applied, and whether it renders with the extension at the repo's root."""
    workdir = tmp / "src"
    root_extension = False
    if entry["builtin"]:
        shutil.copytree(SAMPLES, workdir)
        doc = workdir / entry["file"]
    else:
        source = checkout(entry["repo"], entry["ref"], rev)
        rel = Path(entry["file"])
        # A template in a subfolder is self-contained: copy just that folder.
        sub = rel.parent
        shutil.copytree(source / sub, workdir, ignore=shutil.ignore_patterns(".git"))
        if sub == Path("."):
            apply_quartoignore(workdir)
        # a template in a subfolder may bring its own extensions
        if sub == Path(".") or not (workdir / "_extensions").exists():
            root_extension = install_extensions(source, workdir, entry["repo"].split("/")[0])
        doc = workdir / rel.name
    if not doc.exists():
        raise FileNotFoundError(f"{entry['file']} not found in source")
    if entry["replace"]:
        apply_replacements(doc, entry["replace"])
    if entry["options"] or entry["remove_options"]:
        doc = with_options(doc, entry["format"], entry["options"], entry["remove_options"])
    return doc, root_extension


def save_source(entry: dict, rev: str | None, dest: Path) -> None:
    """Store the document an entry is rendered from, for the site's source view."""
    with tempfile.TemporaryDirectory(prefix=f"qt-{entry['id']}-") as tmp:
        shutil.copy2(prepare_source(entry, rev, Path(tmp))[0], dest / SOURCE_NAME)


def render_entry(entry: dict, rev: str | None, dest: Path) -> list[dict]:
    """Render an entry into dest; return its output records (just the one)."""
    with tempfile.TemporaryDirectory(prefix=f"qt-{entry['id']}-") as tmp:
        src, root_extension = prepare_source(entry, rev, Path(tmp))
        workdir = Path(tmp) / "src"
        shutil.copy2(src, dest / SOURCE_NAME)  # before rendering, which may write next to it

        fmt = entry["format"]
        base = base_of(fmt)
        output = BASE_FORMATS[base][1]
        if ENGINES.get(base) == "latex":
            ensure_latex()
        out_name = f"{fmt}.{output}"
        cmd = ["quarto", "render", src.name, "--to", fmt, "--output", out_name]
        if output == "html":
            cmd += ["-M", "embed-resources:true"]
        log(f"  quarto render {entry['file']} --to {fmt}")
        run(cmd, cwd=src.parent, timeout=RENDER_TIMEOUT)
        produced = [p for p in workdir.rglob(out_name) if p.is_file()]
        if not produced:
            raise FileNotFoundError(f"render finished but {out_name} was not produced")
        shutil.copy2(produced[0], dest / out_name)
        return [{
            "format": fmt, "output": output, "file": out_name,
            # does the template already use this format as is?
            "native": not (entry["options"] or entry["remove_options"]) and fmt in declared_formats(src),
            # a document in a subfolder that uses the repo's extension
            "example": root_extension and Path(entry["file"]).parent != Path("."),
        }]


# --- slimming ---------------------------------------------------------------
# embed-resources inlines every font a theme declares, in every format it lists:
# reveal.js decks carry Source Sans Pro as EOT, WOFF and TTF (~2 MB), of which a
# browser only ever uses one. Keep a single source per @font-face, as WOFF2.

FONT_FACE = re.compile(r"@font-face\s*\{[^{}]*\}")
FONT_SRC = re.compile(r"\bsrc\s*:(?:[^;{}()]|\([^()]*\))*;?")  # url(data:...;base64,...) holds a ;
FONT_URL = re.compile(r"url\(\s*(['\"]?)(data:([\w/+.-]+)[^,]*?;base64,([A-Za-z0-9+/=\s]+))\1\s*\)(?:\s*format\(\s*['\"]?([\w-]+)['\"]?\s*\))?")
CSS_DATA_LINK = re.compile(r'(href=")data:text/css,([^"]*)(")')
STYLE = re.compile(r"(<style\b[^>]*>)(.*?)(</style>)", re.S | re.I)
# format() names and data: types, most preferred first; EOT and SVG fonts are skipped
FONT_KINDS = [("woff2", ("woff2", "font/woff2")), ("woff", ("woff", "font/woff", "application/font-woff")),
              ("sfnt", ("truetype", "opentype", "font/ttf", "font/otf", "font/sfnt", "application/x-font-ttf",
                        "application/x-font-opentype", "application/font-sfnt"))]


def to_woff2(data: bytes) -> bytes | None:
    try:
        from fontTools.ttLib import TTFont
    except ImportError:
        return None
    import io
    try:
        font = TTFont(io.BytesIO(data))
        font.flavor = "woff2"
        out = io.BytesIO()
        font.save(out)
        return out.getvalue()
    except Exception:
        return None


def slim_font_face(rule: str) -> str:
    """One embedded source per @font-face, converted to WOFF2 where possible."""
    srcs = FONT_SRC.findall(rule)
    urls = [u for s in srcs for u in FONT_URL.finditer(s)]
    # leave rules with sources that aren't embedded (remote files) alone
    if not urls or sum(s.count("url(") for s in srcs) != len(urls):
        return rule
    best = next(((rank, u) for rank, (_, names) in enumerate(FONT_KINDS)
                 for u in urls if (u.group(5) or u.group(3)).lower() in names), None)
    if best is None:
        return rule
    rank, u = best
    if rank > 0:
        data = base64.b64decode(re.sub(r"\s+", "", u.group(4)))
        woff2 = to_woff2(data)
        if woff2 and len(woff2) < len(data):
            rank, u = 0, None
            src = f"src: url(data:font/woff2;base64,{base64.b64encode(woff2).decode()}) format('woff2');"
    if u is not None:
        src = f"src: url({u.group(2)}) format('{FONT_KINDS[rank][1][0]}');"
    first = FONT_SRC.search(rule)
    rest = FONT_SRC.sub("", rule[first.end():])
    return rule[:first.start()] + src + rest


def slim_css(css: str) -> str:
    return FONT_FACE.sub(lambda m: slim_font_face(m.group(0)), css)


def slim_html(path: Path) -> None:
    """Shrink a self-contained HTML file in place (fonts in <style> and in data: stylesheets)."""
    text = path.read_text(encoding="utf-8")

    def link(m: re.Match) -> str:
        css = urllib.parse.unquote(m.group(2))
        if "@font-face" not in css:
            return m.group(0)
        # base64 needs no escaping, so the fonts stay as compact as in a <style>
        return m.group(1) + "data:text/css," + urllib.parse.quote(slim_css(css), safe="/:;,=+()!*-._~@{}[]$?") + m.group(3)

    # only in CSS: scripts may build @font-face rules in strings (e.g. anchor.js)
    slim = STYLE.sub(lambda m: m.group(1) + slim_css(m.group(2)) + m.group(3), CSS_DATA_LINK.sub(link, text))
    if len(slim) < len(text):
        path.write_text(slim, encoding="utf-8")


# --- thumbnails -------------------------------------------------------------


def pdf_thumb(pdf: Path, out: Path, page: int) -> None:
    if not shutil.which("pdftoppm"):
        raise RuntimeError("pdftoppm not found; install poppler-utils (apt) or poppler (brew)")
    stem = out.with_suffix("")
    run(["pdftoppm", "-f", str(page), "-l", str(page), "-singlefile",
         "-png", "-scale-to-x", str(THUMB_WIDTH), "-scale-to-y", "-1",
         str(pdf), str(stem)], timeout=120)


class Browser:
    """Lazily started headless browser for HTML thumbnails."""

    def __init__(self) -> None:
        self._pw = None
        self._browser = None

    def get(self):
        if self._browser is None:
            from playwright.sync_api import sync_playwright
            self._pw = sync_playwright().start()
            try:
                self._browser = self._pw.chromium.launch()
            except Exception:
                # e.g. GitHub's runners: no Playwright download, but Chrome is installed
                self._browser = self._pw.chromium.launch(channel="chrome")
        return self._browser

    def close(self) -> None:
        if self._browser:
            self._browser.close()
        if self._pw:
            self._pw.stop()


def html_thumb(browser: Browser, page_file: Path, out: Path, slides: bool) -> None:
    w, h = (1280, 720) if slides else (1280, 960)
    page = browser.get().new_page(viewport={"width": w, "height": h}, device_scale_factor=THUMB_WIDTH / w)
    try:
        page.goto(page_file.as_uri(), wait_until="load", timeout=60_000)
        if slides:
            page.wait_for_function("window.Reveal && Reveal.isReady && Reveal.isReady()", timeout=30_000)
        page.evaluate("document.fonts.ready")
        page.wait_for_timeout(600)
        page.screenshot(path=str(out), type="png")
    finally:
        page.close()


def to_webp(png: Path) -> tuple[Path, int, int]:
    """Convert a PNG thumbnail to WebP (about half the size of a JPEG); return it and its size."""
    from PIL import Image
    out = png.with_suffix(".webp")
    with Image.open(png) as im:
        im.convert("RGB").save(out, "WEBP", quality=THUMB_QUALITY, method=6)
        w, h = im.size
    png.unlink()
    return out, w, h


# --- site data --------------------------------------------------------------


def front_matter_snippet(entry: dict) -> str:
    """A complete front matter block using the entry's format, ready to paste."""
    fmt, options = entry["format"], entry["options"]
    meta = {
        "title": "My Slides" if entry["kind"] == "slides" else "My Document",
        "format": {fmt: options} if options else fmt,
    }
    return "---\n" + yaml.safe_dump(meta, sort_keys=False, allow_unicode=True) + "---"


def site_record(entry: dict, manifest: dict) -> dict:
    repo, file = entry["repo"], entry["file"]
    rec = {
        "id": entry["id"],
        "title": entry["title"],
        "description": entry["description"],
        "kind": entry["kind"],
        "builtin": entry["builtin"],
    }
    if entry["builtin"]:
        rec["origin"] = "format: " + entry["format"]
        rec["src"] = DOCS[base_of(entry["format"])]
        rec["setup"] = "builtin"
    else:
        sub = str(Path(file).parent)
        rec["origin"] = repo if sub == "." else f"{repo}/{sub}"
        rec["src"] = f"https://github.com/{repo}" + (f"/tree/{entry['ref'] or 'HEAD'}/{sub}" if sub != "." else "")
        rec["repo"] = repo
        rec["file"] = file
        rec["setup"] = "extension" if sub == "." else "clone"
    out = manifest["outputs"][0]
    if out.get("example"):
        rec["setup"] = "example"
    rec.update({
        "format": out["format"],
        "output": out["output"],
        "engine": ENGINES.get(base_of(out["format"])),
        "url": f"t/{entry['id']}/{out['file']}",
        "thumb": f"t/{entry['id']}/{out['thumb']}" if out.get("thumb") else None,
        "w": out.get("w"),
        "h": out.get("h"),
        "yaml": front_matter_snippet(entry),
        "native": out.get("native", False),
    })
    if manifest.get("source"):
        rec["source"] = f"t/{entry['id']}/{manifest['source']}"
        rec["source_name"] = Path(file).name
    rec["rendered"] = manifest.get("rendered")
    rec["rev"] = manifest.get("rev")
    return rec


# --- main -------------------------------------------------------------------


def samples_hash() -> str:
    h = hashlib.sha256()
    for p in sorted(SAMPLES.rglob("*")):
        if p.is_file():
            h.update(p.relative_to(SAMPLES).as_posix().encode())
            h.update(p.read_bytes())
    return h.hexdigest()


def cache_key(entry: dict, rev: str | None) -> str:
    material = {
        "v": RENDER_VERSION,
        # "formats" stays a list, as when entries could have several, so existing caches stay valid
        "entry": {"formats": [entry["format"]], **{k: entry[k] for k in ("repo", "ref", "file", "options", "preview_page")}},
        # only when set, so entries without it keep their cache
        **({"remove_options": entry["remove_options"]} if entry["remove_options"] else {}),
        **({"replace": entry["replace"]} if entry["replace"] else {}),
        "rev": rev if not entry["builtin"] else samples_hash(),
        "quarto": quarto_version(),
    }
    return hashlib.sha256(json.dumps(material, sort_keys=True).encode()).hexdigest()[:16]


def build_entry(entry: dict, args, browser: Browser) -> dict | None:
    store = CACHE / "renders" / entry["id"]
    manifest_path = store / "manifest.json"
    old = json.loads(manifest_path.read_text()) if manifest_path.exists() else None

    try:
        rev = None if entry["builtin"] else remote_revision(entry["repo"], entry["ref"])
        key = cache_key(entry, rev)
    except Exception as exc:
        log(f"! {entry['id']}: cannot resolve source: {exc}")
        return old  # offline or repo gone: keep whatever we had

    selected = not args.only or entry["id"] in args.only
    if old and old.get("key") == key and not (args.force and selected):
        if all(has_thumb(out) and slimmed(out) for out in old["outputs"]) and old.get("source"):
            log(f"= {entry['id']} (cached)")
            return old
        # Rendered fine earlier, but a thumbnail, the slimming or the source is missing: make just that.
        log(f"= {entry['id']} (cached, completing)")
        errors = make_thumbs(entry, old["outputs"], store, browser)
        make_slim(old["outputs"], store)
        if not old.get("source"):
            try:
                save_source(entry, rev, store)
                old["source"] = SOURCE_NAME
            except Exception as exc:
                log(f"  ! source for {entry['id']} failed: {exc}")
                errors.append(f"source: {exc}")
        manifest_path.write_text(json.dumps(old, indent=2))
        return {**old, "error": "; ".join(errors)} if errors else old
    if not selected:
        if old:
            log(f"~ {entry['id']} (stale, not selected)")
        return old

    log(f"> {entry['id']}")
    started = time.time()
    staging = CACHE / "staging" / entry["id"]
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    try:
        outputs = render_entry(entry, rev, staging)
        thumb_errors = make_thumbs(entry, outputs, staging, browser)
        make_slim(outputs, staging)
    except Exception as exc:
        log(f"! {entry['id']} failed after {time.time() - started:.0f}s:\n{exc}")
        if old:
            log(f"  keeping previous render from {old.get('rendered')}")
        return {**old, "error": str(exc)[-2000:]} if old else {"id": entry["id"], "error": str(exc)[-2000:]}

    manifest = {
        "id": entry["id"],
        "key": key,
        "rev": rev,
        "quarto": quarto_version(),
        "rendered": time.strftime("%Y-%m-%d", time.gmtime()),
        "outputs": outputs,
        "source": SOURCE_NAME,
    }
    (staging / "manifest.json").write_text(json.dumps(manifest, indent=2))
    shutil.rmtree(store, ignore_errors=True)
    store.parent.mkdir(parents=True, exist_ok=True)
    staging.rename(store)
    log(f"  done in {time.time() - started:.0f}s")
    return {**manifest, "error": "; ".join(thumb_errors)} if thumb_errors else manifest


def make_thumbs(entry: dict, outputs: list[dict], folder: Path, browser: Browser) -> list[str]:
    """Add a WebP thumbnail to each output that lacks one; return error messages."""
    errors = []
    for out in outputs:
        if has_thumb(out):
            continue
        png = folder / Path(out["file"]).with_suffix(".png").name
        try:
            if out["output"] == "pdf":
                pdf_thumb(folder / out["file"], png, entry["preview_page"])
            else:
                html_thumb(browser, folder / out["file"], png, entry["kind"] == "slides")
            thumb, out["w"], out["h"] = to_webp(png)
            if out.get("thumb") and out["thumb"] != thumb.name:
                (folder / out["thumb"]).unlink(missing_ok=True)  # e.g. a JPEG from older builds
            out["thumb"] = thumb.name
        except Exception as exc:
            log(f"  ! thumbnail for {out['format']} failed: {exc}")
            errors.append(f"thumbnail for {out['format']}: {exc}")
    return errors


def has_thumb(out: dict) -> bool:
    return out.get("thumb", "").endswith(".webp")


def slimmed(out: dict) -> bool:
    return out["output"] != "html" or out.get("slim", False)


def make_slim(outputs: list[dict], folder: Path) -> None:
    """Slim each HTML output that isn't yet (after its thumbnail, which it doesn't change)."""
    for out in outputs:
        if slimmed(out):
            continue
        try:
            before = (folder / out["file"]).stat().st_size
            slim_html(folder / out["file"])
            log(f"  slimmed {out['file']}: {before / 1e6:.1f} -> {(folder / out['file']).stat().st_size / 1e6:.1f} MB")
        except Exception as exc:
            log(f"  ! slimming {out['file']} failed: {exc}")
        out["slim"] = True  # a failure would only repeat; the output works as it is


def write_site(records: list[dict], out_dir: Path) -> None:
    shutil.rmtree(out_dir, ignore_errors=True)
    shutil.copytree(SITE_SRC, out_dir)
    for rec in records:
        src = CACHE / "renders" / rec["id"]
        dest = out_dir / "t" / rec["id"]
        dest.mkdir(parents=True, exist_ok=True)
        for rel in (rec["url"], rec["thumb"], rec.get("source")):
            if rel:
                shutil.copy2(src / Path(rel).name, dest / Path(rel).name)
    index = out_dir / "index.html"
    data = json.dumps({"templates": records, "quarto": quarto_version()}, ensure_ascii=False)
    data = data.replace("</", "<\\/")  # keep it inert inside <script>
    index.write_text(index.read_text().replace("<!--TEMPLATE_DATA-->", data))
    (out_dir / "templates.json").write_text(json.dumps(records, indent=2, ensure_ascii=False))
    (out_dir / ".nojekyll").touch()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", nargs="*", default=[], help="render only these ids (others come from the cache)")
    ap.add_argument("--force", action="store_true", help="re-render even if cached")
    ap.add_argument("--out", default="_site", help="output directory (default: _site)")
    ap.add_argument("--strict", action="store_true", help="exit non-zero if any template failed")
    args = ap.parse_args()

    entries = load_config()
    unknown = set(args.only) - {e["id"] for e in entries}
    if unknown:
        ap.error(f"unknown ids: {', '.join(sorted(unknown))}")

    browser = Browser()
    records, failed = [], []
    try:
        for entry in entries:
            manifest = build_entry(entry, args, browser)
            if manifest and manifest.get("error"):
                failed.append((entry["id"], manifest["error"]))
            if manifest and manifest.get("outputs"):
                records.append(site_record(entry, manifest))
    finally:
        browser.close()

    write_site(records, ROOT / args.out)
    # Drop cached renders of entries removed from the config.
    ids = {e["id"] for e in entries}
    for stale in (CACHE / "renders").glob("*"):
        if stale.name not in ids:
            shutil.rmtree(stale)

    log(f"\n{len(records)} of {len(entries)} templates in {args.out}/")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if failed:
        log("Failed: " + ", ".join(i for i, _ in failed))
    if summary:
        with open(summary, "a") as f:
            f.write(f"### Gallery build\n\n{len(records)} of {len(entries)} templates published.\n\n")
            for tid, err in failed:
                f.write(f"<details><summary>❌ {html.escape(tid)}</summary>\n\n```\n{err}\n```\n</details>\n\n")
    return 1 if failed and args.strict else 0


if __name__ == "__main__":
    sys.exit(main())
