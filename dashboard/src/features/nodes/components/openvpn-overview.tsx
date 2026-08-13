import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { subnetCapacity } from '@/features/core-editor/kit/openvpn-subnet'
import useDirDetection from '@/hooks/use-dir-detection'
import { cn } from '@/lib/utils'
import { useGetAllCores, type CoreResponse } from '@/service/api'
import { $fetch } from '@/service/http'
import { useQuery } from '@tanstack/react-query'
import { Check, Copy, Download, ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

/** What /api/openvpn/ca returns. ca_key is deliberately never exposed. */
interface CaInfo {
  ca_cert?: string | null
  common_name?: string | null
  serial?: string | null
  fingerprint?: string | null
  not_before?: string | null
  not_after?: string | null
  expired?: boolean | null
  tls_crypt_key_present?: boolean | null
  client_cert_validity_days?: number | null
}

interface Listener {
  port?: number
  proto?: string
}

/** Below this, the CA is close enough that it should look different. */
const EXPIRY_WARNING_DAYS = 30

const formatDate = (value?: string | null) => {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString()
}

const daysUntil = (value?: string | null): number | null => {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return Math.round((d.getTime() - Date.now()) / 86400000)
}

/** How much of the CA's life has been used, for the bar under the header. */
const lifeElapsedPercent = (from?: string | null, to?: string | null): number | null => {
  if (!from || !to) return null
  const start = new Date(from).getTime()
  const end = new Date(to).getTime()
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null
  return Math.min(100, Math.max(0, ((Date.now() - start) / (end - start)) * 100))
}

function Tile({ label, children, tone }: { label: string; children: React.ReactNode; tone?: 'danger' | 'warning' }) {
  return (
    <div
      className={cn(
        'bg-muted/30 min-w-0 rounded-md border px-3 py-2',
        tone === 'danger' && 'border-destructive/30 bg-destructive/10',
        tone === 'warning' && 'border-amber-500/30 bg-amber-500/10',
      )}
    >
      <div className="text-muted-foreground text-start text-[11px] font-medium tracking-wide uppercase">{label}</div>
      <div
        className={cn(
          'mt-1 truncate text-start font-mono text-sm',
          tone === 'danger' ? 'text-destructive' : tone === 'warning' ? 'text-amber-600 dark:text-amber-400' : 'text-foreground',
        )}
      >
        {children}
      </div>
    </div>
  )
}

/** A fingerprint that is cut off is not worth reading, so it can be copied. */
function CopyableValue({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error(t('copyFailed', { defaultValue: 'Could not copy' }))
    }
  }

  return (
    <div className="bg-muted/30 min-w-0 rounded-md border px-3 py-2">
      <div className="text-muted-foreground text-start text-[11px] font-medium tracking-wide uppercase">{label}</div>
      <div className="mt-1 flex items-start gap-2">
        <code dir="ltr" className="min-w-0 flex-1 font-mono text-xs break-all">
          {value}
        </code>
        <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={copy} aria-label={t('copy', { defaultValue: 'Copy' })}>
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  )
}

