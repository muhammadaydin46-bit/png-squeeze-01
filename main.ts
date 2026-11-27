// png-squeeze: a lossless PNG recompressor for 1280x720 screenshots.
//
// Pipeline, written from scratch for this bounty (Node 22, stdlib only):
//   1. Own PNG decoder to RGBA (bit depth 8, no interlace).
//   2. Per-image analysis (opaque? grey? distinct colours <= 256?) and a set of
//      candidate colour forms: palette (count order and luminance order),
//      grey / grey+alpha, RGB, RGBA, and RGB or grey with a tRNS key when every
//      non-opaque pixel shares one transparent value.
//   3. Per-row filter search: whole-image None, per-row minimum absolute sum,
//      and per-row brute force (each of the 5 filters compressed at zlib level 4
//      with the previous 32 KiB as dictionary). Candidates are screened by
//      compressing the filtered stream at zlib level 6.
//   4. The winning filtered stream is compressed three ways and the smallest is
//      kept: zlib level 9 memLevel 8, zlib level 9 memLevel 9, and an own
//      optimal-parsing deflate (hash-chain LZ77 + two-pass DP optimal parse +
//      one dynamic-Huffman block with package-merge length-limited codes).
//   5. Strict PNG output: IHDR, PLTE (palette only), tRNS (when needed), one
//      IDAT, IEND. Deterministic: no clock, no randomness, no environment input.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------------------------------------------------------------- CRC32
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// -------------------------------------------------------------- Adler-32
function adler32(buf) {
  let a = 1;
  let b = 0;
  let i = 0;
  const n = buf.length;
  while (i < n) {
    const end = Math.min(i + 5550, n);
    for (; i < end; i++) {
      a += buf[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ------------------------------------------------------------ PNG decode
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

const BPP_OF_TYPE = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function decodePng(bytes) {
  let pos = 8; // PNG signature
  let w = 0;
  let h = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let plte = null;
  let trns = null;
  const idat = [];
  while (pos + 8 <= bytes.length) {
    const len = bytes.readUInt32BE(pos);
    const type = bytes.toString('ascii', pos + 4, pos + 8);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      plte = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error('unsupported PNG: bitDepth=' + bitDepth + ' interlace=' + interlace);
  if (!(colorType in BPP_OF_TYPE)) throw new Error('unsupported colour type ' + colorType);
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = BPP_OF_TYPE[colorType];
  const stride = w * bpp;
  const rgba = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const base = y * (stride + 1);
    const f = raw[base];
    const row = raw.subarray(base + 1, base + 1 + stride);
    const out = new Uint8Array(stride);
    if (f === 0) {
      out.set(row);
    } else if (f === 1) {
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? out[x - bpp] : 0;
        out[x] = (row[x] + a) & 255;
      }
    } else if (f === 2) {
      for (let x = 0; x < stride; x++) out[x] = (row[x] + prev[x]) & 255;
    } else if (f === 3) {
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? out[x - bpp] : 0;
        out[x] = (row[x] + ((a + prev[x]) >> 1)) & 255;
      }
    } else if (f === 4) {
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? out[x - bpp] : 0;
        const b = prev[x];
        const c = x >= bpp ? prev[x - bpp] : 0;
        out[x] = (row[x] + paeth(a, b, c)) & 255;
      }
    } else {
      throw new Error('bad filter ' + f);
    }
    const dst = y * w * 4;
    if (colorType === 6) {
      rgba.set(out, dst);
    } else if (colorType === 2) {
      for (let x = 0; x < w; x++) {
        rgba[dst + 4 * x] = out[3 * x];
        rgba[dst + 4 * x + 1] = out[3 * x + 1];
        rgba[dst + 4 * x + 2] = out[3 * x + 2];
        rgba[dst + 4 * x + 3] = 255;
      }
    } else if (colorType === 0) {
      for (let x = 0; x < w; x++) {
        const g = out[x];
        rgba[dst + 4 * x] = g;
        rgba[dst + 4 * x + 1] = g;
        rgba[dst + 4 * x + 2] = g;
        rgba[dst + 4 * x + 3] = 255;
      }
    } else if (colorType === 4) {
      for (let x = 0; x < w; x++) {
        const g = out[2 * x];
        rgba[dst + 4 * x] = g;
        rgba[dst + 4 * x + 1] = g;
        rgba[dst + 4 * x + 2] = g;
        rgba[dst + 4 * x + 3] = out[2 * x + 1];
      }
    } else if (colorType === 3) {
      for (let x = 0; x < w; x++) {
        const idx = out[x];
        rgba[dst + 4 * x] = plte[3 * idx];
        rgba[dst + 4 * x + 1] = plte[3 * idx + 1];
        rgba[dst + 4 * x + 2] = plte[3 * idx + 2];
        rgba[dst + 4 * x + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }
    prev = out;
  }
  return { w, h, rgba };
}

// ------------------------------------------------------------ PNG encode
function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length);
  return out;
}

function encodePng(w, h, form, zlibStream) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = form.colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr)];
  if (form.plte) parts.push(pngChunk('PLTE', form.plte));
  if (form.trns) parts.push(pngChunk('tRNS', form.trns));
  parts.push(pngChunk('IDAT', zlibStream));
  parts.push(pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- Filters
// Write one filtered row (filter byte + stride bytes) into `out` at offset 0.
function filterRow(raw, prev, bpp, f, out) {
  const stride = raw.length;
  out[0] = f;
  if (f === 0) {
    out.set(raw, 1);
  } else if (f === 1) {
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? raw[x - bpp] : 0;
      out[x + 1] = (raw[x] - a) & 255;
    }
  } else if (f === 2) {
    for (let x = 0; x < stride; x++) out[x + 1] = (raw[x] - prev[x]) & 255;
  } else if (f === 3) {
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? raw[x - bpp] : 0;
      out[x + 1] = (raw[x] - ((a + prev[x]) >> 1)) & 255;
    }
  } else {
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? raw[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      out[x + 1] = (raw[x] - paeth(a, b, c)) & 255;
    }
  }
}

