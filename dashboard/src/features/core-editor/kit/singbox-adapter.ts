/**
 * Between a sing-box config and the form that edits it.
 *
 * The danger with a form over sing-box is not a wrong value, it is a missing
 * one: the config is written to the node verbatim, sing-box owns a large schema,
 * and any key the form does not model would be dropped on save. So the form
 * never rebuilds the config — it edits a copy of the original and writes back
 * only the fields it owns. Outbounds, route, dns, ntp, anything this file has
 * never heard of, survive untouched.
 *
 * The same applies inside an inbound: an inbound the form knows keeps every key
 * the form does not.
 */

export const SINGBOX_INBOUND_TYPES = ['hysteria2', 'vless', 'vmess', 'trojan', 'shadowsocks'] as const
export type SingBoxInboundType = (typeof SINGBOX_INBOUND_TYPES)[number]

export const TRANSPORT_TYPES = ['', 'ws', 'grpc', 'http', 'httpupgrade', 'quic'] as const

/** Only QUIC-based protocols cannot run without TLS. */
export const TLS_REQUIRED: ReadonlySet<string> = new Set(['hysteria2'])

/** Where obfuscation applies at all. */
export const SUPPORTS_OBFS: ReadonlySet<string> = new Set(['hysteria2'])

/** Where a cipher belongs on the inbound rather than on the user. */
export const SUPPORTS_METHOD: ReadonlySet<string> = new Set(['shadowsocks'])

/** Where a stream transport can be configured. */
export const SUPPORTS_TRANSPORT: ReadonlySet<string> = new Set(['vless', 'vmess', 'trojan'])

export interface TlsForm {
  enabled: boolean
  server_name: string
  certificate_path: string
  key_path: string
  alpn: string
}

export interface InboundForm {
  /** Position in the original inbounds array, or null for one added here. */
  sourceIndex: number | null
  type: SingBoxInboundType
  tag: string
  listen: string
  listen_port: string
  udp_timeout: string
  tls: TlsForm
  transport_type: string
  transport_path: string
  transport_host: string
  transport_service_name: string
  obfs_password: string
  method: string
}

export interface SingBoxFormValues {
  log_level: string
  clash_external_controller: string
  clash_secret: string
  v2ray_listen: string
  inbounds: InboundForm[]
}

type Dict = Record<string, any>

const asDict = (value: unknown): Dict => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Dict) : {})
const str = (value: unknown): string => (value === undefined || value === null ? '' : String(value))

const emptyTls = (): TlsForm => ({ enabled: false, server_name: '', certificate_path: '', key_path: '', alpn: '' })

export const isSupportedType = (type: unknown): type is SingBoxInboundType =>
  SINGBOX_INBOUND_TYPES.includes(type as SingBoxInboundType)

/** A blank inbound, for the Add button. */
export const newInboundForm = (type: SingBoxInboundType = 'vless'): InboundForm => ({
  sourceIndex: null,
  type,
  tag: '',
  listen: '::',
  listen_port: '',
  udp_timeout: '',
  tls: { ...emptyTls(), enabled: TLS_REQUIRED.has(type) },
  transport_type: '',
  transport_path: '',
  transport_host: '',
  transport_service_name: '',
  obfs_password: '',
  method: type === 'shadowsocks' ? 'aes-128-gcm' : '',
})

export function configToForm(config: unknown): SingBoxFormValues {
  const cfg = asDict(config)
  const experimental = asDict(cfg.experimental)
  const clash = asDict(experimental.clash_api)
  const v2ray = asDict(experimental.v2ray_api)
  const rawInbounds = Array.isArray(cfg.inbounds) ? cfg.inbounds : []

  const inbounds: InboundForm[] = []
  rawInbounds.forEach((raw, index) => {
    const inbound = asDict(raw)
    // An inbound of a type the panel cannot describe to a client is left alone
    // entirely — it stays in the config and simply is not offered for editing.
    if (!isSupportedType(inbound.type)) return

    const tls = asDict(inbound.tls)
    const transport = asDict(inbound.transport)
    const obfs = asDict(inbound.obfs)

    inbounds.push({
      sourceIndex: index,
      type: inbound.type,
      tag: str(inbound.tag),
      listen: str(inbound.listen),
      listen_port: str(inbound.listen_port),
      udp_timeout: str(inbound.udp_timeout),
      tls: {
        enabled: Boolean(tls.enabled),
        server_name: str(tls.server_name),
        certificate_path: str(tls.certificate_path),
        key_path: str(tls.key_path),
        alpn: Array.isArray(tls.alpn) ? tls.alpn.join(', ') : str(tls.alpn),
      },
      transport_type: str(transport.type),
      transport_path: str(transport.path),
      transport_host: Array.isArray(transport.host) ? transport.host.join(', ') : str(transport.host),
      transport_service_name: str(transport.service_name),
      obfs_password: str(obfs.password),
      method: str(inbound.method),
    })
  })

  return {
    log_level: str(asDict(cfg.log).level) || 'info',
    clash_external_controller: str(clash.external_controller),
    clash_secret: str(clash.secret),
    v2ray_listen: str(v2ray.listen),
    inbounds,
  }
}

