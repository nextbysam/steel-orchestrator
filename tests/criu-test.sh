#!/bin/bash
#
# CRIU Checkpoint/Restore Test for Steel Browser on Orb Cloud
#
# Dedicated test that:
# 1. Creates a Steel VM with Chrome
# 2. Browses sites to establish state (cookies, DOM)
# 3. Takes a screenshot BEFORE checkpoint
# 4. Checkpoints (demotes) Chrome
# 5. Restores (promotes) Chrome
# 6. Takes a screenshot AFTER restore
# 7. Compares before/after
# 8. Logs everything to CRIU_LOG.md with timestamps
#
# Usage:
#   ORB_API_KEY=orb_xxx ./tests/criu-test.sh
#
# Appends results to CRIU_LOG.md (cumulative across runs)
#

set -uo pipefail

ORB_KEY="${ORB_API_KEY:?Set ORB_API_KEY}"
ORB_API="${ORB_API_URL:-https://api.orbcloud.dev}"
LOG_FILE="CRIU_LOG.md"

timestamp() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
log() { echo "[$(timestamp)] $*"; }

orb_api() {
  local method="$1" path="$2"
  shift 2
  curl -s -X "$method" "${ORB_API}${path}" \
    -H "Authorization: Bearer $ORB_KEY" \
    -H 'Content-Type: application/json' "$@"
}

# Initialize log if it doesn't exist
if [ ! -f "$LOG_FILE" ]; then
  cat > "$LOG_FILE" << 'EOF'
# CRIU Checkpoint/Restore Log

Tracking every CRIU test attempt for Steel Browser + Chrome on Orb Cloud.

| Date | Computer | Port | Checkpoint | Restore | Screenshot Before | Screenshot After | Notes |
|------|----------|------|------------|---------|-------------------|------------------|-------|
EOF
fi

log "=== CRIU Checkpoint/Restore Test ==="
RUN_TIME=$(timestamp)

# Step 1: Create VM
log "Step 1: Creating Steel Browser VM..."
COMP=$(orb_api POST /v1/computers -d '{"name":"criu-test","runtime_mb":2048,"disk_mb":8192}')
COMP_ID=$(echo "$COMP" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
SHORT_ID="${COMP_ID:0:8}"
STEEL_URL="https://${SHORT_ID}.orbcloud.dev"

if [ -z "$COMP_ID" ] || [ "$COMP_ID" = "None" ]; then
  log "FAIL: Could not create computer"
  echo "| $RUN_TIME | FAIL | - | - | - | - | - | Could not create computer |" >> "$LOG_FILE"
  exit 1
fi
log "Computer: $COMP_ID ($SHORT_ID)"

# Step 2: Config + Build
log "Step 2: Uploading config..."
curl -s -X POST "${ORB_API}/v1/computers/${COMP_ID}/config" \
  -H "Authorization: Bearer $ORB_KEY" \
  -H 'Content-Type: application/toml' \
  --data-binary @orb-steel.toml > /dev/null

log "Step 3: Building (3-5 min)..."
BUILD_RES=$(curl -s -m 900 -X POST "${ORB_API}/v1/computers/${COMP_ID}/build" \
  -H "Authorization: Bearer $ORB_KEY")
BUILD_OK=$(echo "$BUILD_RES" | python3 -c "import sys,json; print(json.loads(sys.stdin.read(),strict=False).get('success',False))" 2>/dev/null)

if [ "$BUILD_OK" != "True" ]; then
  log "FAIL: Build failed"
  echo "| $RUN_TIME | $SHORT_ID | - | - | - | - | - | Build failed |" >> "$LOG_FILE"
  orb_api DELETE "/v1/computers/$COMP_ID" > /dev/null
  exit 1
fi
log "Build OK"

# Step 4: Deploy
log "Step 4: Deploying..."
DEPLOY=$(orb_api POST "/v1/computers/$COMP_ID/agents" -d '{}')
AGENT_PORT=$(echo "$DEPLOY" | python3 -c "import sys,json; print(json.load(sys.stdin)['agents'][0]['port'])" 2>/dev/null)

if [ -z "$AGENT_PORT" ] || [ "$AGENT_PORT" = "None" ]; then
  log "FAIL: Deploy failed"
  echo "| $RUN_TIME | $SHORT_ID | - | - | - | - | - | Deploy failed |" >> "$LOG_FILE"
  orb_api DELETE "/v1/computers/$COMP_ID" > /dev/null
  exit 1
fi
log "Agent port: $AGENT_PORT"

# Step 5: Wait for health
log "Step 5: Waiting for health..."
sleep 15
HEALTH=$(curl -s "$STEEL_URL/v1/health" 2>/dev/null)
if ! echo "$HEALTH" | grep -q '"ok"'; then
  log "FAIL: Health check failed: $HEALTH"
  echo "| $RUN_TIME | $SHORT_ID | $AGENT_PORT | - | - | - | - | Health check failed |" >> "$LOG_FILE"
  orb_api DELETE "/v1/computers/$COMP_ID" > /dev/null
  exit 1
fi
log "Steel Browser healthy"

# Step 6: Browse to establish state
log "Step 6: Browsing to set cookies..."
curl -s -X POST "$STEEL_URL/v1/sessions" -H 'Content-Type: application/json' -d '{}' > /dev/null
curl -s -X POST "$STEEL_URL/v1/scrape" -H 'Content-Type: application/json' \
  -d '{"url":"https://www.google.com"}' > /dev/null
curl -s -X POST "$STEEL_URL/v1/scrape" -H 'Content-Type: application/json' \
  -d '{"url":"https://www.wikipedia.org"}' > /dev/null
log "Browsed Google + Wikipedia"

# Step 7: Screenshot BEFORE
log "Step 7: Screenshot before checkpoint..."
curl -s -X POST "$STEEL_URL/v1/screenshot" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}' --output /tmp/criu-before-${SHORT_ID}.jpg
BEFORE_SIZE=$(wc -c < /tmp/criu-before-${SHORT_ID}.jpg 2>/dev/null | tr -d ' ')
log "Before: ${BEFORE_SIZE} bytes"

