/**
 * How an OpenVPN core's client subnet is divided between its listeners.
 *
 * The node runs one server process per listener and gives each an equal slice
 * of the subnet, and a slice narrower than a /24 is refused. Both the editor
 * and the overview show that, so the rule lives here rather than in either of
 * them — two copies of an arithmetic rule drift, and the one that drifts is the
 * one nobody is looking at.
 */
export const subnetCapacity = (subnet: string, count: number): { perListener: number; tooSmall: boolean } | null => {
  const prefix = Number((subnet || '').split('/')[1])
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32 || count < 1) return null
  const extraBits = count > 1 ? 32 - Math.clz32(count - 1) : 0
  const perListener = prefix + extraBits
  return { perListener, tooSmall: perListener > 24 }
}
