#!/bin/bash
set -u
IFS=$'\n\t'

# Root of your audiobooks (Author/Book folders)
ROOT_DEFAULT="/mnt/remotes/192.168.4.4_media/Audiobooks"
ROOT="${ROOT_FOLDER:-$ROOT_DEFAULT}"

# Operation mode (can be overridden via environment variable MODE):
MODE="${MODE:-convert}"

# DRY_RUN (can be overridden via environment variable DRY_RUN):
DRY_RUN="${DRY_RUN:-true}"

# Ensure helper containers join the same docker network as m4brew
DOCKER_NETWORK="${DOCKER_NETWORK:-matt-net}"

# Audio mode policy (can be overridden via environment variable AUDIO_MODE):
AUDIO_MODE_DEFAULT="match"
AUDIO_MODE="${AUDIO_MODE:-$AUDIO_MODE_DEFAULT}"   # match | mono | stereo

# Docker user:group (match your mount ownership)
DOCKER_UID_GID="1026:100"
DOCKER_GID="${DOCKER_UID_GID##*:}"

# Docker image for m4b-tool (merge + optional re-encode)
M4B_IMAGE="sandreas/m4b-tool:latest"

# Docker image for ffmpeg (for single-file M4A remux)
FFMPEG_IMAGE="linuxserver/ffmpeg"

# Target bitrate for all MP3→M4B outputs (numeric kbps from env → append "k")
BITRATE_DEFAULT="64"
BITRATE="${BITRATE:-$BITRATE_DEFAULT}k"

# Minimum acceptable output size (5 MB) to consider conversion valid
MIN_BYTES=$((5 * 1024 * 1024))

############################################
# Helpers
############################################
ts() { date +"%Y-%m-%d %H:%M:%S"; }
log() { echo "[$(ts)] $*"; }

is_dry_run() {
  [[ "${DRY_RUN}" == "true" ]]
}

safe_name() {
  echo "$1" | sed 's#/#-#g'
}

# Emit the special summary line (must be ONE line, machine readable)
emit_summary() {
  local success="$1"          # true|false
  local runtime_s="$2"        # integer seconds
  local created="$3"          # integer
  local skipped="$4"          # integer
  local failed="$5"           # integer
  local renamed="$6"          # integer
  local deleted="$7"          # integer
  local reason="${8:-""}"     # optional string

  # Parse BITRATE like "96k" → 96 (best effort)
  local bitrate_num
  bitrate_num="$(echo "${BITRATE}" | sed 's/[^0-9]//g')"
  [[ -z "${bitrate_num}" ]] && bitrate_num=0

  # Build compact JSON (no pretty-print, must be single line)
  if [[ -n "${reason}" ]]; then
    echo "__M4B_SUMMARY_JSON__ {\"mode\":\"${MODE}\",\"dry_run\":${DRY_RUN},\"success\":${success},\"runtime_s\":${runtime_s},\"root\":\"${ROOT}\",\"audio_mode\":\"${AUDIO_MODE}\",\"bitrate_kbps\":${bitrate_num},\"created\":${created},\"skipped\":${skipped},\"failed\":${failed},\"renamed\":${renamed},\"deleted\":${deleted},\"reason\":\"${reason}\"}"
  else
    echo "__M4B_SUMMARY_JSON__ {\"mode\":\"${MODE}\",\"dry_run\":${DRY_RUN},\"success\":${success},\"runtime_s\":${runtime_s},\"root\":\"${ROOT}\",\"audio_mode\":\"${AUDIO_MODE}\",\"bitrate_kbps\":${bitrate_num},\"created\":${created},\"skipped\":${skipped},\"failed\":${failed},\"renamed\":${renamed},\"deleted\":${deleted}}"
  fi
}

# Detect mono vs stereo using ffprobe inside the m4b-tool image
detect_channels() {
  local first_file="$1"

  # DRY_RUN should never spin up helper containers.
  # Default to stereo (2) to keep the run fast and safe.
  if is_dry_run; then
    echo "2"
    return 0
  fi

  local ch
  ch=$(docker run --rm --network "${DOCKER_NETWORK}" \
      -v "$(dirname "$first_file"):/data" \
      "$M4B_IMAGE" \
      ffprobe -v error -select_streams a:0 -show_entries stream=channels \
      -of default=nk=1:nw=1 "/data/$(basename "$first_file")" 2>/dev/null || echo "2")

  if [[ "$ch" == "1" ]]; then
    echo "1"
  else
    echo "2"
  fi
}

