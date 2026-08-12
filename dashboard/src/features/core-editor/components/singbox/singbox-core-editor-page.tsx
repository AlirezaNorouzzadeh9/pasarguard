import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { JsonCodeEditorPanel } from '@/features/core-editor/components/shared/json-code-editor-panel'
import { Button } from '@/components/ui/button'
import { useModifyCoreConfig, type CoreCreateConfig } from '@/service/api'
import { toast } from 'sonner'

/**
 * Editing a sing-box core as JSON, deliberately.
 *
 * sing-box owns a large schema of its own, and a structured form would have to
 * track it — every protocol, every transport — or quietly drop the fields it
 * does not model. Since the config here is written verbatim to the node, a form
 * that loses a key is worse than no form at all.
 *
 * The panel already rejects a config that would start and then do nothing (no
 * clash_api, or stats that cannot count a user added later), so those mistakes
 * are caught on save rather than being the editor's job to prevent.
 */
interface Props {
  coreId: number
  coreName: string
  config: unknown
}

export default function SingBoxCoreEditorPage({ coreId, coreName, config }: Props) {
  const { t } = useTranslation()
  const serverJson = useMemo(() => JSON.stringify(config ?? {}, null, 2), [config])
  const [draft, setDraft] = useState(serverJson)
  const [parseError, setParseError] = useState<string | null>(null)
  const modifyCore = useModifyCoreConfig()

  // Re-sync when the core is reloaded from the server, but never over unsaved
  // edits — losing someone's work to a background refetch is unforgivable.
  useEffect(() => {
    setDraft(current => (current === '' || current === serverJson ? serverJson : current))
  }, [serverJson])

  const dirty = draft !== serverJson

  const onChange = (next: string) => {
    setDraft(next)
    try {
      JSON.parse(next)
      setParseError(null)
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err))
    }
  }

  const save = async () => {
    // The API type describes an xray config; a sing-box config is a different
    // shape that the panel stores verbatim, so the cast is the honest thing
    // here rather than pretending it matches.
    let parsed: CoreCreateConfig
    try {
      parsed = JSON.parse(draft) as CoreCreateConfig
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err))
      return
    }
    try {
      await modifyCore.mutateAsync({
        coreId,
        data: { name: coreName, type: 'singbox', config: parsed, exclude_inbound_tags: [], fallbacks_inbound_tags: [] },
        // A sing-box core only takes effect when the node restarts it, and a
        // saved-but-not-applied config is the kind of difference nobody notices
        // until a user cannot connect.
        params: { restart_nodes: true },
      })
      toast.success(t('coreConfig.saved', { defaultValue: 'Core saved' }))
    } catch (err: any) {
      // The panel's rejection message says exactly which setting is missing and
      // why it matters, so it is shown rather than replaced with "save failed".
      const detail = err?.response?.data?.detail
      toast.error(typeof detail === 'string' ? detail : JSON.stringify(detail ?? err?.message ?? err))
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground">
          {t('coreConfig.singboxJsonOnly', {
            defaultValue: 'sing-box cores are edited as JSON. The config is sent to the node unchanged.',
          })}
        </div>
        <Button onClick={save} disabled={!dirty || !!parseError || modifyCore.isPending}>
          {modifyCore.isPending
            ? t('saving', { defaultValue: 'Saving…' })
            : t('save', { defaultValue: 'Save' })}
        </Button>
      </div>

      {parseError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {parseError}
        </div>
      )}

      <JsonCodeEditorPanel value={draft} onChange={onChange} className="min-h-0 flex-1" />
    </div>
  )
}
