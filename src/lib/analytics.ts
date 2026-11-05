import type {
  IndustrySummary,
  PortfolioHolding,
  PortfolioIndustrySummary,
  ScoredStock,
  StrategyConfig,
} from '../types'
import { MAX_GOODWILL_RATIO, MAX_PLEDGE_RATIO } from './strategy'

const average = (values: number[]) =>
  values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length

const sum = (values: number[]) =>
  values.reduce((total, value) => total + value, 0)

export const summarizeIndustries = (
  stocks: ScoredStock[],
): IndustrySummary[] => {
  const grouped = new Map<string, ScoredStock[]>()
  for (const stock of stocks) {
    const bucket = grouped.get(stock.industry) ?? []
    bucket.push(stock)
    grouped.set(stock.industry, bucket)
  }

  return [...grouped.entries()]
    .map<IndustrySummary>(([industry, members]) => {
      const debtValues = members
        .map((stock) => stock.debtRatio)
        .filter((value): value is number => value !== null)
      const positivePbs = members
        .map((stock) => stock.pb)
        .filter((value): value is number => value !== null && value > 0)
      const positiveMarketCaps = members
        .map((stock) => stock.marketCap)
        .filter((value): value is number => value !== null && value > 0)

      const marketCapsForPb = members
        .filter(
          (stock) =>
            stock.marketCap !== null &&
            stock.marketCap > 0 &&
            stock.pb !== null &&
            stock.pb > 0,
        )
        .map((stock) => ({
          marketCap: stock.marketCap as number,
          netAsset: (stock.marketCap as number) / (stock.pb as number),
        }))

      const marketCapsForPe = members
        .filter(
          (stock) =>
            stock.marketCap !== null &&
            stock.marketCap > 0 &&
            stock.pe !== null &&
            stock.pe > 0,
        )
        .map((stock) => ({
          marketCap: stock.marketCap as number,
          earnings: (stock.marketCap as number) / (stock.pe as number),
        }))

      const marketCap = positiveMarketCaps.length === 0 ? null : sum(positiveMarketCaps)
      const netAsset =
        marketCapsForPb.length === 0
          ? null
          : sum(marketCapsForPb.map((item) => item.netAsset))
      const pb = marketCap !== null && netAsset !== null && netAsset > 0
        ? marketCap / netAsset
        : null
      const pbFloor =
        positivePbs.length === 0 ? null : Math.min(...positivePbs)
      const pbGain =
        pb !== null && pbFloor !== null && pbFloor > 0
          ? (pb / pbFloor - 1) * 100
          : null
      const peEarnings = sum(marketCapsForPe.map((item) => item.earnings))
      const pe =
        marketCapsForPe.length === 0 || peEarnings <= 0 || marketCap === null
          ? null
          : marketCap / peEarnings

      const best = [...members].sort((a, b) => b.totalScore - a.totalScore)[0]

      return {
        industry,
        stockCount: members.length,
        eligibleCount: members.filter((stock) => stock.eligible).length,
        avgDebtRatio: average(debtValues),
        pbFloor,
        pb,
        pbGain,
        pe,
        marketCap,
        netAsset,
        bestStockCode: best?.code ?? null,
        bestStockName: best?.name ?? null,
      }
    })
    .sort((a, b) => {
      if (a.pbFloor === null) return 1
      if (b.pbFloor === null) return -1
      return a.pbFloor - b.pbFloor
    })
}

export const summarizePortfolioIndustries = (
  portfolio: PortfolioHolding[],
): PortfolioIndustrySummary[] => {
  const grouped = new Map<string, PortfolioHolding[]>()
  for (const holding of portfolio) {
    const bucket = grouped.get(holding.industry) ?? []
    bucket.push(holding)
    grouped.set(holding.industry, bucket)
  }

  return [...grouped.entries()]
    .map<PortfolioIndustrySummary>(([industry, members]) => {
      const scores = members.map((item) => item.score)
      const wins = members
        .map((item) => item.winProbability)
        .filter((value): value is number => value !== null)
      return {
        industry,
        holdingCount: members.length,
        targetWeight: sum(members.map((item) => item.targetWeight)),
        avgScore: sum(scores) / scores.length,
        avgWinProbability: average(wins),
        codes: members.map((item) => item.code),
      }
    })
    .sort((a, b) => b.targetWeight - a.targetWeight || b.avgScore - a.avgScore)
}

export const buildAiHighlights = (
  stocks: ScoredStock[],
  industries: IndustrySummary[],
  portfolio: PortfolioHolding[],
): string[] => {
  const eligible = stocks.filter((stock) => stock.eligible)
  const topIndustry = industries[0]
  const strongest = eligible[0]
  const weakestLink = stocks.find(
    (stock) => !stock.eligible && stock.debtAboveIndustryMedian === true,
  )

  const lines: string[] = []

  if (strongest) {
    lines.push(
      `当前最高分股票是 ${strongest.name}（${strongest.code}），总分 ${strongest.totalScore.toFixed(1)}，胜算 ${strongest.winProbability?.toFixed(1) ?? '—'}%。`,
    )
  }
  if (topIndustry) {
    lines.push(
      `${topIndustry.industry} 的 PB 底约为 ${topIndustry.pbFloor?.toFixed(2) ?? '—'}，行业 PB ${topIndustry.pb?.toFixed(2) ?? '—'}，较底部抬升 ${topIndustry.pbGain?.toFixed(1) ?? '—'}%。`,
    )
  }
  if (portfolio.length > 0) {
    lines.push(
      `推荐组合当前覆盖 ${portfolio.length} 个持仓位，按单行业上限分散配置，避免在单一细分赛道过度集中。`,
    )
  }
  if (weakestLink) {
    lines.push(
      `${weakestLink.name}（${weakestLink.code}）这类股票的常见淘汰原因是“资产负债率高于行业中位数”，即便估值便宜也不会进入推荐组合。`,
    )
  }
  if (eligible.length === 0) {
    lines.push('当前没有满足全部口径的股票，优先检查 K 线是否补齐、评分门槛是否过高。')
  }

  return lines
}

export const explainStockExclusion = (
  stock: ScoredStock,
  config: StrategyConfig,
) => {
  const reasons: string[] = []
  if (stock.isST) reasons.push('ST 风险')
  if (stock.debtAboveIndustryMedian === true) {
    reasons.push('资产负债率高于行业中位数')
  }
  if (stock.priceScore === null) {
    reasons.push('未进入涨幅评分或尚未补齐一年内最低价')
  }
  if (stock.totalScore <= config.scoreThreshold) {
    reasons.push(`三好学生评分未超过 ${config.scoreThreshold} 分门槛`)
  }
  if (
    stock.dividendYield !== null &&
    stock.dividendYield <= config.minDividendYield
  ) {
    reasons.push(`股息率不满足 >${config.minDividendYield}% 条件`)
  }
  if (
    stock.goodwillRatio !== null &&
    stock.goodwillRatio >= MAX_GOODWILL_RATIO
  ) {
    reasons.push(`商誉占净资产不满足 <${MAX_GOODWILL_RATIO}% 条件`)
  }
  if (
    stock.pledgeRatio !== null &&
    stock.pledgeRatio >= MAX_PLEDGE_RATIO
  ) {
    reasons.push(`股权质押比例不满足 <${MAX_PLEDGE_RATIO}% 条件`)
  }
  return reasons
}
