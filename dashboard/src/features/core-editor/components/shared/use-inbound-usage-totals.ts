import { useMemo } from 'react'

import { Period } from '@/service/api'
import { useGetInboundUsage } from '@/service/api/inbound-usage'
import { formatOffsetDateTime, formatOffsetStartOfDay } from '@/utils/dateTimeParsing'

/** How much an inbound has carried over each window, in bytes. */
export type InboundUsageWindows = {
  day: number
  week: number
  month: number
  total: number
}

export type InboundUsageWindow = keyof InboundUsageWindows

/** The windows in the order the selector offers them. */
export const INBOUND_USAGE_WINDOWS: InboundUsageWindow[] = ['day', 'week', 'month', 'total']

const DAY_MS = 24 * 3600 * 1000
const EMPTY: InboundUsageWindows = { day: 0, week: 0, month: 0, total: 0 }

/**
 * Traffic per inbound tag, split into today / last 7 days / last 30 days / all.
 *
 * One request covers all four: the endpoint returns daily buckets, and the
 * windows are sums over suffixes of that series. Asking it four times would be
 * four scans of the same rows for numbers already in hand.
 *
 * The range is sent with the browser's offset so the server buckets by the
 * viewer's days — "today" has to mean their today, not UTC's. A year back is
 * effectively everything, since recording began with the inbound_usages table.
 */
export function useInboundUsageTotals(): Record<string, InboundUsageWindows> {
  const range = useMemo(() => {
    const now = new Date()
    return {
      // From the start of the day a year ago, so every bucket in between is whole.
      start: formatOffsetStartOfDay(new Date(now.getTime() - 365 * DAY_MS)),
      end: formatOffsetDateTime(now),
    }
  }, [])

  const { data } = useGetInboundUsage(
    { period: Period.day, start: range.start, end: range.end },
    { query: { staleTime: 60_000, refetchInterval: 5 * 60_000, retry: 1 } },
  )

  return useMemo(() => {
    const startOfToday = new Date()
    startOfToday.setHours(0, 0, 0, 0)
    const dayFrom = startOfToday.getTime()
    const weekFrom = dayFrom - 6 * DAY_MS // today plus the six before it
    const monthFrom = dayFrom - 29 * DAY_MS

    const totals: Record<string, InboundUsageWindows> = {}
    for (const [tag, points] of Object.entries(data?.stats ?? {})) {
      const windows: InboundUsageWindows = { ...EMPTY }
      for (const point of points) {
        const bytes = Number(point.uplink || 0) + Number(point.downlink || 0)
        if (!bytes) continue
        const at = new Date(point.period_start).getTime()
        windows.total += bytes
        if (at >= monthFrom) windows.month += bytes
        if (at >= weekFrom) windows.week += bytes
        if (at >= dayFrom) windows.day += bytes
      }
      totals[tag] = windows
    }
    return totals
  }, [data?.stats])
}
