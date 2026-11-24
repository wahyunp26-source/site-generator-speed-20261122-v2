[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/wahyunp26-source/site-generator-speed-20261122-v2/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/wahyunp26-source/site-generator-speed-20261122-v2/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# site-generator-speed-20261122-v2

A faster static site generator — v2 of the entry for the [make.fun bounty](https://make.fun/bounty/site-generator-speed-01-run-20261122) "Build a static site faster" (`site-generator-speed-01-run-20261122`).

`run(input)` renders a whole site (posts, pages, tags, index, static files) to a tree of HTML files, byte-identical to the `makefun-site` 1.0.0 reference on the practice set. Pure Node.js standard library, no dependencies, no network. Honest optimisation only — no precomputed answers.

## What v2 changes vs v1

- Word counting uses a 64K whitespace lookup table instead of a ~20-way OR-chain per character.
- Markdown blocks write their HTML straight into the shared output array instead of building throwaway per-paragraph arrays (the first paragraph's HTML is still kept as the excerpt string; level 2/3 headings still keep theirs for the TOC).
- CRLF normalisation is skipped entirely when the source holds no `\r` (only ~5% of sources do).
- Tags are built in a single pass over the posts instead of one scan per tag.
- One link-resolution context is reused across bodies instead of spreading a fresh object per body.
- The inline scanner's regex is shared at module scope (safe: every call resets `lastIndex` before its first match, and the loop re-sets it after any nested call returns).

## Local results (practice set, 3 cases)

- `grade-local`: **3/3 passing**, L1 regrade reproduced byte for byte
- CPU time, interleaved A/B (9 rounds each, same machine): v2 median **~680,000 µs** vs v1 median **~736,000 µs** — about **7.5% faster** (mean: 668,000 vs 740,000 µs, ~10%).
- House baseline on the same machine: **~1,286,000 µs** — v2 is about **1.9× faster**.
