import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'

const STORAGE_KEY = 'mc-stats-store-v1'

export interface MCScenario {
  id: string
  name: string
  description: string
  params: Record<string, number>
  category: string
}

export interface MCResult {
  scenario: string
  iterations: number
  estimate: number
  trueValue?: number
  error?: number
  samples: number[]
  convergence: number[]
}

export interface HypTestResult {
  testType: string
  statistic: number
  pValue: number
  significant: boolean
  alpha: number
  df?: number
}

export interface ValidationError {
  group: 'A' | 'B'
  type: 'empty' | 'format' | 'count' | 'range'
  message: string
  invalidItems: string[]
}

export interface ValidationResult {
  valid: boolean
  group1: number[]
  group2: number[]
  errors: ValidationError[]
}

function normalRandom(): number {
  let u = 0, v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v)
}

function runMC(scenario: MCScenario, n: number): MCResult {
  const samples: number[] = []
  const convergence: number[] = []

  if (scenario.id === 'pi') {
    let inside = 0
    for (let i = 0; i < n; i++) {
      const x = Math.random() * 2 - 1, y = Math.random() * 2 - 1
      if (x * x + y * y <= 1) inside++
      samples.push(x * x + y * y <= 1 ? 1 : 0)
      convergence.push((inside / (i + 1)) * 4)
    }
    const estimate = (inside / n) * 4
    return { scenario: 'pi', iterations: n, estimate, trueValue: Math.PI, error: Math.abs(estimate - Math.PI), samples, convergence }
  }
  if (scenario.id === 'brownian') {
    let pos = 0
    const dt = scenario.params.dt || 0.01
    for (let i = 0; i < n; i++) { pos += normalRandom() * Math.sqrt(dt); samples.push(pos) }
    convergence.push(...samples.slice(0, 200))
    return { scenario: 'brownian', iterations: n, estimate: pos, samples, convergence }
  }
  if (scenario.id === 'option') {
    const { S0 = 100, K = 105, r = 0.05, sigma = 0.2, T = 1 } = scenario.params
    let payoffSum = 0
    for (let i = 0; i < n; i++) {
      const ST = S0 * Math.exp((r - 0.5 * sigma * sigma) * T + sigma * Math.sqrt(T) * normalRandom())
      const p = Math.max(ST - K, 0); payoffSum += p; samples.push(p)
      if ((i + 1) % 50 === 0) convergence.push((payoffSum / (i + 1)) * Math.exp(-r * T))
    }
    return { scenario: 'option', iterations: n, estimate: (payoffSum / n) * Math.exp(-r * T), samples, convergence }
  }
  if (scenario.id === 'random_walk') {
    let pos = 0
    for (let i = 0; i < n; i++) { pos += Math.random() > 0.5 ? 1 : -1; samples.push(pos) }
    convergence.push(...samples.slice(0, 200))
    return { scenario: 'random_walk', iterations: n, estimate: pos, samples, convergence }
  }
  if (scenario.id === 'diffusion') {
    const { D = 1, dt = 0.01 } = scenario.params
    let x = 0, y = 0
    for (let i = 0; i < n; i++) {
      x += normalRandom() * Math.sqrt(2 * D * dt); y += normalRandom() * Math.sqrt(2 * D * dt)
      samples.push(Math.sqrt(x * x + y * y))
    }
    convergence.push(...samples.slice(0, 200))
    return { scenario: 'diffusion', iterations: n, estimate: Math.sqrt(x * x + y * y), samples, convergence }
  }
  // gambler
  const { p = 0.45, bankroll = 50, goal = 100 } = scenario.params
  let ruinCount = 0
  for (let i = 0; i < n; i++) {
    let money = bankroll
    let steps = 0
    while (money > 0 && money < goal && steps < 10000) { money += Math.random() < p ? 1 : -1; steps++ }
    if (money <= 0) ruinCount++
    samples.push(money <= 0 ? 0 : 1)
    convergence.push(ruinCount / (i + 1))
  }
  return { scenario: 'gambler', iterations: n, estimate: ruinCount / n, samples, convergence }
}

export const SCENARIOS: MCScenario[] = [
  { id: 'pi', name: '圆周率π估算', description: '随机投点估算π值，观察收敛过程', params: {}, category: '基础' },
  { id: 'brownian', name: '布朗运动模拟', description: '粒子热运动随机路径模拟', params: { dt: 0.01 }, category: '物理' },
  { id: 'option', name: '欧式期权定价', description: 'Black-Scholes期权价格蒙特卡洛估算', params: { S0: 100, K: 105, r: 0.05, sigma: 0.2, T: 1 }, category: '金融' },
  { id: 'random_walk', name: '随机游走', description: '一维离散随机游走轨迹模拟', params: {}, category: '基础' },
  { id: 'diffusion', name: '粒子扩散', description: '二维粒子随机扩散位移分析', params: { D: 1, dt: 0.01 }, category: '物理' },
  { id: 'gambler', name: '赌徒破产', description: '不利赌局下资金耗尽概率估算', params: { p: 0.45, bankroll: 50, goal: 100 }, category: '概率' }
]

