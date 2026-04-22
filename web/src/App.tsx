import { useCallback, useEffect, useMemo, useState } from 'react'
import { DateTime } from 'luxon'
import { QRCodeSVG } from 'qrcode.react'
import './App.css'

const ADMIN_KEY = 'bot_admin_token'
const DEFAULT_TIMEZONE = 'Asia/Almaty'

type WaStatus = {
  success?: boolean
  ready: boolean
  state: string
  qr: string | null
  phone?: string | null
  pushname?: string | null
  error?: string
}

type PlannedBroadcast = {
  id: string
  scheduleAt: string
  scheduleTimezone: string
  prompt: string
  source?: 'manual' | 'weekly'
  weeklyRuleId?: string
}

type WeeklyBroadcastRule = {
  id: string
  weekday: number
  time: string
  prompt: string
  scheduleTimezone: string
}

type BotConfig = {
  groupInviteUrl: string
  scheduleTimezone: string
  scheduleAt: string | null
  plannedBroadcasts?: PlannedBroadcast[]
  weeklyBroadcastRules?: WeeklyBroadcastRule[]
  newsTargetChatId: string | null
  newsTargetTitle: string | null
  lastBroadcastAt: string | null
  lastBroadcastError: string | null
}

type PlannedBroadcastForm = {
  id: string
  scheduleAtLocal: string
  scheduleTimezone: string
  prompt: string
}

type GroupMatch = { id: string; name: string }
type TabKey = 'planned' | 'weekly' | 'now' | 'connect'

const WEEKDAY_LABELS = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота']

