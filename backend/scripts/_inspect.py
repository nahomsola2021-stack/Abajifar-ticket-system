import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import text
from database import engine

with engine.connect() as c:
    print("number sequences:")
    for branch_id, kind, value in c.execute(
        text("SELECT branch_id, kind, next_value FROM public.document_number_sequences")
    ).all():
        print(f"   branch {branch_id} {kind} -> {value}")
    print()
    print("generated numbers:")
    for kind in ("INV", "RCP", "BILL", "EXP"):
        print("  ", c.execute(text("SELECT public.next_document_number(1, :k)"), {"k": kind}).scalar_one())
    print()
    print("supplier_bills columns:")
    for name, nullable in c.execute(
        text(
            """
            SELECT column_name, is_nullable FROM information_schema.columns
            WHERE table_name = 'supplier_bills' ORDER BY ordinal_position
            """
        )
    ).all():
        print(f"   {name} ({'nullable' if nullable == 'YES' else 'not null'})")
    print()
    print("business_expenses columns:")
    for name, nullable in c.execute(
        text(
            """
            SELECT column_name, is_nullable FROM information_schema.columns
            WHERE table_name = 'business_expenses' ORDER BY ordinal_position
            """
        )
    ).all():
        print(f"   {name} ({'nullable' if nullable == 'YES' else 'not null'})")
    print()
    print("documents financial columns:")
    for name in c.execute(
        text(
            """
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'documents' AND column_name LIKE '%_id'
            ORDER BY column_name
            """
        )
    ).scalars().all():
        print("  ", name)
    print()
    print("sequence table rows after use:")
    for row in c.execute(
        text("SELECT branch_id, kind, next_value FROM public.document_number_sequences ORDER BY kind")
    ).all():
        print("  ", row)
