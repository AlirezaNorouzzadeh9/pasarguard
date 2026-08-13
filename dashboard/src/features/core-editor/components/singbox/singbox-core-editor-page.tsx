import { Plus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useFieldArray, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Form, FormControl, FormField, FormItem, FormLabel } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { StickySaveBar } from '@/features/core-editor/components/shell/sticky-save-bar'
import { SingBoxInboundCard } from '@/features/core-editor/components/singbox/singbox-inbound-card'
import {
  configToForm,
  formToConfig,
  newInboundForm,
  type SingBoxFormValues,
} from '@/features/core-editor/kit/singbox-adapter'
import { useModifyCoreConfig, type CoreCreateConfig } from '@/service/api'

/**
 * Editing a sing-box core as a form.
 *
 * The config is written to the node verbatim and sing-box owns a large schema,
 * so the form never rebuilds it: it edits a copy and writes back only the
 * fields it owns. Outbounds, route, dns and every key this editor has never
 * heard of survive being saved by it — see singbox-adapter, where that is the
 * property the tests are about.
 *
 * Two settings are not offered as choices because neither has a second useful
 * value, and both fail silently when wrong: stats must count every user, and a
 * core with no clash_api can never be given one.
 */
interface Props {
  coreId: number
  coreName: string
  config: unknown
  excludeInboundTags?: string[] | null
  fallbacksInboundTags?: string[] | null
}

export default function SingBoxCoreEditorPage({
  coreId,
  coreName,
  config,
  excludeInboundTags,
  fallbacksInboundTags,
}: Props) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const modifyCore = useModifyCoreConfig()
  const initial = useMemo(() => configToForm(config), [config])
  // A sing-box core only takes effect when the node restarts it, and a
  // saved-but-not-applied config is the kind of difference nobody notices until
  // a user cannot connect — so this is on unless it is deliberately turned off.
  const [restartNodes, setRestartNodes] = useState(true)

  const form = useForm<SingBoxFormValues>({ defaultValues: initial })
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'inbounds' })

  // Re-seed when the core reloads, but never over unsaved edits — losing
  // someone's work to a background refetch is unforgivable.
  useEffect(() => {
    if (!form.formState.isDirty) form.reset(initial)
  }, [initial, form])

  const save = form.handleSubmit(async values => {
    const tags = values.inbounds.map(row => row.tag.trim()).filter(Boolean)
    if (tags.length !== values.inbounds.length) {
      toast.error(t('coreEditor.singbox.tagRequired', { defaultValue: 'Every inbound needs a tag.' }))
      return
    }
    if (new Set(tags).size !== tags.length) {
      // Hosts are matched to inbounds by tag, so a duplicate silently sends
      // users to whichever one the panel resolves first.
      toast.error(t('coreEditor.singbox.tagDuplicate', { defaultValue: 'Two inbounds share a tag.' }))
      return
    }

    try {
      await modifyCore.mutateAsync({
        coreId,
        data: {
          name: coreName,
          type: 'singbox',
          // The API type describes an xray config; a sing-box config is a
          // different shape the panel stores verbatim, so the cast is the
          // honest thing rather than pretending it matches.
          config: formToConfig(config, values) as CoreCreateConfig,
          exclude_inbound_tags: excludeInboundTags ?? [],
          fallbacks_inbound_tags: fallbacksInboundTags ?? [],
        },
        params: { restart_nodes: restartNodes },
      })
      form.reset(values)
      toast.success(t('coreConfig.saved', { defaultValue: 'Core saved' }))
    } catch (err: any) {
      // The panel's rejection says exactly which setting is missing and why it
      // matters, so it is shown rather than replaced with "save failed".
      const detail = err?.response?.data?.detail
      toast.error(typeof detail === 'string' ? detail : JSON.stringify(detail ?? err?.message ?? err))
    }
  })

  return (
    <Form {...form}>
      <form onSubmit={save} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto p-4 pb-24">
          <div className="mb-4 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">
              {t('coreEditor.singbox.inbounds', { defaultValue: 'Inbounds' })}
              <span className="ml-2 text-xs font-normal text-muted-foreground">{fields.length}</span>
            </h2>
            <Button type="button" variant="outline" size="sm" onClick={() => append(newInboundForm())}>
              <Plus className="mr-1 h-4 w-4" />
              {t('coreEditor.singbox.addInbound', { defaultValue: 'Add inbound' })}
            </Button>
          </div>

          <div className="flex flex-col gap-3">
            {fields.length === 0 && (
              <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
                {t('coreEditor.singbox.noInbounds', {
                  defaultValue: 'No inbounds yet. A core with none hands users an empty subscription.',
                })}
              </div>
            )}
            {fields.map((row, index) => (
              <SingBoxInboundCard key={row.id} form={form} index={index} onRemove={() => remove(index)} />
            ))}
          </div>

          <h2 className="mb-3 mt-6 text-sm font-semibold">
            {t('coreEditor.singbox.api', { defaultValue: 'Node API' })}
          </h2>
          <div className="rounded-lg border bg-card p-4">
            <p className="mb-3 text-[11px] text-muted-foreground">
              {t('coreEditor.singbox.apiHint', {
                defaultValue:
                  'Users are pushed over clash_api and usage is read over v2ray_api. A core missing either starts and looks healthy while serving nobody or counting nothing.',
              })}
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <FormField
                control={form.control}
                name="clash_external_controller"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">clash_api</FormLabel>
                    <FormControl>
                      <Input {...field} dir="ltr" className="text-xs" placeholder="127.0.0.1:9090" />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="clash_secret"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">
                      {t('coreEditor.singbox.secret', { defaultValue: 'Secret' })}
                    </FormLabel>
                    <FormControl>
                      <Input {...field} dir="ltr" className="text-xs" />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="v2ray_listen"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">v2ray_api</FormLabel>
                    <FormControl>
                      <Input {...field} dir="ltr" className="text-xs" placeholder="127.0.0.1:8080" />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="log_level"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">{t('coreEditor.singbox.logLevel', { defaultValue: 'Log level' })}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="text-xs">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'panic'].map(level => (
                          <SelectItem key={level} value={level}>
                            {level}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
            </div>
          </div>
        </div>

        <StickySaveBar
          dirty={form.formState.isDirty}
          saving={modifyCore.isPending}
          onSave={save}
          onDiscard={() => form.reset(initial)}
          onCancel={() => navigate(-1)}
          showRestart
          restartNodes={restartNodes}
          onRestartChange={setRestartNodes}
        />
      </form>
    </Form>
  )
}
