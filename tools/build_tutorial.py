#!/usr/bin/env python3
# Converts TUTORIAL.md into a standalone HTML page for the Artifact viewer.
#   python3 tools/build_tutorial.py TUTORIAL.md out.html
import html
import re
import sys

SRC, OUT = sys.argv[1], sys.argv[2]
lines = open(SRC).read().split('\n')

SPECIAL = {'defun', 'const', 'let', 'lambda', 'if', 'when', 'case', 'cond', 'do',
           'and', 'or', 'catch', 'quote', 'else'}

def esc(s):
    return html.escape(s, quote=False)

def inline(s):
    # Protect code spans, then apply bold and italic to the rest.
    codes = []
    def keep(m):
        codes.append('<code>' + esc(m.group(1)) + '</code>')
        return f'\x00{len(codes) - 1}\x00'
    t = re.sub(r'`([^`]+)`', keep, s)
    t = esc(t)
    t = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', t)
    t = re.sub(r'(?<![*\w])\*([^*\s][^*]*?)\*(?![*\w])', r'<em>\1</em>', t)
    t = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'\1', t)
    return re.sub(r'\x00(\d+)\x00', lambda m: codes[int(m.group(1))], t)

TOKEN = re.compile(r'''
   (?P<comment>;[^\n]*)
 | (?P<string>"(?:\\.|[^"\\])*")
 | (?P<paren>[()])
 | (?P<quote>')
 | (?P<atom>[^\s()'"]+)
 | (?P<ws>\s+)
''', re.X)

def hl_lisp(code):
    out, prev_open = [], False
    for m in TOKEN.finditer(code):
        kind, text = m.lastgroup, m.group()
        e = esc(text)
        if kind == 'comment':
            out.append(f'<span class="t-com">{e}</span>')
        elif kind == 'string':
            out.append(f'<span class="t-str">{e}</span>')
        elif kind == 'paren':
            out.append(f'<span class="t-par">{e}</span>')
        elif kind == 'quote':
            out.append(f'<span class="t-tag">{e}</span>')
        elif kind == 'atom':
            if '::' in text:
                out.append(f'<span class="t-host">{e}</span>')
            elif text.startswith(':') or text in ('#true', '#false'):
                out.append(f'<span class="t-tag">{e}</span>')
            elif re.fullmatch(r'-?\d+(\.\d+)?', text):
                out.append(f'<span class="t-num">{e}</span>')
            elif prev_open and text in SPECIAL:
                out.append(f'<span class="t-kw">{e}</span>')
            else:
                out.append(e)
        else:
            out.append(e)
        if kind != 'ws':
            prev_open = kind == 'paren' and text == '('
    return ''.join(out)

def hl_term(code):
    rows = []
    for ln in code.split('\n'):
        if ln.startswith('$ '):
            rows.append(f'<span class="t-prompt">$</span> <span class="t-cmd">{esc(ln[2:])}</span>')
        elif ln.startswith('#<error') or ln.startswith('  at ') or ln.startswith('caused by:'):
            rows.append(f'<span class="t-err">{esc(ln)}</span>')
        else:
            rows.append(esc(ln))
    return '\n'.join(rows)

def code_block(lang, body):
    label = {'sh': 'shell', 'lisp': 'slight', '': 'output'}.get(lang, lang)
    if lang == 'lisp' and body and re.match(r'^; \S+\.slight$', body[0]):
        label = body[0][2:]
        body = body[1:]
    code = '\n'.join(body)
    inner = hl_lisp(code) if lang == 'lisp' else hl_term(code)
    cls = 'out' if lang == '' else 'src'
    return (f'<figure class="code {cls}"><figcaption>{esc(label)}</figcaption>'
            f'<pre><code>{inner}</code></pre></figure>')

def table(rows):
    cells = [[c.strip() for c in r.strip().strip('|').split('|')] for r in rows]
    head, body = cells[0], cells[2:]
    h = ''.join(f'<th>{inline(c)}</th>' for c in head)
    b = ''.join('<tr>' + ''.join(f'<td>{inline(c)}</td>' for c in r) + '</tr>' for r in body)
    return f'<div class="table"><table><thead><tr>{h}</tr></thead><tbody>{b}</tbody></table></div>'

toc = []

