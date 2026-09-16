#!/bin/bash
set -u
IFS=$'\n\t'

# Job identifier (safe default)
JOB_ID="${JOB_ID:-manual}"

# Root of your audiobooks (Author/Book folders)
ROOT="${ROOT_FOLDER:-/audiobooks}"

# Operation mode (can be overridden via environment variable MODE):
MODE="${MODE:-convert}"

# DRY_RUN (can be overridden via environment variable DRY_RUN):
DRY_RUN="${DRY_RUN:-true}"

# Audio mode policy (can be overridden via environment variable AUDIO_MODE):
AUDIO_MODE_DEFAULT="match"
AUDIO_MODE="${AUDIO_MODE:-$AUDIO_MODE_DEFAULT}"   # match | mono | stereo

# Target bitrate for all MP3→M4B outputs (numeric kbps from env → append "k")
BITRATE_DEFAULT="64"
BITRATE="${BITRATE:-$BITRATE_DEFAULT}"
if [[ "$BITRATE" != "match" ]]; then
  # Append "k" suffix for numeric bitrates
  [[ "$BITRATE" != *k ]] && BITRATE="${BITRATE}k"
fi

# Minimum acceptable output size (5 MB) to consider conversion valid
MIN_BYTES=$((5 * 1024 * 1024))

# Max seconds for a single ffmpeg/m4b-tool conversion step (remux or merge)
# before it's killed. A hung or corrupt input file would otherwise block the
# whole batch indefinitely; this should comfortably exceed how long converting
# a single legitimately huge book takes.
CONVERT_TIMEOUT_SECS="${CONVERT_TIMEOUT_SECS:-1800}"

# Max seconds for the quick ffmpeg probes (channel/bitrate detection) - these
# only read a file's metadata and should finish in well under a minute.
PROBE_TIMEOUT_SECS="${PROBE_TIMEOUT_SECS:-60}"

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

book_label() {
  # "Author / Book" from ".../Author/Book"
  local book_dir="$1"
  local author_dir author book
  author_dir="$(dirname "$book_dir")"
  author="$(basename "$author_dir")"
  book="$(basename "$book_dir")"
  echo "${author} / ${book}"
}

json_escape() {
  # minimal JSON string escape (quotes, backslash, tabs/newlines)
  # shellcheck disable=SC2001
  echo -n "$1" \
    | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g; s/\r/\\r/g; s/\n/\\n/g'
}
# Convert roman numeral (i-xx) to integer (1-20)
roman_to_num() {
  local r="$1"
  case "$r" in
    i) echo "1" ;; ii) echo "2" ;; iii) echo "3" ;; iv) echo "4" ;; v) echo "5" ;;
    vi) echo "6" ;; vii) echo "7" ;; viii) echo "8" ;; ix) echo "9" ;; x) echo "10" ;;
    xi) echo "11" ;; xii) echo "12" ;; xiii) echo "13" ;; xiv) echo "14" ;; xv) echo "15" ;;
    xvi) echo "16" ;; xvii) echo "17" ;; xviii) echo "18" ;; xix) echo "19" ;; xx) echo "20" ;;
    *) echo "" ;;
  esac
}

# Convert a written-out number word (one-twenty) to an integer
word_to_num() {
  case "$1" in
    one) echo "1" ;; two) echo "2" ;; three) echo "3" ;; four) echo "4" ;; five) echo "5" ;;
    six) echo "6" ;; seven) echo "7" ;; eight) echo "8" ;; nine) echo "9" ;; ten) echo "10" ;;
    eleven) echo "11" ;; twelve) echo "12" ;; thirteen) echo "13" ;; fourteen) echo "14" ;; fifteen) echo "15" ;;
    sixteen) echo "16" ;; seventeen) echo "17" ;; eighteen) echo "18" ;; nineteen) echo "19" ;; twenty) echo "20" ;;
    *) echo "" ;;
  esac
}

# Canonical position (1-9) of a recognized unnumbered front-matter keyword.
# Front matter sorts before any numbered chapter.
frontmatter_rank() {
  case "$1" in
    foreword) echo "1" ;;
    preface) echo "2" ;;
    introduction|intro) echo "3" ;;
    prologue) echo "4" ;;
    *) echo "" ;;
  esac
}

# a=1 .. z=26
letter_to_num() {
  local c="$1"
  printf '%d' "$(( $(printf '%d' "'$c") - $(printf '%d' "'a") + 1 ))"
}

# "Disc 1" / "Disk 02" / "CD3" (directory basename) -> "1" / "2" / "3". Empty if no match.
disc_number_for_dir() {
  local lc
  lc="$(echo "$1" | tr '[:upper:]' '[:lower:]')"
  echo "$lc" | sed -n -E 's/^(disc|disk|cd)[[:space:]_-]*0*([0-9]{1,3})$/\2/p' | head -n 1
}

