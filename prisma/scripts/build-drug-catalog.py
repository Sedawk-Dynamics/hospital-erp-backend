#!/usr/bin/env python3
"""
Build the bundled drug-catalogue release from the vendor's Excel drop.

    python prisma/scripts/build-drug-catalog.py --release 2026-06 \
        --drugs "data/June 2026 DRUGS DATA PART 1 of 2.xlsx" \
                "data/June 2026 DRUGS DATA PART 2 of 2.xlsx" \
        --otc   "data/June 2026 OTC DATA PART 1 of 1.xlsx"

Stdlib only. Writes prisma/scripts/data/drug-catalog/ (manifest.json plus
gzipped NDJSON), which ships in the image and is what the server imports on
boot. The Excel files themselves never leave the developer's machine: they are
660 MB, and GitHub refuses any file over 100 MB.

WHY THE OUTPUT IS SO MUCH SMALLER THAN THE INPUT
The vendor writes its long texts once per molecule/formulation and pastes the
brand name in: "Acenac Tablet is a pain-relieving medicine..." and "Zynac
Tablet is a pain-relieving medicine..." are one text. Replacing each product's
own name with {{name}} collapses 1.5 GB of drug prose to about 37 MB of
distinct text. The server stores it the same way and puts the name back when a
text is shown, so nothing is lost: rendering a template with the product's own
name gives back the vendor's text byte for byte.

WHAT THIS DOES NOT DO
It interprets nothing. Prices stay strings, flags stay the vendor's words, and
every column is carried through. Reading the data — dosage forms, pack sizes,
what "Prescription Required" means — is the server's job
(src/modules/drug-master/drug-catalog.normalize.ts), so changing how a field is
read never needs a rebuild. A column this script has never seen stops the build
rather than being dropped quietly.
"""
import argparse
import array
import datetime
import gc
import gzip
import hashlib
import json
import os
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
T, R, SI, ROW, C, V, IS = (NS + x for x in ('t', 'r', 'si', 'row', 'c', 'v', 'is'))

PLACEHOLDER = '{{name}}'
# Brand names are stored in a VARCHAR(255); a longer one is truncated there,
# and a template would render with the truncated name. Such a product keeps its
# texts verbatim instead. Very short names are left alone for the same reason
# in reverse — "Ace" would template every "Aceclofenac" in its own text.
TEMPLATE_NAME_MIN, TEMPLATE_NAME_MAX = 3, 255

# Columns kept on the product line, in the vendor's own words.
DRUG_INLINE = [
    'Product ID', 'Product Name', 'Marketer', 'Composition', 'medicine_type',
    'Packaging Detail', 'Package', 'Qty', 'Product Form', 'MRP',
    'prescription_required', 'Fact_Box', 'primary_use', 'storage', 'side_effect',
    'alcoholInteraction', 'pregnancyInteraction', 'lactationInteraction',
    'drivingInteraction', 'kidneyInteraction', 'liverInteraction', 'country_of_origin',
]
# Long prose, deduplicated into the text dictionary. column -> section key.
DRUG_TEXTS = {
    'Introduction': 'intro',
    'Benefits': 'benefits',
    'how_to_use': 'howToUse',
    'safety_advise': 'safetyAdvice',
    'if_miss': 'missedDose',
    'Q_A': 'faq',
    'How it works': 'howItWorks',
    'drug-drug Interaction': 'interactions',
    'Marketer details': 'marketer',
}
OTC_INLINE = [
    'Product ID', 'name', 'Category', 'Marketing Company', 'type', 'Packaging',
    'Package', 'Qty', 'Product Form', 'MRP', 'country_of_origin',
]
OTC_TEXTS = {
    'product_highlights': 'highlights',
    'Information': 'information',
    'Key Ingredients': 'ingredients',
    'Key Benefits': 'benefits',
    'Directions for Use': 'directions',
    'Safety Information': 'safetyInfo',
    'Marketer details': 'marketer',
}
# Image links appear in the vendor's sample sheet but not in the full drop.
# Hot-linking the vendor's CDN is not something to start by accident.
IGNORED_COLUMNS = {'Image_Urls'}

# Roll over to a new file at this much UNCOMPRESSED text, which lands each
# gzip file comfortably under GitHub's 50 MB warning line.
ROLL_BYTES = 160 * 1024 * 1024


