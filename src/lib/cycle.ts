import type { CycleStats, IndustryCycleSeries } from '../types'

/**
 * 「周期行业」判定与周期特征计算。
 *
 * 口径分两层（与页面说明一致）：
 * 1. 行业身份：命中预置的经典周期行业关键词清单，得基础分；
 * 2. 数据特征：用行业 PB 月度序列的振幅与波动强度补足，让同样高波动的行业能被识别出来。
 */
export type CyclicalGroup = {
  label: string
  keywords: string[]
}

/**
 * 预置的经典周期行业。关键词按「包含即可命中」匹配东财 BOARD_NAME，
 * 顺序即判定优先级，命中第一个即返回。
 * 关键词依据东财实际返回的行业名（如「普钢 / 特钢Ⅱ / 冶钢原料」「工业金属 / 金属新材料」）整理。
 */
export const CYCLICAL_GROUPS: CyclicalGroup[] = [
  {
    label: '上游资源',
    keywords: [
      '有色',
      '钢',
      '煤炭',
      '焦炭',
      '石油',
      '油服',
      '油气',
      '炼化',
      '采掘',
      '矿业',
      '黄金',
      '工业金属',
      '金属新材料',
      '贵金属',
      '小金属',
      '能源金属',
      '稀有金属',
    ],
  },
  {
    label: '化工材料',
    keywords: [
      '化工',
      '化学原料',
      '化学制品',
      '化纤',
      '化学纤维',
      '橡胶',
      '塑料',
      '农化',
      '玻纤',
      '非金属材料',
    ],
  },
  { label: '建筑材料', keywords: ['建材', '水泥', '玻璃', '陶瓷'] },
  { label: '造纸包装', keywords: ['造纸', '包装'] },
  {
    label: '机械设备',
    keywords: ['机械', '通用设备', '专用设备', '机床', '轨交设备', '重工', '船舶'],
  },
  {
    label: '汽车产业',
    keywords: ['汽车', '乘用车', '商用车', '整车', '轮胎', '摩托车'],
  },
  {
    label: '地产建筑',
    keywords: ['房地产', '地产', '建筑', '建设', '装修', '工程'],
  },
  {
    label: '交通运输',
    keywords: ['航运', '港口', '机场', '公路', '铁路', '物流', '交通', '高速'],
  },
  {
    label: '农林牧渔',
    keywords: ['养殖', '畜禽', '饲料', '种植', '渔业', '农林牧渔', '农牧', '饲渔', '林业', '农业'],
  },
  { label: '金融周期', keywords: ['证券', '保险'] },
  {
    label: '国防军工',
    keywords: ['军工', '国防', '航天装备', '航空装备', '地面兵装', '航海装备'],
  },
]

/** 返回命中的周期行业分组名，未命中返回 null */
export const classifyCyclical = (industry: string): string | null => {
  const name = industry.trim()
  if (!name) return null
  for (const group of CYCLICAL_GROUPS) {
    if (group.keywords.some((keyword) => name.includes(keyword))) {
      return group.label
    }
  }
  return null
}

/** 振幅满分参考：PB 最高/最低达到 3 倍（振幅 2）即拿满振幅分 */
export const AMPLITUDE_REFERENCE = 2
/** 波动满分参考：月度 PB 环比绝对变化均值达到 8% 即拿满波动分 */
export const VOLATILITY_REFERENCE = 0.08

export const CYCLICAL_STRONG_THRESHOLD = 70
export const CYCLICAL_MEDIUM_THRESHOLD = 40

export type CyclicalityScore = {
  /** 周期性总分，0~100 */
  total: number
  /** 行业身份分（0 或 40） */
  identity: number
  /** 振幅分（0~30） */
  amplitude: number
  /** 波动分（0~30） */
  volatility: number
  /** 强周期 / 中周期 / 弱周期 */
  level: '强周期' | '中周期' | '弱周期'
}

/**
 * 周期性评分：
 * - 身份分：命中预置周期行业清单 +40，否则 0；
 * - 振幅分：对数归一化后 ×30，PB 区间 3 倍拿满；
 * - 波动分：min(波动率 / 8%, 1) × 30。
 */
export const scoreCyclicality = (
  group: string | null,
  stats: CycleStats,
): CyclicalityScore => {
  const identity = group ? 40 : 0
  const amplitude =
    stats.amplitude === null || stats.amplitude <= 0
      ? 0
      : Math.min(
          1,
          Math.log(1 + stats.amplitude) / Math.log(1 + AMPLITUDE_REFERENCE),
        ) * 30
  const volatility =
    stats.volatility === null
      ? 0
      : Math.min(1, stats.volatility / VOLATILITY_REFERENCE) * 30

  const total = identity + amplitude + volatility
  return {
    total,
    identity,
    amplitude,
    volatility,
    level:
      total >= CYCLICAL_STRONG_THRESHOLD
        ? '强周期'
        : total >= CYCLICAL_MEDIUM_THRESHOLD
          ? '中周期'
          : '弱周期',
  }
}

const validPoints = (values: (number | null)[]) =>
  values
    .map((value, index) => ({ value, index }))
    .filter((point): point is { value: number; index: number } =>
      typeof point.value === 'number' && Number.isFinite(point.value) && point.value > 0,
    )

const TWELVE_MONTHS = 12

/**
 * 从月度 PB 序列归纳周期特征。
 * @param series 行业月度序列
 * @param dates 与序列对齐的月份列表
 */
export const computeCycleStats = (
  series: IndustryCycleSeries | undefined,
  dates: string[],
): CycleStats => {
  const empty: CycleStats = {
    months: 0,
    current: null,
    min: null,
    max: null,
    minDate: null,
    maxDate: null,
    percentile: null,
    amplitude: null,
    volatility: null,
    trend1y: null,
  }
  if (!series || !Array.isArray(series.pb)) return empty

  const points = validPoints(series.pb)
  if (points.length === 0) return empty

  let minPoint = points[0]
  let maxPoint = points[0]
  for (const point of points) {
    if (point.value < minPoint.value) minPoint = point
    if (point.value > maxPoint.value) maxPoint = point
  }

  const currentPoint = points[points.length - 1]
  const belowOrEqual = points.filter(
    (point) => point.value <= currentPoint.value,
  ).length

  // 波动率：相邻有效月份环比绝对变化的均值
  let volatilitySum = 0
  let volatilityCount = 0
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1].value
    if (prev <= 0) continue
    volatilitySum += Math.abs(points[i].value / prev - 1)
    volatilityCount += 1
  }

  // 近 12 个月变化：取当前点往前推 12 个有效月份
  const baseIndex = points.length - 1 - TWELVE_MONTHS
  const trend1y =
    baseIndex >= 0 && points[baseIndex].value > 0
      ? (currentPoint.value / points[baseIndex].value - 1) * 100
      : null

  return {
    months: points.length,
    current: currentPoint.value,
    min: minPoint.value,
    max: maxPoint.value,
    minDate: dates[minPoint.index] ?? null,
    maxDate: dates[maxPoint.index] ?? null,
    percentile: (belowOrEqual / points.length) * 100,
    amplitude: minPoint.value > 0 ? maxPoint.value / minPoint.value - 1 : null,
    volatility: volatilityCount === 0 ? null : volatilitySum / volatilityCount,
    trend1y,
  }
}

/** 把 YYYY-MM-01 显示成 YYYY-MM */
export const formatMonth = (date: string | null) =>
  date === null ? '—' : date.slice(0, 7)