# Extract an order key from a filename (base name only, extension already stripped).
# Returns a 7-character string: 1 digit type (0=front matter, 1=chapter) +
# 4-digit chapter/rank number + 2-digit ACX sub-letter (00 = none). Empty if unclear.
# Patterns (in priority order):
#   0) unnumbered front matter: "Prologue", "Introduction"
#   1) starts with digits, optionally wrapped in ()/[] and/or with an ACX letter
#      suffix: "01 Prologue", "(01) Title", "[01] Title", "01a Title"
#   2) separator+digits: "something - 03", "something_03", "something.03"
#   3) keyword+number: "Part 2", "Chapter 10", "Episode 3", "Volume 1", "Book 2", etc.
#   4) keyword+roman: "Chapter III", "Part IV"
#   5) written-out number: "One", "Chapter Two"
#   6) trailing number with only whitespace before it: "Title 01"
# Year rejection: numbers 1900-2099 are ignored (all patterns cap at 999)
extract_order_key() {
  local base="$1"
  local lc
  lc="$(echo "$base" | tr '[:upper:]' '[:lower:]' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  local n="" sub=0

  # Pattern 0: unnumbered front matter (whole name is a known keyword)
  n="$(frontmatter_rank "$lc")"
  if [[ -n "$n" ]]; then
    printf '0%04d00' "$n"
    return 0
  fi

  # Normalize a leading (01) or [01] wrapper to a bare leading number
  lc="$(echo "$lc" | sed -E 's/^\(([0-9]+)\)/\1/; s/^\[([0-9]+)\]/\1/')"

  # Pattern 1: numeric prefix at start, optional single-letter ACX suffix (01a, 01b)
  n="$(echo "$lc" | sed -n -E 's/^[[:space:]]*0*([0-9]{1,4})($|[^0-9].*)/\1/p' | head -n 1)"
  if [[ -n "$n" && "$n" -le 999 ]]; then
    local letter=""
    letter="$(echo "$lc" | sed -n -E 's/^[[:space:]]*0*[0-9]{1,4}([a-z])($|[^a-z0-9].*)/\1/p' | head -n 1)"
    [[ -n "$letter" ]] && sub="$(letter_to_num "$letter")"
    printf '1%04d%02d' "$n" "$sub"
    return 0
  fi

  # Pattern 2: Number after STRONG separator (dash, underscore, dot)
  n="$(echo "$lc" | sed -n 's/.*[-_.][[:space:]]*0*\([0-9]\{1,4\}\)\($\|[^0-9].*\)/\1/p' | head -n 1)"
  if [[ -n "$n" && "$n" -le 999 ]]; then
    printf '1%04d00' "$n"
    return 0
  fi

  # Pattern 3: keyword + number
  n="$(echo "$lc" | sed -n 's/.*\b\(part\|chapter\|ch\|disc\|disk\|cd\|track\|episode\|ep\|volume\|vol\|book\|session\)[^0-9]\{0,6\}0*\([0-9]\{1,4\}\)\b.*/\2/p' | head -n 1)"
  if [[ -n "$n" && "$n" -le 999 ]]; then
    printf '1%04d00' "$n"
    return 0
  fi

  # Pattern 4: keyword + roman numeral (Chapter III, Part IV)
  local roman=""
  roman="$(echo "$lc" | sed -n 's/.*\b\(part\|chapter\|ch\|disc\|disk\|cd\|track\|episode\|ep\|volume\|vol\|book\|session\)[^a-z]*\([ivxlc]\{1,7\}\)\b.*/\2/p' | head -n 1)"
  if [[ -n "$roman" ]]; then
    n="$(roman_to_num "$roman")"
    if [[ -n "$n" ]]; then
      printf '1%04d00' "$n"
      return 0
    fi
  fi

  # Pattern 5: written-out number ("One") or keyword + written-out number ("Chapter Two")
  n="$(word_to_num "$lc")"
  if [[ -z "$n" ]]; then
    local word=""
    word="$(echo "$lc" | sed -n -E 's/.*\b(part|chapter|ch|disc|disk|cd|track|episode|ep|volume|vol|book|session)[[:space:]_-]+([a-z]+)\b.*/\2/p' | head -n 1)"
    [[ -n "$word" ]] && n="$(word_to_num "$word")"
  fi
  if [[ -n "$n" ]]; then
    printf '1%04d00' "$n"
    return 0
  fi

  # Pattern 6: trailing number with only whitespace before it ("Title 01")
  n="$(echo "$lc" | sed -n -E 's/.*[[:space:]]0*([0-9]{1,4})$/\1/p' | head -n 1)"
  if [[ -n "$n" && "$n" -le 999 ]]; then
    printf '1%04d00' "$n"
    return 0
  fi

  echo ""
}

