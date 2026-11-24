import { useEffect, useId, type ReactNode } from 'react';

/** Modal dialog. Escape closes it unless `onClose` is omitted (a dialog that must be completed). */
export function Dialog({
  title,
  description,
  children,
  footer,
  onClose,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer: ReactNode;
  onClose?: () => void;
}) {
  const titleId = useId();
  useEffect(() => {
    if (!onClose) return undefined;
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [onClose]);

  return (
    <div className="cd-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose?.()}>
      <div className="cd-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="cd-dialog__header">
          <h2 id={titleId} className="cd-panel__title">
            {title}
          </h2>
          {description ? <p className="cd-panel__description">{description}</p> : null}
        </div>
        <div className="cd-dialog__body">{children}</div>
        <div className="cd-dialog__footer">{footer}</div>
      </div>
    </div>
  );
}
