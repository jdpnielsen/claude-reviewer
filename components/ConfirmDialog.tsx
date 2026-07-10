'use client';

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { useClickOutside, useHotkeys } from '@mantine/hooks';

interface ConfirmOptions {
  danger?: boolean;
}

type ConfirmFn = (message: string, options?: ConfirmOptions) => Promise<boolean>;

interface PendingConfirm {
  message: string;
  danger: boolean;
  resolve: (value: boolean) => void;
}

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirm = useCallback<ConfirmFn>((message, options) => {
    return new Promise<boolean>((resolve) => {
      setPending({ message, danger: options?.danger ?? false, resolve });
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    setPending((current) => {
      current?.resolve(value);
      return null;
    });
  }, []);

  const cardRef = useClickOutside(() => settle(false));

  useHotkeys([['Escape', () => settle(false)]]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <div className="confirm-dialog-backdrop" data-testid="confirm-backdrop">
          <div className="confirm-dialog-card" ref={cardRef}>
            <p className="confirm-dialog-message">{pending.message}</p>
            <div className="confirm-dialog-actions">
              <button className="confirm-dialog-cancel-btn" onClick={() => settle(false)}>
                Cancel
              </button>
              <button
                className={`confirm-dialog-confirm-btn${pending.danger ? ' confirm-dialog-confirm-btn-danger' : ''}`}
                onClick={() => settle(true)}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error('useConfirm must be used within a ConfirmProvider');
  }
  return ctx;
}
