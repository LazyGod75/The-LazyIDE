/**
 * Borealis Dynamics demo content — fictional engineering notes.
 * All content is entirely fictional. No real-world identifiers.
 */

export interface NoteSpec {
  readonly author: string;
  readonly type: 'decision' | 'episodic' | 'reference';
  readonly tags: string[];
  readonly text: string;
}

// ---------------------------------------------------------------------------
// Platform team — 10 notes (alice / claire)
// Decision pairs: one superseded pair (platform-billing-retry → platform-billing-retry-v2)
// One note with a fake credential to trigger scrubbing
// ---------------------------------------------------------------------------

export const PLATFORM_NOTES: NoteSpec[] = [
  {
    author: 'alice',
    type: 'decision',
    tags: ['billing', 'idempotency', 'stripe'],
    text: 'ADR-001: Idempotency keys for billing retries. We adopt client-generated idempotency keys on all Stripe charge calls, keyed by order-id + attempt-number. This eliminates the double-charge window that appeared under our auto-retry logic during the Q1 incident. All charge endpoints now reject requests missing the X-Idempotency-Key header with HTTP 422. Idempotency key TTL is set to 24 hours on the Stripe side.',
  },
  {
    author: 'claire',
    type: 'decision',
    tags: ['runtime', 'node', 'lts', 'platform'],
    text: 'ADR-002: Pin Node 22 LTS across all services. After evaluating the V8 performance gains in Node 22 and confirming compatibility with our internal toolchain, we pin to Node 22.x LTS for all platform services. Docker base images are updated to node:22-alpine. CI matrix drops Node 18 support. The runtime freeze is in effect until the next LTS cycle (October 2026) unless a critical CVE forces an earlier upgrade.',
  },
  {
    author: 'alice',
    type: 'decision',
    tags: ['observability', 'opentelemetry', 'tracing'],
    text: 'ADR-003: Adopt OpenTelemetry traces for distributed request tracking. We replace our bespoke correlation-ID middleware with the OpenTelemetry SDK. The OTLP exporter is configured to push traces to our Grafana Tempo instance. Service owners must instrument the three top-level entry points (HTTP handler, message consumer, cron job) within their sprint. This decision supersedes the home-grown X-Trace-ID header scheme documented in the 2024 wiki.',
  },
  {
    author: 'claire',
    type: 'decision',
    tags: ['rate-limiting', 'api-gateway', 'growth-analytics'],
    text: `ADR-004: Rate-limit strategy — tiered quotas by plan. We implement token-bucket rate limiting at the API gateway level with three tiers: free (60 req/min), pro (600 req/min), enterprise (6 000 req/min). Limits are enforced per API key, not per IP, to support legitimate burst patterns from load balancers. The rate-limit configuration is consumed by the growth team's analytics attribution pipeline — see also growth team decision ADR-G-001 (attribution model consolidation) for dependency tracking.`,
  },
  {
    author: 'alice',
    type: 'episodic',
    tags: ['bug', 'webhooks', 'stripe', 'post-mortem'],
    text: 'BUG-011: Webhook double-fire root cause — clock skew on ECS task startup. During the April 22 incident window, our webhook processor acknowledged events before persisting the processed-event record to DynamoDB. Under high load, a second ECS task started within the 30-second SQS visibility timeout and reprocessed the same event. Root cause: the deduplication lock used wall-clock time with a 10-second tolerance, which was insufficient given the 40-second cold-start observed on p99. Fix: replaced wall-clock lock with a conditional-write on the DynamoDB event record using a version attribute.',
  },
  {
    author: 'claire',
    type: 'episodic',
    tags: ['bug', 'auth', 'jwt', 'clock-skew'],
    text: `BUG-017: JWT rejection storm caused by NTP clock skew on worker pods. On May 3rd, 14 of our 48 worker pods began rejecting all inbound JWTs with "token not yet valid." Investigation revealed those pods had drifted 4 minutes ahead of UTC due to a misconfigured chrony daemon after the last AMI bake. JWTs issued by the auth service were arriving before the recipients' clocks caught up. Mitigation: increased nbf leeway to 120 seconds in the JWT verification middleware. Long-term fix: enforce chrony synchronization via the instance bootstrap script and add a clock-drift CloudWatch alarm.`,
  },
  {
    author: 'alice',
    type: 'decision',
    tags: ['deployment', 'canary', 'progressive'],
    text: 'ADR-005 (SUPERSEDED — see ADR-005-v2): Canary deploy using weighted routing at the ALB. Initial proposal was to implement canary deploys by adjusting ALB target group weights directly. We planned to start all canary releases at 5% traffic for 30 minutes before full promotion. This approach was validated in staging but has since been replaced by a more sophisticated strategy — see ADR-005-v2 for the current approach using feature flags for finer granularity.',
  },
  {
    author: 'claire',
    type: 'decision',
    tags: ['deployment', 'canary', 'feature-flags', 'progressive'],
    text: `ADR-005-v2: Canary deploys via feature flags (replaces ADR-005). After piloting the ALB-weight approach in staging we found it insufficient for partial user-segment targeting. We now use a feature-flag service (LaunchDarkly) as the primary canary gate, with ALB weights retained as a secondary kill switch. Canary releases start at 1% of paying customers only, graduate to 10% after 1 hour with no error-rate increase, then full rollout after 24 hours. This integrates directly with the growth team's analytics model (ADR-G-001) to measure conversion impact during the canary window.`,
  },
  {
    author: 'alice',
    type: 'reference',
    tags: ['on-call', 'runbook', 'sre'],
    text: `On-call runbook reference: the full platform on-call runbook is maintained in Confluence under "Platform Engineering > SRE > On-Call Runbook (2026)." Key sections: escalation matrix, pager duty rotation schedule, severity classification guide, and the five most common alert playbooks (high error rate, memory pressure, DB connection exhaustion, certificate expiry, and deployment rollback procedure). This note acts as a pointer — always consult the Confluence version which is updated after each post-mortem.`,
  },
  {
    author: 'alice',
    type: 'episodic',
    tags: ['security', 'credentials', 'incident'],
    // split literal to avoid false-positive secret push-protection; runtime value unchanged
    text:
      'SECURITY-003: Credential accidentally committed to feature branch — remediation log. During routine dependency update work, a developer committed a test configuration file containing api_key=sk_live_' +
      'demoFakeKey1234567890abc to a feature branch. The secret was caught by our pre-receive hook within 90 seconds. Actions taken: key rotated immediately via Stripe dashboard, branch history rewritten and force-pushed, dependent services updated, post-mortem scheduled. This note documents the event for audit purposes; the actual key stored here is already rotated and non-functional.',
  },
];

