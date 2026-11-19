/**
 * 市场温度校正（P2）：查看公共市场温度历史，管理员可校正指定日期的数据。
 *
 * 校正支持「从市场自动拉取」：复用用户端同源的数据抓取与温度计算逻辑，
 * 自动填充当日真实指标，管理员确认后保存，避免手工录入出错。
 */
import { useCallback, useEffect, useState } from 'react'
import { apiGet, apiSend } from '../auth/api'
import { fetchRealMarketData } from '../lib/eastmoney'
import { applyKline, fetchIndexSnapshot, fetchKlines } from '../lib/kline'
import {
  computeMarketTemperature,
  pickKlineCandidates,
  scoreStocks,
} from '../lib/strategy'
import { defaultConfig } from '../data/stocks'
import type { MarketTemperatureRecord } from '../types'

const todayStr = () => {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

const FIELD_LABELS: Array<{ key: keyof MarketTemperatureRecord; label: string }> = [
  { key: 'indexLevel', label: '上证点位' },
  { key: 'exposurePct', label: '建议仓位(%)' },
  { key: 'pbMedian', label: 'PB 中位数' },
  { key: 'peMedian', label: 'PE 中位数' },
  { key: 'belowNetCount', label: '破净股数' },
  { key: 'threeLowCount', label: '三低命中数' },
  { key: 'riskPassedCount', label: '扫雷通过数' },
]

export function MarketTemperaturePanel() {
  const [records, setRecords] = useState<MarketTemperatureRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [editRecord, setEditRecord] = useState<MarketTemperatureRecord | null>(null)
  const [fetching, setFetching] = useState(false)
  const [fetchProgress, setFetchProgress] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const result = await apiGet<{ records: MarketTemperatureRecord[] }>(
      '/api/market-temperature?limit=60',
    )
    setLoading(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setError(null)
    setRecords(result.data.records)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const startEdit = (record: MarketTemperatureRecord) => {
    setEditRecord({ ...record })
  }

  const startNew = () => {
    setEditRecord({
      date: todayStr(),
      indexLevel: null,
      exposurePct: null,
      pbMedian: null,
      peMedian: null,
      belowNetCount: 0,
      threeLowCount: 0,
      riskPassedCount: 0,
    })
  }

  /**
   * 从东方财富公开接口拉取当日全市场真实数据 + 上证点位，
   * 复用 computeMarketTemperature 计算温度并自动填充弹窗字段。
   * 为得到准确的「三低命中数」，会补齐候选股票的一年/三年低价。
   */
  const fetchAndFill = async () => {
    setFetching(true)
    setError(null)
    setFetchProgress('正在连接数据源…')
    try {
      const { stocks } = await fetchRealMarketData((msg) => setFetchProgress(msg))

      // 补齐候选 K 线：三低命中依赖一年内最低价，需回填后才能判定 eligible
      setFetchProgress('正在筛选需补 K 线的候选…')
      const firstPass = scoreStocks(stocks, defaultConfig)
      const candidates = pickKlineCandidates(firstPass, defaultConfig)
      let enriched = stocks
      if (candidates.length > 0) {
        setFetchProgress(`正在补齐 ${candidates.length} 只候选的 K 线…`)
        const kline = await fetchKlines(candidates, defaultConfig.klineDays, (done, total) =>
          setFetchProgress(`正在补齐候选 K 线：${done}/${total}`),
        )
        enriched = applyKline(stocks, kline.data)
      }

      setFetchProgress('正在获取上证指数点位…')
      const indexEntry = await fetchIndexSnapshot()
      const indexLevel = indexEntry?.lastClose ?? null

      const temperature = computeMarketTemperature(enriched, indexLevel, defaultConfig)
      // 保留管理员已选择的日期，只覆盖指标字段
      setEditRecord((prev) =>
        prev
          ? { ...prev, ...temperature, date: prev.date || temperature.date }
          : temperature,
      )
      setFetchProgress(null)
      setNotice(`已拉取并填充 ${stocks.length} 只股票的市场温度`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '拉取市场数据失败')
    } finally {
      setFetching(false)
    }
  }

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!editRecord) return
    setError(null)
    const result = await apiSend<{ updated: boolean; date: string }>(
      `/api/admin/market-temperature/${encodeURIComponent(editRecord.date)}`,
      'PUT',
      { record: editRecord },
    )
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setNotice(`已校正 ${editRecord.date} 的市场温度`)
    setEditRecord(null)
    await load()
  }

  const updateField = (key: keyof MarketTemperatureRecord, value: string) => {
    if (!editRecord) return
    const isCount = key === 'belowNetCount' || key === 'threeLowCount' || key === 'riskPassedCount'
    const parsed = value === '' ? null : Number(value)
    setEditRecord({
      ...editRecord,
      [key]: isCount ? (parsed == null ? 0 : Math.max(0, Math.floor(parsed))) : parsed,
    })
  }

  return (
    <section className="panel">
      <div className="section-title">
        <h2>市场温度校正</h2>
        <p>市场温度为全站公共数据。可查看历史记录，或校正/补充指定日期的数据。</p>
      </div>

      <div className="row-actions" style={{ marginBottom: 12 }}>
        <button type="button" onClick={startNew}>
          校正今日数据
        </button>
      </div>

      {error && <p className="auth-error">{error}</p>}
      {notice && <p className="auth-success">{notice}</p>}

      {loading ? (
        <p className="helper-text">加载中…</p>
      ) : records.length === 0 ? (
        <p className="helper-text">暂无市场温度记录。</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>日期</th>
                <th>上证点位</th>
                <th>仓位(%)</th>
                <th>PB 中位</th>
                <th>PE 中位</th>
                <th>破净数</th>
                <th>三低数</th>
                <th>扫雷通过</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.date}>
                  <td>{record.date}</td>
                  <td>{record.indexLevel?.toFixed(2) ?? '—'}</td>
                  <td>{record.exposurePct?.toFixed(0) ?? '—'}</td>
                  <td>{record.pbMedian?.toFixed(2) ?? '—'}</td>
                  <td>{record.peMedian?.toFixed(2) ?? '—'}</td>
                  <td>{record.belowNetCount}</td>
                  <td>{record.threeLowCount}</td>
                  <td>{record.riskPassedCount}</td>
                  <td>
                    <button
                      type="button"
                      className="button-secondary"
                      onClick={() => startEdit(record)}
                    >
                      校正
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editRecord && (
        <div className="admin-modal-overlay" onClick={() => setEditRecord(null)}>
          <form
            className="panel admin-modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={handleSave}
          >
            <h3>校正市场温度</h3>
            <div className="row-actions" style={{ marginBottom: 12 }}>
              <button
                type="button"
                onClick={fetchAndFill}
                disabled={fetching}
                style={{ marginRight: 8 }}
              >
                {fetching ? '拉取中…' : '从市场自动拉取'}
              </button>
              {fetchProgress && (
                <span className="helper-text" style={{ alignSelf: 'center' }}>
                  {fetchProgress}
                </span>
              )}
            </div>
            <label className="auth-field">
              <span>日期</span>
              <input
                type="date"
                value={editRecord.date}
                onChange={(e) => setEditRecord({ ...editRecord, date: e.target.value })}
                required
              />
            </label>
            <div className="admin-form" style={{ gridTemplateColumns: '1fr 1fr' }}>
              {FIELD_LABELS.map(({ key, label }) => (
                <label className="auth-field" key={key}>
                  <span>{label}</span>
                  <input
                    type="number"
                    step="any"
                    value={editRecord[key] == null ? '' : String(editRecord[key])}
                    onChange={(e) => updateField(key, e.target.value)}
                    disabled={fetching}
                  />
                </label>
              ))}
            </div>
            <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="button-secondary"
                onClick={() => setEditRecord(null)}
                disabled={fetching}
              >
                取消
              </button>
              <button type="submit" disabled={fetching}>
                保存
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  )
}
