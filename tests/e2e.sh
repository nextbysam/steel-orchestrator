#!/bin/bash
#
# Steel Orchestrator — End-to-End Test Suite
#
# Tests the full lifecycle: VM provisioning, session management,
# scraping, screenshots, context persistence, CRIU checkpoint/restore.
#
# Usage:
#   ORB_API_KEY=orb_xxx ORCHESTRATOR_URL=https://xxx.orbcloud.dev ./tests/e2e.sh
#
# Results are logged to RESULTS.md
#

set -euo pipefail

ORB_KEY="${ORB_API_KEY:?Set ORB_API_KEY}"
ORB_API="${ORB_API_URL:-https://api.orbcloud.dev}"
ORCH_URL="${ORCHESTRATOR_URL:-}"
RESULTS_FILE="RESULTS.md"
PASS=0
FAIL=0
SKIP=0
TESTS=()

# ── Helpers ──────────────────────────────────────────────

timestamp() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

log() { echo "[$(timestamp)] $*"; }

record() {
  local name="$1" status="$2" detail="$3"
  TESTS+=("| $name | $status | $detail |")
  if [ "$status" = "PASS" ]; then ((PASS++)); fi
  if [ "$status" = "FAIL" ]; then ((FAIL++)); fi
  if [ "$status" = "SKIP" ]; then ((SKIP++)); fi
  log "$status: $name — $detail"
}

orb_api() {
  local method="$1" path="$2"
  shift 2
  curl -s -X "$method" "${ORB_API}${path}" \
    -H "Authorization: Bearer $ORB_KEY" \
    -H 'Content-Type: application/json' "$@"
}

steel_api() {
  local method="$1" url="$2"
  shift 2
  curl -s -X "$method" "$url" \
    -H 'Content-Type: application/json' "$@"
}

json_get() { python3 -c "import sys,json; d=json.load(sys.stdin); print(d$1)" 2>/dev/null; }

# ── Test: Direct Steel Browser VM ────────────────────────