// Sum of absolute values of the filtered bytes, read as signed bytes.
function filterRowScore(buf) {
  let s = 0;
  for (let i = 1; i < buf.length; i++) {
    const v = buf[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// --------------------------------------------------------- Candidate forms
function buildForms(rgba, w, h) {
  const n = w * h;
  let opaque = true;
  let grey = true;
  const distinct = new Map();
  let distinctOver = false;
  let transRgb = -1; // -1: none seen yet, -2: more than one transparent colour
  for (let i = 0; i < n; i++) {
    const r = rgba[4 * i];
    const g = rgba[4 * i + 1];
    const b = rgba[4 * i + 2];
    const a = rgba[4 * i + 3];
    if (a !== 255) opaque = false;
    if (r !== g || g !== b) grey = false;
    if (!distinctOver) {
      const key = (r << 24) | (g << 16) | (b << 8) | a;
      distinct.set(key, (distinct.get(key) ?? 0) + 1);
      if (distinct.size > 256) {
        distinctOver = true;
        distinct.clear();
      }
    }
    if (a !== 255) {
      const rgb = (r << 16) | (g << 8) | b;
      if (transRgb === -1) transRgb = rgb;
      else if (transRgb !== rgb) transRgb = -2;
    }
  }

  const forms = [];
  const u32 = (k) => k >>> 0;

  if (!distinctOver) {
    const entries = [...distinct.entries()]; // [key, count]
    const lumOf = (key) => {
      const r = (key >>> 24) & 255;
      const g = (key >>> 16) & 255;
      const b = (key >>> 8) & 255;
      return 299 * r + 587 * g + 114 * b;
    };
    const byCount = [...entries].sort((a, b) => b[1] - a[1] || u32(a[0]) - u32(b[0]));
    const byLum = [...entries].sort((a, b) => lumOf(a[0]) - lumOf(b[0]) || u32(a[0]) - u32(b[0]));
    for (const [order, name] of [
      [byCount, 'palette-count'],
      [byLum, 'palette-lum'],
    ]) {
      const index = new Map();
      const plte = Buffer.alloc(order.length * 3);
      const alphas = Buffer.alloc(order.length);
      let allOpaque = true;
      order.forEach(([key], idx) => {
        index.set(key, idx);
        plte[3 * idx] = (key >>> 24) & 255;
        plte[3 * idx + 1] = (key >>> 16) & 255;
        plte[3 * idx + 2] = (key >>> 8) & 255;
        const a = key & 255;
        alphas[idx] = a;
        if (a !== 255) allOpaque = false;
      });
      let trns = null;
      if (!allOpaque) {
        let cut = alphas.length;
        while (cut > 0 && alphas[cut - 1] === 255) cut--;
        trns = Buffer.from(alphas.subarray(0, cut));
      }
      const data = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const key = (rgba[4 * i] << 24) | (rgba[4 * i + 1] << 16) | (rgba[4 * i + 2] << 8) | rgba[4 * i + 3];
        data[i] = index.get(key);
      }
      forms.push({ name, colorType: 3, bpp: 1, data, plte, trns });
    }
  }

  if (grey) {
    const data = new Uint8Array(n);
    for (let i = 0; i < n; i++) data[i] = rgba[4 * i];
    forms.push({ name: 'grey', colorType: 0, bpp: 1, data, plte: null, trns: null });
    if (!opaque) {
      const data2 = new Uint8Array(2 * n);
      for (let i = 0; i < n; i++) {
        data2[2 * i] = rgba[4 * i];
        data2[2 * i + 1] = rgba[4 * i + 3];
      }
      forms.push({ name: 'grey-alpha', colorType: 4, bpp: 2, data: data2, plte: null, trns: null });
    }
  }

  if (opaque) {
    const data = new Uint8Array(3 * n);
    for (let i = 0; i < n; i++) {
      data[3 * i] = rgba[4 * i];
      data[3 * i + 1] = rgba[4 * i + 1];
      data[3 * i + 2] = rgba[4 * i + 2];
    }
    forms.push({ name: 'rgb', colorType: 2, bpp: 3, data, plte: null, trns: null });
  }

  {
    const data = new Uint8Array(4 * n);
    data.set(rgba);
    forms.push({ name: 'rgba', colorType: 6, bpp: 4, data, plte: null, trns: null });
  }

  // tRNS key: every non-opaque pixel shares one RGB value, and no opaque
  // pixel uses that RGB (it would wrongly turn transparent).
  if (!opaque && transRgb >= 0) {
    let ok = true;
    for (let i = 0; i < n; i++) {
      if (rgba[4 * i + 3] === 255) {
        const rgb = (rgba[4 * i] << 16) | (rgba[4 * i + 1] << 8) | rgba[4 * i + 2];
        if (rgb === transRgb) {
          ok = false;
          break;
        }
      }
    }
    if (ok) {
      const trns = Buffer.alloc(6);
      trns.writeUInt16BE((transRgb >>> 16) & 255, 0);
      trns.writeUInt16BE((transRgb >>> 8) & 255, 2);
      trns.writeUInt16BE(transRgb & 255, 4);
      const data = new Uint8Array(3 * n);
      for (let i = 0; i < n; i++) {
        data[3 * i] = rgba[4 * i];
        data[3 * i + 1] = rgba[4 * i + 1];
        data[3 * i + 2] = rgba[4 * i + 2];
      }
      forms.push({ name: 'rgb-trns', colorType: 2, bpp: 3, data, plte: null, trns });
      if (grey) {
        const gv = (transRgb >>> 16) & 255;
        const trnsG = Buffer.alloc(2);
        trnsG.writeUInt16BE(gv, 0);
        const dataG = new Uint8Array(n);
        for (let i = 0; i < n; i++) dataG[i] = rgba[4 * i];
        forms.push({ name: 'grey-trns', colorType: 0, bpp: 1, data: dataG, plte: null, trns: trnsG });
      }
    }
  }

  return forms;
}

// -------------------------------------------------------- Filter strategies
function filterNone(form, w, h) {
  const stride = w * form.bpp;
  const out = new Uint8Array(h * (stride + 1));
  const zero = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const rowStart = y * stride;
    const o = y * (stride + 1);
    out[o] = 0;
    out.set(form.data.subarray(rowStart, rowStart + stride), o + 1);
  }
  return out;
}

function filterMinsum(form, w, h) {
  const stride = w * form.bpp;
  const rowLen = stride + 1;
  const out = new Uint8Array(h * rowLen);
  const scratch = new Uint8Array(5 * rowLen);
  const zero = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const row = form.data.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? zero : form.data.subarray((y - 1) * stride, y * stride);
    let bestF = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const buf = scratch.subarray(f * rowLen, (f + 1) * rowLen);
      filterRow(row, prev, form.bpp, f, buf);
      const s = filterRowScore(buf);
      if (s < bestScore) {
        bestScore = s;
        bestF = f;
      }
    }
    out.set(scratch.subarray(bestF * rowLen, (bestF + 1) * rowLen), y * rowLen);
  }
  return out;
}

