import PageHeader from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { StickySaveBar } from '@/features/core-editor/components/shell/sticky-save-bar'
import useDirDetection from '@/hooks/use-dir-detection'
import { cn } from '@/lib/utils'
import { getGetCoreConfigQueryKey, useCreateCoreConfig, useGetCoreConfig, useModifyCoreConfig } from '@/service/api'
import { $fetch } from '@/service/http'
import { queryClient } from '@/utils/query-client'
import { ArrowLeft, Download, RefreshCcw, ShieldCheck } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'

const CIPHERS = ['AES-256-GCM', 'AES-128-GCM', 'CHACHA20-POLY1305', 'AES-256-CBC', 'AES-128-CBC'] as const

// Server PKI material is generated/preserved by the backend — the form never edits it,
// but we round-trip it on save so an edit doesn't force cert regeneration.
const MATERIAL_KEYS = ['ca_cert', 'server_cert', 'server_key', 'tls_crypt_key'] as const

// A single OpenVPN process binds one port/protocol, so serving both UDP and TCP
// means one server per entry. Edited as "port proto" lines because it is a
// short list and a table would dwarf it.
const listenersToText = (value: unknown): string => {
  if (!Array.isArray(value)) return ''
  return value
    .map(entry => {
      const row = entry as { port?: number; proto?: string }
      return row?.port ? `${row.port} ${row.proto ?? 'udp'}`.trim() : ''
    })
    .filter(Boolean)
    .join(String.fromCharCode(10))
}

const parseListeners = (text: string): { port: number; proto: string }[] | undefined => {
  const rows = text
    .split(String.fromCharCode(10))
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [rawPort, rawProto] = line.split(/\s+/)
      const port = Number(rawPort)
      if (!Number.isInteger(port) || port < 1 || port > 65535) return null
      const proto = (rawProto ?? 'udp').toLowerCase()
      return proto === 'udp' || proto === 'tcp' ? { port, proto } : null
    })
    .filter((row): row is { port: number; proto: string } => row !== null)
  // One entry is what port/proto already say, so send nothing and keep the
  // classic single-listener config.
  return rows.length > 1 ? rows : undefined
}

interface OpenVPNFormValues {
  inbound_tag: string
  port: string
  proto: 'udp' | 'tcp'
  server_subnet: string
  listeners: string
  cipher: string
  duplicate_cn: boolean
  keepalive: string
  max_clients: string
  dns: string
  data_ciphers: string
  push: string
  extra_server_directives: string
}

function splitLines(v: string): string[] {
  return v
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
}

function defaultValues(): OpenVPNFormValues {
  return {
    inbound_tag: 'ovpn-main',
    port: '1194',
    proto: 'udp',
    server_subnet: '10.29.0.0/16',
    listeners: '',
    cipher: 'AES-256-GCM',
    duplicate_cn: true,
    keepalive: '10 60',
    max_clients: '1024',
    dns: '1.1.1.1',
    data_ciphers: 'AES-256-GCM\nCHACHA20-POLY1305',
    push: '',
    extra_server_directives: '',
  }
}

function configToFormValues(config: Record<string, unknown>): OpenVPNFormValues {
  const d = defaultValues()
  return {
    inbound_tag: String(config.inbound_tag ?? d.inbound_tag),
    port: String(config.port ?? d.port),
    proto: config.proto === 'tcp' ? 'tcp' : 'udp',
    server_subnet: String(config.server_subnet ?? d.server_subnet),
    listeners: listenersToText(config.listeners),
    cipher: String(config.cipher ?? d.cipher),
    duplicate_cn: config.duplicate_cn !== false,
    keepalive: String(config.keepalive ?? d.keepalive),
    max_clients: String(config.max_clients ?? d.max_clients),
    dns: Array.isArray(config.dns) ? (config.dns as string[]).join('\n') : d.dns,
    data_ciphers: Array.isArray(config.data_ciphers) ? (config.data_ciphers as string[]).join('\n') : d.data_ciphers,
    push: Array.isArray(config.push) ? (config.push as string[]).join('\n') : '',
    extra_server_directives: Array.isArray(config.extra_server_directives) ? (config.extra_server_directives as string[]).join('\n') : '',
  }
}