# Resolve audio channels based on AUDIO_MODE policy
resolve_channels() {
  local detected="$1"

  case "${AUDIO_MODE:-match}" in
    mono)   echo "1" ;;
    stereo) echo "2" ;;
    match|*) echo "$detected" ;;
  esac
}

############################################
# Start
############################################
START_EPOCH=$(date +%s)

log "===== START MP3/M4A → M4B tool ====="
log "MODE=${MODE}"
log "ROOT=${ROOT}"
log "DRY_RUN=${DRY_RUN}"
log "BITRATE=${BITRATE}"
log "AUDIO_MODE=${AUDIO_MODE}"
log "DOCKER_UID:GID=${DOCKER_UID_GID}"

# Ensure root exists
if [[ ! -d "${ROOT}" ]]; then
  log "ERROR: ROOT does not exist: ${ROOT}"
  END_EPOCH=$(date +%s)
  RUNTIME=$((END_EPOCH - START_EPOCH))
  emit_summary false "${RUNTIME}" 0 0 1 0 0 "root_missing"
  exit 1
fi

# Prevent overlapping runs (web UI double-submit etc.)
LOCKFILE="/config/m4brew.lock"
mkdir -p /config 2>/dev/null || true
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  log "ERROR: Another run is already in progress. Exiting."
  END_EPOCH=$(date +%s)
  RUNTIME=$((END_EPOCH - START_EPOCH))
  emit_summary false "${RUNTIME}" 0 0 1 0 0 "already_running"
  exit 1
fi

# Cancel: exit immediately on SIGINT/SIGTERM (releases lock)
on_cancel() {
  log "CANCEL: signal received, exiting."
    END_EPOCH=$(date +%s)
    RUNTIME=$((END_EPOCH - START_EPOCH))
    emit_summary false "${RUNTIME}" 0 0 1 0 0 "canceled"
  exit 130
}
trap on_cancel INT TERM


