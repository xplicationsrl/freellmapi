import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ModelCombobox } from '@/components/model-combobox'
import { Switch } from '@/components/ui/switch'
import { MemorySection } from '@/components/playground/memory-section'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { buildModelOptions } from '@/lib/model-groups'
import { usePlaygroundPrefs } from '@/lib/playground-prefs'
import {
  createMemory,
  deleteMemory,
  listMemories,
  type Memory,
} from '@/lib/playground-memories'
import {
  SAMPLING_FIELDS,
  SAMPLING_RANGES,
  formatSamplingValue,
  setSamplingEnabled,
  setSamplingValue,
  type SamplingField,
  type SamplingSettings,
} from '@/lib/playground-sampling'
import { engineChain, type SearchEngine } from '@/lib/search'
import { toast } from '@/lib/toast'
import {
  hasTranscription,
  transcriptionOptions,
  type TranscriptionModelRow,
} from '@/lib/transcription'
import type { Chain } from '@/components/chain-manager'

interface FallbackEntry {
  modelDbId: number
  priority: number
  enabled: boolean
  platform: string
  modelId: string
  canonicalId?: string
  displayName: string
  sizeLabel: string
  intelligenceRank: number
  supportsVision: boolean
  keyCount: number
}

const FIELD_LABEL_KEYS: Record<SamplingField, string> = {
  temperature: 'playground.temperature',
  topP: 'playground.topP',
  maxTokens: 'playground.maxTokens',
}

function SamplingControlRow({
  field,
  settings,
  onChange,
}: {
  field: SamplingField
  settings: SamplingSettings
  onChange: (next: SamplingSettings) => void
}) {
  const { t } = useI18n()
  const range = SAMPLING_RANGES[field]
  const control = settings[field]
  const label = t(FIELD_LABEL_KEYS[field])

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <label
          htmlFor={`playground-sampling-${field}`}
          className={`flex-1 truncate text-xs font-medium transition-colors ${
            control.enabled ? '' : 'text-muted-foreground'
          }`}
        >
          {label}
        </label>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {control.enabled
            ? formatSamplingValue(field, control.value)
            : t('playground.samplingDefault')}
        </span>
        <Switch
          size="sm"
          aria-label={label}
          checked={control.enabled}
          onCheckedChange={enabled => onChange(setSamplingEnabled(settings, field, enabled))}
        />
      </div>
      {field === 'maxTokens' ? (
        <input
          id={`playground-sampling-${field}`}
          type="number"
          inputMode="numeric"
          min={range.min}
          max={range.max}
          step={range.step}
          disabled={!control.enabled}
          value={control.value}
          onChange={e => onChange(setSamplingValue(settings, field, Number(e.target.value)))}
          aria-label={label}
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 font-mono text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
        />
      ) : (
        <input
          id={`playground-sampling-${field}`}
          type="range"
          min={range.min}
          max={range.max}
          step={range.step}
          disabled={!control.enabled}
          value={control.value}
          onChange={e => onChange(setSamplingValue(settings, field, Number(e.target.value)))}
          aria-label={label}
          className="w-full cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
        />
      )}
    </div>
  )
}

