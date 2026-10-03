/**
 * Markdown-lite: Ueberschriften, Listen (verschachtelt, Aufgaben), Zitate,
 * Tabellen, Trennlinien, fett/kursiv/durchgestrichen, Inline-Code, Links und
 * Fence-Code-Bloecke. Alles andere bleibt maskierter Text — Provider-Ausgabe
 * wird NIE als HTML geparst. Kern arbeitet auf Strings (testbar), nur die
 * Montage beruehrt das DOM.
 */

export interface CodeBlock {
  kind: 'code'
  lang: string
  data: string
}

export interface TextBlock {
  kind: 'text'
  data: string
}

export type Block = CodeBlock | TextBlock

export type InlineToken =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'bold'; v: string }
  | { t: 'italic'; v: string }
  | { t: 'bolditalic'; v: string }
  | { t: 'strike'; v: string }
  | { t: 'link'; v: string; href: string }

export interface ListItem {
  text: string
  /** Aufgabenliste: true = [x], false = [ ], undefined = normaler Punkt */
  checked?: boolean
  children: ListBlock[]
}

export interface ListBlock {
  kind: 'list'
  ordered: boolean
  start: number
  items: ListItem[]
}

export type TextPart =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'hr' }
  | { kind: 'quote'; text: string }
  | ListBlock
  | { kind: 'table'; header: string[]; align: Array<'' | 'left' | 'center' | 'right'>; rows: string[][] }
  | { kind: 'para'; text: string }