// ---------------------------------------------------------------------------
// Firmware team — 8 notes (bob / dana) — PRIVATE team
// ---------------------------------------------------------------------------

export const FIRMWARE_NOTES: NoteSpec[] = [
  {
    author: 'bob',
    type: 'decision',
    tags: ['rtos', 'watchdog', 'safety'],
    text: 'FW-ADR-001: RTOS task watchdog policy — mandatory for all safety-critical tasks. All tasks classified as safety-critical (motor control, brake actuation, emergency stop) must register with the hardware watchdog at init time and kick it within 80% of their deadline. Tasks that miss two consecutive deadlines are logged to the black-box recorder and trigger a controlled halt. Non-safety tasks use a software watchdog only and receive a warning before termination. This policy aligns with our IEC 61508 SIL-2 obligations for the Hydra-7 platform.',
  },
  {
    author: 'dana',
    type: 'decision',
    tags: ['can-bus', 'versioning', 'protocol'],
    text: 'FW-ADR-002: CAN bus frame versioning via DLC extension byte. To support protocol evolution without breaking existing ECU firmware, we reserve the first byte of all extended-frame payloads as a schema-version field. Version 0x00 denotes the legacy (pre-2025) format. Version 0x01 introduces the new field layout ratified at the April firmware sync. ECUs must silently ignore frames with versions higher than they support; they must not respond with an error frame. Migration path: all ECUs will be updated to 0x01 in the Hydra-7.3 release; 0x00 support removed in 7.4.',
  },
  {
    author: 'bob',
    type: 'episodic',
    tags: ['bug', 'flash', 'wear-leveling', 'regression'],
    text: 'FW-BUG-008: Flash wear-leveling regression in v7.2.1-rc3. The wear-leveling algorithm regression introduced in commit f3a91cc causes the erase-block selection heuristic to favor blocks in the 0x000–0x0FF address range under high write frequency. In 72-hour soak tests on the HIL rig, blocks 0x004 and 0x007 hit the 100K erase-cycle limit while blocks above 0x100 remain near zero. Root cause: the free-block scan wraps at 256 entries due to an off-by-one in the modular arithmetic. Fix committed to hotfix/flash-wear branch; regression test added to the soak suite.',
  },
  {
    author: 'dana',
    type: 'episodic',
    tags: ['bug', 'brownout', 'reset', 'power'],
    text: `FW-BUG-012: Brownout reset loop root cause — capacitor timing race. Field units showing persistent brownout-reset loops were traced to a race between the MCU's brownout detector and the bulk capacitor discharge sequence on the 3.3V rail. When input voltage drops below 4.1V (e.g., during motor inrush), the cap discharges in 18ms but the brownout threshold fires at 22ms, repeatedly resetting before the cap can recover. Workaround in firmware v7.2.2: extend the brownout hold-off timer from 10ms to 30ms. Hardware fix (increased cap value) is scheduled for rev-F PCB.`,
  },
  {
    author: 'bob',
    type: 'decision',
    tags: ['hil', 'testing', 'ci', 'hardware'],
    text: 'FW-IDEA-001: Hardware-in-the-loop (HIL) test rig expansion proposal. Current HIL capacity (2 rigs) is a bottleneck: 40-minute queue times are delaying firmware CI green times above 4 hours. Proposal: add 4 additional HIL rigs using the Renode emulation framework for non-safety-critical tests and reserve physical rigs for safety-critical and power-subsystem tests. Estimated setup time: 2 sprints. Expected CI time reduction: 60%. Requires approval from embedded hardware lead and budget sign-off from Claire.',
  },
  {
    author: 'dana',
    type: 'reference',
    tags: ['vendor', 'errata', 'stm32', 'reference'],
    text: `Vendor errata reference: STM32H7B0 silicon revision X (ES0396 Rev 10, January 2025). Critical errata applicable to Borealis Dynamics Hydra-7 hardware: ES-023 (ADC clock domain crossing glitch under simultaneous DMA and Ethernet activity), ES-041 (SPI NSS pulse drop under high CPU load at >400MHz), and ES-057 (IWDG window mode false-trigger if CPU enters Stop 2 within the window). All three are worked around in our BSP layer — see bsp/stm32h7b0_errata.c. Document is stored in the firmware team SharePoint under "Datasheets > STM32H7B0."`,
  },
  {
    author: 'bob',
    type: 'decision',
    tags: ['safety', 'fota', 'ota', 'rollback'],
    text: 'FW-ADR-003: FOTA rollback policy — dual-bank scheme with automatic revert. Firmware-over-the-air updates are applied to the inactive flash bank. On first boot after update, a watchdog-supervised health check runs for 120 seconds. If any safety-critical task fails to report healthy within that window, the bootloader reverts to the previous bank and marks the update as failed in the telemetry log. Failed updates are quarantined for 72 hours and re-attempted only after a maintenance window confirmation from the fleet operator. This satisfies the rollback requirement from our ISO 26262 ASIL-B obligation.',
  },
  {
    author: 'dana',
    type: 'episodic',
    tags: ['performance', 'can-bus', 'latency', 'optimization'],
    text: 'FW-PERF-002: CAN bus latency spike during concurrent sensor fusion + telemetry burst. Observed during track testing on unit BD-FLT-044: latency on the motor-command CAN frame spiked from nominal 1.2ms to 18ms during 5-second windows of concurrent LiDAR point-cloud upload (telemetry burst). Investigation showed the FIFO arbitration was giving equal priority to telemetry and control frames. Fix: reduced telemetry message priority from 0x200 to 0x400 (lower = lower priority in CAN standard), and introduced a burst-limiter that caps telemetry output at 50 frames/second during active motor control. Latency returned to 1.4ms p99 after fix.',
  },
];

