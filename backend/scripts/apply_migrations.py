from __future__ import annotations

import re
import sys
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

# Allow "python scripts/apply_migrations.py" from the backend directory.
BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from database import engine

MIGRATIONS_DIR = BACKEND_DIR / "migrations"

BEGIN_PATTERN = re.compile(r"^\s*BEGIN\s*;", re.IGNORECASE | re.MULTILINE)
COMMIT_PATTERN = re.compile(r"^\s*COMMIT\s*;", re.IGNORECASE | re.MULTILINE)


def ensure_migration_table(connection) -> None:
    connection.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS public.schema_migrations (
                version VARCHAR(120) PRIMARY KEY,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
    )


def detect_baseline(connection) -> list[str]:
    """Record migrations that were applied before this runner existed.

    The first schema migrations were applied by hand, so the tracking table
    starts empty on an existing database. Detecting the core objects keeps the
    runner from trying to create tables that are already there.
    """
    has_core_tables = connection.execute(
        text(
            """
            SELECT COUNT(*) = 3
            FROM information_schema.tables
            WHERE table_schema = 'public'
                AND table_name IN ('users', 'bookings', 'invoices')
            """
        )
    ).scalar_one()
    if not has_core_tables:
        return []

    baseline = ["001_initial_schema.sql"]
    has_auth_link = connection.execute(
        text(
            """
            SELECT COUNT(*) = 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
                AND table_name = 'users'
                AND column_name = 'auth_user_id'
            """
        )
    ).scalar_one()
    if has_auth_link:
        baseline.append("002_link_staff_to_supabase_auth.sql")
    return baseline


def load_migrations() -> list[tuple[str, Path]]:
    if not MIGRATIONS_DIR.is_dir():
        raise SystemExit(f"Migration directory not found: {MIGRATIONS_DIR}")

    migrations: list[tuple[str, Path]] = []
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        migrations.append((path.name, path))
    if not migrations:
        raise SystemExit(f"No migration files found in {MIGRATIONS_DIR}")
    return migrations


def strip_transaction_wrapper(sql: str) -> str:
    """The runner owns the transaction, so remove the file-level BEGIN/COMMIT."""
    sql = BEGIN_PATTERN.sub("", sql)
    sql = COMMIT_PATTERN.sub("", sql)
    return sql.strip()


def main() -> None:
    print(f"Applying migrations from {MIGRATIONS_DIR}")
    applied_now: list[str] = []

    with engine.begin() as connection:
        ensure_migration_table(connection)
        already_applied = {
            row[0] for row in connection.execute(text("SELECT version FROM public.schema_migrations"))
        }
        if not already_applied:
            for version in detect_baseline(connection):
                connection.execute(
                    text("INSERT INTO public.schema_migrations (version) VALUES (:version)"),
                    {"version": version},
                )
                already_applied.add(version)
                print(f"  ~ {version} (recorded as previously applied)")

    for version, path in load_migrations():
        if version in already_applied:
            print(f"  = {version} (already applied)")
            continue

        sql = strip_transaction_wrapper(path.read_text(encoding="utf-8"))
        try:
            with engine.begin() as connection:
                connection.execute(text(sql))
                connection.execute(
                    text("INSERT INTO public.schema_migrations (version) VALUES (:version)"),
                    {"version": version},
                )
        except SQLAlchemyError as error:
            print(f"  ! {version} failed: {error}", file=sys.stderr)
            print(
                "No further migrations were applied. Fix the failing migration and run this script again.",
                file=sys.stderr,
            )
            raise SystemExit(1) from error

        applied_now.append(version)
        print(f"  + {version}")

    if applied_now:
        print(f"Applied {len(applied_now)} migration(s): {', '.join(applied_now)}")
    else:
        print("The database schema is already up to date.")


if __name__ == "__main__":
    main()
