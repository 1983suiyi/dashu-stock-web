import { useEffect, useMemo, useState } from 'react'
import { defaultConfig, defaultMarketSnapshot, demoStocks } from './data/stocks'
import { downloadCsv, toCsv } from './lib/csv'
import { fetchRealMarketData } from './lib/eastmoney'
import { applyKline, fetchKlines } from './lib/kline'
import {
  buildAiHighlights,
  explainStockExclusion,
  summarizeIndustries,
  summarizePortfolioIndustries,
} from './lib/analytics'
import {
  MAX_SCORE,
  deriveMarketSnapshot,
  pbBand,
  peBand,
  pickKlineCandidates,
  portfolioExposure,
  recommendPortfolio,
  scoreStocks,
  summarizeMarket,
} from './lib/strategy'
import type {
  DataSourceMeta,
  MarketSnapshot,
  StockRecord,
  StrategyConfig,
} from './types'

const researchHighlights = [
  {
    title: '组合投资',
    detail:
      '用分层抽样替代单点押注：先覆盖行业，再在行业内找估值更低的样本企业。',
  },
  {
    title: '低估值建仓',
    detail:
      'PB 与 PE 各自映射成 0~100 分，只有在估值区间下沿才拿满分，价格越贵得分越低。',
  },
  {
    title: '长期持有',
    detail:
      '一年内最低价到现价的涨幅越低，得分越高，鼓励在价格低位而不是高位建仓。',
  },
  {
    title: '2/3 仓位上限',
    detail:
      '200 分门槛等于绝对胜算概率 66.67%，与 2/3 仓位约束同源，给极端行情留缓冲。',
  },
]

const csvHeaders = [
  'code',
  'name',
  'industry',
  'price',
  'pb',
  'pe',
  'ps',
  'roe',
  'debtRatio',
  'dividendYield',
  'marketCap',
  'lowPrice1y',
  'goodwillRatio',
  'isST',
]

type WorkspaceView =
  | 'overview'
  | 'scores'
  | 'portfolio'
  | 'portfolioSummary'
  | 'industries'
  | 'archives'
  | 'ai'

type ArchiveSnapshot = {
  id: string
  label: string
  createdAt: string
  stocks: StockRecord[]
  config: StrategyConfig
  market: MarketSnapshot
  dataMeta: DataSourceMeta | null
}

const ARCHIVE_STORAGE_KEY = 'dashu-workspace-archives'

const navItems: Array<{ key: WorkspaceView; label: string }> = [
  { key: 'overview', label: '市场概况' },
  { key: 'scores', label: '大数评分' },
  { key: 'portfolio', label: '持仓' },
  { key: 'portfolioSummary', label: '持仓汇总' },
  { key: 'industries', label: '细分行业' },
  { key: 'archives', label: '归档' },
  { key: 'ai', label: 'AI' },
]

const parseBoolean = (value: string) =>
  ['true', '1', 'yes', 'y', '是'].includes(value.trim().toLowerCase())

