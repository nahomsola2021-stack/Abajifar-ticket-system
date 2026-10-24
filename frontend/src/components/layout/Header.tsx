import React from 'react';
import { Menu, LogOut, Settings2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

interface HeaderProps {
  onTabChange: (tab: string) => void;
  onToggleMobileSidebar: () => void;
  onOpenConfig: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  onTabChange,
  onToggleMobileSidebar,
  onOpenConfig,
}) => {
  const { staff, signOut } = useAuth();

  return (
    <header className="sticky top-0 z-30 bg-slate-900 border-b border-slate-800 text-slate-100">
      <div className="flex items-center justify-between gap-8 px-4 sm:px-6 py-3.5 max-w-7xl mx-auto">
        {/* Zone 1: Brand title, one line */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={onToggleMobileSidebar}
            aria-label="Toggle navigation menu"
            className="md:hidden p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
          >
            <Menu className="w-5 h-5" />
          </button>

          <a
            href="#dashboard"
            onClick={(e) => {
              e.preventDefault();
              onTabChange('dashboard');
            }}
            className="text-base font-bold tracking-tight text-white whitespace-nowrap shrink-0 flex items-center gap-2 hover:opacity-95 transition-opacity"
          >
            <span className="w-2.5 h-2.5 rounded-full bg-teal-400 shrink-0" aria-hidden="true" />
            <span>Ticket Office</span>
          </a>
        </div>

        {/* Zone 2 removed: navigation lives in the sidebar */}

        {/* Zone 3: 1 primary action area */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={onOpenConfig}
            title="System Connection Settings"
            aria-label="Open connection settings"
            className="p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors shrink-0"
          >
            <Settings2 className="w-4 h-4" />
          </button>

          {staff && (
            <div className="hidden lg:flex items-center gap-2 pl-2 border-l border-slate-800 text-xs text-slate-300 shrink-0">
              <div className="w-6 h-6 rounded-full bg-teal-900/80 border border-teal-500/30 flex items-center justify-center text-teal-300 font-medium text-[11px]">
                {staff.full_name?.charAt(0) || 'S'}
              </div>
              <span className="max-w-[130px] truncate font-medium text-slate-200">
                {staff.full_name}
              </span>
            </div>
          )}

          <button
            type="button"
            onClick={() => signOut()}
            className="px-3.5 py-1.5 text-xs font-medium text-slate-200 hover:text-white bg-slate-800 hover:bg-slate-700/80 border border-slate-700 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <LogOut className="w-3.5 h-3.5 text-slate-400" />
            <span>Sign out</span>
          </button>
        </div>
      </div>
    </header>
  );
};
