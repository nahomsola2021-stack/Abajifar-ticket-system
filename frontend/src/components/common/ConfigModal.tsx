import React, { useState } from 'react';
import { X, CheckCircle, Shield, Globe, Key, RefreshCw } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { saveLocalOverrides, clearLocalOverrides } from '../../lib/config';

interface ConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ConfigModal: React.FC<ConfigModalProps> = ({ isOpen, onClose }) => {
  const { config, reloadConfig } = useAuth();

  const [supabaseUrl, setSupabaseUrl] = useState(config.supabaseUrl);
  const [supabaseAnonKey, setSupabaseAnonKey] = useState(config.supabaseAnonKey);
  const [apiUrl, setApiUrl] = useState(config.apiUrl);
  const [saveSuccess, setSaveSuccess] = useState(false);

  if (!isOpen) return null;

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    saveLocalOverrides({
      supabaseUrl,
      supabaseAnonKey,
      apiUrl,
    });
    reloadConfig();
    setSaveSuccess(true);
    setTimeout(() => {
      setSaveSuccess(false);
      onClose();
    }, 1200);
  };

  const handleResetToEnv = () => {
    clearLocalOverrides();
    reloadConfig();
    setSupabaseUrl(import.meta.env.VITE_SUPABASE_URL || '');
    setSupabaseAnonKey(import.meta.env.VITE_SUPABASE_ANON_KEY || '');
    setApiUrl(import.meta.env.VITE_API_URL || '');
    setSaveSuccess(true);
    setTimeout(() => {
      setSaveSuccess(false);
      onClose();
    }, 1200);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-labelledby="config-modal-title"
    >
      <div className="bg-white rounded-xl shadow-2xl border border-slate-200 max-w-xl w-full p-6 text-slate-900 overflow-hidden">
        <div className="flex items-center justify-between pb-4 border-b border-slate-200">
          <div>
            <h2 id="config-modal-title" className="text-lg font-semibold text-slate-900">
              System Connection Settings
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Ticket Office frontend environment configuration
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close configuration modal"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSave} className="mt-4 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Backend API URL (<code className="font-mono text-[11px] text-teal-700">VITE_API_URL</code>)
            </label>
            <div className="relative">
              <Globe className="w-4 h-4 text-slate-400 absolute left-3 top-3 pointer-events-none" />
              <input
                type="url"
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                placeholder="https://api.yourtravelagency.com"
                className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600 focus:border-teal-600 font-mono"
              />
            </div>
            <p className="text-[11px] text-slate-500 mt-1">
              Base URL used for <code className="text-slate-700">/api/auth/me</code> and <code className="text-slate-700">/api/dashboard/overview</code>.
            </p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Supabase Project URL (<code className="font-mono text-[11px] text-teal-700">VITE_SUPABASE_URL</code>)
            </label>
            <div className="relative">
              <Shield className="w-4 h-4 text-slate-400 absolute left-3 top-3 pointer-events-none" />
              <input
                type="url"
                value={supabaseUrl}
                onChange={(e) => setSupabaseUrl(e.target.value)}
                placeholder="https://your-project.supabase.co"
                className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600 focus:border-teal-600 font-mono"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Supabase Anon Key (<code className="font-mono text-[11px] text-teal-700">VITE_SUPABASE_ANON_KEY</code>)
            </label>
            <div className="relative">
              <Key className="w-4 h-4 text-slate-400 absolute left-3 top-3 pointer-events-none" />
              <input
                type="password"
                value={supabaseAnonKey}
                onChange={(e) => setSupabaseAnonKey(e.target.value)}
                placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600 focus:border-teal-600 font-mono"
              />
            </div>
          </div>

          <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 text-xs text-slate-600 space-y-1">
            <div className="font-medium text-slate-800 flex items-center gap-1.5">
              <span>CORS Policy Requirement:</span>
            </div>
            <p>
              The backend at <code className="text-teal-800 font-mono">{apiUrl || 'VITE_API_URL'}</code> must allow this frontend origin in its CORS configuration with headers <code className="font-mono">Authorization, Content-Type</code>.
            </p>
          </div>

          {saveSuccess && (
            <div className="p-3 bg-teal-50 border border-teal-200 rounded-lg flex items-center gap-2 text-xs text-teal-800">
              <CheckCircle className="w-4 h-4 text-teal-600 shrink-0" />
              <span>Configuration applied successfully.</span>
            </div>
          )}

          <div className="flex items-center justify-between pt-3 border-t border-slate-200">
            <button
              type="button"
              onClick={handleResetToEnv}
              className="px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 flex items-center gap-1.5 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Reset to .env values</span>
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 border border-slate-200 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors shadow-xs"
              >
                Save Settings
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
