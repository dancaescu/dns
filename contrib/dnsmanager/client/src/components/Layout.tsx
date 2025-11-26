import { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { UnifiedHeader } from "./UnifiedHeader";
import { Breadcrumb } from "./Breadcrumb";

interface User {
  id: number;
  username: string;
  email: string;
  role: "superadmin" | "account_admin" | "user";
}

interface BreadcrumbItem {
  label: string;
  path?: string;
}

interface LayoutProps {
  children: ReactNode;
  user?: User | null;
  onLogout: () => void;
  onSupportClick?: () => void;
  breadcrumbs?: BreadcrumbItem[];
  title?: string;
  subtitle?: string;
}

export function Layout({
  children,
  user,
  onLogout,
  onSupportClick,
  breadcrumbs,
  title,
  subtitle,
}: LayoutProps) {
  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <Sidebar user={user} />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col ml-64">
        {/* Header */}
        <UnifiedHeader
          title={title}
          subtitle={subtitle}
          onLogout={onLogout}
          onSupportClick={onSupportClick}
          user={user}
        />

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto bg-gray-50">
          <div className="p-8">
            {/* Breadcrumbs */}
            {breadcrumbs && breadcrumbs.length > 0 && (
              <Breadcrumb items={breadcrumbs} />
            )}

            {/* Page Content */}
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