export default function OpenVPNCoreEditorPage() {
  const { t } = useTranslation()
  const dir = useDirDetection()
  const navigate = useNavigate()
  const [, setSearchParams] = useSearchParams()
  const { coreId: coreIdParam } = useParams<{ coreId: string }>()
  const isNew = coreIdParam === 'new'
  const numericId = coreIdParam && !isNew ? Number(coreIdParam) : NaN
  const validId = Number.isFinite(numericId) && numericId > 0

  const { data: coreData, isLoading } = useGetCoreConfig(validId ? numericId : 0, { query: { enabled: validId } })

  const [coreName, setCoreName] = useState('')
  const [restartNodes, setRestartNodes] = useState(true)
  const [saving, setSaving] = useState(false)
  const [preservedMaterial, setPreservedMaterial] = useState<Record<string, unknown>>({})
  const [advanced, setAdvanced] = useState(false)
  const [advancedJson, setAdvancedJson] = useState('')
  const [advancedError, setAdvancedError] = useState<string | null>(null)
  const [caInfo, setCaInfo] = useState<{ ca_cert?: string; common_name?: string; not_after?: string; expired?: boolean; fingerprint?: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    $fetch<typeof caInfo>('/api/openvpn/ca')
      .then(res => {
        if (!cancelled) setCaInfo(res)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const exportCa = () => {
    if (!caInfo?.ca_cert) return
    const blob = new Blob([caInfo.ca_cert], { type: 'application/x-pem-file' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'pasarguard-openvpn-ca.crt'
    a.click()
    URL.revokeObjectURL(url)
  }

  const form = useForm<OpenVPNFormValues>({ defaultValues: defaultValues() })

  // Hydrate from the loaded core (edit) once.
  useEffect(() => {
    if (isNew || !coreData) return
    setCoreName(coreData.name ?? '')
    const config = (coreData.config ?? {}) as Record<string, unknown>
    form.reset(configToFormValues(config))
    const material: Record<string, unknown> = {}
    for (const k of MATERIAL_KEYS) if (config[k] != null) material[k] = config[k]
    setPreservedMaterial(material)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coreData, isNew])

  const createMutation = useCreateCoreConfig()
  const modifyMutation = useModifyCoreConfig()

  const buildConfig = (v: OpenVPNFormValues): Record<string, unknown> => ({
    inbound_tag: v.inbound_tag.trim(),
    port: Number(v.port),
    proto: v.proto,
    server_subnet: v.server_subnet.trim(),
    listeners: parseListeners(v.listeners),
    cipher: v.cipher,
    data_ciphers: splitLines(v.data_ciphers),
    duplicate_cn: v.duplicate_cn,
    keepalive: v.keepalive.trim(),
    max_clients: Number(v.max_clients),
    dns: splitLines(v.dns),
    push: splitLines(v.push),
    extra_server_directives: splitLines(v.extra_server_directives),
    ...preservedMaterial,
  })

  // Advanced mode edits the raw config JSON (minus PKI material, which is
  // preserved on save) — the same pattern as the Xray core editor.
  const enterAdvanced = () => {
    const cfg = buildConfig(form.getValues()) as Record<string, unknown>
    for (const k of MATERIAL_KEYS) delete cfg[k]
    setAdvancedJson(JSON.stringify(cfg, null, 2))
    setAdvancedError(null)
    setAdvanced(true)
  }

  const exitAdvanced = () => {
    try {
      const parsed = JSON.parse(advancedJson)
      form.reset(configToFormValues(parsed as Record<string, unknown>))
      setAdvancedError(null)
      setAdvanced(false)
    } catch (e) {
      setAdvancedError((e as Error).message)
    }
  }

  const handleSave = async () => {
    const name = coreName.trim()
    if (!name) {
      toast.error(t('coreConfigModal.nameRequired', { defaultValue: 'Core name is required' }))
      return
    }
    let config: Record<string, unknown>
    if (advanced) {
      try {
        const parsed = JSON.parse(advancedJson)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('Config must be a JSON object')
        }
        config = { ...(parsed as Record<string, unknown>), ...preservedMaterial }
      } catch (e) {
        const msg = (e as Error).message
        setAdvancedError(msg)
        toast.error(t('coreEditor.openvpn.invalidJson', { defaultValue: 'Invalid JSON: ' }) + msg)
        return
      }
    } else {
      config = buildConfig(form.getValues())
    }
    setSaving(true)
    try {
      if (isNew) {
        const res = await createMutation.mutateAsync({
          data: { name, type: 'openvpn', config, exclude_inbound_tags: [], fallbacks_inbound_tags: [] },
        })
        toast.success(t('coreConfigModal.createSuccess', { name, defaultValue: 'Core created' }))
        queryClient.invalidateQueries({ queryKey: ['/api/cores'] })
        queryClient.invalidateQueries({ queryKey: ['/api/cores/simple'] })
        navigate(`/nodes/cores/${res.id}`, { replace: true })
      } else if (validId) {
        await modifyMutation.mutateAsync({
          coreId: numericId,
          data: { name, type: 'openvpn', config, exclude_inbound_tags: [], fallbacks_inbound_tags: [] },
          params: { restart_nodes: restartNodes },
        })
        toast.success(t('coreConfigModal.editSuccess', { name, defaultValue: 'Core saved' }))
        queryClient.invalidateQueries({ queryKey: ['/api/cores'] })
        queryClient.invalidateQueries({ queryKey: ['/api/cores/simple'] })
        queryClient.invalidateQueries({ queryKey: getGetCoreConfigQueryKey(numericId) })
      }
    } catch (e: unknown) {
      const err = e as { data?: { detail?: unknown }; response?: { _data?: { detail?: unknown }; data?: { detail?: unknown } }; message?: string }
      const detail = err?.data?.detail ?? err?.response?._data?.detail ?? err?.response?.data?.detail
      toast.error(typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : (err?.message ?? String(e)))
    } finally {
      setSaving(false)
    }
  }

  const materialReady = isNew || Object.keys(preservedMaterial).length > 0

  const header = useMemo(
    () => (
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn('h-11 w-11 shrink-0', dir === 'rtl' && 'rotate-180')}
          onClick={() => navigate('/nodes/cores')}
          aria-label={t('back', { defaultValue: 'Back' })}
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="grid max-w-2xl flex-1 grid-cols-[1fr_auto] items-center gap-2 sm:gap-3">
          <Input value={coreName} onChange={e => setCoreName(e.target.value)} className="h-10 font-medium" placeholder={t('coreConfigModal.namePlaceholder', { defaultValue: 'Core name' })} />
          <Select
            value="openvpn"
            onValueChange={value => {
              if (!isNew) return // type change on an existing core is not supported here
              if (value === 'openvpn') return
              setSearchParams(
                prev => {
                  const p = new URLSearchParams(prev)
                  if (value === 'wg') p.set('kind', 'wg')
                  else p.delete('kind')
                  return p
                },
                { replace: true },
              )
            }}
            disabled={!isNew}
          >
            <SelectTrigger className="h-10 w-28 shrink-0 px-2 sm:w-[180px] sm:px-3" aria-label={t('coreConfigModal.backendType', { defaultValue: 'Backend type' })}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="xray">Xray</SelectItem>
              <SelectItem value="wg">WireGuard</SelectItem>
              <SelectItem value="openvpn">OpenVPN</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    ),
    [coreName, dir, isNew, navigate, setSearchParams, t],
  )

  if (!isNew && validId && isLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4 px-4 py-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full max-w-md rounded-md" />
        ))}
      </div>
    )
  }

  const lbl = (key: string, fallback: string) => t(`coreEditor.openvpn.fields.${key}`, { defaultValue: fallback })

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-0">
      <div className="px-4 pt-3 pb-2 md:pt-6 md:pb-0">{header}</div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <PageHeader title={t('coreEditor.openvpn.title', { defaultValue: 'OpenVPN server' })} description={t('coreEditor.openvpn.desc', { defaultValue: 'Server settings the node runs. Certificates are generated automatically.' })} className="py-2.5 sm:py-4 md:pt-6" />
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-4">
          {caInfo?.ca_cert && (
            <div className="mb-4 rounded-md border p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <ShieldCheck className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{t('coreEditor.openvpn.ca', { defaultValue: 'Certificate Authority' })}</div>
                    <div className="text-muted-foreground truncate text-[11px]" dir="ltr">
                      {caInfo.common_name}
                      {caInfo.not_after && (
                        <>
                          {' · '}
                          {caInfo.expired
                            ? t('coreEditor.openvpn.caExpired', { defaultValue: 'expired' })
                            : t('coreEditor.openvpn.caExpires', { defaultValue: 'expires' }) + ' ' + new Date(caInfo.not_after).toLocaleDateString()}
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <Button type="button" variant="outline" size="sm" className="h-8 shrink-0" onClick={exportCa}>
                  <Download className="mr-1 h-3.5 w-3.5" />
                  {t('coreEditor.openvpn.exportCa', { defaultValue: 'Export CA' })}
                </Button>
              </div>
            </div>
          )}
          <div className="mb-4 inline-flex rounded-md border p-0.5" dir="ltr">
            <Button type="button" size="sm" variant={advanced ? 'ghost' : 'secondary'} className="h-8" onClick={() => advanced && exitAdvanced()}>
              {t('coreEditor.openvpn.formTab', { defaultValue: 'Form' })}
            </Button>
            <Button type="button" size="sm" variant={advanced ? 'secondary' : 'ghost'} className="h-8" onClick={() => !advanced && enterAdvanced()}>
              {t('coreEditor.openvpn.advancedTab', { defaultValue: 'Advanced (JSON)' })}
            </Button>
          </div>
          {advanced && (
            <div className="space-y-2">
              <Textarea
                dir="ltr"
                spellCheck={false}
                className="h-[60vh] resize-none font-mono text-xs leading-relaxed"
                value={advancedJson}
                onChange={e => {
                  setAdvancedJson(e.target.value)
                  setAdvancedError(null)
                }}
              />
              {advancedError && <p className="text-destructive text-xs">{advancedError}</p>}
              <p className="text-muted-foreground text-[11px]">
                {t('coreEditor.openvpn.advancedHint', {
                  defaultValue: 'Raw core config JSON. Certificates/keys are preserved automatically. Switch back to Form to keep only the known fields.',
                })}
              </p>
            </div>
          )}
          <div className={cn(advanced && 'hidden')}>
          <Form {...form}>
            <form className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2" onSubmit={e => e.preventDefault()}>
              <FormField
                control={form.control}
                name="inbound_tag"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{lbl('inbound_tag', 'Inbound tag')}</FormLabel>
                    <FormControl>
                      <Input dir="ltr" className="text-xs" placeholder="ovpn-main" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="port"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{lbl('port', 'Port')}</FormLabel>
                    <FormControl>
                      <div dir="ltr" className={cn('flex items-center gap-2', dir === 'rtl' ? 'flex-row-reverse' : 'flex-row')}>
                        <Input type="text" inputMode="numeric" className="text-xs" placeholder="1194" {...field} />
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-9 w-9 shrink-0"
                          onClick={() => form.setValue('port', String(Math.floor(Math.random() * (65535 - 10000 + 1)) + 10000), { shouldDirty: true })}
                          title={t('coreEditor.inbound.randomPort', { defaultValue: 'Generate random port' })}
                        >
                          <RefreshCcw className="h-3 w-3" />
                        </Button>
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="proto"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{lbl('proto', 'Protocol')}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="h-10">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="udp">UDP</SelectItem>
                        <SelectItem value="tcp">TCP</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="server_subnet"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{lbl('server_subnet', 'Server subnet')}</FormLabel>
                    <FormControl>
                      <Input dir="ltr" className="text-xs" placeholder="10.29.0.0/16" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="listeners"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{lbl('listeners', 'Extra listeners (optional)')}</FormLabel>
                    <FormControl>
                      <Textarea
                        dir="ltr"
                        rows={3}
                        className="font-mono text-xs"
                        placeholder={['6062 udp', '1982 udp', '443 tcp'].join(String.fromCharCode(10))}
                        {...field}
                      />
                    </FormControl>
                    <p className="text-muted-foreground text-[11px]">
                      {t('coreEditor.openvpn.listenersHint', {
                        defaultValue:
                          'One "port protocol" per line. The node runs one OpenVPN server per entry, sharing this core\'s users and certificates, and splits the subnet between them. Leave empty to serve only the port above.',
                      })}
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="cipher"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{lbl('cipher', 'Cipher')}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="h-10">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {CIPHERS.map(c => (
                          <SelectItem key={c} value={c}>
                            {c}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="max_clients"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{lbl('max_clients', 'Max clients')}</FormLabel>
                    <FormControl>
                      <Input type="text" inputMode="numeric" dir="ltr" className="text-xs" placeholder="1024" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="keepalive"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{lbl('keepalive', 'Keepalive')}</FormLabel>
                    <FormControl>
                      <Input dir="ltr" className="text-xs" placeholder="10 60" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="duplicate_cn"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between rounded-md border p-3">
                    <div className="space-y-0.5">
                      <FormLabel>{lbl('duplicate_cn', 'Allow multiple devices (duplicate-cn)')}</FormLabel>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="dns"
                render={({ field }) => (
                  <FormItem className="sm:col-span-2">
                    <FormLabel>{lbl('dns', 'DNS servers (one per line)')}</FormLabel>
                    <FormControl>
                      <Textarea rows={3} dir="ltr" className="text-xs" placeholder={'1.1.1.1\n8.8.8.8'} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="data_ciphers"
                render={({ field }) => (
                  <FormItem className="sm:col-span-2">
                    <FormLabel>{lbl('data_ciphers', 'Data ciphers (one per line)')}</FormLabel>
                    <FormControl>
                      <Textarea rows={3} dir="ltr" className="text-xs" placeholder={'AES-256-GCM\nCHACHA20-POLY1305'} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="push"
                render={({ field }) => (
                  <FormItem className="sm:col-span-2">
                    <FormLabel>{lbl('push', 'Extra push directives (one per line, optional)')}</FormLabel>
                    <FormControl>
                      <Textarea rows={3} dir="ltr" className="text-xs" placeholder={'redirect-gateway def1 bypass-dhcp'} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="extra_server_directives"
                render={({ field }) => (
                  <FormItem className="sm:col-span-2">
                    <FormLabel>{lbl('extra_server_directives', 'Extra server directives (raw server.conf lines, one per line)')}</FormLabel>
                    <FormControl>
                      <Textarea rows={3} dir="ltr" className="text-xs" placeholder={'mssfix 1360\ncompress lz4-v2\nsndbuf 393216'} {...field} />
                    </FormControl>
                    <p className="text-muted-foreground text-[11px]">
                      {t('coreEditor.openvpn.extraServerHint', {
                        defaultValue: 'Appended verbatim to server.conf. Critical lines (management, status, certificates) are always set by the node and cannot be changed here.',
                      })}
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </form>
          </Form>
          </div>
        </div>
      </div>
      <StickySaveBar
        dirty
        canSave={materialReady}
        saveLabel={isNew ? t('create', { defaultValue: 'Create' }) : undefined}
        onSave={handleSave}
        onDiscard={() => navigate('/nodes/cores')}
        onCancel={() => navigate('/nodes/cores')}
        saving={saving || createMutation.isPending || modifyMutation.isPending}
        showRestart={!isNew}
        restartNodes={restartNodes}
        onRestartChange={setRestartNodes}
      />
    </div>
  )
}
