import PageHeader from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { StickySaveBar } from '@/features/core-editor/components/shell/sticky-save-bar'
import useDirDetection from '@/hooks/use-dir-detection'
import { cn } from '@/lib/utils'
import { getGetCoreConfigQueryKey, useCreateCoreConfig, useGetCoreConfig, useModifyCoreConfig } from '@/service/api'
import { $fetch } from '@/service/http'
import { queryClient } from '@/utils/query-client'
import { ArrowLeft, Download, ShieldCheck } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'

// The server certificate material is generated/preserved by the backend — the form
// never edits it, but we round-trip it on save so an edit doesn't regenerate certs.
const MATERIAL_KEYS = ['ca_cert', 'server_cert', 'server_key'] as const

interface IKEv2FormValues {
  inbound_tag: string
  server_addr: string
  identity: string
  pool: string
  dns: string
  ike_proposals: string
  esp_proposals: string
}

function splitLines(v: string): string[] {
  return v
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
}

function defaultValues(): IKEv2FormValues {
  return {
    inbound_tag: 'ikev2-main',
    server_addr: '',
    identity: '',
    pool: '10.30.0.0/24',
    dns: '1.1.1.1\n8.8.8.8',
    ike_proposals: 'aes256-sha256-modp2048\naes128-sha256-modp2048',
    esp_proposals: 'aes256-sha256\naes128-sha256',
  }
}

function configToFormValues(config: Record<string, unknown>): IKEv2FormValues {
  const d = defaultValues()
  return {
    inbound_tag: String(config.inbound_tag ?? d.inbound_tag),
    server_addr: String(config.server_addr ?? ''),
    identity: String(config.identity ?? ''),
    pool: String(config.pool ?? d.pool),
    dns: Array.isArray(config.dns) ? (config.dns as string[]).join('\n') : d.dns,
    ike_proposals: Array.isArray(config.ike_proposals) ? (config.ike_proposals as string[]).join('\n') : d.ike_proposals,
    esp_proposals: Array.isArray(config.esp_proposals) ? (config.esp_proposals as string[]).join('\n') : d.esp_proposals,
  }
}

