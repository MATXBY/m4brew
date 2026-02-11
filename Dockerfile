FROM python:3.12-slim

# Don’t write __pycache__ / .pyc inside the container
ENV PYTHONDONTWRITEBYTECODE=1


LABEL app.name="m4brew" \
      app.version="1.5.6" \
      app.release_date="2026-02-11" \
      app.description="Audiobook source manager and M4B converter"

# System deps (ffmpeg + tooling)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      ffmpeg \
      gnupg && \
    rm -rf /var/lib/apt/lists/*

# Install Docker CLI only (NOT full engine)
RUN set -eux; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc; \
    chmod a+r /etc/apt/keyrings/docker.asc; \
    . /etc/os-release; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" \
      > /etc/apt/sources.list.d/docker.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends docker-ce-cli; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY app/ /app/
COPY scripts/ /scripts/
RUN chmod +x /scripts/m4brew.sh

RUN pip install --no-cache-dir flask

EXPOSE 8080
CMD ["python", "web.py"]
