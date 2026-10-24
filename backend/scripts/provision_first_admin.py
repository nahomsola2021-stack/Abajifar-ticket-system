from __future__ import annotations

import sys
from getpass import getpass
from pathlib import Path

from sqlalchemy import text

# Allow "python scripts/provision_first_admin.py" from the backend directory.
BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from database import engine


def main() -> None:
    print("Create the first ticket-office branch and administrator.")
    email = input("Invited Supabase staff email: ").strip().lower()
    full_name = input("Administrator full name: ").strip()
    branch_code = input("Branch code (for example, HQ): ").strip().upper()
    branch_name = input("Branch name: ").strip()
    confirm = getpass("Type CREATE ADMIN to confirm: ").strip()

    if not email or not full_name or not branch_code or not branch_name:
        raise SystemExit("Email, full name, branch code, and branch name are required.")
    if confirm != "CREATE ADMIN":
        raise SystemExit("Provisioning cancelled.")

    with engine.begin() as connection:
        existing_staff = connection.execute(
            text("SELECT EXISTS (SELECT 1 FROM public.users)")
        ).scalar_one()
        if existing_staff:
            raise SystemExit(
                "Staff profiles already exist; first-admin provisioning is disabled."
            )

        auth_user = connection.execute(
            text(
                """
                SELECT id, email
                FROM auth.users
                WHERE lower(email) = :email
                """
            ),
            {"email": email},
        ).mappings().one_or_none()
        if auth_user is None:
            raise SystemExit(
                "No Supabase Auth user exists for that email. Invite the staff member first."
            )

        branch_id = connection.execute(
            text(
                """
                INSERT INTO public.branches (code, name)
                VALUES (:code, :name)
                RETURNING id
                """
            ),
            {"code": branch_code, "name": branch_name},
        ).scalar_one()

        staff_id = connection.execute(
            text(
                """
                INSERT INTO public.users
                    (auth_user_id, branch_id, email, full_name)
                VALUES
                    (:auth_user_id, :branch_id, :email, :full_name)
                RETURNING id
                """
            ),
            {
                "auth_user_id": auth_user["id"],
                "branch_id": branch_id,
                "email": auth_user["email"],
                "full_name": full_name,
            },
        ).scalar_one()

        role_id = connection.execute(
            text("SELECT id FROM public.roles WHERE code = 'ADMIN'")
        ).scalar_one()
        connection.execute(
            text(
                """
                INSERT INTO public.user_roles (user_id, role_id)
                VALUES (:user_id, :role_id)
                """
            ),
            {"user_id": staff_id, "role_id": role_id},
        )

    print(f"First administrator provisioned for {email}; branch ID: {branch_id}.")


if __name__ == "__main__":
    main()
