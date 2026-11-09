# knitoutjs

knitout in patchwork. write a pattern in javascript, build it into knitout
(a .k), watch it knit, and turn it into kcode for a kniterate. these are the
tools lattice opens .js and .k files with, and "Knitout JS", a patchwork
project of its own.

## where it comes from

most of the knitting here is other people's work, carried over.

- **knitout** itself is [Jim McCann](https://github.com/ixchow)'s, from the
  [carnegie mellon textiles lab](https://textiles-lab.github.io/knitout/knitout.html).
- **the visualiser** (`core/vendor/show-knitout.js`, `CellMachine.js`,
  `VectorTiles.js`, `VectorTilesLib.js`, `parseKnitout.js`, `evalJS.js`) is
  Jim's [knitout live visualizer](https://github.com/textiles-lab/knitout-live-visualizer),
  with work from Mark Gillespie, Catherine Yu, Lea Albaugh, Vidya Narayanan
  and Himalini Gururaj.
- **this grew out of** [Agnes Cameron](https://github.com/agnescameron)'s
  [kniterate fork](https://github.com/agnescameron/knitout-visualizer-kniterate)
  of the visualiser, which she uses
  [to teach](https://soup.agnescameron.info/2025/09/20/kniterate.html). it
  brought the kniterate's colours, the
  [waste section](https://soup.agnescameron.info/2026/03/25/kniterate-waste-section.html)
  and cast on, and the kcode export.
- **knitout to kcode** (`core/vendor/knitout-to-kcode.js`) is
  [Gabrielle Ohlson](https://github.com/gabrielle-ohlson) and Jim's
  [kniterate backend](https://github.com/textiles-lab/knitout-backend-kniterate),
  as Agnes adapted it for the visualiser.
- **javascript highlighting** (`core/vendor/lezer-javascript.js`) is
  [lezer](https://lezer.codemirror.net)'s javascript grammar, by Marijn
  Haverbeke, bundled.

all of these are MIT licensed: the visualiser © 2018–2019, the kniterate
backend © 2020 Carnegie Mellon Textiles Lab, and lezer © Marijn Haverbeke and
others. their notices are in [`core/vendor/LICENSE.md`](core/vendor/LICENSE.md),
and that code keeps its licence.

the patchwork side (the panes, the editor and the projects) is by chee, with
Mimi Reyburn.

## licence

knitoutjs is [AGPL-3.0-or-later](LICENSE), apart from `core/vendor`, which is
MIT (above).
