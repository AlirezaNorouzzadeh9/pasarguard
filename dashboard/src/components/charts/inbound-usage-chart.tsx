import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ComponentProps } from 'react'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis, TooltipProps } from 'recharts'
import { DateRange } from 'react-day-picker'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { type ChartConfig, ChartContainer, ChartTooltip } from '@/components/ui/chart'
import { useTranslation } from 'react-i18next'
import useDirDetection from '@/hooks/use-dir-detection'
import { useChartViewType } from '@/hooks/use-chart-view-type'
import { Period, type NodeUsageStat } from '@/service/api'
import { useGetInboundUsage } from '@/service/api/inbound-usage'
import { formatBytes } from '@/utils/formatByte'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from './empty-state'
import { BarChart3, Calendar, Network } from 'lucide-react'
import TimeSelector, { TRAFFIC_TIME_SELECTOR_SHORTCUTS } from './time-selector'
import DenseChartAreaHint from './dense-chart-area-hint'
import PeriodSelector from './period-selector'
import { TimeRangeSelector } from '@/components/common/time-range-selector'
import {
  CHART_PERIOD_OVERRIDE_AUTO,
  type ChartPeriodOverride,
  formatTooltipDate,
  getChartQueryRangeFromShortcut,
  getChartQueryRangeFromDateRange,
  formatPeriodLabelForPeriod,
  getChartXAxisInterval,
  resolvePeriodOverride,
  TrafficShortcutKey,
} from '@/utils/chart-period-utils'
import { getChartRenderFlags } from '@/utils/chart-performance'

type InboundDataPoint = {
  time: string
  _period_start: string
  [key: string]: string | number
}

type BarRadius = [number, number, number, number]
type CellRadiusProps = Partial<ComponentProps<typeof Cell>>

const BAR_RADIUS = 4
const SQUARE_RADIUS: BarRadius = [0, 0, 0, 0]
const GB = 1024 * 1024 * 1024

const getCellRadiusProps = (radius: BarRadius) => ({ radius }) as unknown as CellRadiusProps