function isoToDatetimeLocal(iso: string | null, timeZone: string): string {
  if (!iso) return ''
  const z = (timeZone || DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE
  const dt = DateTime.fromISO(iso, { zone: 'utc' }).setZone(z)
  if (!dt.isValid) return ''
  return dt.toFormat("yyyy-LL-dd'T'HH:mm")
}

/** Интерпретирует `YYYY-MM-DDTHH:mm` как локальное время в указанной IANA-зоне. */
function datetimeLocalToIso(s: string, timeZone: string): string | null {
  const z = (timeZone || DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE
  if (!s.trim()) return null
  const dt = DateTime.fromISO(s.trim(), { zone: z })
  if (!dt.isValid) return null
  return dt.toUTC().toISO()
}

function dayKeyInTimezone(isoUtc: string, timeZone: string): string | null {
  const z = (timeZone || DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE
  const d = new Date(isoUtc)
  if (Number.isNaN(d.getTime())) return null
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: z,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(d)
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(d)
  }
}

function plannedInstantMs(slot: PlannedBroadcastForm, defaultTz: string): number {
  const z = (slot.scheduleTimezone || defaultTz).trim() || DEFAULT_TIMEZONE
  const dt = DateTime.fromISO(slot.scheduleAtLocal.trim(), { zone: z })
  return dt.isValid ? dt.toUTC().toMillis() : Number.NaN
}

function todayLocalDate(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function makePlannedId(): string {
  return `pb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function makeWeeklyRuleId(): string {
  return `wr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function formatPlannedLocalDateTime(scheduleAtLocal: string, timeZone: string): string {
  if (!scheduleAtLocal) return 'Дата и время не заданы'
  const z = (timeZone || DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE
  const dt = DateTime.fromISO(scheduleAtLocal.trim(), { zone: z })
  if (!dt.isValid) return scheduleAtLocal.replace('T', ' ')
  return dt.setLocale('ru').toLocaleString(DateTime.DATETIME_SHORT)
}

function nextThreeMonthsDatesForWeekday(weekday: number): string[] {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setMonth(end.getMonth() + 3)
  const dates: string[] = []
  const cursor = new Date(start)
  const diff = (weekday - cursor.getDay() + 7) % 7
  cursor.setDate(cursor.getDate() + diff)
  while (cursor.getTime() <= end.getTime()) {
    dates.push(cursor.toLocaleDateString())
    cursor.setDate(cursor.getDate() + 7)
  }
  return dates
}

function authHeaders(): HeadersInit {
  const token = localStorage.getItem(ADMIN_KEY)?.trim()
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

async function readApiJsonSafe(r: Response): Promise<any> {
  const text = await r.text()
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    const looksLikeHtml = text.trimStart().startsWith('<!DOCTYPE') || text.trimStart().startsWith('<html')
    return {
      success: false,
      error: looksLikeHtml
        ? 'Сервер вернул HTML вместо JSON. Обычно это значит, что API-роут не подхватился. Перезапустите сервер (npm start) и попробуйте снова.'
        : `Некорректный ответ сервера: ${text.slice(0, 240)}`
    }
  }
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('planned')
  const [selectedDate, setSelectedDate] = useState(todayLocalDate())
  const [wa, setWa] = useState<WaStatus | null>(null)
  const [cfg, setCfg] = useState<BotConfig | null>(null)
  const [form, setForm] = useState({
    groupInviteUrl: '',
    scheduleTimezone: DEFAULT_TIMEZONE,
    newsTargetChatId: '',
    newsTargetTitle: '',
    plannedBroadcasts: [] as PlannedBroadcastForm[],
    weeklyBroadcastRules: [] as WeeklyBroadcastRule[]
  })
  const [nowPrompt, setNowPrompt] = useState('')
  const [groupSearch, setGroupSearch] = useState('')
  const [groupMatches, setGroupMatches] = useState<GroupMatch[]>([])
  const [groupSearchLoading, setGroupSearchLoading] = useState(false)
  const [groupSearchErr, setGroupSearchErr] = useState<string | null>(null)
  const [adminToken, setAdminToken] = useState(() => localStorage.getItem(ADMIN_KEY) || '')
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const loadConfig = useCallback(async () => {
    const r = await fetch('/api/config')
    const j = await r.json()
    if (j.success && j.config) {
      const c = j.config as BotConfig
      const planned = Array.isArray(c.plannedBroadcasts) ? c.plannedBroadcasts : []
      const weeklyRules = Array.isArray(c.weeklyBroadcastRules) ? c.weeklyBroadcastRules : []
      const normalizedPlanned = planned.length
        ? planned
        : c.scheduleAt
          ? [{ id: `legacy_${c.scheduleAt}`, scheduleAt: c.scheduleAt, scheduleTimezone: c.scheduleTimezone, prompt: '' }]
          : []
      setCfg(c)
      setForm({
        groupInviteUrl: c.groupInviteUrl || '',
        scheduleTimezone: c.scheduleTimezone || DEFAULT_TIMEZONE,
        newsTargetChatId: c.newsTargetChatId || '',
        newsTargetTitle: c.newsTargetTitle || '',
        plannedBroadcasts: normalizedPlanned
          .filter((p) => p.source !== 'weekly')
          .map((p) => ({
          id: p.id,
          scheduleAtLocal: isoToDatetimeLocal(p.scheduleAt, p.scheduleTimezone || c.scheduleTimezone || DEFAULT_TIMEZONE),
          scheduleTimezone: p.scheduleTimezone || c.scheduleTimezone || DEFAULT_TIMEZONE,
          prompt: p.prompt || ''
          })),
        weeklyBroadcastRules: weeklyRules.map((r) => ({
          id: r.id,
          weekday: r.weekday,
          time: r.time,
          prompt: r.prompt || '',
          scheduleTimezone: r.scheduleTimezone || c.scheduleTimezone || DEFAULT_TIMEZONE
        }))
      })
    }
  }, [])

  const pollWa = useCallback(async () => {
    try {
      const r = await fetch('/api/whatsapp/status')
      const j = (await r.json()) as WaStatus
      setWa(j)
    } catch {
      setWa({
        ready: false,
        state: 'ERROR',
        qr: null,
        error: 'Нет связи с сервером'
      })
    }
  }, [])

  useEffect(() => {
    void loadConfig()
  }, [loadConfig])

  useEffect(() => {
    void pollWa()
    const id = setInterval(() => void pollWa(), 2500)
    return () => clearInterval(id)
  }, [pollWa])

  useEffect(() => {
    localStorage.setItem(ADMIN_KEY, adminToken)
  }, [adminToken])

  const connected = wa?.ready === true
  const showQr = !connected && wa?.qr

  const selectedDayIndexes = useMemo(() => {
    return form.plannedBroadcasts
      .map((item, idx) => ({ item, idx }))
      .filter(({ item }) => item.scheduleAtLocal.startsWith(`${selectedDate}T`) || item.scheduleAtLocal === '')
      .map(({ idx }) => idx)
  }, [form.plannedBroadcasts, selectedDate])

  const plannedSortedIndexes = useMemo(() => {
    return form.plannedBroadcasts
      .map((item, idx) => ({ item, idx }))
      .sort((a, b) => {
        const ta = plannedInstantMs(a.item, form.scheduleTimezone)
        const tb = plannedInstantMs(b.item, form.scheduleTimezone)
        if (Number.isNaN(ta) && Number.isNaN(tb)) return 0
        if (Number.isNaN(ta)) return 1
        if (Number.isNaN(tb)) return -1
        return ta - tb
      })
      .map(({ idx }) => idx)
  }, [form.plannedBroadcasts, form.scheduleTimezone])

  const canAddSlot = selectedDayIndexes.length < 2

  function updatePlannedSlot(idx: number, patch: Partial<PlannedBroadcastForm>) {
    setForm((f) => {
      const next = [...f.plannedBroadcasts]
      next[idx] = { ...next[idx], ...patch }
      return { ...f, plannedBroadcasts: next }
    })
  }

  function addPlannedSlot() {
    setSaveErr(null)
    if (!canAddSlot) {
      setSaveErr(`На ${selectedDate} уже задано 2 рассылки.`)
      return
    }
    const defaultTime = selectedDayIndexes.length === 0 ? '10:00' : '18:00'
    setForm((f) => ({
      ...f,
      plannedBroadcasts: [
        ...f.plannedBroadcasts,
        {
          id: makePlannedId(),
          scheduleAtLocal: `${selectedDate}T${defaultTime}`,
          scheduleTimezone: f.scheduleTimezone,
          prompt: ''
        }
      ]
    }))
  }

  function removePlannedSlot(idx: number) {
    setForm((f) => ({
      ...f,
      plannedBroadcasts: f.plannedBroadcasts.filter((_, i) => i !== idx)
    }))
  }

  const weeklySlotsByDay = useMemo(() => {
    const byDay: Record<number, WeeklyBroadcastRule[]> = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] }
    for (const rule of form.weeklyBroadcastRules) {
      if (byDay[rule.weekday]) byDay[rule.weekday].push(rule)
    }
    for (const day of Object.keys(byDay)) {
      byDay[Number(day)].sort((a, b) => a.time.localeCompare(b.time))
    }
    return byDay
  }, [form.weeklyBroadcastRules])

  function addWeeklySlot(weekday: number) {
    const dayRules = weeklySlotsByDay[weekday] || []
    if (dayRules.length >= 2) {
      setSaveErr(`Для ${WEEKDAY_LABELS[weekday]} можно задать максимум 2 рассылки.`)
      return
    }
    const defaultTime = dayRules.length === 0 ? '10:00' : '18:00'
    setSaveErr(null)
    setForm((f) => ({
      ...f,
      weeklyBroadcastRules: [
        ...f.weeklyBroadcastRules,
        {
          id: makeWeeklyRuleId(),
          weekday,
          time: defaultTime,
          prompt: '',
          scheduleTimezone: f.scheduleTimezone
        }
      ]
    }))
  }

  function updateWeeklySlot(ruleId: string, patch: Partial<WeeklyBroadcastRule>) {
    setForm((f) => ({
      ...f,
      weeklyBroadcastRules: f.weeklyBroadcastRules.map((r) => (r.id === ruleId ? { ...r, ...patch } : r))
    }))
  }

  function removeWeeklySlot(ruleId: string) {
    setForm((f) => ({
      ...f,
      weeklyBroadcastRules: f.weeklyBroadcastRules.filter((r) => r.id !== ruleId)
    }))
  }

  async function savePlannedConfig() {
    setSaveMsg(null)
    setSaveErr(null)
    setBusy(true)
    try {
      const byDate = new Map<string, number>()
      const plannedPayload: PlannedBroadcast[] = []
      for (const item of form.plannedBroadcasts) {
        const tz = item.scheduleTimezone || form.scheduleTimezone
        const iso = datetimeLocalToIso(item.scheduleAtLocal, tz)
        if (!iso) {
          setSaveErr('Укажите корректную дату и время для всех плановых рассылок.')
          setBusy(false)
          return
        }
        const t = new Date(iso).getTime()
        if (t <= Date.now()) {
          setSaveErr('Плановая рассылка должна быть в будущем.')
          setBusy(false)
          return
        }
        const dayKey = dayKeyInTimezone(iso, tz)
        if (!dayKey) {
          setSaveErr('Некорректный часовой пояс. Укажите IANA, например Asia/Almaty.')
          setBusy(false)
          return
        }
        const dayCount = (byDate.get(dayKey) || 0) + 1
        byDate.set(dayKey, dayCount)
        if (dayCount > 2) {
          setSaveErr(`На ${dayKey} можно задать максимум 2 рассылки.`)
          setBusy(false)
          return
        }
        plannedPayload.push({
          id: item.id || makePlannedId(),
          scheduleAt: iso,
          scheduleTimezone: item.scheduleTimezone || form.scheduleTimezone,
          prompt: item.prompt.trim(),
          source: 'manual'
        })
      }

      const r = await fetch('/api/config', {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({
          plannedBroadcasts: plannedPayload,
          scheduleTimezone: form.scheduleTimezone,
          scheduleAt: null
        })
      })
      const j = await r.json()
      if (!r.ok) {
        setSaveErr(j.error || `Ошибка ${r.status}`)
        return
      }
      setSaveMsg('Плановые рассылки сохранены')
      if (j.config) {
        setCfg(j.config as BotConfig)
        void loadConfig()
      }
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function saveWeeklyConfig() {
    setSaveMsg(null)
    setSaveErr(null)
    setBusy(true)
    try {
      const byDay = new Map<number, number>()
      const payload = form.weeklyBroadcastRules.map((r) => {
        const c = (byDay.get(r.weekday) || 0) + 1
        byDay.set(r.weekday, c)
        return {
          id: r.id || makeWeeklyRuleId(),
          weekday: r.weekday,
          time: r.time,
          prompt: r.prompt.trim(),
          scheduleTimezone: r.scheduleTimezone || form.scheduleTimezone
        }
      })
      for (const [weekday, count] of byDay.entries()) {
        if (count > 2) {
          setSaveErr(`Для ${WEEKDAY_LABELS[weekday]} можно задать максимум 2 рассылки.`)
          setBusy(false)
          return
        }
      }
      const r = await fetch('/api/config', {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({
          weeklyBroadcastRules: payload,
          scheduleTimezone: form.scheduleTimezone
        })
      })
      const j = await r.json()
      if (!r.ok) {
        setSaveErr(j.error || `Ошибка ${r.status}`)
        return
      }
      setSaveMsg('Еженедельный план сохранен на 3 месяца')
      if (j.config) {
        setCfg(j.config as BotConfig)
        void loadConfig()
      }
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function refreshWeeklyDates() {
    setSaveMsg(null)
    setSaveErr(null)
    setBusy(true)
    try {
      const r = await fetch('/api/weekly/refresh', {
        method: 'POST',
        headers: authHeaders()
      })
      const j = await readApiJsonSafe(r)
      if (!r.ok) {
        setSaveErr(j.error || `Ошибка ${r.status}`)
        return
      }
      setSaveMsg('Даты еженедельных рассылок обновлены на 3 месяца вперед')
      if (j.config) {
        setCfg(j.config as BotConfig)
        void loadConfig()
      }
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function saveConnectionConfig() {
    setSaveMsg(null)
    setSaveErr(null)
    setBusy(true)
    try {
      const chatId = form.newsTargetChatId.trim()
      const r = await fetch('/api/config', {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({
          groupInviteUrl: form.groupInviteUrl,
          newsTargetChatId: chatId || null,
          newsTargetTitle: chatId ? form.newsTargetTitle.trim() || null : null
        })
      })
      const j = await r.json()
      if (!r.ok) {
        setSaveErr(j.error || `Ошибка ${r.status}`)
        return
      }
      setSaveMsg('Подключение и группа сохранены')
      if (j.config) setCfg(j.config)
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function runBroadcastNow() {
    setSaveMsg(null)
    setSaveErr(null)
    setBusy(true)
    try {
      const r = await fetch('/api/broadcast/run', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          prompt: nowPrompt.trim() || null
        })
      })
      const j = await r.json()
      if (!r.ok) {
        setSaveErr(j.error || `Ошибка ${r.status}`)
        if (j.config) setCfg(j.config)
        return
      }
      setSaveMsg('Рассылка отправлена')
      if (j.config) setCfg(j.config)
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function searchGroupsByName() {
    setGroupSearchErr(null)
    setGroupMatches([])
    const q = groupSearch.trim()
    if (!q) {
      setGroupSearchErr('Введите часть названия группы.')
      return
    }
    if (!connected) {
      setGroupSearchErr('Сначала подключите WhatsApp.')
      return
    }
    setGroupSearchLoading(true)
    try {
      const r = await fetch(`/api/whatsapp/groups/search?q=${encodeURIComponent(q)}`)
      const j = await r.json()
      if (!r.ok) {
        setGroupSearchErr(j.error || `Ошибка ${r.status}`)
        return
      }
      setGroupMatches((j.matches as GroupMatch[]) || [])
      if (!(j.matches as GroupMatch[])?.length) {
        setGroupSearchErr('Ничего не найдено. Проверьте название — бот должен уже состоять в этой группе.')
      }
    } catch (e) {
      setGroupSearchErr(e instanceof Error ? e.message : String(e))
    } finally {
      setGroupSearchLoading(false)
    }
  }

  async function pickGroup(id: string, name: string) {
    setSaveMsg(null)
    setSaveErr(null)
    setGroupSearchErr(null)
    setBusy(true)
    try {
      const r = await fetch('/api/config', {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ newsTargetChatId: id, newsTargetTitle: name })
      })
      const j = await r.json()
      if (!r.ok) {
        setSaveErr(j.error || `Ошибка ${r.status}`)
        return
      }
      setSaveMsg(`Группа «${name}» выбрана для рассылки`)
      setGroupMatches([])
      if (j.config) {
        setCfg(j.config)
        const c = j.config as BotConfig
        setForm((f) => ({
          ...f,
          newsTargetChatId: c.newsTargetChatId || '',
          newsTargetTitle: c.newsTargetTitle || ''
        }))
      }
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h1>Новостной WhatsApp-бот</h1>
      <p className="sub">
        Планируйте рассылки через календарь, отправляйте сообщения сразу и управляйте подключением аккаунта.
      </p>

      <div className="tabs">
        <button type="button" className={`tab-btn ${activeTab === 'planned' ? 'active' : ''}`} onClick={() => setActiveTab('planned')}>
          Плановая рассылка
        </button>
        <button type="button" className={`tab-btn ${activeTab === 'weekly' ? 'active' : ''}`} onClick={() => setActiveTab('weekly')}>
          Еженедельная
        </button>
        <button type="button" className={`tab-btn ${activeTab === 'now' ? 'active' : ''}`} onClick={() => setActiveTab('now')}>
          Рассылка сейчас
        </button>
        <button type="button" className={`tab-btn ${activeTab === 'connect' ? 'active' : ''}`} onClick={() => setActiveTab('connect')}>
          Аккаунт и чаты
        </button>
      </div>

      {activeTab === 'planned' && (
        <div className="card">
          <h2>Календарь плановой рассылки</h2>
          <p className="sub" style={{ marginBottom: '1rem' }}>
            Выберите день и добавьте до двух рассылок: время + специальный промпт для этой отправки.
          </p>
          <div className="field">
            <label htmlFor="plan-date">День рассылки</label>
            <input id="plan-date" type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} />
          </div>

          <div className="stack-actions" style={{ marginTop: 0, marginBottom: '1rem' }}>
            <button type="button" className="btn secondary" disabled={busy || !canAddSlot} onClick={addPlannedSlot}>
              Добавить рассылку в этот день
            </button>
          </div>

          {form.plannedBroadcasts.length === 0 && (
            <p className="hint">Пока нет рассылок. Нажмите «Добавить рассылку в этот день».</p>
          )}

          {plannedSortedIndexes.map((idx, pos) => {
            const slot = form.plannedBroadcasts[idx]
            const dateValue = slot.scheduleAtLocal.includes('T') ? slot.scheduleAtLocal.slice(0, 10) : selectedDate
            const timeValue = slot.scheduleAtLocal.includes('T') ? slot.scheduleAtLocal.slice(11, 16) : '10:00'
            return (
              <div className="planned-slot" key={slot.id}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <strong>Рассылка #{pos + 1}</strong>
                  <button type="button" className="btn secondary" disabled={busy} onClick={() => removePlannedSlot(idx)}>
                    Удалить
                  </button>
                </div>
                <p className="hint" style={{ marginTop: '0.5rem' }}>
                  Запланировано на:{' '}
                  {formatPlannedLocalDateTime(slot.scheduleAtLocal, slot.scheduleTimezone || form.scheduleTimezone)}
                </p>
                <div className="field" style={{ marginTop: '0.75rem' }}>
                  <label htmlFor={`date-${slot.id}`}>Дата</label>
                  <input
                    id={`date-${slot.id}`}
                    type="date"
                    value={dateValue}
                    onChange={(e) =>
                      updatePlannedSlot(idx, {
                        scheduleAtLocal: `${e.target.value}T${timeValue}`
                      })
                    }
                  />
                </div>
                <div className="field">
                  <label htmlFor={`time-${slot.id}`}>Время</label>
                  <input
                    id={`time-${slot.id}`}
                    type="time"
                    value={timeValue}
                    onChange={(e) =>
                      updatePlannedSlot(idx, {
                        scheduleAtLocal: `${dateValue}T${e.target.value}`
                      })
                    }
                  />
                </div>
                <div className="field">
                  <label htmlFor={`prompt-${slot.id}`}>Промпт для этой рассылки</label>
                  <textarea
                    id={`prompt-${slot.id}`}
                    value={slot.prompt}
                    onChange={(e) => updatePlannedSlot(idx, { prompt: e.target.value })}
                    placeholder="Например: сделай короткий дайджест по локальным новостям и в конце добавь CTA..."
                  />
                </div>
              </div>
            )
          })}

          <div className="field">
            <label htmlFor="tz">Часовой пояс</label>
            <input
              id="tz"
              type="text"
              value={form.scheduleTimezone}
              onChange={(e) => setForm((f) => ({ ...f, scheduleTimezone: e.target.value }))}
              placeholder="Europe/Moscow"
            />
            <p className="hint">
              Дата и время слотов считаются в этом часовом поясе. План сработает только если в это время запущен сервер
              бота (например <code>npm start</code>) и WhatsApp остаётся подключённым.
            </p>
          </div>

          {cfg?.lastBroadcastAt && <p className="hint">Последняя рассылка: {new Date(cfg.lastBroadcastAt).toLocaleString()}</p>}
          {cfg?.lastBroadcastError && <p className="err-text">Ошибка рассылки: {cfg.lastBroadcastError}</p>}

          <div className="stack-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => void savePlannedConfig()}>
              Сохранить план
            </button>
          </div>
        </div>
      )}

      {activeTab === 'weekly' && (
        <div className="card">
          <h2>Еженедельная рассылка на 3 месяца</h2>
          <p className="sub" style={{ marginBottom: '1rem' }}>
            Выберите дни недели, задайте до двух рассылок на каждый день и промпт для каждого слота.
          </p>

          <div className="field">
            <label htmlFor="weekly-tz">Часовой пояс</label>
            <input
              id="weekly-tz"
              type="text"
              value={form.scheduleTimezone}
              onChange={(e) => setForm((f) => ({ ...f, scheduleTimezone: e.target.value }))}
              placeholder="Europe/Moscow"
            />
          </div>

          {WEEKDAY_LABELS.map((label, weekday) => {
            const daySlots = weeklySlotsByDay[weekday] || []
            const dates = nextThreeMonthsDatesForWeekday(weekday)
            return (
              <div className="planned-slot" key={`weekday-${weekday}`}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <strong>{label}</strong>
                  <button type="button" className="btn secondary" disabled={busy || daySlots.length >= 2} onClick={() => addWeeklySlot(weekday)}>
                    Добавить время
                  </button>
                </div>
                <p className="hint" style={{ marginTop: '0.5rem' }}>
                  Даты на 3 месяца: {dates.join(', ')}
                </p>
                {daySlots.length === 0 && <p className="hint">Рассылки для этого дня недели не заданы.</p>}
                {daySlots.map((slot, idx) => (
                  <div className="planned-slot weekly-inner" key={slot.id}>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <strong>Слот #{idx + 1}</strong>
                      <button type="button" className="btn secondary" disabled={busy} onClick={() => removeWeeklySlot(slot.id)}>
                        Удалить
                      </button>
                    </div>
                    <div className="field" style={{ marginTop: '0.75rem' }}>
                      <label htmlFor={`weekly-time-${slot.id}`}>Время</label>
                      <input
                        id={`weekly-time-${slot.id}`}
                        type="time"
                        value={slot.time}
                        onChange={(e) => updateWeeklySlot(slot.id, { time: e.target.value })}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor={`weekly-prompt-${slot.id}`}>Промпт</label>
                      <textarea
                        id={`weekly-prompt-${slot.id}`}
                        value={slot.prompt}
                        onChange={(e) => updateWeeklySlot(slot.id, { prompt: e.target.value })}
                        placeholder="Что именно отправлять по этому расписанию"
                      />
                    </div>
                  </div>
                ))}
              </div>
            )
          })}

          <div className="stack-actions">
            <button type="button" className="btn secondary" disabled={busy} onClick={() => void refreshWeeklyDates()}>
              Обновить даты
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void saveWeeklyConfig()}>
              Сохранить еженедельный план
            </button>
          </div>
        </div>
      )}

      {activeTab === 'now' && (
        <div className="card">
          <h2>Рассылка сейчас</h2>
          <p className="sub" style={{ marginBottom: '1rem' }}>
            Укажите дополнительный промпт (по желанию) и отправьте одно сообщение в выбранный чат прямо сейчас.
          </p>
          <div className="field">
            <label htmlFor="now-prompt">Промпт для текущей рассылки</label>
            <textarea
              id="now-prompt"
              value={nowPrompt}
              onChange={(e) => setNowPrompt(e.target.value)}
              placeholder="Например: акцент на итогах дня, коротко и без эмодзи"
            />
          </div>
          <div className="stack-actions">
            <button type="button" className="btn" disabled={busy || !connected} onClick={() => void runBroadcastNow()}>
              Отправить сейчас
            </button>
          </div>
        </div>
      )}

      {activeTab === 'connect' && (
        <>
          <div className="card">
            <h2>Подключение WhatsApp</h2>
            {wa == null && <p className="sub">Загрузка статуса…</p>}
            {wa && (
              <>
                <div className="row">
                  <span className={`status-pill ${connected ? 'ok' : 'wait'}`}>
                    {connected ? 'Подключено' : showQr ? 'Ожидание сканирования QR' : 'Не подключено'}
                  </span>
                  {connected && wa.phone && (
                    <span className="mono">
                      +{wa.phone}
                      {wa.pushname ? ` · ${wa.pushname}` : ''}
                    </span>
                  )}
                </div>
                {wa.state && (
                  <p className="hint" style={{ marginTop: '0.5rem' }}>
                    Состояние: {wa.state}
                  </p>
                )}
                {showQr && (
                  <div className="qr-wrap">
                    <QRCodeSVG value={wa.qr!} size={240} level="M" />
                  </div>
                )}
                {connected && <p className="ok-text">Номер привязан, бот готов к работе.</p>}
                {!connected && !showQr && (
                  <p className="hint">
                    Откройте WhatsApp на телефоне → Связанные устройства → Привязка устройства. QR появится здесь, когда сервер его получит.
                  </p>
                )}
                {wa.error && <p className="err-text">{wa.error}</p>}
              </>
            )}
          </div>

          <div className="card">
            <h2>Группы и чаты для рассылки</h2>
            <p className="sub" style={{ marginBottom: '1rem' }}>
              Бот должен быть участником группы. Можно найти группу по названию или указать ID вручную.
            </p>

            <div className="field">
              <label htmlFor="gsearch">Название группы (часть имени)</label>
              <div className="row" style={{ gap: '0.5rem' }}>
                <input
                  id="gsearch"
                  type="text"
                  value={groupSearch}
                  onChange={(e) => setGroupSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void searchGroupsByName()
                    }
                  }}
                  placeholder="Например: Новости или Команда"
                  style={{ flex: '1 1 200px' }}
                />
                <button
                  type="button"
                  className="btn secondary"
                  disabled={busy || groupSearchLoading || !connected}
                  onClick={() => void searchGroupsByName()}
                >
                  {groupSearchLoading ? 'Поиск…' : 'Найти'}
                </button>
              </div>
              {groupSearchErr && <p className="err-text">{groupSearchErr}</p>}
              {groupMatches.length > 0 && (
                <ul className="group-pick-list" aria-label="Совпадения">
                  {groupMatches.map((m) => (
                    <li key={m.id}>
                      <button type="button" disabled={busy} onClick={() => void pickGroup(m.id, m.name)}>
                        <strong>{m.name}</strong>
                        <span className="mono" style={{ display: 'block', fontSize: '0.75rem', opacity: 0.75 }}>
                          {m.id}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {(cfg?.newsTargetTitle || cfg?.newsTargetChatId) && (
              <div className="current-group">
                <strong>Группа для рассылки:</strong> {cfg?.newsTargetTitle || 'без названия'}
                {cfg?.newsTargetChatId && (
                  <span className="mono" style={{ display: 'block', marginTop: '0.25rem', fontSize: '0.75rem' }}>
                    {cfg.newsTargetChatId}
                  </span>
                )}
              </div>
            )}

            <p className="sub" style={{ margin: '1rem 0 0.5rem' }}>
              Либо вступите по ссылке-приглашению:
            </p>
            <div className="field">
              <label htmlFor="invite">Ссылка invite</label>
              <input
                id="invite"
                type="text"
                value={form.groupInviteUrl}
                onChange={(e) => setForm((f) => ({ ...f, groupInviteUrl: e.target.value }))}
                placeholder="https://chat.whatsapp.com/…"
              />
            </div>

            <details className="advanced">
              <summary>Вручную: ID чата</summary>
              <div className="field" style={{ marginTop: '0.75rem' }}>
                <label htmlFor="chatid">ID (…@g.us)</label>
                <input
                  id="chatid"
                  type="text"
                  className="mono"
                  value={form.newsTargetChatId}
                  onChange={(e) => setForm((f) => ({ ...f, newsTargetChatId: e.target.value }))}
                  placeholder="123456789-123456@g.us"
                />
                <p className="hint">Подпись для панели (необязательно):</p>
                <input
                  type="text"
                  aria-label="Название для отображения"
                  value={form.newsTargetTitle}
                  onChange={(e) => setForm((f) => ({ ...f, newsTargetTitle: e.target.value }))}
                  placeholder="Как показывать в интерфейсе"
                />
              </div>
            </details>

            <div className="field">
              <label htmlFor="token">Токен API (опционально)</label>
              <input
                id="token"
                type="password"
                autoComplete="off"
                value={adminToken}
                onChange={(e) => setAdminToken(e.target.value)}
                placeholder="Пусто, если ADMIN_TOKEN не используется"
              />
            </div>

            <div className="stack-actions">
              <button type="button" className="btn" disabled={busy} onClick={() => void saveConnectionConfig()}>
                Сохранить подключение
              </button>
            </div>
          </div>
        </>
      )}

      {saveMsg && <p className="ok-text">{saveMsg}</p>}
      {saveErr && <p className="err-text">{saveErr}</p>}
    </>
  )
}