def render(ls):
    out, i = [], 0
    while i < len(ls):
        ln = ls[i]
        if not ln.strip():
            i += 1
            continue
        if ln.startswith('```'):
            lang = ln[3:].strip()
            j = i + 1
            while not ls[j].startswith('```'):
                j += 1
            out.append(code_block(lang, ls[i + 1:j]))
            i = j + 1
            continue
        m = re.match(r'^(#{1,3}) (.*)$', ln)
        if m:
            level, text = len(m.group(1)), m.group(2)
            if level == 1:
                i += 1
                continue  # the page header carries the title
            n = re.match(r'^(\d+)\. (.*)$', text)
            if level == 2 and n:
                sid = 's' + n.group(1)
                toc.append((n.group(1), n.group(2), sid))
                out.append(f'<h2 id="{sid}"><span class="num">{n.group(1)}</span>{inline(n.group(2))}</h2>')
            else:
                out.append(f'<h{level}>{inline(text)}</h{level}>')
            i += 1
            continue
        if ln.startswith('|'):
            j = i
            while j < len(ls) and ls[j].startswith('|'):
                j += 1
            out.append(table(ls[i:j]))
            i = j
            continue
        lm = re.match(r'^(- |\d+\. )', ln)
        if lm:
            ordered = lm.group(1) != '- '
            items = []
            while i < len(ls):
                mm = re.match(r'^(- |\d+\. )(.*)$', ls[i])
                if not mm:
                    break
                width = len(mm.group(1))
                item = [mm.group(2)]
                i += 1
                while i < len(ls):
                    nxt = ls[i]
                    if nxt.startswith(' ' * width) or (nxt.strip() == '' and i + 1 < len(ls) and ls[i + 1].startswith(' ' * width)):
                        item.append(nxt[width:] if nxt.strip() else '')
                        i += 1
                    else:
                        break
                items.append(item)
            tag = 'ol' if ordered else 'ul'
            lis = ''.join(f'<li>{render_item(it)}</li>' for it in items)
            out.append(f'<{tag}>{lis}</{tag}>')
            continue
        j = i
        para = []
        while j < len(ls) and ls[j].strip() and not re.match(r'^(```|#|\||- |\d+\. )', ls[j]):
            para.append(ls[j].strip())
            j += 1
        out.append(f'<p>{inline(" ".join(para))}</p>')
        i = j
    return '\n'.join(out)

def render_item(item):
    # A list item with only text renders inline; one with blocks renders as blocks.
    if any(l.startswith('```') for l in item):
        return render(item)
    return inline(' '.join(l.strip() for l in item if l.strip()))

# Split off the intro (between the title and the first section).
first_h2 = next(i for i, l in enumerate(lines) if l.startswith('## '))
intro = render(lines[1:first_h2])
body = render(lines[first_h2:])

toc_html = ''.join(f'<li><a href="#{sid}"><span class="num">{n}</span>{inline(t)}</a></li>' for n, t, sid in toc)

