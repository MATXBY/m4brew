FROM python:3.12-slim

LABEL app.name="m4brew" \
      app.version="0.3.0-dev" \
      app.release_date="2026-01-04" \
      app.description="Audiobook source manager and M4B converter"

# Install bash, curl and ffmpeg/ffprobe
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Install Docker CLI (so the script's docker commands can be sent to the host via docker.sock)
RUN curl -fsSL https://get.docker.com -o /tmp/get-docker.sh && \
    sh /tmp/get-docker.sh && \
    rm -f /tmp/get-docker.sh

# Set working directory for the web app
WORKDIR /app

# Copy Flask web app
COPY app/ /app/

# Copy scripts
COPY scripts/ /scripts/
RUN chmod +x /scripts/m4brew.sh

# Install Python dependencies
RUN pip install --no-cache-dir flask

# Expose the web UI port
EXPOSE 8080

# Run the Flask app
CMD ["python", "web.py"]

