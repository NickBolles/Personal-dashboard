#!/usr/bin/env python3
"""Publish the private, self-contained in-this-chat visual evidence board.
Requires BOARD_DIR containing actual Playwright PNGs. Uses only the established artifact
publisher credential locations and validates bytes plus stored MD5 after upload.
"""
import base64
import hashlib
import html
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

BASE = "https://artifacts.ai.nickbolles.com"
SLUG = "jarvis-in-this-chat-20261124"
TITLE = "In this chat execution receipts — mock browser evidence"
ROOT = Path(__file__).resolve().parents[1]
BEFORE = Path("/home/hermes/.hermes/profiles/chiefofstaff/cache/documents/native-inputs/8633f2eac03bac5a21058be27d72eacdde688ebaefe3167224cd20d23a1c066a/api_8633f2eac03bac5a21058be27d72eacd.jpg")


def token():
    value = os.environ.get("HERMES_ARTIFACT_API_TOKEN")
    if value:
        return value
    # Established authorized publisher source; never print environment or credential values.
    inspect = json.loads(subprocess.check_output(["docker", "inspect", "Agent-artifacts"]))
    return next(entry.split("=", 1)[1] for entry in inspect[0]["Config"]["Env"] if entry.startswith("API_TOKEN="))


def request(method, url, secret, body=None, content_type=None):
    headers = {"Authorization": "Bearer " + secret}
    if content_type:
        headers["Content-Type"] = content_type
    with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=headers, method=method), timeout=45) as response:
        return response.read(), dict(response.headers)


def data_image(path):
    kind = "image/jpeg" if path.suffix.lower() in {".jpg", ".jpeg"} else "image/png"
    return "data:%s;base64,%s" % (kind, base64.b64encode(path.read_bytes()).decode())


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: publish-in-this-chat-board.py <actual-shot-directory>")
    shots_dir = Path(sys.argv[1])
    shots = sorted(shots_dir.glob("*.png"))
    if not BEFORE.is_file() or not shots:
        raise SystemExit("Need the owner-provided before image and at least one actual Playwright PNG.")
    cards = [f'<figure><img alt="Before: owner-provided in this chat sheet" src="{data_image(BEFORE)}"><figcaption>Before — owner-provided mobile reference.</figcaption></figure>']
    for shot in shots:
        cards.append(f'<figure><img alt="Actual mock browser render: {html.escape(shot.stem)}" src="{data_image(shot)}"><figcaption>After — actual production-build Playwright render: {html.escape(shot.name)}.</figcaption></figure>')
    document = f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{TITLE}</title><style>body{{margin:0;background:#10151e;color:#e9edf5;font:16px/1.5 system-ui}}main{{max-width:1200px;margin:auto;padding:28px}}.note{{background:#172434;border-left:4px solid #7dd3fc;padding:14px;border-radius:8px}}.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px}}figure{{margin:0;background:#18202c;border:1px solid #334155;border-radius:12px;overflow:hidden}}img{{display:block;width:100%;height:auto}}figcaption{{padding:10px;color:#cbd5e1;font-size:13px}}code{{overflow-wrap:anywhere}}</style><main><h1>{TITLE}</h1><p class="note">Private review evidence. “After” images are actual local production-build browser renders against route-intercepted mock execution DTOs; they do not prove a production integration. No live owner sends or integration writes occurred.</p><h2>Coverage represented</h2><p>Synthetic fixtures exercise compact execution presentation and recorded references. Images below show only the scenarios named in their captions; functional assertions and unverified acceptance gaps are recorded in the PR and durable handoff. A screenshot is not proof of production integration, a completed task, or a successful external action.</p><div class="grid">{''.join(cards)}</div></main></html>'''.encode()
    secret = token()
    metadata, _ = request("POST", BASE + "/api/artifacts", secret, json.dumps({"slug": SLUG, "title": TITLE, "visibility": "authenticated", "allowDirectoryListing": False}).encode(), "application/json")
    viewer = json.loads(metadata).get("viewerUrl")
    if not viewer or not viewer.startswith(BASE + "/v/"):
        raise SystemExit("Artifact service did not return expected viewer URL.")
    request("PUT", BASE + "/api/artifacts/" + SLUG + "/files/index.html", secret, document, "text/html; charset=utf-8")
    md5 = hashlib.md5(document).hexdigest()
    paths = subprocess.check_output(["docker", "exec", "Agent-artifacts", "find", "/data", "-path", "*" + SLUG + "*", "-name", "index.html"], text=True).splitlines()
    verified = False
    for path in paths:
        stored = subprocess.check_output(["docker", "exec", "Agent-artifacts", "md5sum", path], text=True).split()[0]
        verified = verified or stored == md5
    if not verified:
        raise SystemExit("Stored artifact MD5 readback did not match uploaded document.")
    output = Path("/opt/data/artifacts") / SLUG
    output.mkdir(parents=True, exist_ok=True)
    (output / "index.html").write_bytes(document)
    print(json.dumps({"url": viewer, "private": True, "shots": len(shots), "storedMd5": md5, "verified": True}))


if __name__ == "__main__":
    main()
