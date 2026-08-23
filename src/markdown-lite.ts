/**
 * Markdown-lite: fett, kursiv, Inline-Code, Fence-Code-Bloecke. Alles andere
 * bleibt maskierter Text — Provider-Ausgabe wird NIE als HTML geparst.
 * Kern arbeitet auf Strings (testbar), nur die Montage beruehrt das DOM.
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

/**
 * Inline-Tokenizer: Code-Spans zuerst herausloesen (Inhalt ist vor Fett/Kursiv
 * geschuetzt), dann **fett**, *kursiv*, _kursiv_ und ***beides***.
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

function pushStyled(text: string, out: InlineToken[]) {
  // ***bolditalic*** | **bold** | *italic* | _italic_
  const re = /\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) })
    if (m[1] !== undefined) out.push({ t: 'bolditalic', v: m[1] })
    else if (m[2] !== undefined) out.push({ t: 'bold', v: m[2] })
    else if (m[3] !== undefined) out.push({ t: 'italic', v: m[3] })
    else if (m[4] !== undefined) out.push({ t: 'italic', v: m[4] })
    last = re.lastIndex
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) })
}

/* ------------------------------------------------------------- montage */

export interface MarkdownRenderOpts {
  /** css-Klasse fuer generierte code-Bloecke */
  codeClass?: string
}

export function renderMarkdownLite(src: string, opts: MarkdownRenderOpts = {}): HTMLElement {
  const root = document.createElement('div')
  root.className = 'md-lite'
  for (const block of splitBlocks(src)) {
    if (block.kind === 'code') {
      const pre = document.createElement('pre')
      const code = document.createElement('code')
      if (opts.codeClass) code.className = opts.codeClass
      if (block.lang) code.dataset.lang = block.lang
      code.textContent = block.data
      pre.appendChild(code)
      root.appendChild(pre)
    } else {
      for (const para of block.data.split(/\n{2,}/)) {
        if (para.trim() === '') continue
        root.appendChild(renderParagraph(para))
      }
    }
  }
  return root
}

function renderParagraph(para: string): HTMLElement {
  const p = document.createElement('p')
  const segments = para.split('\n')
  segments.forEach((seg, i) => {
    if (i > 0) p.appendChild(document.createElement('br'))
    for (const tok of inlineTokens(seg)) {
      switch (tok.t) {
        case 'code': {
          const c = document.createElement('code')
          c.textContent = tok.v
          p.appendChild(c)
          break
        }
        case 'bold': {
          const b = document.createElement('strong')
          b.textContent = tok.v
          p.appendChild(b)
          break
        }
        case 'bolditalic': {
          const s = document.createElement('strong')
          const em = document.createElement('em')
          em.textContent = tok.v
          s.appendChild(em)
          p.appendChild(s)
          break
        }
        case 'italic': {
          const em2 = document.createElement('em')
          em2.textContent = tok.v
          p.appendChild(em2)
          break
        }
        default:
          p.appendChild(document.createTextNode(tok.v))
      }
    }
  })
  return p
}
