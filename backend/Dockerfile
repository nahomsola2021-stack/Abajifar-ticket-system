FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8000

WORKDIR /app

# Install the dependencies first so an application change does not reinstall
# them on every build.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Attachments are written here. Mount a volume over it to keep uploads across
# restarts.
RUN mkdir -p /var/data/documents
ENV DOCUMENT_STORAGE_DIR=/var/data/documents

EXPOSE 8000

CMD uvicorn main:app --host 0.0.0.0 --port ${PORT}
