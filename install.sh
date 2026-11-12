#!/usr/bin/env bash
# Install these customizations into the active omp agent directory.
set -euo pipefail

AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$AGENT_DIR/extensions" "$AGENT_DIR/skills"

for file in config.yml models.yml; do
	if [ -f "$AGENT_DIR/$file" ]; then
		backup="$AGENT_DIR/$file.bak.$(date +%Y%m%d%H%M%S)"
		cp "$AGENT_DIR/$file" "$backup"
		echo "backed up existing $file -> $backup"
	fi
done

cp "$SRC/config/config.yml" "$AGENT_DIR/config.yml"
cp "$SRC/models/models.yml" "$AGENT_DIR/models.yml"
cp "$SRC"/extensions/*.ts "$AGENT_DIR/extensions/"
cp -r "$SRC"/skills/* "$AGENT_DIR/skills/"

echo "installed into $AGENT_DIR"
echo "restart omp so newly added extension modules are imported"
