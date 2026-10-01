#!/usr/bin/env bash
# Create repo-local .venv-jczx and install UnityPy + Pillow.
# After this, the viewer auto-discovers the venv — NO BD2_JCZX_PYTHON needed.
# Internet required once for pip install.
set -euo pipefail
cd "$(dirname "$0")"
REPO="$(cd .. && pwd)"
VENV="$REPO/.venv-jczx"
REQ="$(pwd)/_tools/requirements-jczx.txt"

PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
done
if [[ -z "$PY" ]]; then
  echo "[ERROR] Python not found. Install Python 3.10+ then re-run." >&2
  exit 1
fi

echo "JCZX setup: creating $VENV (bootstrap: $PY)"
if [[ ! -x "$VENV/bin/python" ]]; then
  "$PY" -m venv "$VENV"
else
  echo "venv already exists, installing / upgrading deps..."
fi

"$VENV/bin/python" -m pip install --upgrade pip
"$VENV/bin/python" -m pip install -r "$REQ"
"$VENV/bin/python" -c 'import UnityPy; print("UnityPy", getattr(UnityPy, "__version__", "ok"))'

echo
echo "Done. Start with: node server.mjs --open  (no BD2_JCZX_PYTHON needed)"
echo "Optional override: export BD2_JCZX_PYTHON=$VENV/bin/python"