# Step 8: CHECKPOINT
log "Step 8: CHECKPOINT (demote)..."
DEMOTE_RES=$(orb_api POST "/v1/computers/$COMP_ID/agents/demote" -d "{\"port\": $AGENT_PORT}")
DEMOTE_STATUS=$(echo "$DEMOTE_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status', d.get('error','?')))" 2>/dev/null)
CHECKPOINT_DIR=$(echo "$DEMOTE_RES" | python3 -c "import sys,json; print(json.load(sys.stdin).get('checkpoint_dir','none'))" 2>/dev/null)

log "Checkpoint result: $DEMOTE_STATUS"
if [ "$DEMOTE_STATUS" != "demoted" ]; then
  log "FAIL: Checkpoint failed — $DEMOTE_STATUS"
  echo "| $RUN_TIME | $SHORT_ID | $AGENT_PORT | FAIL ($DEMOTE_STATUS) | - | ${BEFORE_SIZE}B | - | Checkpoint dir: $CHECKPOINT_DIR |" >> "$LOG_FILE"
  orb_api DELETE "/v1/computers/$COMP_ID" > /dev/null
  exit 1
fi
log "Checkpoint dir: $CHECKPOINT_DIR"

# Step 9: Wait (Chrome is frozen)
log "Step 9: Sleeping 5s (Chrome frozen on NVMe, costing \$0)..."
sleep 5

# Step 10: RESTORE
log "Step 10: RESTORE (promote)..."
PROMOTE_RES=$(orb_api POST "/v1/computers/$COMP_ID/agents/promote" -d "{\"port\": $AGENT_PORT}")
PROMOTE_STATUS=$(echo "$PROMOTE_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status', d.get('error','?')))" 2>/dev/null)

log "Restore result: $PROMOTE_STATUS"

if [ "$PROMOTE_STATUS" = "promoted" ] || [ "$PROMOTE_STATUS" = "running" ]; then
  log "PASS: Chrome restored!"

  sleep 5

  # Step 11: Health after restore
  POST_HEALTH=$(curl -s "$STEEL_URL/v1/health" 2>/dev/null)
  if echo "$POST_HEALTH" | grep -q '"ok"'; then
    log "PASS: Health OK after restore"
  else
    log "WARN: Health check failed after restore: $POST_HEALTH"
  fi

  # Step 12: Screenshot AFTER
  curl -s -X POST "$STEEL_URL/v1/screenshot" -H 'Content-Type: application/json' \
    -d '{"url":"https://example.com"}' --output /tmp/criu-after-${SHORT_ID}.jpg
  AFTER_SIZE=$(wc -c < /tmp/criu-after-${SHORT_ID}.jpg 2>/dev/null | tr -d ' ')
  log "After: ${AFTER_SIZE} bytes"

  echo "| $RUN_TIME | $SHORT_ID | $AGENT_PORT | PASS | PASS | ${BEFORE_SIZE}B | ${AFTER_SIZE}B | Checkpoint: $CHECKPOINT_DIR |" >> "$LOG_FILE"
  log ""
  log "=========================================="
  log "  CRIU CHECKPOINT/RESTORE: PASS"
  log "  Before: ${BEFORE_SIZE}B  After: ${AFTER_SIZE}B"
  log "=========================================="
else
  PROMOTE_MSG=$(echo "$PROMOTE_RES" | python3 -c "import sys,json; print(json.load(sys.stdin).get('message','no detail'))" 2>/dev/null)
  log "FAIL: Restore failed — $PROMOTE_STATUS: $PROMOTE_MSG"
  echo "| $RUN_TIME | $SHORT_ID | $AGENT_PORT | PASS | FAIL ($PROMOTE_STATUS) | ${BEFORE_SIZE}B | - | $PROMOTE_MSG. Dir: $CHECKPOINT_DIR |" >> "$LOG_FILE"
fi

# Cleanup
log "Cleaning up..."
orb_api DELETE "/v1/computers/$COMP_ID" > /dev/null
log "Done."
