import { describe, expect, it } from 'bun:test'

import { HostFormSchema, hostFormDefaultValues } from './host-form'

// An OpenVPN host has no address input — it supplies addresses through the
// remotes editor, and the submit handler derives the address list from them.
// The schema used to require a non-empty address regardless, so the form failed
// on a field that was not rendered: Save did nothing and said nothing.
const base = { ...hostFormDefaultValues, remark: 'germany', inbound_tag: 'open_de' }

describe('HostFormSchema address requirement', () => {
  it('accepts an OpenVPN host whose address comes from remotes', () => {
    const result = HostFormSchema.safeParse({
      ...base,
      address: [],
      openvpn_overrides: { remotes: [{ host: '88.218.19.12' }] },
    })
    expect(result.success).toBe(true)
  })

  it('still accepts an ordinary host with an address', () => {
    const result = HostFormSchema.safeParse({ ...base, address: ['example.com'] })
    expect(result.success).toBe(true)
  })

  it('rejects a host with neither, and blames the address field', () => {
    const result = HostFormSchema.safeParse({ ...base, address: [] })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.join('.') === 'address')).toBe(true)
    }
  })

  it('does not count a blank remote host as an address', () => {
    const result = HostFormSchema.safeParse({
      ...base,
      address: [],
      openvpn_overrides: { remotes: [{ host: '   ' }] },
    })
    expect(result.success).toBe(false)
  })
})
