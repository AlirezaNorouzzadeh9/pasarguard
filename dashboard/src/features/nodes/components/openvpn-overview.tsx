import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useGetAllCores, type CoreResponse } from '@/service/api'
import { $fetch } from '@/service/http'
import { useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { useTranslation } from 'react-i18next'

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

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="min-w-0">
    <div className="text-muted-foreground text-[11px] uppercase">{label}</div>
    <div className="truncate font-mono text-xs">{children}</div>
  </div>
)

export default function OpenVPNOverview() {
  const { t } = useTranslation()

  const { data: ca, isLoading: caLoading } = useQuery({
    queryKey: ['openvpn', 'ca'],
    queryFn: () => $fetch<CaInfo>('/api/openvpn/ca'),
    retry: false,
  })
  const { data: cores, isLoading: coresLoading } = useGetAllCores()

  const openvpnCores = (cores?.cores ?? []).filter((core: CoreResponse) => core.type === 'openvpn')
  const caExpiresIn = daysUntil(ca?.not_after)

  if (caLoading || coresLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  // No CA yet means no OpenVPN core has ever been saved — the material is
  // minted on first save, so there is nothing to show and nothing wrong.
  if (!ca?.ca_cert) {
    return (
      <Card className="text-muted-foreground px-4 py-10 text-center text-sm">
        {t('nodes.openvpn.noCa', {
          defaultValue: 'No OpenVPN certificate authority yet. It is created automatically with your first OpenVPN core.',
        })}
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <div className="mb-4 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium">{t('nodes.openvpn.ca', { defaultValue: 'Certificate authority' })}</h3>
            {ca.expired ? (
              <Badge variant="destructive">{t('nodes.openvpn.expired', { defaultValue: 'Expired' })}</Badge>
            ) : (
              <Badge variant="secondary">
                {caExpiresIn !== null
                  ? t('nodes.openvpn.expiresIn', { defaultValue: '{{days}} days left', days: caExpiresIn })
                  : t('nodes.openvpn.valid', { defaultValue: 'Valid' })}
              </Badge>
            )}
          </div>
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
            <Download className="mr-1 h-3.5 w-3.5" />
            {t('nodes.openvpn.exportCa', { defaultValue: 'Export CA' })}
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3" dir="ltr">
          <Field label={t('nodes.openvpn.commonName', { defaultValue: 'Common name' })}>{ca.common_name ?? '—'}</Field>
          <Field label={t('nodes.openvpn.validFrom', { defaultValue: 'Valid from' })}>{formatDate(ca.not_before)}</Field>
          <Field label={t('nodes.openvpn.validUntil', { defaultValue: 'Valid until' })}>{formatDate(ca.not_after)}</Field>
          <Field label={t('nodes.openvpn.fingerprint', { defaultValue: 'Fingerprint' })}>{ca.fingerprint ?? '—'}</Field>
          <Field label={t('nodes.openvpn.tlsCrypt', { defaultValue: 'tls-crypt key' })}>
            {ca.tls_crypt_key_present
              ? t('nodes.openvpn.present', { defaultValue: 'present' })
              : t('nodes.openvpn.missing', { defaultValue: 'missing' })}
          </Field>
          <Field label={t('nodes.openvpn.clientValidity', { defaultValue: 'Client cert validity' })}>
            {ca.client_cert_validity_days ? `${ca.client_cert_validity_days} days` : '—'}
          </Field>
        </div>
      </Card>

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

          return (
            <Card key={core.id} className="p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">{core.name}</h3>
                <span className="text-muted-foreground font-mono text-xs">{String(config.inbound_tag ?? '')}</span>
              </div>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3" dir="ltr">
                <Field label={t('nodes.openvpn.subnet', { defaultValue: 'Client subnet' })}>
                  {String(config.server_subnet ?? '—')}
                </Field>
                <Field label={t('nodes.openvpn.cipher', { defaultValue: 'Cipher' })}>{String(config.cipher ?? '—')}</Field>
                <Field label={t('nodes.openvpn.listeners', { defaultValue: 'Listeners' })}>
                  <div className="flex flex-wrap gap-1">
                    {listeners.map(l => (
                      <Badge key={`${l.proto}-${l.port}`} variant="secondary" className="font-mono text-[10px]">
                        {l.port}/{(l.proto ?? 'udp').toUpperCase()}
                      </Badge>
                    ))}
                  </div>
                </Field>
              </div>
              {listeners.length > 1 && (
                <p className="text-muted-foreground mt-3 text-[11px]">
                  {t('nodes.openvpn.splitNote', {
                    defaultValue:
                      'The node runs one server per listener and splits the client subnet between them, so each gets an equal share.',
                  })}
                </p>
              )}
            </Card>
          )
        })
      )}
    </div>
  )
}
