import { useCallback, useEffect, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import './App.css'

const ADMIN_KEY = 'bot_admin_token'

type WaStatus = {
  success?: boolean
  ready: boolean
  state: string
  qr: string | null
  phone?: string | null
  pushname?: string | null
  error?: string
}

type BotConfig = {
  theme: string
  role: string
  rules: string
  groupInviteUrl: string
  scheduleAt: string | null
  scheduleTimezone: string
  newsTargetChatId: string | null
  newsTargetTitle: string | null
  lastBroadcastAt: string | null
  lastBroadcastError: string | null
}

type GroupMatch = { id: string; name: string }

function isoToDatetimeLocal(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function datetimeLocalToIso(s: string): string | null {
  if (!s.trim()) return null
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

function authHeaders(): HeadersInit {
  const token = localStorage.getItem(ADMIN_KEY)?.trim()
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

export default function App() {
  const [wa, setWa] = useState<WaStatus | null>(null)
  const [cfg, setCfg] = useState<BotConfig | null>(null)
  const [form, setForm] = useState({
    theme: '',
    role: '',
    rules: '',
    groupInviteUrl: '',
    scheduleAtLocal: '',
    scheduleTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    newsTargetChatId: '',
    newsTargetTitle: ''
  })
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
      setCfg(c)
      setForm({
        theme: c.theme || '',
        role: c.role || '',
        rules: c.rules || '',
        groupInviteUrl: c.groupInviteUrl || '',
        scheduleAtLocal: isoToDatetimeLocal(c.scheduleAt),
        scheduleTimezone: c.scheduleTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
        newsTargetChatId: c.newsTargetChatId || '',
        newsTargetTitle: c.newsTargetTitle || ''
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
    loadConfig()
  }, [loadConfig])

  useEffect(() => {
    pollWa()
    const id = setInterval(pollWa, 2500)
    return () => clearInterval(id)
  }, [pollWa])

  useEffect(() => {
    localStorage.setItem(ADMIN_KEY, adminToken)
  }, [adminToken])

  async function saveConfig() {
    setSaveMsg(null)
    setSaveErr(null)
    setBusy(true)
    try {
      const scheduleAt = datetimeLocalToIso(form.scheduleAtLocal)
      const chatId = form.newsTargetChatId.trim()
      const r = await fetch('/api/config', {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({
          theme: form.theme,
          role: form.role,
          rules: form.rules,
          groupInviteUrl: form.groupInviteUrl,
          scheduleAt,
          scheduleTimezone: form.scheduleTimezone,
          newsTargetChatId: chatId || null,
          newsTargetTitle: chatId ? form.newsTargetTitle.trim() || null : null
        })
      })
      const j = await r.json()
      if (!r.ok) {
        setSaveErr(j.error || `Ошибка ${r.status}`)
        return
      }
      setSaveMsg('Сохранено')
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
        headers: authHeaders()
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

  const connected = wa?.ready === true
  const showQr = !connected && wa?.qr

  return (
    <>
      <h1>Новостной WhatsApp-бот</h1>
      <p className="sub">
        Подключите номер по QR, задайте тему и правила для ИИ, укажите группу и время рассылки.
      </p>

      <div className="card">
        <h2>WhatsApp</h2>
        {wa == null && <p className="sub">Загрузка статуса…</p>}
        {wa && (
          <>
            <div className="row">
              <span
                className={`status-pill ${connected ? 'ok' : showQr ? 'wait' : 'wait'}`}
              >
                {connected
                  ? 'Подключено'
                  : showQr
                    ? 'Ожидание сканирования QR'
                    : 'Не подключено'}
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
            {connected && (
              <p className="ok-text">Номер привязан, бот готов к работе.</p>
            )}
            {!connected && !showQr && (
              <p className="hint">
                Откройте WhatsApp на телефоне → Связанные устройства → Привязка устройства. QR
                появится здесь, когда сервер его получит.
              </p>
            )}
            {wa.error && <p className="err-text">{wa.error}</p>}
          </>
        )}
      </div>

      <div className="card">
        <h2>Тема, роль и правила для ИИ</h2>
        <p className="sub" style={{ marginBottom: '1rem' }}>
          Эти настройки учитываются в личных ответах и при генерации текста рассылки.
        </p>
        <div className="field">
          <label htmlFor="theme">Тема / фокус новостей</label>
          <input
            id="theme"
            type="text"
            value={form.theme}
            onChange={(e) => setForm((f) => ({ ...f, theme: e.target.value }))}
            placeholder="Например: IT, региональные новости, спорт"
          />
        </div>
        <div className="field">
          <label htmlFor="role">Роль бота</label>
          <input
            id="role"
            type="text"
            value={form.role}
            onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
            placeholder="Например: ведущий дайджеста, нейтральный тон"
          />
        </div>
        <div className="field">
          <label htmlFor="rules">Правила сообщений</label>
          <textarea
            id="rules"
            value={form.rules}
            onChange={(e) => setForm((f) => ({ ...f, rules: e.target.value }))}
            placeholder="Что писать и чего избегать: длина, стиль, запреты, источники…"
          />
        </div>
      </div>

      <div className="card">
        <h2>Рассылка в группу</h2>
        <p className="sub" style={{ marginBottom: '1rem' }}>
          Аккаунт бота должен уже быть участником группы. Поиск идёт по названию среди групп, в которых
          состоит этот номер.
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
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void pickGroup(m.id, m.name)}
                  >
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
            <strong>Группа для рассылки:</strong>{' '}
            {cfg?.newsTargetTitle || 'без названия'}
            {cfg?.newsTargetChatId && (
              <span className="mono" style={{ display: 'block', marginTop: '0.25rem', fontSize: '0.75rem' }}>
                {cfg.newsTargetChatId}
              </span>
            )}
          </div>
        )}

        <p className="sub" style={{ margin: '1rem 0 0.5rem' }}>
          Либо вступите по ссылке-приглашению (если группы ещё нет в списке):
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
          <label htmlFor="dt">Дата и время рассылки</label>
          <input
            id="dt"
            type="datetime-local"
            value={form.scheduleAtLocal}
            onChange={(e) => setForm((f) => ({ ...f, scheduleAtLocal: e.target.value }))}
          />
          <p className="hint">Время в часовом поясе этого браузера. Должно быть в будущем.</p>
        </div>
        <div className="field">
          <label htmlFor="tz">Подпись часового пояса (для справки)</label>
          <input
            id="tz"
            type="text"
            value={form.scheduleTimezone}
            onChange={(e) => setForm((f) => ({ ...f, scheduleTimezone: e.target.value }))}
            placeholder="Europe/Moscow"
          />
        </div>
        {cfg?.lastBroadcastAt && (
          <p className="hint">
            Последняя рассылка: {new Date(cfg.lastBroadcastAt).toLocaleString()}
          </p>
        )}
        {cfg?.lastBroadcastError && (
          <p className="err-text">Ошибка рассылки: {cfg.lastBroadcastError}</p>
        )}
      </div>

      <div className="card">
        <h2>Защита API (опционально)</h2>
        <p className="sub" style={{ marginBottom: '1rem' }}>
          Если на сервере задан <span className="mono">ADMIN_TOKEN</span>, введите тот же токен
          здесь — он сохранится в браузере.
        </p>
        <div className="field">
          <label htmlFor="token">Токен</label>
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
          <button type="button" className="btn" disabled={busy} onClick={() => void saveConfig()}>
            Сохранить настройки
          </button>
          <button
            type="button"
            className="btn secondary"
            disabled={busy || !connected}
            onClick={() => void runBroadcastNow()}
          >
            Отправить рассылку сейчас
          </button>
        </div>
        {saveMsg && <p className="ok-text">{saveMsg}</p>}
        {saveErr && <p className="err-text">{saveErr}</p>}
      </div>
    </>
  )
}
