/**
 * 邮件发送（可插拔通道）。
 *
 * - 开发期默认使用「控制台桩」：把验证码打印到服务端日志，不真正发信。
 * - 生产用 Brevo 事务邮件 REST API（零 SDK 依赖，直接 fetch）。
 *
 * 预留 SmsChannel：业务层只调用 sendVerificationCode(target, purpose, code)，
 * 将来切短信时只需在此文件新增一个 channel 实现。
 */

const PROVIDER = (process.env.MAIL_PROVIDER || 'console').toLowerCase()
const BREVO_API_KEY = process.env.BREVO_API_KEY || ''
const MAIL_FROM = process.env.MAIL_FROM || '大数选股 <no-reply@example.com>'

const PURPOSE_LABEL = {
  register: '注册账号',
  login: '登录',
  reset: '重置密码',
}

const buildContent = (purpose, code, ttlMinutes) => {
  const label = PURPOSE_LABEL[purpose] ?? '身份验证'
  const subject = `【大数选股】${label}验证码：${code}`
  const text = [
    `你正在${label}。`,
    '',
    `验证码：${code}`,
    `有效期 ${ttlMinutes} 分钟，请勿泄露给他人。`,
    '',
    '如果这不是你的操作，请忽略本邮件。',
  ].join('\n')
  return { subject, text }
}

const sendViaBrevo = async (to, subject, text) => {
  const fromMatch = MAIL_FROM.match(/^(.*)<(.*)>$/)
  const sender = fromMatch
    ? { name: fromMatch[1].trim(), email: fromMatch[2].trim() }
    : { name: '大数选股', email: MAIL_FROM }

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender,
      to: [{ email: to }],
      subject,
      textContent: text,
    }),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Brevo 发送失败（${response.status}）：${detail.slice(0, 200)}`)
  }
}

/** 通过短信发送验证码（预留，未实现） */
const sendViaSms = async () => {
  throw new Error('短信通道尚未接入，请使用邮箱验证码')
}

/**
 * 发送验证码到指定目标（本期内测默认控制台桩）。
 * @param {string} target 邮箱地址
 * @param {'register'|'login'|'reset'} purpose
 * @param {string} code 6 位验证码
 * @param {number} ttlMinutes 有效期（分钟）
 */
export const sendVerificationCode = async (target, purpose, code, ttlMinutes) => {
  const { subject, text } = buildContent(purpose, code, ttlMinutes)

  if (PROVIDER === 'brevo') {
    if (!BREVO_API_KEY) {
      throw new Error('MAIL_PROVIDER=brevo 但未配置 BREVO_API_KEY')
    }
    await sendViaBrevo(target, subject, text)
    return { delivered: 'brevo' }
  }

  if (PROVIDER === 'sms') {
    await sendViaSms()
    return { delivered: 'sms' }
  }

  // 控制台桩：开发/内测使用
  console.log(
    `[mailer:console] 发往 ${target} · ${PURPOSE_LABEL[purpose] ?? purpose} · 验证码 ${code}（${ttlMinutes} 分钟有效）`,
  )
  return { delivered: 'console' }
}

export const MAIL_PROVIDER = PROVIDER
