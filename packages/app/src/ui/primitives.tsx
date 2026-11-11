import { Check, Copy, X } from 'lucide-react';
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { formatNim } from '../lib/money.js';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet';

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; block?: boolean; busy?: boolean; icon?: ReactNode }
>(function Button({ variant = 'primary', block, busy, icon, children, className, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      className={['btn', `btn-${variant}`, block ? 'btn-block' : '', className ?? ''].join(' ')}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <span className="spinner" aria-hidden /> : icon}
      <span>{children}</span>
    </button>
  );
});

export function Amount({
  luna,
  signed,
  size = 'md',
  unit = true,
  className,
}: {
  luna: bigint;
  signed?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  unit?: boolean;
  className?: string;
}) {
  const text = formatNim(luna, { signed: signed ?? false });
  return (
    <span className={['amount', `amount-${size}`, 'num', className ?? ''].join(' ')} aria-label={`${text.replace('−', 'minus ')} NIM`}>
      {text}
      {unit && <span className="amount-unit"> NIM</span>}
    </span>
  );
}

export type Tone = 'info' | 'warn' | 'error' | 'success';

export function Alert({ tone = 'info', title, children, action }: { tone?: Tone; title?: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={`alert alert-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <div className="alert-body">
        {title && <p className="alert-title">{title}</p>}
        {children && <div className="alert-text">{children}</div>}
      </div>
      {action && <div className="alert-action">{action}</div>}
    </div>
  );
}

export type PillTone = 'neutral' | 'agreed' | 'waiting' | 'declined' | 'paid' | 'checking' | 'problem';

export function Pill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  htmlFor: string;
}) {
  return (
    <div className={`field${error ? ' field-invalid' : ''}`}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="field-error" id={`${htmlFor}-error`} role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="field-hint" id={`${htmlFor}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  const { invalid, className, ...rest } = props;
  return <input className={`input${className ? ` ${className}` : ''}`} aria-invalid={invalid || undefined} {...rest} />;
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className="icon-btn"
      onClick={() => {
        navigator.clipboard.writeText(value).then(
          () => setCopied(true),
          () => window.prompt('Copy this:', value),
        );
      }}
      aria-label={copied ? 'Copied' : label}
    >
      {copied ? <Check size={18} strokeWidth={2} /> : <Copy size={18} strokeWidth={1.9} />}
    </button>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton" aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton-line" style={{ width: `${88 - i * 14}%` }} />
      ))}
    </div>
  );
}

/**
 * A modal sheet: focus moves in and is trapped, Escape and the close button
 * dismiss it, and dismissing never submits anything.
 */
export function Sheet({ title, open, onClose, children, footer }: { title: string; open: boolean; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusables = (): HTMLElement[] =>
      node ? [...node.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])')] : [];
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Tab') {
        const list = focusables();
        if (list.length === 0) return;
        const first = list[0] as HTMLElement;
        const last = list[list.length - 1] as HTMLElement;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      previous?.focus();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <div className="sheet-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={20} strokeWidth={1.9} />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Empty({ title, children, action, art }: { title: string; children?: ReactNode; action?: ReactNode; art?: ReactNode }) {
  return (
    <div className="empty">
      {art}
      <h2 className="empty-title">{title}</h2>
      {children && <div className="empty-text">{children}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