def col_idx(ref):
    n = 0
    for ch in ref:
        o = ord(ch)
        if 65 <= o <= 90:
            n = n * 26 + (o - 64)
        else:
            break
    return n - 1


def load_shared_strings(z):
    """One UTF-8 bytearray + offsets: 1.7M strings with no per-object cost."""
    buf, offs = bytearray(), array.array('Q', [0])
    with z.open('xl/sharedStrings.xml') as fh:
        it = ET.iterparse(fh, events=('start', 'end'))
        _, root = next(it)
        n = 0
        for ev, el in it:
            if ev != 'end' or el.tag != SI:
                continue
            parts = []
            for ch in el:
                if ch.tag == T:
                    parts.append(ch.text or '')
                elif ch.tag == R:
                    t = ch.find(T)
                    if t is not None:
                        parts.append(t.text or '')
            buf += ''.join(parts).encode('utf-8')
            offs.append(len(buf))
            n += 1
            if n % 50000 == 0:
                root.clear()
    return buf, offs


def first_sheet_path(z):
    rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
    target = {r.get('Id'): r.get('Target') for r in rels}
    wb = ET.fromstring(z.read('xl/workbook.xml'))
    sheet = next(wb.iter(NS + 'sheet'))
    rid = sheet.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')
    t = target[rid].lstrip('/')
    return t if t.startswith('xl/') else 'xl/' + t


def read_rows(path):
    """Yield one {header: value} dict per data row. Values are strings."""
    z = zipfile.ZipFile(path)
    buf, offs = load_shared_strings(z)

    def s(i):
        return buf[offs[i]:offs[i + 1]].decode('utf-8')

    header = None
    with z.open(first_sheet_path(z)) as fh:
        it = ET.iterparse(fh, events=('start', 'end'))
        _, root = next(it)
        for ev, el in it:
            if ev != 'end' or el.tag != ROW:
                continue
            vals = {}
            for c in el.iter(C):
                t, v = c.get('t'), c.find(V)
                if t == 's':
                    val = s(int(v.text)) if v is not None else None
                elif t == 'inlineStr':
                    x = c.find(IS)
                    val = ''.join(y.text or '' for y in x.iter(T)) if x is not None else None
                else:
                    val = v.text if v is not None else None
                if val is not None and val != '':
                    vals[col_idx(c.get('r'))] = val
            root.clear()
            if header is None:
                header = [vals.get(i) for i in range(max(vals) + 1)]
                yield ('header', header)
                continue
            yield ('row', {header[i]: v for i, v in vals.items() if i < len(header) and header[i]})
    del buf, offs
    gc.collect()


class RollingGzip:
    """NDJSON written across numbered .gz files, each recorded in the manifest."""

    def __init__(self, out_dir, stem):
        self.out_dir, self.stem = out_dir, stem
        self.files, self._fh, self._raw, self._gz = [], None, 0, None
        self._count, self._written = 0, 0

    def _open(self):
        name = f'{self.stem}-{len(self.files) + 1:03d}.ndjson.gz'
        self._raw = open(os.path.join(self.out_dir, name), 'wb')
        # mtime=0 and no embedded filename: the same input builds the same bytes.
        self._gz = gzip.GzipFile(filename='', mode='wb', compresslevel=9, fileobj=self._raw, mtime=0)
        self.files.append({'file': name, 'count': 0})
        self._count, self._written = 0, 0

    def write(self, obj):
        if self._gz is None or self._written >= ROLL_BYTES:
            self.close()
            self._open()
        line = json.dumps(obj, ensure_ascii=False, separators=(',', ':'))
        # U+2028 / U+2029 are legal inside a JSON string, and the vendor's texts
        # contain them, but line readers such as Node's readline break a line at
        # them. Escaped, the file reads the same with any reader.
        line = (line.replace('\u2028', '\\u2028').replace('\u2029', '\\u2029') + '\n').encode('utf-8')
        self._gz.write(line)
        self._written += len(line)
        self._count += 1
        self.files[-1]['count'] = self._count

    def close(self):
        if self._gz is not None:
            self._gz.close()
            self._raw.close()
            self._gz = self._raw = None

    def finish(self):
        self.close()
        for f in self.files:
            with open(os.path.join(self.out_dir, f['file']), 'rb') as fh:
                f['sha256'] = hashlib.sha256(fh.read()).hexdigest()
                f['bytes'] = fh.tell()
        return self.files


