"""Generate the hero's four rigged mascot buttons for youcoded/docs/index.html.

Run from the repo root:  python3 docs/tools/gen-hero-mascots.py
Paste its output over the two <div class="mrow"> blocks in docs/index.html.

NOT a build step -- index.html is hand-edited and is the live page. This exists so
that when a theme's mascot changes, or the picker's four themes change, the markup
can be regenerated instead of four 7 KB SVG blocks being edited by hand.

WHERE THE ART COMES FROM. Each button wears its theme's OWN mascot, vendored into
docs/mascots/<slug>.rig.svg from wecoded-themes/themes/<slug>/assets/mascot-rig.svg
-- the rigs rebuilt to the rig contract in wecoded-themes/mascots/README.md
(f52cc85, 130afab). They are complete characters with hardcoded identity colours
and six authored faces, so nothing here tints them.

A theme with no mascot of its own falls back to the app's built-in default buddy
(desktop/src/renderer/components/mascot/default-buddy-rig.ts), which IS tinted --
and its face socket is deliberately a DARK theme colour, never the theme's
on-accent. Passing on-accent gave white-on-purple eyes and a white mouth, and
Destin's word for the result was "terrifying" (2026-09-04). The rig library says
the same thing in prose: "paint eyes on top in a DARK socket colour".
"""
import re
import sys

DEFAULT_RIG_TS = 'desktop/src/renderer/components/mascot/default-buddy-rig.ts'
THEME_RIG = 'docs/mascots/%s.rig.svg'

# slug, display name, accent, dark face socket (only used by the fallback buddy;
# a theme rig paints its own face), idle act
PICKER = [
    ('cotton-candy-sky',   'Cotton Candy Sky',   '#8B47B8', '#21152C', 'greet'),
    ('meadow-mist',        'Meadow Mist',        '#2F7D55', '#041008', 'sway'),
    ('halftone-dimension', 'Halftone Dimension', '#E51F48', None,      'look'),
    ('golden-sunbreak',    'Golden Sunbreak',    '#ffc030', None,      'hop'),
]

# Dropped: the mittens that grip a screen edge (there is no screen edge in a
# 62px chip) and the dizzy face (nothing here spins).
#
# NOT DROPPED, and this was a real mistake on the first pass: slot-hat and
# slot-eyewear. They read like empty scaffolding, but the rig library puts each
# theme's SIGNATURE in them -- "the dimensional visor is eyewear, Kuromi's
# jester hat and Strawberry Kitty's ears-and-bow are hats" (wecoded-themes/
# mascots/README.md -> Component slots). Stripping them turned Halftone's bot
# into a featureless dark blob and left both cats bald. An empty slot costs 20
# bytes; an emptied one costs the character.
DROP_GROUPS = ['rig-hand-peek-right', 'rig-hand-peek-left', 'rig-face-dizzy']

PARTS = ['rig-root', 'rig-arm-left', 'rig-arm-right', 'rig-leg-left',
         'rig-leg-right', 'rig-body', 'rig-tail']
FACES = ['idle', 'welcome', 'curious', 'shocked', 'blink']


def inner_svg(svg: str) -> str:
    """Everything between <svg …> and </svg>."""
    return svg[svg.index('>', svg.index('<svg')) + 1: svg.rindex('</svg>')]


def load_rig(slug: str) -> str:
    try:
        return inner_svg(open(THEME_RIG % slug, encoding='utf-8').read())
    except FileNotFoundError:
        src = open(DEFAULT_RIG_TS, encoding='utf-8').read()
        m = re.search(r'DEFAULT_BUDDY_RIG = `([\s\S]*?)`;', src)
        if not m:
            sys.exit('could not find DEFAULT_BUDDY_RIG in ' + DEFAULT_RIG_TS)
        return inner_svg(m.group(1))


def drop_group(svg: str, gid: str) -> str:
    """Remove <g id="gid" …>…</g>, or its self-closing form, balancing nesting."""
    self_closing = re.search(r'<g id="%s"\s*/>' % re.escape(gid), svg)
    if self_closing:
        return svg[:self_closing.start()] + svg[self_closing.end():]
    open_m = re.search(r'<g id="%s"[^>]*>' % re.escape(gid), svg)
    if not open_m:
        return svg
    depth, i = 1, open_m.end()
    while depth:
        nxt = re.search(r'<g\b|</g>', svg[i:])
        if not nxt:
            sys.exit('unbalanced <g> hunting ' + gid)
        i += nxt.end()
        depth += 1 if nxt.group() == '<g' else -1
    return svg[:open_m.start()] + svg[i:]


def button(slug, name, accent, socket, act) -> str:
    body = load_rig(slug)
    for gid in DROP_GROUPS:
        body = drop_group(body, gid)
        assert 'id="%s"' % gid not in body, (slug, gid)

    # Rig hooks become CLASSES. The driver and the stylesheet address parts by
    # class precisely because four rigs are inlined into one document and four
    # elements called rig-arm-left would be a trap.
    for part in PARTS:
        body = body.replace('<g id="%s"' % part, '<g class="%s"' % part)
    for face in FACES:
        # The inline display:none goes with it -- an inline style outranks the
        # stylesheet, and the stylesheet is what switches faces.
        body = re.sub(r'<g id="rig-face-%s"[^>]*>' % face,
                      '<g class="rig-face rig-face-%s">' % face, body)
    assert 'id="rig-' not in body, slug

    # Every id that SURVIVES is a gradient/filter/clip the art references. Suffix
    # them per button: four inlined rigs otherwise share whichever "gs-hi" the
    # document happens to define first, and one theme's lighting silently paints
    # another's body.
    for rid in sorted(set(re.findall(r'id="([^"]+)"', body)), key=len, reverse=True):
        body = body.replace('id="%s"' % rid, 'id="%s-%s"' % (rid, slug))
        body = body.replace('url(#%s)' % rid, 'url(#%s-%s)' % (rid, slug))
        body = body.replace('href="#%s"' % rid, 'href="#%s-%s"' % (rid, slug))
    assert 'url(#' not in body or all(
        ref.endswith('-' + slug) for ref in re.findall(r'url\(#([^)]+)\)', body)), slug

    body = re.sub(r'\n\s+', '\n', body).strip()
    style = '--a:%s' % accent + (';--rig-on-accent:%s' % socket if socket else '')
    return (
        '<button class="mascot" data-theme="%s" data-act="%s" data-face="welcome"\n'
        '  aria-label="Use the %s look" style="%s"><span class="m-chip"></span>\n'
        '<svg class="m-art m-rig" viewBox="-3 -5 30 30" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">\n'
        '%s\n</svg><span class="m-name">%s</span></button>'
    ) % (slug, act, name, style, body, name)


def main():
    out = [button(*row) for row in PICKER]
    print('<!--LEFT-->\n' + '\n'.join(out[:2]))
    print('<!--RIGHT-->\n' + '\n'.join(out[2:]))


main()
