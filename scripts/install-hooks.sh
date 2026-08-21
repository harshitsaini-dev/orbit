#!/bin/sh
# Installs local git hooks. Run once after cloning:  sh scripts/install-hooks.sh
set -e

hook=".git/hooks/commit-msg"
cat > "$hook" <<'HOOK'
#!/bin/sh
# Strip any AI-attribution trailer that slipped into the message.
sed -i.bak -e '/^Co-Authored-By: Claude/d' \
           -e '/^Co-authored-by: Claude/d' \
           -e '/Generated with \[*Claude Code/d' \
           -e '/^🤖 Generated with/d' "$1"
rm -f "$1.bak"
HOOK
chmod +x "$hook"
echo "installed $hook"
