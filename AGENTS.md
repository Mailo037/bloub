# AGENTS.md

Notes for AI coding agents working in this repo.

## Landing page

The repo also contains the product landing page in `website/` (Vite + TypeScript,
no framework). It is built from the app's own styles and code, and copies several
screens on purpose:

| Landing section | Mirrors |
|---|---|
| Hero / Customize (live Bloub) | `vendor/bot/*` (engine, `skins.ts`, `states.ts`), `src/shared.ts` (`makeBotSvg`, labels), `src/pet.ts` (gaze rule) |
| Desktop demo (pet, edit button, dock, context menu) | `src/index.html`, `src/style.css` |
| Chat window showcase | `src/chat.html`, `src/chat.css` |
| Models | `electron/chat/provider.cjs`, `electron/chat/protocols/*` |
| Agent tools | `electron/chat/tools.cjs` |
| Switches, buttons, colors | `src/ui/kit.css`, `src/ui/theme.css` |

Files: `website/index.html` (markup), `website/style.css` (all styles),
`website/main.ts` (avatars, demos, live release), `website/release.ts` (GitHub
release fetch, shared by the page and the build).

```bash
pnpm run website:dev      # dev server
pnpm run website:build    # builds to website/dist
pnpm run website:preview  # serves the build
```

### Release data is never hardcoded

Don't edit the version number, release date or download links by hand. The page
loads the latest GitHub release (`/repos/Mailo037/bloub/releases/latest`) every
time it is opened (cached for 10 minutes per browser). The build also writes the
latest release into the HTML, so the page is right without JS too. The workflow
`.github/workflows/website.yml` rebuilds on every published release.

### Hosting

GitHub Pages serves the `gh-pages` branch at https://mailo037.github.io/bloub/.
That branch is build output only: the workflow overwrites it on every push to
`main` that touches the site and on every release. Don't commit to it by hand.
Shape and color counts come from `vendor/bot/skins.ts` at runtime.

### When you make a big UI change

If your change visibly alters any of the files above (new layout, new colors or
radii, renamed or new sections in chat/dock/menu, new shapes or colors in
`skins.ts`, new agent tools or providers):

1. Update the matching section of the landing page in the same change so it
   still matches the app.
2. Update its copy too if a feature was added, removed or renamed (providers,
   agent tools, release artifacts).
3. Run `pnpm run website:build` and check the page in a browser.
4. Open a pull request for the landing page update. Don't push straight to
   `main`. In the PR description, say which app change it follows and add a
   before/after screenshot of the affected section.

Small fixes (spacing tweaks, bug fixes, internal refactors with no visible
change) don't need a landing page update.
