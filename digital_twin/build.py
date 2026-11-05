#!/usr/bin/env python3
"""Rebuild the single-file dashboard (../2_Digital_Twin_Model/Twin_Electra_Dashboard.html)
from src/template.html, src/app.js and the three vendor libraries.
Usage:  python3 build.py
Only the Python standard library is needed."""
import os
here = os.path.dirname(os.path.abspath(__file__))
read = lambda p: open(os.path.join(here, p), encoding="utf-8").read()
html = read("src/template.html")
for tag, path in [("plotly.min.js", "vendor/plotly.min.js"), ("xlsx.full.min.js", "vendor/xlsx.full.min.js"),
                  ("jszip.min.js", "vendor/jszip.min.js"), ("app.js", "src/app.js")]:
    html = html.replace("@@" + tag + "@@", read(path))
html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>' + html + "</body></html>"
out = os.path.join(here, "..", "2_Digital_Twin_Model", "Twin_Electra_Dashboard.html")
open(out, "w", encoding="utf-8").write(html)
print("written", os.path.normpath(out), len(html), "characters")
