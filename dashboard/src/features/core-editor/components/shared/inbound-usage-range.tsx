import { useCallback, useMemo, useState } from 'react'
import { DateRange } from 'react-day-picker'
import { Calendar } from 'lucide-react'

import TimeSelector, { TRAFFIC_TIME_SELECTOR_SHORTCUTS } from '@/components/charts/time-selector'
import { TimeRangeSelector } from '@/components/common/time-range-selector'
import { getChartQueryRangeFromDateRange, getChartQueryRangeFromShortcut, type TrafficShortcutKey } from '@/utils/chart-period-utils'

export type InboundUsageRange = { start: string; end: string }

/**
 * The window the usage column is measured over.
 *
 * Same shortcuts and custom-range picker the traffic chart uses, so a range
 * means the same thing in both places. Only the bounds matter here — the chart's
 * period control decides bucket width, which a column of one number per inbound
 * has no use for.
 */
export function useInboundUsageRange(defaultShortcut: TrafficShortcutKey = '1w') {
  const [shortcut, setShortcut] = useState<TrafficShortcutKey>(defaultShortcut)
  const [showCustom, setShowCustom] = useState(false)
  const [customRange, setCustomRange] = useState<DateRange | undefined>(undefined)

  const range = useMemo<InboundUsageRange>(() => {
    const query =
      showCustom && customRange?.from && customRange?.to
        ? getChartQueryRangeFromDateRange(customRange, shortcut)
        : getChartQueryRangeFromShortcut(shortcut, new Date())
    return { start: query.startDate, end: query.endDate }
  }, [shortcut, showCustom, customRange])

  const onShortcut = useCallback((value: string) => {
    setShortcut(value as TrafficShortcutKey)
    setShowCustom(false)
    setCustomRange(undefined)
  }, [])

  const onCustomRange = useCallback((next: DateRange | undefined) => {
    setCustomRange(next)
    if (next?.from && next?.to) setShowCustom(true)
  }, [])

  return { range, shortcut, onShortcut, showCustom, setShowCustom, customRange, onCustomRange }
}

type Props = ReturnType<typeof useInboundUsageRange>

/** The control itself: shortcuts plus a toggle for an explicit date range. */
export function InboundUsageRangeSelector({ shortcut, onShortcut, showCustom, setShowCustom, customRange, onCustomRange }: Props) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-2 sm:w-auto">
      <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
        <TimeSelector selectedTime={shortcut} setSelectedTime={onShortcut} shortcuts={TRAFFIC_TIME_SELECTOR_SHORTCUTS} maxVisible={5} className="min-w-0 flex-1 sm:flex-none" />
        <button
          type="button"
          aria-label="Custom Range"
          className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border ${showCustom ? 'bg-muted' : ''}`}
          onClick={() => {
            const next = !showCustom
            setShowCustom(next)
            if (!next) onCustomRange(undefined)
          }}
        >
          <Calendar className="h-4 w-4" />
        </button>
      </div>
      {showCustom && <TimeRangeSelector onRangeChange={onCustomRange} initialRange={customRange} className="w-full" />}
    </div>
  )
}
