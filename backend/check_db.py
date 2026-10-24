
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from database import engine


def main():
    try:
        with engine.connect() as connection:
            result = connection.execute(
                text("SELECT current_database(), current_user")
            )
            database_name, database_user = result.one()

        print("Database connection successful!")
        print(f"Database: {database_name}")
        print(f"Connected user: {database_user}")

    except SQLAlchemyError as error:
        print("Database connection failed.")
        print(f"Error type: {type(error).__name__}")
        print(f"Details: {error}")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
