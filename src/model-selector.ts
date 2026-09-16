import { chevron } from './ui/icons'
import { getBridge } from './shared'
export function initModelSelector(bridge: ReturnType<typeof getBridge>) {
  const root = document.getElementById('model-selector-slot')
  if (!root) return
  root.className = 'model-selector'
  const trigger = document.createElement('button')
  trigger.className = 'effort-trigger'
  trigger.title = 'Modell und Denkaufwand · Ctrl+Shift+M'
  trigger.setAttribute('aria-expanded', 'false')
  const popup = document.createElement('div')
  popup.className = 'model-popover hidden'
  root.append(trigger, popup)
  let models: Array<{ id: string; name: string; levels: string[] }> = []
  let selected = ''
  let effort = ''
  const labels: Record<string, string> = { off: 'Sofort', minimal: 'Minimal', low: 'Niedrig', medium: 'Mittel', high: 'Hoch', xhigh: 'Sehr hoch' }
  const close = () => { popup.classList.add('hidden'); trigger.setAttribute('aria-expanded', 'false') }
  async function save(model: string, level: string) {
    const cfg = await bridge.getConfig()
    await bridge.updateConfig({ chat: { ...cfg.chat, model, reasoningLevel: level } })
    selected = model; effort = level
    render()
  }
  function render(list = false) {
    const model = models.find(m => m.id === selected)
    const label = document.createElement('span')
    label.className = 'effort-trigger-label'
    label.textContent = model?.levels.length ? labels[effort] || 'Denkaufwand' : model?.name || selected || 'Modell'
    trigger.title = `${model?.name || selected || 'Modell'} · Modell und Denkaufwand · Ctrl+Shift+M`
    trigger.replaceChildren(label, chevron())
    popup.replaceChildren()
    const heading = document.createElement('button')
    heading.className = 'model-popover-heading'
    heading.textContent = 'Modell auswählen'
    heading.onclick = () => render(!list)
    if (list || !model?.levels.length) {
      heading.textContent = 'Modell auswählen'
      popup.append(heading)
      for (const m of models) {
        const option = document.createElement('button')
        option.className = 'model-option'
        option.textContent = m.name + (m.id === selected ? ' ✓' : '')
        option.onclick = () => void save(m.id, m.levels.includes(effort) ? effort : m.levels.includes('medium') ? 'medium' : m.levels[0] || '').catch(showError)
        popup.append(option)
      }
    } else {
      const value = document.createElement('button')
      value.type = 'button'
      value.className = 'effort-value'
      value.title = 'Modell auswählen'
      value.onclick = () => render(true)
      const slider = document.createElement('input')
      slider.type = 'range'; slider.min = '0'; slider.max = String(model.levels.length - 1)
      slider.step = '1'; slider.value = String(Math.max(0, model.levels.indexOf(effort)))
      slider.setAttribute('aria-label', 'Denkaufwand')
      const paint = () => {
        const label = labels[model.levels[Number(slider.value)] || 'off'] || 'Sofort'
        value.replaceChildren(document.createTextNode(label), chevron('right'))
        slider.setAttribute('aria-valuetext', label)
        slider.style.setProperty('--progress', `${Number(slider.value) / Math.max(1, model.levels.length - 1) * 100}%`)
      }
      slider.oninput = paint
      slider.onchange = () => void save(selected, model.levels[Number(slider.value)] || 'off').catch(showError)
      const track = document.createElement('div')
      track.className = 'effort-track'
      const dots = document.createElement('div')
      dots.className = 'effort-stops'
      dots.setAttribute('aria-hidden', 'true')
      for (const level of model.levels) {
        const dot = document.createElement('span')
        dot.title = labels[level] || level
        dots.append(dot)
      }
      track.append(slider, dots)
      paint(); popup.append(value, track)
    }
  }
  function showError() { trigger.title = 'Auswahl konnte nicht gespeichert werden'; }
  trigger.onclick = () => { const open = popup.classList.contains('hidden'); popup.classList.toggle('hidden', !open); trigger.setAttribute('aria-expanded', String(open)); if (open) render() }
  // Rendering another view removes the clicked button. The original event path
  // still identifies this as an inside click after that DOM replacement.
  document.addEventListener('click', e => { if (!e.composedPath().includes(root)) close() })
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') close()
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'm') { e.preventDefault(); trigger.click(); popup.querySelector<HTMLInputElement>('input')?.focus() }
  })
  async function load() {
    const cfg = await bridge.getConfig()
    selected = cfg.chat?.model || ''; effort = cfg.chat?.reasoningLevel || ''
    models = await bridge.listChatModels?.() || []
    render()
  }
  bridge.onConfigChanged(() => { void load().catch(showError) })
  void load().catch(showError)
}