export default function OpenVPNOverview() {
  const { t } = useTranslation()
  const dir = useDirDetection()

  const { data: ca, isLoading: caLoading } = useQuery({
    queryKey: ['openvpn', 'ca'],
    queryFn: () => $fetch<CaInfo>('/api/openvpn/ca'),
    retry: false,
  })
  const { data: cores, isLoading: coresLoading } = useGetAllCores()

  const openvpnCores = (cores?.cores ?? []).filter((core: CoreResponse) => core.type === 'openvpn')
  const caExpiresIn = daysUntil(ca?.not_after)
  const elapsed = lifeElapsedPercent(ca?.not_before, ca?.not_after)

  if (caLoading || coresLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  // No CA yet means no OpenVPN core has ever been saved — the material is
  // minted on first save, so there is nothing to show and nothing wrong.
  if (!ca?.ca_cert) {
    return (
      <Card className="flex flex-col items-center gap-3 px-4 py-12 text-center">
        <ShieldCheck className="text-muted-foreground/50 h-10 w-10" />
        <p className="text-muted-foreground max-w-md text-sm">
          {t('nodes.openvpn.noCa', {
            defaultValue: 'No OpenVPN certificate authority yet. It is created automatically with your first OpenVPN core.',
          })}
        </p>
      </Card>
    )
  }

  const expired = Boolean(ca.expired)
  const expiringSoon = !expired && caExpiresIn !== null && caExpiresIn <= EXPIRY_WARNING_DAYS
  const tone = expired ? 'danger' : expiringSoon ? 'warning' : undefined
  const StatusIcon = expired ? ShieldX : expiringSoon ? ShieldAlert : ShieldCheck

  return (
    <div className="flex flex-col gap-4" dir={dir}>
      <Card className={cn('px-4 py-4', expired && 'border-destructive/40', expiringSoon && 'border-amber-500/40')}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-center gap-2.5">
            <StatusIcon
              className={cn('h-5 w-5 shrink-0', expired ? 'text-destructive' : expiringSoon ? 'text-amber-500' : 'text-emerald-500')}
            />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">{t('nodes.openvpn.ca', { defaultValue: 'Certificate authority' })}</h3>
              <p className="text-muted-foreground truncate text-xs">
                {/* Every client certificate is signed by this one, so its expiry
                    is the whole deployment's expiry — worth stating rather than
                    leaving as a date to work out. */}
                {expired
                  ? t('nodes.openvpn.expiredNote', { defaultValue: 'Clients cannot connect until it is replaced.' })
                  : t('nodes.openvpn.signsAll', { defaultValue: 'Signs every client certificate this panel issues.' })}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Badge variant={expired ? 'destructive' : 'secondary'} className={cn(expiringSoon && 'border-amber-500/40 bg-amber-500/15 text-amber-600 dark:text-amber-400')}>
              {expired
                ? t('nodes.openvpn.expired', { defaultValue: 'Expired' })
                : caExpiresIn !== null
                  ? t('nodes.openvpn.expiresIn', { defaultValue: '{{days}} days left', days: caExpiresIn })
                  : t('nodes.openvpn.valid', { defaultValue: 'Valid' })}
            </Badge>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const blob = new Blob([ca.ca_cert ?? ''], { type: 'application/x-pem-file' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = 'pasarguard-openvpn-ca.crt'
                a.click()
                URL.revokeObjectURL(url)
              }}
            >
              <Download className="me-1 h-3.5 w-3.5" />
              {t('nodes.openvpn.exportCa', { defaultValue: 'Export CA' })}
            </Button>
          </div>
        </div>

        {elapsed !== null && (
          <div className="mt-4">
            <Progress
              value={elapsed}
              className="h-1.5"
              indicatorClassName={expired ? 'bg-destructive' : expiringSoon ? 'bg-amber-500' : undefined}
            />
            <div className="text-muted-foreground mt-1.5 flex justify-between text-[11px] tabular-nums" dir="ltr">
              <span>{formatDate(ca.not_before)}</span>
              <span>{formatDate(ca.not_after)}</span>
            </div>
          </div>
        )}

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Tile label={t('nodes.openvpn.commonName', { defaultValue: 'Common name' })}>{ca.common_name ?? '—'}</Tile>
          <Tile label={t('nodes.openvpn.clientValidity', { defaultValue: 'Client cert validity' })}>
            {ca.client_cert_validity_days
              ? t('nodes.openvpn.days', { defaultValue: '{{days}} days', days: ca.client_cert_validity_days })
              : '—'}
          </Tile>
          {/* Without it the node cannot start, so its absence is a fault, not a setting. */}
          <Tile
            label={t('nodes.openvpn.tlsCrypt', { defaultValue: 'tls-crypt key' })}
            tone={ca.tls_crypt_key_present ? undefined : 'danger'}
          >
            {ca.tls_crypt_key_present
              ? t('nodes.openvpn.present', { defaultValue: 'present' })
              : t('nodes.openvpn.missing', { defaultValue: 'missing' })}
          </Tile>
        </div>

        {ca.fingerprint && (
          <div className="mt-3">
            <CopyableValue value={ca.fingerprint} label={t('nodes.openvpn.fingerprint', { defaultValue: 'Fingerprint' })} />
          </div>
        )}
      </Card>

      <div className="flex items-center justify-between gap-2 px-1">
        <h3 className="text-sm font-semibold">
          {t('nodes.openvpn.cores', { defaultValue: 'OpenVPN cores' })}
          <span className="text-muted-foreground ms-2 text-xs font-normal">{openvpnCores.length}</span>
        </h3>
      </div>

      {openvpnCores.length === 0 ? (
        <Card className="text-muted-foreground px-4 py-10 text-center text-sm">
          {t('nodes.openvpn.noCores', { defaultValue: 'No OpenVPN cores.' })}
        </Card>
      ) : (
        openvpnCores.map((core: CoreResponse) => {
          const config = (core.config ?? {}) as Record<string, unknown>
          // A core without an explicit list serves exactly one endpoint, built
          // from its own port and protocol.
          const listeners = (config.listeners as Listener[] | undefined)?.length
            ? (config.listeners as Listener[])
            : [{ port: config.port as number | undefined, proto: config.proto as string | undefined }]
          const subnet = String(config.server_subnet ?? '')
          const capacity = subnetCapacity(subnet, listeners.length)

          return (
            <Card key={core.id} className="px-4 py-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-sm font-medium">{core.name}</h4>
                {config.inbound_tag ? (
                  <Badge variant="secondary" className="font-mono text-[10px]">
                    {String(config.inbound_tag)}
                  </Badge>
                ) : null}
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Tile label={t('nodes.openvpn.subnet', { defaultValue: 'Client subnet' })}>{subnet || '—'}</Tile>
                <Tile label={t('nodes.openvpn.cipher', { defaultValue: 'Cipher' })}>{String(config.cipher ?? '—')}</Tile>
                {/* One server process per listener, so this is how many the node runs. */}
                <Tile
                  label={t('nodes.openvpn.perListener', { defaultValue: 'Per listener' })}
                  tone={capacity?.tooSmall ? 'danger' : undefined}
                >
                  {capacity ? `/${capacity.perListener}` : '—'}
                </Tile>
              </div>

              <div className="mt-3">
                <div className="text-muted-foreground mb-1.5 text-[11px] font-medium tracking-wide uppercase">
                  {t('nodes.openvpn.listeners', { defaultValue: 'Listeners' })}
                </div>
                <div className="flex flex-wrap gap-1.5" dir="ltr">
                  {listeners.map(l => (
                    <Badge key={`${l.proto}-${l.port}`} variant="outline" className="font-mono text-[11px]">
                      {l.port ?? '—'}/{(l.proto ?? 'udp').toUpperCase()}
                    </Badge>
                  ))}
                </div>
              </div>

              {capacity?.tooSmall ? (
                <p className="text-destructive mt-3 text-[11px]">
                  {t('nodes.openvpn.subnetTooSmall', {
                    defaultValue:
                      'Each listener would get a /{{prefix}}, narrower than the /24 the node allows. Widen the subnet or use fewer listeners.',
                    prefix: capacity.perListener,
                  })}
                </p>
              ) : listeners.length > 1 ? (
                <p className="text-muted-foreground mt-3 text-[11px]">
                  {t('nodes.openvpn.splitNote', {
                    defaultValue:
                      'The node runs one server per listener and splits the client subnet between them, so each gets an equal share.',
                  })}
                </p>
              ) : null}
            </Card>
          )
        })
      )}
    </div>
  )
}