/** 空单元格统一解析为 null，避免 Number('') = 0 污染估值判定 */
const parseNumberCell = (value: string): number | null => {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

const parseCsv = (text: string): StockRecord[] => {
  const rows = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (rows.length <= 1) return []

  const headers = rows[0].split(',').map((item) => item.trim())
  return rows.slice(1).map((row) => {
    const values = row.split(',').map((item) => item.trim())
    const get = (key: string) => values[headers.indexOf(key)] ?? ''

    return {
      code: get('code'),
      name: get('name'),
      industry: get('industry'),
      price: parseNumberCell(get('price')),
      pb: parseNumberCell(get('pb')),
      pe: parseNumberCell(get('pe')),
      ps: parseNumberCell(get('ps')),
      roe: parseNumberCell(get('roe')),
      debtRatio: parseNumberCell(get('debtRatio')),
      marketCap: parseNumberCell(get('marketCap')),
      dividendYield: parseNumberCell(get('dividendYield')),
      goodwillRatio: parseNumberCell(get('goodwillRatio')),
      lowPrice1y: parseNumberCell(get('lowPrice1y')),
      isST: parseBoolean(get('isST')),
    }
  })
}

const fixed = (value: number | null, digits = 2) =>
  value === null ? '' : value.toFixed(digits)

const show = (value: number | null, digits = 2) =>
  value === null ? '—' : value.toFixed(digits)

const percent = (value: number | null, digits = 2) =>
  value === null ? '' : `${(value * 100).toFixed(digits)}`

const percentView = (value: number | null, digits = 1) =>
  value === null ? '—' : `${value.toFixed(digits)}%`

const yi = (value: number | null, digits = 0) =>
  value === null ? '—' : (value / 1e8).toFixed(digits)

const normalize = (value: string) => value.trim().toLowerCase()

function App() {
  const [stocks, setStocks] = useState<StockRecord[]>(demoStocks)
  const [config, setConfig] = useState<StrategyConfig>(defaultConfig)
  const [market, setMarket] = useState(defaultMarketSnapshot)
  const [message, setMessage] = useState('当前使用内置演示数据。')
  const [warning, setWarning] = useState('')
  const [dataMeta, setDataMeta] = useState<DataSourceMeta | null>(null)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState('')
  const [onlyEligible, setOnlyEligible] = useState(false)
  const [activeView, setActiveView] = useState<WorkspaceView>('overview')
  const [stockQuery, setStockQuery] = useState('000589')
  const [industryQuery, setIndustryQuery] = useState('')
  const [snapshots, setSnapshots] = useState<ArchiveSnapshot[]>([])

  useEffect(() => {
    try {
      const raw = localStorage.getItem(ARCHIVE_STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as ArchiveSnapshot[]
      setSnapshots(Array.isArray(parsed) ? parsed : [])
    } catch {
      setSnapshots([])
    }
  }, [])

  const scoredStocks = useMemo(
    () => scoreStocks(stocks, config),
    [stocks, config],
  )
  const eligibleStocks = useMemo(
    () => scoredStocks.filter((stock) => stock.eligible),
    [scoredStocks],
  )
  const portfolio = useMemo(
    () => recommendPortfolio(scoredStocks, config, market),
    [scoredStocks, config, market],
  )
  const marketSummary = useMemo(() => summarizeMarket(market), [market])
  const exposure = useMemo(() => portfolioExposure(portfolio), [portfolio])
  const industrySummaries = useMemo(
    () => summarizeIndustries(scoredStocks),
    [scoredStocks],
  )
  const portfolioSummaries = useMemo(
    () => summarizePortfolioIndustries(portfolio),
    [portfolio],
  )
  const aiHighlights = useMemo(
    () => buildAiHighlights(scoredStocks, industrySummaries, portfolio),
    [scoredStocks, industrySummaries, portfolio],
  )
  const [pbLo, pbHi] = pbBand(config.discount)
  const [peLo, peHi] = peBand(config.discount)

  const pendingKline = useMemo(
    () => scoredStocks.filter((stock) => stock.lowPrice1y === null).length,
    [scoredStocks],
  )
  const visibleStocks = onlyEligible ? eligibleStocks : scoredStocks
  const searchedStocks = useMemo(() => {
    const keyword = normalize(stockQuery)
    if (!keyword) return []
    return scoredStocks
      .filter((stock) => {
        const hay = `${stock.code} ${stock.name} ${stock.industry}`.toLowerCase()
        return hay.includes(keyword)
      })
      .slice(0, 12)
  }, [scoredStocks, stockQuery])
  const selectedStock = searchedStocks[0] ?? null
  const visibleIndustries = useMemo(() => {
    const keyword = normalize(industryQuery)
    if (!keyword) return industrySummaries
    return industrySummaries.filter((item) => {
      const hay = `${item.industry} ${item.bestStockName ?? ''} ${item.bestStockCode ?? ''}`.toLowerCase()
      return hay.includes(keyword)
    })
  }, [industryQuery, industrySummaries])

  const persistSnapshots = (next: ArchiveSnapshot[]) => {
    setSnapshots(next)
    try {
      localStorage.setItem(ARCHIVE_STORAGE_KEY, JSON.stringify(next))
    } catch {
      // localStorage 超限时保留内存态，不打断主流程
    }
  }

  const handleConfigChange = (key: keyof StrategyConfig, value: number) => {
    setConfig((current) => ({ ...current, [key]: value }))
  }

  const runKlineStep = async (universe: StockRecord[]) => {
    const candidates = pickKlineCandidates(
      scoreStocks(universe, config),
      config,
    )
    if (candidates.length === 0) {
      return { stocks: universe, count: 0, failed: [] as string[] }
    }

    const { data, failed } = await fetchKlines(
      candidates,
      config.klineDays,
      (done, total) => setProgress(`正在补齐一年内最低价：${done}/${total}`),
    )

    return {
      stocks: applyKline(universe, data),
      count: Object.keys(data).length,
      failed,
    }
  }

  const handleFetchAll = async () => {
    setLoading(true)
    setWarning('')
    setProgress('开始拉取…')
    try {
      const { stocks: universe, meta } = await fetchRealMarketData(setProgress)
      const { stocks: enriched, count, failed } = await runKlineStep(universe)
      setStocks(enriched)
      setMarket(deriveMarketSnapshot(enriched))
      setDataMeta({ ...meta, klineCount: count })
      setMessage(
        `已接入真实数据：${meta.total} 只 A 股，交易日 ${meta.tradeDate}，` +
          `其中 ${count} 只补齐了一年内最低价。`,
      )
      if (failed.length > 0) {
        setWarning(`有 ${failed.length} 只候选未能取到 K 线，其涨幅得分暂缺。`)
      }
    } catch (error) {
      setWarning(
        `拉取失败：${error instanceof Error ? error.message : String(error)}。` +
          ' 若在 vite preview 下运行，请改用 npm run dev（K 线接口需要本地服务）。',
      )
    } finally {
      setLoading(false)
      setProgress('')
    }
  }

  const handleFillKline = async () => {
    setLoading(true)
    setWarning('')
    setProgress('开始补齐 K 线…')
    try {
      const { stocks: enriched, count, failed } = await runKlineStep(stocks)
      setStocks(enriched)
      setMarket(deriveMarketSnapshot(enriched))
      setDataMeta((current) =>
        current ? { ...current, klineCount: count } : current,
      )
      setMessage(`已为 ${count} 只候选补齐一年内最低价。`)
      if (failed.length > 0) {
        setWarning(`有 ${failed.length} 只候选未能取到 K 线。`)
      }
    } catch (error) {
      setWarning(
        `补齐失败：${error instanceof Error ? error.message : String(error)}。` +
          ' 请确认通过 npm run dev 或 npm start 启动（K 线需要本地服务）。',
      )
    } finally {
      setLoading(false)
      setProgress('')
    }
  }

  const handleFileImport = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      const text = await file.text()
      const parsed = parseCsv(text).filter((item) => item.code && item.name)
      if (parsed.length === 0) {
        setMessage('CSV 已读取，但未识别到有效股票行。')
        return
      }

      setStocks(parsed)
      setDataMeta(null)
      setWarning('')
      setMessage(`已导入 ${parsed.length} 条股票记录。`)
    } catch (error) {
      setMessage(`导入失败：${String(error)}`)
    } finally {
      event.target.value = ''
    }
  }

  const handleRestoreDemo = () => {
    setStocks(demoStocks)
    setMarket(defaultMarketSnapshot)
    setDataMeta(null)
    setWarning('')
    setMessage('已恢复为内置演示数据。')
  }

  const handleArchiveCurrent = () => {
    const snapshot: ArchiveSnapshot = {
      id: String(Date.now()),
      label: dataMeta
        ? `${dataMeta.tradeDate} ${dataMeta.total}只`
        : `本地快照 ${new Date().toLocaleTimeString('zh-CN')}`,
      createdAt: new Date().toLocaleString('zh-CN'),
      stocks,
      config,
      market,
      dataMeta,
    }
    const next = [snapshot, ...snapshots].slice(0, 6)
    persistSnapshots(next)
    setMessage(`已归档当前结果，共保留 ${next.length} 份快照。`)
    setActiveView('archives')
  }

  const handleRestoreSnapshot = (snapshot: ArchiveSnapshot) => {
    setStocks(snapshot.stocks)
    setConfig(snapshot.config)
    setMarket(snapshot.market)
    setDataMeta(snapshot.dataMeta)
    setWarning('')
    setMessage(`已恢复归档：${snapshot.label}`)
    setActiveView('overview')
  }

  const handleDeleteSnapshot = (id: string) => {
    const next = snapshots.filter((snapshot) => snapshot.id !== id)
    persistSnapshots(next)
  }

  const exportScoreTable = () => {
    const rows = scoredStocks.map((stock) => [
      stock.code,
      stock.name,
      stock.industry,
      fixed(stock.pb),
      fixed(stock.pe),
      fixed(stock.pbScore, 1),
      fixed(stock.peScore, 1),
      fixed(stock.priceScore, 1),
      fixed(stock.totalScore, 1),
      fixed(stock.winProbability, 1),
      fixed(stock.lowPrice1y),
      percent(stock.gain1y),
      fixed(stock.debtRatio),
      fixed(stock.industryDebtMedian),
      fixed(stock.dividendYield),
      fixed(stock.goodwillRatio),
      stock.eligible ? '通过' : '未通过',
      stock.notes.join(' / '),
    ])
    downloadCsv(
      '大数评分表.csv',
      toCsv(
        [
          '代码',
          '名称',
          '行业',
          '当前市净率',
          'PE',
          'PB得分',
          'PE得分',
          '涨幅得分',
          '三好学生评分',
          '绝对胜算概率(%)',
          '一年内最低价',
          '一年内涨幅(%)',
          '资产负债率(%)',
          '行业资产负债率中位数(%)',
          '股息率(%)',
          '商誉占净资产(%)',
          '是否通过',
          '风险提示',
        ],
        rows,
      ),
    )
  }

  const exportPortfolio = () => {
    const rows = portfolio.map((item) => {
      const source = scoredStocks.find((stock) => stock.code === item.code)
      return [
        item.code,
        item.name,
        item.industry,
        fixed(item.score, 1),
        fixed(item.winProbability, 1),
        (item.targetWeight * 100).toFixed(2),
        fixed(source?.price ?? null),
        item.reason,
      ]
    })
    downloadCsv(
      '大数持仓.csv',
      toCsv(
        [
          '代码',
          '名称',
          '行业',
          '三好学生评分',
          '绝对胜算概率(%)',
          '目标权重(%)',
          '现价',
          '入选原因',
        ],
        rows,
      ),
    )
  }

  const exportIndustryTable = () => {
    const rows = industrySummaries.map((item) => [
      item.industry,
      item.stockCount,
      item.eligibleCount,
      fixed(item.avgDebtRatio, 1),
      fixed(item.pbGain, 1),
      fixed(item.pbFloor),
      fixed(item.pb),
      fixed(item.pe),
      yi(item.marketCap),
      yi(item.netAsset),
      item.bestStockCode ?? '',
      item.bestStockName ?? '',
    ])
    downloadCsv(
      '细分行业汇总.csv',
      toCsv(
        [
          '细分行业',
          '股票数',
          '通过筛选数',
          '资产负债率(%)',
          'PB涨幅(%)',
          'PB底',
          'PB',
          'PE',
          '总市值(亿)',
          '净资产(亿)',
          '行业高分股代码',
          '行业高分股名称',
        ],
        rows,
      ),
    )
  }

  const stockDiagnosis = useMemo(() => {
    if (!selectedStock) return []
    const inPortfolio = portfolio.find((item) => item.code === selectedStock.code)
    if (inPortfolio) {
      return [
        `已入选推荐组合，目标权重 ${(inPortfolio.targetWeight * 100).toFixed(2)}%。`,
        inPortfolio.reason,
      ]
    }

    const reasons = explainStockExclusion(selectedStock, config)
    if (reasons.length > 0) return reasons

    const industryHolding = portfolioSummaries.find(
      (item) => item.industry === selectedStock.industry,
    )
    if (
      industryHolding &&
      industryHolding.targetWeight >= config.maxIndustryWeight - 0.0001
    ) {
      return ['该细分行业在推荐组合中已达到单行业上限，优先保留排名更高的股票。']
    }
    if (exposure >= config.maxEquityExposure - 0.0001) {
      return ['推荐组合总权益仓位已满，当前股票虽合格但未进入前排持仓位。']
    }
    return ['当前未入选，通常是排序落后于更高分股票。']
  }, [config, exposure, portfolio, portfolioSummaries, selectedStock])

  const overviewSection = (
    <>
      <header className="hero">
        <div>
          <span className="eyebrow">大数选股管理工具</span>
          <h1>三好学生评分驱动的选股与组合管理</h1>
          <p className="hero-text">
            评分算法还原自「大数模拟器」：PB、PE、一年内价格低点涨幅各 100
            分，满分 {MAX_SCORE} 分，绝对胜算概率 = 总分 / 3。
          </p>
          <div className="hero-tags">
            <span>全市场真实数据</span>
            <span>三好学生评分</span>
            <span>细分行业</span>
            <span>归档与 AI 摘要</span>
          </div>
        </div>

        <div className="hero-panel">
          <div className="metric-card accent">
            <span>市场状态</span>
            <strong>{marketSummary.label}</strong>
            <p>{marketSummary.description}</p>
          </div>
          <div className="metric-grid">
            <div className="metric-card">
              <span>候选股票</span>
              <strong>{stocks.length}</strong>
            </div>
            <div className="metric-card">
              <span>通过筛选</span>
              <strong>{eligibleStocks.length}</strong>
            </div>
            <div className="metric-card">
              <span>建议持仓数</span>
              <strong>{portfolio.length}</strong>
            </div>
            <div className="metric-card">
              <span>建议权益仓位</span>
              <strong>{(exposure * 100).toFixed(1)}%</strong>
            </div>
          </div>
        </div>
      </header>

      <section className="panel">
        <div className="section-title">
          <h2>数据与导出</h2>
          <p>
            行情与财务来自东方财富公开接口（浏览器直连）；一年内最低价由本地
            <code> /api/kline </code>代理补齐，用于计算涨幅得分。
          </p>
        </div>

        <div className="action-row">
          <button type="button" onClick={handleFetchAll} disabled={loading}>
            {loading ? '处理中…' : '拉取真实数据并评分'}
          </button>
          <button type="button" onClick={handleFillKline} disabled={loading}>
            仅补齐 K 线
          </button>
          <button type="button" onClick={exportScoreTable}>
            导出评分表 CSV
          </button>
          <button
            type="button"
            onClick={exportPortfolio}
            disabled={portfolio.length === 0}
          >
            导出持仓 CSV
          </button>
          <button type="button" onClick={exportIndustryTable}>
            导出行业汇总 CSV
          </button>
          <button type="button" onClick={handleArchiveCurrent}>
            归档当前结果
          </button>
          <label className="file-button">
            导入 CSV
            <input type="file" accept=".csv" onChange={handleFileImport} />
          </label>
          <button type="button" onClick={handleRestoreDemo} disabled={loading}>
            恢复演示数据
          </button>
        </div>

        {progress && <p className="helper-text">{progress}</p>}
        <p className="helper-text">{message}</p>
        {warning && <p className="helper-text error">{warning}</p>}

        {dataMeta && (
          <div className="meta-grid">
            <div>
              <span>数据源</span>
              <strong>{dataMeta.name}</strong>
            </div>
            <div>
              <span>交易日</span>
              <strong>{dataMeta.tradeDate}</strong>
            </div>
            <div>
              <span>财务报告期</span>
              <strong>{dataMeta.reportDate}</strong>
            </div>
            <div>
              <span>样本数量</span>
              <strong>{dataMeta.total}</strong>
            </div>
            <div>
              <span>已补 K 线</span>
              <strong>{dataMeta.klineCount}</strong>
            </div>
            <div>
              <span>拉取时间</span>
              <strong>{dataMeta.fetchedAt}</strong>
            </div>
          </div>
        )}

        <p className="helper-text">
          说明：涨幅得分依赖「一年内最低价」。为控制请求量，只对
          <strong>可能达到门槛</strong>的候选（PB+PE 得分 &gt; 门槛 − 100）补 K
          线，该剪枝不丢结果。当前仍有 {pendingKline} 只未补齐。
        </p>
        <p className="helper-text">
          当前接口未提供<strong>股息率</strong>与<strong>商誉占净资产</strong>，
          相关列显示为 <code>—</code> 且不参与淘汰判定。导入字段：
          <code>{csvHeaders.join(', ')}</code>
        </p>
      </section>

      <section className="panel two-columns">
        <div>
          <div className="section-title">
            <h2>规则配置</h2>
            <p>参数化还原大数模拟器口径，改任意阈值都会立刻重算。</p>
          </div>
          <div className="control-grid">
            <label>
              历史折扣 PB
              <input
                type="number"
                step="0.1"
                value={config.discount}
                min={0}
                max={1}
                onChange={(event) =>
                  handleConfigChange('discount', Number(event.target.value))
                }
              />
            </label>
            <label>
              评分门槛（满分 {MAX_SCORE}）
              <input
                type="number"
                value={config.scoreThreshold}
                min={0}
                max={MAX_SCORE}
                onChange={(event) =>
                  handleConfigChange('scoreThreshold', Number(event.target.value))
                }
              />
            </label>
            <label>
              股息率下限(%)
              <input
                type="number"
                step="0.1"
                value={config.minDividendYield}
                min={0}
                max={10}
                onChange={(event) =>
                  handleConfigChange('minDividendYield', Number(event.target.value))
                }
              />
            </label>
            <label>
              满配过滤：单行业上限
              <input
                type="number"
                step="0.01"
                value={config.maxIndustryWeight}
                min={0.01}
                max={0.5}
                onChange={(event) =>
                  handleConfigChange('maxIndustryWeight', Number(event.target.value))
                }
              />
            </label>
            <label>
              总权益仓位上限
              <input
                type="number"
                step="0.01"
                value={config.maxEquityExposure}
                min={0.2}
                max={0.67}
                onChange={(event) =>
                  handleConfigChange('maxEquityExposure', Number(event.target.value))
                }
              />
            </label>
            <label>
              K 线回溯天数
              <input
                type="number"
                value={config.klineDays}
                min={20}
                max={400}
                onChange={(event) =>
                  handleConfigChange('klineDays', Number(event.target.value))
                }
              />
            </label>
            <label>
              最多补 K 线只数
              <input
                type="number"
                value={config.maxKlineCandidates}
                min={50}
                max={5000}
                step={50}
                onChange={(event) =>
                  handleConfigChange(
                    'maxKlineCandidates',
                    Number(event.target.value),
                  )
                }
              />
            </label>
          </div>

          <div className="market-callout">
            <strong>估值区间</strong>
            <p>
              PB 取值范围 [ {pbLo.toFixed(3)}, {pbHi.toFixed(3)} ]，PE 取值范围 [
              {peLo.toFixed(2)}, {peHi.toFixed(2)} ]。区间下沿得满分 100
              分，上沿得 0 分，中间线性递减。
            </p>
          </div>
        </div>

        <div>
          <div className="section-title">
            <h2>个股诊断</h2>
            <p>这里可以直接查某只股票为什么未进推荐组合。默认已定位到贵州轮胎。</p>
          </div>
          <div className="control-grid single-column">
            <label>
              股票代码 / 名称
              <input
                value={stockQuery}
                onChange={(event) => setStockQuery(event.target.value)}
                placeholder="例如 000589 或 贵州轮胎"
              />
            </label>
          </div>
          {selectedStock ? (
            <div className="diagnostic-card">
              <div className="diagnostic-head">
                <div>
                  <strong>
                    {selectedStock.name}（{selectedStock.code}）
                  </strong>
                  <p>
                    {selectedStock.industry} / 总分 {selectedStock.totalScore.toFixed(1)} / 状态{' '}
                    {selectedStock.eligible ? '通过筛选' : '未通过筛选'}
                  </p>
                </div>
                <span
                  className={
                    selectedStock.eligible ? 'status ok' : 'status muted'
                  }
                >
                  {selectedStock.eligible ? '可入池' : '未入池'}
                </span>
              </div>
              <div className="mini-metrics">
                <span>PB {show(selectedStock.pb)}</span>
                <span>PE {show(selectedStock.pe)}</span>
                <span>
                  资产负债率 {show(selectedStock.debtRatio, 1)} /{' '}
                  {show(selectedStock.industryDebtMedian, 1)}
                </span>
                <span>一年内低点 {show(selectedStock.lowPrice1y)}</span>
              </div>
              <ul className="explain-list">
                {stockDiagnosis.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="helper-text">未找到匹配股票。</p>
          )}
        </div>
      </section>

      <section className="section-grid">
        {researchHighlights.map((item) => (
          <article key={item.title} className="insight-card">
            <h2>{item.title}</h2>
            <p>{item.detail}</p>
          </article>
        ))}
      </section>
    </>
  )

  const scoreSection = (
    <section className="panel">
      <div className="section-title">
        <h2>大数评分</h2>
        <p>
          PB、PE、涨幅得分各 100 分；绝对胜算概率 = 总分 / 3。这里能直接看到未入池原因。
        </p>
      </div>

      <div className="action-row">
        <button type="button" onClick={exportScoreTable}>
          导出为 CSV
        </button>
        <label className="toggle">
          <input
            type="checkbox"
            checked={onlyEligible}
            onChange={(event) => setOnlyEligible(event.target.checked)}
          />
          只看通过筛选
        </label>
        <span className="helper-text">共 {visibleStocks.length} 条</span>
      </div>

      <div className="table-wrap tall">
        <table>
          <thead>
            <tr>
              <th>代码</th>
              <th>名称</th>
              <th>行业</th>
              <th>PB</th>
              <th>PE</th>
              <th>PB得分</th>
              <th>PE得分</th>
              <th>涨幅得分</th>
              <th>三好学生评分</th>
              <th>胜算概率</th>
              <th>资产负债率 / 行业中位数</th>
              <th>状态</th>
              <th>风险提示</th>
            </tr>
          </thead>
          <tbody>
            {visibleStocks.slice(0, 300).map((stock) => (
              <tr key={stock.code}>
                <td>{stock.code}</td>
                <td>{stock.name}</td>
                <td>{stock.industry}</td>
                <td>{show(stock.pb)}</td>
                <td>{show(stock.pe)}</td>
                <td>{show(stock.pbScore, 1)}</td>
                <td>{show(stock.peScore, 1)}</td>
                <td>{show(stock.priceScore, 1)}</td>
                <td>{stock.totalScore.toFixed(1)}</td>
                <td>{show(stock.winProbability, 1)}%</td>
                <td>
                  {show(stock.debtRatio, 1)} / {show(stock.industryDebtMedian, 1)}
                </td>
                <td>
                  <span className={stock.eligible ? 'status ok' : 'status muted'}>
                    {stock.eligible ? '通过' : '未通过'}
                  </span>
                </td>
                <td>
                  {stock.notes.join(' / ') || '无明显提示'}
                  {stock.missingFields.length > 0 && (
                    <em className="missing">
                      {' '}
                      待补：{stock.missingFields.join('、')}
                    </em>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )

  const portfolioSection = (
    <section className="panel">
      <div className="section-title">
        <h2>持仓</h2>
        <p>
          按三好学生评分从高到低选入，单行业持仓不超过{' '}
          {(config.maxIndustryWeight * 100).toFixed(0)}%，总仓位不超过 2/3。
        </p>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>代码</th>
              <th>名称</th>
              <th>行业</th>
              <th>三好学生评分</th>
              <th>绝对胜算概率</th>
              <th>目标权重</th>
              <th>入选原因</th>
            </tr>
          </thead>
          <tbody>
            {portfolio.map((item) => (
              <tr key={item.code}>
                <td>{item.code}</td>
                <td>{item.name}</td>
                <td>{item.industry}</td>
                <td>{item.score.toFixed(1)}</td>
                <td>{show(item.winProbability, 1)}%</td>
                <td>{(item.targetWeight * 100).toFixed(2)}%</td>
                <td>{item.reason}</td>
              </tr>
            ))}
            {portfolio.length === 0 && (
              <tr>
                <td colSpan={7}>
                  暂无通过筛选的股票。请先拉取真实数据并补齐 K 线，或下调评分门槛。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )

  const portfolioSummarySection = (
    <section className="panel">
      <div className="section-title">
        <h2>持仓汇总</h2>
        <p>按行业聚合推荐组合，方便看持仓分散度和行业权重占用情况。</p>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>行业</th>
              <th>持仓数</th>
              <th>目标权重</th>
              <th>平均评分</th>
              <th>平均胜算</th>
              <th>股票代码</th>
            </tr>
          </thead>
          <tbody>
            {portfolioSummaries.map((item) => (
              <tr key={item.industry}>
                <td>{item.industry}</td>
                <td>{item.holdingCount}</td>
                <td>{(item.targetWeight * 100).toFixed(2)}%</td>
                <td>{item.avgScore.toFixed(1)}</td>
                <td>{percentView(item.avgWinProbability, 1)}</td>
                <td>{item.codes.join(', ')}</td>
              </tr>
            ))}
            {portfolioSummaries.length === 0 && (
              <tr>
                <td colSpan={6}>暂无持仓汇总数据。</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )

  const industriesSection = (
    <section className="panel">
      <div className="section-title">
        <h2>细分行业</h2>
        <p>对截图里的行业汇总能力做了完整接入，核心看 PB 底、PB 涨幅、PE、总市值与净资产。</p>
      </div>
      <div className="action-row">
        <label className="inline-search">
          <span>搜索行业</span>
          <input
            value={industryQuery}
            onChange={(event) => setIndustryQuery(event.target.value)}
            placeholder="例如 银行 / 汽车零部件"
          />
        </label>
        <button type="button" onClick={exportIndustryTable}>
          导出行业汇总 CSV
        </button>
      </div>
      <div className="table-wrap tall">
        <table>
          <thead>
            <tr>
              <th>细分</th>
              <th>资产负债率</th>
              <th>PB涨幅</th>
              <th>PB底</th>
              <th>PB</th>
              <th>↑PE</th>
              <th>总市值(亿)</th>
              <th>净资产(亿)</th>
              <th>通过数</th>
              <th>行业高分股</th>
            </tr>
          </thead>
          <tbody>
            {visibleIndustries.map((item) => (
              <tr key={item.industry}>
                <td>{item.industry}</td>
                <td>{percentView(item.avgDebtRatio, 0)}</td>
                <td>{percentView(item.pbGain, 1)}</td>
                <td>{show(item.pbFloor)}</td>
                <td>{show(item.pb)}</td>
                <td>{show(item.pe)}</td>
                <td>{yi(item.marketCap, 0)}</td>
                <td>{yi(item.netAsset, 0)}</td>
                <td>
                  {item.eligibleCount} / {item.stockCount}
                </td>
                <td>
                  {item.bestStockName ?? '—'}
                  {item.bestStockCode ? ` (${item.bestStockCode})` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )

  const archivesSection = (
    <section className="panel">
      <div className="section-title">
        <h2>归档</h2>
        <p>保留最近 6 份本地快照，可随时回放当时的股票池、参数与市场快照。</p>
      </div>
      <div className="archive-list">
        {snapshots.map((snapshot) => (
          <article key={snapshot.id} className="archive-card">
            <div>
              <strong>{snapshot.label}</strong>
              <p>{snapshot.createdAt}</p>
              <p>
                {snapshot.dataMeta?.name ?? '本地数据'} / {snapshot.stocks.length} 只股票
              </p>
            </div>
            <div className="action-row">
              <button type="button" onClick={() => handleRestoreSnapshot(snapshot)}>
                恢复
              </button>
              <button
                type="button"
                className="button-secondary"
                onClick={() => handleDeleteSnapshot(snapshot.id)}
              >
                删除
              </button>
            </div>
          </article>
        ))}
        {snapshots.length === 0 && <p className="helper-text">暂无归档，先拉真实数据后点击“归档当前结果”。</p>}
      </div>
    </section>
  )

  const aiSection = (
    <section className="panel">
      <div className="section-title">
        <h2>AI</h2>
        <p>这里先集成基于当前数据实时生成的策略摘要，后续可以再接外部模型。</p>
      </div>
      <div className="ai-grid">
        {aiHighlights.map((line) => (
          <article key={line} className="insight-card">
            <p>{line}</p>
          </article>
        ))}
      </div>
    </section>
  )

  return (
    <div className="workspace-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <strong>大数工作台</strong>
          <p>suiyi / 研究模式</p>
        </div>
        <nav className="nav-list">
          {navItems.map((item) => (
            <button
              key={item.key}
              type="button"
              className={item.key === activeView ? 'nav-item active' : 'nav-item'}
              onClick={() => setActiveView(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <p>当前数据：{dataMeta ? `${dataMeta.total} 只` : '演示数据'}</p>
          <p>未补 K 线：{pendingKline} 只</p>
        </div>
      </aside>

      <main className="workspace-main">
        {activeView === 'overview' && overviewSection}
        {activeView === 'scores' && scoreSection}
        {activeView === 'portfolio' && portfolioSection}
        {activeView === 'portfolioSummary' && portfolioSummarySection}
        {activeView === 'industries' && industriesSection}
        {activeView === 'archives' && archivesSection}
        {activeView === 'ai' && aiSection}

        <footer className="footer-note">
          评分算法还原自「大数模拟器」公开前端产物，方法源头为《大数投资》公开信息；
          行情与财务数据来自东方财富与腾讯公开接口。仅作研究与工具演示，不构成投资建议。
        </footer>
      </main>
    </div>
  )
}

export default App