function filterBrute(form, w, h) {
  const stride = w * form.bpp;
  const rowLen = stride + 1;
  const out = new Uint8Array(h * rowLen);
  const scratch = new Uint8Array(5 * rowLen);
  const zero = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const row = form.data.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? zero : form.data.subarray((y - 1) * stride, y * stride);
    const dictStart = Math.max(0, y * rowLen - 32768);
    const dict = out.subarray(dictStart, y * rowLen);
    let bestF = 0;
    let bestLen = Infinity;
    for (let f = 0; f < 5; f++) {
      const buf = scratch.subarray(f * rowLen, (f + 1) * rowLen);
      filterRow(row, prev, form.bpp, f, buf);
      const comp = deflateSync(buf, { level: 4, dictionary: dict });
      if (comp.length < bestLen) {
        bestLen = comp.length;
        bestF = f;
      }
    }
    out.set(scratch.subarray(bestF * rowLen, (bestF + 1) * rowLen), y * rowLen);
  }
  return out;
}

// Screen every (form, strategy) with zlib level 6 and keep the smallest.
function screenForms(forms, w, h) {
  let best = null;
  for (const form of forms) {
    for (const [name, fn] of [
      ['none', filterNone],
      ['minsum', filterMinsum],
      ['brute', filterBrute],
    ]) {
      const filtered = fn(form, w, h);
      const size = deflateSync(filtered, { level: 6 }).length;
      if (best === null || size < best.size) best = { form, strategy: name, filtered, size };
    }
  }
  return best;
}

