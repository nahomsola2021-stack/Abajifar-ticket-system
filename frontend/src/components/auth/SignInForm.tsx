import React, { useState } from 'react';
import { Eye, EyeOff, Lock, Mail, AlertCircle, Building, ShieldAlert, ArrowRight, Settings2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { ConfigModal } from '../common/ConfigModal';

export const SignInForm: React.FC = () => {
  const { signIn, isLoading, authError, clearAuthError, config } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    try {
      await signIn(email, password);
    } catch {
      // Error is caught and stored in authError inside AuthContext
    }
  };

  const hasMissingEnv = config.missingKeys.length > 0;

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col justify-between relative overflow-hidden select-none">
      {/* Background visual texture with calm teal and navy hues */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(13,148,136,0.15),rgba(255,255,255,0))]" />
      <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-teal-500/20 to-transparent" />

      {/* Top minimal brand bar */}
      <header className="relative z-10 max-w-6xl w-full mx-auto px-6 py-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-teal-800/80 border border-teal-500/30 flex items-center justify-center text-teal-200 shadow-xs">
            <Building className="w-5 h-5" />
          </div>
          <div>
            <span className="text-base font-semibold text-slate-100 tracking-tight">Ticket Office</span>
            <span className="text-xs text-slate-400 block -mt-0.5">Staff Workspace</span>
          </div>
        </div>

        <button
          onClick={() => setIsConfigModalOpen(true)}
          className="text-xs font-medium text-slate-400 hover:text-teal-300 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-800 hover:border-teal-500/30 transition-colors"
          title="Inspect API and Supabase configuration"
        >
          <Settings2 className="w-3.5 h-3.5" />
          <span>Connection Settings</span>
        </button>
      </header>

      {/* Main Sign In Card */}
      <main className="relative z-10 w-full max-w-md mx-auto px-4 py-8">
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-8 shadow-2xl backdrop-blur-md">
          {/* Header */}
          <div className="mb-6">
            <div className="flex items-center gap-2 text-xs font-medium text-teal-400 mb-2">
              <span className="w-1.5 h-1.5 rounded-full bg-teal-400" />
              <span>Restricted Staff Access</span>
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-white">
              Sign in to workspace
            </h1>
            <p className="text-sm text-slate-400 mt-1.5 leading-relaxed">
              Enter your authorized staff credentials to access manual ticket office operations.
            </p>
          </div>

          {/* Environmental Readiness Warning if env vars are missing */}
          {hasMissingEnv && (
            <div className="mb-5 p-3.5 rounded-xl bg-amber-950/40 border border-amber-500/30 text-amber-200 text-xs">
              <div className="flex items-start gap-2.5">
                <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <div className="font-semibold text-amber-300">Configuration Required</div>
                  <p className="mt-1 text-slate-300 text-[11px] leading-relaxed">
                    Missing: {config.missingKeys.join(', ')}. Set them in your <code className="text-amber-300 font-mono">.env</code> file or click below to configure runtime parameters.
                  </p>
                  <button
                    type="button"
                    onClick={() => setIsConfigModalOpen(true)}
                    className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-amber-400 hover:underline"
                  >
                    Open Connection Settings &rarr;
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Error Banner */}
          {authError && (
            <div
              role="alert"
              className="mb-5 p-3.5 rounded-xl bg-rose-950/50 border border-rose-500/40 text-rose-200 text-xs animate-in fade-in duration-200"
            >
              <div className="flex items-start gap-2.5">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <div className="font-semibold text-rose-200">
                    {authError.code === 'INVALID_CREDENTIALS' && 'Authentication Failed'}
                    {authError.code === 'SESSION_EXPIRED' && 'Session Expired'}
                    {authError.code === 'MISSING_STAFF_PROFILE' && 'Staff Record Not Found'}
                    {authError.code === 'INACTIVE_ACCOUNT' && 'Account Restricted'}
                    {authError.code === 'BACKEND_CONNECTION_ERROR' && 'Backend Connection Failed'}
                    {authError.code === 'ENV_CONFIG_MISSING' && 'Missing Configuration'}
                    {authError.code === 'UNKNOWN' && 'Operation Error'}
                  </div>
                  <p className="mt-1 text-slate-300 text-[11px] leading-relaxed">
                    {authError.message}
                  </p>
                  {authError.details && (
                    <p className="mt-1 text-slate-400 text-[10px] font-mono break-all">
                      {authError.details}
                    </p>
                  )}
                  {authError.code === 'BACKEND_CONNECTION_ERROR' && (
                    <div className="mt-2 pt-2 border-t border-rose-900/60 text-[11px] text-slate-300">
                      Check that the backend at <code className="text-teal-300 font-mono">{config.apiUrl || 'VITE_API_URL'}</code> is online and allows CORS requests from this origin.
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="staff-email"
                className="block text-xs font-medium text-slate-300 mb-1.5"
              >
                Staff Email Address
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-3 pointer-events-none" />
                <input
                  id="staff-email"
                  type="email"
                  required
                  autoComplete="username"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (authError) clearAuthError();
                  }}
                  placeholder="agent@ticketoffice.travel"
                  className="w-full pl-10 pr-3.5 py-2.5 text-sm bg-slate-950/80 border border-slate-700 rounded-lg text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500 transition-colors"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="staff-password"
                className="block text-xs font-medium text-slate-300 mb-1.5"
              >
                Password
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-3 pointer-events-none" />
                <input
                  id="staff-password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (authError) clearAuthError();
                  }}
                  placeholder="••••••••••••"
                  className="w-full pl-10 pr-10 py-2.5 text-sm bg-slate-950/80 border border-slate-700 rounded-lg text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500 transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-200 transition-colors p-0.5"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoading || !email || !password}
              className="w-full mt-2 py-2.5 px-4 text-sm font-semibold text-white bg-teal-600 hover:bg-teal-500 active:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-all shadow-md flex items-center justify-center gap-2"
            >
              {isLoading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>Verifying identity...</span>
                </>
              ) : (
                <>
                  <span>Sign in to workspace</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          {/* Admin-Provisioned Notice (No Public Sign-Up) */}
          <div className="mt-6 pt-5 border-t border-slate-800 text-center">
            <p className="text-xs text-slate-400 leading-relaxed">
              New accounts are provisioned exclusively by agency administrators.
              <br />
              <span className="text-slate-500">Public self-registration is disabled for security.</span>
            </p>
          </div>
        </div>

        {/* Backend Endpoint Status indicator */}
        <div className="mt-4 text-center">
          <div className="inline-flex items-center gap-2 text-xs text-slate-400">
            <span className="font-mono text-[11px] text-slate-400">
              API: {config.apiUrl ? config.apiUrl : 'VITE_API_URL not configured'}
            </span>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 max-w-6xl w-full mx-auto px-6 py-4 flex flex-col sm:flex-row items-center justify-between text-xs text-slate-500 border-t border-slate-900 gap-2">
        <div>Ticket Office Manual Ticketing & Operations Workspace</div>
        <div className="flex items-center gap-4 text-slate-400 text-xs">
          <span>Supabase Auth</span>
          <span aria-hidden="true">·</span>
          <span>Bearer JWT Integration</span>
          <span aria-hidden="true">·</span>
          <span>Role-Based Access</span>
        </div>
      </footer>

      <ConfigModal
        isOpen={isConfigModalOpen}
        onClose={() => setIsConfigModalOpen(false)}
      />
    </div>
  );
};
