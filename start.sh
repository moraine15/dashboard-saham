#!/usr/bin/env sh
# Start the dashboard on Linux or macOS. The first run creates .venv and installs the requirements.
set -e
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  PY="${PYTHON:-python3}"
  if ! command -v "$PY" >/dev/null 2>&1 || ! "$PY" -c 'import sys; sys.exit(sys.version_info < (3, 11))'; then
    echo "Python 3.11 or newer is required: https://www.python.org/downloads/"
    exit 1
  fi
  echo "Creating the Python environment in .venv ..."
  "$PY" -m venv .venv
fi

.venv/bin/python -m pip install --disable-pip-version-check -q -r requirements.txt
exec .venv/bin/python app.py
