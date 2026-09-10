# ScanPro

An offline document scanner for Indian documents. Automatic edge detection,
perspective correction, multi-page batches, OCR in 15 languages, searchable
PDFs, and Lens-style recognition of what's actually on the page — all running
in the browser, on the device, with no server and no account.

Installs to a phone's home screen and works with the network off.

---

## What it does

**Scanning**
- Live viewfinder that finds the page edges and locks on, with auto-capture
  when you hold the phone steady
- Perspective correction — a photo taken at an angle comes out square
- Shadow and uneven-lighting removal (the thing that makes a phone photo look
  like a real scan)
- Five looks: Original, Auto, Magic Colour, Greyscale, and an adaptive B&W
  built for text
- Multi-page batches, drag to reorder, re-crop or delete any page
- Import existing photos, one or a whole folder at once

**Reading**
- OCR in English plus 14 Indian languages: Hindi, Bengali, Tamil, Telugu,
  Marathi, Gujarati, Kannada, Malayalam, Punjabi, Odia, Assamese, Urdu,
  Sanskrit and Nepali
- Searchable PDFs — the scan you see, with selectable, searchable text
  underneath, in any of those scripts
- Full-text search across every scan you've made
- Low-confidence words are highlighted so you know what to double-check

**Lens**
- Point at anything and read it: text, QR codes, barcodes
- Finds and acts on what's in the text — phone numbers, emails, links, UPI
  IDs, PAN, GSTIN, IFSC, Aadhaar (checksum-validated), vehicle numbers,
  amounts, dates
- Offline transliteration between Indic scripts and Roman letters

---

## Running it

The app is plain static files. Any web server works; it needs `https://` (or
`localhost`) because browsers only give camera access to secure origins.

```bash
node tools/serve.mjs 8080      # then open http://localhost:8080
```

To put it on a phone, host the folder anywhere that serves HTTPS — GitHub
Pages, Netlify, Cloudflare Pages, or your own box — then open it in Chrome or
Safari and choose "Add to Home Screen". After the first load it runs offline.

There is no build step. No bundler, no framework, no npm install needed to
run it. `npm install` is only for the test suite.

### Tests

```bash
node tools/serve.mjs 8099 &
node tools/test/e2e.mjs        # 29 checks: pipeline, OCR, PDF, UI flow
node tools/test/camera.mjs     # 7 checks: live camera and auto-capture
```

Both drive a real Chromium against a synthetic photo of a Hindi/English
document and verify the output — including running `pdftotext` logic over the
generated PDF to prove the Devanagari really extracts.

---

## How it works

### Edge detection (`js/core/detect.js`)

Downscale → greyscale → Gaussian blur → Sobel → non-maximum suppression →
hysteresis threshold (Canny) → Hough line transform → pair up near-parallel
lines into candidate quadrilaterals → **score each quad by how much of its
perimeter sits on real edge pixels**.

That last step is what separates it from a "largest rectangle" approach. A
patterned tablecloth or a window frame produces strong lines but no continuous
support along all four sides, so it loses to the actual page.

On the test image it lands within **5 px on a 1200×1600 frame** in about
130 ms — fast enough to run several times a second in the viewfinder.

### Perspective correction (`js/core/warp.js`)

Solves the homography from the output rectangle back to the detected quad and
inverse-maps every destination pixel with bilinear sampling, so there are no
holes. Output size comes from the longest opposing edges.

### Enhancement (`js/core/enhance.js`)

The important one is background estimation. A phone photo of paper has uneven
light and usually a shadow from the hand holding the camera. A local maximum
filter removes the text (dark and thin) leaving the paper (bright and broad),
a wide blur of that approximates the illumination, and dividing the image by
it flattens the lighting. This both looks right and measurably improves OCR.

B&W uses Sauvola adaptive thresholding rather than a global cut-off, so
shadows and yellowed paper don't black out half the page.

### OCR (`js/core/ocr.js`)

Two things matter here.

**Language packs load once and then work offline.** Models come from the app's
own `tessdata/` folder and are cached in IndexedDB by the service worker.

**A script-aware dual pass.** Running an Indic model together with English
reads Devanagari well but mangles Latin digits — measured on the test page,
`14,500.00` came back as `4,500.00` and the invoice number lost a digit.
Running English alone reads every digit perfectly but cannot see Indic script
at all. So ScanPro runs both and merges at word level: Indic words always come
from the Indic pass, Latin and numeric words from whichever pass is more
confident, and confident Latin words the Indic pass dropped entirely get
reinserted.

