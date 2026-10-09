# quarto-templates

A gallery of Quarto templates, each rendered from source, so you can pick one
by its actual output. Every entry links to its rendered HTML or PDF and shows
the commands to use it.

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
```

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
Chrome). TinyTeX is installed on first use if no LaTeX is found. Templates with
R code chunks need R with the packages listed in the
[workflow](.github/workflows/build.yml) (knitr, rmarkdown, ggplot2, …).

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
