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
import { queryClient } from '@/utils/query-client'
import { ArrowLeft, RefreshCcw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'

const CIPHERS = ['AES-256-GCM', 'AES-128-GCM', 'CHACHA20-POLY1305', 'AES-256-CBC', 'AES-128-CBC'] as const

// Server PKI material is generated/preserved by the backend — the form never edits it,
// but we round-trip it on save so an edit doesn't force cert regeneration.
const MATERIAL_KEYS = ['ca_cert', 'server_cert', 'server_key', 'tls_crypt_key'] as const

interface OpenVPNFormValues {
  inbound_tag: string
  port: string
  proto: 'udp' | 'tcp'
  server_subnet: string
  cipher: string
  duplicate_cn: boolean
  keepalive: string
  max_clients: string
  dns: string
  data_ciphers: string
  push: string
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
    cipher: 'AES-256-GCM',
    duplicate_cn: true,
    keepalive: '10 60',
    max_clients: '1024',
    dns: '1.1.1.1',
    data_ciphers: 'AES-256-GCM\nCHACHA20-POLY1305',
    push: '',
  }
}

function configToFormValues(config: Record<string, unknown>): OpenVPNFormValues {
  const d = defaultValues()
  return {
    inbound_tag: String(config.inbound_tag ?? d.inbound_tag),
    port: String(config.port ?? d.port),
    proto: config.proto === 'tcp' ? 'tcp' : 'udp',
    server_subnet: String(config.server_subnet ?? d.server_subnet),
    cipher: String(config.cipher ?? d.cipher),
    duplicate_cn: config.duplicate_cn !== false,
    keepalive: String(config.keepalive ?? d.keepalive),
    max_clients: String(config.max_clients ?? d.max_clients),
    dns: Array.isArray(config.dns) ? (config.dns as string[]).join('\n') : d.dns,
    data_ciphers: Array.isArray(config.data_ciphers) ? (config.data_ciphers as string[]).join('\n') : d.data_ciphers,
    push: Array.isArray(config.push) ? (config.push as string[]).join('\n') : '',
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
    cipher: v.cipher,
    data_ciphers: splitLines(v.data_ciphers),
    duplicate_cn: v.duplicate_cn,
    keepalive: v.keepalive.trim(),
    max_clients: Number(v.max_clients),
    dns: splitLines(v.dns),
    push: splitLines(v.push),
    ...preservedMaterial,
  })

  const handleSave = async () => {
    const name = coreName.trim()
    if (!name) {
      toast.error(t('coreConfigModal.nameRequired', { defaultValue: 'Core name is required' }))
      return
    }
    const v = form.getValues()
    const config = buildConfig(v)
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
            </form>
          </Form>
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