On the test document that takes token recall from **85% to 100%** and mean
confidence from 76 to 88.

Pages also keep a separate greyscale "OCR master" made from the *unfiltered*
page, because the display filters — tuned to look like a clean scan — cost
recognition accuracy.

### Searchable PDFs (`js/core/pdf.js`)

Written by hand rather than with a PDF library, for one specific reason. A
searchable PDF needs a real font object with a ToUnicode CMap, and browser PDF
libraries either embed Latin-only base fonts (which mangle Indic text on
extraction) or need megabytes of real script fonts per document.

But the text layer is *invisible* — it sits under the page image in render
mode 3 — so the glyphs never have to be drawn. ScanPro embeds a single
**836-byte glyphless font** where every CID maps to one blank glyph, and
carries the real Unicode in the ToUnicode CMap. Any script, no per-script font
cost. Word positions are matched with horizontal scaling (`Tz`) so selection
rectangles line up with what you see.

Verified with `qpdf --check` (no syntax errors) and `pdftotext` (Devanagari
with conjuncts, matras and nukta all extract correctly).

---

## An honest note on accuracy

No OCR system is 100% accurate, and no translation system is either — that
includes Google Lens, Adobe Scan and every commercial engine. Anyone claiming
otherwise is selling something.

What you can expect here:
- **Clean printed text, good light:** roughly 90–97%
- **Indic scripts specifically:** conjuncts and matras are the hard part;
  Devanagari and Bengali do well, Tamil and Malayalam are usually good,
  handwriting is poor
- **Handwriting:** don't rely on it

That is why every word carries a confidence score and the uncertain ones are
highlighted in the text view. A scanner that quietly shows you a wrong digit
is worse than one that tells you where to look.

**Translation** is deliberately not bundled. Real machine translation needs a
neural model far too large to ship in a web app, so ScanPro does the honest
thing instead:

- **Transliteration** (converting script to Roman letters — `भारत सरकार` →
  `bhārata sarakāra`) works fully offline and is built in
- **Translation** is optional and pluggable: point Settings at a
  LibreTranslate server you control, or your own Google Cloud Translation
  key. Nothing leaves the device unless you configure one and ask for it.

---

## Privacy

Everything — scans, recognised text, language packs, settings — lives in
IndexedDB on the device. There is no server, no account, no telemetry and no
network call except downloading a language pack the first time you use it.

This matters for the documents people actually scan in India: Aadhaar cards,
bank statements, land records, medical reports. The app flags PAN and Aadhaar
numbers as sensitive when it finds them, and never transmits them anywhere.

---

## Layout

```
index.html                  app shell, all screens
css/app.css                 styling
manifest.webmanifest        PWA manifest
sw.js                       service worker (offline + lazy model caching)

js/core/
  detect.js                 Canny + Hough document edge detection
  warp.js                   homography and perspective correction
  enhance.js                background estimation, filters, Sauvola B&W
  geometry.js               linear solver, homography, quad maths
  ocr.js                    Tesseract wrapper, dual-pass script-aware merge
  languages.js              language and script catalogue
  pdf.js                    searchable PDF writer
  glyphless-font.js         generated 836-byte font for the text layer
  lens.js                   entities, barcodes, transliteration
  db.js                     IndexedDB storage and search
  pipeline.js               worker client and canvas helpers

js/workers/cv.worker.js     image processing off the main thread
js/ui/                      camera, editor, text view, settings, helpers

tessdata/                   15 language models (42 MB)
vendor/                     Tesseract runtime and wasm core
tools/                      dev server, font generator, tests
```

---

## Making it smaller

The full folder is about 60 MB, mostly language models. To ship a lean build,
delete the `tessdata/*.traineddata` files you don't need — `eng` plus one
language is around 5 MB. Sanskrit alone is 12 MB. The app downloads and caches
whatever is present when a user first selects that language.

To rebuild the glyphless font: `python3 tools/make_glyphless_font.py`.

---

## Known limits

- Tamil transliteration is approximate. Tamil has a smaller consonant
  inventory and doesn't distinguish aspirates, so the shared Brahmi
  code-point alignment the transliterator uses is only partial there.
- Barcode scanning uses the browser's `BarcodeDetector`, available in Chrome
  and Android WebView but not yet in Safari. Everything else works everywhere.
- Book mode currently scans as a single page; facing-page splitting is not
  implemented.
- Handwriting recognition is weak — that is a limit of the Tesseract models,
  not of the pipeline around them.
