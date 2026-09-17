import { chevron } from './ui/icons'
import { getBridge } from './shared'
export function initModelSelector(bridge: ReturnType<typeof getBridge>) {
  const root = document.getElementById('model-selector-slot')
  if (!root) return
  root.className = 'model-selector'
  const trigger = document.createElement('button')
  trigger.className = 'effort-trigger'
  trigger.title = 'Model and reasoning effort · Ctrl+Shift+M'
  trigger.setAttribute('aria-expanded', 'false')
  const popup = document.createElement('div')
  popup.className = 'model-popover hidden'
  root.append(trigger, popup)
  let models: Awaited<ReturnType<NonNullable<typeof bridge.listChatModels>>> = []
  let loadVersion = 0
  let selected = ''
  let effort = ''
  const labels: Record<string, string> = { off: 'Instant', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Very high' }
  const close = () => { popup.classList.add('hidden'); trigger.setAttribute('aria-expanded', 'false') }
  async function save(model: string, level: string) {
    const result = await bridge.selectChatModel?.(model, level)
    if (!result?.ok) throw new Error(result?.error || 'Could not save selection')
    selected = model; effort = level
    await load()
  }
  function render(list = false) {
    const model = models.find(m => m.key === selected)
    const label = document.createElement('span')
    label.className = 'effort-trigger-label'
    label.textContent = model?.levels.length ? labels[effort] || 'Reasoning effort' : model?.name || selected || 'Model'
    trigger.title = `${model?.name || selected || 'Model'} · Model and reasoning effort · Ctrl+Shift+M`
    trigger.replaceChildren(label, chevron())
    popup.replaceChildren()
    const heading = document.createElement('button')
    heading.className = 'model-popover-heading'
    heading.textContent = 'Choose model'
    heading.onclick = () => render(!list)
    if (list || !model?.levels.length) {
      heading.textContent = 'Choose model'
      popup.append(heading)
      if (!models.length) {
        const empty = document.createElement('p'); empty.textContent = 'Configure a provider and add models in Connections.'; popup.append(empty)
      }
      let group = ''
      for (const m of [...models].sort((a, b) => a.providerName.localeCompare(b.providerName))) {
        if (group !== m.providerName) {
          group = m.providerName
          const title = document.createElement('div'); title.className = 'model-popover-heading'; title.textContent = group; popup.append(title)
        }
        const option = document.createElement('button')
        option.className = 'model-option'
        option.textContent = m.name + (m.key === selected ? ' ✓' : '')
        option.title = `${m.providerName} · ${m.id}`
        option.onclick = () => void save(m.key, m.levels.includes(effort) ? effort : m.levels.includes('medium') ? 'medium' : m.levels[0] || '').catch(showError)
        popup.append(option)
      }
    } else {
      const value = document.createElement('button')
      value.type = 'button'
      value.className = 'effort-value'
      value.title = 'Choose model'
      value.onclick = () => render(true)
      const slider = document.createElement('input')
      slider.type = 'range'; slider.min = '0'; slider.max = String(model.levels.length - 1)
      slider.step = '1'; slider.value = String(Math.max(0, model.levels.indexOf(effort)))
      slider.setAttribute('aria-label', 'Reasoning effort')
      const paint = () => {
        const label = labels[model.levels[Number(slider.value)] || 'off'] || 'Instant'
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
  function showError() { trigger.title = 'Could not save selection'; }
  trigger.onclick = () => { const open = popup.classList.contains('hidden'); popup.classList.toggle('hidden', !open); trigger.setAttribute('aria-expanded', String(open)); if (open) render() }
  // Rendering another view removes the clicked button. The original event path
  // still identifies this as an inside click after that DOM replacement.
  document.addEventListener('click', e => { if (!e.composedPath().includes(root)) close() })
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') close()
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'm') { e.preventDefault(); trigger.click(); popup.querySelector<HTMLInputElement>('input')?.focus() }
  })
  async function load() {
    const version = ++loadVersion
    const cfg = await bridge.getConfig()
    const rows = await bridge.listChatModels?.() || []
    if (version !== loadVersion) return
    models = rows
    const current = models.find(m => m.id === cfg.chat?.model && m.protocol === cfg.chat?.protocol && m.baseUrl.replace(/\/$/, '') === (cfg.chat?.baseUrl || '').replace(/\/$/, ''))
    selected = current?.key || ''; effort = cfg.chat?.reasoningLevel || ''
    render()
  }
  bridge.onConfigChanged(() => { void load().catch(showError) })
  void load().catch(showError)
}