/** Playground knobs that used to live in the right-hand rail — now a Settings section. */
export function PlaygroundSettingsPanel() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const {
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
  } = usePlaygroundPrefs()

  const { data: memories = [] } = useQuery<Memory[]>({
    queryKey: ['playground-memories'],
    queryFn: listMemories,
  })
  const { data: mediaData } = useQuery<{ models: TranscriptionModelRow[] }>({
    queryKey: ['media'],
    queryFn: () => apiFetch('/api/media'),
  })
  const { data: searchEngines = [] } = useQuery<SearchEngine[]>({
    queryKey: ['search-engines'],
    queryFn: () => apiFetch('/api/search/engines'),
    retry: false,
  })
  const { data: fallbackEntries = [] } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })
  const { data: chains = [] } = useQuery<Chain[]>({
    queryKey: ['profiles'],
    queryFn: () => apiFetch('/api/profiles'),
  })

  const mediaModels = mediaData?.models ?? []
  const usableEngines = engineChain(searchEngines).filter(e => e.keyCount > 0)
  const webSearchAvailable = usableEngines.length > 0
  const transcriptionAvailable = hasTranscription(mediaModels)
  const dictationOptions = transcriptionOptions(mediaModels, t('playground.autoModel'))
  const availableModels = fallbackEntries.filter(e => e.keyCount > 0 && e.enabled)
  const modelOptions = buildModelOptions(availableModels, true)
  const chainOptions = chains
    .filter(c => c.type === 'custom')
    .map(c => ({
      value: `auto:${c.name.toLowerCase()}`,
      label: c.emoji ? `${c.emoji} ${c.name}` : c.name,
      sub: `auto:${c.name.toLowerCase()}`,
      isNew: false,
      platforms: [] as string[],
    }))
  const pickerOptions = [
    { value: 'auto', label: t('playground.autoModel'), sub: '', isNew: false, platforms: [] as string[] },
    { value: 'fusion', label: t('playground.fusionModel'), sub: '', isNew: false, platforms: [] as string[] },
    ...chainOptions,
    ...modelOptions,
  ]

  const addMemory = async (content: string) => {
    try {
      await createMemory(content)
      queryClient.invalidateQueries({ queryKey: ['playground-memories'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('playground.memorySaveFailed'))
      throw err
    }
  }

  const removeMemory = async (id: number) => {
    try {
      await deleteMemory(id)
      queryClient.invalidateQueries({ queryKey: ['playground-memories'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('playground.memoryDeleteFailed'))
      throw err
    }
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <span className="block text-xs font-medium">{t('common.model')}</span>
        <ModelCombobox
          value={selectedModel}
          options={pickerOptions}
          onSelect={setSelectedModel}
          ariaLabel={t('playground.selectModel')}
          placeholder={t('playground.searchModels')}
          emptyText={t('playground.noModelsFound')}
          align="start"
          triggerClassName="flex h-8 w-full items-center justify-between gap-2 whitespace-nowrap rounded-lg border border-input bg-transparent px-3 text-sm outline-none transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          footer={
            availableModels.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">{t('playground.noModels')}</div>
            ) : undefined
          }
        />
      </div>

      <div className="space-y-1.5">
        <span className="block text-xs font-medium">{t('playground.dictationModel')}</span>
        {!transcriptionAvailable ? (
          <p className="text-xs text-muted-foreground">{t('playground.dictationUnavailable')}</p>
        ) : (
          <ModelCombobox
            value={dictationChoice}
            options={dictationOptions}
            onSelect={setDictationChoice}
            ariaLabel={t('playground.dictationModel')}
            placeholder={t('playground.searchModels')}
            emptyText={t('playground.noModelsFound')}
            align="start"
            triggerClassName="flex h-8 w-full items-center justify-between gap-2 whitespace-nowrap rounded-lg border border-input bg-transparent px-3 text-sm outline-none transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          />
        )}
      </div>

      <div className="space-y-1.5">
        <label htmlFor="playground-system-prompt" className="flex items-center gap-1.5 text-xs font-medium">
          {t('playground.systemPromptLabel')}
          {systemPrompt.trim() && <span className="size-1.5 rounded-full bg-primary/70" />}
        </label>
        <textarea
          id="playground-system-prompt"
          value={systemPrompt}
          onChange={e => setSystemPrompt(e.target.value)}
          placeholder={t('playground.systemPromptPlaceholder')}
          rows={4}
          className="max-h-64 min-h-[88px] w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
        />
      </div>

      <div className="space-y-3">
        <div className="space-y-0.5">
          <span className="block text-xs font-medium">{t('playground.samplingHeading')}</span>
          <p className="text-[11px] leading-snug text-muted-foreground">
            {t('playground.samplingHelp')}
          </p>
        </div>
        {SAMPLING_FIELDS.map(field => (
          <SamplingControlRow
            key={field}
            field={field}
            settings={sampling}
            onChange={setSampling}
          />
        ))}
      </div>

      <div className="space-y-2">
        <div className="space-y-0.5">
          <span className="block text-xs font-medium">{t('search.playgroundHeading')}</span>
          <p className="text-[11px] leading-snug text-muted-foreground">
            {webSearchAvailable ? t('search.playgroundHelp') : t('search.playgroundNoKeys')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="playground-web-search" className="flex-1 text-xs">
            {t('search.playgroundToggle')}
          </label>
          <Switch
            id="playground-web-search"
            size="sm"
            checked={webSearch && webSearchAvailable}
            onCheckedChange={setWebSearch}
            disabled={!webSearchAvailable}
          />
        </div>
        {webSearchAvailable && usableEngines.length > 0 && (
          <p className="text-[11px] text-muted-foreground">
            {t('search.playgroundEngines', {
              chain: usableEngines.map(e => e.displayName).join(' → '),
            })}
          </p>
        )}
      </div>

      <MemorySection
        enabled={memoryEnabled}
        onEnabledChange={setMemoryEnabled}
        memories={memories}
        onAdd={addMemory}
        onDelete={removeMemory}
      />
    </div>
  )
}
