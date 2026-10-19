import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  readSampling,
  writeSampling,
  type SamplingSettings,
} from '@/lib/playground-sampling'
import { readMemoryEnabled, writeMemoryEnabled } from '@/lib/playground-memories'
import { DICTATION_AUTO, DICTATION_MODEL_STORAGE_KEY } from '@/lib/transcription'

export interface PlaygroundPrefs {
  systemPrompt: string
  setSystemPrompt: (value: string) => void
  sampling: SamplingSettings
  setSampling: (next: SamplingSettings) => void
  webSearch: boolean
  setWebSearch: (enabled: boolean) => void
  memoryEnabled: boolean
  setMemoryEnabled: (enabled: boolean) => void
  selectedModel: string
  setSelectedModel: (value: string) => void
  dictationChoice: string
  setDictationChoice: (value: string) => void
}

const PlaygroundPrefsContext = createContext<PlaygroundPrefs | null>(null)

export function PlaygroundPrefsProvider({ children }: { children: ReactNode }) {
  const [systemPrompt, setSystemPromptState] = useState(
    () => localStorage.getItem('playground.systemPrompt') ?? '',
  )
  const [sampling, setSamplingState] = useState<SamplingSettings>(() => readSampling())
  const [webSearch, setWebSearchState] = useState(
    () => localStorage.getItem('playground.webSearch') === '1',
  )
  const [memoryEnabled, setMemoryEnabledState] = useState(() => readMemoryEnabled())
  const [selectedModel, setSelectedModelState] = useState(
    () => localStorage.getItem('playground.model') ?? 'auto',
  )
  const [dictationChoice, setDictationChoiceState] = useState(
    () => localStorage.getItem(DICTATION_MODEL_STORAGE_KEY) ?? DICTATION_AUTO,
  )

  const setSystemPrompt = useCallback((value: string) => {
    setSystemPromptState(value)
    localStorage.setItem('playground.systemPrompt', value)
  }, [])

  const setSampling = useCallback((next: SamplingSettings) => {
    setSamplingState(next)
    writeSampling(next)
  }, [])

  const setWebSearch = useCallback((enabled: boolean) => {
    setWebSearchState(enabled)
    localStorage.setItem('playground.webSearch', enabled ? '1' : '0')
  }, [])

  const setMemoryEnabled = useCallback((enabled: boolean) => {
    setMemoryEnabledState(enabled)
    writeMemoryEnabled(enabled)
  }, [])

  const setSelectedModel = useCallback((value: string) => {
    setSelectedModelState(value)
    localStorage.setItem('playground.model', value)
  }, [])

  const setDictationChoice = useCallback((value: string) => {
    setDictationChoiceState(value)
    localStorage.setItem(DICTATION_MODEL_STORAGE_KEY, value)
  }, [])

  const value = useMemo(
    () => ({
      systemPrompt,
      setSystemPrompt,
      sampling,
      setSampling,
      webSearch,
      setWebSearch,
      memoryEnabled,
      setMemoryEnabled,
      selectedModel,
      setSelectedModel,
      dictationChoice,
      setDictationChoice,
    }),
    [
      systemPrompt,
      setSystemPrompt,
      sampling,
      setSampling,
      webSearch,
      setWebSearch,
      memoryEnabled,
      setMemoryEnabled,
      selectedModel,
      setSelectedModel,
      dictationChoice,
      setDictationChoice,
    ],
  )

  return (
    <PlaygroundPrefsContext.Provider value={value}>
      {children}
    </PlaygroundPrefsContext.Provider>
  )
}

export function usePlaygroundPrefs(): PlaygroundPrefs {
  const ctx = useContext(PlaygroundPrefsContext)
  if (!ctx) {
    throw new Error('usePlaygroundPrefs must be used within PlaygroundPrefsProvider')
  }
  return ctx
}
