import { createSelect } from './ui/kit'
import type { PetBridge, PetConfigShape } from './shared'

type Provider = 'openai' | 'gemini'
type ChatProvider = Provider | 'custom'
const presets = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', protocol: 'openai-completions' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', protocol: 'openai-completions' }
}
const element = (id: string) => document.getElementById(id)!
const input = (id: string) => element(id) as HTMLInputElement
const show = (id: string, visible: boolean) => element(id).classList.toggle('hidden', !visible)
function chatProvider(config: { chat?: { baseUrl?: string } }): ChatProvider {
  try {
    const u = new URL(config.chat?.baseUrl || '')
    if (u.protocol !== 'https:' || u.port || u.username || u.password || u.search || u.hash) return 'custom'
    const p = u.pathname.replace(/\/$/, '')
    if (u.hostname === 'api.openai.com' && p === '/v1') return 'openai'
    if (u.hostname === 'generativelanguage.googleapis.com' && ['/v1', '/v1beta', '/v1/openai', '/v1beta/openai'].includes(p)) return 'gemini'
  } catch { /* Custom or not configured. */ }
  return 'custom'
}

export function setupProviderSettings(bridge: PetBridge, getConfig: () => PetConfigShape, switchTab: (tab: string) => void) {
  const providers = [{ value: 'openai', label: 'OpenAI' }, { value: 'gemini', label: 'Gemini' }]
  let selection: Provider = 'openai'
  let initialized = false
  let voiceProvider: Provider = 'gemini'
  let statusRound = 0
  const keyStates = new Map<string, { input: HTMLInputElement; status: HTMLElement; busy: boolean; dirty: boolean }>()
  function selectCredentials(provider: Provider) {
    selection = provider
    credentialSelect.setValue(provider)
    show('openai-credential-row', provider === 'openai')
    show('gemini-credential-row', provider === 'gemini')
  }
  const credentialSelect = createSelect({ options: providers, onChange: value => selectCredentials(value as Provider) })
  element('credential-provider-slot').replaceChildren(credentialSelect.el)

  function bindKey(name: string, inputId: string, buttonId: string, statusId: string, save: (key: string) => Promise<{ ok: boolean; error?: string }> | undefined) {
    const field = input(inputId)
    const button = element(buttonId) as HTMLButtonElement
    const status = element(statusId)
    const state = { input: field, status, busy: false, dirty: false }
    keyStates.set(name, state)
    field.setAttribute('aria-describedby', statusId)
    field.addEventListener('input', () => { state.dirty = true; status.textContent = 'Not saved yet — click Save key.' })
    const submit = async () => {
      if (state.busy) return
      const value = field.value.trim()
      if (!value) { status.textContent = 'Enter a key first. Your saved key will not be removed.'; return }
      state.busy = true
      button.disabled = true
      field.readOnly = true
      status.textContent = 'Saving…'
      try {
        const result = await save(value)
        if (!result?.ok) throw new Error(result?.error || 'Could not save the key. Restart Bloub after updating and retry.')
        field.value = ''
        field.placeholder = 'Saved — enter a new key to replace'
        state.dirty = false
        status.textContent = 'Saved securely on this device.'
      } catch (error) {
        // Keep the draft and the previous stored key after any failure.
        state.dirty = true
        status.textContent = error instanceof Error ? error.message : 'Could not save the key. Please retry.'
      } finally {
        state.busy = false
        button.disabled = false
        field.readOnly = false
        void refreshStatus()
      }
    }
    button.addEventListener('click', () => void submit())
    field.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void submit() } })
  }
  bindKey('openai', 'openai-apikey', 'openai-key-save', 'openai-key-status', key => bridge.setProviderApiKey?.('openai', key))
  bindKey('gemini', 'audio-apikey', 'gemini-key-save', 'gemini-key-status', key => bridge.setProviderApiKey?.('gemini', key))
  bindKey('custom', 'chat-apikey', 'custom-key-save', 'custom-key-status', key => bridge.setApiKey?.(key))

  async function refreshStatus() {
    const round = ++statusRound
    for (const provider of ['openai', 'gemini', 'custom'] as const) {
      try {
        const result = provider === 'custom' ? await bridge.getApiKeyStatus?.() : await bridge.getProviderKeyStatus?.(provider)
        if (round !== statusRound) return
        const state = keyStates.get(provider)!
        const hasKey = !!result?.hasKey
        state.input.placeholder = hasKey ? 'Saved — enter a new key to replace' : 'Not set'
        if (!state.busy && !state.dirty) state.status.textContent = result ? (hasKey ? 'Saved securely on this device.' : 'No key saved yet.') : 'Key status unavailable. Restart Bloub after updating.'
        if (provider === voiceProvider) element('voice-key-status').textContent = `${provider === 'openai' ? 'OpenAI' : 'Gemini'} key: ${hasKey ? 'saved in Connections' : 'not saved — add it in Connections'}.`
      } catch {
        if (round !== statusRound) return
        const state = keyStates.get(provider)!
        if (!state.busy && !state.dirty) state.status.textContent = 'Could not read key status. Please retry.'
      }
    }
  }

  let customFields: { baseUrl: string; model: string; protocol: string } | null = null
  const chatSelect = createSelect({ options: [...providers, { value: 'custom', label: 'Custom endpoint' }], onChange: async value => {
    const previous = getConfig()
    if (chatProvider(previous) === 'custom') customFields = { baseUrl: input('chat-baseurl').value, model: input('chat-model').value, protocol: previous.chat?.protocol || 'openai-completions' }
    const saved = previous.chat?.modelProfiles?.find(p => chatProvider({ chat: p }) === value)
    const fields = saved || (value === 'custom' ? (customFields || { baseUrl: '', model: '', protocol: 'openai-completions' }) : presets[value as Provider])
    // Update visible values immediately so a queued text-field debounce cannot restore the old endpoint.
    input('chat-baseurl').value = fields.baseUrl
    input('chat-model').value = fields.model
    if (value !== 'custom') selectCredentials(value as Provider)
    try { await bridge.updateConfig({ chat: { ...previous.chat, ...fields } }); sync() }
    catch { element('chat-test-result').textContent = 'Could not save provider. Please retry.'; sync() }
  } })
  element('chat-provider-slot').replaceChildren(chatSelect.el)

  const voiceSelect = createSelect({ options: providers, onChange: async value => {
    const previous = getConfig()
    const audio = { ...previous.audio, liveProvider: value, transcriptionProvider: previous.audio?.transcriptionProvider === 'local' ? 'local' : value, ...(value === 'openai' ? { voiceEnabled: false } : {}) }
    try {
      await bridge.updateConfig({ audio, ...(value === 'openai' ? { chat: { ...previous.chat, voiceAlways: false } } : {}) } as Parameters<PetBridge['updateConfig']>[0])
      sync()
    } catch { element('voice-key-status').textContent = 'Could not save voice provider. Please retry.' }
  } })
  element('voice-provider-slot').replaceChildren(voiceSelect.el)
  const transcriptionSelect = createSelect({ options: [{ value: 'cloud', label: 'Selected voice provider' }, { value: 'local', label: 'Local Whisper' }], onChange: async value => {
    try { await bridge.updateConfig({ audio: { ...getConfig().audio, transcriptionProvider: value === 'local' ? 'local' : voiceProvider } } as Parameters<PetBridge['updateConfig']>[0]); sync() }
    catch { element('transcription-cloud-description').textContent = 'Could not save transcription mode.' }
  } })
  element('transcription-provider-slot').replaceChildren(transcriptionSelect.el)
  input('transcription-local-url').addEventListener('change', async () => {
    const field = input('transcription-local-url')
    try {
      const url = new URL(field.value.trim())
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error()
      field.setCustomValidity('')
      await bridge.updateConfig({ audio: { ...getConfig().audio, whisperUrl: url.href } } as Parameters<PetBridge['updateConfig']>[0])
    } catch { field.setCustomValidity('Enter a valid HTTP or HTTPS server URL.'); field.reportValidity() }
  })
  element('transcription-local-guide').addEventListener('click', () => void bridge.openExternal?.('https://github.com/ggml-org/whisper.cpp/tree/master/examples/server'))
  element('voice-manage-key').addEventListener('click', () => {
    selectCredentials(voiceProvider)
    switchTab('connections')
    element('provider-credentials').classList.add('open')
    element('provider-credentials').scrollIntoView({ block: 'center' })
    input(voiceProvider === 'openai' ? 'openai-apikey' : 'audio-apikey').focus()
  })
  const modelDraft = input('chat-model-add')
  const modelStatus = element('chat-models-status')
  async function editModel(action: 'add' | 'remove', id: string) {
    modelStatus.textContent = 'Saving…'
    try {
      const result = await bridge.editChatModels?.(action, id)
      if (!result?.ok) throw new Error(result?.error || 'Could not save models. Restart Bloub after updating.')
      if (action === 'add') modelDraft.value = ''
      modelStatus.textContent = action === 'add' ? 'Model added to the chat menu.' : 'Model removed.'
      renderModels()
    } catch (error) { modelStatus.textContent = error instanceof Error ? error.message : 'Could not save models.' }
  }
  element('chat-model-add-btn').addEventListener('click', () => void editModel('add', modelDraft.value.trim()))
  modelDraft.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void editModel('add', modelDraft.value.trim()) } })
  function renderModels() {
    const chat = getConfig().chat
    const profile = chat?.modelProfiles?.find(p => p.baseUrl.replace(/\/$/, '') === (chat.baseUrl || '').replace(/\/$/, '') && p.protocol === chat.protocol)
    const ids = [...new Set([...(profile?.models || []), chat?.model || ''].filter(Boolean))]
    element('chat-saved-models').replaceChildren(...ids.map(id => {
      const row = document.createElement('div'); row.className = 'row-between'
      const name = document.createElement('span'); name.className = 'hint'; name.textContent = id + (id === chat?.model ? ' · active' : '')
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'k-action-btn'; remove.textContent = 'Remove'; remove.disabled = id === chat?.model
      remove.setAttribute('aria-label', `Remove ${id}`)
      remove.onclick = () => void editModel('remove', id)
      row.append(name, remove); return row
    }))
  }
  function sync() {
    renderModels()
    const cfg = getConfig()
    if (!cfg) return
    const chat = chatProvider(cfg)
    voiceProvider = cfg.audio?.liveProvider === 'openai' ? 'openai' : 'gemini'
    if (!initialized) { selectCredentials(chat === 'custom' ? voiceProvider : chat); initialized = true }
    chatSelect.setValue(chat)
    show('custom-chat-fields', chat === 'custom')
    show('custom-chat-key-row', chat === 'custom')
    element('chat-credential-hint').textContent = chat === 'custom' ? 'This endpoint uses its own key, not your OpenAI or Gemini key.' : `Uses your ${chat === 'openai' ? 'OpenAI' : 'Gemini'} key from Provider keys below.`
    voiceSelect.setValue(voiceProvider)
    const gemini = voiceProvider === 'gemini'
    show('gemini-voice-settings', gemini)
    show('gemini-key-guide', gemini)
    show('openai-voice-note', !gemini)
    show('chat-voice-toggle-slot', gemini)
    element('live-model-description').textContent = gemini ? 'Gemini · 3.1 Flash Live' : 'OpenAI · GPT-Live 1'
    const local = cfg.audio?.transcriptionProvider === 'local'
    transcriptionSelect.setValue(local ? 'local' : 'cloud')
    show('transcription-local-fields', local)
    show('transcription-cloud-description', !local)
    element('transcription-cloud-description').textContent = gemini ? 'Audio is sent to Gemini using the key saved in Connections.' : 'gpt-4o-mini-transcribe · Audio is sent to OpenAI using the key saved in Connections.'
    if (document.activeElement !== input('transcription-local-url')) input('transcription-local-url').value = cfg.audio?.whisperUrl || 'http://127.0.0.1:8080/inference'
    void refreshStatus()
  }
  return { sync }
}
