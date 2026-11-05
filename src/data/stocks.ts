import type { MarketSnapshot, StockRecord, StrategyConfig } from '../types'
import { normalizeIndustry } from '../lib/industry'

export const defaultMarketSnapshot: MarketSnapshot = {
  allMarketPb: 2.15,
  allMarketPe: 16.8,
}

/**
 * 默认参数对应「大数模拟器」的口径：
 * 门槛 200 分（≡ 绝对胜算概率 66.67%）、满配过滤单行业 3%、总仓位不超 2/3。
 */
export const defaultConfig: StrategyConfig = {
  discount: 1,
  scoreThreshold: 200,
  minDividendYield: 1,
  maxIndustryWeight: 0.03,
  maxEquityExposure: 0.6667,
  klineDays: 300,
  maxKlineCandidates: 600,
}

type DemoRow = [
  code: string,
  name: string,
  industry: string,
  price: number,
  pb: number,
  pe: number,
  ps: number,
  roe: number,
  debtRatio: number,
  dividendYield: number,
  marketCap: number,
  /** 一年内涨幅，用于反推一年内最低价 */
  gain1y: number,
]

/** 仅供离线演示；真实选股请点击「拉取全市场真实数据」 */
const demoRows: DemoRow[] = [
  ['600519', '贵州茅台', '食品饮料', 1588, 8.4, 24.3, 10.8, 31.4, 17, 3.1, 19900, 0.12],
  ['601318', '中国平安', '非银金融', 55.8, 0.92, 7.8, 1.3, 12.8, 89, 5.6, 10100, 0.28],
  ['600036', '招商银行', '银行', 36.4, 1.01, 6.1, 2.8, 15.6, 91, 5.2, 9200, 0.22],
  ['600900', '长江电力', '公用事业', 28.6, 3.08, 19.5, 7.1, 15.1, 58, 3.8, 7100, 0.15],
  ['600309', '万华化学', '基础化工', 78.5, 2.35, 13.4, 1.6, 18.4, 54, 2.4, 2500, 0.31],
  ['600941', '中国移动', '通信', 108.2, 1.29, 12.8, 2.1, 10.2, 31, 4.3, 22500, 0.09],
  ['000651', '格力电器', '家用电器', 42.6, 2.12, 8.7, 1.2, 23.8, 64, 6.2, 2400, 0.18],
  ['000333', '美的集团', '家用电器', 72.3, 3.21, 13.5, 1.4, 24.1, 60, 4.7, 5000, 0.24],
  ['601899', '紫金矿业', '有色金属', 18.1, 3.05, 14.2, 1.9, 20.3, 58, 2.3, 4800, 0.42],
  ['002415', '海康威视', '计算机', 31.5, 3.18, 18.7, 4.3, 19.1, 39, 3.4, 2900, 0.16],
  ['002594', '比亚迪', '汽车', 254.4, 5.42, 26.3, 1.7, 24.7, 74, 0.5, 7600, 0.35],
  ['600276', '恒瑞医药', '医药生物', 42.8, 6.12, 35.8, 10.1, 18.2, 11, 0.4, 2700, 0.29],
  ['600031', '三一重工', '机械设备', 16.9, 1.82, 12.4, 1.1, 14.3, 56, 3.7, 1430, 0.26],
  ['601088', '中国神华', '煤炭', 39.8, 1.56, 9.3, 1.4, 17.1, 26, 7.8, 7900, 0.08],
  ['000858', '五粮液', '食品饮料', 138.5, 4.87, 16.9, 5.2, 25.4, 21, 3.5, 5400, 0.2],
  ['601225', '陕西煤业', '煤炭', 24.3, 1.91, 8.4, 1.8, 24.2, 43, 8.1, 2350, 0.11],
  ['600887', '伊利股份', '食品饮料', 28.1, 2.76, 14.8, 1.4, 20.1, 53, 3.9, 1800, 0.14],
  ['000002', '万科A', '房地产', 8.2, 0.52, 45, 0.38, 1.5, 78, 2.1, 980, 0.05],
  ['300750', '宁德时代', '电力设备', 228, 5.86, 21.7, 3.1, 21.8, 63, 1, 10000, 0.33],
  ['603288', '海天味业', '食品饮料', 36.4, 6.88, 32.4, 7.2, 19.7, 18, 2.2, 2050, 0.19],
  ['600030', '中信证券', '非银金融', 27.6, 1.39, 14.1, 2.6, 8.7, 78, 3.3, 4100, 0.27],
  ['000725', '京东方A', '电子', 4.2, 1.05, 18.5, 1.1, 5.6, 52, 2.8, 1600, 0.06],
]

export const demoStocks: StockRecord[] = demoRows.map(
  ([
    code,
    name,
    industry,
    price,
    pb,
    pe,
    ps,
    roe,
    debtRatio,
    dividendYield,
    marketCap,
    gain1y,
  ]) => ({
    ...normalizeIndustry(industry),
    code,
    name,
    sourceIndustry: industry,
    price,
    pb,
    pe,
    ps,
    roe,
    debtRatio,
    marketCap,
    dividendYield,
    goodwillRatio: null,
    lowPrice1y: Number((price / (1 + gain1y)).toFixed(2)),
    isST: false,
  }),
)
