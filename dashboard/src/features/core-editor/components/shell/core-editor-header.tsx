import { ArrowLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import useDirDetection from '@/hooks/use-dir-detection'
import { cn } from '@/lib/utils'

/** The `kind` query parameter each editor is reached by. */
export type CoreEditorKind = 'xray' | 'wg' | 'openvpn' | 'singbox' | 'l2tp'

/**
 * Every core type the editor can open, and what it is called.
 *
 * One list, because there were four: each editor carried its own copy of this
 * header, and they drifted — sing-box showed a static label with no way out of
 * it at all, and OpenVPN's offered three of the five types, so from there you
 * could not start a sing-box or L2TP core.
 */
export const CORE_KINDS: { value: CoreEditorKind; label: string }[] = [
  { value: 'xray', label: 'Xray' },
  { value: 'wg', label: 'WireGuard' },
  { value: 'openvpn', label: 'OpenVPN' },
  { value: 'singbox', label: 'SingBox' },
  { value: 'l2tp', label: 'L2TP' },
]

export interface CoreEditorHeaderProps {
  /** Which type this editor is editing; selects the matching entry. */
  kind: CoreEditorKind
  name: string
  onNameChange: (value: string) => void
  /** A new core can still change type; an existing one cannot be converted. */
  isNew: boolean
  namePlaceholder?: string
  nameInvalid?: boolean
  /** Where the back arrow goes. Defaults to one step back in history. */
  onBack?: () => void
  /**
   * Called instead of the default query-parameter switch, for an editor that
   * has to do something first (an xray core can change kind in place).
   */
  onKindChange?: (kind: CoreEditorKind) => void
}

/**
 * The bar above every core editor: back, the core's name, and its type.
 */
export function CoreEditorHeader({ kind, name, onNameChange, isNew, namePlaceholder, nameInvalid, onBack, onKindChange }: CoreEditorHeaderProps) {
  const { t } = useTranslation()
  const dir = useDirDetection()
  const navigate = useNavigate()
  const [, setSearchParams] = useSearchParams()

  const switchKind = (value: string) => {
    const next = value as CoreEditorKind
    if (next === kind) return
    // The type of a core that already exists is not something this screen can
    // convert, so the control is read-only there.
    if (!isNew) return
    if (onKindChange) {
      onKindChange(next)
      return
    }
    setSearchParams(
      prev => {
        const params = new URLSearchParams(prev)
        // xray is the editor's default, so it is the absence of a kind.
        if (next === 'xray') params.delete('kind')
        else params.set('kind', next)
        return params
      },
      { replace: true },
    )
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn('h-11 w-11 shrink-0', dir === 'rtl' && 'rotate-180')}
        onClick={() => (onBack ? onBack() : navigate(-1))}
        aria-label={t('back', { defaultValue: 'Back' })}
      >
        <ArrowLeft className="h-5 w-5" />
      </Button>
      <div className="grid min-w-0 max-w-2xl flex-1 grid-cols-[1fr_auto] items-center gap-2 sm:gap-3">
        <Input
          value={name}
          onChange={e => onNameChange(e.target.value)}
          className="h-10 font-medium"
          placeholder={namePlaceholder ?? t('coreConfigModal.namePlaceholder', { defaultValue: 'Core name' })}
          aria-invalid={nameInvalid}
        />
        <Select value={kind} onValueChange={switchKind} disabled={!isNew}>
          <SelectTrigger className="h-10 w-28 shrink-0 px-2 sm:w-[180px] sm:px-3" aria-label={t('coreConfigModal.backendType', { defaultValue: 'Backend type' })}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CORE_KINDS.map(entry => (
              <SelectItem key={entry.value} value={entry.value}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
