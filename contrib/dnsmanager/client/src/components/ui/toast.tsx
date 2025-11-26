import { useEffect, useState } from "react";

export type ToastType = "success" | "error" | "info" | "warning";

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
}

const toastListeners: ((toast: Toast) => void)[] = [];

interface ToastOptions {
  title?: string;
  description: string;
  variant?: "default" | "destructive";
}

function toastFunction(options: ToastOptions): void;
function toastFunction(message: string): void;
function toastFunction(arg: string | ToastOptions): void {
  if (typeof arg === "string") {
    toastFunctions.show(arg);
  } else {
    const type = arg.variant === "destructive" ? "error" : "info";
    const message = arg.title ? `${arg.title}: ${arg.description}` : arg.description;
    toastFunctions.show(message, type);
  }
}

const toastFunctions = {
  show: (message: string, type: ToastType = "info", duration: number = 3000) => {
    const newToast: Toast = {
      id: `toast-${Date.now()}-${Math.random()}`,
      message,
      type,
      duration,
    };
    toastListeners.forEach((listener) => listener(newToast));
  },
  success: (message: string, duration?: number) => toastFunctions.show(message, "success", duration),
  error: (message: string, duration?: number) => toastFunctions.show(message, "error", duration),
  info: (message: string, duration?: number) => toastFunctions.show(message, "info", duration),
  warning: (message: string, duration?: number) => toastFunctions.show(message, "warning", duration),
};

export const toast = Object.assign(toastFunction, toastFunctions);

export function ToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const listener = (newToast: Toast) => {
      setToasts((prev) => [...prev, newToast]);

      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== newToast.id));
      }, newToast.duration || 3000);
    };

    toastListeners.push(listener);

    return () => {
      const index = toastListeners.indexOf(listener);
      if (index > -1) {
        toastListeners.splice(index, 1);
      }
    };
  }, []);

  const getToastStyles = (type: ToastType) => {
    switch (type) {
      case "success":
        return "bg-green-50 border-green-200 text-green-800";
      case "error":
        return "bg-red-50 border-red-200 text-red-800";
      case "warning":
        return "bg-yellow-50 border-yellow-200 text-yellow-800";
      case "info":
      default:
        return "bg-blue-50 border-blue-200 text-blue-800";
    }
  };

  const getIcon = (type: ToastType) => {
    switch (type) {
      case "success":
        return "✓";
      case "error":
        return "✕";
      case "warning":
        return "⚠";
      case "info":
      default:
        return "ℹ";
    }
  };

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto animate-slide-in-right rounded-lg border px-4 py-3 shadow-lg ${getToastStyles(t.type)} max-w-md`}
        >
          <div className="flex items-start gap-3">
            <span className="text-lg font-bold flex-shrink-0">{getIcon(t.type)}</span>
            <p className="text-sm flex-1">{t.message}</p>
            <button
              onClick={() => setToasts((prev) => prev.filter((toast) => toast.id !== t.id))}
              className="text-current opacity-50 hover:opacity-100 transition-opacity flex-shrink-0"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      ))}
      <style>{`
        @keyframes slide-in-right {
          from {
            transform: translateX(100%);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
        .animate-slide-in-right {
          animation: slide-in-right 0.3s ease-out;
        }
      `}</style>
    </div>
  );
}