/** Quelle in Code-Fences und Textbloecke teilen; offener Fence = Rest ist Code. */
export function splitBlocks(src: string): Block[] {
  const blocks: Block[] = []
  const fenceRe = /^```(.*)$/
  const lines = src.split('\n')
  let textLines: string[] = []
  let inCode: { lang: string; lines: string[] } | null = null

  const flushText = () => {
    if (textLines.length > 0) blocks.push({ kind: 'text', data: textLines.join('\n') })
    textLines = []
  }

  for (const line of lines) {
    const m = fenceRe.exec(line.trim())
    if (inCode) {
      if (m) {
        blocks.push({ kind: 'code', lang: inCode.lang.trim(), data: inCode.lines.join('\n') })
        inCode = null
      } else {
        inCode.lines.push(line)
      }
    } else if (m) {
      flushText()
      inCode = { lang: m[1] ?? '', lines: [] }
    } else {
      textLines.push(line)
    }
  }
  // Offener Fence am Ende: der Rest bleibt Code
  if (inCode) blocks.push({ kind: 'code', lang: inCode.lang.trim(), data: inCode.lines.join('\n') })
  flushText()
  return blocks
}

/* --------------------------------------------------------- block-ebene */

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

function indentOf(ws: string): number {
  return ws.replace(/\t/g, '    ').length
}

function splitRow(line: string): string[] {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)
  return row.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

function isTableStart(lines: string[], i: number): boolean {
  const head = lines[i] ?? ''
  const sep = lines[i + 1] ?? ''
  return head.includes('|') && sep.includes('-') && TABLE_SEP_RE.test(sep) && splitRow(head).length >= 2
}

/** Beginnt in Zeile i ein eigener Block (unterbricht damit einen Absatz)? */
function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i] ?? ''
  return HEADING_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line) || LIST_RE.test(line) || isTableStart(lines, i)
}

/** Textblock (ohne Code-Fences) in Ueberschriften, Listen, Zitate, Tabellen und Absaetze teilen. */
export function parseTextBlock(src: string): TextPart[] {
  const lines = src.split('\n')
  const out: TextPart[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (!line.trim()) {
      i++
      continue
    }
    const heading = HEADING_RE.exec(line)
    if (heading) {
      out.push({ kind: 'heading', level: heading[1]!.length, text: heading[2] ?? '' })
      i++
      continue
    }
    if (HR_RE.test(line)) {
      out.push({ kind: 'hr' })
      i++
      continue
    }
    if (QUOTE_RE.test(line)) {
      const inner: string[] = []
      while (i < lines.length) {
        const q = QUOTE_RE.exec(lines[i] ?? '')
        if (!q) break
        inner.push(q[1] ?? '')
        i++
      }
      out.push({ kind: 'quote', text: inner.join('\n') })
      continue
    }
    if (isTableStart(lines, i)) {
      const header = splitRow(line)
      const align = splitRow(lines[i + 1] ?? '').map((c) => {
        const left = c.startsWith(':')
        const right = c.endsWith(':')
        return left && right ? 'center' : right ? 'right' : left ? 'left' : ''
      }) as Array<'' | 'left' | 'center' | 'right'>
      i += 2
      const rows: string[][] = []
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim()) {
        rows.push(splitRow(lines[i] ?? ''))
        i++
      }
      out.push({ kind: 'table', header, align, rows })
      continue
    }
    if (LIST_RE.test(line)) {
      i = parseList(lines, i, out)
      continue
    }
    const para: string[] = [line]
    i++
    while (i < lines.length && (lines[i] ?? '').trim() && !startsBlock(lines, i)) {
      para.push(lines[i] ?? '')
      i++
    }
    out.push({ kind: 'para', text: para.join('\n') })
  }
  return out
}

/** Liste ab Zeile i einlesen (Verschachtelung ueber Einrueckung); liefert die naechste freie Zeile. */
function parseList(lines: string[], start: number, out: TextPart[]): number {
  const stack: Array<{ indent: number; list: ListBlock }> = []
  let i = start
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const m = LIST_RE.exec(line)
    if (!m) {
      if (!line.trim()) {
        // Leerzeile: Liste geht weiter, wenn danach ein Punkt oder eingerueckter Text folgt
        let j = i + 1
        while (j < lines.length && !(lines[j] ?? '').trim()) j++
        const next = lines[j] ?? ''
        if (j < lines.length && (LIST_RE.test(next) || /^\s{2,}\S/.test(next))) {
          i = j
          continue
        }
        break
      }
      const top = stack[stack.length - 1]
      const last = top?.list.items[top.list.items.length - 1]
      if (last && /^\s{2,}\S/.test(line) && !HEADING_RE.test(line)) {
        last.text += '\n' + line.trim()
        i++
        continue
      }
      break
    }
    const indent = indentOf(m[1] ?? '')
    const marker = m[2] ?? '-'
    const ordered = /\d/.test(marker)
    let text = m[3] ?? ''
    let checked: boolean | undefined
    const task = /^\[([ xX])\]\s+(.*)$/.exec(text)
    if (task) {
      checked = task[1] !== ' '
      text = task[2] ?? ''
    }
    const item: ListItem = { text, checked, children: [] }
    const newList = (): ListBlock => ({ kind: 'list', ordered, start: ordered ? parseInt(marker, 10) || 1 : 1, items: [item] })

    let top = stack[stack.length - 1]
    if (!top) {
      const list = newList()
      out.push(list)
      stack.push({ indent, list })
    } else if (indent >= top.indent + 2 && top.list.items.length > 0) {
      const list = newList()
      top.list.items[top.list.items.length - 1]!.children.push(list)
      stack.push({ indent, list })
    } else {
      while (stack.length > 1 && indent < top.indent) {
        stack.pop()
        top = stack[stack.length - 1]!
      }
      if (stack.length === 1 && top.list.ordered !== ordered && indent <= top.indent) {
        // Wechsel zwischen nummeriert und Punkten auf oberster Ebene: neue Liste
        const list = newList()
        out.push(list)
        stack[0] = { indent, list }
      } else {
        top.list.items.push(item)
      }
    }
    i++
  }
  return i
}

/* -------------------------------------------------------- inline-ebene */

/**
 * Inline-Tokenizer: Code-Spans zuerst herausloesen (Inhalt ist vor Fett/Kursiv
 * geschuetzt), dann Links, nackte URLs, **fett**, *kursiv*, _kursiv_,
 * ~~durchgestrichen~~ und ***beides***.
 */
export function inlineTokens(text: string): InlineToken[] {
  const tokens: InlineToken[] = []
  // Erst an Backticks teilen — gerade Indizes sind Text, ungerade Code
  const parts = text.split('`')
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? ''
    if (i % 2 === 1) {
      if (part.length > 0) tokens.push({ t: 'code', v: part })
      continue
    }
    pushStyled(part, tokens)
  }
  return tokens
}

