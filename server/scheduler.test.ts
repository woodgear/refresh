import { describe, expect, test } from 'bun:test'
import { jitterDelayFor } from './scheduler'

const INTERVAL = 30 * 60 * 1000

function samples(intervalMs: number, n: number): number[] {
  return Array.from({ length: n }, () => jitterDelayFor(intervalMs))
}

describe('调度间隔抖动', () => {
  test('落在 ±20% 区间内', () => {
    for (const v of samples(INTERVAL, 500)) {
      expect(v).toBeGreaterThanOrEqual(INTERVAL * 0.8)
      expect(v).toBeLessThanOrEqual(INTERVAL * 1.2)
    }
  })

  test('不是常数，也不是只在两端跳', () => {
    const xs = samples(INTERVAL, 500)
    expect(new Set(xs).size).toBeGreaterThan(400)
  })

  test('均值贴在 intervalMs 上，不带系统性偏移', () => {
    const xs = samples(INTERVAL, 2000)
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length
    expect(Math.abs(mean - INTERVAL)).toBeLessThan(INTERVAL * 0.02)
  })

  test('换成别的间隔同样成立（60 分钟）', () => {
    const hour = 60 * 60 * 1000
    for (const v of samples(hour, 200)) {
      expect(v).toBeGreaterThanOrEqual(hour * 0.8)
      expect(v).toBeLessThanOrEqual(hour * 1.2)
    }
  })
})