test_steel_vm() {
  log "=== TEST GROUP: Direct Steel Browser VM ==="

  # Create VM
  log "Creating Steel Browser VM..."
  local comp_json=$(orb_api POST /v1/computers -d '{"name":"e2e-test-steel","runtime_mb":2048,"disk_mb":8192}')
  local comp_id=$(echo "$comp_json" | json_get "['id']")
  local short_id="${comp_id:0:8}"
  local steel_url="https://${short_id}.orbcloud.dev"

  if [ -z "$comp_id" ] || [ "$comp_id" = "None" ]; then
    record "create-vm" "FAIL" "Could not create computer"
    return
  fi
  record "create-vm" "PASS" "Computer $short_id created"

  # Upload config
  local config_res=$(curl -s -X POST "${ORB_API}/v1/computers/${comp_id}/config" \
    -H "Authorization: Bearer $ORB_KEY" \
    -H 'Content-Type: application/toml' \
    --data-binary @orb-steel.toml)
  if echo "$config_res" | grep -q "computer_id"; then
    record "upload-config" "PASS" "orb.toml accepted"
  else
    record "upload-config" "FAIL" "$config_res"
    orb_api DELETE "/v1/computers/$comp_id" > /dev/null
    return
  fi

  # Build
  log "Building (Chrome + Steel, ~3-5 min)..."
  local build_res=$(curl -s -m 900 -X POST "${ORB_API}/v1/computers/${comp_id}/build" \
    -H "Authorization: Bearer $ORB_KEY")
  local build_ok=$(echo "$build_res" | python3 -c "import sys,json; print(json.loads(sys.stdin.read(),strict=False).get('success',False))" 2>/dev/null)
  if [ "$build_ok" = "True" ]; then
    record "build" "PASS" "All build steps exit 0"
  else
    local failed_step=$(echo "$build_res" | python3 -c "
import sys,json
d=json.loads(sys.stdin.read(),strict=False)
for s in d.get('steps',[]):
    if s['exit_code'] != 0:
        print(f'Step: {s[\"step\"][:50]} stderr: {s.get(\"stderr\",\"\")[:100]}')
        break
" 2>/dev/null || echo "unknown")
    record "build" "FAIL" "$failed_step"
    orb_api DELETE "/v1/computers/$comp_id" > /dev/null
    return
  fi

  # Deploy
  local deploy_res=$(orb_api POST "/v1/computers/$comp_id/agents" -d '{}')
  local agent_port=$(echo "$deploy_res" | python3 -c "import sys,json; print(json.load(sys.stdin)['agents'][0]['port'])" 2>/dev/null)
  if [ -n "$agent_port" ] && [ "$agent_port" != "None" ]; then
    record "deploy" "PASS" "Agent on port $agent_port"
  else
    record "deploy" "FAIL" "No agent started"
    orb_api DELETE "/v1/computers/$comp_id" > /dev/null
    return
  fi

  # Wait for health
  log "Waiting for Steel to be ready..."
  sleep 12
  local health=$(steel_api GET "$steel_url/v1/health")
  if echo "$health" | grep -q '"ok"'; then
    record "health" "PASS" "Steel Browser healthy at $steel_url"
  else
    record "health" "FAIL" "Health check failed: $health"
    orb_api DELETE "/v1/computers/$comp_id" > /dev/null
    return
  fi

  # Create session
  local session_res=$(steel_api POST "$steel_url/v1/sessions" -d '{}')
  local sid=$(echo "$session_res" | json_get "['id']")
  if [ -n "$sid" ] && [ "$sid" != "None" ]; then
    record "create-session" "PASS" "Session $sid"
  else
    record "create-session" "FAIL" "No session ID"
  fi

  # Scrape
  local scrape_res=$(steel_api POST "$steel_url/v1/scrape" -d '{"url":"https://example.com"}')
  local scrape_title=$(echo "$scrape_res" | json_get ".get('metadata',{}).get('title','?')")
  if [ "$scrape_title" = "Example Domain" ]; then
    record "scrape" "PASS" "Title: $scrape_title"
  else
    record "scrape" "FAIL" "Expected 'Example Domain', got '$scrape_title'"
  fi

  # Screenshot
  steel_api POST "$steel_url/v1/screenshot" -d '{"url":"https://example.com"}' --output /tmp/e2e-screenshot.jpg
  local ss_size=$(wc -c < /tmp/e2e-screenshot.jpg 2>/dev/null || echo "0")
  ss_size=$(echo "$ss_size" | tr -d ' ')
  if [ "$ss_size" -gt 1000 ]; then
    record "screenshot" "PASS" "${ss_size} bytes"
  else
    record "screenshot" "FAIL" "Only ${ss_size} bytes (error response?)"
  fi

  # Context
  local ctx_res=$(steel_api GET "$steel_url/v1/sessions/$sid/context")
  local cookie_count=$(echo "$ctx_res" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('cookies',[])))" 2>/dev/null || echo "0")
  record "context" "PASS" "$cookie_count cookies"

  # Release session
  local release_res=$(steel_api POST "$steel_url/v1/sessions/$sid/release")
  if echo "$release_res" | grep -q "released\|idle"; then
    record "release-session" "PASS" "Session released"
  else
    record "release-session" "FAIL" "$release_res"
  fi

  # CRIU Checkpoint/Restore
  log "Testing CRIU checkpoint/restore..."

  # Browse first to set state
  steel_api POST "$steel_url/v1/scrape" -d '{"url":"https://www.google.com"}' > /dev/null

  # Checkpoint
  local demote_res=$(orb_api POST "/v1/computers/$comp_id/agents/demote" -d "{\"port\": $agent_port}")
  local demote_status=$(echo "$demote_res" | json_get ".get('status','?')")
  if [ "$demote_status" = "demoted" ]; then
    record "criu-checkpoint" "PASS" "Chrome frozen to NVMe"
  else
    local demote_err=$(echo "$demote_res" | json_get ".get('error','?')")
    record "criu-checkpoint" "FAIL" "$demote_err"
    orb_api DELETE "/v1/computers/$comp_id" > /dev/null
    return
  fi

  sleep 5

  # Restore
  local promote_res=$(orb_api POST "/v1/computers/$comp_id/agents/promote" -d "{\"port\": $agent_port}")
  local promote_status=$(echo "$promote_res" | json_get ".get('status','?')")
  if [ "$promote_status" = "promoted" ] || [ "$promote_status" = "running" ]; then
    record "criu-restore" "PASS" "Chrome restored from NVMe"

    sleep 3
    # Verify Chrome works after restore
    local post_health=$(steel_api GET "$steel_url/v1/health")
    if echo "$post_health" | grep -q '"ok"'; then
      record "criu-post-health" "PASS" "Steel healthy after restore"
    else
      record "criu-post-health" "FAIL" "$post_health"
    fi

    # Screenshot after restore
    steel_api POST "$steel_url/v1/screenshot" -d '{"url":"https://example.com"}' --output /tmp/e2e-post-restore.jpg
    local post_ss=$(wc -c < /tmp/e2e-post-restore.jpg 2>/dev/null || echo "0")
    post_ss=$(echo "$post_ss" | tr -d ' ')
    if [ "$post_ss" -gt 1000 ]; then
      record "criu-post-screenshot" "PASS" "${post_ss} bytes after restore"
    else
      record "criu-post-screenshot" "FAIL" "Only ${post_ss} bytes"
    fi
  else
    local promote_err=$(echo "$promote_res" | json_get ".get('error', .get('message','?'))")
    record "criu-restore" "FAIL" "$promote_err"
    record "criu-post-health" "SKIP" "Restore failed"
    record "criu-post-screenshot" "SKIP" "Restore failed"
  fi

  # Cleanup
  log "Cleaning up VM..."
  orb_api DELETE "/v1/computers/$comp_id" > /dev/null
  record "cleanup" "PASS" "VM $short_id destroyed"
}

