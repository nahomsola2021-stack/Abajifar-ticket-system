"""Verify staff creation records a profile and its roles without Supabase Auth.

Staff profiles are recorded by the office. This drives the real staff
administration handlers against the live database with no Supabase
administrative credentials present, checks that the profile, office, and roles
are saved, and checks the guardrails. Everything it creates is removed at the
end. Run from the backend directory:

    .\.venv\Scripts\python.exe scripts\verify_staff_access.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from uuid import uuid4

from sqlalchemy import text

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import main
from database import engine
from main import AuthenticatedUser

PASSED: list[str] = []
FAILED: list[str] = []

TEST_EMAIL = "staff.access.check@example.com"
ONE_ROLE_EMAIL = "one.role.check@example.com"
MANY_ROLES_EMAIL = "many.roles.check@example.com"
LINKED_EMAIL = "linked.signin@example.com"
UNLINKED_AUTH_EMAIL = "unlinked.signin@example.com"


def check(label: str, condition: bool, detail: str = "") -> None:
    if condition:
        PASSED.append(label)
        print(f"  PASS  {label}")
    else:
        FAILED.append(f"{label} {detail}".strip())
        print(f"  FAIL  {label} {detail}")


def expect_http_error(label: str, status_code: int, function, *args, **kwargs) -> None:
    try:
        function(*args, **kwargs)
    except Exception as error:  # noqa: BLE001 - the handler raises HTTPException
        actual = getattr(error, "status_code", None)
        if actual == status_code:
            PASSED.append(label)
            print(f"  PASS  {label}")
        else:
            FAILED.append(f"{label} (expected {status_code}, got {actual})")
            print(f"  FAIL  {label} (expected {status_code}, got {actual})")
    else:
        FAILED.append(f"{label} (no error raised)")
        print(f"  FAIL  {label} (no error raised)")


def expect_validation_error(label: str, function, *args, **kwargs) -> str:
    """Call something that must be rejected, and return the message."""
    try:
        function(*args, **kwargs)
    except Exception as error:  # noqa: BLE001 - pydantic raises a validation error
        message = str(error)
        PASSED.append(label)
        print(f"  PASS  {label}")
        return message
    FAILED.append(f"{label} (no error raised)")
    print(f"  FAIL  {label} (no error raised)")
    return ""


def run() -> None:
    # The whole point of this suite: no Supabase administrative credentials.
    for variable in ("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY"):
        os.environ.pop(variable, None)
    check(
        "no Supabase service role key is set",
        not os.getenv("SUPABASE_SERVICE_ROLE_KEY"),
    )
    check(
        "no Supabase secret key is set",
        not os.getenv("SUPABASE_SECRET_KEY"),
    )
    check(
        "the API has no Supabase admin helper at all",
        not hasattr(main, "supabase_admin_configured")
        and not hasattr(main, "generate_temporary_password")
        and not hasattr(main, "create_supabase_sign_in")
        and not hasattr(main, "invite_supabase_sign_in"),
    )

    with engine.begin() as connection:
        admin = connection.execute(
            text(
                """
                SELECT u.id, u.auth_user_id, u.email, u.branch_id
                FROM public.users AS u
                JOIN public.user_roles AS ur ON ur.user_id = u.id
                JOIN public.roles AS r ON r.id = ur.role_id
                WHERE r.code = 'ADMIN' AND u.is_active AND u.auth_user_id IS NOT NULL
                LIMIT 1
                """
            )
        ).mappings().one()
        role_ids = {
            row["code"]: row["id"]
            for row in connection.execute(
                text("SELECT id, code FROM public.roles")
            ).mappings()
        }
        branch_id = admin["branch_id"]
        inactive_branch_id = connection.execute(
            text(
                """
                INSERT INTO public.branches (code, name, is_active)
                VALUES ('ZZTEST', 'Staff Access Check Branch', FALSE)
                RETURNING id
                """
            )
        ).scalar_one()

        for email in (
            TEST_EMAIL,
            ONE_ROLE_EMAIL,
            MANY_ROLES_EMAIL,
            LINKED_EMAIL,
            UNLINKED_AUTH_EMAIL,
        ):
            connection.execute(text("DELETE FROM public.users WHERE email = :email"), {"email": email})
            connection.execute(text("DELETE FROM auth.users WHERE email = :email"), {"email": email})

        invited_auth_id = uuid4()
        connection.execute(
            text(
                """
                INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
                VALUES (:id, 'authenticated', 'authenticated', :email, '{}'::jsonb, '{}'::jsonb)
                """
            ),
            {"id": invited_auth_id, "email": TEST_EMAIL},
        )
        # A staff member who exists but is not an administrator, so the
        # administrator-only gates can be checked.
        non_admin_id = connection.execute(
            text(
                """
                INSERT INTO public.users (auth_user_id, branch_id, email, full_name)
                VALUES (:auth_user_id, :branch_id, :email, 'Non Admin Check')
                RETURNING id
                """
            ),
            {
                "auth_user_id": invited_auth_id,
                "branch_id": branch_id,
                "email": TEST_EMAIL,
            },
        ).scalar_one()
        connection.execute(
            text("INSERT INTO public.user_roles (user_id, role_id) VALUES (:user_id, :role_id)"),
            {"user_id": non_admin_id, "role_id": role_ids["AGENT"]},
        )

    admin_user = AuthenticatedUser(id=str(admin["auth_user_id"]), email=admin["email"])

    try:
        print("Admin options and listing")
        options = main.staff_admin_options(user=admin_user)
        check("options list every role", len(options.roles) == len(role_ids), f"got {len(options.roles)}")
        check(
            "options list the active branches",
            any(branch.id == branch_id for branch in options.branches),
        )
        check(
            "the options carry no Supabase administration flag",
            not hasattr(options, "can_create_sign_ins"),
        )

        listing = main.list_managed_staff(user=admin_user)
        check("the staff register is readable", any(row.staff_id == admin["id"] for row in listing))
        check(
            "the admin's own roles are listed",
            any(row.staff_id == admin["id"] and "ADMIN" in row.roles for row in listing),
        )

        print("Adding a staff member with one role")
        one_role = main.link_invited_staff(
            request=main.StaffLinkCreate(
                email=ONE_ROLE_EMAIL,
                full_name="One Role Check",
                branch_id=branch_id,
                role_ids=[role_ids["CASHIER"]],
            ),
            user=admin_user,
        )
        check("the staff profile is created", one_role.staff_id is not None)
        check("the single role is assigned", one_role.roles == ["CASHIER"], f"got {one_role.roles}")
        check("the office is assigned", one_role.branch_id == branch_id)
        check("the office code comes back", one_role.branch_code is not None)
        check("the profile is active", one_role.is_active is True)
        check("no sign-in is joined", one_role.auth_user_id is None)
        check("the screen knows there is no sign-in", one_role.has_sign_in is False)
        check(
            "the response carries no temporary password",
            not hasattr(one_role, "temporary_password"),
        )

        with engine.connect() as connection:
            stored = connection.execute(
                text(
                    """
                    SELECT staff.auth_user_id, staff.branch_id, staff.is_active,
                           COALESCE(
                               ARRAY_AGG(roles.code ORDER BY roles.code)
                                   FILTER (WHERE roles.code IS NOT NULL),
                               ARRAY[]::VARCHAR[]
                           ) AS roles
                    FROM public.users AS staff
                    LEFT JOIN public.user_roles AS ur ON ur.user_id = staff.id
                    LEFT JOIN public.roles AS roles ON roles.id = ur.role_id
                    WHERE staff.id = :staff_id
                    GROUP BY staff.id
                    """
                ),
                {"staff_id": one_role.staff_id},
            ).mappings().one()
        check("the database row holds the single role", list(stored["roles"]) == ["CASHIER"])
        check("the database row holds the office", stored["branch_id"] == branch_id)
        check("the database row has no sign-in", stored["auth_user_id"] is None)

        print("Adding a staff member with multiple roles")
        many_roles = main.link_invited_staff(
            request=main.StaffLinkCreate(
                email=MANY_ROLES_EMAIL,
                full_name="Many Roles Check",
                branch_id=branch_id,
                role_ids=[
                    role_ids["ACCOUNTANT"],
                    role_ids["AGENT"],
                    role_ids["CASHIER"],
                    role_ids["MANAGER"],
                ],
            ),
            user=admin_user,
        )
        check("the staff profile is created", many_roles.staff_id is not None)
        check(
            "every selected role is assigned",
            set(many_roles.roles) == {"ACCOUNTANT", "AGENT", "CASHIER", "MANAGER"},
            f"got {many_roles.roles}",
        )
        check("the role ids are all recorded", len(many_roles.role_ids) == 4)
        check("the office is assigned", many_roles.branch_id == branch_id)
        with engine.connect() as connection:
            stored_roles = connection.execute(
                text(
                    """
                    SELECT r.code FROM public.user_roles AS ur
                    JOIN public.roles AS r ON r.id = ur.role_id
                    WHERE ur.user_id = :staff_id
                    ORDER BY r.code
                    """
                ),
                {"staff_id": many_roles.staff_id},
            ).scalars().all()
        check(
            "the database row holds every role",
            list(stored_roles) == ["ACCOUNTANT", "AGENT", "CASHIER", "MANAGER"],
            f"got {list(stored_roles)}",
        )

        print("Duplicate staff profiles")
        expect_http_error(
            "a second profile for the same email is refused",
            422,
            main.link_invited_staff,
            request=main.StaffLinkCreate(
                email=ONE_ROLE_EMAIL,
                full_name="One Role Check Again",
                branch_id=branch_id,
                role_ids=[role_ids["AGENT"]],
            ),
            user=admin_user,
        )
        try:
            main.link_invited_staff(
                request=main.StaffLinkCreate(
                    email=ONE_ROLE_EMAIL,
                    full_name="One Role Check Again",
                    branch_id=branch_id,
                    role_ids=[role_ids["AGENT"]],
                ),
                user=admin_user,
            )
        except Exception as error:  # noqa: BLE001
            message = getattr(error, "detail", "")
            check(
                "the duplicate error names the email and points at editing",
                ONE_ROLE_EMAIL in str(message) and "already exists" in str(message),
                f"got {message!r}",
            )
        else:
            check("the duplicate error names the email and points at editing", False)
        with engine.connect() as connection:
            duplicate_count = connection.execute(
                text("SELECT COUNT(*) FROM public.users WHERE email = :email"),
                {"email": ONE_ROLE_EMAIL},
            ).scalar_one()
        check("no duplicate row was written", duplicate_count == 1, f"got {duplicate_count}")

        print("Sign-in options are refused")
        expect_validation_error(
            "creating a Supabase account is refused",
            main.StaffLinkCreate,
            email="created.signin@example.com",
            full_name="Created Signin",
            branch_id=branch_id,
            role_ids=[role_ids["AGENT"]],
            sign_in_method="temporary_password",
        )
        expect_validation_error(
            "inviting a Supabase account is refused",
            main.StaffLinkCreate,
            email="invited.signin@example.com",
            full_name="Invited Signin",
            branch_id=branch_id,
            role_ids=[role_ids["AGENT"]],
            sign_in_method="invite",
        )
        with engine.connect() as connection:
            made = connection.execute(
                text(
                    "SELECT COUNT(*) FROM auth.users WHERE email IN "
                    "('created.signin@example.com', 'invited.signin@example.com')"
                )
            ).scalar_one()
        check("no Supabase account was created", made == 0, f"got {made}")

        print("Joining a sign-in that already exists")
        expect_http_error(
            "a sign-in that does not exist yet is refused",
            404,
            main.link_invited_staff,
            request=main.StaffLinkCreate(
                email="nobody.invited@example.com",
                full_name="Nobody",
                branch_id=branch_id,
                role_ids=[role_ids["AGENT"]],
                sign_in_method="existing",
            ),
            user=admin_user,
        )
        with engine.begin() as connection:
            linked_auth_id = uuid4()
            connection.execute(
                text(
                    """
                    INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
                    VALUES (:id, 'authenticated', 'authenticated', :email, '{}'::jsonb, '{}'::jsonb)
                    """
                ),
                {"id": linked_auth_id, "email": LINKED_EMAIL},
            )
        joined = main.link_invited_staff(
            request=main.StaffLinkCreate(
                email=LINKED_EMAIL,
                full_name="Linked Signin",
                branch_id=branch_id,
                role_ids=[role_ids["AGENT"]],
                sign_in_method="existing",
            ),
            user=admin_user,
        )
        check("the existing sign-in is joined", joined.auth_user_id is not None)
        check("the screen knows the sign-in is there", joined.has_sign_in is True)
        check("the roles are applied", joined.roles == ["AGENT"], f"got {joined.roles}")

        print("An unlinked profile cannot sign in")
        unlinked = main.link_invited_staff(
            request=main.StaffLinkCreate(
                email=UNLINKED_AUTH_EMAIL,
                full_name="Unlinked Signin",
                branch_id=branch_id,
                role_ids=[role_ids["AGENT"]],
            ),
            user=admin_user,
        )
        check("the profile is created", unlinked.staff_id is not None)
        check("the profile has no sign-in", unlinked.auth_user_id is None)
        with engine.begin() as connection:
            unlinked_auth_id = uuid4()
            connection.execute(
                text(
                    """
                    INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
                    VALUES (:id, 'authenticated', 'authenticated', :email, '{}'::jsonb, '{}'::jsonb)
                    """
                ),
                {"id": unlinked_auth_id, "email": UNLINKED_AUTH_EMAIL},
            )
        expect_http_error(
            "a staff profile with no joined sign-in cannot sign in",
            404,
            main.current_user,
            user=AuthenticatedUser(id=str(unlinked_auth_id), email=UNLINKED_AUTH_EMAIL),
        )
        with engine.connect() as connection:
            still_unlinked = connection.execute(
                text("SELECT auth_user_id FROM public.users WHERE id = :staff_id"),
                {"staff_id": unlinked.staff_id},
            ).scalar_one()
        check(
            "the failed sign-in did not join anything",
            still_unlinked is None,
        )

        print("Office and role validation")
        expect_http_error(
            "a role that does not exist is rejected",
            422,
            main.link_invited_staff,
            request=main.StaffLinkCreate(
                email=TEST_EMAIL,
                full_name="Staff Access Check",
                branch_id=branch_id,
                role_ids=[999999],
            ),
            user=admin_user,
        )
        expect_http_error(
            "an inactive office is rejected",
            422,
            main.link_invited_staff,
            request=main.StaffLinkCreate(
                email="another.invited@example.com",
                full_name="Another",
                branch_id=inactive_branch_id,
                role_ids=[role_ids["AGENT"]],
            ),
            user=admin_user,
        )
        expect_validation_error(
            "a staff member with no role is rejected",
            main.StaffLinkCreate,
            email=TEST_EMAIL,
            full_name="Staff Access Check",
            branch_id=branch_id,
            role_ids=[],
        )
        expect_validation_error(
            "a duplicate role is rejected",
            main.StaffLinkCreate,
            email=TEST_EMAIL,
            full_name="Staff Access Check",
            branch_id=branch_id,
            role_ids=[role_ids["AGENT"], role_ids["AGENT"]],
        )
        expect_validation_error(
            "an email with no address is rejected",
            main.StaffLinkCreate,
            email="not-an-email",
            full_name="Staff Access Check",
            branch_id=branch_id,
            role_ids=[role_ids["AGENT"]],
        )

        print("Changing the roles")
        updated = main.update_managed_staff(
            target_staff_id=one_role.staff_id,
            update=main.StaffAccessUpdate(
                branch_id=branch_id,
                role_ids=[role_ids["ACCOUNTANT"]],
                is_active=True,
            ),
            user=admin_user,
        )
        check(
            "the roles are replaced, not appended",
            updated.roles == ["ACCOUNTANT"],
            f"got {updated.roles}",
        )
        with engine.connect() as connection:
            role_rows = connection.execute(
                text(
                    """
                    SELECT r.code FROM public.user_roles AS ur
                    JOIN public.roles AS r ON r.id = ur.role_id
                    WHERE ur.user_id = :staff_id
                    """
                ),
                {"staff_id": one_role.staff_id},
            ).scalars().all()
        check("the old roles are gone", list(role_rows) == ["ACCOUNTANT"], f"got {list(role_rows)}")

        print("Deactivating a staff member")
        deactivated = main.update_managed_staff(
            target_staff_id=one_role.staff_id,
            update=main.StaffAccessUpdate(
                branch_id=branch_id,
                role_ids=[role_ids["ACCOUNTANT"]],
                is_active=False,
            ),
            user=admin_user,
        )
        check("the staff member is deactivated", deactivated.is_active is False)

        print("Administrator protections")
        expect_http_error(
            "an admin cannot remove their own administrator role",
            409,
            main.update_managed_staff,
            target_staff_id=admin["id"],
            update=main.StaffAccessUpdate(
                branch_id=branch_id,
                role_ids=[role_ids["AGENT"]],
                is_active=True,
            ),
            user=admin_user,
        )
        expect_http_error(
            "an admin cannot deactivate themselves",
            409,
            main.update_managed_staff,
            target_staff_id=admin["id"],
            update=main.StaffAccessUpdate(
                branch_id=branch_id,
                role_ids=[role_ids["ADMIN"]],
                is_active=False,
            ),
            user=admin_user,
        )

        print("Role enforcement")
        linked_user = AuthenticatedUser(id=str(invited_auth_id), email=TEST_EMAIL)
        expect_http_error(
            "a non-administrator cannot read the staff register",
            403,
            main.list_managed_staff,
            user=linked_user,
        )
        expect_http_error(
            "a non-administrator cannot add a staff member",
            403,
            main.link_invited_staff,
            request=main.StaffLinkCreate(
                email="sneaky@example.com",
                full_name="Sneaky",
                branch_id=branch_id,
                role_ids=[role_ids["ADMIN"]],
            ),
            user=linked_user,
        )
        expect_http_error(
            "a non-administrator cannot change staff access",
            403,
            main.update_managed_staff,
            target_staff_id=admin["id"],
            update=main.StaffAccessUpdate(
                branch_id=branch_id,
                role_ids=[role_ids["AGENT"]],
                is_active=True,
            ),
            user=linked_user,
        )
    finally:
        with engine.begin() as connection:
            connection.execute(
                text(
                    """
                    DELETE FROM public.activity_logs
                    WHERE action IN ('staff.provisioned', 'staff.access_updated', 'staff.sign_in_linked')
                      AND entity_id IN (
                        SELECT id FROM public.users
                        WHERE email IN (:one, :many, :linked, :unlinked, :test)
                    )
                    """
                ),
                {
                    "one": ONE_ROLE_EMAIL,
                    "many": MANY_ROLES_EMAIL,
                    "linked": LINKED_EMAIL,
                    "unlinked": UNLINKED_AUTH_EMAIL,
                    "test": TEST_EMAIL,
                },
            )
            connection.execute(
                text(
                    "DELETE FROM public.users WHERE email IN (:one, :many, :linked, :unlinked, :test)"
                ),
                {
                    "one": ONE_ROLE_EMAIL,
                    "many": MANY_ROLES_EMAIL,
                    "linked": LINKED_EMAIL,
                    "unlinked": UNLINKED_AUTH_EMAIL,
                    "test": TEST_EMAIL,
                },
            )
            connection.execute(
                text(
                    "DELETE FROM auth.users WHERE email IN (:one, :many, :linked, :unlinked, :test)"
                ),
                {
                    "one": ONE_ROLE_EMAIL,
                    "many": MANY_ROLES_EMAIL,
                    "linked": LINKED_EMAIL,
                    "unlinked": UNLINKED_AUTH_EMAIL,
                    "test": TEST_EMAIL,
                },
            )
            connection.execute(text("DELETE FROM public.branches WHERE id = :id"), {"id": inactive_branch_id})
        print("Temporary staff profiles removed.")

    print()
    print(f"{len(PASSED)} passed, {len(FAILED)} failed")
    if FAILED:
        for failure in FAILED:
            print(f"  - {failure}")
        raise SystemExit(1)


if __name__ == "__main__":
    run()
