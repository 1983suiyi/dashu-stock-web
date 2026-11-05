import type { KlineResult } from '../types'

/** 每批请求的标的数量，避免单次 URL 过长 */
const BATCH_SIZE = 120

/** 6 位代码 → 腾讯行情符号（sh/sz/bj） */
export const toSymbol = (code: string): string | null => {
  if (/^[69]/.test(code)) return `sh${code}`
  if (/^[023]/.test(code)) return `sz${code}`
  if (/^[48]/.test(code)) return `bj${code}`
  return null
}

export type KlineBatch = {
  data: Record<string, KlineResult>
  failed: string[]
}

/** 通过后端代理批量获取前复权一年内最低价 */
export const fetchKlines = async (
  codes: string[],
  days: number,
  onProgress?: (done: number, total: number) => void,
): Promise<KlineBatch> => {
  const symbols = codes
    .map(toSymbol)
    .filter((symbol): symbol is string => symbol !== null)

  const data: Record<string, KlineResult> = {}
  const failed: string[] = []

  for (let index = 0; index < symbols.length; index += BATCH_SIZE) {
    const slice = symbols.slice(index, index + BATCH_SIZE)
    const params = new URLSearchParams({
      codes: slice.join(','),
      days: String(days),
    })

    const response = await fetch(`/api/kline?${params.toString()}`)
    if (!response.ok) {
      throw new Error(`K 线代理返回 HTTP ${response.status}`)
    }

    const payload = (await response.json()) as Partial<KlineBatch>
    Object.assign(data, payload.data ?? {})
    if (payload.failed) failed.push(...payload.failed)

    onProgress?.(
      Math.min(index + BATCH_SIZE, symbols.length),
      symbols.length,
    )
  }

  return { data, failed }
}

/** 把 K 线结果回填到股票记录 */
export const applyKline = <
  T extends { code: string; lowPrice1y: number | null },
>(
  stocks: T[],
  kline: Record<string, KlineResult>,
): T[] =>
  stocks.map((stock) => {
    const symbol = toSymbol(stock.code)
    const entry = symbol ? kline[symbol] : undefined
    if (!entry || entry.low1y === null) return stock
    return { ...stock, lowPrice1y: entry.low1y }
  })
