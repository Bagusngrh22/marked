# marked

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Bagusngrh22/marked/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Bagusngrh22/marked/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free, drop-in replacement for marked 18.1.3 that renders byte-identical HTML, faster — a single-file ES module parser (`parse.js`) plus a Node 22 driver (`main.ts`) that reads `/input/cases.json` and writes `/output/html.json`.

## Run it

```sh
node main.ts
```

It reads every case from `/input/cases.json` (or `$MAKEFUN_INPUT_DIR/cases.json`) and writes the HTML for each case, in order, to `/output/html.json` (or `$MAKEFUN_OUTPUT_DIR/html.json`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=w43ybwk1&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
