interface HealthStatusBadgeProps {
  healthy: boolean | null;
  size?: "sm" | "md" | "lg";
}

export function HealthStatusBadge({ healthy, size = "md" }: HealthStatusBadgeProps) {
  const sizeClasses = {
    sm: "text-xs px-2 py-0.5",
    md: "text-sm px-2.5 py-1",
    lg: "text-base px-3 py-1.5",
  };

  if (healthy === null) {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-full bg-gray-100 font-medium text-gray-600 ${sizeClasses[size]}`}
      >
        <span className="inline-block h-2 w-2 rounded-full bg-gray-400"></span>
        Unknown
      </span>
    );
  }

  if (healthy) {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-full bg-green-100 font-medium text-green-700 ${sizeClasses[size]}`}
      >
        <span className="inline-block h-2 w-2 rounded-full bg-green-500"></span>
        Healthy
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full bg-red-100 font-medium text-red-700 ${sizeClasses[size]}`}
    >
      <span className="inline-block h-2 w-2 rounded-full bg-red-500"></span>
      Unhealthy
    </span>
  );
}

interface OriginHealthBadgeProps {
  healthy: boolean | null;
  name: string;
  address: string;
}

export function OriginHealthBadge({ healthy, name, address }: OriginHealthBadgeProps) {
  const getStatusColor = () => {
    if (healthy === null) return "text-gray-600";
    return healthy ? "text-green-600" : "text-red-600";
  };

  const getStatusText = () => {
    if (healthy === null) return "Unknown";
    return healthy ? "Healthy" : "Unhealthy";
  };

  return (
    <div className="flex items-center justify-between text-sm">
      <div className="flex-1">
        <div className="font-medium">{name}</div>
        <div className="text-xs text-gray-500">{address}</div>
      </div>
      <span className={`font-medium ${getStatusColor()}`}>{getStatusText()}</span>
    </div>
  );
}
