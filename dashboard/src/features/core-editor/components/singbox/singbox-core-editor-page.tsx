import { ArrowLeft, ArrowUpFromLine, ShieldCheck } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import type { ColumnDef } from '@tanstack/react-table'

import PageHeader from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Form } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { CoreEditorDataTable } from '@/features/core-editor/components/shared/core-editor-data-table'
import { CoreEditorFormDialog } from '@/features/core-editor/components/shared/core-editor-form-dialog'
import { JsonCodeEditorPanel } from '@/features/core-editor/components/shared/json-code-editor-panel'
import { CoreEditorLayout } from '@/features/core-editor/components/shell/core-editor-layout'
import { SingBoxInboundFields } from '@/features/core-editor/components/singbox/singbox-inbound-card'
import { SINGBOX_CORE_SECTION_NAV, type SingBoxCoreSection } from '@/features/core-editor/kit/core-section-nav'
import {
  configToForm,
  formToConfig,
  newInboundForm,
  withRawSections,
  type InboundForm,
  type SingBoxFormValues,
} from '@/features/core-editor/kit/singbox-adapter'
import useDirDetection from '@/hooks/use-dir-detection'
import { cn } from '@/lib/utils'
import { useQueryClient } from '@tanstack/react-query'

import { getGetCoreConfigQueryKey, useCreateCoreConfig, useModifyCoreConfig, type CoreCreateConfig } from '@/service/api'

/**
 * Editing a sing-box core, in the same shell as an xray one.
 *
 * The config is written to the node verbatim and sing-box owns a large schema,
 * so the form never rebuilds it: it edits a copy and writes back only the
 * fields it owns. Every key it has never heard of survives being saved by it —
 * see singbox-adapter, where that is the property the tests are about.
 *
 * Inbounds get real fields because the panel has to understand them well enough
 * to build a client link. Routing and DNS are edited as JSON: modelling them
 * would mean tracking sing-box's rule schema, and a form that silently drops a
 * rule it does not recognise is worse for those than no form at all.
 */
interface Props {
  /** null = creating a new core; save goes through create instead of modify */
  coreId: number | null
  coreName: string
  config: unknown
  excludeInboundTags?: string[] | null
  fallbacksInboundTags?: string[] | null
}

type Dict = Record<string, any>

const asDict = (value: unknown): Dict => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Dict) : {})
const pretty = (value: unknown) => JSON.stringify(value ?? {}, null, 2)

/* What a new core starts from. The experimental block is not optional garnish:
   clash_api is how the node adds and removes users on the running core, and
   v2ray_api (with users:["*"]) is where their usage is read — the panel
   refuses to save a config without them. Inbounds start empty on purpose; the
   editor's empty state explains what a core without them means. */
export const NEW_SINGBOX_CONFIG = {
  log: { level: 'warn' },
  inbounds: [],
  outbounds: [{ type: 'direct', tag: 'direct' }],
  experimental: {
    clash_api: { external_controller: '127.0.0.1:9090' },
    v2ray_api: { listen: '127.0.0.1:8080', stats: { enabled: true, users: ['*'] } },
  },
}

