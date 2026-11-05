const stripLevelSuffix = (value: string) =>
  value.replace(/[ⅠⅡⅢⅣⅤ]+$/u, '').trim()

type IndustryAlias = {
  sector: string
  industry: string
}

/**
 * 东财公开接口只有单层 `BOARD_NAME`，这里补一层与「大数模拟器」更接近的
 * 行业/细分映射。优先使用人工确认过的别名；未覆盖时退回到“去层级后作为一级行业，
 * 原值作为细分行业”的保守策略。
 */
const INDUSTRY_ALIAS: Record<string, IndustryAlias> = {
  银行Ⅱ: { sector: '银行', industry: '银行' },
  保险Ⅱ: { sector: '保险', industry: '保险' },
  证券Ⅱ: { sector: '证券', industry: '证券Ⅲ' },
  多元金融: { sector: '多元金融', industry: '多元金融Ⅲ' },
  汽车零部件: { sector: '汽车类', industry: '汽车零部件' },
  商用车: { sector: '汽车类', industry: '汽车整车' },
  摩托车及其他: { sector: '汽车类', industry: '汽车服务及其他' },
  电网设备: { sector: '电气设备', industry: '电气自控设备' },
  电池: { sector: '电气设备', industry: '电池' },
  风电设备: { sector: '通用机械', industry: '风电零部件' },
  环境治理: { sector: '环境保护', industry: '固废治理' },
  环保设备Ⅱ: { sector: '环境保护', industry: '环保设备Ⅲ' },
  水务: { sector: '水务', industry: '水务及水治理' },
  基础建设: { sector: '建筑', industry: '基础建设' },
  专业工程: { sector: '建筑', industry: '专业工程' },
  工程咨询服务Ⅱ: { sector: '建筑', industry: '工程咨询服务' },
  房屋建设Ⅱ: { sector: '建筑', industry: '建筑装饰' },
  燃气Ⅱ: { sector: '供气供热', industry: '燃气Ⅲ' },
  电力: { sector: '电力', industry: '电力' },
  工业金属: { sector: '有色', industry: '铝' },
  能源金属: { sector: '有色', industry: '能源金属' },
  农化制品: { sector: '化工', industry: '农化制品' },
  化学制品: { sector: '化工', industry: '其他化学制品' },
  化学制药: { sector: '医药', industry: '化学制剂' },
  中药Ⅱ: { sector: '医药', industry: '中药Ⅲ' },
  医疗器械: { sector: '医疗保健', industry: '医疗设备' },
  医药商业: { sector: '商业连锁', industry: '医药流通' },
  综合Ⅱ: { sector: '商业连锁', industry: '综合Ⅲ' },
  一般零售: { sector: '商业连锁', industry: '百货零售' },
  贸易Ⅱ: { sector: '商贸代理', industry: '贸易' },
  家电零部件Ⅱ: { sector: '家用电器', industry: '家电零部件' },
  白色家电: { sector: '家用电器', industry: '白色家电' },
  厨卫电器: { sector: '家用电器', industry: '厨卫电器' },
  照明设备Ⅱ: { sector: '家用电器', industry: 'LED' },
  饮料乳品: { sector: '食品饮料', industry: '饮料制造' },
  调味发酵品Ⅱ: { sector: '食品饮料', industry: '食品加工制造' },
  食品加工: { sector: '食品饮料', industry: '食品加工制造' },
  纺织制造: { sector: '纺织服饰', industry: '纺织制造' },
  服装家纺: { sector: '纺织服饰', industry: '服装家纺' },
  造纸: { sector: '造纸', industry: '造纸Ⅲ' },
  包装印刷: { sector: '广告包装', industry: '包装' },
  油服工程: { sector: '石油', industry: '油气开采及服务' },
  航运港口: { sector: '交通设施', industry: '港口航运' },
  航空机场: { sector: '交通设施', industry: '机场航运' },
  铁路公路: { sector: '交通设施', industry: '公路铁路运输' },
  轨交设备Ⅱ: { sector: '运输设备', industry: '轨交设备Ⅲ' },
  工程机械: { sector: '工程机械', industry: '工程机械Ⅲ' },
  通用设备: { sector: '通用机械', industry: '通用设备' },
  专用设备: { sector: '工业机械', industry: '其他专用设备' },
  计算机设备: { sector: 'IT设备', industry: '安防设备' },
  通信设备: { sector: '通信设备', industry: '通信网络设备及器件' },
  互联网电商: { sector: '互联网', industry: '互联网电商' },
  出版: { sector: '传媒娱乐', industry: '出版' },
  专业服务: { sector: '文教休闲', industry: '专业服务' },
  种植业: { sector: '农林牧渔', industry: '种植业与林业' },
  橡胶: { sector: '化工', industry: '橡胶制品' },
  装修建材: { sector: '建材', industry: '其他建材' },
  非金属材料Ⅱ: { sector: '矿物制品', industry: '非金属材料' },
  家居用品: { sector: '家居用品', industry: '其他家居用品' },
  化学纤维: { sector: '化纤', industry: '化学纤维' },
}

export const normalizeIndustry = (sourceIndustry: string): IndustryAlias => {
  const trimmed = sourceIndustry.trim()
  const aliased = INDUSTRY_ALIAS[trimmed]
  if (aliased) return aliased

  const sector = stripLevelSuffix(trimmed) || '未分类'
  return {
    sector,
    industry: trimmed || '未分类',
  }
}