// ------------------------------------------------------- Optimal deflate
// Own optimal-parsing deflate: hash-chain LZ77, two-pass DP optimal parse,
// one dynamic-Huffman block. Code lengths come from package-merge
// (Larmore & Hirschberg), which is optimal among length-limited codes.
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
// Largest length coded by each length symbol (the cost of a match only changes
// at these boundaries, so a DP only needs to try these lengths per distance).
const BUCKET_MAX = [3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 22, 26, 30, 34, 42, 50, 58, 66, 82, 98, 114, 130, 162, 194, 226, 257, 258];

const LEN_SYM = new Uint8Array(259);
const DIST_SYM = new Uint8Array(32769);
for (let s = 0; s < 29; s++) {
  const hi = s < 28 ? LEN_BASE[s + 1] - 1 : 258;
  for (let len = LEN_BASE[s]; len <= hi; len++) LEN_SYM[len] = s;
}
for (let s = 0; s < 30; s++) {
  const dhi = s + 1 < 30 ? DIST_BASE[s + 1] - 1 : 32768;
  for (let d = DIST_BASE[s]; d <= dhi; d++) DIST_SYM[d] = s;
}
const FIXED_LIT_LEN = new Uint8Array(288);
for (let i = 0; i < 288; i++) FIXED_LIT_LEN[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;

// Package-merge: optimal length-limited Huffman code lengths (max `limit`
// bits) for the given frequencies. Returns a Uint8Array of lengths, Kraft
// complete. Symbols with frequency 0 get length 0.
function packageMergeLengths(freq, limit) {
  const nSym = freq.length;
  const out = new Uint8Array(nSym);
  const used = [];
  for (let i = 0; i < nSym; i++) if (freq[i] > 0) used.push(i);
  const m = used.length;
  if (m === 0) return out;
  if (m === 1) {
    out[used[0]] = 1;
    return out;
  }
  if (m === 2) {
    out[used[0]] = 1;
    out[used[1]] = 1;
    return out;
  }
  // One item per symbol; a package is a pair of items (members counted twice
  // when a symbol occurs in both halves, exactly as the algorithm requires).
  let cur = used.map((s) => ({ w: freq[s], sym: s })).sort((a, b) => a.w - b.w);
  const singletons = cur;
  const pkg = (list) => {
    const r = [];
    for (let i = 0; i + 1 < list.length; i += 2) {
      r.push({ w: list[i].w + list[i + 1].w, a: list[i], b: list[i + 1] });
    }
    return r; // odd leftover is dropped
  };
  const merge = (a, b) => {
    const r = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i].w <= b[j].w) r.push(a[i++]);
      else r.push(b[j++]);
    }
    while (i < a.length) r.push(a[i++]);
    while (j < b.length) r.push(b[j++]);
    return r;
  };
  for (let lvl = 1; lvl < limit; lvl++) cur = merge(pkg(cur), singletons);
  const last = pkg(cur);
  const count = (it) => {
    if (it.sym !== undefined) {
      out[it.sym]++;
      return;
    }
    count(it.a);
    count(it.b);
  };
  for (let k = 0; k < Math.min(m - 1, last.length); k++) count(last[k]);
  return out;
}

