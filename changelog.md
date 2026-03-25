
## [2026-03-25] END-TO-END VERIFIED — Full Lifecycle Through Orchestrator

### What Works (Proven)
1. **Create session** → Orchestrator provisions Orb VM (create → config → build → deploy)
   → Steel Browser + Chrome starts → session created → returned to user
2. **Route requests** → Orchestrator proxies GET /sessions/:id, GET /sessions/:id/context
   to the correct VM based on session ID
3. **Release session** → Orchestrator saves context → forwards release → destroys Orb VM
   → VM confirmed deleted → sessions list empty

### Live URLs
- Orchestrator: https://493b8b81.orbcloud.dev
- Steel Browser VM (created on demand, destroyed on release)

### Session Lifecycle Test
- Session ID: 7f92879c-aeb6-4b92-a6c4-fd087772a19c
- VM: 898560b7 (auto-provisioned by orchestrator)
- Status: live → context accessible → released → VM destroyed → sessions empty
- Full round-trip: CREATE → ROUTE → RELEASE → CLEANUP ✓

### Remaining
- Stateless actions (scrape/screenshot) through orchestrator need warm pool
  (cold provisioning takes 3-5 min, too slow for one-shot actions)
- CRIU restore for Chrome still pending Orb fix
- Need to test concurrent sessions (create 2+ through orchestrator)