const INLINE_RE = new RegExp(
  [
    /\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.source, // 1 text, 2 href
    /(https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]}*_~])/.source, // 3 nackte URL
    /\*\*\*([^*]+)\*\*\*/.source, // 4
    /\*\*([^*]+)\*\*/.source, // 5
    /(?<![\w])__([^_]+)__(?![\w])/.source, // 6
    /~~([^~]+)~~/.source, // 7
    /\*([^*\s][^*]*)\*/.source, // 8
    /(?<![\w])_([^_\s][^_]*)_(?![\w])/.source // 9
  ].join('|'),
  'g'
)

/** Nur sichere Ziele werden zu Links — alles andere bleibt Text. */
export function safeHref(href: string): string | null {
  const trimmed = href.trim()
  return /^(https?:\/\/|mailto:)/i.test(trimmed) ? trimmed : null
}

function pushStyled(text: string, out: InlineToken[]) {
  INLINE_RE.lastIndex = 0
  let last = 0
  let m: RegExpExecArray | null
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) })
    if (m[1] !== undefined) {
      const href = safeHref(m[2] ?? '')
      out.push(href ? { t: 'link', v: m[1], href } : { t: 'text', v: m[1] })
    } else if (m[3] !== undefined) out.push({ t: 'link', v: m[3], href: m[3] })
    else if (m[4] !== undefined) out.push({ t: 'bolditalic', v: m[4] })
    else if (m[5] !== undefined) out.push({ t: 'bold', v: m[5] })
    else if (m[6] !== undefined) out.push({ t: 'bold', v: m[6] })
    else if (m[7] !== undefined) out.push({ t: 'strike', v: m[7] })
    else if (m[8] !== undefined) out.push({ t: 'italic', v: m[8] })
    else if (m[9] !== undefined) out.push({ t: 'italic', v: m[9] })
    last = INLINE_RE.lastIndex
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) })
}

/* ------------------------------------------------------------- montage */

export interface MarkdownRenderOpts {
  /** css-Klasse fuer generierte code-Bloecke */
  codeClass?: string
  /** Kopfzeile mit Sprache + Kopieren-Knopf ueber Code-Bloecken (Default: an) */
  codeHeader?: boolean
  /** Link-Klick; Default oeffnet die Adresse im Standard-Browser. */
  onLink?: (href: string) => void
}

function openLinkDefault(href: string) {
  const bridge = (window as unknown as { bloubPet?: { openExternal?: (url: string) => unknown } }).bloubPet
  void bridge?.openExternal?.(href)
}

export function renderMarkdownLite(src: string, opts: MarkdownRenderOpts = {}): HTMLElement {
  const root = document.createElement('div')
  root.className = 'md-lite'
  for (const block of splitBlocks(src)) {
    if (block.kind === 'code') root.appendChild(renderCode(block, opts))
    else appendTextParts(root, parseTextBlock(block.data), opts)
  }
  return root
}

function renderCode(block: CodeBlock, opts: MarkdownRenderOpts): HTMLElement {
  const pre = document.createElement('pre')
  const code = document.createElement('code')
  if (opts.codeClass) code.className = opts.codeClass
  if (block.lang) code.dataset.lang = block.lang
  code.textContent = block.data
  pre.appendChild(code)
  if (opts.codeHeader === false) return pre

  const wrap = document.createElement('div')
  wrap.className = 'md-code'
  const head = document.createElement('div')
  head.className = 'md-code-head'
  const lang = document.createElement('span')
  lang.className = 'md-code-lang'
  lang.textContent = block.lang || 'code'
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'md-code-copy'
  copy.textContent = 'Copy'
  copy.title = 'Copy code'
  let reset: ReturnType<typeof setTimeout> | undefined
  copy.addEventListener('click', (e) => {
    e.stopPropagation()
    clearTimeout(reset)
    navigator.clipboard.writeText(block.data).then(
      () => { copy.textContent = 'Copied' },
      () => { copy.textContent = 'Copy failed' }
    )
    reset = setTimeout(() => { copy.textContent = 'Copy' }, 1600)
  })
  head.append(lang, copy)
  wrap.append(head, pre)
  return wrap
}