class TextDictionary:
    """Distinct (section, template) pairs, numbered in order of first sight."""

    def __init__(self, writer):
        self.writer, self.index, self.raw_bytes, self.kept_bytes = writer, {}, 0, 0

    def ref(self, section, text, name):
        self.raw_bytes += len(text)
        if TEMPLATE_NAME_MIN <= len(name) <= TEMPLATE_NAME_MAX:
            text = text.replace(name, PLACEHOLDER)
        key = hashlib.blake2b((section + '\x00' + text).encode('utf-8'), digest_size=16).digest()
        idx = self.index.get(key)
        if idx is None:
            idx = len(self.index)
            self.index[key] = idx
            self.kept_bytes += len(text)
            self.writer.write([section, text])
        return idx


def build_kind(kind, paths, inline, texts, name_col, dictionary, out_dir, log):
    columns = inline + ['@' + s for s in texts.values()]
    writer = RollingGzip(out_dir, kind)
    seen_ids, rows, skipped = set(), 0, 0
    for path in paths:
        log(f'{kind}: reading {os.path.basename(path)}')
        for tag, payload in read_rows(path):
            if tag == 'header':
                known = set(inline) | set(texts) | IGNORED_COLUMNS
                unknown = [h for h in payload if h and h not in known]
                missing = [h for h in inline + list(texts) if h not in payload]
                if unknown:
                    sys.exit(f'{path}: columns this build has never seen: {unknown}. '
                             'Map them in build-drug-catalog.py and drug-catalog.normalize.ts first.')
                if missing:
                    log(f'  WARNING {path}: expected columns absent: {missing}')
                continue
            row = payload
            pid = (row.get('Product ID') or '').strip()
            name = (row.get(name_col) or '').strip()
            if not pid or not name:
                skipped += 1
                continue
            if pid in seen_ids:
                log(f'  duplicate Product ID {pid} — first occurrence kept')
                skipped += 1
                continue
            seen_ids.add(pid)
            line = [row.get(c) for c in inline]
            line[inline.index(name_col)] = name
            line[inline.index('Product ID')] = pid
            for col in texts:
                v = row.get(col)
                line.append(dictionary.ref(texts[col], v, name) if v else None)
            writer.write(line)
            rows += 1
            if rows % 100000 == 0:
                log(f'  {rows:,} {kind} rows')
    files = writer.finish()
    log(f'{kind}: {rows:,} products, {skipped} blank/duplicate rows skipped')
    return {'columns': columns, 'files': files, 'count': rows}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--release', required=True, help='Release label, e.g. 2026-06')
    ap.add_argument('--drugs', nargs='+', required=True, help='Drug workbook(s), in order')
    ap.add_argument('--otc', nargs='*', default=[], help='OTC workbook(s), in order')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), 'data', 'drug-catalog'))
    args = ap.parse_args()

    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    for f in os.listdir(out_dir):
        if f.endswith('.ndjson.gz') or f == 'manifest.json':
            os.remove(os.path.join(out_dir, f))

    def log(msg):
        print(f'[{datetime.datetime.now():%H:%M:%S}] {msg}', flush=True)

    text_writer = RollingGzip(out_dir, 'texts')
    dictionary = TextDictionary(text_writer)
    drugs = build_kind('drugs', args.drugs, DRUG_INLINE, DRUG_TEXTS, 'Product Name', dictionary, out_dir, log)
    otc = build_kind('otc', args.otc, OTC_INLINE, OTC_TEXTS, 'name', dictionary, out_dir, log) if args.otc else None
    text_files = text_writer.finish()
    log(f'texts: {len(dictionary.index):,} distinct, {dictionary.raw_bytes / 1e6:,.0f} MB of prose '
        f'kept as {dictionary.kept_bytes / 1e6:,.1f} MB')

    manifest = {
        'format': 1,
        'release': args.release,
        'builtAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
        'sources': [os.path.basename(p) for p in args.drugs + args.otc],
        'placeholder': PLACEHOLDER,
        'texts': {'files': text_files, 'count': len(dictionary.index)},
        'drugs': drugs,
    }
    if otc:
        manifest['otc'] = otc
    with open(os.path.join(out_dir, 'manifest.json'), 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    total = sum(f['bytes'] for f in text_files + drugs['files'] + (otc['files'] if otc else []))
    log(f'wrote {out_dir} — {total / 1e6:,.1f} MB')


if __name__ == '__main__':
    main()
