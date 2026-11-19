/**
 * 行业 PB 底（行业统计口径）：
 * 对每个细分行业（东财 BOARD_NAME），取历史各期个股 PB 分布的第 5 百分位数，
 * 再取历史最低值作为该行业的「PB 底」。
 *
 * 这与「大数模拟器」的「行业统计 PB 底」口径一致：
 *  中药Ⅲ ≈ 0.89，服装家纺 ≈ 0.64。
 */
import https from 'node:https'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CACHE_FILE = resolve(__dirname, 'pb-floor-cache.json')
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 天

const fetchJson = (url) =>
  new Promise((resolve, reject) => {
    https
      .get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Referer: 'https://data.eastmoney.com/',
        },
      })
      .on('error', reject)
      .on('response', (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch (e) {
            reject(e)
          }
        })
      })
  })

const percentile = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b)
  const idx = (s.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return s[lo] + (s[hi] - s[lo]) * (idx - lo)
}

// 生成从 startYear 到当前的每月 1 号日期列表
const generateMonthlyDates = (startYear = 2018) => {
  const dates = []
  const now = new Date()
  for (let y = startYear; y <= now.getFullYear(); y++) {
    for (let m = 1; m <= 12; m++) {
      const d = new Date(y, m - 1, 1)
      if (d > now) break
      dates.push(`${y}-${String(m).padStart(2, '0')}-01`)
    }
  }
  return dates
}

const fetchPBRows = async (date) => {
  const url =
    'https://datacenter-web.eastmoney.com/api/data/v1/get' +
    '?reportName=RPT_VALUEANALYSIS_DET' +
    '&columns=SECURITY_CODE,BOARD_NAME,PB_MRQ' +
    '&pageNumber=1&pageSize=6000' +
    '&sortColumns=SECURITY_CODE&sortTypes=1' +
    `&filter=(TRADE_DATE=%27${date}%27)`
  const data = await fetchJson(url)
  return data.result?.data || []
}

/**
 * 计算各行业（BOARD_NAME）的 PB 底，以及个股历史 PB 低点。
 * @returns {Promise<{ floors: Record<string, number>, stockFloors: Record<string, number> }>}
 *   floors: BOARD_NAME → 行业统计 PB 底（各期第 5 百分位的历史最低值）
 *   stockFloors: SECURITY_CODE → 个股历史 PB 低点（各期历史最低正 PB）
 */
export const calculatePbFloors = async () => {
  const dates = generateMonthlyDates()
  // Map<BOARD_NAME, number[]>  历史各期的 5th 百分位 PB
  const industryP5History = new Map()
  // Map<SECURITY_CODE, number>  个股历史最低正 PB
  const stockPbMin = new Map()

  for (const date of dates) {
    try {
      const rows = await fetchPBRows(date)
      if (rows.length === 0) continue

      const grouped = new Map()
      for (const row of rows) {
        const board = row.BOARD_NAME
        const code = row.SECURITY_CODE
        const pb = row.PB_MRQ
        if (pb === null || pb <= 0) continue

        if (code) {
          const current = stockPbMin.get(code)
          if (current === undefined || pb < current) stockPbMin.set(code, pb)
        }

        if (!board) continue
        if (!grouped.has(board)) grouped.set(board, [])
        grouped.get(board).push(pb)
      }

      for (const [board, pbs] of grouped) {
        if (pbs.length < 5) continue // 样本太少，5 百分位无意义
        const p5 = percentile(pbs, 0.05)
        if (!industryP5History.has(board)) industryP5History.set(board, [])
        industryP5History.get(board).push(p5)
      }
    } catch (e) {
      console.error(`[pb-floor] 拉取 ${date} 失败:`, e.message)
    }
  }

  const floors = {}
  for (const [board, p5List] of industryP5History) {
    floors[board] = Math.min(...p5List)
  }

  const stockFloors = {}
  for (const [code, pb] of stockPbMin) {
    stockFloors[code] = Math.round(pb * 1000) / 1000
  }

  return { floors, stockFloors }
}

// 内存缓存
let memoryCache = null
let memoryCacheTime = 0
let recalculating = false

const isCacheStale = (cacheTime) => Date.now() - cacheTime > CACHE_TTL_MS

const loadCacheFromFile = async () => {
  try {
    const raw = await readFile(CACHE_FILE, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && parsed.floors && parsed.stockFloors && parsed.timestamp) {
      return parsed
    }
  } catch {
    // 无缓存或格式错误
  }
  return null
}

const saveCacheToFile = async (floors, stockFloors) => {
  const payload = {
    timestamp: Date.now(),
    floors,
    stockFloors,
  }
  await writeFile(CACHE_FILE, JSON.stringify(payload))
}

/**
 * 获取行业 PB 底与个股历史 PB 低点，优先使用缓存；缓存过期时在后台重算。
 * @returns {Promise<{ floors: Record<string, number>, stockFloors: Record<string, number>, cached: boolean, timestamp: number }>}
 */
export const getPbFloors = async () => {
  // 1. 内存缓存
  if (memoryCache && !isCacheStale(memoryCacheTime)) {
    return {
      floors: memoryCache.floors,
      stockFloors: memoryCache.stockFloors,
      cached: true,
      timestamp: memoryCacheTime,
    }
  }

  // 2. 文件缓存
  const fileCache = await loadCacheFromFile()
  if (fileCache && !isCacheStale(fileCache.timestamp)) {
    memoryCache = { floors: fileCache.floors, stockFloors: fileCache.stockFloors }
    memoryCacheTime = fileCache.timestamp
    return {
      floors: fileCache.floors,
      stockFloors: fileCache.stockFloors,
      cached: true,
      timestamp: fileCache.timestamp,
    }
  }

  // 3. 有旧缓存但已过期：先返回旧数据，后台重算
  if (fileCache) {
    memoryCache = { floors: fileCache.floors, stockFloors: fileCache.stockFloors }
    memoryCacheTime = fileCache.timestamp
    // 后台重算（不阻塞）
    if (!recalculating) {
      recalculating = true
      setImmediate(async () => {
        try {
          const result = await calculatePbFloors()
          await saveCacheToFile(result.floors, result.stockFloors)
          memoryCache = result
          memoryCacheTime = Date.now()
          console.log('[pb-floor] 后台重算完成')
        } catch (e) {
          console.error('[pb-floor] 后台重算失败:', e.message)
        } finally {
          recalculating = false
        }
      })
    }
    return {
      floors: fileCache.floors,
      stockFloors: fileCache.stockFloors,
      cached: true,
      timestamp: fileCache.timestamp,
    }
  }

  // 4. 无缓存：同步计算（首次启动会较慢，约 1-2 分钟）
  console.log('[pb-floor] 无缓存，开始全量计算（约 1-2 分钟）...')
  const result = await calculatePbFloors()
  await saveCacheToFile(result.floors, result.stockFloors)
  memoryCache = result
  memoryCacheTime = Date.now()
  console.log('[pb-floor] 全量计算完成')
  return {
    floors: result.floors,
    stockFloors: result.stockFloors,
    cached: false,
    timestamp: memoryCacheTime,
  }
}
