import { describe, expect, it } from 'bun:test'

import { configToForm, formToConfig, newInboundForm, type SingBoxFormValues } from './singbox-adapter'

/**
 * The risk a form over sing-box carries is losing a key, not showing a wrong
 * value: the config goes to the node verbatim, so a field this editor does not
 * model must survive being edited by it. Everything here is about that.
 */

const config = () => ({
  log: { level: 'info', timestamp: true },
  dns: { servers: [{ tag: 'google', address: '8.8.8.8' }] },
  route: { rules: [{ protocol: 'dns', outbound: 'dns-out' }], final: 'direct' },
  ntp: { enabled: true, server: 'time.apple.com' },
  experimental: {
    clash_api: { external_controller: '127.0.0.1:9090', secret: 's3cret', external_ui: 'ui' },
    v2ray_api: { listen: '127.0.0.1:8080', stats: { enabled: true, users: ['*'], inbounds: ['hy2'] } },
  },
  inbounds: [
    {
      type: 'hysteria2',
      tag: 'hy2',
      listen: '::',
      listen_port: 443,
      users: [{ name: 'seed', password: 'seed-pw' }],
      obfs: { type: 'salamander', password: 'abcdef' },
      tls: { enabled: true, server_name: 'a.example', certificate_path: '/c.pem', key_path: '/k.pem' },
      // Not modelled by the form, and must not be dropped by it.
      masquerade: 'https://example.com',
      brutal_debug: true,
      ignore_client_bandwidth: false,
    },
  ],
  outbounds: [{ type: 'direct', tag: 'direct' }],
})

const edit = (values: SingBoxFormValues, mutate: (v: SingBoxFormValues) => void) => {
  mutate(values)
  return values
}

describe('reading a config into the form', () => {
  it('describes the inbound the way the fields expect', () => {
    const form = configToForm(config())
    expect(form.inbounds).toHaveLength(1)
    const [hy2] = form.inbounds
    expect(hy2.type).toBe('hysteria2')
    expect(hy2.listen_port).toBe('443')
    expect(hy2.tls.enabled).toBe(true)
    expect(hy2.tls.server_name).toBe('a.example')
    expect(hy2.obfs_password).toBe('abcdef')
    expect(form.clash_external_controller).toBe('127.0.0.1:9090')
  })

  it('leaves an inbound it cannot describe out of the form', () => {
    const cfg = config()
    cfg.inbounds.push({ type: 'mixed', tag: 'local', listen_port: 2080 } as never)
    expect(configToForm(cfg).inbounds.map(i => i.tag)).toEqual(['hy2'])
  })
})

describe('writing the form back', () => {
  it('keeps every section the editor does not touch', () => {
    const before = config()
    const after = formToConfig(before, configToForm(before))

    expect(after.dns).toEqual(before.dns)
    expect(after.route).toEqual(before.route)
    expect(after.ntp).toEqual(before.ntp)
    expect(after.outbounds).toEqual(before.outbounds)
    expect(after.experimental.clash_api.external_ui).toBe('ui')
  })

  it('keeps inbound keys the form has never heard of', () => {
    const before = config()
    const after = formToConfig(
      before,
      edit(configToForm(before), v => {
        v.inbounds[0].listen_port = '8443'
      }),
    )
    const [hy2] = after.inbounds
    expect(hy2.listen_port).toBe(8443)
    expect(hy2.masquerade).toBe('https://example.com')
    expect(hy2.brutal_debug).toBe(true)
    expect(hy2.ignore_client_bandwidth).toBe(false)
  })

  it('does not modify the config it was given', () => {
    const before = config()
    const snapshot = JSON.parse(JSON.stringify(before))
    formToConfig(
      before,
      edit(configToForm(before), v => {
        v.inbounds[0].tag = 'renamed'
      }),
    )
    expect(before).toEqual(snapshot)
  })

  it('leaves an unsupported inbound in the config even though it was never shown', () => {
    const cfg = config()
    cfg.inbounds.push({ type: 'mixed', tag: 'local', listen_port: 2080 } as never)
    const after = formToConfig(cfg, configToForm(cfg))
    expect(after.inbounds.map((i: { tag: string }) => i.tag).sort()).toEqual(['hy2', 'local'])
  })

  it('keeps the user list rather than editing it, since the node replaces it', () => {
    const before = config()
    const after = formToConfig(before, configToForm(before))
    expect(after.inbounds[0].users).toEqual([{ name: 'seed', password: 'seed-pw' }])
  })
})

describe('settings that fail quietly if got wrong', () => {
  it('always asks for stats on every user', () => {
    // The list is read once at startup: name users individually and everyone
    // created afterwards passes traffic counted against nobody.
    const before = config()
    const after = formToConfig(before, configToForm(before))
    expect(after.experimental.v2ray_api.stats.users).toEqual(['*'])
    expect(after.experimental.v2ray_api.stats.enabled).toBe(true)
  })

  it('records every inbound tag for stats, including ones just added', () => {
    const before = config()
    const after = formToConfig(
      before,
      edit(configToForm(before), v => {
        v.inbounds.push({ ...newInboundForm('vless'), tag: 'vl', listen_port: '8443' })
      }),
    )
    expect(after.experimental.v2ray_api.stats.inbounds).toEqual(['hy2', 'vl'])
  })

  it('never leaves a shadowsocks inbound without users', () => {
    // sing-box builds the multi-user inbound only when users is non-empty. The
    // single-user one it builds otherwise cannot be given users later: the
    // node's push is refused, its start fails, and it stops the whole core —
    // taking every other inbound down with it.
    const before = config()
    const after = formToConfig(
      before,
      edit(configToForm(before), v => {
        v.inbounds.push({ ...newInboundForm('shadowsocks'), tag: 'ss', listen_port: '8388' })
      }),
    )
    const ss = after.inbounds.find((i: { tag: string }) => i.tag === 'ss')
    expect(ss.users.length).toBeGreaterThan(0)
    expect(ss.method).toBe('aes-128-gcm')
  })
})

describe('per-protocol fields', () => {
  it('drops a transport when the protocol has none', () => {
    const before = config()
    const after = formToConfig(
      before,
      edit(configToForm(before), v => {
        v.inbounds[0].transport_type = 'ws' // hysteria2 has no stream transport
      }),
    )
    expect(after.inbounds[0].transport).toBeUndefined()
  })

  it('carries a websocket transport for the protocols that have one', () => {
    const before = config()
    const after = formToConfig(
      before,
      edit(configToForm(before), v => {
        v.inbounds.push({
          ...newInboundForm('vless'),
          tag: 'vl',
          listen_port: '8443',
          transport_type: 'ws',
          transport_path: '/x',
          transport_host: 'a.example, b.example',
        })
      }),
    )
    const vl = after.inbounds.find((i: { tag: string }) => i.tag === 'vl')
    expect(vl.transport).toEqual({ type: 'ws', path: '/x', host: ['a.example', 'b.example'] })
  })

  it('drops obfs when the password is cleared', () => {
    const before = config()
    const after = formToConfig(
      before,
      edit(configToForm(before), v => {
        v.inbounds[0].obfs_password = ''
      }),
    )
    expect(after.inbounds[0].obfs).toBeUndefined()
  })

  it('keeps certificate paths when TLS is switched off', () => {
    // Otherwise toggling it off and on again silently empties the fields.
    const before = config()
    const after = formToConfig(
      before,
      edit(configToForm(before), v => {
        v.inbounds[0].tls.enabled = false
      }),
    )
    expect(after.inbounds[0].tls).toMatchObject({ enabled: false, certificate_path: '/c.pem' })
  })
})
