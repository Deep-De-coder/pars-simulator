"""
Build a single self-contained HTML file of the 3D game that needs no
server: the JavaScript engine (static/engine.js) runs in the page.

    python -m pars.web.build pars-3d.html                 # three.js from cdnjs
    python -m pars.web.build pars-3d.html --inline-three  # fully offline
    python -m pars.web.build out.html --fragment          # no <html>/<head>/<body> wrapper
"""

import argparse
import re
from pathlib import Path

STATIC = Path(__file__).parent / "static"
THREE_CDN = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"
THREE_TAG = '<script src="/vendor/three.min.js"></script>'


def build_standalone(inline_three=False, fragment=False):
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    engine = (STATIC / "engine.js").read_text(encoding="utf-8")
    if inline_three:
        three = (STATIC / "vendor" / "three.min.js").read_text(encoding="utf-8")
        three_tag = f"<script>{three}</script>"
    else:
        three_tag = f'<script src="{THREE_CDN}"></script>'
    assert THREE_TAG in html, "index.html no longer references the vendored three.js"
    html = html.replace(
        THREE_TAG,
        three_tag + "\n<script>window.PARS_STANDALONE = true;</script>\n<script>" + engine + "</script>",
    )
    if fragment:
        head = re.search(r"<head>(.*?)</head>", html, re.S).group(1)
        body = re.search(r"<body>(.*)</body>", html, re.S).group(1)
        head = re.sub(r"<meta[^>]*>\s*", "", head)  # the host supplies charset/viewport
        html = head.strip() + "\n" + body.strip() + "\n"
    return html


def main(argv=None):
    p = argparse.ArgumentParser(description="Build a standalone PARS 3D page")
    p.add_argument("output")
    p.add_argument("--inline-three", action="store_true", help="Embed three.js (works offline)")
    p.add_argument("--fragment", action="store_true", help="Omit the html/head/body wrapper")
    args = p.parse_args(argv)
    out = build_standalone(args.inline_three, args.fragment)
    Path(args.output).write_text(out, encoding="utf-8")
    print(f"Wrote {args.output} ({len(out) // 1024} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
