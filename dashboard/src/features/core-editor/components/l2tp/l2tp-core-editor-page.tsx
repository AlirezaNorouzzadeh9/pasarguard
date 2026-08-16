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
import { queryClient } from '@/utils/query-client'
import { ArrowLeft, RefreshCcw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'

interface L2TPFormValues {
  inbound_tag: string
  server_addr: string
  pool: string
  local_ip: string
  psk: string
  egress_interface: string
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

function randomPSK(len = 12): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = new Uint8Array(len)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('')
}

function defaultValues(): L2TPFormValues {
  return {
    inbound_tag: 'l2tp-main',
    server_addr: '',
    pool: '10.31.0.0/24',
    local_ip: '',
    psk: '',
    egress_interface: '',
    dns: '1.1.1.1\n8.8.8.8',
    ike_proposals: 'aes256-sha1-modp2048\naes128-sha1-modp1024\n3des-sha1-modp1024',
    esp_proposals: 'aes256-sha1\naes128-sha1\n3des-sha1',
  }
}

function configToFormValues(config: Record<string, unknown>): L2TPFormValues {
  const d = defaultValues()
  return {
    inbound_tag: String(config.inbound_tag ?? d.inbound_tag),
    server_addr: String(config.server_addr ?? ''),
    pool: String(config.pool ?? d.pool),
    local_ip: String(config.local_ip ?? ''),
    psk: String(config.psk ?? ''),
    egress_interface: String(config.egress_interface ?? ''),
    dns: Array.isArray(config.dns) ? (config.dns as string[]).join('\n') : d.dns,
    ike_proposals: Array.isArray(config.ike_proposals) ? (config.ike_proposals as string[]).join('\n') : d.ike_proposals,
    esp_proposals: Array.isArray(config.esp_proposals) ? (config.esp_proposals as string[]).join('\n') : d.esp_proposals,
  }
}

export default function L2TPCoreEditorPage() {
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

  const form = useForm<L2TPFormValues>({ defaultValues: defaultValues() })

  useEffect(() => {
    if (isNew || !coreData) return
    setCoreName(coreData.name ?? '')
    form.reset(configToFormValues((coreData.config ?? {}) as Record<string, unknown>))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coreData, isNew])

  const createMutation = useCreateCoreConfig()
  const modifyMutation = useModifyCoreConfig()

  const buildConfig = (v: L2TPFormValues): Record<string, unknown> => ({
    inbound_tag: v.inbound_tag.trim(),
    server_addr: v.server_addr.trim(),
    pool: v.pool.trim(),
    local_ip: v.local_ip.trim(),
    // Empty PSK lets the backend generate one; a set value is kept.
    psk: v.psk.trim(),
    egress_interface: v.egress_interface.trim(),
    dns: splitLines(v.dns),
    ike_proposals: splitLines(v.ike_proposals),
    esp_proposals: splitLines(v.esp_proposals),
  })

  const handleSave = async () => {
    const name = coreName.trim()
    if (!name) {
      toast.error(t('coreConfigModal.nameRequired', { defaultValue: 'Core name is required' }))
      return
    }
    const v = form.getValues()
    if (!v.server_addr.trim()) {
      toast.error(t('coreEditor.l2tp.serverAddrRequired', { defaultValue: 'Server address is required' }))
      return
    }
    const config = buildConfig(v)
    setSaving(true)
    try {
      if (isNew) {
        const res = await createMutation.mutateAsync({
          data: { name, type: 'l2tp', config, exclude_inbound_tags: [], fallbacks_inbound_tags: [] },
        })
        toast.success(t('coreConfigModal.createSuccess', { name, defaultValue: 'Core created' }))
        queryClient.invalidateQueries({ queryKey: ['/api/cores'] })
        queryClient.invalidateQueries({ queryKey: ['/api/cores/simple'] })
        navigate(`/nodes/cores/${res.id}`, { replace: true })
      } else if (validId) {
        await modifyMutation.mutateAsync({
          coreId: numericId,
          data: { name, type: 'l2tp', config, exclude_inbound_tags: [], fallbacks_inbound_tags: [] },
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
            value="l2tp"
            onValueChange={value => {
              if (!isNew) return
              if (value === 'l2tp') return
              setSearchParams(
                prev => {
                  const p = new URLSearchParams(prev)
                  if (value === 'wg') p.set('kind', 'wg')
                  else if (value === 'openvpn') p.set('kind', 'openvpn')
                  else if (value === 'singbox') p.set('kind', 'singbox')
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
              <SelectItem value="singbox">sing-box</SelectItem>
              <SelectItem value="l2tp">L2TP</SelectItem>
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

  const lbl = (key: string, fallback: string) => t(`coreEditor.l2tp.fields.${key}`, { defaultValue: fallback })

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-0">
      <div className="px-4 pt-3 pb-2 md:pt-6 md:pb-0">{header}</div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <PageHeader title={t('coreEditor.l2tp.title', { defaultValue: 'L2TP/IPsec server' })} description={t('coreEditor.l2tp.desc', { defaultValue: 'Username/password over a shared IPsec pre-shared key. Best for older Android devices without native IKEv2.' })} className="py-2.5 sm:py-4 md:pt-6" />
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
                      <Input dir="ltr" className="text-xs" placeholder="l2tp-main" {...field} />
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
                name="pool"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{lbl('pool', 'Client IP pool')}</FormLabel>
                    <FormControl>
                      <Input dir="ltr" className="text-xs" placeholder="10.31.0.0/24" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="local_ip"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{lbl('local_ip', 'Server tunnel IP (optional)')}</FormLabel>
                    <FormControl>
                      <Input dir="ltr" className="text-xs" placeholder="10.31.0.1" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="psk"
                render={({ field }) => (
                  <FormItem className="sm:col-span-2">
                    <FormLabel>{lbl('psk', 'IPsec pre-shared key (PSK)')}</FormLabel>
                    <FormControl>
                      <div dir="ltr" className={cn('flex items-center gap-2', dir === 'rtl' ? 'flex-row-reverse' : 'flex-row')}>
                        <Input dir="ltr" className="text-xs" placeholder={t('coreEditor.l2tp.pskPlaceholder', { defaultValue: 'auto-generated if left empty' })} {...field} />
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-9 w-9 shrink-0"
                          onClick={() => form.setValue('psk', randomPSK(), { shouldDirty: true })}
                          title={t('coreEditor.l2tp.generatePsk', { defaultValue: 'Generate PSK' })}
                        >
                          <RefreshCcw className="h-3 w-3" />
                        </Button>
                      </div>
                    </FormControl>
                    <p className="text-muted-foreground text-[11px]">
                      {t('coreEditor.l2tp.pskHint', { defaultValue: 'Shared by every client. Give it to users alongside their username and password.' })}
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="egress_interface"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{lbl('egress_interface', 'Egress interface (optional)')}</FormLabel>
                    <FormControl>
                      <Input dir="ltr" className="text-xs" placeholder="wg-de" {...field} />
                    </FormControl>
                    <p className="text-muted-foreground text-[11px]">
                      {t('coreEditor.l2tp.egressHint', {
                        defaultValue: "Route this core's traffic out a specific interface on the node (e.g. an upstream tunnel). Leave empty for the default route.",
                      })}
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="dns"
                render={({ field }) => (
                  <FormItem>
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
                      <Textarea rows={3} dir="ltr" className="text-xs" placeholder={'aes256-sha1-modp2048'} {...field} />
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
                      <Textarea rows={3} dir="ltr" className="text-xs" placeholder={'aes256-sha1'} {...field} />
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
        canSave
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
