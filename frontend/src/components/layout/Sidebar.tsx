import React, { useState } from 'react';
import {
  LayoutDashboard,
  TrendingUp,
  Users,
  Receipt,
  PiggyBank,
  Building,
  LogOut,
  X,
  Server,
  ChevronDown,
  ChevronRight,
  BarChart3,
  Settings,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

interface SidebarProps {
  currentTab: string;
  onTabChange: (tab: string) => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onOpenConfig: () => void;
}

interface NavSubItem {
  id: string;
  label: string;
}

interface NavItem {
  id: string;
  label: string;
  icon: any;
  adminOnly?: boolean;
  children?: NavSubItem[];
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  onTabChange,
  mobileOpen,
  onCloseMobile,
  onOpenConfig,
}) => {
  const { staff, signOut } = useAuth();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    sales: true,
    money: true,
    reports: true,
    settings: true,
  });

  const isAdministrator = Boolean(staff?.roles.some((role) => role.toUpperCase() === 'ADMIN'));

  const navigation: NavItem[] = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    {
      id: 'sales',
      label: 'Sales',
      icon: TrendingUp,
      children: [
        { id: 'ticket-sales', label: 'Ticket Sales' },
        { id: 'bookings', label: 'Bookings & PNRs' },
      ],
    },
    { id: 'customers', label: 'Customers', icon: Users },
    {
      id: 'money',
      label: 'Money',
      icon: Receipt,
      children: [
        { id: 'invoices', label: 'Invoices' },
        { id: 'customer-payments', label: 'Customer Payments' },
        { id: 'supplier-bills', label: 'Supplier Bills' },
        { id: 'supplier-payments', label: 'Supplier Payments' },
      ],
    },
    { id: 'expenses', label: 'Expenses', icon: PiggyBank },
    {
      id: 'reports',
      label: 'Reports',
      icon: BarChart3,
      children: [
        { id: 'reports-sales', label: 'Sales & Margins' },
        { id: 'reports-customer-balances', label: 'Customer Balances' },
        { id: 'reports-supplier-balances', label: 'Supplier Balances' },
        { id: 'reports-expenses', label: 'Expenses & Payments' },
      ],
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: Settings,
      adminOnly: true,
      children: [
        { id: 'settings-staff', label: 'Staff & Roles' },
        { id: 'settings-suppliers', label: 'Suppliers' },
      ],
    },
  ];

  const visibleNavigation = navigation.filter((item) => !item.adminOnly || isAdministrator);

  const handleNavClick = (id: string) => {
    onTabChange(id);
    onCloseMobile();
  };

  const toggle = (id: string) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  return (
    <>
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-950/70 backdrop-blur-xs md:hidden"
          onClick={onCloseMobile}
          aria-hidden="true"
        />
      )}

      <aside
        className={`fixed md:sticky top-0 z-40 h-screen w-60 bg-slate-900 border-r border-slate-800 flex flex-col transition-transform duration-200 ease-in-out md:translate-x-0 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="h-14 px-5 border-b border-slate-800 flex items-center justify-between shrink-0">
<div className="flex items-center gap-3 px-4 py-5">
  <img 
    src="/logo.png" 
    alt="Abajifar Tour and Travel" 
    className="h-9 w-auto object-contain" 
  />
</div>

          <button
            onClick={onCloseMobile}
            className="md:hidden p-1 rounded-md text-slate-400 hover:text-slate-200 hover:bg-slate-800"
            aria-label="Close navigation"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="p-3 space-y-1 flex-1 overflow-y-auto" aria-label="Sidebar Navigation">
          {visibleNavigation.map((item) => {
            const Icon = item.icon;
            
            if (!item.children) {
              const isActive = currentTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => handleNavClick(item.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-xs font-medium rounded-lg transition-colors ${
                    isActive
                      ? 'bg-teal-950/80 text-teal-200 border border-teal-500/30'
                      : 'text-slate-300 hover:text-white hover:bg-slate-800/60'
                  }`}
                >
                  <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-teal-400' : 'text-slate-400'}`} />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            }

            const isOpen = expanded[item.id];
            const hasActiveChild = item.children.some((c) => c.id === currentTab);
            
            return (
              <div key={item.id}>
                <button
                  onClick={() => toggle(item.id)}
                  className={`w-full flex items-center justify-between px-3 py-2.5 text-xs font-medium rounded-lg transition-colors ${
                    hasActiveChild
                      ? 'text-teal-200'
                      : 'text-slate-300 hover:text-white hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <Icon className={`w-4 h-4 shrink-0 ${hasActiveChild ? 'text-teal-400' : 'text-slate-400'}`} />
                    <span className="truncate">{item.label}</span>
                  </div>
                  {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                </button>
                {isOpen && (
                  <div className="ml-4 mt-1 space-y-0.5 border-l border-slate-800 pl-2">
                    {item.children.map((child) => {
                      const isActive = currentTab === child.id;
                      return (
                        <button
                          key={child.id}
                          onClick={() => handleNavClick(child.id)}
                          className={`w-full text-left px-2.5 py-1.5 text-xs rounded-md transition-colors ${
                            isActive
                              ? 'bg-teal-950/80 text-teal-200'
                              : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
                          }`}
                        >
                          {child.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="p-3 border-t border-slate-800 bg-slate-950/40 shrink-0">
          {staff ? (
            <div className="space-y-2.5">
              <div className="px-2 pt-1">
                <div className="text-xs font-semibold text-white truncate">{staff.full_name}</div>
                <div className="text-[11px] text-slate-400 truncate">{staff.email}</div>
              </div>
              <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between gap-2 px-1">
                <button
                  type="button"
                  onClick={onOpenConfig}
                  className="p-1.5 rounded-md text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors flex items-center gap-1.5 text-[11px]"
                  title="Connection Settings"
                >
                  <Server className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => signOut()}
                  className="px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:text-white bg-slate-800/80 hover:bg-slate-800 rounded-md transition-colors flex items-center gap-1.5"
                >
                  <LogOut className="w-3 h-3 text-slate-400" />
                  <span>Sign out</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="px-2 py-2 text-xs text-slate-400">
              <span>Authenticating staff session...</span>
            </div>
          )}
        </div>
      </aside>
    </>
  );
};