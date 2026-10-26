import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'

interface UsageAlert {
  id: number
  severity: 'info' | 'warning' | 'error'
  message: string
}

// Polls for new usage alerts (key near its cap, key invalid), toasts each one
// once, then acks it so it is not shown again on the next poll or reload.
export function AlertsWatcher() {
  const queryClient = useQueryClient()
  const { data } = useQuery<{ alerts: UsageAlert[] }>({
    queryKey: ['usage-alerts'],
    queryFn: () => apiFetch('/api/alerts'),
    refetchInterval: 60_000,
    retry: false,
  })

  useEffect(() => {
    const alerts = data?.alerts
    if (!alerts || alerts.length === 0) return
    for (const a of alerts) {
      if (a.severity === 'error') toast.error(a.message)
      else toast.info(a.message)
    }
    apiFetch('/api/alerts/ack', { method: 'POST', body: JSON.stringify({ ids: alerts.map(a => a.id) }) })
      .catch(() => {})
      .finally(() => { void queryClient.invalidateQueries({ queryKey: ['usage-alerts'] }) })
  }, [data, queryClient])

  return null
}
