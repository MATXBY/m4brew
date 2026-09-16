FROM sandreas/m4b-tool:latest
ENV PYTHONDONTWRITEBYTECODE=1
LABEL app.name="m4brew" \
      app.release_date="2026-04-18" \
      app.description="Audiobook source manager and M4B converter"
# ffmpeg here is *only* for ffprobe - the base image bundles a static
# /usr/local/bin/ffmpeg (which wins on PATH and is what m4brew.sh actually
# uses) but no ffprobe binary at all, needed for the ID3 track-tag fallback.
RUN apk add --no-cache python3 py3-pip curl bash su-exec shadow ffmpeg
WORKDIR /app
COPY requirements.txt /app/
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt
COPY app/ /app/
COPY scripts/ /scripts/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /scripts/m4brew.sh /entrypoint.sh
RUN adduser -u 1000 -D m4brew && chown -R m4brew:m4brew /app /scripts
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1
ENTRYPOINT ["/entrypoint.sh"]
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "1", "--threads", "4", "--timeout", "120", "web:app"]
