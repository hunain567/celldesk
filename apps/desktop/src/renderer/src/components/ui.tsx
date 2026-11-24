import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export function Button({
  variant = 'secondary',
  busy = false,
  icon,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; busy?: boolean; icon?: ReactNode }) {
  return (
    <button
      type={type}
      className={`cd-button cd-button--${variant}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <span className="cd-spinner" aria-hidden="true" /> : icon}
      {children}
    </button>
  );
}

export type Tone = 'neutral' | 'success' | 'warning' | 'danger';

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`cd-badge cd-badge--${tone}`}>{children}</span>;
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="cd-segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Panel({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="cd-panel">
      <header className="cd-panel__header">
        <div>
          <h2 className="cd-panel__title">{title}</h2>
          {description ? <p className="cd-panel__description">{description}</p> : null}
        </div>
        {actions ? <div className="cd-actions">{actions}</div> : null}
      </header>
      <div className="cd-panel__body">{children}</div>
    </section>
  );
}

export function Properties({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="cd-properties">
      {items.map((item) => (
        <div key={item.label} style={{ display: 'contents' }}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
