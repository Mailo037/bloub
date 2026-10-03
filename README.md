# Bloub Pet 🐾

An interactive, AI-powered desktop pet companion built with Electron, Vite, TypeScript, and the procedural vector morphing Bloub avatar engine.

## Features

- **Procedural SVG Avatar Engine**: Smooth morphing body shapes, expressive eyes, dynamic animations (idle, talk, wink, bounce, orbit, burst, and custom keyframes).
- **Multi-Protocol AI Integration**: Connects to OpenAI Completions, OpenAI Responses, or Anthropic Messages protocols (compatible with OpenAI, Ollama, LM Studio, Claude, OpenRouter, and more).
- **Desktop Companion Capabilities**:
  - Multi-monitor support with smooth cross-screen dragging
  - Transparent, frameless overlay window with drag-and-drop placement
  - Dockable interactive chat interface with Markdown rendering (lists, tables, code with copy, links) and quick actions
  - Chat window with searchable chat list, visible work steps, friendly error messages with one-click retry, and file/image attachments via button, drag & drop or paste
  - Built-in Agent Tools: workspace file reading/editing, directory tree inspection, search, system info, memory persistence, desktop screenshots, and shell execution (sandboxed with configurable permissions)
  - Custom animation timelines & state triggers
- **Cross-Platform Packaging**: Automated installer (.exe), portable binary (.exe), and portable zip builds via Electron Builder.

## Development

```bash
# Install dependencies
pnpm install

# Start development mode
pnpm run dev

# Run test suites (plain Node)
node tools/test-chat-tools.cjs
node tools/test-persistent-chats.cjs

# Build renderer, then run the Electron integration tests
pnpm run build
pnpm exec electron tools/test-chat-activity.cjs
pnpm exec electron tools/test-chat-experience.cjs

# Package Electron App
pnpm run dist
```

## Website

The landing page lives in `website/` and reuses the app's avatar engine and styles.
Version and download links always come from the latest GitHub release, so they never
need manual updates. It deploys to GitHub Pages via `.github/workflows/website.yml`.

```bash
pnpm run website:dev     # dev server
pnpm run website:build   # static build in website/dist
```

## Release Artifacts

Electron builds are placed in `release/`:
- `Bloub Pet Setup <version>.exe` (NSIS Installer)
- `Bloub Pet <version>.exe` (Standalone Portable Executable)
- `Bloub Pet-<version>-win.zip` (Portable ZIP archive)

## License

MIT
