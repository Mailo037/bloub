# Fixing the Inactive Titlebar / Topbar Glitch on Windows in Frameless Transparent Electron Apps

> **Target Audience:** Electron Developers & AI Assistants building desktop pets, widgets, overlays, HUDs, or floating transparent tools on Windows 10 & Windows 11.

---

## 1. Problem Description

When creating a frameless, transparent window in Electron on Windows:
```javascript
const win = new BrowserWindow({
  frame: false,
  transparent: true,
  hasShadow: false,
  backgroundColor: '#00000000',
  // ...
})
```

**Symptom:**
- When the window is focused, it looks transparent and borderless.
- **As soon as the user clicks anywhere outside the window (losing focus / `blur`), a horizontal bar (often light blue, gray, or white, ~30px tall) appears across the top of the window.**

---

## 2. Root Cause Analysis

This issue is caused by the interaction between the **Windows Desktop Window Manager (DWM)**, Chromium's **Non-Client Frame View**, and Electron's default window styles:

### A. Windows DWM Non-Client Deactivation (`WM_NCACTIVATE (FALSE)`)
By default, top-level windows in Windows are registered with `WS_THICKFRAME` and standard activation handlers. When focus changes to another application, Windows sends `WM_NCACTIVATE` with `wParam = FALSE`. DWM's compositing pipeline attempts to paint an inactive caption/titlebar bar or non-client border on any focusable top-level window.

### B. Chromium Menu Container (`autoHideMenuBar: true`)
Setting `autoHideMenuBar: true` causes Chromium to initialize a hidden `MenuBarView` in the top container. When focus is lost, Chromium invalidates the top container layout and renders the background of the menu bar with the system accent/default color.

### C. `use-angle, d3d11` DirectComposition Swapchain Clears
Command-line switches like `app.commandLine.appendSwitch('use-angle', 'd3d11')` override Chromium's native DirectComposition swapchain behavior, causing the D3D11 backbuffer to clear non-client areas to an opaque color when inactive.

### D. `type: 'toolbar'` / `WS_EX_TOOLWINDOW` Caption Behavior
Using `type: 'toolbar'` adds `WS_EX_TOOLWINDOW`, but on Windows 10/11, tool windows with default frame styles still trigger a mini-caption (~24px) background draw when unfocused.

---

## 3. The Complete Solution

### Pattern: The Dynamic Focusable Strategy

For desktop pets, widgets, and overlays that only occasionally require text input (e.g. chat docks, search bars):

1. **Keep the window `focusable: false` by default:**
   - A window that is not focusable will **never receive OS-level focus** during normal hovering, dragging, or clicking.
   - Because it never gains focus, it **never loses focus**, completely preventing Windows DWM from sending `WM_NCACTIVATE (FALSE)` and drawing the inactive topbar.

2. **Dynamically enable `setFocusable(true)` ONLY when interactive input is needed:**
   - When the user opens the input/chat UI: call `win.setFocusable(true)` and `win.focus()`.
   - When the input/chat UI closes or the window blurs: call `win.setFocusable(false)`.

---

## 4. Implementation Reference

### Main Process (`main.js` / `main.cjs`)

```javascript
const { app, BrowserWindow, Menu } = require('electron')

// 1. Remove global application menu completely
Menu.setApplicationMenu(null)

// 2. DO NOT use 'use-angle, d3d11' if using transparent frameless windows
// (Electron's default compositor handles per-pixel alpha correctly)

let win = null
let chatVisible = false

function createPetWindow() {
  win = new BrowserWindow({
    width: 620,
    height: 620,
    frame: false,
    transparent: true,
    hasShadow: false,
    // CRITICAL: Disable thickFrame to remove WS_THICKFRAME
    thickFrame: false,
    // CRITICAL: Disable DWM corner rounding artifacts on Windows 11
    roundedCorners: false,
    // CRITICAL: Must be false so Chromium does NOT create a MenuBarView
    autoHideMenuBar: false,
    // CRITICAL: Keep focusable false during idle/pet state
    focusable: false,
    backgroundColor: '#00000000',
    skipTaskbar: true,
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  // Explicitly remove all window menus
  win.setMenu(null)
  win.removeMenu()
  win.setMenuBarVisibility(false)

  // Prevent title updates from triggering Windows DWM caption updates
  win.webContents.on('page-title-updated', (e) => e.preventDefault())

  // On blur, return to unfocusable mode if chat is not open
  win.on('blur', () => {
    if (!chatVisible) {
      win.setFocusable(false)
    }
  })
}

// When opening text input / chat dock:
function showChat() {
  if (!win || win.isDestroyed()) return
  chatVisible = true
  // Enable focusability so user can click & type into input fields
  win.setFocusable(true)
  win.webContents.send('ui:chat-visibility', true)
  win.focus()
}

// When closing text input / chat dock:
function hideChat() {
  if (!win || win.isDestroyed()) return
  chatVisible = false
  win.webContents.send('ui:chat-visibility', false)
  // Disable focusability to restore 100% ghost/artifact-free desktop mode
  win.setFocusable(false)
}
```

### Renderer Process / Mouse Passthrough (`pet.ts`)

```typescript
// Ensure click passthrough logic ignores non-interactive areas
function updateIgnore(overUi: boolean) {
  const overPet = isMouseOverPet()
  const overChat = isMouseOverChat()
  const shouldIgnore = !(overUi || overPet || overChat || isDragging)
  
  if (shouldIgnore !== isIgnoring) {
    isIgnoring = shouldIgnore
    window.bloubPet.setIgnore(shouldIgnore) // win.setIgnoreMouseEvents(true, { forward: true })
  }
}
```

---

## 5. Checklist for Frameless Windows on Windows 10/11

| Setting | Recommended Value | Reason |
| :--- | :--- | :--- |
| `frame` | `false` | Removes standard OS window borders and titlebar |
| `transparent` | `true` | Enables per-pixel alpha transparency |
| `thickFrame` | `false` | Strips `WS_THICKFRAME` (prevents DWM inactive border drawing) |
| `roundedCorners` | `false` | Prevents Windows 11 DWM corner clipping white boxes |
| `autoHideMenuBar` | `false` | Prevents Chromium from attaching a dormant `MenuBarView` |
| `focusable` | `false` (idle) / `true` (input) | Prevents Windows `WM_NCACTIVATE` from ever painting a caption bar |
| `backgroundColor` | `'#00000000'` | Full alpha 0 clear color |
| `Menu.setApplicationMenu` | `null` | Eliminates native menu overhead |
| `win.setMenu(null)` | called immediately | Removes default window menu |
| `titleBarStyle` | *omit* | Do not set `hidden` on Windows (which triggers WCO/caption space) |
