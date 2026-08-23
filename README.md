# Bloub Pad 🐾

An interactive, AI-powered desktop pet companion built with Electron, Vite, TypeScript, and the procedural vector morphing Bloub avatar engine.

## Features

- **Procedural SVG Avatar Engine**: Smooth morphing body shapes, expressive eyes, dynamic animations (idle, talk, wink, bounce, orbit, burst, and custom keyframes).
- **Multi-Protocol AI Integration**: Connects to OpenAI Completions, OpenAI Responses, or Anthropic Messages protocols (compatible with OpenAI, Ollama, LM Studio, Claude, OpenRouter, and more).
- **Desktop Companion Capabilities**:
  - Transparent, frameless overlay window with drag-and-drop placement
  - Dockable interactive chat interface with Markdown rendering and quick actions
  - Built-in Agent Tools: workspace file reading/editing, directory tree inspection, search, system info, memory persistence, desktop screenshots, and shell execution (sandboxed with configurable permissions)
  - Custom animation timelines & state triggers
- **Cross-Platform Packaging**: Automated installer (.exe), portable binary (.exe), and portable zip builds via Electron Builder.

## Development

`ash
# Install dependencies
pnpm install

# Start development mode
pnpm run dev

# Run test suites
node tools/test-protocol-adapters.cjs
node tools/test-chat-tools.cjs

# Build renderer
pnpm run build

# Package Electron App
pnpm run dist
`

## Release Artifacts

Electron builds are placed in elease/:
- Bloub Pad Setup <version>.exe (NSIS Installer)
- Bloub Pad <version>.exe (Standalone Portable Executable)
- Bloub Pad-<version>-win.zip (Portable ZIP archive)

## License

MIT