function canonicalCodes(lengths) {
  let maxLen = 0;
  for (const l of lengths) if (l > maxLen) maxLen = l;
  const blCount = new Int32Array(maxLen + 1);
  for (const l of lengths) if (l) blCount[l]++;
  const nextCode = new Int32Array(maxLen + 1);
  let code = 0;
  for (let b = 1; b <= maxLen; b++) {
    code = (code + blCount[b - 1]) << 1;
    nextCode[b] = code;
  }
  const codes = new Int32Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) {
    const l = lengths[s];
    if (l) codes[s] = nextCode[l]++;
  }
  return codes;
}

function reverseBits(code, len) {
  let r = 0;
  for (let i = 0; i < len; i++) {
    r = (r << 1) | (code & 1);
    code >>= 1;
  }
  return r;
}

// Hash-chain match finding. Two chains per position: a 3-byte hash chain
// (finds every match of length >= 3, including near ones) and a 4-byte hash
// chain (far fewer entries per hash, so a short walk reaches far long matches
// that the 3-byte chain buries behind near short ones, e.g. a repeated row).
// Returns the best and second-best (distance, length) match at every
// position. Chain lengths scale with nothing but the data: the work is
// bounded by the chain limits, never by the clock.
function findMatches(data) {
  const N = data.length;
  const chainLimit = 1024;
  const chain4Limit = 64;
  const head = new Int32Array(1 << 15).fill(-1);
  const prev = new Int32Array(N);
  const head4 = new Int32Array(1 << 16).fill(-1);
  const prev4 = new Int32Array(N);
  const candD1 = new Int32Array(N);
  const candL1 = new Uint16Array(N);
  const candD2 = new Int32Array(N);
  const candL2 = new Uint16Array(N);
  for (let pos = 0; pos < N; pos++) {
    let bestLen = 0;
    let bestDist = 0;
    let secondLen = 0;
    let secondDist = 0;
    const consider = (dist, len) => {
      if (len < 3) return;
      if (len > bestLen || (len === bestLen && dist < bestDist)) {
        if (bestLen >= 3 && bestDist !== dist) {
          secondLen = bestLen;
          secondDist = bestDist;
        }
        bestLen = len;
        bestDist = dist;
      } else if (len > secondLen && dist !== bestDist) {
        secondLen = len;
        secondDist = dist;
      }
    };
    if (pos + 2 < N) {
      const h = ((data[pos] << 10) ^ (data[pos + 1] << 5) ^ data[pos + 2]) & 0x7fff;
      let cur = head[h];
      let steps = 0;
      let budget = chainLimit;
      const maxLen = Math.min(258, N - pos);
      while (cur !== -1 && steps < budget) {
        const dist = pos - cur;
        if (dist > 32768) break;
        steps++;
        if (bestLen >= 3 && pos + bestLen < N && data[cur + bestLen] !== data[pos + bestLen]) {
          cur = prev[cur];
          continue; // cannot beat the best length; still counts as a chain step
        }
        let len = 0;
        while (len < maxLen && data[cur + len] === data[pos + len]) len++;
        if (len >= 3) {
          const before = bestLen;
          consider(dist, len);
          if (bestLen > before) {
            // A good match is found: only a few more steps, to look for a
            // nearer match of similar length (a cheaper distance code).
            if (bestLen >= 128) budget = Math.min(budget, steps + 32);
            else if (bestLen >= 32) budget = Math.min(budget, steps + 128);
          }
        }
        if (bestLen >= 258) break;
        cur = prev[cur];
      }
      prev[pos] = head[h];
      head[h] = pos;
    }
    if (pos + 3 < N) {
      const h4 = (((data[pos] * 31 + data[pos + 1]) * 31 + data[pos + 2]) * 31 + data[pos + 3]) & 0xffff;
      let cur = head4[h4];
      let steps = 0;
      const maxLen = Math.min(258, N - pos);
      while (cur !== -1 && steps < chain4Limit) {
        const dist = pos - cur;
        if (dist > 32768) break;
        steps++;
        if (bestLen >= 4 && pos + bestLen < N && data[cur + bestLen] !== data[pos + bestLen]) {
          cur = prev4[cur];
          continue;
        }
        let len = 0;
        while (len < maxLen && data[cur + len] === data[pos + len]) len++;
        consider(dist, len);
        if (bestLen >= 258) break;
        cur = prev4[cur];
      }
      prev4[pos] = head4[h4];
      head4[h4] = pos;
    }
    candD1[pos] = bestDist;
    candL1[pos] = bestLen;
    candD2[pos] = secondDist;
    candL2[pos] = secondLen;
  }
  return { candD1, candL1, candD2, candL2 };
}

