import { useMemo } from 'react'

import { Period } from '@/service/api'
import { useGetInboundUsage } from '@/service/api/inbound-usage'

import type { InboundUsageRange } from './inbound-usage-range'

/**
 * Traffic per inbound tag over a window, in bytes.
 *
 * The endpoint buckets by period and this only ever wants the sum, so the
 * coarsest bucket that still fits the window is asked for: a year of daily rows
 * to add up is wasteful when one row would do. Hour buckets keep short windows
 * honest — a day bucket would drag in traffic from before a "last 6 hours".
 */
export function useInboundUsageTotals(range: InboundUsageRange): Record<string, number> {
  const period = useMemo(() => {
    const spanHours = (new Date(range.end).getTime() - new Date(range.start).getTime()) / 3_600_000
    if (spanHours <= 72) return Period.hour
    if (spanHours <= 24 * 90) return Period.day
    return Period.month
  }, [range.start, range.end])

  const { data } = useGetInboundUsage(
    { period, start: range.start, end: range.end },
    { query: { staleTime: 60_000, refetchInterval: 5 * 60_000, retry: 1 } },
  )

  return useMemo(() => {
    const totals: Record<string, number> = {}
    for (const [tag, points] of Object.entries(data?.stats ?? {})) {
      totals[tag] = points.reduce((sum, point) => sum + Number(point.uplink || 0) + Number(point.downlink || 0), 0)
    }
    return totals
  }, [data?.stats])
}
