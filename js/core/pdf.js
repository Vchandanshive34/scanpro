/**
 * Searchable PDF writer.
 *
 * Produces a PDF where each page is the scanned image with an *invisible*
 * text layer positioned over the words OCR found. The result looks exactly
 * like the scan, but text can be selected, copied and searched — including
 * Devanagari, Tamil, Bengali and the rest.
 *
 * Written by hand rather than with a PDF library for one specific reason:
 * Indic text needs a Type0/Identity-H font with a ToUnicode CMap, and the
 * usual browser PDF libraries either embed Latin-only base fonts (which mangle
 * Indic text on extraction) or require embedding megabytes of real script
 * fonts per document. Because the text layer is invisible, we instead embed a
 * single 836-byte glyphless font and carry the real Unicode in ToUnicode. Any
 * script, no per-script font cost.
 */

import { GLYPHLESS_FONT_B64 } from './glyphless-font.js';

const PT_PER_INCH = 72;

export const PAGE_SIZES = {
  fit:    null,                       // page matches the image's own aspect
  a4:     { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
  legal:  { width: 612, height: 1008 },
  a5:     { width: 419.53, height: 595.28 },
};

/* ------------------------------------------------------------------ */
/* Byte helpers                                                        */
/* ------------------------------------------------------------------ */

const enc = new TextEncoder();

function latin1Bytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

function concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Escape a string for a PDF literal string, as UTF-16BE with BOM. */
function pdfTextString(str) {
  const units = [0xfe, 0xff];
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) {
      const v = cp - 0x10000;
      const hi = 0xd800 + (v >> 10);
      const lo = 0xdc00 + (v & 0x3ff);
      units.push(hi >> 8, hi & 0xff, lo >> 8, lo & 0xff);
    } else {
      units.push(cp >> 8, cp & 0xff);
    }
  }
  return '<' + units.map((b) => b.toString(16).padStart(2, '0')).join('') + '>';
}