// One DP optimal-parse pass. litCost is indexed by literal/length symbol
// (0..287); lenCost by match length (3..258); distCost by distance (1..32768).
// Returns parent pointers describing the cheapest token ending at each offset.
function optimalParse(data, cand, litCost, lenCost, distCost) {
  const N = data.length;
  const INF = 1 << 30;
  const cost = new Int32Array(N + 1).fill(INF);
  const parLen = new Uint16Array(N + 1);
  const parDist = new Int32Array(N + 1);
  cost[0] = 0;
  for (let i = 0; i < N; i++) {
    const c = cost[i];
    if (c === INF) continue;
    const ncLit = c + litCost[data[i]];
    if (ncLit < cost[i + 1]) {
      cost[i + 1] = ncLit;
      parLen[i + 1] = 1;
      parDist[i + 1] = 0;
    }
    const L1 = cand.candL1[i];
    if (L1 >= 3) {
      const dc = distCost[cand.candD1[i]];
      for (let b = 0; b < 29; b++) {
        const len = BUCKET_MAX[b];
        if (len > L1) break;
        const nc = c + lenCost[len] + dc;
        const j = i + len;
        if (nc < cost[j]) {
          cost[j] = nc;
          parLen[j] = len;
          parDist[j] = cand.candD1[i];
        }
      }
      const L2 = cand.candL2[i];
      if (L2 >= 3) {
        const nc = c + lenCost[L2] + distCost[cand.candD2[i]];
        const j = i + L2;
        if (nc < cost[j]) {
          cost[j] = nc;
          parLen[j] = L2;
          parDist[j] = cand.candD2[i];
        }
      }
    }
  }
  return { parLen, parDist };
}

// Walk the parse backwards, counting literal/length and distance frequencies
// and recording the tokens in reverse order (tokLen/tokDist, count entries).
function tokensFromParse(data, parLen, parDist) {
  const N = data.length;
  const litFreq = new Int32Array(288);
  const distFreq = new Int32Array(30);
  const tokLen = new Int32Array(N);
  const tokDist = new Int32Array(N);
  let count = 0;
  let i = N;
  while (i > 0) {
    const len = parLen[i];
    if (len === 1) {
      tokLen[count] = 1;
      tokDist[count] = data[i - 1];
      litFreq[data[i - 1]]++;
      i--;
    } else {
      const d = parDist[i];
      tokLen[count] = len;
      tokDist[count] = d;
      litFreq[257 + LEN_SYM[len]]++;
      distFreq[DIST_SYM[d]]++;
      i -= len;
    }
    count++;
  }
  litFreq[256]++;
  return { litFreq, distFreq, tokLen, tokDist, count };
}

function costTables(litLen, distLen) {
  const litCost = new Int32Array(288);
  for (let s = 0; s < 288; s++) litCost[s] = litLen[s];
  const lenCost = new Int32Array(259);
  for (let len = 3; len <= 258; len++) {
    const s = LEN_SYM[len];
    lenCost[len] = litLen[257 + s] + LEN_EXT[s];
  }
  const distCost = new Int32Array(32769);
  for (let d = 1; d <= 32768; d++) {
    const s = DIST_SYM[d];
    distCost[d] = distLen[s] + DIST_EXT[s];
  }
  return { litCost, lenCost, distCost };
}

