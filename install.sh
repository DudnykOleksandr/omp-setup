#!/usr/bin/env bash
# Install these customizations into the active omp agent directory.
set -euo pipefail

AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$AGENT_DIR/extensions" "$AGENT_DIR/skills"

if [ -f "$AGENT_DIR/config.yml" ]; then
	backup="$AGENT_DIR/config.yml.bak.$(date +%Y%m%d%H%M%S)"
	cp "$AGENT_DIR/config.yml" "$backup"
	echo "backed up existing config -> $backup"
fi

cp "$SRC/config/config.yml" "$AGENT_DIR/config.yml"
cp "$SRC"/extensions/*.ts "$AGENT_DIR/extensions/"
cp -r "$SRC"/skills/* "$AGENT_DIR/skills/"

echo "installed into $AGENT_DIR"
echo "restart omp so newly added extension modules are imported"
