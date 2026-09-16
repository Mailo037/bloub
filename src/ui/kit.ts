import { chevron } from './icons'
/**
 * UI-Kit: Template-Objekte zum Mitnehmen. Jede Fabrik baut ein in sich
 * geschlossenes DOM-Stueck — kein natives <select>, kein confirm(), kein
 * Browser-Chrome. Kopierfaehig in jedes Fenster des Hauses.
 */
import './kit.css'

/* ------------------------------------------------------------ select */

export interface SelectOption {
  value: string
  label: string
  description?: string
}

export interface SelectHandle {
  el: HTMLElement
  getValue(): string
  setValue(v: string): void
}

export function createSelect(cfg: {
  options: SelectOption[]
  value?: string
  onChange?: (value: string) => void
}): SelectHandle {
  const root = document.createElement('div')
  root.className = 'k-select'

  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'k-select-trigger'
  trigger.setAttribute('aria-haspopup', 'listbox')
  trigger.setAttribute('aria-expanded', 'false')
  const labelSpan = document.createElement('span')
  labelSpan.className = 'k-select-value'
  const caret = document.createElement('span')
  caret.className = 'k-select-caret'
  caret.append(chevron())
  const valueWindow = document.createElement('span')
  valueWindow.className = 'k-select-value-window'
  valueWindow.append(labelSpan)
  trigger.append(valueWindow, caret)

  const menu = document.createElement('div')
  menu.className = 'k-select-menu hidden'
  const search = document.createElement('input')
  search.type = 'search'
  search.className = 'k-select-search'
  search.placeholder = 'Suchen…'
  search.setAttribute('aria-label', 'Optionen suchen')
  const list = document.createElement('ul')
  list.className = 'k-select-options'
  list.setAttribute('role', 'listbox')
  if (cfg.options.length > 5) menu.append(search)
  menu.append(list)
  menu.addEventListener('click', e => e.stopPropagation())
  search.addEventListener('input', renderMenu)

  let value = cfg.value ?? cfg.options[0]?.value ?? ''
  let open = false

  function labelFor(v: string): string {
    return cfg.options.find((o) => o.value === v)?.label ?? v
  }

  function renderMenu() {
    list.replaceChildren(
      ...cfg.options.filter(o => (o.label + ' ' + (o.description || '')).toLocaleLowerCase().includes(search.value.toLocaleLowerCase())).map((o) => {
        const li = document.createElement('li')
        li.className = `k-option${o.value === value ? ' selected' : ''}`
        const copy = document.createElement('span')
        copy.className = 'k-option-copy'
        const title = document.createElement('span')
        title.textContent = o.label
        copy.append(title)
        if (o.description) {
          const description = document.createElement('small')
          description.textContent = o.description
          copy.append(description)
        }
        const check = document.createElement('span')
        check.className = 'k-option-check'
        check.textContent = o.value === value ? '✓' : ''
        check.setAttribute('aria-hidden', 'true')
        li.append(copy, check)
        li.tabIndex = -1
        li.setAttribute('role', 'option')
        li.setAttribute('aria-selected', String(o.value === value))
        li.addEventListener('click', (e) => {
          e.stopPropagation()
          setValue(o.value)
          setOpen(false)
          cfg.onChange?.(o.value)
          trigger.focus()
        })
        return li
      })
    )
  }

  function setOpen(next: boolean) {
    open = next
    trigger.setAttribute('aria-expanded', String(open))
    root.classList.toggle('open', open)
    menu.classList.toggle('hidden', !open)
    if (open) {
      search.value = ''
      renderMenu()
      clampMenuToViewport()
      if (cfg.options.length > 5) search.focus()
    }
  }

  /** Dropdown nie ueber den sichtbaren Bereich hinaus: bei Platzmangel nach
   *  oben oeffnen und die Hoehe begrenzen. */
  function clampMenuToViewport() {
    const rect = menu.getBoundingClientRect()
    const viewH = window.innerHeight
    const viewW = window.innerWidth
    // Maximalhoehe: Platz nach unten bzw. oben
    const spaceBelow = viewH - rect.top - 8
    const spaceAbove = rect.bottom - rect.height - 8
    menu.style.maxHeight = `${Math.max(120, Math.min(280, Math.max(spaceBelow, spaceAbove)))}px`
    menu.style.overflowY = 'auto'
    // Wenn unten kein Platz ist, oeffne nach oben
    if (rect.bottom > viewH - 8 && spaceAbove > spaceBelow) {
      menu.style.top = 'auto'
      menu.style.bottom = 'calc(100% + 4px)'
    } else {
      menu.style.top = 'calc(100% + 4px)'
      menu.style.bottom = 'auto'
    }
    // Horizontal nie ueber den rechten Rand
    const after = menu.getBoundingClientRect()
    if (after.right > viewW - 8) {
      menu.style.left = `${Math.max(0, viewW - 8 - after.width)}px`
      menu.style.right = 'auto'
    }
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation()
    setOpen(!open)
  })

  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { setOpen(false); trigger.focus(); return }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) setOpen(true)
      const items = Array.from(menu.querySelectorAll<HTMLElement>('.k-option'))
      const current = items.indexOf(document.activeElement as HTMLElement)
      const next = current < 0 ? Math.max(0, items.findIndex(o => o.getAttribute('aria-selected') === 'true'))
        : (current + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[next]?.focus()
    }
    if ((e.key === 'Enter' || e.key === ' ') && document.activeElement?.classList.contains('k-option')) {
      e.preventDefault()
      ;(document.activeElement as HTMLElement).click()
    }
  })

  // Klick irgendwoanders schliesst das Menue
  document.addEventListener('click', () => setOpen(false))
  root.addEventListener('focusout', e => { if (!root.contains(e.relatedTarget as Node)) setOpen(false) })

  function setValue(v: string) {
    const previous = labelSpan.textContent
    value = v
    labelSpan.textContent = labelFor(v)
    if (previous && previous !== labelSpan.textContent && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      valueWindow.querySelector('.k-select-value-old')?.remove()
      const old = document.createElement('span')
      old.className = 'k-select-value-old'
      old.setAttribute('aria-hidden', 'true')
      old.textContent = previous
      valueWindow.append(old)
      const leaving = old.animate([{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(-100%)', opacity: 0 }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' })
      leaving.onfinish = () => old.remove()
      labelSpan.getAnimations().forEach(a => a.cancel())
      labelSpan.animate([{ transform: 'translateY(100%)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' })
    }
  }

  root.append(trigger, menu)
  setValue(value)
  return { el: root, getValue: () => value, setValue }
}

/* ---------------------------------------------------------- segmented */

export function createSegmented(cfg: {
  options: SelectOption[]
  value?: string
  onChange?: (value: string) => void
}): SelectHandle {
  const root = document.createElement('div')
  root.className = 'k-seg'
  root.setAttribute('role', 'radiogroup')

  let value = cfg.value ?? cfg.options[0]?.value ?? ''

  function paint() {
    for (const btn of root.querySelectorAll<HTMLButtonElement>('.k-seg-btn')) {
      const on = btn.dataset.value === value
      btn.classList.toggle('on', on)
      btn.setAttribute('aria-checked', on ? 'true' : 'false')
    }
  }

  for (const o of cfg.options) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'k-seg-btn'
    btn.dataset.value = o.value
    btn.textContent = o.label
    btn.setAttribute('role', 'radio')
    btn.addEventListener('click', () => {
      if (value === o.value) return
      value = o.value
      paint()
      cfg.onChange?.(o.value)
    })
    root.appendChild(btn)
  }

  function setValue(v: string) {
    value = v
    paint()
  }

  paint()
  return { el: root, getValue: () => value, setValue }
}

