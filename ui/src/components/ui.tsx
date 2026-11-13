import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { isApiFailure } from '../api/client'
import { prettyJson } from '../lib/format'

// Small shared pieces, in Blueprint's patterns: square outlined badges, banners,
// stat tiles, a modal. Everything renders stored text as text, never as HTML.

export type Status = 'pass' | 'fail' | 'error' | 'skipped' | 'running' | 'queued' | 'not_applicable'

const STATUS_LABEL: Record<Status, string> = { pass: 'Pass', fail: 'Fail', error: 'Error', skipped: 'Skipped', running: 'Running', queued: 'Queued', not_applicable: 'N/A' }
const STATUS_GLYPH: Record<Status, string> = { pass: '✓', fail: '✕', error: '!', skipped: '○', running: '●', queued: '○', not_applicable: '–' }
/** What a screen reader says where the visible text is an abbreviation. */
const STATUS_SPOKEN: Partial<Record<Status, string>> = { not_applicable: 'Not applicable' }

/**
 * Skipped is its own look (dashed, hatched, hollow glyph) so it can never pass for a pass.
 * Not applicable is muted and dotted: the criterion's situation never arose, so it was not graded.
 */
export function StatusBadge({ status, label }: { status: Status; label?: string }) {
  const visible = label ?? STATUS_LABEL[status]
  const spoken = label === undefined ? STATUS_SPOKEN[status] : undefined
  return (
    <span className={`badge badge-${status}`} data-status={status} title={status === 'not_applicable' ? 'Not applicable. This criterion was not graded.' : undefined}>
      <span aria-hidden="true">{STATUS_GLYPH[status]}</span>
      {spoken ? (
        <>
          <span aria-hidden="true">{visible}</span>
          <span className="sr-only">{spoken}</span>
        </>
      ) : (
        visible
      )}
    </span>
  )
}

export function VerdictBadge({ verdict }: { verdict: 'pass' | 'fail' | 'not_applicable' }) {
  return <StatusBadge status={verdict} />
}

export function CriticalMarker() {
  return <span className="badge badge-critical" title="A failure here blocks a release">Critical</span>
}

export function TagList({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null
  return (
    <span className="row" style={{ gap: '0.3rem' }}>
      {tags.map(t => (
        <span key={t} className="badge badge-tag">{t}</span>
      ))}
    </span>
  )
}

export function PageHead({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head row-between" style={{ alignItems: 'flex-start' }}>
      <div className="grow">
        <h1 className="page-title">{title}</h1>
        {sub ? <p className="page-sub">{sub}</p> : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </div>
  )
}

export function Banner({ kind = 'info', title, children, role }: { kind?: 'info' | 'warning' | 'danger' | 'success' | 'demo'; title?: string; children?: ReactNode; role?: 'alert' | 'status' }) {
  return (
    <div className={`banner banner-${kind}`} role={role}>
      <div>
        {title ? <strong>{title}</strong> : null}
        {title && children ? ' ' : null}
        {children}
      </div>
    </div>
  )
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  )
}

export function ErrorState({ error, onRetry, title = 'Could not load this' }: { error: unknown; onRetry?: () => void; title?: string }) {
  const message = isApiFailure(error) ? error.message : error instanceof Error ? error.message : String(error)
  const code = isApiFailure(error) ? error.code : undefined
  return (
    <div className="banner banner-danger" role="alert">
      <div>
        <strong>{title}.</strong> {message}
        {code ? <span className="muted small"> ({code})</span> : null}
        {onRetry ? (
          <div style={{ marginTop: '0.6rem' }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>Try again</button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function EmptyState({ title, children, commands }: { title: string; children?: ReactNode; commands?: string }) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {commands ? <pre>{commands}</pre> : null}
    </div>
  )
}

export function Tile({ label, value, sub, lead, valueLabel }: { label: string; value: ReactNode; sub?: ReactNode; lead?: boolean; valueLabel?: string }) {
  return (
    <div className={`stat-card${lead ? ' lead' : ''}`}>
      <div className="stat-num" aria-label={valueLabel}>{value}</div>
      <div className="stat-label">{label}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  )
}

export function JsonBlock({ value, label }: { value: unknown; label?: string }) {
  return (
    <pre className="json" tabIndex={0} aria-label={label}>
      {prettyJson(value)}
    </pre>
  )
}

export function Disclosure({ title, children, open }: { title: ReactNode; children: ReactNode; open?: boolean }) {
  return (
    <details className="disclosure" open={open}>
      <summary>{title}</summary>
      <div className="disclosure-body">{children}</div>
    </details>
  )
}

export function Warnings({ items, title = 'Warnings' }: { items: string[]; title?: string }) {
  if (items.length === 0) return null
  return (
    <Banner kind="warning" title={title}>
      <ul>
        {items.map((w, i) => (
          <li key={`${i}-${w}`} className="break">{w}</li>
        ))}
      </ul>
    </Banner>
  )
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: string }[]; value: T; onChange(id: T): void; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map(t => (
        <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={value === t.id} aria-controls={`panel-${t.id}`} className="tab" onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  )
}

// ------------------------------------------------------------ confirm dialog

export interface ConfirmDialogProps {
  title: string
  children: ReactNode
  confirmLabel: string
  cancelLabel?: string
  onConfirm(): void
  onCancel(): void
  busy?: boolean
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * A modal that asks before anything that can spend money. Focus starts on
 * Cancel, so an Enter keypress cannot confirm by accident. Escape cancels, Tab
 * stays inside, and focus goes back to where it was.
 */
export function ConfirmDialog({ title, children, confirmLabel, cancelLabel = 'Cancel', onConfirm, onCancel, busy }: ConfirmDialogProps) {
  const titleId = useId()
  const descId = useId()
  const box = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    cancelRef.current?.focus()
    return () => previous?.focus?.()
  }, [])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && !busy) {
      e.stopPropagation()
      onCancel()
      return
    }
    if (e.key === 'Tab' && box.current) {
      const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (items.length === 0) return
      const first = items[0]!
      const last = items[items.length - 1]!
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && !busy && onCancel()}>
      <div ref={box} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId} onKeyDown={onKeyDown}>
        <h2 className="modal-title" id={titleId}>{title}</h2>
        <div id={descId}>{children}</div>
        <div className="modal-footer">
          <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
          <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={busy}>
            {busy ? <span className="spinner" aria-hidden="true" /> : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Local state for a boolean that survives nothing: a convenience for disclosures built from buttons. */
export function useToggle(initial = false): [boolean, () => void] {
  const [on, setOn] = useState(initial)
  return [on, () => setOn(v => !v)]
}
