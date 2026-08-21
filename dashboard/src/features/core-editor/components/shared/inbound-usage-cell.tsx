import { useTranslation } from 'react-i18next'

import { formatBytes } from '@/utils/formatByte'

import type { InboundUsageWindows } from './use-inbound-usage-totals'

/**
 * An inbound's traffic, shown as today / this week / this month / all time.
 *
 * The total leads because it is the figure an operator scans the column for;
 * the three windows sit under it in one muted line, which is enough to see
 * whether an inbound is still carrying anything without opening a chart.
 */
export function InboundUsageCell({ usage }: { usage?: InboundUsageWindows }) {
  const { t } = useTranslation()

  if (!usage || !usage.total) {
    return <span className="text-muted-foreground text-xs">—</span>
  }

  const windows: [string, number][] = [
    [t('coreEditor.usage.day', { defaultValue: 'today' }), usage.day],
    [t('coreEditor.usage.week', { defaultValue: '7d' }), usage.week],
    [t('coreEditor.usage.month', { defaultValue: '30d' }), usage.month],
  ]

  return (
    <div className="flex flex-col gap-0.5 leading-tight">
      <span dir="ltr" className="font-mono text-xs">
        {String(formatBytes(usage.total, 2))}
      </span>
      <span className="text-muted-foreground flex flex-wrap gap-x-2 text-[10px]">
        {windows.map(([label, value]) => (
          <span key={label} className="whitespace-nowrap">
            {label}{' '}
            <span dir="ltr" className="font-mono">
              {value ? String(formatBytes(value, 1)) : '0'}
            </span>
          </span>
        ))}
      </span>
    </div>
  )
}