############################################
# CLEANUP MODE: delete _backup_files only
############################################
if [[ "$MODE" == "cleanup" ]]; then
  log "===== CLEANUP MODE: deleting _backup_files folders ====="
  log "ROOT=${ROOT}"
  log "DRY_RUN=${DRY_RUN}"

  mapfile -d '' -t backup_dirs < <(
    find "$ROOT" -type d -iname "_backup_files" -print0 2>/dev/null
  )

  if [[ ${#backup_dirs[@]} -eq 0 ]]; then
    log "No _backup_files folders found — nothing to delete."
    log "===== END CLEANUP ====="
    END_EPOCH=$(date +%s)
    RUNTIME=$((END_EPOCH - START_EPOCH))
    emit_summary true "${RUNTIME}" 0 0 0 0 0
    exit 0
  fi

  deleted_count=0

  for dir in "${backup_dirs[@]}"; do
    log "Deleting: $dir"
    if is_dry_run; then
      log "[DRY-RUN] rm -rf \"$dir\""
      deleted_count=$((deleted_count + 1))
    else
      rm -rf "$dir"
      deleted_count=$((deleted_count + 1))
    fi
  done

  log "Cleanup complete. Deleted backup folders: ${deleted_count}"
  log "===== END CLEANUP ====="
  END_EPOCH=$(date +%s)
  RUNTIME=$((END_EPOCH - START_EPOCH))
  emit_summary true "${RUNTIME}" 0 0 0 0 "${deleted_count}"
  exit 0
fi

############################################
# CORRECT MODE: rename .m4b to Book.m4b
############################################
if [[ "$MODE" == "correct" ]]; then
  log "===== CORRECT MODE: renaming .m4b files ====="
  log "ROOT=${ROOT}"
  log "DRY_RUN=${DRY_RUN}"

  renamed_count=0
  already_ok_count=0
  skipped_none_count=0
  skipped_multi_count=0

  while IFS= read -r -d '' book_dir; do
    author_dir="$(dirname "$book_dir")"
    author="$(basename "$author_dir")"
    book="$(basename "$book_dir")"

    [[ "$author" == "#recycle" ]] && continue

    mapfile -d '' -t m4bs < <(find "$book_dir" -maxdepth 1 -type f -iname "*.m4b" -print0 2>/dev/null || true)
    m4b_count=${#m4bs[@]}

    if [[ "$m4b_count" -eq 0 ]]; then
      skipped_none_count=$((skipped_none_count + 1))
      continue
    fi

    if [[ "$m4b_count" -gt 1 ]]; then
      log "WARN: Multiple .m4b files in book folder, skipping rename: ${book_dir}"
      skipped_multi_count=$((skipped_multi_count + 1))
      continue
    fi

    existing_path="${m4bs[0]}"
    existing_base="$(basename "$existing_path")"
    desired_name="${book} - ${author}.m4b"
    desired_path="${book_dir}/${desired_name}"

    if [[ "$existing_base" == "$desired_name" ]]; then
      already_ok_count=$((already_ok_count + 1))
      continue
    fi

    log "RENAME: ${existing_base} → ${desired_name} (in ${book_dir})"
    if is_dry_run; then
      log "[DRY-RUN] mv \"${existing_path}\" \"${desired_path}\""
    else
      mv -f "${existing_path}" "${desired_path}"
    fi
    renamed_count=$((renamed_count + 1))

  done < <(find "${ROOT}" -mindepth 2 -maxdepth 2 -type d -print0 2>/dev/null)

  END_EPOCH=$(date +%s)
  RUNTIME=$((END_EPOCH - START_EPOCH))

  log "===== CORRECT MODE SUMMARY ====="
  log "Runtime                : ${RUNTIME}s"
  log "Renamed .m4b files     : ${renamed_count}"
  log "Already correct        : ${already_ok_count}"
  log "Skipped (no .m4b)      : ${skipped_none_count}"
  log "Skipped (multiple .m4b): ${skipped_multi_count}"
  log "===== END CORRECT MODE ====="

  emit_summary true "${RUNTIME}" 0 0 0 "${renamed_count}" 0
  exit 0
fi

############################################
# CONVERT MODE: pull images & process folders
############################################
log "MODE=convert: converting + backing up sources → _backup_files/"
log "Policy: MP3s re-encoded @ ${BITRATE}, M4As remuxed where possible"

# Pull images once (skip in dry-run)
if is_dry_run; then
  log "[DRY-RUN] skipping docker pull"
else
  log "[RUN] docker pull \"${M4B_IMAGE}\" >/dev/null 2>&1 || true"
  docker pull "${M4B_IMAGE}" >/dev/null 2>&1 || true
  log "[RUN] docker pull \"${FFMPEG_IMAGE}\" >/dev/null 2>&1 || true"
  docker pull "${FFMPEG_IMAGE}" >/dev/null 2>&1 || true
fi

created_count=0
skipped_count=0
failed_count=0
declare -a created_files=()
declare -a failed_books=()

while IFS= read -r -d '' book_dir; do
  author_dir="$(dirname "$book_dir")"
  author="$(basename "$author_dir")"
  book="$(basename "$book_dir")"

  [[ "$author" == "#recycle" ]] && continue

  if find "$book_dir" -maxdepth 1 -type f -iname "*.m4b" ! -iname ".tmp_*.m4b" ! -iname "tmp_*.m4b" -print -quit | grep -q .; then
    log "SKIP (already has m4b): ${book_dir}"
    skipped_count=$((skipped_count + 1))
    continue
  fi

  mapfile -d '' -t mp3s < <(find "$book_dir" -maxdepth 1 -type f -iname "*.mp3" -print0 2>/dev/null || true)
  mapfile -d '' -t m4as < <(find "$book_dir" -maxdepth 1 -type f -iname "*.m4a" -print0 2>/dev/null || true)

  mp3_count=${#mp3s[@]}
  m4a_count=${#m4as[@]}

  if [[ "$mp3_count" -eq 0 && "$m4a_count" -eq 0 ]]; then
    continue
  fi

  if [[ "$mp3_count" -gt 0 && "$m4a_count" -gt 0 ]]; then
    log "INFO: Both MP3 and M4A found, using MP3s only → ${book_dir}"
  fi

  out_name="${book}.m4b"
  out_path="${book_dir}/${out_name}"
  tmp_stem="$(safe_name "$book")"
  tmp_path="${book_dir}/.tmp_${tmp_stem}.m4b"
    # If a previous run was canceled/crashed, remove stale temp so we always re-encode
    rm -f "${tmp_path}" >/dev/null 2>&1 || true

  if [[ -f "${out_path}" ]]; then
    log "WARN: Unexpected existing .m4b without earlier detection, skipping: ${out_path}"
    skipped_count=$((skipped_count + 1))
    continue
  fi

  log "----------------------------------------"
  log "AUTHOR: ${author}"
  log "BOOK:   ${book}"
  log "PATH:   ${book_dir}"
  log "MP3s:   ${mp3_count}"
  log "M4As:   ${m4a_count}"

  ##########################################
  # Branch 1: MP3 → M4B
  ##########################################
  if [[ "$mp3_count" -gt 0 ]]; then
    first_mp3="${mp3s[0]}"
    detected="$(detect_channels "$first_mp3")"
    channels="$(resolve_channels "$detected")"

    [[ "$channels" == "1" ]] && mode_desc="mono" || mode_desc="stereo"
    log "MODE:   ${mode_desc} @ ${BITRATE}"
    log "OUTPUT: ${out_path}"

    audio_args=(--audio-bitrate="${BITRATE}" --audio-channels="${channels}")

    cmd=(docker run --rm --network "${DOCKER_NETWORK}" -u "${DOCKER_UID_GID}"
      -v "${book_dir}:/data"
      "${M4B_IMAGE}" merge /data
      --output-file "/data/$(basename "$tmp_path")"
      "${audio_args[@]}"
    )

    if is_dry_run; then
      log "[DRY-RUN] ${cmd[*]}"
      created_count=$((created_count + 1))
      created_files+=("${out_path} (DRY-RUN, from MP3)")
      continue
    fi

    if ! "${cmd[@]}"; then
      log "ERROR: m4b-tool merge (MP3) failed for: ${book_dir}"
      failed_count=$((failed_count + 1))
      failed_books+=("${book_dir}")
      rm -f "${tmp_path}" >/dev/null 2>&1 || true
      continue
    fi

    if [[ ! -f "${tmp_path}" ]]; then
      log "ERROR: temp m4b not created (MP3): ${tmp_path}"
      failed_count=$((failed_count + 1))
      failed_books+=("${book_dir}")
      continue
    fi

    size_bytes=$(stat -c%s "${tmp_path}" 2>/dev/null || echo 0)
    if [[ "${size_bytes}" -lt "${MIN_BYTES}" ]]; then
      log "ERROR: temp m4b too small (${size_bytes} bytes, MP3). Keeping MP3s. Temp stays: ${tmp_path}"
      failed_count=$((failed_count + 1))
      failed_books+=("${book_dir}")
      continue
    fi

    mv -f "${tmp_path}" "${out_path}"
    log "OK: Created (from MP3) ${out_path}"
    created_count=$((created_count + 1))
    created_files+=("${out_path}")

    backup_dir="${book_dir}/_backup_files"
    if is_dry_run; then
      log "[DRY-RUN] mkdir -p \"${backup_dir}\""
      log "[DRY-RUN] move *.mp3 → \"${backup_dir}/\""
    else
      mkdir -p "${backup_dir}"
      find "${book_dir}" -maxdepth 1 -type f -iname "*.mp3" -print0 \
        | xargs -0 -I{} mv -f "{}" "${backup_dir}/"
    fi
    log "MP3s moved to: ${backup_dir}/"

    continue
  fi

  ##########################################
  # Branch 2: M4A → M4B
  ##########################################
  if [[ "$m4a_count" -eq 1 ]]; then
    in_file="${m4as[0]}"
    log "MODE:   Single M4A (remux, stream copy)"
    log "INPUT:  ${in_file}"
    log "OUTPUT: ${out_path}"

    cmd=(docker run --rm --network "${DOCKER_NETWORK}"
      -e "PUID=${DOCKER_UID_GID%%:*}"
      -e "PGID=${DOCKER_UID_GID##*:}"
      -v "${book_dir}:/data"
      "${FFMPEG_IMAGE}" -v error -stats
      -i "/data/$(basename "$in_file")"
      -c copy -movflags +faststart
      "/data/$(basename "$tmp_path")"
    )

    if is_dry_run; then
      log "[DRY-RUN] ${cmd[*]}"
      created_count=$((created_count + 1))
      created_files+=("${out_path} (DRY-RUN, from single M4A)")
      continue
    fi

    if ! "${cmd[@]}"; then
      log "ERROR: ffmpeg remux (M4A) failed for: ${book_dir}"
      failed_count=$((failed_count + 1))
      failed_books+=("${book_dir}")
      rm -f "${tmp_path}" >/dev/null 2>&1 || true
      continue
    fi

  else
    first_m4a="${m4as[0]}"
    detected="$(detect_channels "$first_m4a")"
    channels="$(resolve_channels "$detected")"

    [[ "$channels" == "1" ]] && mode_desc="mono" || mode_desc="stereo"
    log "MODE:   Multi-M4A merge (${mode_desc} @ ${BITRATE})"
    log "OUTPUT: ${out_path}"

    audio_args=(--audio-bitrate="${BITRATE}" --audio-channels="${channels}")

    cmd=(docker run --rm --network "${DOCKER_NETWORK}" -u "${DOCKER_UID_GID}"
      -v "${book_dir}:/data"
      "${M4B_IMAGE}" merge /data
      --output-file "/data/$(basename "$tmp_path")"
      "${audio_args[@]}"
    )

    if is_dry_run; then
      log "[DRY-RUN] ${cmd[*]}"
      created_count=$((created_count + 1))
      created_files+=("${out_path} (DRY-RUN, from multi M4A)")
      continue
    fi

    if ! "${cmd[@]}"; then
      log "ERROR: m4b-tool merge (M4A) failed for: ${book_dir}"
      failed_count=$((failed_count + 1))
      failed_books+=("${book_dir}")
      rm -f "${tmp_path}" >/dev/null 2>&1 || true
      continue
    fi
  fi

  if [[ ! -f "${tmp_path}" ]]; then
    log "ERROR: temp m4b not created (M4A): ${tmp_path}"
    failed_count=$((failed_count + 1))
    failed_books+=("${book_dir}")
    continue
  fi

  size_bytes=$(stat -c%s "${tmp_path}" 2>/dev/null || echo 0)
  if [[ "${size_bytes}" -lt "${MIN_BYTES}" ]]; then
    log "ERROR: temp m4b too small (${size_bytes} bytes, M4A). Keeping M4As. Temp stays: ${tmp_path}"
    failed_count=$((failed_count + 1))
    failed_books+=("${book_dir}")
    continue
  fi

  mv -f "${tmp_path}" "${out_path}"
  log "OK: Created (from M4A) ${out_path}"
  created_count=$((created_count + 1))
  created_files+=("${out_path}")

  backup_dir="${book_dir}/_backup_files"
  if is_dry_run; then
    log "[DRY-RUN] mkdir -p \"${backup_dir}\""
    log "[DRY-RUN] move *.m4a → \"${backup_dir}/\""
  else
    mkdir -p "${backup_dir}"
    find "${book_dir}" -maxdepth 1 -type f -iname "*.m4a" -print0 \
      | xargs -0 -I{} mv -f "{}" "${backup_dir}/"
  fi
  log "M4As moved to: ${backup_dir}/"

done < <(find "${ROOT}" -mindepth 2 -maxdepth 2 -type d -print0 2>/dev/null)

END_EPOCH=$(date +%s)
RUNTIME=$((END_EPOCH - START_EPOCH))

log "===== CONVERT MODE SUMMARY ====="
log "Runtime      : ${RUNTIME}s"
log "Created M4Bs : ${created_count}"
log "Skipped books: ${skipped_count}"
log "Failed books : ${failed_count}"

if [[ "${#created_files[@]}" -gt 0 ]]; then
  log "Created files:"
  for f in "${created_files[@]}"; do
    log "  - ${f}"
  done
else
  log "Created files: none"
fi

if [[ "${#failed_books[@]}" -gt 0 ]]; then
  log "Failures:"
  for f in "${failed_books[@]}"; do
    log "  - ${f}"
  done
fi

log "===== END CONVERT MODE ====="

if [[ "${failed_count}" -eq 0 ]]; then
  emit_summary true "${RUNTIME}" "${created_count}" "${skipped_count}" "${failed_count}" 0 0
else
  emit_summary false "${RUNTIME}" "${created_count}" "${skipped_count}" "${failed_count}" 0 0
fi