function pdfDate(d = new Date()) {
  const p = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
         `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
         `${sign}${p(off / 60 | 0)}'${p(off % 60)}'`;
}

/** Deflate with the platform compressor when available. */
async function maybeDeflate(bytes) {
  if (typeof CompressionStream === 'undefined') return { data: bytes, filter: null };
  try {
    const cs = new CompressionStream('deflate');
    const stream = new Blob([bytes]).stream().pipeThrough(cs);
    const buf = await new Response(stream).arrayBuffer();
    const out = new Uint8Array(buf);
    return out.length < bytes.length
      ? { data: out, filter: '/FlateDecode' }
      : { data: bytes, filter: null };
  } catch {
    return { data: bytes, filter: null };
  }
}

/* ------------------------------------------------------------------ */
/* Font: CID inventory shared across the document                      */
/* ------------------------------------------------------------------ */

/**
 * Assigns a CID to every distinct grapheme cluster used in the text layer.
 *
 * Clusters, not codepoints: "क्षि" is several codepoints that a reader thinks
 * of as one unit, and keeping clusters intact makes copied text round-trip
 * correctly.
 */
class CidInventory {
  constructor() {
    this.map = new Map();   // cluster -> cid
    this.list = [];         // cid -> cluster
    this.segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
      ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      : null;
  }

  clusters(text) {
    if (this.segmenter) {
      return [...this.segmenter.segment(text)].map((s) => s.segment);
    }
    return [...text]; // codepoint fallback
  }

  /** @returns {number[]} CIDs for the text */
  encode(text) {
    const out = [];
    for (const cluster of this.clusters(text)) {
      let cid = this.map.get(cluster);
      if (cid === undefined) {
        cid = this.list.length + 1;   // CID 0 stays .notdef
        this.map.set(cluster, cid);
        this.list.push(cluster);
      }
      out.push(cid);
    }
    return out;
  }

  get maxCid() { return this.list.length; }

  /** Build the ToUnicode CMap that makes the layer searchable. */
  toUnicodeCMap() {
    const entries = this.list.map((cluster, i) => {
      const cid = (i + 1).toString(16).padStart(4, '0');
      let hex = '';
      for (const ch of cluster) {
        const cp = ch.codePointAt(0);
        if (cp > 0xffff) {
          const v = cp - 0x10000;
          hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0');
          hex += (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
        } else {
          hex += cp.toString(16).padStart(4, '0');
        }
      }
      return `<${cid}> <${hex}>`;
    });

    // bfchar sections are capped at 100 entries by the spec.
    const chunks = [];
    for (let i = 0; i < entries.length; i += 100) {
      const slice = entries.slice(i, i + 100);
      chunks.push(`${slice.length} beginbfchar\n${slice.join('\n')}\nendbfchar`);
    }

    return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${chunks.join('\n')}
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
  }

  /** All CIDs map to the single blank glyph 0. */
  cidToGidMap() {
    return new Uint8Array((this.maxCid + 1) * 2); // all zero
  }
}

/* ------------------------------------------------------------------ */
/* Text layer geometry                                                 */
/* ------------------------------------------------------------------ */

/**
 * Turn OCR words into PDF text-drawing operators.
 *
 * Each word is drawn in render mode 3 (invisible) at a font size matching its
 * height, then horizontally scaled with Tz so the string's advance width
 * matches the word's real width on the page. That keeps selection rectangles
 * lined up with what the reader sees, without needing true glyph metrics.
 */
function buildTextOps(words, inv, scaleX, scaleY, pageHeight, offsetX, offsetY) {
  const ops = ['BT', '3 Tr'];   // 3 Tr = invisible

  for (const w of words) {
    if (!w || w.noise) continue;
    const text = (w.text || '').trim();
    if (!text) continue;

    const b = w.bbox || w;
    const x0 = b.x0 * scaleX + offsetX;
    const x1 = b.x1 * scaleX + offsetX;
    const y0 = b.y0 * scaleY + offsetY;
    const y1 = b.y1 * scaleY + offsetY;

    const wpt = x1 - x0;
    const hpt = y1 - y0;
    if (wpt <= 0.4 || hpt <= 0.4) continue;

    const cids = inv.encode(text);
    if (!cids.length) continue;

    // PDF's origin is bottom-left; image coordinates run top-down.
    const baseline = pageHeight - y1 + hpt * 0.18;
    const fontSize = Math.max(1, hpt * 0.92);

    // Glyph advance is a flat 0.5 em, so scale to fit the measured width.
    const natural = cids.length * 0.5 * fontSize;
    const tz = Math.max(1, Math.min(1200, (wpt / natural) * 100));

    const hex = cids.map((c) => c.toString(16).padStart(4, '0')).join('');

    ops.push(`${tz.toFixed(2)} Tz`);
    ops.push(`/F1 ${fontSize.toFixed(2)} Tf`);
    ops.push(`1 0 0 1 ${x0.toFixed(2)} ${baseline.toFixed(2)} Tm`);
    ops.push(`<${hex}> Tj`);
  }

  ops.push('ET');
  return ops.join('\n');
}

/* ------------------------------------------------------------------ */
/* Document builder                                                    */
/* ------------------------------------------------------------------ */

/**
 * Build a searchable PDF.
 *
 * @param {Array} pages  [{ jpeg: Uint8Array, width, height, words: [] }]
 * @param {Object} opts  { title, author, pageSize, margin, dpi }
 * @returns {Promise<Blob>}
 */
export async function buildSearchablePDF(pages, opts = {}) {
  const {
    title = 'Scan',
    author = '',
    pageSize = 'fit',
    margin = 0,
    creator = 'ScanPro',
  } = opts;

  const inv = new CidInventory();
  const objects = [];   // 1-indexed; objects[i] is the body of object i+1

  const addObject = (bytes) => {
    objects.push(bytes instanceof Uint8Array ? bytes : latin1Bytes(bytes));
    return objects.length;   // object number
  };

  const addStream = async (dict, data, { compress = true } = {}) => {
    const raw = data instanceof Uint8Array ? data : latin1Bytes(data);
    const { data: body, filter } = compress
      ? await maybeDeflate(raw)
      : { data: raw, filter: null };

    const entries = { ...dict, Length: body.length };
    if (filter) entries.Filter = filter;

    const dictStr = '<< ' + Object.entries(entries)
      .map(([k, v]) => `/${k} ${v}`).join(' ') + ' >>\n';

    return addObject(concat([
      latin1Bytes(dictStr + 'stream\n'),
      body,
      latin1Bytes('\nendstream'),
    ]));
  };

  // --- Reserve object numbers we need to reference before we write them ---
  const CATALOG = 1, PAGES = 2;
  objects.push(new Uint8Array(0));  // placeholder 1
  objects.push(new Uint8Array(0));  // placeholder 2

  // --- Font objects -------------------------------------------------
  const fontBytes = base64ToBytes(GLYPHLESS_FONT_B64);
  const fontFileNum = await addStream(
    { Length1: fontBytes.length }, fontBytes, { compress: true });

  const descriptorNum = addObject(
    `<< /Type /FontDescriptor /FontName /GlyphLessFont /Flags 4 ` +
    `/FontBBox [0 -200 500 800] /ItalicAngle 0 /Ascent 800 /Descent -200 ` +
    `/CapHeight 700 /StemV 80 /FontFile2 ${fontFileNum} 0 R >>`);

  // Filled in after every page's text has been encoded.
  const cidToGidNum = objects.push(new Uint8Array(0));
  const toUnicodeNum = objects.push(new Uint8Array(0));

  const descendantNum = addObject(
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /GlyphLessFont ` +
    `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
    `/FontDescriptor ${descriptorNum} 0 R /DW 500 ` +
    `/CIDToGIDMap ${cidToGidNum} 0 R >>`);

  const fontNum = addObject(
    `<< /Type /Font /Subtype /Type0 /BaseFont /GlyphLessFont ` +
    `/Encoding /Identity-H /DescendantFonts [${descendantNum} 0 R] ` +
    `/ToUnicode ${toUnicodeNum} 0 R >>`);

  // --- Pages --------------------------------------------------------
  const pageNums = [];

  for (const page of pages) {
    const imgW = page.width;
    const imgH = page.height;

    let pw, ph, drawW, drawH, offX, offY;

    if (pageSize === 'fit' || !PAGE_SIZES[pageSize]) {
      // Page takes the image's aspect at a sane physical size.
      const dpi = page.dpi || 200;
      pw = (imgW / dpi) * PT_PER_INCH;
      ph = (imgH / dpi) * PT_PER_INCH;
      drawW = pw; drawH = ph; offX = 0; offY = 0;
    } else {
      const size = PAGE_SIZES[pageSize];
      // Portrait or landscape, whichever suits the image.
      const landscape = imgW > imgH;
      pw = landscape ? size.height : size.width;
      ph = landscape ? size.width : size.height;

      const availW = pw - margin * 2;
      const availH = ph - margin * 2;
      const scale = Math.min(availW / imgW, availH / imgH);
      drawW = imgW * scale;
      drawH = imgH * scale;
      offX = (pw - drawW) / 2;
      offY = (ph - drawH) / 2;
    }

    const imgNum = await addStream({
      Type: '/XObject',
      Subtype: '/Image',
      Width: imgW,
      Height: imgH,
      ColorSpace: page.gray ? '/DeviceGray' : '/DeviceRGB',
      BitsPerComponent: 8,
      Filter: '/DCTDecode',
    }, page.jpeg, { compress: false });   // JPEG is already compressed

    const scaleX = drawW / imgW;
    const scaleY = drawH / imgH;

    // The text layer's y offset is measured from the top of the page.
    const textOps = buildTextOps(
      page.words || [], inv, scaleX, scaleY, ph, offX, ph - drawH - offY);

    const content =
      `q\n${drawW.toFixed(2)} 0 0 ${drawH.toFixed(2)} ${offX.toFixed(2)} ${offY.toFixed(2)} cm\n` +
      `/Im0 Do\nQ\n${textOps}\n`;

    const contentNum = await addStream({}, content);

    const pageNum = addObject(
      `<< /Type /Page /Parent ${PAGES} 0 R ` +
      `/MediaBox [0 0 ${pw.toFixed(2)} ${ph.toFixed(2)}] ` +
      `/Resources << /XObject << /Im0 ${imgNum} 0 R >> ` +
      `/Font << /F1 ${fontNum} 0 R >> /ProcSet [/PDF /Text /ImageC /ImageB] >> ` +
      `/Contents ${contentNum} 0 R >>`);

    pageNums.push(pageNum);
  }

  // --- Font tables now that every CID is known ----------------------
  const cidGid = await maybeDeflate(inv.cidToGidMap());
  objects[cidToGidNum - 1] = concat([
    latin1Bytes(`<< /Length ${cidGid.data.length}` +
      (cidGid.filter ? ` /Filter ${cidGid.filter}` : '') + ' >>\nstream\n'),
    cidGid.data,
    latin1Bytes('\nendstream'),
  ]);

  const cmapBytes = enc.encode(inv.toUnicodeCMap());
  const cmap = await maybeDeflate(cmapBytes);
  objects[toUnicodeNum - 1] = concat([
    latin1Bytes(`<< /Length ${cmap.data.length}` +
      (cmap.filter ? ` /Filter ${cmap.filter}` : '') + ' >>\nstream\n'),
    cmap.data,
    latin1Bytes('\nendstream'),
  ]);

  // --- Catalog, page tree, metadata ---------------------------------
  objects[PAGES - 1] = latin1Bytes(
    `<< /Type /Pages /Count ${pageNums.length} ` +
    `/Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] >>`);

  objects[CATALOG - 1] = latin1Bytes(
    `<< /Type /Catalog /Pages ${PAGES} 0 R >>`);

  const infoNum = addObject(
    `<< /Title ${pdfTextString(title)} ` +
    (author ? `/Author ${pdfTextString(author)} ` : '') +
    `/Producer ${pdfTextString(creator)} /Creator ${pdfTextString(creator)} ` +
    `/CreationDate (${pdfDate()}) /ModDate (${pdfDate()}) >>`);

  // --- Serialise with an xref table ---------------------------------
  const chunks = [];
  let offset = 0;
  const push = (bytes) => { chunks.push(bytes); offset += bytes.length; };

  // The binary comment tells tools this file is not plain ASCII.
  push(latin1Bytes('%PDF-1.7\n'));
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const offsets = new Array(objects.length + 1).fill(0);
  for (let i = 0; i < objects.length; i++) {
    offsets[i + 1] = offset;
    push(latin1Bytes(`${i + 1} 0 obj\n`));
    push(objects[i]);
    push(latin1Bytes('\nendobj\n'));
  }

  const xrefStart = offset;
  const count = objects.length + 1;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${count} /Root ${CATALOG} 0 R /Info ${infoNum} 0 R >>\n` +
          `startxref\n${xrefStart}\n%%EOF\n`;
  push(latin1Bytes(xref));

  return new Blob([concat(chunks)], { type: 'application/pdf' });
}

/** Convenience: plain (non-searchable) image PDF. */
export function buildImagePDF(pages, opts = {}) {
  return buildSearchablePDF(
    pages.map((p) => ({ ...p, words: [] })), opts);
}
