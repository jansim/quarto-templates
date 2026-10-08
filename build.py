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
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / "templates.toml"
SAMPLES = ROOT / "samples"
SITE_SRC = ROOT / "site"
CACHE = ROOT / ".cache"

# Bump to invalidate every cached render (e.g. after changing how renders work).
RENDER_VERSION = "1"

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
NEEDS_LATEX = {"pdf", "beamer"}
RENDER_TIMEOUT = 20 * 60
THUMB_WIDTH = 640


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
        formats = e["format"] if isinstance(e["format"], list) else [e["format"]]
        kinds = {BASE_FORMATS[base_of(f)][0] for f in formats}
        if len(kinds) > 1:
            raise ValueError(f"[{tid}]: mixes document and slide formats")
        repo = e.get("repo")
        if repo and not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
            raise ValueError(f"[{tid}]: repo must look like 'owner/name'")
        builtin = repo is None
        kind = kinds.pop()
        if builtin:
            file = e.get("file") or ("slides.qmd" if kind == "slides" else "document.qmd")
        else:
            file = e.get("file", "template.qmd")
        entries.append({
            "id": tid,
            "title": e["title"],
            "formats": formats,
            "repo": repo,
            "ref": e.get("ref"),
            "file": file,
            "options": e.get("options") or {},
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
    """Drop files `quarto use template` would not copy (see .quartoignore)."""
    ignore = workdir / ".quartoignore"
    if not ignore.exists():
        return
    patterns = [l.strip() for l in ignore.read_text().splitlines() if l.strip() and not l.startswith("#")]
    for pattern in patterns:
        pattern = pattern.strip("/")
        for path in list(workdir.rglob("*")):
            rel = path.relative_to(workdir).as_posix()
            if fnmatch.fnmatch(rel, pattern) or ("/" not in pattern and fnmatch.fnmatch(path.name, pattern)):
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


def with_options(src: Path, fmt: str, options: dict) -> Path:
    """Copy of src with options merged into the front matter of format fmt."""
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
    meta["format"] = formats
    dumped = yaml.safe_dump(meta, sort_keys=False, allow_unicode=True, width=1000)
    dest = src.with_name(f"gallery-{src.stem}.qmd")
    dest.write_text(f"---\n{dumped}---\n{body}", encoding="utf-8")
    return dest


def render_entry(entry: dict, rev: str | None, dest: Path) -> list[dict]:
    """Render all formats of an entry into dest; return output records."""
    with tempfile.TemporaryDirectory(prefix=f"qt-{entry['id']}-") as tmp:
        tmp = Path(tmp)
        if entry["builtin"]:
            workdir = tmp / "src"
            shutil.copytree(SAMPLES, workdir)
            doc = workdir / entry["file"]
        else:
            source = checkout(entry["repo"], entry["ref"], rev)
            rel = Path(entry["file"])
            # A template in a subfolder is self-contained: copy just that folder.
            sub = rel.parent
            workdir = tmp / "src"
            shutil.copytree(source / sub, workdir, ignore=shutil.ignore_patterns(".git"))
            if sub == Path("."):
                apply_quartoignore(workdir)
            doc = workdir / rel.name
        if not doc.exists():
            raise FileNotFoundError(f"{entry['file']} not found in source")

        outputs = []
        for fmt in entry["formats"]:
            base = base_of(fmt)
            output = BASE_FORMATS[base][1]
            if base in NEEDS_LATEX:
                ensure_latex()
            src = with_options(doc, fmt, entry["options"]) if entry["options"] else doc
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
            outputs.append({
                "format": fmt, "output": output, "file": out_name,
                # does the template already use this format as is?
                "native": not entry["options"] and fmt in declared_formats(doc),
            })
        return outputs


# --- thumbnails -------------------------------------------------------------


def pdf_thumb(pdf: Path, out: Path, page: int) -> None:
    stem = out.with_suffix("")
    run(["pdftoppm", "-f", str(page), "-l", str(page), "-singlefile",
         "-jpeg", "-jpegopt", "quality=82", "-scale-to-x", str(THUMB_WIDTH), "-scale-to-y", "-1",
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
        page.screenshot(path=str(out), type="jpeg", quality=82)
    finally:
        page.close()


def image_size(jpeg: Path) -> tuple[int, int]:
    """Width and height of a JPEG, read from its SOF marker."""
    data = jpeg.read_bytes()
    i = 2
    while i < len(data):
        marker, length = data[i + 1], int.from_bytes(data[i + 2:i + 4], "big")
        if marker in (0xC0, 0xC1, 0xC2):
            return int.from_bytes(data[i + 7:i + 9], "big"), int.from_bytes(data[i + 5:i + 7], "big")
        i += 2 + length
    return 0, 0


# --- site data --------------------------------------------------------------


def front_matter_snippet(fmt: str, options: dict) -> str:
    if not options:
        return f"format: {fmt}"
    return yaml.safe_dump({"format": {fmt: options}}, sort_keys=False, allow_unicode=True).strip()


def site_record(entry: dict, manifest: dict) -> dict:
    repo, file = entry["repo"], entry["file"]
    rec = {
        "id": entry["id"],
        "title": entry["title"],
        "description": entry["description"],
        "kind": entry["kind"],
        "builtin": entry["builtin"],
        "outputs": [],
    }
    if entry["builtin"]:
        rec["origin"] = "format: " + entry["formats"][0]
        rec["src"] = DOCS[base_of(entry["formats"][0])]
        rec["setup"] = "builtin"
    else:
        sub = str(Path(file).parent)
        rec["origin"] = repo if sub == "." else f"{repo}/{sub}"
        rec["src"] = f"https://github.com/{repo}" + (f"/tree/{entry['ref'] or 'HEAD'}/{sub}" if sub != "." else "")
        rec["repo"] = repo
        rec["file"] = file
        rec["setup"] = "extension" if sub == "." else "clone"
    for out in manifest["outputs"]:
        rec["outputs"].append({
            "format": out["format"],
            "output": out["output"],
            "url": f"t/{entry['id']}/{out['file']}",
            "thumb": f"t/{entry['id']}/{out['thumb']}" if out.get("thumb") else None,
            "w": out.get("w"),
            "h": out.get("h"),
            "yaml": front_matter_snippet(out["format"], entry["options"]),
            "native": out.get("native", False),
        })
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
        "entry": {k: entry[k] for k in ("formats", "repo", "ref", "file", "options", "preview_page")},
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
        log(f"= {entry['id']} (cached)")
        return old
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
        for out in outputs:
            thumb = Path(out["file"]).with_suffix(".jpg").name
            try:
                if out["output"] == "pdf":
                    pdf_thumb(staging / out["file"], staging / thumb, entry["preview_page"])
                else:
                    html_thumb(browser, staging / out["file"], staging / thumb, entry["kind"] == "slides")
                out["thumb"] = thumb
                out["w"], out["h"] = image_size(staging / thumb)
            except Exception as exc:
                log(f"  ! thumbnail failed: {exc}")
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
    }
    (staging / "manifest.json").write_text(json.dumps(manifest, indent=2))
    shutil.rmtree(store, ignore_errors=True)
    store.parent.mkdir(parents=True, exist_ok=True)
    staging.rename(store)
    log(f"  done in {time.time() - started:.0f}s")
    return manifest


def write_site(records: list[dict], out_dir: Path) -> None:
    shutil.rmtree(out_dir, ignore_errors=True)
    shutil.copytree(SITE_SRC, out_dir)
    for rec in records:
        src = CACHE / "renders" / rec["id"]
        dest = out_dir / "t" / rec["id"]
        dest.mkdir(parents=True, exist_ok=True)
        for out in rec["outputs"]:
            for rel in (out["url"], out["thumb"]):
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
