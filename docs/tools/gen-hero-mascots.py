"""Generate the hero's four rigged mascot buttons for youcoded/docs/index.html.

The art is the app's OWN default buddy rig (desktop/src/renderer/components/
mascot/default-buddy-rig.ts) — the 2.5D-soft skin, tinted through --rig-accent /
--rig-on-accent. One silhouette, four colours, exactly as the 2026-08-30 picker
decision requires; what differs per button is how it MOVES.

NOT a build step -- index.html is hand-edited and is the live page. This exists so
that when the app's buddy rig changes, or the picker's four themes change, the
markup can be regenerated instead of four 6 KB SVG blocks being edited by hand.
Paste its output over the two <div class="mrow"> blocks in docs/index.html.
"""
import re, sys

# Run from the repo root:  python3 docs/tools/gen-hero-mascots.py
RIG_TS = 'desktop/src/renderer/components/mascot/default-buddy-rig.ts'

PICKER = [
    # slug,                 name,                  accent,     onAccent,  act
    ('cotton-candy-sky',    'Cotton Candy Sky',    '#8B47B8', '#FFFFFF', 'greet'),
    ('meadow-mist',         'Meadow Mist',         '#2F7D55', '#FFFFFF', 'sway'),
    ('halftone-dimension',  'Halftone Dimension',  '#E51F48', '#ffffff', 'look'),
    ('golden-sunbreak',     'Golden Sunbreak',     '#ffc030', '#000000', 'hop'),
]

# Buddy-floater-only furniture: peek mittens for clinging to a screen edge, and
# the three accessory slots the theme system fills. None of it can happen in a
# 62px picker chip, so it is dropped rather than shipped as dead markup.
DROP_GROUPS = ['rig-hand-peek-right', 'rig-hand-peek-left',
               'slot-hat', 'slot-eyewear', 'slot-item', 'rig-face-dizzy']
DEF_IDS = ['g-hi', 'g-lo', 'g-limb-shade', 'g-spec', 'f-soft']


def rig_body() -> str:
    src = open(RIG_TS, encoding='utf-8').read()
    m = re.search(r'DEFAULT_BUDDY_RIG = `([\s\S]*?)`;', src)
    if not m:
        sys.exit('could not find DEFAULT_BUDDY_RIG in ' + RIG_TS)
    svg = m.group(1)
    return svg[svg.index('>', svg.index('<svg')) + 1: svg.rindex('</svg>')]


def drop_group(svg: str, gid: str) -> str:
    """Remove <g id="gid" …>…</g> (or its self-closing form). The rig nests only
    one level inside these groups, so a non-greedy match to the next </g> is
    correct — asserted by the caller checking the id is gone."""
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


def button(slug, name, accent, on_accent, act, body) -> str:
    # Def ids are suffixed per button so four inlined copies never share a
    # gradient by accident; every OTHER hook is a class, because the driver and
    # the stylesheet address parts by class and duplicate ids would be a trap.
    for d in DEF_IDS:
        body = body.replace('id="%s"' % d, 'id="%s-%s"' % (d, slug))
        body = body.replace('url(#%s)' % d, 'url(#%s-%s)' % (d, slug))
    for part in ['rig-root', 'rig-arm-left', 'rig-arm-right', 'rig-leg-left',
                 'rig-leg-right', 'rig-body']:
        body = body.replace('<g id="%s"' % part, '<g class="%s"' % part)
    for face in ['idle', 'welcome', 'curious', 'shocked', 'blink']:
        # The inline display:none is dropped: an inline style outranks the
        # stylesheet, and the stylesheet is what switches faces.
        body = body.replace('<g id="rig-face-%s" style="display:none">' % face,
                            '<g class="rig-face rig-face-%s">' % face)
        body = body.replace('<g id="rig-face-%s">' % face,
                            '<g class="rig-face rig-face-%s">' % face)
    assert 'id="rig-' not in body and 'style="display:none"' not in body, slug
    body = re.sub(r'\n\s+', '\n', body).strip()
    return (
        '<button class="mascot" data-theme="%s" data-act="%s" data-face="welcome"\n'
        '  aria-label="Use the %s look" style="--a:%s;--rig-on-accent:%s">'
        '<span class="m-chip"></span>\n'
        '<svg class="m-art m-rig" viewBox="-3 -5 30 30" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">\n'
        '%s\n</svg><span class="m-name">%s</span></button>'
    ) % (slug, act, name, accent, on_accent, body, name)


def main():
    body = rig_body()
    for gid in DROP_GROUPS:
        body = drop_group(body, gid)
        assert 'id="%s"' % gid not in body, gid
    out = [button(*row, body) for row in PICKER]
    print('<!--LEFT-->\n' + '\n'.join(out[:2]))
    print('<!--RIGHT-->\n' + '\n'.join(out[2:]))


main()