page = f'''<title>slight CPI Tutorial</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=Source+Sans+3:ital,wght@0,400;0,600;1,400&family=JetBrains+Mono:wght@400;600&display=swap">
<style>
:root {{
  --bg: #f5f7f6;
  --surface: #ffffff;
  --ink: #1a2024;
  --muted: #56636b;
  --rule: #d9e0de;
  --accent: #17708a;
  --accent-soft: #e2eff2;
  --code-bg: #eef2f1;
  --out-bg: #1d2428;
  --out-ink: #d7e0e3;
  --out-err: #f0a58c;
  --t-com: #7a8a86;
  --t-str: #8a5a12;
  --t-kw: #6a3fb5;
  --t-host: #17708a;
  --t-tag: #a33b5d;
  --t-num: #2f7a3d;
  --t-par: #9aa7a4;
  --display: "Bricolage Grotesque", "Avenir Next", system-ui, sans-serif;
  --body: "Source Sans 3", "Segoe UI", system-ui, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
}}
@media (prefers-color-scheme: dark) {{
  :root:not([data-theme="light"]) {{
    color-scheme: dark;
    --bg: #111618;
    --surface: #182024;
    --ink: #e3e9eb;
    --muted: #9aa8ae;
    --rule: #2a3438;
    --accent: #5cb9d3;
    --accent-soft: #1b3038;
    --code-bg: #182125;
    --out-bg: #0b0f11;
    --out-ink: #cfd9dc;
    --out-err: #f2a88f;
    --t-com: #71827e;
    --t-str: #e0b36a;
    --t-kw: #b69cf0;
    --t-host: #5cb9d3;
    --t-tag: #ee8bab;
    --t-num: #8fd19a;
    --t-par: #5d6b69;
  }}
}}
:root[data-theme="dark"] {{
  color-scheme: dark;
  --bg: #111618;
  --surface: #182024;
  --ink: #e3e9eb;
  --muted: #9aa8ae;
  --rule: #2a3438;
  --accent: #5cb9d3;
  --accent-soft: #1b3038;
  --code-bg: #182125;
  --out-bg: #0b0f11;
  --out-ink: #cfd9dc;
  --out-err: #f2a88f;
  --t-com: #71827e;
  --t-str: #e0b36a;
  --t-kw: #b69cf0;
  --t-host: #5cb9d3;
  --t-tag: #ee8bab;
  --t-num: #8fd19a;
  --t-par: #5d6b69;
}}
* {{ box-sizing: border-box; }}
html {{ scroll-behavior: smooth; }}
@media (prefers-reduced-motion: reduce) {{ html {{ scroll-behavior: auto; }} }}
body {{
  background: var(--bg);
  color: var(--ink);
  font-family: var(--body);
  font-size: 17px;
  line-height: 1.6;
  padding-inline: 20px;
}}
.wrap {{
  max-width: 1120px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 40px;
  padding-block: 40px 96px;
}}
@media (min-width: 1000px) {{
  .wrap {{ grid-template-columns: 220px minmax(0, 1fr); gap: 56px; }}
  .toc {{ position: sticky; top: calc(env(safe-area-inset-top, 0px) + 32px); align-self: start; }}
}}
header.top {{ grid-column: 1 / -1; display: grid; gap: 14px; max-width: 72ch; }}
.eyebrow {{
  font-family: var(--mono); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--accent);
}}
h1 {{
  font-family: var(--display); font-weight: 700; font-size: clamp(34px, 6vw, 52px);
  line-height: 1.05; letter-spacing: -0.02em; margin: 0; text-wrap: balance;
}}
.lede {{ color: var(--muted); font-size: 19px; margin: 0; }}
.lede p {{ margin: 0 0 10px; }}
.toc h2 {{
  font-family: var(--mono); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--muted); margin: 0 0 10px; font-weight: 400;
}}
.toc ol {{ list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; border-left: 1px solid var(--rule); }}
.toc a {{
  display: flex; gap: 10px; padding: 5px 0 5px 14px; margin-left: -1px; border-left: 2px solid transparent;
  color: var(--muted); text-decoration: none; font-size: 15px; line-height: 1.35;
}}
.toc a:hover, .toc a:focus-visible {{ color: var(--ink); border-left-color: var(--accent); outline: none; }}
.toc .num {{ font-family: var(--mono); font-size: 12px; color: var(--accent); padding-top: 2px; min-width: 1ch; }}
main {{ min-width: 0; max-width: 74ch; }}
main h2 {{
  font-family: var(--display); font-weight: 700; font-size: 28px; line-height: 1.2; letter-spacing: -0.01em;
  margin: 56px 0 14px; display: flex; align-items: baseline; gap: 14px; text-wrap: balance;
  scroll-margin-top: 24px;
}}
main h2:first-child {{ margin-top: 0; }}
main h2 .num {{
  font-family: var(--mono); font-size: 14px; font-weight: 600; color: var(--accent);
  border: 1px solid var(--accent); border-radius: 4px; padding: 1px 7px; flex: none;
  transform: translateY(-3px);
}}
main p, main li {{ margin: 0 0 14px; }}
main ul, main ol {{ padding-left: 22px; margin: 0 0 18px; }}
main li::marker {{ color: var(--accent); }}
main li > p:last-child {{ margin-bottom: 0; }}
strong {{ font-weight: 600; }}
code {{
  font-family: var(--mono); font-size: 0.86em; background: var(--code-bg);
  padding: 1px 5px; border-radius: 4px; overflow-wrap: anywhere;
}}
figure.code {{ margin: 18px 0 22px; border-radius: 8px; overflow: hidden; border: 1px solid var(--rule); }}
figure.code figcaption {{
  font-family: var(--mono); font-size: 12px; letter-spacing: 0.04em;
  padding: 7px 14px; color: var(--muted); background: var(--surface); border-bottom: 1px solid var(--rule);
}}
figure.code pre {{ margin: 0; padding: 14px 16px; overflow-x: auto; font-size: 14px; line-height: 1.55; }}
figure.code pre code {{ background: none; padding: 0; font-size: inherit; overflow-wrap: normal; border-radius: 0; }}
figure.src pre {{ background: var(--code-bg); }}
figure.out {{ border-color: var(--out-bg); }}
figure.out figcaption {{ background: var(--out-bg); color: var(--t-com); border-bottom-color: #ffffff14; }}
figure.out pre {{ background: var(--out-bg); color: var(--out-ink); }}
.t-com {{ color: var(--t-com); font-style: italic; }}
.t-str {{ color: var(--t-str); }}
.t-kw {{ color: var(--t-kw); font-weight: 600; }}
.t-host {{ color: var(--t-host); font-weight: 600; }}
.t-tag {{ color: var(--t-tag); }}
.t-num {{ color: var(--t-num); }}
.t-par {{ color: var(--t-par); }}
.t-prompt {{ color: var(--t-com); }}
.t-cmd {{ color: #ffffff; }}
.t-err {{ color: var(--out-err); }}
.table {{ overflow-x: auto; margin: 18px 0 22px; border: 1px solid var(--rule); border-radius: 8px; background: var(--surface); }}
table {{ border-collapse: collapse; width: 100%; font-size: 15px; }}
th, td {{ text-align: left; vertical-align: top; padding: 10px 14px; border-bottom: 1px solid var(--rule); }}
tr:last-child td {{ border-bottom: none; }}
th {{ font-weight: 600; font-size: 13px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }}
td:first-child {{ white-space: nowrap; }}
@media (max-width: 640px) {{ td:first-child {{ white-space: normal; }} body {{ font-size: 16px; }} }}
a {{ color: var(--accent); }}
</style>
<div class="wrap">
  <header class="top">
    <div class="eyebrow">ts-cpi · control plane interpreter prototype</div>
    <h1>Writing control plane code</h1>
    <div class="lede">{intro}</div>
  </header>
  <nav class="toc" aria-label="Contents">
    <h2>Contents</h2>
    <ol>{toc_html}</ol>
  </nav>
  <main>
{body}
  </main>
</div>
'''
open(OUT, 'w').write(page)
print('wrote', OUT, len(page), 'bytes;', len(toc), 'sections')
