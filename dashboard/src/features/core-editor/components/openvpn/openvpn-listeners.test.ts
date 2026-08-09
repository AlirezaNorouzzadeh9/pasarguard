import { describe, expect, it } from 'bun:test'

import { configToListenerRows, parseRows, subnetCapacity } from './openvpn-core-editor-page'

// The editor now edits endpoints only as a list, and derives port/proto from
// the first row. The risk in that change is existing cores: one saved before
// the list existed carries only port/proto, and one saved with a list carries
// both. Both have to open showing the right rows.

describe('configToListenerRows', () => {
  it('reads the list when the config has one', () => {
    expect(
      configToListenerRows({
        port: 7071,
        proto: 'udp',
        listeners: [
          { port: 7071, proto: 'udp' },
          { port: 7071, proto: 'tcp' },
        ],
      }),
    ).toEqual([
      { port: '7071', proto: 'udp' },
      { port: '7071', proto: 'tcp' },
    ])
  })

  it('falls back to port/proto for a config saved before the list existed', () => {
    expect(configToListenerRows({ port: 1194, proto: 'tcp' })).toEqual([{ port: '1194', proto: 'tcp' }])
  })

  it('defaults a missing protocol to udp rather than dropping the row', () => {
    expect(configToListenerRows({ port: 1194 })).toEqual([{ port: '1194', proto: 'udp' }])
  })

  it('returns nothing when there is neither', () => {
    expect(configToListenerRows({})).toEqual([])
  })
})

describe('parseRows', () => {
  it('drops rows that are blank or out of range', () => {
    expect(
      parseRows([
        { port: '1194', proto: 'udp' },
        { port: '', proto: 'udp' },
        { port: '70000', proto: 'tcp' },
        { port: '443', proto: 'tcp' },
      ]),
    ).toEqual([
      { port: 1194, proto: 'udp' },
      { port: 443, proto: 'tcp' },
    ])
  })

  it('keeps a single row instead of discarding it', () => {
    // The old code sent `undefined` for one entry, so a lone row in the list
    // silently did nothing and the separate port field won instead.
    expect(parseRows([{ port: '1194', proto: 'udp' }])).toEqual([{ port: 1194, proto: 'udp' }])
  })
})

describe('subnetCapacity', () => {
  it('matches the backend split for the common cases', () => {
    expect(subnetCapacity('10.29.0.0/16', 1)).toEqual({ perListener: 16, tooSmall: false })
    expect(subnetCapacity('10.29.0.0/16', 2)).toEqual({ perListener: 17, tooSmall: false })
    expect(subnetCapacity('10.29.0.0/16', 3)).toEqual({ perListener: 18, tooSmall: false })
    expect(subnetCapacity('10.29.0.0/16', 8)).toEqual({ perListener: 19, tooSmall: false })
  })

  it('flags a subnet that cannot be split that far', () => {
    expect(subnetCapacity('10.29.0.0/24', 2)).toEqual({ perListener: 25, tooSmall: true })
    expect(subnetCapacity('10.29.0.0/22', 8)).toEqual({ perListener: 25, tooSmall: true })
  })

  it('says nothing when the subnet is not a prefix yet', () => {
    expect(subnetCapacity('10.29.0.0', 2)).toBeNull()
    expect(subnetCapacity('', 2)).toBeNull()
  })
})
