const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/

export interface ParsedRfc3339 {
  readonly epochSecond: number
  readonly fraction: string
}

export function parseRfc3339(value: string): ParsedRfc3339 | null {
  const match = RFC3339.exec(value)
  if (match === null) {
    return null
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const fraction = match[7] ?? ''
  const offsetSign = match[9]
  const offsetHour = Number(match[10] ?? 0)
  const offsetMinute = Number(match[11] ?? 0)

  if (
    month < 1
    || month > 12
    || day < 1
    || day > daysInMonth(year, month)
    || hour > 23
    || minute > 59
    || second > 60
    || offsetHour > 23
    || offsetMinute > 59
  ) {
    return null
  }

  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, Math.min(second, 59), 0)

  const direction = offsetSign === '-' ? -1 : 1
  const offsetSeconds = direction * ((offsetHour * 60 + offsetMinute) * 60)
  const leapSecond = second === 60 ? 1 : 0
  return {
    epochSecond: date.getTime() / 1000 + leapSecond - offsetSeconds,
    fraction,
  }
}

export function compareRfc3339(left: string, right: string): number {
  const parsedLeft = parseRfc3339(left)
  const parsedRight = parseRfc3339(right)
  if (parsedLeft === null || parsedRight === null) {
    return left.localeCompare(right)
  }
  if (parsedLeft.epochSecond !== parsedRight.epochSecond) {
    return parsedLeft.epochSecond - parsedRight.epochSecond
  }
  const fractionLength = Math.max(parsedLeft.fraction.length, parsedRight.fraction.length)
  return parsedLeft.fraction.padEnd(fractionLength, '0')
    .localeCompare(parsedRight.fraction.padEnd(fractionLength, '0'))
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
    return leap ? 29 : 28
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

