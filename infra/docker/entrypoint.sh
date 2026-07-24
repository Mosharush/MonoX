#!/bin/sh

set -eu

case "${MONOX_WORKSPACE:-}" in
  @*/*) ;;
  *)
    echo "MONOX_WORKSPACE must be a scoped workspace name" >&2
    exit 64
    ;;
esac

case "${MONOX_START_SCRIPT:-}" in
  ''|*[!A-Za-z0-9:_-]*)
    echo "MONOX_START_SCRIPT contains unsupported characters" >&2
    exit 64
    ;;
esac

exec yarn workspace "${MONOX_WORKSPACE}" "${MONOX_START_SCRIPT}"
