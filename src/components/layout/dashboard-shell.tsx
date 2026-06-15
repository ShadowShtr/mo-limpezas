"use client";

import { useState } from "react";
import { Sidebar } from "./sidebar";
import { MobileHeader } from "./mobile-header";

interface Props {
  children: React.ReactNode;
  userName: string;
  userRole: string;
  avatarUrl?: string | null;
}

export function DashboardShell({ children, userName, userRole, avatarUrl }: Props) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: "linear-gradient(135deg, #d1fae5 0%, #f8fafc 55%, #dbeafe 100%)" }}>
      {/* Sidebar desktop (sempre visível ≥ lg) */}
      <div className="hidden lg:flex">
        <Sidebar userName={userName} userRole={userRole} avatarUrl={avatarUrl} />
      </div>

      {/* Drawer mobile (< lg) */}
      {sidebarOpen && (
        <>
          <div
            className="fixed inset-0 bg-black/40 z-40 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          />
          <div className="fixed inset-y-0 left-0 z-50 lg:hidden">
            <Sidebar
              userName={userName}
              userRole={userRole}
              avatarUrl={avatarUrl}
              onClose={() => setSidebarOpen(false)}
            />
          </div>
        </>
      )}

      {/* Conteúdo principal */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Header mobile (só visível < lg) */}
        <MobileHeader
          userName={userName}
          avatarUrl={avatarUrl}
          onMenuClick={() => setSidebarOpen(true)}
        />
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
