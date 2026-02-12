# TornCity Scripts & Tools

A personal repo for Torn City automation/QoL tools:
- **UserScripts** (Tampermonkey/Greasemonkey)
- **Tools** (Python utilities, experiments, bots)

## Quick links
- **UserScripts:** `userscripts/`
- **GitHub Pages site (script directory):** `docs/` (published via Pages)
- **Python tools:** `tools/python/`

## Repo layout
```
userscripts/
  casino/highlow/   # Torn High-Low helper
  _template/        # starter template for new userscripts
docs/               # GitHub Pages content (static)
tools/python/       # python utilities (optional)
scripts/            # dev scripts (PowerShell)
```

## Add a new userscript (fast)
- Copy `userscripts/_template/` → `userscripts/<category>/<name>/`
- Update metadata block: `@name`, `@match`, `@version`, `@description`
- Keep code readable (don’t minify) if you plan to publish on Greasy Fork.

## Notes
- Publishing: Greasy Fork is the primary “install + auto-update” channel.
- GitHub Pages is the “directory” + documentation hub.