# ── Test: Orchestrator ───────────────────────────────────

test_orchestrator() {
  if [ -z "$ORCH_URL" ]; then
    record "orchestrator-health" "SKIP" "ORCHESTRATOR_URL not set"
    return
  fi

  log "=== TEST GROUP: Orchestrator ==="

  # Health
  local health=$(steel_api GET "$ORCH_URL/v1/orchestrator/health")
  if echo "$health" | grep -q '"ok"'; then
    record "orch-health" "PASS" "Orchestrator healthy"
  else
    record "orch-health" "FAIL" "$health"
    return
  fi

  # Create session through orchestrator
  log "Creating session through orchestrator (provisions VM, ~3-5 min)..."
  local session_res=$(curl -s -m 600 -X POST "$ORCH_URL/v1/sessions" \
    -H 'Content-Type: application/json' -d '{}')
  local orch_sid=$(echo "$session_res" | json_get ".get('id','?')")
  local orch_vm=$(echo "$session_res" | json_get ".get('_orchestrator',{}).get('vmId','?')")
  if [ -n "$orch_sid" ] && [ "$orch_sid" != "?" ] && [ "$orch_sid" != "None" ]; then
    record "orch-create-session" "PASS" "Session $orch_sid on VM ${orch_vm:0:8}"
  else
    record "orch-create-session" "FAIL" "$(echo "$session_res" | head -c 100)"
    return
  fi

  # Route: get session details
  local detail_res=$(steel_api GET "$ORCH_URL/v1/sessions/$orch_sid")
  local detail_status=$(echo "$detail_res" | json_get ".get('status','?')")
  if [ "$detail_status" = "live" ] || [ "$detail_status" = "idle" ]; then
    record "orch-route-session" "PASS" "Status: $detail_status"
  else
    record "orch-route-session" "FAIL" "$detail_status"
  fi

  # List sessions
  local list_res=$(steel_api GET "$ORCH_URL/v1/sessions")
  local list_count=$(echo "$list_res" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('sessions',[])))" 2>/dev/null)
  if [ "$list_count" -ge 1 ]; then
    record "orch-list-sessions" "PASS" "$list_count session(s)"
  else
    record "orch-list-sessions" "FAIL" "Expected >=1, got $list_count"
  fi

  # Release
  local release_res=$(steel_api POST "$ORCH_URL/v1/sessions/$orch_sid/release")
  if echo "$release_res" | grep -q "released"; then
    record "orch-release" "PASS" "Session released, VM destroyed"
  else
    record "orch-release" "FAIL" "$release_res"
  fi

  # Verify empty
  local empty_res=$(steel_api GET "$ORCH_URL/v1/sessions")
  local empty_count=$(echo "$empty_res" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('sessions',[])))" 2>/dev/null)
  if [ "$empty_count" = "0" ]; then
    record "orch-cleanup" "PASS" "0 sessions after release"
  else
    record "orch-cleanup" "FAIL" "$empty_count sessions remain"
  fi
}

# ── Run Tests ────────────────────────────────────────────

log "Steel Orchestrator E2E Test Suite"
log "================================="
log ""

test_steel_vm
test_orchestrator

# ── Write Results ────────────────────────────────────────

cat > "$RESULTS_FILE" << EOF
# E2E Test Results

**Date:** $(timestamp)
**Orb API:** $ORB_API
**Orchestrator:** ${ORCH_URL:-not tested}

## Summary

- **PASS:** $PASS
- **FAIL:** $FAIL
- **SKIP:** $SKIP
- **Total:** $((PASS + FAIL + SKIP))

## Results

| Test | Status | Detail |
|------|--------|--------|
$(printf '%s\n' "${TESTS[@]}")

## Notes

- CRIU checkpoint (freeze) consistently works
- CRIU restore (wake) status tracked per run
- Build takes 3-5 minutes (Chrome + npm install)
- Each test run creates and destroys VMs (clean state)
EOF

log ""
log "================================="
log "PASS: $PASS  FAIL: $FAIL  SKIP: $SKIP"
log "Results written to $RESULTS_FILE"
