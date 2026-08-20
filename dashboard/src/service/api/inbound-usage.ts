/**
 * Hand-written client for GET /api/node/inbounds/usage.
 *
 * Mirrors the shape orval generates so the next `bun gen:api` run (which reads
 * the panel's openapi.json and regenerates index.ts) can supersede this file —
 * at that point switch the imports over and delete it.
 */
import { useQuery } from '@tanstack/react-query'
import type { UseQueryOptions } from '@tanstack/react-query'

import { orvalFetcher } from '../http'
import type { NodeUsageStat, Period } from './index'

export interface InboundUsageStatsList {
  period?: Period | null
  start: string
  end: string
  /** Keyed by inbound tag (summed across nodes unless node_id narrows the query). */
  stats: { [tag: string]: NodeUsageStat[] }
}

export type GetInboundUsageParams = {
  period?: Period
  node_id?: number | null
  start?: string | null
  end?: string | null
}

export const getInboundUsage = (params?: GetInboundUsageParams, signal?: AbortSignal) => {
  return orvalFetcher<InboundUsageStatsList>({ url: `/api/node/inbounds/usage`, method: 'GET', params, signal })
}

export const getGetInboundUsageQueryKey = (params?: GetInboundUsageParams) => {
  return [`/api/node/inbounds/usage`, ...(params ? [params] : [])] as const
}

export function useGetInboundUsage(
  params?: GetInboundUsageParams,
  options?: { query?: Partial<UseQueryOptions<InboundUsageStatsList, unknown, InboundUsageStatsList>> },
) {
  const { query: queryOptions } = options ?? {}
  return useQuery({
    queryKey: queryOptions?.queryKey ?? getGetInboundUsageQueryKey(params),
    queryFn: ({ signal }) => getInboundUsage(params, signal),
    ...queryOptions,
  })
}