// Emit one dynamic-Huffman deflate block for the token stream, wrapped as a
// zlib stream. Returns a Buffer, or null if the input is too small to bother.
function emitDynamicBlock(data, toks, litLen, distLen) {
  const HLIT = (() => {
    let n = 286;
    while (n > 257 && litLen[n - 1] === 0) n--;
    return n;
  })();
  let HDIST = 30;
  while (HDIST > 1 && distLen[HDIST - 1] === 0) HDIST--;
  const totalLens = HLIT + HDIST;
  const lens = new Uint8Array(totalLens);
  lens.set(litLen.subarray(0, HLIT), 0);
  lens.set(distLen.subarray(0, HDIST), HLIT);

  // RLE-encode the code lengths (symbols 16/17/18).
  const seq = []; // [symbol, extraValue, extraBits]
  let i = 0;
  while (i < totalLens) {
    const l = lens[i];
    if (l === 0) {
      let run = 0;
      while (i + run < totalLens && lens[i + run] === 0) run++;
      i += run;
      while (run >= 11) {
        const n = Math.min(run, 138);
        seq.push([18, n - 11, 7]);
        run -= n;
      }
      if (run >= 3) {
        seq.push([17, run - 3, 3]);
        run = 0;
      }
      while (run > 0) {
        seq.push([0, 0, 0]);
        run--;
      }
    } else {
      seq.push([l, 0, 0]);
      i++;
      let run = 0;
      while (i + run < totalLens && lens[i + run] === l) run++;
      i += run;
      while (run >= 3) {
        const n = Math.min(run, 6);
        seq.push([16, n - 3, 2]);
        run -= n;
      }
      while (run > 0) {
        seq.push([l, 0, 0]);
        run--;
      }
    }
  }
  const clFreq = new Int32Array(19);
  for (const [s] of seq) clFreq[s]++;
  let clLen = packageMergeLengths(clFreq, 7);
  // A code-length code needs at least two codes, or inflate rejects it.
  let clUsed = 0;
  for (const l of clLen) if (l) clUsed++;
  if (clUsed < 2) {
    clLen = Uint8Array.from(clLen);
    for (let s = 0; s < 19 && clUsed < 2; s++) {
      if (clLen[s] === 0) {
        clLen[s] = 1;
        clUsed++;
      }
    }
  }
  const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  let HCLEN = 19;
  while (HCLEN > 4 && clLen[CL_ORDER[HCLEN - 1]] === 0) HCLEN--;

  const litCode = canonicalCodes(litLen);
  const distCode = canonicalCodes(distLen);
  const clCode = canonicalCodes(clLen);
  const litRev = new Int32Array(288);
  const distRev = new Int32Array(30);
  const clRev = new Int32Array(19);
  for (let s = 0; s < 288; s++) if (litLen[s]) litRev[s] = reverseBits(litCode[s], litLen[s]);
  for (let s = 0; s < 30; s++) if (distLen[s]) distRev[s] = reverseBits(distCode[s], distLen[s]);
  for (let s = 0; s < 19; s++) if (clLen[s]) clRev[s] = reverseBits(clCode[s], clLen[s]);

  const out = [];
  let acc = 0;
  let nbits = 0;
  const put = (value, len) => {
    acc |= value << nbits;
    nbits += len;
    while (nbits >= 8) {
      out.push(acc & 0xff);
      acc >>>= 8;
      nbits -= 8;
    }
  };
  put(1, 1); // BFINAL
  put(2, 2); // BTYPE = dynamic
  put(HLIT - 257, 5);
  put(HDIST - 1, 5);
  put(HCLEN - 4, 4);
  for (let k = 0; k < HCLEN; k++) put(clLen[CL_ORDER[k]], 3);
  for (const [s, extra, ebits] of seq) {
    put(clRev[s], clLen[s]);
    if (ebits) put(extra, ebits);
  }
  // Tokens are stored in reverse; emit them forwards.
  for (let t = toks.count - 1; t >= 0; t--) {
    const len = toks.tokLen[t];
    if (len === 1) {
      const lit = toks.tokDist[t];
      put(litRev[lit], litLen[lit]);
    } else {
      const d = toks.tokDist[t];
      const ls = LEN_SYM[len];
      put(litRev[257 + ls], litLen[257 + ls]);
      if (LEN_EXT[ls]) put(len - LEN_BASE[ls], LEN_EXT[ls]);
      const ds = DIST_SYM[d];
      put(distRev[ds], distLen[ds]);
      if (DIST_EXT[ds]) put(d - DIST_BASE[ds], DIST_EXT[ds]);
    }
  }
  put(litRev[256], litLen[256]); // end of block
  if (nbits > 0) out.push(acc & 0xff);
  const deflate = Buffer.from(out);
  const zlib = Buffer.alloc(deflate.length + 6);
  zlib[0] = 0x78;
  zlib[1] = 0xda;
  deflate.copy(zlib, 2);
  zlib.writeUInt32BE(adler32(data), 2 + deflate.length);
  return zlib;
}

