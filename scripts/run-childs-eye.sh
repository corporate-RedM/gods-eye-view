#!/usr/bin/env bash
set -euo pipefail
eye_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="/home/bk/.nvm/versions/node/v24.21.0/bin:$PATH"
cd "$eye_root"
exec node node_modules/vite/bin/vite.js --host 127.0.0.1 --port "${PORT:-4173}" --strictPort
