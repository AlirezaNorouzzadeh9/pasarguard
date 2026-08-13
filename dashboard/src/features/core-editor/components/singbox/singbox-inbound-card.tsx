import { Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { UseFormReturn } from 'react-hook-form'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  SINGBOX_INBOUND_TYPES,
  SUPPORTS_METHOD,
  SUPPORTS_OBFS,
  SUPPORTS_TRANSPORT,
  TLS_REQUIRED,
  TRANSPORT_TYPES,
  type SingBoxFormValues,
} from '@/features/core-editor/kit/singbox-adapter'

const SHADOWSOCKS_METHODS = [
  'aes-128-gcm',
  'aes-256-gcm',
  'chacha20-ietf-poly1305',
  '2022-blake3-aes-128-gcm',
  '2022-blake3-aes-256-gcm',
] as const

interface Props {
  form: UseFormReturn<SingBoxFormValues>
  index: number
  onRemove: () => void
}

/**
 * One inbound.
 *
 * Only the fields that apply to the chosen protocol are shown: a transport on
 * hysteria2 or an obfuscation password on vless would be written into a config
 * that ignores them, which reads as a working setting that does nothing.
 */
export function SingBoxInboundCard({ form, index, onRemove }: Props) {
  const { t } = useTranslation()
  const type = form.watch(`inbounds.${index}.type`)
  const tlsEnabled = form.watch(`inbounds.${index}.tls.enabled`)
  const transportType = form.watch(`inbounds.${index}.transport_type`)
  const tlsLocked = TLS_REQUIRED.has(type)

  const text = (name: `inbounds.${number}.${string}`, label: string, placeholder?: string, ltr = true) => (
    <FormField
      control={form.control}
      name={name as never}
      render={({ field }) => (
        <FormItem>
          <FormLabel className="text-xs">{label}</FormLabel>
          <FormControl>
            <Input {...field} dir={ltr ? 'ltr' : undefined} className="text-xs" placeholder={placeholder} />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  )

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="font-mono text-[10px]">
            {form.watch(`inbounds.${index}.tag`) || t('coreEditor.singbox.untagged', { defaultValue: 'no tag' })}
          </Badge>
          <span className="text-xs text-muted-foreground">{type}</span>
        </div>
        <Button type="button" variant="ghost" size="icon" onClick={onRemove} aria-label="remove inbound">
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <FormField
          control={form.control}
          name={`inbounds.${index}.type`}
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs">{t('coreEditor.singbox.protocol', { defaultValue: 'Protocol' })}</FormLabel>
              <Select
                value={field.value}
                onValueChange={value => {
                  field.onChange(value)
                  // QUIC cannot run in the clear, so the switch would be a lie.
                  if (TLS_REQUIRED.has(value)) form.setValue(`inbounds.${index}.tls.enabled`, true)
                  if (value === 'shadowsocks' && !form.getValues(`inbounds.${index}.method`)) {
                    form.setValue(`inbounds.${index}.method`, 'aes-128-gcm')
                  }
                }}
              >
                <FormControl>
                  <SelectTrigger className="text-xs">
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {SINGBOX_INBOUND_TYPES.map(value => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormItem>
          )}
        />
        {text(`inbounds.${index}.tag`, t('coreEditor.singbox.tag', { defaultValue: 'Tag' }), 'singbox-vless')}
        {text(`inbounds.${index}.listen`, t('coreEditor.singbox.listen', { defaultValue: 'Listen' }), '::')}
        {text(`inbounds.${index}.listen_port`, t('coreEditor.singbox.port', { defaultValue: 'Port' }), '443')}
      </div>

      {SUPPORTS_METHOD.has(type) && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <FormField
            control={form.control}
            name={`inbounds.${index}.method`}
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-xs">{t('coreEditor.singbox.method', { defaultValue: 'Method' })}</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger className="text-xs">
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {SHADOWSOCKS_METHODS.map(value => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  {t('coreEditor.singbox.methodHint', {
                    defaultValue: 'Must match the method the panel issues to users, or nobody can connect.',
                  })}
                </p>
              </FormItem>
            )}
          />
        </div>
      )}

      {SUPPORTS_OBFS.has(type) && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {text(
            `inbounds.${index}.obfs_password`,
            t('coreEditor.singbox.obfs', { defaultValue: 'Salamander password' }),
            t('coreEditor.singbox.obfsEmpty', { defaultValue: 'empty = no obfuscation' }),
          )}
        </div>
      )}

      <div className="mt-4 rounded-md border border-dashed p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-xs font-medium">TLS</div>
            {tlsLocked && (
              <div className="text-[11px] text-muted-foreground">
                {t('coreEditor.singbox.tlsRequired', { defaultValue: 'Required by this protocol.' })}
              </div>
            )}
          </div>
          <FormField
            control={form.control}
            name={`inbounds.${index}.tls.enabled`}
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Switch checked={field.value} disabled={tlsLocked} onCheckedChange={field.onChange} />
                </FormControl>
              </FormItem>
            )}
          />
        </div>

        {tlsEnabled && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {text(
              `inbounds.${index}.tls.server_name`,
              t('coreEditor.singbox.sni', { defaultValue: 'Server name' }),
              'example.com',
            )}
            {text(`inbounds.${index}.tls.alpn`, 'ALPN', 'h3, h2')}
            {text(
              `inbounds.${index}.tls.certificate_path`,
              t('coreEditor.singbox.certPath', { defaultValue: 'Certificate path' }),
              '/etc/ssl/fullchain.pem',
            )}
            {text(
              `inbounds.${index}.tls.key_path`,
              t('coreEditor.singbox.keyPath', { defaultValue: 'Key path' }),
              '/etc/ssl/privkey.pem',
            )}
          </div>
        )}
      </div>

      {SUPPORTS_TRANSPORT.has(type) && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <FormField
            control={form.control}
            name={`inbounds.${index}.transport_type`}
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-xs">
                  {t('coreEditor.singbox.transport', { defaultValue: 'Transport' })}
                </FormLabel>
                <Select value={field.value || 'none'} onValueChange={value => field.onChange(value === 'none' ? '' : value)}>
                  <FormControl>
                    <SelectTrigger className="text-xs">
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {TRANSPORT_TYPES.map(value => (
                      <SelectItem key={value || 'none'} value={value || 'none'}>
                        {value || t('coreEditor.singbox.tcpPlain', { defaultValue: 'tcp (none)' })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormItem>
            )}
          />
          {transportType && transportType !== 'grpc' && (
            <>
              {text(`inbounds.${index}.transport_path`, t('coreEditor.singbox.path', { defaultValue: 'Path' }), '/')}
              {text(`inbounds.${index}.transport_host`, t('coreEditor.singbox.host', { defaultValue: 'Host' }), 'a.example')}
            </>
          )}
          {transportType === 'grpc' &&
            text(
              `inbounds.${index}.transport_service_name`,
              t('coreEditor.singbox.serviceName', { defaultValue: 'Service name' }),
              'GunService',
            )}
        </div>
      )}
    </div>
  )
}