export default function IKEv2CoreEditorPage() {
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
  const [caInfo, setCaInfo] = useState<{ ca_cert?: string; common_name?: string; not_after?: string; expired?: boolean } | null>(null)

  const form = useForm<IKEv2FormValues>({ defaultValues: defaultValues() })

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
    a.download = 'pasarguard-ca.crt'
    a.click()
    URL.revokeObjectURL(url)
  }

  const createMutation = useCreateCoreConfig()
  const modifyMutation = useModifyCoreConfig()

  const buildConfig = (v: IKEv2FormValues): Record<string, unknown> => ({
    inbound_tag: v.inbound_tag.trim(),
    server_addr: v.server_addr.trim(),
    identity: v.identity.trim() || v.server_addr.trim(),
    pool: v.pool.trim(),
    dns: splitLines(v.dns),
    ike_proposals: splitLines(v.ike_proposals),
    esp_proposals: splitLines(v.esp_proposals),
    ...preservedMaterial,
  })

  const handleSave = async () => {
    const name = coreName.trim()
    if (!name) {
      toast.error(t('coreConfigModal.nameRequired', { defaultValue: 'Core name is required' }))
      return
    }
    const v = form.getValues()
    if (!v.server_addr.trim()) {
      toast.error(t('coreEditor.ikev2.serverAddrRequired', { defaultValue: 'Server address is required' }))
      return
    }
    const config = buildConfig(v)
    setSaving(true)
    try {
      if (isNew) {
        const res = await createMutation.mutateAsync({
          data: { name, type: 'ikev2', config, exclude_inbound_tags: [], fallbacks_inbound_tags: [] },
        })
        toast.success(t('coreConfigModal.createSuccess', { name, defaultValue: 'Core created' }))
        queryClient.invalidateQueries({ queryKey: ['/api/cores'] })
        queryClient.invalidateQueries({ queryKey: ['/api/cores/simple'] })
        navigate(`/nodes/cores/${res.id}`, { replace: true })
      } else if (validId) {
        await modifyMutation.mutateAsync({
          coreId: numericId,
          data: { name, type: 'ikev2', config, exclude_inbound_tags: [], fallbacks_inbound_tags: [] },
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
            value="ikev2"
            onValueChange={value => {
              if (!isNew) return
              if (value === 'ikev2') return
              setSearchParams(
                prev => {
                  const p = new URLSearchParams(prev)
                  if (value === 'wg') p.set('kind', 'wg')
                  else if (value === 'openvpn') p.set('kind', 'openvpn')
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
              <SelectItem value="ikev2">IKEv2</SelectItem>
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

  const lbl = (key: string, fallback: string) => t(`coreEditor.ikev2.fields.${key}`, { defaultValue: fallback })

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-0">
      <div className="px-4 pt-3 pb-2 md:pt-6 md:pb-0">{header}</div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <PageHeader title={t('coreEditor.ikev2.title', { defaultValue: 'IKEv2/IPsec server' })} description={t('coreEditor.ikev2.desc', { defaultValue: 'EAP username/password. The server certificate is generated automatically from the panel CA.' })} className="py-2.5 sm:py-4 md:pt-6" />
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-4">
          {caInfo?.ca_cert && (
            <div className="mb-4 rounded-md border p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <ShieldCheck className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{t('coreEditor.ikev2.ca', { defaultValue: 'Certificate Authority' })}</div>
                    <div className="text-muted-foreground truncate text-[11px]" dir="ltr">
                      {caInfo.common_name}
                      {caInfo.not_after && <> {' · '}{caInfo.expired ? t('coreEditor.ikev2.caExpired', { defaultValue: 'expired' }) : t('coreEditor.ikev2.caExpires', { defaultValue: 'expires' }) + ' ' + new Date(caInfo.not_after).toLocaleDateString()}</>}
                    </div>
                  </div>
                </div>
                <Button type="button" variant="outline" size="sm" className="h-8 shrink-0" onClick={exportCa}>
                  <Download className="mr-1 h-3.5 w-3.5" />
                  {t('coreEditor.ikev2.exportCa', { defaultValue: 'Export CA' })}
                </Button>
              </div>
            </div>
          )}
          <Form {...form}>
            <form className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2" onSubmit={e => e.preventDefault()}>
              <FormField
                control={form.control}
                name="inbound_tag"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{lbl('inbound_tag', 'Inbound tag')}</FormLabel>
                    <FormControl>
                      <Input dir="ltr" className="text-xs" placeholder="ikev2-main" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="server_addr"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{lbl('server_addr', 'Server address (public IP/host)')}</FormLabel>
                    <FormControl>
                      <Input dir="ltr" className="text-xs" placeholder="172.234.115.84" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="identity"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{lbl('identity', 'Server identity (cert SAN; default = address)')}</FormLabel>
                    <FormControl>
                      <Input dir="ltr" className="text-xs" placeholder="172.234.115.84" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="pool"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{lbl('pool', 'Client IP pool')}</FormLabel>
                    <FormControl>
                      <Input dir="ltr" className="text-xs" placeholder="10.30.0.0/24" {...field} />
                    </FormControl>
                    <FormMessage />
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
                name="ike_proposals"
                render={({ field }) => (
                  <FormItem className="sm:col-span-2">
                    <FormLabel>{lbl('ike_proposals', 'IKE proposals (one per line)')}</FormLabel>
                    <FormControl>
                      <Textarea rows={3} dir="ltr" className="text-xs" placeholder={'aes256-sha256-modp2048'} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="esp_proposals"
                render={({ field }) => (
                  <FormItem className="sm:col-span-2">
                    <FormLabel>{lbl('esp_proposals', 'ESP proposals (one per line)')}</FormLabel>
                    <FormControl>
                      <Textarea rows={3} dir="ltr" className="text-xs" placeholder={'aes256-sha256'} {...field} />
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
