import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

type ToastTone = 'info' | 'success' | 'danger';

interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  message?: string;
}

type Notify = (toast: Omit<ToastItem, 'id'>) => void;

const ToastContext = createContext<Notify | null>(null);
let nextId = 1;

/**
 * Success toasts close after 4 seconds. Failure toasts stay until the user
 * dismisses them, so a problem is never missed.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((toast) => toast.id !== id)), []);

  const notify = useCallback<Notify>(
    (toast) => {
      const id = nextId++;
      setToasts((all) => [...all, { ...toast, id }]);
      if (toast.tone !== 'danger') window.setTimeout(() => dismiss(id), 4000);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className="cd-toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`cd-toast cd-toast--${toast.tone}`} onClick={() => dismiss(toast.id)}>
            <div className="cd-toast__title">{toast.title}</div>
            {toast.message ? <div className="cd-toast__message">{toast.message}</div> : null}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): Notify {
  const notify = useContext(ToastContext);
  if (!notify) throw new Error('useToast must be used inside ToastProvider');
  return notify;
}
