import fs from 'node:fs'
import { fetchRealMarketData } from '../src/lib/eastmoney.ts'
import { defaultConfig } from '../src/data/stocks.ts'
import { pickKlineCandidates, scoreStocks } from '../src/lib/strategy.ts'
import { queryKline } from '../server/kline.mjs'
import { applyKline, toSymbol } from '../src/lib/kline.ts'
import type { KlineResult } from '../src/types.ts'

type BaselineRow = {
  code: string
  name: string
  sector: string
  industry: string
  score: number | string | null
  gain1y: number | string | null
  low1y: number | string | null
  debtRatio: number | string | null
  debtMedian: number | string | null
  dividendYield: number | string | null
}

const toNumber = (value: number | string | null | undefined) => {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const formatDiff = (left: number | null, right: number | null) => {
  if (left === null || right === null) return null
  return Number((right - left).toFixed(1))
}

const baselinePath = process.argv[2]

if (!baselinePath) {
  console.error(
    'Usage: npx tsx scripts/compare_simulator_export.mts <baseline.json>',
  )
  process.exit(1)
}

const baseline = JSON.parse(
  fs.readFileSync(baselinePath, 'utf8'),
) as BaselineRow[]

const { stocks } = await fetchRealMarketData()
const first = scoreStocks(stocks, defaultConfig)
const candidates = pickKlineCandidates(first, defaultConfig)
const klineData: Record<string, KlineResult> = {}

for (let index = 0; index < candidates.length; index += 120) {
  const slice = candidates
    .slice(index, index + 120)
    .map((code) => toSymbol(code))
    .filter((value): value is string => value !== null)
  const payload = await queryKline(slice.join(','), String(defaultConfig.klineDays))
  Object.assign(klineData, payload.data)
}

const local = scoreStocks(applyKline(stocks, klineData), defaultConfig)
const localMap = new Map(local.map((stock) => [stock.code, stock]))

const report = baseline
  .map((row) => {
    const localStock = localMap.get(row.code)
    if (!localStock) {
      return {
        code: row.code,
        name: row.name,
        missing: true,
      }
    }
    return {
      code: row.code,
      name: row.name,
      sector_export: row.sector,
      sector_local: localStock.sector,
      industry_export: row.industry,
      industry_local: localStock.industry,
      score_export: toNumber(row.score),
      score_local: Number(localStock.totalScore.toFixed(1)),
      score_diff: formatDiff(toNumber(row.score), Number(localStock.totalScore.toFixed(1))),
      low1y_export: toNumber(row.low1y),
      low1y_local: localStock.lowPrice1y === null ? null : Number(localStock.lowPrice1y.toFixed(2)),
      gain1y_export: toNumber(row.gain1y),
      gain1y_local: localStock.gain1y === null ? null : Number((localStock.gain1y * 100).toFixed(1)),
      debt_export: toNumber(row.debtRatio),
      debt_local: localStock.debtRatio === null ? null : Number(localStock.debtRatio.toFixed(1)),
      debt_median_export: toNumber(row.debtMedian),
      debt_median_local:
        localStock.industryDebtMedian === null
          ? null
          : Number(localStock.industryDebtMedian.toFixed(1)),
      dividend_export: toNumber(row.dividendYield),
      dividend_local: localStock.dividendYield,
      eligible_local: localStock.eligible,
    }
  })

const matchedScores = report
  .map((row) => ('score_diff' in row ? row.score_diff : null))
  .filter((value): value is number => value !== null)
const absDiffs = matchedScores.map((value) => Math.abs(value))

const summary = {
  baselineRows: baseline.length,
  localMatched: report.filter((row) => !('missing' in row)).length,
  missingCodes: report.filter((row) => 'missing' in row).map((row) => row.code),
  sectorMismatch: report.filter(
    (row) =>
      !('missing' in row) &&
      row.sector_export &&
      row.sector_local &&
      row.sector_export !== row.sector_local,
  ).length,
  industryMismatch: report.filter(
    (row) =>
      !('missing' in row) &&
      row.industry_export &&
      row.industry_local &&
      row.industry_export !== row.industry_local,
  ).length,
  score: {
    compared: matchedScores.length,
    avgAbsDiff:
      absDiffs.length === 0
        ? null
        : Number(
            (
              absDiffs.reduce((sum, value) => sum + value, 0) / absDiffs.length
            ).toFixed(2),
          ),
    maxAbsDiff: absDiffs.length === 0 ? null : Math.max(...absDiffs),
  },
}

const topScoreGaps = report
  .filter((row) => 'score_diff' in row && row.score_diff !== null)
  .sort((a, b) => {
    const left = 'score_diff' in a ? Math.abs(a.score_diff ?? 0) : 0
    const right = 'score_diff' in b ? Math.abs(b.score_diff ?? 0) : 0
    return right - left
  })
  .slice(0, 10)

const notes = [
  '本脚本仅作对比校验，不参与任何运行时逻辑。',
  'debt_median_export 与 debt_median_local 不一致属预期：模拟器该值来自其私有后端常量，本地为公开口径现算结果。',
  '评分差异主要来自缺失字段（股息率/商誉/质押率等）与行业口径差异。',
]

console.log(
  JSON.stringify({ summary, notes, topScoreGaps, sample: report.slice(0, 20) }, null, 2),
)
