#!/bin/sh
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
UMASK="${UMASK:-022}"

CURRENT_UID="$(id -u m4brew)"
CURRENT_GID="$(id -g m4brew)"

if [ "$PGID" != "$CURRENT_GID" ]; then
  groupmod -o -g "$PGID" m4brew
fi

if [ "$PUID" != "$CURRENT_UID" ]; then
  usermod -o -u "$PUID" m4brew
fi

umask "$UMASK"

chown -R m4brew:m4brew /app /scripts
[ -d /config ] && chown -R m4brew:m4brew /config

exec su-exec m4brew "$@"
