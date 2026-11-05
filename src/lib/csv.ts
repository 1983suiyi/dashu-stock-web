export type CsvCell = string | number | null

const escapeCell = (value: CsvCell) => {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 生成 CSV 文本，使用 CRLF 以兼容 Excel */
export const toCsv = (headers: string[], rows: CsvCell[][]) =>
  [headers, ...rows]
    .map((row) => row.map(escapeCell).join(','))
    .join('\r\n')

/**
 * 触发浏览器下载。
 * 前缀 BOM 是为了让 Excel 正确识别 UTF-8 中文，否则会显示乱码。
 */
export const downloadCsv = (filename: string, content: string) => {
  const blob = new Blob([`\uFEFF${content}`], {
    type: 'text/csv;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