# Combine a file's disc-folder number (if any) with its chapter order key into
# a single 10-digit, zero-padded, lexically-sortable string. Empty if unclear.
compute_sort_key() {
  local filepath="$1" book_dir="$2"
  local parent_dir parent_base disc=0 d chapkey base
  parent_dir="$(dirname "$filepath")"
  if [[ "$parent_dir" != "$book_dir" ]]; then
    parent_base="$(basename "$parent_dir")"
    d="$(disc_number_for_dir "$parent_base")"
    [[ -n "$d" ]] && disc=$((10#$d))
  fi
  base="$(basename "$filepath")"
  base="${base%.*}"
  chapkey="$(extract_order_key "$base")"
  [[ -z "$chapkey" ]] && return 1
  printf '%03d%s' "$disc" "$chapkey"
}

# Gather audio files of a given extension directly under book_dir, plus any
# files one level down inside "Disc N"/"Disk N"/"CD N" subfolders.
gather_audio_files() {
  local book_dir="$1" ext="$2"
  find "$book_dir" -maxdepth 1 -type f ! -name "._*" ! -name ".DS_Store" -iname "*.${ext}" -print0 2>/dev/null

  local discdir discbase
  while IFS= read -r -d '' discdir; do
    discbase="$(basename "$discdir")"
    if [[ -n "$(disc_number_for_dir "$discbase")" ]]; then
      find "$discdir" -maxdepth 1 -type f ! -name "._*" ! -name ".DS_Store" -iname "*.${ext}" -print0 2>/dev/null
    fi
  done < <(find "$book_dir" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)
}

# Move source files (top-level and any Disc N/ subfolders) into the backup dir.
# Files coming from a disc subfolder are prefixed with that folder's name to
# avoid collisions (e.g. two discs both having a "01 Title.mp3").
move_to_backup() {
  local book_dir="$1" ext="$2" backup_dir="$3"
  find "$book_dir" -maxdepth 1 -type f ! -name "._*" ! -name ".DS_Store" -iname "*.${ext}" -print0 2>/dev/null \
    | xargs -0 -I{} mv -f "{}" "${backup_dir}/"

  local discdir discbase f
  while IFS= read -r -d '' discdir; do
    discbase="$(basename "$discdir")"
    if [[ -n "$(disc_number_for_dir "$discbase")" ]]; then
      while IFS= read -r -d '' f; do
        mv -f "$f" "${backup_dir}/${discbase} - $(basename "$f")"
      done < <(find "$discdir" -maxdepth 1 -type f ! -name "._*" ! -name ".DS_Store" -iname "*.${ext}" -print0 2>/dev/null)
    fi
  done < <(find "$book_dir" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)
}

# Given book_dir and a list of files, print them NUL-separated in merge order
# (by compute_sort_key). Files whose key can't be determined keep their
# original relative order and sort last.
sorted_files_for_book() {
  local book_dir="$1"; shift
  local -a files=("$@")
  local -a lines=()
  local i n=${#files[@]} key
  for (( i = 0; i < n; i++ )); do
    key="$(compute_sort_key "${files[i]}" "$book_dir")"
    [[ -z "$key" ]] && key="9999999999"
    lines+=("${key} ${i}")
  done
  local sorted_idx idx
  sorted_idx="$(printf '%s\n' "${lines[@]}" | sort | awk '{print $2}')"
  while IFS= read -r idx; do
    printf '%s\0' "${files[idx]}"
  done <<< "$sorted_idx"
}

# Log the resolved merge order so DRY_RUN output can be visually verified.
log_planned_order() {
  local -a files=("$@")
  local i=1 f
  log "PLANNED ORDER:"
  for f in "${files[@]}"; do
    log "  $(printf '%2d' "$i")) $(basename "$f")"
    i=$((i + 1))
  done
}
order_is_clear() {
  local book_dir="$1"; shift
  local -a files=("$@")
  local n="${#files[@]}"

  # 0/1 file is always clear
  if (( n <= 1 )); then
    return 0
  fi

  local -a keys=()
  local f k
  for f in "${files[@]}"; do
    k="$(compute_sort_key "$f" "$book_dir")"
    if [[ -z "$k" ]]; then
      return 1
    fi
    keys+=("$k")
  done

  # keys must be well-formed (10-digit, zero-padded disc+type+chapter+subletter)
  local x
  for x in "${keys[@]}"; do
    [[ "$x" =~ ^[0-9]{10}$ ]] || return 1
  done

  # uniqueness: no two files may resolve to the same slot
  # (This avoids "cbx/xdr/wor" and avoids guessing when numbering is weird.)
  local uniq_count
  uniq_count="$(printf "%s\n" "${keys[@]}" | sort | uniq | wc -l | tr -d ' ')"
  (( uniq_count == n )) || return 1

  return 0
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
  local warnings_count="${8:-0}"  # integer
  local warnings_json="${9:-""}"  # json array string like: [{"code":"..."}]
  local reason="${10:-""}"        # optional string

  # Parse BITRATE like "96k" → 96 (best effort)
  local bitrate_num
  bitrate_num="$(echo "${BITRATE}" | sed 's/[^0-9]//g')"
  [[ -z "${bitrate_num}" ]] && bitrate_num=0

  # Build compact JSON (no pretty-print, must be single line)
  # warnings_json must be a valid JSON array (or empty string to omit)
  local wfrag=""
  if [[ -n "${warnings_json}" ]]; then
    wfrag=",\"warnings_count\":${warnings_count},\"warnings\":${warnings_json}"
  fi

  if [[ -n "${reason}" ]]; then
    echo "__M4B_SUMMARY_JSON__ {\"mode\":\"${MODE}\",\"dry_run\":${DRY_RUN},\"success\":${success},\"runtime_s\":${runtime_s},\"root\":\"${ROOT}\",\"audio_mode\":\"${AUDIO_MODE}\",\"bitrate_kbps\":${bitrate_num},\"created\":${created},\"skipped\":${skipped},\"failed\":${failed},\"renamed\":${renamed},\"deleted\":${deleted}${wfrag},\"reason\":\"${reason}\"}"
  else
    echo "__M4B_SUMMARY_JSON__ {\"mode\":\"${MODE}\",\"dry_run\":${DRY_RUN},\"success\":${success},\"runtime_s\":${runtime_s},\"root\":\"${ROOT}\",\"audio_mode\":\"${AUDIO_MODE}\",\"bitrate_kbps\":${bitrate_num},\"created\":${created},\"skipped\":${skipped},\"failed\":${failed},\"renamed\":${renamed},\"deleted\":${deleted}${wfrag}}"
  fi
}

# Detect mono vs stereo using ffprobe inside the m4b-tool image
detect_channels() {
  local first_file="$1"

  # DRY_RUN skips probing — default to stereo.
  if is_dry_run; then
    echo "2"
    return 0
  fi

  local ch_str
  ch_str=$(timeout -k 10 "$PROBE_TIMEOUT_SECS" ffmpeg -hide_banner -i "$first_file" 2>&1 | grep "Audio:" | grep -oE 'mono|stereo' | head -1)

  if [[ "$ch_str" == "mono" ]]; then
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


# Detect bitrate (kbps) of a single audio file using ffmpeg
detect_bitrate() {
  local file="$1"
  if is_dry_run; then
    echo "0"
    return 0
  fi
  local info br
  info=$(timeout -k 10 "$PROBE_TIMEOUT_SECS" ffmpeg -hide_banner -i "$file" 2>&1)
  # Try stream-level first (e.g. "Audio: mp3, 44100 Hz, stereo, fltp, 128 kb/s")
  br=$(echo "$info" | grep "Audio:" | grep -oE ', [0-9]+ kb/s' | grep -oE '[0-9]+' | head -1)
  # Fall back to format-level (e.g. "bitrate: 128 kb/s") — reliable for VBR files
  if [[ ! "$br" =~ ^[0-9]+$ ]] || (( br == 0 )); then
    br=$(echo "$info" | grep -oE 'bitrate: [0-9]+ kb/s' | grep -oE '[0-9]+' | head -1)
  fi
  if [[ "$br" =~ ^[0-9]+$ ]] && (( br > 0 )); then
    echo "$br"
  else
    echo "0"
  fi
}

# Detect highest bitrate across multiple files
detect_max_bitrate() {
  local max_br=0
  local file br
  for file in "$@"; do
    br=$(detect_bitrate "$file")
    if [[ "$br" =~ ^[0-9]+$ ]] && (( br > max_br )); then
      max_br=$br
    fi
  done
  echo "$max_br"
}

# Resolve bitrate: "match" detects from source, otherwise use fixed value
resolve_bitrate() {
  local bitrate_setting="$1"
  shift
  local -a files=("$@")
  if [[ "$bitrate_setting" == "match" ]]; then
    local detected
    detected=$(detect_max_bitrate "${files[@]}")
    if (( detected > 0 )); then
      log "BITRATE: matched source -> ${detected}k" >&2
      echo "${detected}k"
    else
      if is_dry_run; then
        log "BITRATE: dry-run — detection skipped, real run will match source bitrate" >&2
      else
        log "BITRATE: could not detect source, falling back to ${BITRATE_DEFAULT}k" >&2
      fi
      echo "${BITRATE_DEFAULT}k"
    fi
  else
    echo "${bitrate_setting}"
  fi
}

############################################
# Start
############################################
START_EPOCH=$(date +%s)

log "===== START MP3/M4A/M4B → M4B tool ====="
log "MODE=${MODE}"
log "ROOT=${ROOT}"
log "DRY_RUN=${DRY_RUN}"
log "BITRATE=${BITRATE}"
log "AUDIO_MODE=${AUDIO_MODE}"

# Ensure root exists
if [[ ! -d "${ROOT}" ]]; then
  log "ERROR: ROOT does not exist: ${ROOT}"
  END_EPOCH=$(date +%s)
  RUNTIME=$((END_EPOCH - START_EPOCH))
  emit_summary false "${RUNTIME}" 0 0 1 0 0 0 "" "root_missing"
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
  emit_summary false "${RUNTIME}" 0 0 1 0 0 0 "" "already_running"
  exit 1
fi

# Cancel: exit immediately on SIGINT/SIGTERM (releases lock)
on_cancel() {
  log "CANCEL: signal received, exiting."
  END_EPOCH=$(date +%s)
  RUNTIME=$((END_EPOCH - START_EPOCH))
  emit_summary false "${RUNTIME}" 0 0 1 0 0 0 "" "canceled"
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
    emit_summary true "${RUNTIME}" 0 0 0 0 0 0 ""
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
  emit_summary true "${RUNTIME}" 0 0 0 0 "${deleted_count}" 0 ""
  exit 0
fi

############################################
# CORRECT MODE: rename .m4b to Book - Author.m4b
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

    mapfile -d '' -t m4bs < <(find "$book_dir" -maxdepth 1 -type f ! -name "._*" ! -name ".DS_Store" -iname "*.m4b" -print0 2>/dev/null || true)
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

  emit_summary true "${RUNTIME}" 0 0 0 "${renamed_count}" 0 0 ""
  exit 0
fi

############################################
# CONVERT MODE
############################################
log "MODE=convert: converting + backing up sources → _backup_files/"
log "Policy:"
log " - MP3s merged → re-encoded @ ${BITRATE}"
log " - M4As: single file remux (stream copy), multi-file merge @ ${BITRATE}"
log " - M4Bs: multi-file merge (no re-encode) when part order is clear"
log "Safety: If multi-file order isn't clear, the book is skipped with a warning (does not stop the batch)."

created_count=0
skipped_count=0
failed_count=0

warnings_count=0
declare -a warnings_json_items=()
declare -a order_unclear_books=()   # "Author / Book" list for footer
declare -a failed_books=()
declare -a created_files=()

# Common warning helper
warn_order_unclear() {
  local book_dir="$1"
  local parts="$2"   # number of parts
  local lbl
  lbl="$(book_label "$book_dir")"
  log "WARN: ORDER_UNCLEAR: BOOK=${lbl#* / } PATH=${book_dir} (parts=${parts})"
  log "WARN: ORDER_UNCLEAR: Skipping merge. Rename parts with numeric prefixes (01, 02, 03...) then re-run."

  warnings_count=$((warnings_count + 1))
  order_unclear_books+=("$lbl")

  # JSON warning object
  local book_name author_name msg
  author_name="${lbl%% / *}"
  book_name="${lbl#* / }"
  msg="Part order not clear. Rename parts with numeric prefixes (01, 02, 03...) then re-run."

  warnings_json_items+=("{\"code\":\"order_unclear\",\"book\":\"$(json_escape "$book_name")\",\"path\":\"$(json_escape "$book_dir")\",\"message\":\"$(json_escape "$msg")\"}")
}

warn_timeout() {
  local book_dir="$1" step="$2" secs="$3"
  local lbl book_name
  lbl="$(book_label "$book_dir")"
  book_name="${lbl#* / }"
  log "WARN: TIMEOUT: BOOK=${book_name} — ${step} exceeded ${secs}s and was killed."
  log "WARN: TIMEOUT: Skipping book. The source file(s) may be corrupt or malformed."

  warnings_count=$((warnings_count + 1))

  local msg
  msg="${step} exceeded the ${secs}s timeout and was killed. Source file(s) may be corrupt or malformed."
  warnings_json_items+=("{\"code\":\"timeout\",\"book\":\"$(json_escape "$book_name")\",\"path\":\"$(json_escape "$book_dir")\",\"message\":\"$(json_escape "$msg")\"}")
}

# Exit codes that mean "timeout killed it" for both BusyBox timeout (which
# exits with 128+signal, i.e. 143 for TERM or 137 for the KILL escalation)
# and GNU coreutils timeout (which exits 124).
is_timeout_exit_code() {
  local rc="$1"
  [[ "$rc" == "124" || "$rc" == "137" || "$rc" == "143" ]]
}
warn_gaps() {
  local book_dir="$1"
  shift
  local -a files=("$@")
  if (( ${#files[@]} <= 1 )); then return 0; fi

  # Group numbered-chapter keys by disc (first 3 digits of the sort key).
  # Front matter (type digit 0) and ACX sub-letters are excluded/collapsed:
  # gaps are only meaningful across distinct chapter numbers, per disc.
  local f k disc chapter
  local -A chapters_by_disc=()
  for f in "${files[@]}"; do
    k="$(compute_sort_key "$f" "$book_dir")"
    [[ -z "$k" ]] && continue
    [[ "${k:3:1}" == "1" ]] || continue
    disc="${k:0:3}"
    chapter="$((10#${k:4:4}))"
    chapters_by_disc["$disc"]+="${chapter}"$'\n'
  done

  local lbl book_name
  lbl="$(book_label "$book_dir")"
  book_name="${lbl#* / }"

  local disc_key
  for disc_key in "${!chapters_by_disc[@]}"; do
    local -a uniq_chs
    mapfile -t uniq_chs < <(printf '%s' "${chapters_by_disc[$disc_key]}" | sort -n -u)
    (( ${#uniq_chs[@]} <= 1 )) && continue

    local min max expected actual missing_list="" disc_num disc_note=""
    min="${uniq_chs[0]}"
    max="${uniq_chs[-1]}"
    expected=$(( max - min + 1 ))
    actual="${#uniq_chs[@]}"
    disc_num=$((10#$disc_key))
    (( disc_num > 0 )) && disc_note=" (Disc ${disc_num})"
    if (( actual < expected )); then
      local i
      for (( i = min; i <= max; i++ )); do
        if ! printf "%s\n" "${uniq_chs[@]}" | grep -qx "$i"; then
          missing_list="${missing_list:+${missing_list}, }${i}"
        fi
      done
      log "WARN: GAPS_DETECTED: BOOK=${book_name}${disc_note} — expected ${expected} files (${min}–${max}), found ${actual}. Missing: ${missing_list}"
      warnings_count=$((warnings_count + 1))
      local msg
      msg="Possible missing files${disc_note} (${min}–${max}, found ${actual}). Missing: ${missing_list}"
      warnings_json_items+=("{\"code\":\"gaps_detected\",\"book\":\"$(json_escape "$book_name")\",\"path\":\"$(json_escape "$book_dir")\",\"message\":\"$(json_escape "$msg")\"}")
    fi
  done
}

while IFS= read -r -d '' book_dir; do
  author_dir="$(dirname "$book_dir")"
  author="$(basename "$author_dir")"
  book="$(basename "$book_dir")"

  [[ "$author" == "#recycle" ]] && continue

  # Gather source candidates
  mapfile -d '' -t mp3s < <(gather_audio_files "$book_dir" "mp3" || true)
  mapfile -d '' -t m4as < <(gather_audio_files "$book_dir" "m4a" || true)

  # For m4b parts: EXCLUDE temp files
  mapfile -d '' -t m4bs < <(find "$book_dir" -maxdepth 1 -type f ! -name "._*" ! -name ".DS_Store" -iname "*.m4b" ! -iname ".tmp_*.m4b" ! -iname "tmp_*.m4b" -print0 2>/dev/null || true)

  mp3_count=${#mp3s[@]}
  m4a_count=${#m4as[@]}
  m4b_count=${#m4bs[@]}

  # Determine if this folder is "already done":
  # - if it contains exactly ONE real .m4b and no mp3/m4a, we skip as already converted.
  # - if it contains MULTIPLE .m4b, we treat as a merge candidate (new feature).
  if (( m4b_count == 1 )) && (( mp3_count == 0 )) && (( m4a_count == 0 )); then
    log "SKIP (already has single m4b): ${book_dir}"
    skipped_count=$((skipped_count + 1))
    continue
  fi

  # If nothing usable, ignore silently
  if (( mp3_count == 0 )) && (( m4a_count == 0 )) && (( m4b_count == 0 )); then
    continue
  fi

  # If MP3 + M4A coexist, MP3 wins (as before)
  if (( mp3_count > 0 )) && (( m4a_count > 0 )); then
    log "INFO: Both MP3 and M4A found, using MP3s only → ${book_dir}"
  fi

  out_name="${book} - ${author}.m4b"
  out_path="${book_dir}/${out_name}"
  tmp_stem="$(safe_name "$book")"
  tmp_path="${book_dir}/.tmp_${tmp_stem}.m4b"
  rm -f "${tmp_path}" >/dev/null 2>&1 || true

  # If final output exists for some reason, skip
  if [[ -f "${out_path}" ]]; then
    log "WARN: Unexpected existing output .m4b, skipping: ${out_path}"
    skipped_count=$((skipped_count + 1))
    continue
  fi

  log "----------------------------------------"
  log "AUTHOR: ${author}"
  log "BOOK:   ${book}"
  log "PATH:   ${book_dir}"
  log "MP3s:   ${mp3_count}"
  log "M4As:   ${m4a_count}"
  log "M4Bs:   ${m4b_count}"

  ##########################################
  # Branch 1: MP3 → M4B
  ##########################################
  if (( mp3_count > 0 )); then
    # Safety: if multiple MP3s and order unclear, warn + fail this book only
    if (( mp3_count > 1 )); then
      if ! order_is_clear "$book_dir" "${mp3s[@]}"; then
        warn_order_unclear "$book_dir" "$mp3_count"
        failed_count=$((failed_count + 1))
        failed_books+=("${book_dir}")
        continue
      fi
    fi
      warn_gaps "$book_dir" "${mp3s[@]}"

    mapfile -d '' -t sorted_mp3s < <(sorted_files_for_book "$book_dir" "${mp3s[@]}")

    first_mp3="${sorted_mp3s[0]}"
    detected="$(detect_channels "$first_mp3")"
    channels="$(resolve_channels "$detected")"

    [[ "$channels" == "1" ]] && mode_desc="mono" || mode_desc="stereo"
    log "MODE:   MP3 merge (${mode_desc} @ ${BITRATE})"
    log "OUTPUT: ${out_path}"
    (( mp3_count > 1 )) && log_planned_order "${sorted_mp3s[@]}"

    effective_bitrate=$(resolve_bitrate "${BITRATE}" "${mp3s[@]}")
    audio_args=(--audio-bitrate="${effective_bitrate}" --audio-channels="${channels}")

    if is_dry_run; then
      log "[DRY-RUN] m4b-tool merge ${sorted_mp3s[*]@Q} --output-file \"${tmp_path}\" ${audio_args[*]}"
      created_count=$((created_count + 1))
      created_files+=("${out_path} (DRY-RUN, from MP3)")
      continue
    fi

    timeout -k 30 "$CONVERT_TIMEOUT_SECS" m4b-tool merge "${sorted_mp3s[@]}" --output-file "${tmp_path}" "${audio_args[@]}"
    rc=$?
    if (( rc != 0 )); then
      if is_timeout_exit_code "$rc"; then
        warn_timeout "$book_dir" "m4b-tool merge (MP3)" "$CONVERT_TIMEOUT_SECS"
      else
        log "ERROR: m4b-tool merge (MP3) failed for: ${book_dir}"
      fi
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
      move_to_backup "${book_dir}" "mp3" "${backup_dir}"
    fi
    log "MP3s moved to: ${backup_dir}/"

    continue
  fi

  ##########################################
  # Branch 2: M4A → M4B
  ##########################################
  if (( m4a_count > 0 )); then
    if (( m4a_count == 1 )); then
      in_file="${m4as[0]}"
      log "MODE:   Single M4A (remux, stream copy)"
      log "INPUT:  ${in_file}"
      log "OUTPUT: ${out_path}"

      if is_dry_run; then
        log "[DRY-RUN] ffmpeg -i \"${in_file}\" -map 0:a -c copy -max_muxing_queue_size 9999 -movflags +faststart \"${tmp_path}\""
        created_count=$((created_count + 1))
        created_files+=("${out_path} (DRY-RUN, from single M4A)")
        continue
      fi

      timeout -k 30 "$CONVERT_TIMEOUT_SECS" ffmpeg -v error -stats -i "${in_file}" -map 0:a -c copy -max_muxing_queue_size 9999 -movflags +faststart "${tmp_path}"
      rc=$?
      if (( rc != 0 )); then
        if is_timeout_exit_code "$rc"; then
          warn_timeout "$book_dir" "ffmpeg remux (M4A)" "$CONVERT_TIMEOUT_SECS"
        else
          log "ERROR: ffmpeg remux (M4A) failed for: ${book_dir}"
        fi
        failed_count=$((failed_count + 1))
        failed_books+=("${book_dir}")
        rm -f "${tmp_path}" >/dev/null 2>&1 || true
        continue
      fi

    else
      # Safety: multi-M4A order must be clear
      if ! order_is_clear "$book_dir" "${m4as[@]}"; then
        warn_order_unclear "$book_dir" "$m4a_count"
        failed_count=$((failed_count + 1))
        failed_books+=("${book_dir}")
        continue
      fi
      warn_gaps "$book_dir" "${m4as[@]}"

      mapfile -d '' -t sorted_m4as < <(sorted_files_for_book "$book_dir" "${m4as[@]}")

      first_m4a="${sorted_m4as[0]}"
      detected="$(detect_channels "$first_m4a")"
      channels="$(resolve_channels "$detected")"

      [[ "$channels" == "1" ]] && mode_desc="mono" || mode_desc="stereo"
      log "MODE:   Multi-M4A merge (${mode_desc} @ ${BITRATE})"
      log "OUTPUT: ${out_path}"
      log_planned_order "${sorted_m4as[@]}"

      effective_bitrate=$(resolve_bitrate "${BITRATE}" "${m4as[@]}")
      audio_args=(--audio-bitrate="${effective_bitrate}" --audio-channels="${channels}")

      if is_dry_run; then
        log "[DRY-RUN] m4b-tool merge ${sorted_m4as[*]@Q} --output-file \"${tmp_path}\" ${audio_args[*]}"
        created_count=$((created_count + 1))
        created_files+=("${out_path} (DRY-RUN, from multi M4A)")
        continue
      fi

      timeout -k 30 "$CONVERT_TIMEOUT_SECS" m4b-tool merge "${sorted_m4as[@]}" --output-file "${tmp_path}" "${audio_args[@]}"
      rc=$?
      if (( rc != 0 )); then
        if is_timeout_exit_code "$rc"; then
          warn_timeout "$book_dir" "m4b-tool merge (M4A)" "$CONVERT_TIMEOUT_SECS"
        else
          log "ERROR: m4b-tool merge (M4A) failed for: ${book_dir}"
        fi
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
      move_to_backup "${book_dir}" "m4a" "${backup_dir}"
    fi
    log "M4As moved to: ${backup_dir}/"

    continue
  fi

  ##########################################
  # Branch 3: Multi-M4B merge → single M4B
  ##########################################
  if (( m4b_count > 1 )); then
    # Safety: multi-M4B order must be clear
    if ! order_is_clear "$book_dir" "${m4bs[@]}"; then
      warn_order_unclear "$book_dir" "$m4b_count"
      failed_count=$((failed_count + 1))
      failed_books+=("${book_dir}")
      continue
    fi

    warn_gaps "$book_dir" "${m4bs[@]}"
    mapfile -d '' -t sorted_m4bs < <(sorted_files_for_book "$book_dir" "${m4bs[@]}")
    log "MODE:   Multi-M4B merge (no re-encode)"
    log "OUTPUT: ${out_path}"
    log_planned_order "${sorted_m4bs[@]}"

    # For M4B inputs, do not pass bitrate/channels (avoid re-encode).
    if is_dry_run; then
      log "[DRY-RUN] m4b-tool merge ${sorted_m4bs[*]@Q} --output-file \"${tmp_path}\""
      created_count=$((created_count + 1))
      created_files+=("${out_path} (DRY-RUN, from multi M4B)")
      continue
    fi

    timeout -k 30 "$CONVERT_TIMEOUT_SECS" m4b-tool merge "${sorted_m4bs[@]}" --output-file "${tmp_path}"
    rc=$?
    if (( rc != 0 )); then
      if is_timeout_exit_code "$rc"; then
        warn_timeout "$book_dir" "m4b-tool merge (M4B)" "$CONVERT_TIMEOUT_SECS"
      else
        log "ERROR: m4b-tool merge (M4B) failed for: ${book_dir}"
      fi
      failed_count=$((failed_count + 1))
      failed_books+=("${book_dir}")
      rm -f "${tmp_path}" >/dev/null 2>&1 || true
      continue
    fi

    if [[ ! -f "${tmp_path}" ]]; then
      log "ERROR: temp m4b not created (M4B): ${tmp_path}"
      failed_count=$((failed_count + 1))
      failed_books+=("${book_dir}")
      continue
    fi

    size_bytes=$(stat -c%s "${tmp_path}" 2>/dev/null || echo 0)
    if [[ "${size_bytes}" -lt "${MIN_BYTES}" ]]; then
      log "ERROR: temp m4b too small (${size_bytes} bytes, M4B). Keeping source M4Bs. Temp stays: ${tmp_path}"
      failed_count=$((failed_count + 1))
      failed_books+=("${book_dir}")
      continue
    fi

    mv -f "${tmp_path}" "${out_path}"
    log "OK: Created (from multi M4B) ${out_path}"
    created_count=$((created_count + 1))
    created_files+=("${out_path}")

    backup_dir="${book_dir}/_backup_files"
    if is_dry_run; then
      log "[DRY-RUN] mkdir -p \"${backup_dir}\""
      log "[DRY-RUN] move part *.m4b → \"${backup_dir}/\" (excluding output)"
    else
      mkdir -p "${backup_dir}"
      # Move all .m4b except the newly created output file
      find "${book_dir}" -maxdepth 1 -type f ! -name "._*" ! -name ".DS_Store" -iname "*.m4b" ! -iname "$(basename "$out_path")" -print0 \
        | xargs -0 -I{} mv -f "{}" "${backup_dir}/"
    fi
    log "M4B parts moved to: ${backup_dir}/"

    continue
  fi

  # If we get here and there is exactly 1 m4b but also other files, or odd cases:
  # safest is to skip (we don't want to overwrite or double-handle)
  log "SKIP (unsupported mix or already has m4b parts state): ${book_dir}"
  skipped_count=$((skipped_count + 1))

done < <(find "${ROOT}" -mindepth 2 -maxdepth 2 -type d -print0 2>/dev/null)

END_EPOCH=$(date +%s)
RUNTIME=$((END_EPOCH - START_EPOCH))

log "===== CONVERT MODE SUMMARY ====="
log "Runtime      : ${RUNTIME}s"
log "Created M4Bs : ${created_count}"
log "Skipped books: ${skipped_count}"
log "Failed books : ${failed_count}"
log "Warnings     : ${warnings_count}"

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

# Human-friendly warning footer (so History is instantly useful)
if (( warnings_count > 0 )); then
  log "=================================================="
  log "SUMMARY: WARNINGS"
  log "=================================================="
  log "Failed: ${failed_count}"
  log ""
  log "Order of book files unclear."
  log "These books were skipped to avoid incorrect chapter order."
  log "Please rename files with numeric prefixes (01, 02, 03...) and re-run."
  log ""
  log "Affected books:"
  # de-dupe just in case
  printf "%s\n" "${order_unclear_books[@]}" | awk '!seen[$0]++' | while IFS= read -r lbl; do
    [ -n "$lbl" ] && log " - ${lbl}"
  done
  log "=================================================="
fi

log "===== END CONVERT MODE ====="

# Build warnings JSON array (if any)
warnings_json=""
if (( warnings_count > 0 )); then
  # join with commas
  warnings_json="[$(IFS=,; echo "${warnings_json_items[*]}")]"
fi

if [[ "${failed_count}" -eq 0 ]]; then
  emit_summary true "${RUNTIME}" "${created_count}" "${skipped_count}" "${failed_count}" 0 0 "${warnings_count}" "${warnings_json}"
else
  emit_summary false "${RUNTIME}" "${created_count}" "${skipped_count}" "${failed_count}" 0 0 "${warnings_count}" "${warnings_json}"
fi