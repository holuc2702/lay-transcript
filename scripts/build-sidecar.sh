#!/usr/bin/env bash
#
# Wrapper cho scripts/build-sidecar.py
#   bash scripts/build-sidecar.sh

set -euo pipefail
cd "$(dirname "$0")/.."
exec python3 scripts/build-sidecar.py "$@"
