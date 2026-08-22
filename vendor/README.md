# vendor

Enthält den unveränderten Animationskern aus
https://github.com/jeremy-prt/bloub (MIT License, © Jeremy Perret):

- `bot/` – framework- und clock-freie Engine (`engine.sample(t)` ist eine reine
  Zeitfunktion), Zustände, Expressionen, Skins, Formen. Alle numerischen
  Konstanten sind Frame-für-Frame-Messungen des Referenzvideos und wurden
  **nicht** verändert.
- `ui/gaze.ts` – Blickregel für das Kurverfolgen; Import-Aliase wurden von
  `@/bot/…` auf relative Pfade umgeschrieben, sonst unangetastet.

Siehe LICENSE im Repo-Origin. Nicht mit x.ai verbunden.
