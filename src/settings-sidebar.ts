const STORAGE_KEY = 'bloub.settings.sidebarCollapsed'

/** Local presentation preference, independent of pet configuration. */
export function setupSettingsSidebar(onCollapse: () => void): { expand: () => void } {
  const sidebar = document.getElementById('sidebar')!
  const toggle = document.getElementById('sidebar-toggle') as HTMLButtonElement
  let collapsed = false
  try { collapsed = localStorage.getItem(STORAGE_KEY) === 'true' } catch { /* Storage may be unavailable. */ }

  // Labels remain available to assistive technology when their spans are hidden.
  for (const tab of sidebar.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
    const label = tab.querySelector('span')?.textContent?.trim() ?? ''
    tab.setAttribute('aria-label', label)
    tab.title = label
    tab.querySelector('svg')?.setAttribute('aria-hidden', 'true')
  }

  function apply(next: boolean, persist = true): void {
    if (next) {
      if (sidebar.querySelector('.search-wrap')?.contains(document.activeElement)) toggle.focus()
      // Never leave an invisible search filtering the content.
      onCollapse()
    }
    collapsed = next
    sidebar.classList.toggle('is-collapsed', collapsed)
    toggle.setAttribute('aria-expanded', String(!collapsed))
    toggle.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar'
    toggle.setAttribute('aria-label', toggle.title)
    if (persist) {
      try { localStorage.setItem(STORAGE_KEY, String(collapsed)) } catch { /* Keep working without persistence. */ }
    }
  }

  toggle.addEventListener('click', () => apply(!collapsed))
  apply(collapsed, false)
  return { expand: () => apply(false) }
}
