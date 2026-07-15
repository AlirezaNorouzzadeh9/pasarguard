import { memo, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Download,
  ShieldCheck,
  Zap,
  KeyRound,
  FileDown,
  Copy,
  Check,
  Server,
  User,
  Lock,
} from 'lucide-react';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { cn } from '@/lib/utils';
import type { DownloadEntry, IKEv2Detail } from '@/types/global';

/**
 * File-based backends (OpenVPN / WireGuard / IKEv2) delivered by this fork.
 * Each host is one downloadable file, surfaced as its own card. Data comes from
 * the Jinja-injected __INITIAL_DATA__ (inline base64 data: URLs — no round-trip).
 */

const readInitial = () =>
  (typeof window !== 'undefined' ? window.__INITIAL_DATA__ : undefined) ?? {};

const triggerDownload = (entry: DownloadEntry, onDone: () => void) => {
  try {
    const a = document.createElement('a');
    a.href = entry.data_url;
    a.download = entry.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    onDone();
  } catch (error) {
    console.error('Download failed:', error);
    toast.error('Download failed');
  }
};

interface FileCardProps {
  entry: DownloadEntry;
  accentClass: string;
  icon: ReactNode;
  downloadLabel: string;
}

const FileCard = memo(({ entry, accentClass, icon, downloadLabel }: FileCardProps) => {
  const startedLabel = useTranslation().t('configActions.downloadStarted');
  return (
    <div className="group flex flex-col gap-3 p-4 rounded-2xl border bg-card hover:border-primary/50 hover:shadow-lg hover:shadow-primary/5 transition-all duration-200">
      <div className="flex items-center gap-3 min-w-0">
        <div className={cn('shrink-0 flex items-center justify-center w-10 h-10 rounded-xl', accentClass)}>
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div dir="ltr" className="page-item-title truncate" title={entry.name}>
            {entry.name}
          </div>
          <div dir="ltr" className="page-meta truncate font-mono text-xs" title={entry.filename}>
            {entry.filename}
          </div>
        </div>
      </div>
      <button
        onClick={() => triggerDownload(entry, () => toast.success(startedLabel))}
        className="mt-auto flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold cursor-pointer transition-all duration-200 hover:bg-primary/90 active:scale-[0.98]"
      >
        <Download className="w-4 h-4" />
        {downloadLabel}
      </button>
    </div>
  );
});

interface GroupProps {
  title: string;
  subtitle: string;
  badgeClass: string;
  badgeIcon: ReactNode;
  children: ReactNode;
}

const Group = memo(({ title, subtitle, badgeClass, badgeIcon, children }: GroupProps) => (
  <div className="space-y-3">
    <div className="flex items-center gap-3">
      <div className={cn('shrink-0 flex items-center justify-center w-9 h-9 rounded-xl', badgeClass)}>
        {badgeIcon}
      </div>
      <div className="min-w-0">
        <div className="page-item-title font-semibold">{title}</div>
        <div className="page-meta">{subtitle}</div>
      </div>
    </div>
    {children}
  </div>
));

const IKEv2Card = memo(({ detail }: { detail: IKEv2Detail }) => {
  const { t } = useTranslation();
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  const rows: Array<{ key: string; label: string; value: string; icon: ReactNode }> = [
    { key: `srv:${detail.remark}`, label: t('ikev2.server'), value: detail.server, icon: <Server className="w-3.5 h-3.5" /> },
    { key: `usr:${detail.remark}`, label: t('ikev2.username'), value: detail.username, icon: <User className="w-3.5 h-3.5" /> },
    { key: `pwd:${detail.remark}`, label: t('ikev2.password'), value: detail.password, icon: <Lock className="w-3.5 h-3.5" /> },
  ];

  return (
    <div className="flex flex-col gap-3 p-4 rounded-2xl border bg-card hover:border-primary/50 transition-all duration-200">
      <div className="flex items-center gap-2 page-item-title font-semibold">
        <KeyRound className="w-4 h-4 text-violet-500" />
        <span dir="ltr" className="truncate" title={detail.remark}>{detail.remark}</span>
      </div>
      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center gap-2 p-2 rounded-lg border bg-background/50">
            <span className="shrink-0 text-muted-foreground">{row.icon}</span>
            <span className="shrink-0 w-16 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {row.label}
            </span>
            <span dir="ltr" className="flex-1 min-w-0 truncate font-mono text-xs" title={row.value}>
              {row.value}
            </span>
            <button
              onClick={() => copyToClipboard(row.value, row.key)}
              className={cn(
                'shrink-0 p-1.5 rounded transition-all cursor-pointer',
                isCopied(row.key)
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted hover:bg-primary hover:text-primary-foreground'
              )}
              title={t('qr.copy')}
            >
              {isCopied(row.key) ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          </div>
        ))}
      </div>
      {detail.download && (
        <button
          onClick={() => triggerDownload(detail.download!, () => toast.success(t('configActions.downloadStarted')))}
          className="mt-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold cursor-pointer transition-all duration-200 hover:bg-primary/90 active:scale-[0.98]"
        >
          <FileDown className="w-4 h-4" />
          {t('configDownloads.downloadApple')}
        </button>
      )}
    </div>
  );
});

export const ConfigDownloads = memo(() => {
  const { t } = useTranslation();

  const { openvpn, wireguard, ikev2 } = useMemo(() => {
    const initial = readInitial();
    return {
      openvpn: initial.openvpn_configs ?? [],
      wireguard: initial.wireguard_configs ?? [],
      ikev2: initial.ikev2_details ?? [],
    };
  }, []);

  const hasAny = openvpn.length > 0 || wireguard.length > 0 || ikev2.length > 0;
  if (!hasAny) return null;

  return (
    <div className="space-y-5 animate-fadeIn">
      <h2 className="page-section-title flex items-center gap-2">
        <Download className="w-5 h-5 text-primary" />
        {t('configDownloads.title')}
      </h2>

      {openvpn.length > 0 && (
        <Group
          title="OpenVPN"
          subtitle={t('configDownloads.countProfiles', { count: openvpn.length })}
          badgeClass="bg-primary/15 text-primary"
          badgeIcon={<ShieldCheck className="w-5 h-5" />}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {openvpn.map((entry) => (
              <FileCard
                key={entry.filename}
                entry={entry}
                accentClass="bg-primary/15 text-primary"
                icon={<ShieldCheck className="w-5 h-5" />}
                downloadLabel={t('configDownloads.download')}
              />
            ))}
          </div>
        </Group>
      )}

      {wireguard.length > 0 && (
        <Group
          title="WireGuard"
          subtitle={t('configDownloads.countTunnels', { count: wireguard.length })}
          badgeClass="bg-green-500/15 text-green-600 dark:text-green-500"
          badgeIcon={<Zap className="w-5 h-5" />}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {wireguard.map((entry) => (
              <FileCard
                key={entry.filename}
                entry={entry}
                accentClass="bg-green-500/15 text-green-600 dark:text-green-500"
                icon={<Zap className="w-5 h-5" />}
                downloadLabel={t('configDownloads.download')}
              />
            ))}
          </div>
        </Group>
      )}

      {ikev2.length > 0 && (
        <Group
          title={t('configDownloads.ikev2')}
          subtitle={t('configDownloads.countHosts', { count: ikev2.length })}
          badgeClass="bg-violet-500/15 text-violet-600 dark:text-violet-500"
          badgeIcon={<KeyRound className="w-5 h-5" />}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {ikev2.map((detail) => (
              <IKEv2Card key={detail.remark} detail={detail} />
            ))}
          </div>
        </Group>
      )}
    </div>
  );
});
