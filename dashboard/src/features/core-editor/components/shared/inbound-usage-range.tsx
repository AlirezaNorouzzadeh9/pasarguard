import { useCallback, useMemo, useState } from 'react'
import { DateRange } from 'react-day-picker'
import { CalendarRange } from 'lucide-react'

import TimeSelector, { TRAFFIC_TIME_SELECTOR_SHORTCUTS } from '@/components/charts/time-selector'
import { TimeRangeSelector } from '@/components/common/time-range-selector'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { getChartQueryRangeFromDateRange, getChartQueryRangeFromShortcut, type TrafficShortcutKey } from '@/utils/chart-period-utils'

export type InboundUsageRange = { start: string; end: string }

/**
 * The window the usage column is measured over.
 *
 * Same shortcuts and custom-range picker the traffic chart uses, so a range
 * means the same thing in both places. Only the bounds matter here — the
 * chart's period control decides bucket width, which a column of one number
 * per inbound has no use for.
 */
export function useInboundUsageRange(defaultShortcut: TrafficShortcutKey = '1w') {
  const [shortcut, setShortcut] = useState<TrafficShortcutKey>(defaultShortcut)
  const [customRange, setCustomRange] = useState<DateRange | undefined>(undefined)

  const hasCustom = Boolean(customRange?.from && customRange?.to)

  const range = useMemo<InboundUsageRange>(() => {
    const query =
      hasCustom && customRange ? getChartQueryRangeFromDateRange(customRange, shortcut) : getChartQueryRangeFromShortcut(shortcut, new Date())
    return { start: query.startDate, end: query.endDate }
  }, [shortcut, hasCustom, customRange])

  // Picking a shortcut drops any custom range: the two are the same control
  // expressed two ways, and leaving both set makes the shortcut look ignored.
  const onShortcut = useCallback((value: string) => {
    setShortcut(value as TrafficShortcutKey)
    setCustomRange(undefined)
  }, [])

  const onCustomRange = useCallback((next: DateRange | undefined) => setCustomRange(next), [])

  return { range, shortcut, onShortcut, customRange, hasCustom, onCustomRange }
}

type Props = ReturnType<typeof useInboundUsageRange>

/**
 * Shortcuts, plus a calendar button for an explicit range.
 *
 * The calendar lives in a popover rather than expanding in place: two months of
 * day grid is taller than the table it sits above, and inline it covered the
 * very rows the range was being chosen for.
 */
export function InboundUsageRangeSelector({ shortcut, onShortcut, customRange, hasCustom, onCustomRange }: Props) {
  const [open, setOpen] = useState(false)

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <TimeSelector
        selectedTime={hasCustom ? '' : shortcut}
        setSelectedTime={onShortcut}
        shortcuts={TRAFFIC_TIME_SELECTOR_SHORTCUTS}
        // These shortcuts carry their own `quick` flags, which is what decides
        // the visible set; this only matters if that ever stops being true.
        maxVisible={5}
        className="min-w-0"
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Custom range"
            className={cn(
              'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors',
              hasCustom ? 'border-primary text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <CalendarRange className="h-4 w-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-auto p-3">
          <TimeRangeSelector
            initialRange={customRange}
            onRangeChange={next => {
              onCustomRange(next)
              // Close once both ends are chosen; a half-made range stays open.
              if (next?.from && next?.to) setOpen(false)
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}