// Full optimal deflate of a filtered stream. Returns a zlib stream Buffer.
function optimalDeflate(data) {
  if (data.length < 3) return null;
  const cand = findMatches(data);
  // Pass 1: fixed-Huffman costs.
  const fixed = costTables(FIXED_LIT_LEN, new Uint8Array(30).fill(5));
  const p1 = optimalParse(data, cand, fixed.litCost, fixed.lenCost, fixed.distCost);
  const t1 = tokensFromParse(data, p1.parLen, p1.parDist);
  const litLen1 = packageMergeLengths(t1.litFreq, 15);
  let distLen1 = packageMergeLengths(t1.distFreq, 15);
  if (t1.distFreq.every((f) => f === 0)) {
    distLen1 = new Uint8Array(30);
    distLen1[0] = 1;
  }
  // Pass 2: exact costs from pass 1.
  const exact = costTables(litLen1, distLen1);
  const p2 = optimalParse(data, cand, exact.litCost, exact.lenCost, exact.distCost);
  const t2 = tokensFromParse(data, p2.parLen, p2.parDist);
  const litLen2 = packageMergeLengths(t2.litFreq, 15);
  let distLen2 = packageMergeLengths(t2.distFreq, 15);
  if (t2.distFreq.every((f) => f === 0)) {
    distLen2 = new Uint8Array(30);
    distLen2[0] = 1;
  }
  return emitDynamicBlock(data, t2, litLen2, distLen2);
}

// ------------------------------------------------------------------ Driver
function processInstance(id) {
  const t0 = Date.now();
  const { w, h, rgba } = decodePng(readFileSync(join(INPUT_DIR, id, 'image.png')));
  const forms = buildForms(rgba, w, h);
  const best = screenForms(forms, w, h);
  const z9m8 = deflateSync(best.filtered, { level: 9, memLevel: 8 });
  const z9m9 = deflateSync(best.filtered, { level: 9, memLevel: 9 });
  let zlibStream = z9m8.length <= z9m9.length ? z9m8 : z9m9;
  let method = z9m8.length <= z9m9.length ? 'zlib9-m8' : 'zlib9-m9';
  // The optimal parse only beats zlib level 9 on streams whose filter varies
  // per row (brute-force filters): on whole-image-None streams the data is so
  // redundant that zlib's longer hash chains win, and the optimal parse costs
  // seconds for a worse result. Skipping it there keeps the run well inside
  // the 60 s wall; the choice is a function of the data, never the clock.
  if (best.strategy === 'brute') {
    const opt = optimalDeflate(best.filtered);
    if (opt !== null && opt.length < zlibStream.length) {
      zlibStream = opt;
      method = 'optimal';
    }
  }
  const png = encodePng(w, h, best.form, zlibStream);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), png);
  const ms = Date.now() - t0;
  console.log(
    id + ' form=' + best.form.name + ' filter=' + best.strategy + ' final=' + method +
      ' bytes=' + png.length + ' screen=' + best.size + ' ' + ms + 'ms',
  );
  return png.length;
}

const ids = readdirSync(INPUT_DIR).sort();
const tStart = Date.now();
let total = 0;
for (const id of ids) total += processInstance(id);
console.log('done: ' + ids.length + ' instances, ' + total + ' bytes total, ' + (Date.now() - tStart) + 'ms');