// ---------------------------------------------------------------------------
// Growth team — 7 notes (fatima / eric)
// ---------------------------------------------------------------------------

export const GROWTH_NOTES: NoteSpec[] = [
  {
    author: 'fatima',
    type: 'decision',
    tags: ['attribution', 'analytics', 'marketing'],
    text: `ADR-G-001: Attribution model — last-touch with 30-day window. After a 6-week analysis comparing first-touch, last-touch, and linear attribution across Q4 paid campaigns, we adopt last-touch attribution with a 30-day lookback as our primary model. The decision was driven by the strong correlation (r=0.87) between last-touch last-click and actual conversion events in our A/B holdout. Multi-touch attribution is retained as a secondary view for campaign planning but is not used for budget allocation decisions. This model feeds directly into the platform team's rate-limiting tier assignment (see Platform ADR-004).`,
  },
  {
    author: 'fatima',
    type: 'decision',
    tags: ['analytics', 'consolidation', 'tooling'],
    text: 'ADR-G-002: Consolidate analytics stack from 3 tools to 1 (PostHog). We sunset Mixpanel (contract expires July 2026) and the in-house event pipeline, migrating to PostHog self-hosted as our single event store. Rationale: 60% cost reduction, full data ownership, and a single SDK call replacing three concurrent tracking calls per page event. Migration plan: shadow-track for 4 weeks, validate event parity, flip the kill switch in sprint 47. Eric owns the SDK migration across the web funnel.',
  },
  {
    author: 'eric',
    type: 'episodic',
    tags: ['bug', 'utm', 'tracking', 'truncation'],
    text: 'GROWTH-BUG-003: UTM parameter truncation losing campaign source on mobile Safari. On mobile Safari 17+, our landing page URL handler was truncating UTM parameters exceeding 256 characters. Campaigns using combined utm_content + utm_term strings (common for Google Shopping) were silently dropping utm_source, causing ~8% of paid mobile conversions to appear as organic in our attribution model. Root cause: a URL normalization utility from a third-party library capped query string length at 255 bytes. Fix: replaced the normalizer with a custom implementation that preserves all query parameters. Attribution data corrected retroactively for the 6-week affected window.',
  },
  {
    author: 'fatima',
    type: 'decision',
    tags: ['content', 'changelog', 'product-marketing'],
    text: 'ADR-G-003: Launch public changelog page at /changelog. Product marketing has identified changelog pages as a top-3 driver of feature awareness among power users (sourced from our NPS survey cohort). We will publish a curated changelog at /changelog using a static-generated page from release notes authored in Notion. Target: weekly cadence, owned jointly by growth and product. Eric to implement the frontend in the Site repository.',
  },
  {
    author: 'eric',
    type: 'decision',
    tags: ['partnerships', 'integrations', 'portal'],
    text: 'ADR-G-004: Partner portal MVP scope definition. We will build a lightweight partner portal allowing integration partners to manage their API keys, view usage quotas, and access integration docs without involving a sales engineer. MVP scope: API key management, usage dashboard (read-only, last 30 days), doc hub with versioned OpenAPI spec download. Out of scope for MVP: multi-seat partner accounts, white-label SSO, and revenue-share dashboards. Timeline: 8 weeks from sprint 51 kickoff.',
  },
  {
    author: 'fatima',
    type: 'reference',
    tags: ['brand', 'voice', 'content-guidelines'],
    text: `Brand voice guide reference: the Borealis Dynamics brand voice guidelines (v3.2, approved March 2026) are maintained in Notion under "Marketing > Brand > Voice & Tone Guidelines." Key principles: direct and technical for developer-facing content, confident but not arrogant for executive-facing content, and always metric-backed for claim-making. This note is a pointer — all growth team copy must be reviewed against the Notion document before publication. Fatima is the DRI for brand voice decisions.`,
  },
  {
    author: 'eric',
    type: 'decision',
    tags: ['seo', 'technical', 'web'],
    text: 'ADR-G-005: Core Web Vitals remediation plan for Q2. PageSpeed Insights shows our product landing pages scoring 54/100 on mobile, primarily due to a 2.3s LCP caused by above-the-fold hero images not being preloaded and a 380ms FID from a third-party chat widget initializing synchronously. Remediation steps: (1) add <link rel=preload> for hero images in Next.js _app, (2) defer chat widget initialization to after first interaction, (3) implement image CDN with automatic WebP conversion. Target: 75+ mobile score by end of Q2. Eric is implementation DRI; Fatima tracks the business KPI (organic impressions).',
  },
];