function appendTextParts(parent: HTMLElement, parts: TextPart[], opts: MarkdownRenderOpts) {
  for (const part of parts) {
    switch (part.kind) {
      case 'heading': {
        const h = document.createElement(`h${Math.min(6, part.level + 2)}`)
        h.className = `md-h md-h${part.level}`
        appendInline(h, part.text, opts)
        parent.appendChild(h)
        break
      }
      case 'hr':
        parent.appendChild(document.createElement('hr'))
        break
      case 'quote': {
        const q = document.createElement('blockquote')
        appendTextParts(q, parseTextBlock(part.text), opts)
        parent.appendChild(q)
        break
      }
      case 'list':
        parent.appendChild(renderList(part, opts))
        break
      case 'table':
        parent.appendChild(renderTable(part, opts))
        break
      default: {
        const p = document.createElement('p')
        appendInline(p, part.text, opts)
        parent.appendChild(p)
      }
    }
  }
}

function renderList(list: ListBlock, opts: MarkdownRenderOpts): HTMLElement {
  const el = document.createElement(list.ordered ? 'ol' : 'ul')
  if (list.ordered && list.start !== 1) el.setAttribute('start', String(list.start))
  for (const item of list.items) {
    const li = document.createElement('li')
    if (item.checked !== undefined) {
      li.className = `md-task${item.checked ? ' done' : ''}`
      const box = document.createElement('span')
      box.className = 'md-task-box'
      box.setAttribute('aria-hidden', 'true')
      box.textContent = item.checked ? '✓' : ''
      li.appendChild(box)
    }
    appendInline(li, item.text, opts)
    for (const child of item.children) li.appendChild(renderList(child, opts))
    el.appendChild(li)
  }
  return el
}

function renderTable(part: Extract<TextPart, { kind: 'table' }>, opts: MarkdownRenderOpts): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'md-table-wrap'
  const table = document.createElement('table')
  const thead = document.createElement('thead')
  const headRow = document.createElement('tr')
  part.header.forEach((cell, idx) => {
    const th = document.createElement('th')
    if (part.align[idx]) th.style.textAlign = part.align[idx]!
    appendInline(th, cell, opts)
    headRow.appendChild(th)
  })
  thead.appendChild(headRow)
  const tbody = document.createElement('tbody')
  for (const row of part.rows) {
    const tr = document.createElement('tr')
    for (let idx = 0; idx < part.header.length; idx++) {
      const td = document.createElement('td')
      if (part.align[idx]) td.style.textAlign = part.align[idx]!
      appendInline(td, row[idx] ?? '', opts)
      tr.appendChild(td)
    }
    tbody.appendChild(tr)
  }
  table.append(thead, tbody)
  wrap.appendChild(table)
  return wrap
}

/** Inline-Text (Zeilenumbrueche als <br>) in ein Element haengen. */
function appendInline(target: HTMLElement, text: string, opts: MarkdownRenderOpts) {
  text.split('\n').forEach((seg, i) => {
    if (i > 0) target.appendChild(document.createElement('br'))
    for (const tok of inlineTokens(seg)) target.appendChild(renderToken(tok, opts))
  })
}

function renderToken(tok: InlineToken, opts: MarkdownRenderOpts): Node {
  switch (tok.t) {
    case 'code': {
      const c = document.createElement('code')
      c.textContent = tok.v
      return c
    }
    case 'bold': {
      const b = document.createElement('strong')
      b.textContent = tok.v
      return b
    }
    case 'bolditalic': {
      const s = document.createElement('strong')
      const em = document.createElement('em')
      em.textContent = tok.v
      s.appendChild(em)
      return s
    }
    case 'italic': {
      const em = document.createElement('em')
      em.textContent = tok.v
      return em
    }
    case 'strike': {
      const del = document.createElement('del')
      del.textContent = tok.v
      return del
    }
    case 'link': {
      const a = document.createElement('a')
      a.className = 'md-link'
      a.href = tok.href
      a.title = tok.href
      a.rel = 'noopener noreferrer'
      a.textContent = tok.v
      a.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        ;(opts.onLink ?? openLinkDefault)(tok.href)
      })
      return a
    }
    default:
      return document.createTextNode(tok.v)
  }
}