export function validateAndParseSamples(input1: string, input2: string): ValidationResult {
  const errors: ValidationError[] = []
  let group1: number[] = []
  let group2: number[] = []

  function parseGroup(input: string, groupName: 'A' | 'B'): number[] {
    const trimmed = input.trim()
    if (!trimmed) {
      errors.push({ group: groupName, type: 'empty', message: `样本组${groupName}不能为空`, invalidItems: [] })
      return []
    }
    const rawItems = trimmed.split(',').map(s => s.trim()).filter(s => s !== '')
    const invalidItems: string[] = []
    const numbers: number[] = []
    rawItems.forEach(item => {
      const num = parseFloat(item)
      if (isNaN(num)) {
        invalidItems.push(item)
      } else if (!isFinite(num)) {
        invalidItems.push(item)
      } else {
        numbers.push(num)
      }
    })
    if (invalidItems.length > 0) {
      errors.push({
        group: groupName,
        type: 'format',
        message: `样本组${groupName}包含 ${invalidItems.length} 个无效数值`,
        invalidItems
      })
    }
    if (numbers.length < 2) {
      errors.push({
        group: groupName,
        type: 'count',
        message: `样本组${groupName}至少需要 2 个有效数值，当前仅有 ${numbers.length} 个`,
        invalidItems: []
      })
    }
    return numbers
  }

  group1 = parseGroup(input1, 'A')
  group2 = parseGroup(input2, 'B')

  return { valid: errors.length === 0, group1, group2, errors }
}

export const useMCStore = defineStore('mc', () => {
  const currentScenario = ref<MCScenario>(SCENARIOS[0])
  const iterations = ref(1000)
  const result = ref<MCResult | null>(null)
  const testResult = ref<HypTestResult | null>(null)
  const testErrors = ref<ValidationError[]>([])
  const isRunning = ref(false)
  const group1Input = ref('5.1,4.8,5.3,4.9,5.2,5.0,4.7,5.1,5.4,4.8')
  const group2Input = ref('4.6,4.2,4.9,4.3,4.5,4.7,4.4,4.8,4.1,4.6')

  function persist() {
    try {
      const data = {
        group1Input: group1Input.value,
        group2Input: group2Input.value,
        testResult: testResult.value,
        testErrors: testErrors.value
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    } catch (e) {
      // ignore
    }
  }

  function restore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const data = JSON.parse(raw)
      if (typeof data.group1Input === 'string') group1Input.value = data.group1Input
      if (typeof data.group2Input === 'string') group2Input.value = data.group2Input
      if (data.testResult) testResult.value = data.testResult
      if (Array.isArray(data.testErrors)) testErrors.value = data.testErrors
    } catch (e) {
      // ignore
    }
  }

  function runSimulation() {
    isRunning.value = true
    setTimeout(() => { result.value = runMC(currentScenario.value, iterations.value); isRunning.value = false }, 10)
  }

  function setTestErrors(errors: ValidationError[]) {
    testErrors.value = errors
  }

  function clearTestErrors() {
    testErrors.value = []
  }

  function runTestFromInput() {
    const validation = validateAndParseSamples(group1Input.value, group2Input.value)
    testErrors.value = validation.errors
    if (validation.valid) {
      testResult.value = null
      const g1 = validation.group1, g2 = validation.group2
      const n1 = g1.length, n2 = g2.length
      const m1 = g1.reduce((a, b) => a + b, 0) / n1
      const m2 = g2.reduce((a, b) => a + b, 0) / n2
      const v1 = g1.reduce((s, x) => s + (x - m1) ** 2, 0) / (n1 - 1)
      const v2 = g2.reduce((s, x) => s + (x - m2) ** 2, 0) / (n2 - 1)
      const se = Math.sqrt(v1 / n1 + v2 / n2)
      const t = (m1 - m2) / se
      const df = Math.round((v1 / n1 + v2 / n2) ** 2 / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1)))
      const pValue = 2 * (1 - Math.min(0.9999, Math.abs(t) / (Math.abs(t) + Math.sqrt(df))))
      testResult.value = { testType: 'Welch T检验', statistic: Math.round(t * 1000) / 1000, pValue: Math.round(pValue * 10000) / 10000, significant: pValue < 0.05, alpha: 0.05, df }
    } else {
      testResult.value = null
    }
    persist()
  }

  function setScenario(s: MCScenario) { currentScenario.value = s; result.value = null }

  const convergenceData = computed(() => {
    if (!result.value) return [] as [number, number][]
    return result.value.convergence.slice(0, 200).map((v, i): [number, number] => [i, Math.round(v * 100000) / 100000])
  })

  const histogramData = computed(() => {
    if (!result.value) return { xAxis: [] as number[], data: [] as number[] }
    const s = result.value.samples.slice(0, 1000)
    const mn = Math.min(...s), mx = Math.max(...s)
    const bins = 20, bs = (mx - mn) / bins || 1
    const counts = new Array(bins).fill(0)
    s.forEach(v => { counts[Math.min(bins - 1, Math.floor((v - mn) / bs))]++ })
    return { xAxis: Array.from({ length: bins }, (_, i) => Math.round((mn + i * bs) * 100) / 100), data: counts }
  })

  const group1HasError = computed(() => testErrors.value.some(e => e.group === 'A'))
  const group2HasError = computed(() => testErrors.value.some(e => e.group === 'B'))

  watch([group1Input, group2Input], () => {
    if (testErrors.value.length > 0) {
      const validation = validateAndParseSamples(group1Input.value, group2Input.value)
      testErrors.value = validation.errors
    }
    persist()
  }, { deep: true })

  restore()

  return { currentScenario, iterations, result, testResult, testErrors, isRunning, group1Input, group2Input, group1HasError, group2HasError, convergenceData, histogramData, runSimulation, runTestFromInput, setScenario, setTestErrors, clearTestErrors }
})