const splitList = (raw: string): string[] =>
  raw
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)

/**
 * Apply one form row onto its original inbound, keeping every key not modelled.
 */
function mergeInbound(original: Dict, form: InboundForm): Dict {
  const out: Dict = { ...original }

  out.type = form.type
  out.tag = form.tag.trim()
  if (form.listen.trim()) out.listen = form.listen.trim()
  const port = Number(form.listen_port)
  if (Number.isInteger(port) && port > 0) out.listen_port = port

  if (form.udp_timeout.trim()) out.udp_timeout = form.udp_timeout.trim()
  else delete out.udp_timeout

  // TLS
  if (form.tls.enabled) {
    const tls: Dict = { ...asDict(original.tls), enabled: true }
    const assign = (key: string, value: string) => {
      if (value.trim()) tls[key] = value.trim()
      else delete tls[key]
    }
    assign('server_name', form.tls.server_name)
    assign('certificate_path', form.tls.certificate_path)
    assign('key_path', form.tls.key_path)
    const alpn = splitList(form.tls.alpn)
    if (alpn.length) tls.alpn = alpn
    else delete tls.alpn
    out.tls = tls
  } else if (original.tls !== undefined) {
    // Kept rather than deleted, so certificate paths already entered are not
    // lost by toggling TLS off and on again.
    out.tls = { ...asDict(original.tls), enabled: false }
  }

  // Stream transport
  if (SUPPORTS_TRANSPORT.has(form.type) && form.transport_type) {
    const transport: Dict = { ...asDict(original.transport), type: form.transport_type }
    if (form.transport_path.trim()) transport.path = form.transport_path.trim()
    else delete transport.path
    const hosts = splitList(form.transport_host)
    if (hosts.length) transport.host = hosts
    else delete transport.host
    if (form.transport_service_name.trim()) transport.service_name = form.transport_service_name.trim()
    else delete transport.service_name
    out.transport = transport
  } else {
    delete out.transport
  }

  // Obfuscation
  if (SUPPORTS_OBFS.has(form.type) && form.obfs_password.trim()) {
    out.obfs = { ...asDict(original.obfs), type: 'salamander', password: form.obfs_password.trim() }
  } else {
    delete out.obfs
  }

  // Cipher
  if (SUPPORTS_METHOD.has(form.type)) {
    if (form.method.trim()) out.method = form.method.trim()
  } else {
    delete out.method
  }

  // Users are replaced by the node at runtime, so the list here is only a seed
  // and is never edited by this form. It cannot be empty for shadowsocks:
  // sing-box picks the multi-user inbound only when users is non-empty, and the
  // single-user one it picks otherwise has no way to be given users later — the
  // node's push is refused and the whole core stops, taking every other inbound
  // on it down too.
  if (!Array.isArray(out.users)) out.users = []
  if (form.type === 'shadowsocks' && out.users.length === 0) {
    out.users = [{ name: 'seed', password: 'c2VlZHNlZWRzZWVkc2VlZA==' }]
  }

  return out
}

/**
 * Write the form back over the config it came from.
 *
 * `original` is not modified.
 */
export function formToConfig(original: unknown, values: SingBoxFormValues): Dict {
  const cfg: Dict = structuredClone(asDict(original))
  const rawInbounds: unknown[] = Array.isArray(cfg.inbounds) ? cfg.inbounds : []

  // Rows the form never showed keep their place; the ones it did are rebuilt in
  // the order the form has them.
  const edited = new Set(values.inbounds.map(row => row.sourceIndex).filter((i): i is number => i !== null))
  const untouched = rawInbounds.filter((_, index) => !edited.has(index))

  cfg.inbounds = [
    ...untouched,
    ...values.inbounds.map(row => mergeInbound(row.sourceIndex === null ? {} : asDict(rawInbounds[row.sourceIndex]), row)),
  ]

  cfg.log = { ...asDict(cfg.log), level: values.log_level }

  const experimental: Dict = { ...asDict(cfg.experimental) }
  experimental.clash_api = {
    ...asDict(experimental.clash_api),
    external_controller: values.clash_external_controller.trim(),
    secret: values.clash_secret,
  }

  const v2ray: Dict = { ...asDict(experimental.v2ray_api) }
  v2ray.listen = values.v2ray_listen.trim()
  v2ray.stats = {
    ...asDict(v2ray.stats),
    enabled: true,
    // Read once at startup, so naming users individually would leave everyone
    // created later passing traffic counted against nobody. The panel rejects
    // anything else, and there is no reason to offer it as a choice.
    users: ['*'],
    inbounds: (cfg.inbounds as Dict[]).map(inbound => str(inbound.tag)).filter(Boolean),
  }
  experimental.v2ray_api = v2ray
  cfg.experimental = experimental

  return cfg
}
