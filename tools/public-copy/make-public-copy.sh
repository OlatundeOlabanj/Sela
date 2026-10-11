#!/usr/bin/env bash
# Builds a clean copy of Sela for the public submission repo: current files
# only, no git history, with the public README swapped in, then scans it
# for anything that looks like a key before you publish.
#
# Run from inside the private repo after pulling the latest main:
#   git pull && bash tools/public-copy/make-public-copy.sh ../sela-public
#
# Made by TJS Code
set -euo pipefail

OUT="${1:-../sela-public}"
cd "$(git rev-parse --show-toplevel)"

rm -rf "$OUT"
mkdir -p "$OUT"
git archive HEAD | tar -x -C "$OUT"
cp tools/public-copy/README.public.md "$OUT/README.md"
rm -rf "$OUT/tools/public-copy"

cat > "$OUT/.env.example" << 'ENVEOF'
# Copy to .env and fill in only what you need. Never commit a real .env.
RPC_HTTP_URL=
RPC_REGION_LABEL=
DEVNET_RPC_URL=
ACTIVITY_SOURCE=mock
SOLAMI_API_KEY=
GROQ_API_KEY=
KEEPER_KEYPAIR_JSON=
ENVEOF

echo "Scanning $OUT for secrets..."
HITS=0
scan() {
  if grep -rInE "$1" "$OUT" --exclude-dir=node_modules --exclude-dir=.git --exclude=package-lock.json --exclude=make-public-copy.sh | cut -c1-140; then
    HITS=1
  fi
}
scan 'github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}'
scan 'gsk_[A-Za-z0-9]{20,}|sk_[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}'
scan 'api_?key=[A-Za-z0-9]{16,}'
scan '\[( ?[0-9]{1,3},){60,}'
if find "$OUT" -name ".env" -o -name "keypair*.json" -o -name "id.json" -o -name "*.pem" | grep -q .; then
  echo "Sensitive looking files found:"; find "$OUT" -name ".env" -o -name "keypair*.json" -o -name "id.json" -o -name "*.pem"; HITS=1
fi

if [ "$HITS" -ne 0 ]; then
  echo "STOP: fix the lines above before publishing."; exit 1
fi
echo "Clean. Next:"
echo "  cd $OUT && git init -b main && git add -A && git commit -m 'Sela'"
echo "  git remote add origin https://github.com/<you>/<new public repo>.git && git push -u origin main"
