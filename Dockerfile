FROM sandreas/m4b-tool:latest
ENV PYTHONDONTWRITEBYTECODE=1
LABEL app.name="m4brew" \
      app.version="1.2" \
      app.release_date="2026-04-18" \
      app.description="Audiobook source manager and M4B converter"
RUN apk add --no-cache python3 py3-pip curl bash
WORKDIR /app
COPY requirements.txt /app/
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt
COPY app/ /app/
COPY scripts/ /scripts/
RUN chmod +x /scripts/m4brew.sh
RUN adduser -u 1000 -D m4brew && chown -R m4brew:m4brew /app /scripts
USER m4brew
ENTRYPOINT []
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "1", "--threads", "4", "--timeout", "120", "web:app"]
