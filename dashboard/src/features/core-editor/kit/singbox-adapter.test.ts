import { describe, expect, it } from 'bun:test'

import { configToForm, formToConfig, newInboundForm, withRawSections, type SingBoxFormValues } from './singbox-adapter'

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
  })

  it('leaves log and the api block alone — they are edited as JSON', () => {
    const before = config()
    const after = formToConfig(before, configToForm(before))
    expect(after.log).toEqual(before.log)
    expect(after.experimental.clash_api).toEqual(before.experimental.clash_api)
    expect(after.experimental.v2ray_api.listen).toBe(before.experimental.v2ray_api.listen)
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

  it('adds the wildcard to a stats list edited by hand, without dropping it', () => {
    // The block is raw JSON now, so someone can type a name into it. The panel
    // rejects a list without "*", and silently discarding what they wrote would
    // be its own surprise — so it is added alongside.
    const before: Record<string, any> = config()
    before.experimental.v2ray_api.stats.users = ['alice']
    const after = formToConfig(before, configToForm(before))
    expect(after.experimental.v2ray_api.stats.users).toEqual(['*', 'alice'])
  })

  it('does not stack wildcards when saved repeatedly', () => {
    const before = config()
    const once = formToConfig(before, configToForm(before))
    const twice = formToConfig(once, configToForm(once))
    expect(twice.experimental.v2ray_api.stats.users).toEqual(['*'])
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

describe('the sections edited as raw JSON', () => {
  // Found by opening a real core: it has no routing or dns, both tabs showed
  // "{}" so there was something to type into, and saving wrote those empties
  // back. The core gained two keys nobody asked for, and Save lit up on a
  // config that had not been touched.

  it('does not invent a section the core never had', () => {
    const cfg = { inbounds: [], outbounds: [] }
    const after = withRawSections(cfg, { route: {}, dns: {} })
    expect('route' in after).toBe(false)
    expect('dns' in after).toBe(false)
  })

  it('keeps an empty section that was already there', () => {
    // Empty because someone emptied it, which is a different fact.
    const cfg = { route: {}, inbounds: [] }
    expect(withRawSections(cfg, { route: {} }).route).toEqual({})
  })

  it('writes a section once it has something in it', () => {
    const after = withRawSections({ inbounds: [] }, { route: { final: 'direct' } })
    expect(after.route).toEqual({ final: 'direct' })
  })

  it('replaces a section that already existed', () => {
    const after = withRawSections({ dns: { servers: ['a'] } }, { dns: { servers: ['b'] } })
    expect(after.dns).toEqual({ servers: ['b'] })
  })

  it('does not modify the config it was given', () => {
    const cfg = { dns: { servers: ['a'] } }
    withRawSections(cfg, { dns: { servers: ['b'] } })
    expect(cfg.dns.servers).toEqual(['a'])
  })

  it('opening and saving a core with no routing or dns changes nothing', () => {
    // The case that actually failed: the editor seeds each tab from the config,
    // so a core without those sections seeds them as "{}" and hands that back.
    const before: Record<string, any> = config()
    delete before.route
    delete before.dns

    const after = formToConfig(withRawSections(before, { outbounds: before.outbounds, route: {}, dns: {} }), configToForm(before))

    expect('route' in after).toBe(false)
    expect('dns' in after).toBe(false)
    expect(after).toEqual(formToConfig(before, configToForm(before)))
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