export default function SingBoxCoreEditorPage({
  coreId,
  coreName,
  config,
  excludeInboundTags,
  fallbacksInboundTags,
}: Props) {
  const { t } = useTranslation()
  const dir = useDirDetection()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const modifyCore = useModifyCoreConfig()
  const createCore = useCreateCoreConfig()
  const isNew = coreId === null

  const [name, setName] = useState(coreName)
  const [section, setSection] = useState<SingBoxCoreSection>('inbounds')
  const initial = useMemo(() => configToForm(config), [config])
  const form = useForm<SingBoxFormValues>({ defaultValues: initial })
  const values = form.watch()

  const original = useMemo(() => asDict(config), [config])
  const [outbounds, setOutbounds] = useState<Dict[]>(() => (Array.isArray(original.outbounds) ? original.outbounds : []))
  const [routeText, setRouteText] = useState(() => pretty(original.route))
  const [dnsText, setDnsText] = useState(() => pretty(original.dns))
  // The APIs the node drives the core through, plus logging. Raw JSON rather
  // than fields: sing-box keeps growing settings here, and a form would quietly
  // drop the ones it had not been taught.
  const [advancedText, setAdvancedText] = useState(() =>
    JSON.stringify({ log: original.log ?? {}, experimental: original.experimental ?? {} }, null, 2),
  )

  const [editingInbound, setEditingInbound] = useState<number | null>(null)
  const [editingOutbound, setEditingOutbound] = useState<number | null>(null)
  const [outboundText, setOutboundText] = useState('{}')

  // A sing-box core only takes effect when the node restarts it, and a
  // saved-but-not-applied config is the kind of difference nobody notices until
  // a user cannot connect.
  const [restartNodes, setRestartNodes] = useState(true)

  const parse = (text: string) => {
    try {
      return { value: JSON.parse(text) as unknown, error: null as string | null }
    } catch (err) {
      return { value: null, error: err instanceof Error ? err.message : String(err) }
    }
  }
  const route = parse(routeText)
  const dns = parse(dnsText)
  const advanced = parse(advancedText)
  const jsonError = route.error ?? dns.error ?? advanced.error

  const nextConfig = useMemo(() => {
    const raw: Record<string, unknown> = { outbounds }
    // A section whose text does not parse keeps whatever the config already
    // had, rather than being written as garbage while it is mid-edit.
    if (!route.error) raw.route = route.value
    if (!dns.error) raw.dns = dns.value
    if (!advanced.error) {
      const block = asDict(advanced.value)
      raw.log = block.log ?? {}
      raw.experimental = block.experimental ?? {}
    }
    return formToConfig(withRawSections(original, raw), values)
    // The JSON sections are re-parsed from their text on every render; the text
    // is the dependency, not the parsed value.
  }, [original, outbounds, routeText, dnsText, advancedText, values])

  const dirty = useMemo(() => JSON.stringify(nextConfig) !== JSON.stringify(original), [nextConfig, original])

  const discard = () => {
    form.reset(initial)
    setOutbounds(Array.isArray(original.outbounds) ? original.outbounds : [])
    setRouteText(pretty(original.route))
    setDnsText(pretty(original.dns))
    setAdvancedText(JSON.stringify({ log: original.log ?? {}, experimental: original.experimental ?? {} }, null, 2))
  }

  const save = async () => {
    if (jsonError) {
      toast.error(jsonError)
      return
    }
    if (!name.trim()) {
      toast.error(t('coreConfigModal.nameRequired', { defaultValue: 'The core needs a name.' }))
      return
    }
    const tags = values.inbounds.map(row => row.tag.trim()).filter(Boolean)
    if (tags.length !== values.inbounds.length) {
      toast.error(t('coreEditor.singbox.tagRequired', { defaultValue: 'Every inbound needs a tag.' }))
      setSection('inbounds')
      return
    }
    if (new Set(tags).size !== tags.length) {
      // Hosts are matched to inbounds by tag, so a duplicate silently sends
      // users to whichever one the panel resolves first.
      toast.error(t('coreEditor.singbox.tagDuplicate', { defaultValue: 'Two inbounds share a tag.' }))
      setSection('inbounds')
      return
    }

    try {
      const data = {
        name: name.trim(),
        type: 'singbox',
        // The API type describes an xray config; a sing-box config is a
        // different shape the panel stores verbatim, so the cast is the
        // honest thing rather than pretending it matches.
        config: nextConfig as CoreCreateConfig,
        exclude_inbound_tags: excludeInboundTags ?? [],
        fallbacks_inbound_tags: fallbacksInboundTags ?? [],
      }
      if (coreId === null) {
        const res = await createCore.mutateAsync({ data })
        toast.success(t('coreConfigModal.createSuccess', { name: data.name, defaultValue: 'Core created' }))
        queryClient.invalidateQueries({ queryKey: ['/api/cores'] })
        queryClient.invalidateQueries({ queryKey: ['/api/cores/simple'] })
        navigate(`/nodes/cores/${res.id}`, { replace: true })
        return
      }
      await modifyCore.mutateAsync({
        coreId,
        data,
        params: { restart_nodes: restartNodes },
      })
      queryClient.invalidateQueries({ queryKey: getGetCoreConfigQueryKey(coreId) })
      form.reset(values)
      toast.success(t('coreConfig.saved', { defaultValue: 'Core saved' }))
    } catch (err: any) {
      // The panel's rejection says exactly which setting is missing and why it
      // matters, so it is shown rather than replaced with "save failed".
      const detail = err?.response?.data?.detail
      toast.error(typeof detail === 'string' ? detail : JSON.stringify(detail ?? err?.message ?? err))
    }
  }

  // ------------------------------------------------------------------ tables

  const inboundColumns: ColumnDef<InboundForm, unknown>[] = [
    { id: 'index', header: '#', cell: ({ row }) => <span className="text-muted-foreground text-xs">{row.index + 1}</span> },
    {
      id: 'tag',
      header: t('coreEditor.singbox.tag', { defaultValue: 'Tag' }),
      cell: ({ row }) => <span className="font-medium">{row.original.tag || '—'}</span>,
    },
    {
      id: 'protocol',
      header: t('coreEditor.singbox.protocol', { defaultValue: 'Protocol' }),
      cell: ({ row }) => (
        <Badge variant="secondary" className="text-[10px]">
          {row.original.type}
        </Badge>
      ),
    },
    {
      id: 'port',
      header: t('coreEditor.singbox.port', { defaultValue: 'Port' }),
      cell: ({ row }) => <span dir="ltr">{row.original.listen_port || '—'}</span>,
    },
    {
      id: 'tls',
      header: 'TLS',
      cell: ({ row }) =>
        row.original.tls.enabled ? (
          <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
            <ShieldCheck className="h-3.5 w-3.5" />
            {row.original.tls.server_name || 'on'}
          </span>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        ),
    },
  ]

  const outboundColumns: ColumnDef<Dict, unknown>[] = [
    { id: 'index', header: '#', cell: ({ row }) => <span className="text-muted-foreground text-xs">{row.index + 1}</span> },
    { id: 'tag', header: t('coreEditor.singbox.tag', { defaultValue: 'Tag' }), cell: ({ row }) => <span className="font-medium">{row.original.tag ?? '—'}</span> },
    {
      id: 'type',
      header: t('coreEditor.singbox.protocol', { defaultValue: 'Type' }),
      cell: ({ row }) => (
        <Badge variant="secondary" className="text-[10px]">
          {row.original.type ?? '—'}
        </Badge>
      ),
    },
  ]

  const setInbounds = (next: InboundForm[]) => form.setValue('inbounds', next, { shouldDirty: true })

  const addInbound = () => {
    const next = [...values.inbounds, newInboundForm()]
    setInbounds(next)
    setEditingInbound(next.length - 1)
  }

  const openOutbound = (index: number) => {
    setOutboundText(pretty(outbounds[index]))
    setEditingOutbound(index)
  }

  const addOutbound = () => {
    const next = [...outbounds, { type: 'direct', tag: 'direct' }]
    setOutbounds(next)
    setOutboundText(pretty(next[next.length - 1]))
    setEditingOutbound(next.length - 1)
  }

  const sectionMeta: Record<SingBoxCoreSection, { title: string; description: string; add?: () => void; addLabel?: string }> = {
    inbounds: {
      title: 'coreEditor.section.inbounds',
      description: t('coreEditor.singbox.inboundsDesc', {
        defaultValue: 'Where users connect. Each one becomes an inbound tag hosts can be bound to.',
      }),
      add: addInbound,
      addLabel: t('coreEditor.singbox.addInbound', { defaultValue: 'Add inbound' }),
    },
    outbounds: {
      title: 'coreEditor.section.outbounds',
      description: t('coreEditor.singbox.outboundsDesc', { defaultValue: 'Where traffic leaves. A core with none cannot reach anything.' }),
      add: addOutbound,
      addLabel: t('coreEditor.singbox.addOutbound', { defaultValue: 'Add outbound' }),
    },
    routing: {
      title: 'coreEditor.section.routing',
      description: t('coreEditor.singbox.routingDesc', { defaultValue: 'Rules deciding which outbound a connection takes.' }),
    },
    dns: {
      title: 'coreEditor.section.dns',
      description: t('coreEditor.singbox.dnsDesc', { defaultValue: 'Resolvers the core uses.' }),
    },
    advanced: {
      title: 'coreEditor.section.advanced',
      description: t('coreEditor.singbox.advancedDesc', { defaultValue: 'The APIs the node drives this core through.' }),
    },
  }
  const meta = sectionMeta[section]

  const header = (
    <div className="flex min-w-0 items-center gap-2 sm:gap-3">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn('h-11 w-11 shrink-0', dir === 'rtl' && 'rotate-180')}
        onClick={() => navigate(-1)}
        aria-label={t('back', { defaultValue: 'Back' })}
      >
        <ArrowLeft className="h-5 w-5" />
      </Button>
      <div className="grid min-w-0 max-w-2xl flex-1 grid-cols-[1fr_auto] items-center gap-2 sm:gap-3">
        <Input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={t('coreConfigModal.namePlaceholder', { defaultValue: 'Core name' })}
          className="h-10 font-medium"
        />
        <Badge variant="outline" className="h-10 shrink-0 px-3">
          sing-box
        </Badge>
      </div>
    </div>
  )

  return (
    <Form {...form}>
      <CoreEditorLayout
        header={header}
        sections={{ items: SINGBOX_CORE_SECTION_NAV, active: section, onChange: id => setSection(id as SingBoxCoreSection) }}
        sectionHeader={
          <PageHeader
            title={meta.title}
            description={meta.description}
            className="flex-wrap gap-x-3 gap-y-2 py-2.5 sm:gap-4 sm:py-4 md:pt-6"
            buttonText={meta.addLabel}
            onButtonClick={meta.add}
          />
        }
        main={
          <div className="space-y-6">
            {section === 'inbounds' && (
              <CoreEditorDataTable<InboundForm>
                columns={inboundColumns}
                data={values.inbounds}
                getRowId={(_row, index) => `inbound-${index}`}
                onRowClick={(_row, index) => setEditingInbound(index)}
                onRemoveRow={index => setInbounds(values.inbounds.filter((_, i) => i !== index))}
                onBulkRemove={indices => setInbounds(values.inbounds.filter((_, i) => !indices.includes(i)))}
                emptyLabel={t('coreEditor.singbox.noInbounds', {
                  defaultValue: 'No inbounds yet. A core with none hands users an empty subscription.',
                })}
                searchPlaceholder={t('search')}
                getSearchableText={row => `${row.tag} ${row.type} ${row.listen_port}`}
              />
            )}

            {section === 'outbounds' && (
              <CoreEditorDataTable<Dict>
                columns={outboundColumns}
                data={outbounds}
                getRowId={(_row, index) => `outbound-${index}`}
                onRowClick={(_row, index) => openOutbound(index)}
                onRemoveRow={index => setOutbounds(outbounds.filter((_, i) => i !== index))}
                onBulkRemove={indices => setOutbounds(outbounds.filter((_, i) => !indices.includes(i)))}
                emptyLabel={t('coreEditor.singbox.noOutbounds', { defaultValue: 'No outbounds. Traffic has nowhere to go.' })}
                getSearchableText={row => `${row.tag ?? ''} ${row.type ?? ''}`}
                toolbarActions={
                  <Button type="button" variant="outline" size="sm" onClick={addOutbound}>
                    <ArrowUpFromLine className="me-1 h-4 w-4" />
                    {t('coreEditor.singbox.addOutbound', { defaultValue: 'Add outbound' })}
                  </Button>
                }
              />
            )}

            {section === 'routing' && (
              <div className="space-y-2">
                {route.error && <p className="text-destructive text-xs">{route.error}</p>}
                <JsonCodeEditorPanel value={routeText} onChange={setRouteText} className="min-h-[24rem]" />
              </div>
            )}

            {section === 'dns' && (
              <div className="space-y-2">
                {dns.error && <p className="text-destructive text-xs">{dns.error}</p>}
                <JsonCodeEditorPanel value={dnsText} onChange={setDnsText} className="min-h-[24rem]" />
              </div>
            )}

            {section === 'advanced' && (
              <div className="space-y-2">
                <p className="text-muted-foreground text-[11px]">
                  {t('coreEditor.singbox.apiHint', {
                    defaultValue:
                      'Users are pushed over clash_api and usage is read over v2ray_api. A core missing either starts and looks healthy while serving nobody or counting nothing. The stats block is kept in step with the inbounds on save.',
                  })}
                </p>
                {advanced.error && <p className="text-destructive text-xs">{advanced.error}</p>}
                <JsonCodeEditorPanel value={advancedText} onChange={setAdvancedText} className="min-h-[24rem]" />
              </div>
            )}

          </div>
        }
        dirty={isNew || dirty}
        canSave={(isNew || dirty) && !jsonError}
        onSave={save}
        onDiscard={discard}
        onCancel={() => navigate(-1)}
        saving={modifyCore.isPending || createCore.isPending}
        showRestart={!isNew}
        restartNodes={restartNodes}
        onRestartChange={setRestartNodes}
      />

      <CoreEditorFormDialog
        isDialogOpen={editingInbound !== null}
        onOpenChange={open => setEditingInbound(open ? editingInbound : null)}
        title={t('coreEditor.singbox.editInbound', { defaultValue: 'Inbound' })}
        // Xray persist validation is read from the xray store, which a sing-box
        // core never populates — showing it here would be another core's errors.
        inlinePersistValidation={false}
        footerExtra={
          <Button type="button" onClick={() => setEditingInbound(null)}>
            {t('done', { defaultValue: 'Done' })}
          </Button>
        }
      >
        {editingInbound !== null && values.inbounds[editingInbound] ? <SingBoxInboundFields form={form} index={editingInbound} /> : null}
      </CoreEditorFormDialog>

      <CoreEditorFormDialog
        isDialogOpen={editingOutbound !== null}
        onOpenChange={open => setEditingOutbound(open ? editingOutbound : null)}
        title={t('coreEditor.singbox.editOutbound', { defaultValue: 'Outbound' })}
        inlinePersistValidation={false}
        footerExtra={
          <Button
            type="button"
            onClick={() => {
              try {
                const parsed = JSON.parse(outboundText)
                setOutbounds(outbounds.map((row, i) => (i === editingOutbound ? parsed : row)))
                setEditingOutbound(null)
              } catch (err) {
                toast.error(err instanceof Error ? err.message : String(err))
              }
            }}
          >
            {t('done', { defaultValue: 'Done' })}
          </Button>
        }
      >
        <JsonCodeEditorPanel value={outboundText} onChange={setOutboundText} className="min-h-[18rem]" />
      </CoreEditorFormDialog>
    </Form>
  )
}
