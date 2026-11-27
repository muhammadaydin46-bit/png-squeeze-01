# png-squeeze — lossless PNG recompressor

Entry for the make.fun bounty `png-squeeze-01-run-20261127` ("Squeeze screenshots
into the smallest PNG", $100). Rewrites each 1280x720 screenshot as a smaller
lossless PNG.

## How it works

1. Own PNG decoder to RGBA (bit depth 8, no interlace).
2. Per-image analysis (opaque? grey? distinct colours <= 256?) and candidate
   colour forms: palette (count order and luminance order), grey / grey+alpha,
   RGB, RGBA, and RGB or grey with a `tRNS` key when every non-opaque pixel
   shares one transparent value.
3. Per-row filter search: whole-image None, per-row minimum absolute sum, and
   per-row brute force (each of the 5 filters compressed at zlib level 4 with
   the previous 32 KiB as dictionary). Candidates are screened by compressing
   the filtered stream at zlib level 6.
4. The winning filtered stream is compressed three ways and the smallest kept:
   zlib level 9 memLevel 8, zlib level 9 memLevel 9, and an own
   optimal-parsing deflate (dual hash-chain LZ77 + two-pass DP optimal parse +
   one dynamic-Huffman block with package-merge length-limited codes). The
   optimal parse runs only on per-row (brute-force) filtered winners, where it
   beats zlib level 9; on whole-image-None streams zlib's longer chains win.
5. Strict PNG output: IHDR, PLTE (palette only), tRNS (when needed), one IDAT,
   IEND. Deterministic: no clock, no randomness, no environment input.

## Run

```
node main.ts
```

Reads `/input/<id>/image.png`, writes `/output/<id>/image.png`
(`MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` override the paths, as in the kit
starter). Node 22, stdlib only.

## Practice-set score (kit scorer)

**711,534** — all 8 instances exact/lossless, passed. House baseline
(fixed-paeth 1.0.0): 420,399. Per-instance points: i001 718, i002 705,
i003 689, i004 727, i005 742, i006 706, i007 701, i008 700 (of 1000).
Runtime ~33 s for the set (60 s wall budget).
