import qrcode from 'qrcode-generator';
import { ChevronLeft } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { explorerAddressUrl } from '../lib/config.js';
import { friendlyAddress, shortAddress } from '../lib/identity.js';
import { CopyButton } from './primitives.js';

/** A real, scannable QR code for a URL. */
export function QrCode({ value, size = 184, label }: { value: string; size?: number; label: string }) {
  const path = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + 4} ${y + 4}h1v1h-1z`;
    return { d, n: n + 8 };
  }, [value]);
  return (
    <svg className="qr" width={size} height={size} viewBox={`0 0 ${path.n} ${path.n}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={path.n} height={path.n} fill="#fff" />
      <path d={path.d} fill="#0b2027" />
    </svg>
  );
}

/** A Nimiq address: short by default, full on request, always copyable. */
export function Address({ hex, label }: { hex: string; label?: string }) {
  const [full, setFull] = useState(false);
  const friendly = friendlyAddress(hex);
  return (
    <span className="address">
      <button type="button" className="address-text num" onClick={() => setFull((f) => !f)} aria-label={`${label ?? 'Address'} ${friendly}. ${full ? 'Show less' : 'Show full address'}`}>
        {full ? friendly : shortAddress(hex)}
      </button>
      <CopyButton value={friendly.replace(/\s/g, ' ')} label={`Copy ${label ?? 'address'}`} />
      {full && (
        <a className="address-link" href={explorerAddressUrl(friendly)} target="_blank" rel="noreferrer">
          Explorer
        </a>
      )}
    </span>
  );
}

export function TopBar({ title, back, actions, sub }: { title: string; back?: string; actions?: ReactNode; sub?: ReactNode }) {
  return (
    <header className="topbar">
      {back ? (
        <Link className="icon-btn topbar-back" to={back} aria-label="Back">
          <ChevronLeft size={22} strokeWidth={2} />
        </Link>
      ) : (
        <span className="topbar-spacer" />
      )}
      <div className="topbar-title">
        <h1>{title}</h1>
        {sub && <p className="topbar-sub">{sub}</p>}
      </div>
      <div className="topbar-actions">{actions}</div>
    </header>
  );
}

export interface TimelineStep {
  label: string;
  detail?: string | undefined;
  state: 'done' | 'current' | 'todo' | 'problem';
}

/** One row per real transition; the current step is announced politely, once. */
export function Timeline({ steps }: { steps: TimelineStep[] }) {
  const current = steps.find((s) => s.state === 'current' || s.state === 'problem');
  return (
    <>
      <ol className="timeline">
        {steps.map((s) => (
          <li key={s.label} className={`tl-${s.state}`}>
            <span className="tl-dot" aria-hidden />
            <div>
              <p className="tl-label">
                {s.label}
                <span className="visually-hidden">
                  {s.state === 'done' ? ' (done)' : s.state === 'current' ? ' (in progress)' : s.state === 'problem' ? ' (needs attention)' : ' (not yet)'}
                </span>
              </p>
              {s.detail && <p className="tl-detail">{s.detail}</p>}
            </div>
          </li>
        ))}
      </ol>
      <p className="visually-hidden" aria-live="polite">
        {current ? current.label : ''}
      </p>
    </>
  );
}
