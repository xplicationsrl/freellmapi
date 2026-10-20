import type { LucideIcon } from 'lucide-react'

export interface StarterPrompt {
  id: string
  icon: LucideIcon
  /** Short chip text. */
  label: string
  /** Text placed in the composer when the chip is picked. */
  prompt: string
}

// Suggestions on the empty chat. Picking one fills the composer instead of
// sending: each prompt is the start of a request ("Summarize this text: "),
// and the person still has to add the part only they have.
export function StarterPrompts({ items, onPick }: { items: StarterPrompt[]; onPick: (prompt: string) => void }) {
  return (
    <div className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-2">
      {items.map(({ id, icon: Icon, label, prompt }) => (
        <button
          key={id}
          type="button"
          onClick={() => onPick(prompt)}
          className="flex items-center gap-2.5 rounded-xl border bg-card px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0">{label}</span>
        </button>
      ))}
    </div>
  )
}
