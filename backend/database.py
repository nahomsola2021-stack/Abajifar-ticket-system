
import os
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import URL, create_engine

# Load environment settings from backend/.env
BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

# Check that required credentials exist.
required_settings = ["DB_HOST", "DB_USER", "DB_PASSWORD"]
missing_settings = [
    key for key in required_settings
    if not os.getenv(key)
]

# A single connection string is enough on its own. Hosted platforms hand one
# out, so it takes precedence over the individual settings.
database_url_setting = os.getenv("DATABASE_URL", "").strip()

if not database_url_setting and missing_settings:
    raise RuntimeError(
        "Missing database settings in backend/.env: "
        + ", ".join(missing_settings)
        + " (or set DATABASE_URL)"
    )

if database_url_setting:
    database_url = database_url_setting
else:
    # Build the connection safely, including passwords
    # that contain special URL characters.
    database_url = URL.create(
        drivername="postgresql+psycopg",
        username=os.environ["DB_USER"],
        password=os.environ["DB_PASSWORD"],
        host=os.environ["DB_HOST"],
        port=int(os.getenv("DB_PORT", "5432")),
        database=os.getenv("DB_NAME", "postgres"),
    )

# Require SSL when connecting to the hosted database. A connection string that
# already names an sslmode keeps the setting it was given.
connect_args = {} if "sslmode=" in str(database_url) else {"sslmode": "require"}

engine = create_engine(
    database_url,
    pool_pre_ping=True,
    connect_args=connect_args,
)
