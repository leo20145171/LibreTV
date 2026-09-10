'use client';

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

// —— Toast —— 替代旧版 3 秒/条串行队列，支持并行堆叠与自动过期

interface ToastItem {
  id: number;
  message: string;
  type: 'error' | 'success' | 'info' | 'warning';
}

interface ToastContextValue {
  toast: (message: string, type?: ToastItem['type']) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}

const TYPE_STYLES: Record<ToastItem['type'], string> = {
  error: 'bg-red-500',
  success: 'bg-green-600',
  info: 'bg-blue-500',
  warning: 'bg-yellow-600',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const toast = useCallback((message: string, type: ToastItem['type'] = 'info') => {
    const id = ++idRef.current;
    setItems((prev) => [...prev.slice(-3), { id, message, type }]);
    setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] flex flex-col gap-2 items-center pointer-events-none">
        {items.map((t) => (
          <div
            key={t.id}
            className={cn(
              'px-4 py-2.5 rounded-lg shadow-lg text-white text-sm max-w-md animate-slide-up',
              TYPE_STYLES[t.type]
            )}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
