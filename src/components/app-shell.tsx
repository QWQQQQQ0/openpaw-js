import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { MessageSquare, Globe, Monitor, Smartphone, AppWindow, Cpu, Wrench, Settings, PanelLeftClose, PanelLeft, PawPrint, Menu, Eye, Layers } from 'lucide-react';
import { FloatWindowToggle } from './float-window-toggle';
import { useT } from '@/i18n/strings';
import { ErrorBoundary } from '@/components/error-boundary';
import { AppInitWrapper } from '@/components/app-init-wrapper';
import { isTauri, isMobile } from '@/utils/platform';

interface NavItemDef {
  icon: React.ReactNode;
  label: string;
  to: string;
  show: boolean;
}

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { pathname } = useLocation();
  const t = useT();

  const isDesktopLike = isTauri() || !isMobile();

  const navItems: NavItemDef[] = [
    { icon: <MessageSquare size={20} />, label: t('nav.chat'), to: '/', show: true },
    { icon: <Globe size={20} />, label: 'Web', to: '/web', show: true },
    { icon: <Monitor size={20} />, label: t('nav.desktop'), to: '/desktop', show: isDesktopLike },
    { icon: <Smartphone size={20} />, label: 'Phone', to: '/phone', show: !isDesktopLike },
    { icon: <AppWindow size={20} />, label: t('nav.apps'), to: '/apps', show: true },
    { icon: <Cpu size={20} />, label: t('nav.models'), to: '/models', show: true },
    { icon: <Wrench size={20} />, label: t('nav.skills'), to: '/skills', show: true },
    { icon: <Eye size={20} />, label: t('nav.watchers'), to: '/watchers', show: isDesktopLike },
    { icon: <Layers size={20} />, label: t('nav.knowledge'), to: '/knowledge', show: isDesktopLike },
    { icon: <Settings size={20} />, label: t('nav.settings'), to: '/settings', show: true },
  ];

  const visibleItems = navItems.filter((item) => item.show);

  return (
    <aside
      className={`${
        open ? 'translate-x-0' : '-translate-x-full'
      } lg:translate-x-0 fixed lg:relative z-40 w-[260px] h-full bg-white dark:bg-zinc-950 border-r border-zinc-200 dark:border-zinc-800 flex flex-col shrink-0 transition-transform duration-200`}
    >
      {/* Logo */}
      <div className="flex items-center gap-2 px-4 py-4">
        <PawPrint size={24} className="text-blue-600 dark:text-blue-400" />
        <span className="text-lg font-bold text-zinc-900 dark:text-zinc-100">OpenPaw</span>
      </div>
      <div className="border-t border-zinc-100 dark:border-zinc-800" />

      {/* Nav items */}
      <nav className="flex-1 py-2 overflow-y-auto">
        {visibleItems.map((item) => {
          const isActive = item.to === '/' ? pathname === '/' : pathname.startsWith(item.to);
          return (
            <NavLink
              key={item.to}
              to={item.to}
              prefetch="intent"
              onClick={() => onClose()}
              className={({ isActive: active }) =>
                `flex items-center gap-3 mx-2 px-3 py-2 rounded-lg text-[14px] font-medium transition-colors ${
                  active
                    ? 'bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300'
                    : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                }`
              }
              style={
                isActive
                  ? { borderTopRightRadius: '24px', borderBottomRightRadius: '24px' }
                  : undefined
              }
            >
              {item.icon}
              {item.label}
            </NavLink>
          );
        })}
      </nav>

      <div className="border-t border-zinc-100 dark:border-zinc-800 py-2">
        <FloatWindowToggle />
      </div>
    </aside>
  );
}

function MobileSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          onClick={onClose}
        />
      )}
      <Sidebar open={open} onClose={onClose} />
    </>
  );
}

export function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();

  return (
    <div className="flex h-full">
      <AppInitWrapper />
      {/* Desktop sidebar (always visible) */}
      <div className="hidden lg:block">
        <Sidebar open={true} onClose={() => {}} />
      </div>

      {/* Mobile sidebar (drawer) */}
      <div className="lg:hidden">
        <MobileSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile hamburger */}
        <div className="lg:hidden flex items-center h-12 px-3 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-1.5 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg"
          >
            <Menu size={20} />
          </button>
          <span className="ml-2 font-semibold text-zinc-900 dark:text-zinc-100">OpenPaw</span>
        </div>

        <main className="flex-1 flex flex-col min-h-0 bg-white dark:bg-zinc-950" key={location.pathname}>
          <div className="page-transition flex-1 flex flex-col min-h-0">
            <ErrorBoundary>
              <Outlet />
            </ErrorBoundary>
          </div>
        </main>
      </div>
    </div>
  );
}
