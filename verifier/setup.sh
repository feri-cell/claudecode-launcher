#!/usr/bin/env bash
# One-shot setup for the MSC EDGAR SMTP verifier on a fresh Ubuntu/Debian box.
# Run as root (or with sudo) on a host where OUTBOUND PORT 25 IS OPEN.
#
#   curl -fsSL <raw-url>/verifier/setup.sh | sudo VERIFY_TOKEN=xxxx bash
# or, after cloning the repo:
#   sudo VERIFY_TOKEN=xxxx bash verifier/setup.sh
#
# Required env:  VERIFY_TOKEN   (the secret set on the Worker)
# Optional env:  API_BASE       (default https://msc-edgar.feri-0df.workers.dev)
#                MAIL_FROM       (default outreach@manhattanstreetcapital.com)
set -euo pipefail

API_BASE="${API_BASE:-https://msc-edgar.feri-0df.workers.dev}"
MAIL_FROM="${MAIL_FROM:-outreach@manhattanstreetcapital.com}"
: "${VERIFY_TOKEN:?Set VERIFY_TOKEN=... (the Worker secret) before running}"

echo "==> Installing Node.js 20 (if missing)"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node --version

echo "==> Placing verify.mjs in /opt/msc/verifier"
mkdir -p /opt/msc/verifier
# If this script sits next to verify.mjs (cloned repo), copy it; otherwise the
# operator should scp verify.mjs into /opt/msc/verifier first.
SRC="$(dirname "$(readlink -f "$0")")/verify.mjs"
if [ -f "$SRC" ]; then cp "$SRC" /opt/msc/verifier/verify.mjs; fi
test -f /opt/msc/verifier/verify.mjs || { echo "!! /opt/msc/verifier/verify.mjs missing — copy it there, then re-run"; exit 1; }

echo "==> Pre-flight: is outbound port 25 open? (probing gmail MX)"
if ! timeout 25 node /opt/msc/verifier/verify.mjs --probe deliverability-test@gmail.com; then
  echo "!! Port 25 appears BLOCKED on this host. Get it unblocked (provider ticket) before continuing."
  echo "   The service will be installed but won't be able to verify until 25 is open."
fi

echo "==> Writing systemd unit"
cat >/etc/systemd/system/msc-verifier.service <<UNIT
[Unit]
Description=MSC EDGAR SMTP verifier
After=network-online.target
Wants=network-online.target

[Service]
Environment=API_BASE=${API_BASE}
Environment=VERIFY_TOKEN=${VERIFY_TOKEN}
Environment=MAIL_FROM=${MAIL_FROM}
ExecStart=/usr/bin/node /opt/msc/verifier/verify.mjs --watch
Restart=always
RestartSec=30
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT

echo "==> Enabling + starting service"
systemctl daemon-reload
systemctl enable --now msc-verifier
sleep 2
systemctl --no-pager --full status msc-verifier | head -n 12 || true

echo
echo "Done. Follow the log with:  journalctl -u msc-verifier -f"