/* ------------------------------------------------------------ switch */

export interface SwitchHandle {
  el: HTMLElement
  getValue(): boolean
  setValue(v: boolean): void
}

export function createSwitch(cfg: { checked?: boolean; onChange?: (checked: boolean) => void; label?: string }): SwitchHandle {
  const el = document.createElement('span')
  el.className = `k-switch${cfg.checked ? ' on' : ''}`
  el.setAttribute('role', 'switch')
  const track = document.createElement('span')
  track.className = 'k-track'
  const knob = document.createElement('span')
  knob.className = 'k-knob'
  track.appendChild(knob)
  el.appendChild(track)
  if (cfg.label) el.appendChild(document.createTextNode(cfg.label))

  let checked = !!cfg.checked
  el.setAttribute('aria-checked', checked ? 'true' : 'false')
  el.addEventListener('click', () => {
    checked = !checked
    el.classList.toggle('on', checked)
    el.setAttribute('aria-checked', checked ? 'true' : 'false')
    cfg.onChange?.(checked)
  })

  return {
    el,
    getValue: () => checked,
    setValue: (v: boolean) => {
      checked = v
      el.classList.toggle('on', checked)
      el.setAttribute('aria-checked', checked ? 'true' : 'false')
    }
  }
}

/* ----------------------------------------------------------- dialog */

/**
 * In-Fenster-Dialog statt window.confirm() — nicht-fokussierbare Fenster
 * koennen eh keine nativen Dialoge zeigen.
 */
export function confirmDialog(cfg: {
  title: string
  message?: string
  okLabel?: string
  danger?: boolean
}): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'k-overlay'
    const box = document.createElement('div')
    box.className = 'k-dialog'
    const h = document.createElement('h3')
    h.textContent = cfg.title
    box.appendChild(h)
    if (cfg.message) {
      const p = document.createElement('p')
      p.textContent = cfg.message
      box.appendChild(p)
    }
    const actions = document.createElement('div')
    actions.className = 'k-dialog-actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'k-btn'
    cancel.textContent = 'Cancel'
    const ok = document.createElement('button')
    ok.type = 'button'
    ok.className = `k-btn ${cfg.danger ? 'danger' : 'primary'}`
    ok.textContent = cfg.okLabel ?? 'Ok'
    actions.append(cancel, ok)
    box.appendChild(actions)
    overlay.appendChild(box)

    const done = (result: boolean) => {
      overlay.remove()
      document.removeEventListener('keydown', onKey, true)
      resolve(result)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') done(false)
      if (e.key === 'Enter') done(true)
    }
    cancel.addEventListener('click', () => done(false))
    ok.addEventListener('click', () => done(true))
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) done(false)
    })
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(overlay)
    ok.focus()
  })
}