// Same distinct-hue rotation the user-counts chart uses, so tag colors stay
// stable per position and readable in both themes.
const getDistinctColor = (index: number) => {
  const hues = [156, 212, 32, 280, 6, 188, 248, 318, 96, 44, 228, 12, 176, 268, 336, 128]
  const hue = hues[index % hues.length]
  const saturation = index % 3 === 0 ? 70 : index % 3 === 1 ? 62 : 78
  const lightness = index % 2 === 0 ? 42 : 52
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`
}

const getStackedBarRadius = (row: InboundDataPoint, tag: string, tags: string[]): BarRadius => {
  const visibleTags = tags.filter(item => Number(row[item] || 0) > 0)
  const visibleIndex = visibleTags.findIndex(item => item === tag)

  if (visibleIndex < 0) return SQUARE_RADIUS
  if (visibleTags.length === 1) return [BAR_RADIUS, BAR_RADIUS, BAR_RADIUS, BAR_RADIUS]

  const isBottomSegment = visibleIndex === 0
  const isTopSegment = visibleIndex === visibleTags.length - 1

  return [isTopSegment ? BAR_RADIUS : 0, isTopSegment ? BAR_RADIUS : 0, isBottomSegment ? BAR_RADIUS : 0, isBottomSegment ? BAR_RADIUS : 0]
}

function InboundTooltip({ active, payload, chartConfig, period }: TooltipProps<number, string> & { chartConfig: ChartConfig; period: Period }) {
  const { t, i18n } = useTranslation()
  if (!active || !payload || !payload.length) return null

  const data = payload[0].payload as InboundDataPoint
  const formattedDate = data._period_start ? formatTooltipDate(data._period_start, period, i18n.language) : String(data.time || '')
  const isRTL = i18n.language === 'fa'

  const rows = Object.keys(data)
    .filter(key => !key.startsWith('_') && key !== 'time' && Number(data[key] || 0) > 0)
    .map(tag => ({ tag, usage: Number(data[tag] || 0) }))
    .sort((a, b) => b.usage - a.usage)

  const total = rows.reduce((sum, row) => sum + row.usage, 0)

  return (
    <div className={`border-border bg-background min-w-[160px] rounded border p-2 text-[11px] shadow ${isRTL ? 'text-right' : 'text-left'}`} dir={isRTL ? 'rtl' : 'ltr'}>
      <div className={`mb-1.5 text-[11px] font-semibold opacity-70 ${isRTL ? 'text-right' : 'text-center'}`}>
        <span dir="ltr" className="inline-block">
          {formattedDate}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {rows.map(row => (
          <div key={row.tag} className={`flex items-center justify-between gap-3 ${isRTL ? 'flex-row-reverse' : ''}`}>
            <span className="flex items-center gap-1.5 truncate">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: (chartConfig[row.tag]?.color as string) || 'hsl(var(--chart-1))' }} />
              <span className="truncate">{row.tag}</span>
            </span>
            <span dir="ltr" className="shrink-0 font-mono">
              {formatBytes(row.usage * GB)}
            </span>
          </div>
        ))}
      </div>
      <div className={`text-muted-foreground mt-1.5 border-t pt-1 ${isRTL ? 'text-right' : 'text-center'}`}>
        <span>{t('statistics.totalUsage', { defaultValue: 'Total' })}: </span>
        <span dir="ltr" className="inline-block font-mono">
          {formatBytes(total * GB)}
        </span>
      </div>
    </div>
  )
}

interface InboundUsageChartProps {
  nodeId?: number
}

export function InboundUsageChart({ nodeId }: InboundUsageChartProps) {
  const [selectedTime, setSelectedTime] = useState<TrafficShortcutKey>('1w')
  const [periodOverride, setPeriodOverride] = useState<ChartPeriodOverride>(CHART_PERIOD_OVERRIDE_AUTO)
  const [showCustomRange, setShowCustomRange] = useState(false)
  const [customRange, setCustomRange] = useState<DateRange | undefined>(undefined)
  const [windowWidth, setWindowWidth] = useState<number>(() => (typeof window !== 'undefined' ? window.innerWidth : 1024))

  const { t, i18n } = useTranslation()
  const dir = useDirDetection()
  const chartViewType = useChartViewType()

  const activeQueryRange = useMemo(() => {
    const periodOptions = { minuteForOneHour: true, periodOverride: resolvePeriodOverride(periodOverride) }

    if (showCustomRange && customRange?.from && customRange?.to) {
      return getChartQueryRangeFromDateRange(customRange, selectedTime, periodOptions)
    }

    return getChartQueryRangeFromShortcut(selectedTime, new Date(), periodOptions)
  }, [showCustomRange, customRange, selectedTime, periodOverride])

  const activePeriod = activeQueryRange.period

  const usageParams = useMemo(
    () => ({
      period: activePeriod,
      start: activeQueryRange.startDate,
      end: activeQueryRange.endDate,
      ...(nodeId !== undefined ? { node_id: nodeId } : {}),
    }),
    [activePeriod, activeQueryRange.startDate, activeQueryRange.endDate, nodeId],
  )

  const {
    data: usageData,
    isLoading,
    error,
  } = useGetInboundUsage(usageParams, {
    query: {
      refetchInterval: 1000 * 60 * 5,
    },
  })

  // Tags ordered by their total traffic in the range, heaviest first — the
  // stack order and legend both follow it.
  const tags = useMemo(() => {
    const totals = Object.entries(usageData?.stats ?? {}).map(([tag, points]) => ({
      tag,
      total: (points as NodeUsageStat[]).reduce((sum, p) => sum + Number(p.uplink || 0) + Number(p.downlink || 0), 0),
    }))
    return totals
      .filter(item => item.total > 0)
      .sort((a, b) => b.total - a.total)
      .map(item => item.tag)
  }, [usageData?.stats])

  const chartConfig = useMemo<ChartConfig>(() => {
    const config: ChartConfig = {}
    tags.forEach((tag, index) => {
      config[tag] = { label: tag, color: getDistinctColor(index) }
    })
    return config
  }, [tags])

  const labelRangeHint = useMemo(
    () => ({
      shortcut: showCustomRange ? undefined : selectedTime,
      customRange: showCustomRange ? customRange : undefined,
    }),
    [customRange, selectedTime, showCustomRange],
  )

  const chartData = useMemo<InboundDataPoint[]>(() => {
    const byPeriod = new Map<string, InboundDataPoint>()
    for (const tag of tags) {
      for (const point of (usageData?.stats?.[tag] ?? []) as NodeUsageStat[]) {
        let row = byPeriod.get(point.period_start)
        if (!row) {
          row = {
            time: formatPeriodLabelForPeriod(point.period_start, activePeriod, i18n.language, labelRangeHint),
            _period_start: point.period_start,
          }
          byPeriod.set(point.period_start, row)
        }
        const usageBytes = Number(point.uplink || 0) + Number(point.downlink || 0)
        row[tag] = parseFloat((usageBytes / GB).toFixed(3))
      }
    }
    return Array.from(byPeriod.values()).sort((a, b) => String(a._period_start).localeCompare(String(b._period_start)))
  }, [usageData?.stats, tags, activePeriod, i18n.language, labelRangeHint])

  const totalUsage = useMemo(() => {
    const total = Object.values(usageData?.stats ?? {})
      .flat()
      .reduce((sum, p) => sum + Number((p as NodeUsageStat).uplink || 0) + Number((p as NodeUsageStat).downlink || 0), 0)
    if (total <= 0) return null
    return String(formatBytes(total, 2))
  }, [usageData?.stats])

  const xAxisInterval = useMemo(
    () =>
      getChartXAxisInterval({
        dataLength: chartData.length,
        period: activePeriod,
        shortcut: selectedTime,
        windowWidth,
        customRange: showCustomRange ? customRange : undefined,
        periodOverride: resolvePeriodOverride(periodOverride),
      }),
    [showCustomRange, customRange, activePeriod, chartData.length, selectedTime, windowWidth, periodOverride],
  )

  const { isAnimationActive, useAccessibilityLayer, areaCurveType } = useMemo(() => getChartRenderFlags(chartData.length), [chartData.length])

  useEffect(() => {
    const handleResize = () => {
      setWindowWidth(window.innerWidth)
    }

    handleResize()
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  const handleTimeSelect = useCallback((value: string) => {
    setSelectedTime(value as TrafficShortcutKey)
    setShowCustomRange(false)
    setCustomRange(undefined)
  }, [])

  const handleCustomRangeChange = useCallback((range: DateRange | undefined) => {
    setCustomRange(range)
    if (range?.from && range?.to) {
      setShowCustomRange(true)
    }
  }, [])

  const axisTickStyle = {
    fill: 'hsl(var(--muted-foreground))',
    fontSize: 8,
    fontWeight: 500,
  }

  return (
    <Card>
      <CardHeader className="flex flex-col items-stretch space-y-0 border-b p-0 xl:flex-row">
        <div className="flex flex-1 flex-col gap-2 border-b px-4 py-3 xl:px-6 xl:py-4">
          <div className="flex min-w-0 flex-col justify-center gap-1 pt-2">
            <CardTitle className="mb-0.5 flex min-w-0 items-center gap-2">
              <Network className="text-muted-foreground h-4 w-4 shrink-0" />
              <span className="truncate">{t('statistics.inboundUsage', { defaultValue: 'Inbound Usage' })}</span>
            </CardTitle>
            <CardDescription className="text-pretty">
              {t('statistics.inboundUsageDescription', { defaultValue: 'Traffic recorded per inbound tag' })}
            </CardDescription>
          </div>
          <div className="flex w-full min-w-0 flex-col gap-2">
            <div className="flex w-full min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <TimeSelector selectedTime={selectedTime} setSelectedTime={handleTimeSelect} shortcuts={TRAFFIC_TIME_SELECTOR_SHORTCUTS} maxVisible={5} className="w-full sm:w-fit" />
              <div className="flex w-full items-center gap-2 sm:w-auto">
                <PeriodSelector value={periodOverride} onValueChange={setPeriodOverride} className="min-w-0 flex-1 sm:w-[7rem] sm:flex-none" />
                <button
                  type="button"
                  aria-label="Custom Range"
                  className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border ${showCustomRange ? 'bg-muted' : ''}`}
                  onClick={() => {
                    const next = !showCustomRange
                    setShowCustomRange(next)
                    if (!next) {
                      setCustomRange(undefined)
                    }
                  }}
                >
                  <Calendar className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
          {showCustomRange && (
            <div className="flex w-full">
              <TimeRangeSelector onRangeChange={handleCustomRangeChange} initialRange={customRange} className="w-full" />
            </div>
          )}
        </div>
        <div className="m-0 flex flex-col justify-center p-4 xl:border-l xl:p-5 xl:px-6">
          <span className="text-muted-foreground text-xs">{t('statistics.usageDuringPeriod')}</span>
          <span dir="ltr" className="text-foreground flex items-center justify-center gap-2 text-base sm:text-lg">
            <BarChart3 className="text-muted-foreground h-4 w-4" />
            {isLoading ? <Skeleton className="h-5 w-20" /> : totalUsage ? totalUsage : <span className="text-muted-foreground">—</span>}
          </span>
        </div>
      </CardHeader>
      <CardContent dir={dir} className="px-4 pt-4 sm:px-6 sm:pt-8">
        {isLoading ? (
          <div className="flex max-h-[300px] min-h-[150px] w-full items-center justify-center sm:max-h-[400px] sm:min-h-[200px]">
            <Skeleton className="h-[250px] w-full sm:h-[300px]" />
          </div>
        ) : error ? (
          <EmptyState type="error" className="max-h-[300px] min-h-[150px] sm:max-h-[400px] sm:min-h-[200px]" />
        ) : (
          <div className="mx-auto w-full max-w-7xl">
            <DenseChartAreaHint pointCount={chartData.length} />
            <ChartContainer dir="ltr" config={chartConfig} className="h-[200px] w-full overflow-x-auto sm:h-[320px] lg:h-[400px]">
              {chartData.length > 0 && tags.length > 0 ? (
                chartViewType === 'area' ? (
                  <AreaChart {...(useAccessibilityLayer ? { accessibilityLayer: true } : {})} data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                    <CartesianGrid direction="ltr" vertical={false} />
                    <XAxis direction="ltr" dataKey="time" tickLine={false} tickMargin={8} axisLine={false} interval={xAxisInterval} tick={axisTickStyle} minTickGap={28} />
                    <YAxis
                      direction="ltr"
                      tickLine={false}
                      axisLine={false}
                      domain={[0, 'auto']}
                      tickFormatter={value => formatBytes(Number(value || 0) * GB, 0, true).toString()}
                      tick={axisTickStyle}
                      width={28}
                      tickMargin={2}
                    />
                    <ChartTooltip cursor={false} content={props => <InboundTooltip {...(props as TooltipProps<number, string>)} chartConfig={chartConfig} period={activePeriod} />} />
                    {tags.map(tag => (
                      <Area
                        key={tag}
                        dataKey={tag}
                        stackId="inbounds"
                        type={areaCurveType}
                        fill={chartConfig[tag]?.color as string}
                        fillOpacity={0.28}
                        stroke={chartConfig[tag]?.color as string}
                        strokeWidth={1.5}
                        dot={false}
                        activeDot={false}
                        isAnimationActive={isAnimationActive}
                      />
                    ))}
                  </AreaChart>
                ) : (
                  <BarChart {...(useAccessibilityLayer ? { accessibilityLayer: true } : {})} data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                    <CartesianGrid direction="ltr" vertical={false} />
                    <XAxis direction="ltr" dataKey="time" tickLine={false} tickMargin={8} axisLine={false} interval={xAxisInterval} tick={axisTickStyle} minTickGap={28} />
                    <YAxis
                      direction="ltr"
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={value => formatBytes(Number(value || 0) * GB, 0, true).toString()}
                      tick={axisTickStyle}
                      width={28}
                      tickMargin={2}
                    />
                    <ChartTooltip cursor={false} content={props => <InboundTooltip {...(props as TooltipProps<number, string>)} chartConfig={chartConfig} period={activePeriod} />} />
                    {tags.map(tag => (
                      <Bar key={tag} dataKey={tag} stackId="inbounds" fill={chartConfig[tag]?.color as string} isAnimationActive={isAnimationActive}>
                        {chartData.map(row => (
                          <Cell key={`${tag}-${row._period_start}`} {...getCellRadiusProps(getStackedBarRadius(row, tag, tags))} />
                        ))}
                      </Bar>
                    ))}
                  </BarChart>
                )
              ) : (
                <EmptyState
                  type="no-data"
                  title={t('statistics.noDataInRange')}
                  description={t('statistics.noDataInRangeDescription')}
                  className="max-h-[300px] min-h-[150px] sm:max-h-[400px] sm:min-h-[200px]"
                />
              )}
            </ChartContainer>
            {tags.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5">
                {tags.map(tag => (
                  <span key={tag} className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: chartConfig[tag]?.color as string }} />
                    <span dir="ltr">{tag}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
