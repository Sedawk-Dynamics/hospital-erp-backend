"""
Turn the WHO ICD-10 ClaML XML into the compact dataset the ICD seed ships.

    python prisma/scripts/parse-icd10-claml.py <path-to-icd102019en.xml>

Source: WHO ICD-10 2019 (covid-expanded) ClaML release, `icd102019en.xml`.
Output: src/seeds/data/icd10-who-2019.json, imported by src/seeds/icd-claml.ts.

Why pre-parse instead of reading the XML at boot: the source is 9.2 MB of XML
and the seed runs on every start. Parsing once and committing the result keeps
boot fast and makes the data reviewable in a diff.

WHAT IS KEPT
  code          the ICD-10 code (max 5 chars in this release)
  title         the `preferred` rubric
  block/chapter resolved by walking `SuperClass` up the tree, so a picker can
                show "Ischaemic heart diseases · Diseases of the circulatory
                system" beside a code
  synonyms      every `inclusion` rubric, which is what makes the catalogue
                searchable in clinical language — I10 carries "high blood
                pressure", I21.0 carries "anterolateral"
  leaf          true when no other class names this one as its SuperClass.
                Only a leaf is billable on its own; a parent like I21 is a
                grouping.

FOURTH-CHARACTER MODIFIERS
WHO does not write out every subdivision. E10-E14 (diabetes) share one
`Modifier` block, referenced from each class by `ModifiedBy` — so the raw file
has `E11` but NOT `E11.9`, and E11.9 "Type 2 diabetes mellitus without
complications" is among the most-used codes in any hospital. Those are expanded
here: 217 classes, ~1,788 sub-codes.

Only DOTTED (fourth-character) modifiers are expanded. The bare ones are FIFTH
characters that the release itself describes as "provided for optional use in a
supplementary character position" — and appending one to a three-character
parent would invent a malformed code. The eight classes carrying two modifiers
are all blocks in the external-causes chapter, which are never emitted anyway.

WHAT IS DROPPED
  chapters and blocks   they are groupings, not diagnoses — a doctor cannot
                        pick "Diseases of the circulatory system". Their titles
                        ride along on each category instead.
  exclusion / note / coding-hint rubrics
                        genuinely useful to a coder ("Excl.: ...") but there is
                        no column for them on IcdCode. Worth revisiting if a
                        coding-assistance surface is ever built.
"""
import json
import io
import sys
import xml.etree.ElementTree as ET

DEFAULT_SRC = r'E:\hospital erp\snomed ct and icd\snomed ct and icd\icd102019en.xml\icd102019en.xml'
OUT = 'src/seeds/data/icd10-who-2019.json'


def label_terms(label):
    """A Rubric label as separate terms.

    Inclusion rubrics are split into <Fragment> elements — a stem plus its
    variants, e.g. "Transmural infarction (acute)(of):" then "anterolateral".
    Joining them makes one unsearchable string; a doctor types "anterolateral".
    """
    parts = []
    for node in label.iter():
        if node.tag in ('Fragment', 'Label'):
            txt = (node.text or '').strip()
            if txt:
                parts.append(txt)
        if node.tail and node.tail.strip():
            parts.append(node.tail.strip())
    return parts


def clean(s):
    return ' '.join(s.split())


def lower_first(s):
    return s[:1].lower() + s[1:] if s else s


def main(src):
    root = ET.parse(src).getroot()
    title_el = root.find('Title')
    version = (
        f"{title_el.get('name')} {title_el.get('version')}"
        if title_el is not None else 'ICD-10'
    )

    # Fourth-character subdivisions, keyed by modifier id.
    modifiers = {}
    for mc in root.iter('ModifierClass'):
        code = mc.get('code') or ''
        if not code.startswith('.'):
            continue  # fifth character, optional — see module docstring
        lab = mc.find('Rubric/Label')
        if lab is None:
            continue
        modifiers.setdefault(mc.get('modifier'), []).append(
            (code, clean(''.join(lab.itertext())))
        )

    classes = {}
    for cls in root.iter('Class'):
        code, kind = cls.get('code'), cls.get('kind')
        if not code or kind not in ('chapter', 'block', 'category'):
            continue
        sup = cls.find('SuperClass')
        preferred, inclusions = None, []
        for rub in cls.findall('Rubric'):
            lab = rub.find('Label')
            if lab is None:
                continue
            parts = label_terms(lab)
            if not parts:
                continue
            if rub.get('kind') == 'preferred' and preferred is None:
                preferred = clean(' '.join(parts))
            elif rub.get('kind') == 'inclusion':
                for p in parts:
                    p = clean(p).rstrip(':').strip()
                    if len(p) > 2:
                        inclusions.append(p)
        classes[code] = {
            'kind': kind,
            'sup': sup.get('code') if sup is not None else None,
            'title': preferred,
            'inc': inclusions,
            'mods': [m.get('code') for m in cls.findall('ModifiedBy')],
        }

    parents = {c['sup'] for c in classes.values() if c['sup']}

    def ancestor(code, want):
        cur, hops = classes.get(code, {}).get('sup'), 0
        while cur and hops < 12:
            node = classes.get(cur)
            if not node:
                return None
            if node['kind'] == want:
                return node['title']
            cur, hops = node['sup'], hops + 1
        return None

    rows = []
    for code, c in classes.items():
        if c['kind'] != 'category' or not c['title']:
            continue
        block, chapter = ancestor(code, 'block'), ancestor(code, 'chapter')
        subs = [s for m in c['mods'] for s in modifiers.get(m, [])]

        rows.append({
            'c': code,
            't': c['title'][:500],
            'b': block,
            'ch': chapter,
            # A class with expanded subdivisions becomes a grouping, not a
            # billable code in its own right.
            'leaf': code not in parents and not subs,
            **({'k': sorted({k.lower() for k in c['inc']})} if c['inc'] else {}),
        })

        for suffix, label in subs:
            rows.append({
                'c': f'{code}{suffix}',
                't': f'{c["title"]}, {lower_first(label)}'[:500],
                'b': block,
                'ch': chapter,
                'leaf': True,
            })

    rows.sort(key=lambda r: r['c'])
    io.open(OUT, 'w', encoding='utf-8').write(
        json.dumps({'version': version, 'codes': rows},
                   ensure_ascii=False, separators=(',', ':'))
    )

    print(f'version       : {version}')
    print(f'codes         : {len(rows)}')
    print(f'  billable    : {sum(1 for r in rows if r["leaf"])}')
    print(f'  w/ synonyms : {sum(1 for r in rows if r.get("k"))}')
    print(f'  expanded    : {sum(1 for r in rows if len(r["c"]) > 3 and not r.get("k") and r["leaf"])}')
    print(f'missing block : {sum(1 for r in rows if not r["b"])}')
    print(f'missing chap  : {sum(1 for r in rows if not r["ch"])}')
    print(f'-> {OUT}')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC)
