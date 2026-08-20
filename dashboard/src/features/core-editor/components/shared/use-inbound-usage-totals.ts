import { useMemo } from 'react'

import { Period } from '@/service/api'
import { useGetInboundUsage } from '@/service/api/inbound-usage'

/**
 * Total recorded traffic per inbound tag (uplink + downlink, all nodes),
 * for the usage column in the core editors' inbound tables.
 *
 * Day-period buckets over the last year: the recording started with the
 * inbound_usages table, so "last year" is effectively "everything", and the
 * complete-bucket rule only drops the empty partial day a year back.
 */
export function useInboundUsageTotals(): Record<string, number> {
  const range = useMemo(() => {
    const end = new Date()
    const start = new Date(end.getTime() - 365 * 24 * 3600 * 1000)
    return { start: start.toISOString(), end: end.toISOString() }
  }, [])

  const { data } = useGetInboundUsage(
    { period: Period.day, start: range.start, end: range.end },
    { query: { staleTime: 60_000, refetchInterval: 5 * 60_000, retry: 1 } },
  )

  return useMemo(() => {
    const totals: Record<string, number> = {}
    for (const [tag, points] of Object.entries(data?.stats ?? {})) {
      totals[tag] = points.reduce((sum, p) => sum + Number(p.uplink || 0) + Number(p.downlink || 0), 0)
    }
    return totals
  }, [data?.stats])
}
