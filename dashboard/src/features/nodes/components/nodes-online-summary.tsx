import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Globe, Users } from 'lucide-react'
import { orvalFetcher } from '@/service/http'
import { Card, CardContent } from '@/components/ui/card'

type OnlineCount = { users: number; ips: number }
type OnlineSummary = Record<string, OnlineCount>

// Fixed display order + labels; keys match the panel/node naming.
const PROTOCOLS: { key: string; label: string }[] = [
  { key: 'xray', label: 'Xray' },
  { key: 'openvpn', label: 'OpenVPN' },
  { key: 'wg', label: 'WireGuard' },
  { key: 'ikev2', label: 'IKEv2' },
]

// Live per-protocol summary of how many users / distinct source IPs are connected
// right now, summed across every node.
export default function NodesOnlineSummary() {
  const { t } = useTranslation()

  const { data } = useQuery<OnlineSummary>({
    queryKey: ['/api/nodes/online_summary'],
    queryFn: ({ signal }) => orvalFetcher<OnlineSummary>({ url: '/api/nodes/online_summary', method: 'GET', signal }),
    refetchInterval: 7000,
  })

  const shown = PROTOCOLS.filter(p => data && p.key in data)
  if (!shown.length) return null

  const totalUsers = shown.reduce((sum, p) => sum + (data?.[p.key]?.users || 0), 0)
  const totalIps = shown.reduce((sum, p) => sum + (data?.[p.key]?.ips || 0), 0)

  return (
    <Card className="w-full">
      <CardContent className="p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="text-sm font-medium">{t('onlineSummary.title', { defaultValue: 'Online now, by protocol' })}</span>
          <span className="text-xs text-muted-foreground">
            {t('onlineSummary.total', { defaultValue: '{{users}} users · {{ips}} IPs', users: totalUsers, ips: totalIps })}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {shown.map(p => (
            <div key={p.key} className="rounded-lg border bg-muted/30 p-3">
              <div className="mb-1 truncate text-xs font-medium text-muted-foreground">{p.label}</div>
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1 text-sm font-semibold" title={t('onlineSummary.users', { defaultValue: 'users' })}>
                  <Users className="h-3.5 w-3.5 opacity-60" />
                  {data?.[p.key]?.users ?? 0}
                </span>
                <span className="flex items-center gap-1 text-sm font-semibold" title={t('onlineSummary.ips', { defaultValue: 'IP addresses' })}>
                  <Globe className="h-3.5 w-3.5 opacity-60" />
                  {data?.[p.key]?.ips ?? 0}
                </span>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
