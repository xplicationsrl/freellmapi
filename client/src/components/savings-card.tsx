import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

interface SavingsData {
  lifetimeUsd: number
  monthToDateUsd: number
  since: string | null
}

const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// What the traffic served so far would have cost on paid APIs. Hidden until
// the first priced request so a fresh install shows no "$0.00 saved".
export function SavingsCard() {
  const { data } = useQuery<SavingsData>({
    queryKey: ['analytics', 'savings'],
    queryFn: () => apiFetch('/api/analytics/savings'),
    staleTime: 30_000,
  })
  if (!data || data.lifetimeUsd <= 0) return null

  return (
    <section className="rounded-3xl border bg-card p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">Saved vs paid APIs</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {usd(data.lifetimeUsd)} all time{data.since ? ` (since ${data.since})` : ''}
        </span>
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums">
        {usd(data.monthToDateUsd)}
        <span className="ms-2 text-xs font-normal text-muted-foreground">this month</span>
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Estimate: successful requests priced at each model&apos;s paid-API rate.
      </p>
    </section>
  )
}
