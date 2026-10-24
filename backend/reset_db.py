from database import engine
from sqlalchemy import text

TABLES = [
    "passengers", "passenger_documents", "customers",
    "booking_passengers", "flight_segments", "bookings", "booking_quotes",
    "ticketing_requests", "ticket_coupons", "ticket_actions", "tickets",
    "customer_payments", "invoices", "invoice_items", "payment_allocations",
    "customer_refunds", "supplier_bills", "supplier_payments",
    "business_expenses", "documents", "activity_logs", "exchange_rates",
]

def main():
    confirm = input("Are you sure you want to wipe the database? (y/n) ").strip().lower()
    if confirm != "y":
        print("Aborted.")
        return
    with engine.connect() as conn:
        conn.execute(text("TRUNCATE TABLE " + ", ".join(TABLES) + " RESTART IDENTITY CASCADE;"))
        conn.commit()
    print("Database wiped successfully (users/roles/branches preserved).")

if __name__ == "__main__":
    main()
