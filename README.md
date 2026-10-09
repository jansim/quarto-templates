# Quarto Template Gallery

## Intro (human-written 💁‍♂️)

This repo contains the source code for the quarto template gallery, a collection of quarto templates / formats from around the web, each rendered to make them easier to browse / compare. I build, as I often found myself wanting to quickly compare existing templates to choose one for a particular project (when I didn't want to reinvent the wheel by restyling an existing format.

This is a classic vibe-coded project, I'm mostly interested in the results / final deliverable, not the actual code that powers the website. As such, please keep that in mind. The most interesting document in this repo may be the `templates.toml`, which serves as a collection of interesting templates from across the web. If you feel like one is missing, feel free to [submit an issue](https://github.com/jansim/quarto-templates/issues/new?template=add-template.yml) or PR to add it.

## Adding a template

To suggest a template, [open an issue](https://github.com/jansim/quarto-templates/issues/new?template=add-template.yml);
its form asks for the entry described here. To add one yourself, add a table
to [`templates.toml`](templates.toml). Most entries need three or four lines:

```toml
[riso]                                   # id, used in URLs
title = "Riso Zine"
repo = "jansim/quarto-revealjs-themes"   # leave out for built-in formats
format = "riso-revealjs"                 # one per entry
```

`file` (default `template.qmd`) picks the document to render, and `options`
merges format options into its front matter, so one repo can yield several
entries:

```toml
[titlepage-formal]
title = "Title Pages: Formal"
repo = "nmfs-opensci/quarto_titlepages"
file = "example_2.qmd"
format = "titlepage-pdf"
options = { titlepage = "formal", coverpage = "none" }
remove-options = ["titlepage-bg-image"]  # drop the document's own setting
```

`remove-options` drops keys from the document's format options (use `"a.b"`
for nested keys), for settings that only suit the document's original variant.

A template that supports several formats gets one entry per format.
Whether an entry is a document or slides, whether it renders to PDF or HTML,
and whether that PDF is typeset by LaTeX or Typst, is inferred from the format
name. Setup instructions are derived too:
templates at a repo's root get `quarto use template` / `quarto add`, templates
in a subfolder get `git clone` + `quarto render`. See the comment at the top of
`templates.toml` for all keys.

## Building

```bash
pip install -r requirements.txt
python build.py              # renders what changed, writes _site/
python build.py --only riso  # render a single entry
python build.py --force      # ignore the cache
python -m http.server -d _site
```

Requires Quarto, `pdftoppm` (poppler) for PDF thumbnails and a Chromium for
HTML thumbnails (`python -m playwright install chromium`, or an installed
Chrome). TinyTeX is installed on first use if no LaTeX is found.

Renders are cached in `.cache/renders/<id>/`. An entry is only re-rendered
when its config, the upstream commit (checked with `git ls-remote`), the sample
documents in `samples/` or the Quarto version change. A failed render keeps the
previous output, and the build lists failures in its summary. A render whose
thumbnail failed is kept, and only the thumbnail is retried on the next build.

The [GitHub Action](.github/workflows/build.yml) runs the build on every push,
weekly (to pick up upstream changes) and on demand, keeps `.cache/` between
runs with `actions/cache`, and deploys `_site/` to GitHub Pages.

## Layout

```
templates.toml   the collection
samples/         sample documents rendered by the built-in formats
build.py         render + thumbnail + site build
site/            static site (plain HTML/CSS/JS); data is inlined at build time
```
