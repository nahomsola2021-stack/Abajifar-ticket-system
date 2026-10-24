export interface StaffRoleOption {
  id: number;
  code: string;
  name: string;
  description: string | null;
}

export interface StaffBranchOption {
  id: number;
  code: string;
  name: string;
}

export interface StaffAdminOptions {
  roles: StaffRoleOption[];
  branches: StaffBranchOption[];
}

export interface StaffAdminRecord {
  staff_id: number;
  auth_user_id: string | null;
  email: string;
  full_name: string;
  branch_id: number | null;
  branch_code: string | null;
  branch_name: string | null;
  is_active: boolean;
  role_ids: number[];
  roles: string[];
  created_at: string;
  /** False when the profile has its roles but no Supabase sign-in joined yet. */
  has_sign_in?: boolean;
}

/**
 * "none" records the office and the roles and leaves the sign-in to be
 * joined later. "existing" joins a Supabase account that already exists.
 * Neither creates, invites, or emails an account.
 */
export type StaffSignInMethod = 'none' | 'existing';

export interface StaffLinkInput {
  email: string;
  full_name: string;
  branch_id: number;
  role_ids: number[];
  sign_in_method?: StaffSignInMethod;
}

export interface StaffCreateInput {
  email: string;
  full_name: string;
  branch_id: number;
  role_ids: number[];
  password: string;
  confirm_password: string;
}