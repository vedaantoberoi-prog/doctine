# Doctine Guardian: foundation (25 Nov 2026)

**Status:** built and tested, behind the `guardian` switch, which is **off**. Migration `20261125000000_guardian` is
**not applied** to staging or production. No messaging provider is connected, so Guardian cannot alert anyone by
itself yet, and the app says so on screen.

What works today in the app (web and the Android app, which runs the same web code): an SOS button with a 5-second
cancel, "Are you OK?" check-ins with a countdown on any screen, up to 5 trusted contacts, an honest status panel, one-tap
"Call 112", calling or messaging a contact yourself (recorded as *opened by you*, never as *delivered*), contact
"I'm on it" links (when `GUARDIAN_LINK_SECRET` is set), incident history, test alerts that contact no one, and an
offline queue that sends a saved SOS once when the network returns, and "Ask to confirm": the person sends each
contact a 7-day link from their own phone, and the contact agrees or declines on a Doctine page (the only way a contact
becomes "agreed"; a changed phone number voids the agreement and the old link).

Nothing is detected automatically yet. Crash, fall, wearable and background monitoring need native app work that
doesn't exist (see section 3).

## 1. Repository audit (before this change)

| Area | Existing implementation | Missing or broken | Recommended next action |
|---|---|---|---|
| App shape | One web app (`public/index.html`) served by Netlify/Cloudflare; the same bundle in an Android app (Capacitor 8, `apps/android`) and a macOS app (Tauri). Server functions in `netlify/functions`, one Supabase database with forced RLS | No iOS project; no native code beyond `DoctineSecurePlugin.java` (secure session, files) | Keep this architecture; add native Guardian modules to the Android project first |
| Auth | Supabase Auth; server functions verify the Bearer token with `/auth/v1/user` | None for Guardian | Reused as is |
| Health profile | One emergency contact (`health_profiles.emergency_*`), allergies, conditions, medicines | Not used by any safety feature | Guardian offers "Add … from your health profile" (copy, not link) |
| Emergency handling | Chat shows "call 112" text for emergency messages (`emergencyReply`) | No SOS, incidents, contacts list, check-ins | Built here |
| Voice | None | — | App Intents / Android assistant work later (section 3) |
| Sensors, wearables | None (local notifications for dose alarms only) | Everything | Native work, phases 3 to 5 |
| Admin console | Switches, audit log, AI pages | No Guardian view | `admin_guardian_summary` (counts only) exists; a console card is a small follow-up |
| Sample/demo data | Demo accounts in browser storage, sample account flagged `S.sample`; cloud accounts separate | — | Guardian needs a cloud account; never shown for demo or sample data |
| Baseline checks | `npm test` pass, database suites pass, browser suite 736/736 (run 23–25 Nov) | No pre-existing failures | — |

## 2. What was built

| Domain | Files |
|---|---|
| Incident state machine | `netlify/lib/guardian/states.mjs` (11 states, 31 named transitions; the same list is enforced in SQL) |
| Events and policy | `netlify/lib/guardian/events.mjs` (normalized event, per-type policy, correlation, fusion) |
| Incident engine | `netlify/lib/guardian/engine.mjs` (idempotent, compare-and-set, contact cascade, retries, acknowledgement) |
| Delivery | `netlify/lib/guardian/delivery.mjs` (status vocabulary; the only adapter is `none`) |
| Contact links | `netlify/lib/guardian/links.mjs` (HMAC, 24 h) |
| Storage | `netlify/lib/guardian/store-supabase.mjs`, `store-memory.mjs` (tests); migration `supabase/migrations/20261125000000_guardian.sql`, rollback `supabase/rollback/20261125000000_guardian_down.sql` |
| API | `netlify/functions/guardian.mjs` → `/api/guardian` (routed on Cloudflare too; CORS for the apps) |
| App | `public/index.html`: Guardian screen, banner check-in, offline queue |
| Tests | `tests/guardian.test.mjs` (50), `tests/guardian.test.sql` (48), `tests/browser/guardian.test.mjs` (31) |
| Admin console | Guardian switch (Founder only) with its effects; AI page card with 30-day counts only (`guardian_summary`) |

### Incident states

| From | Trigger → To |
|---|---|
| NORMAL (no incident) | open_suspected → SUSPECTED_EVENT · open_high → HIGH_CONFIDENCE_EVENT · open_confirmed → USER_CONFIRMED · open_expired → CANCELLED |
| SUSPECTED_EVENT | checkin_start → CHECKING_IN · corroborated → HIGH_CONFIDENCE_EVENT · user_ok → CANCELLED · user_help → USER_CONFIRMED |
| HIGH_CONFIDENCE_EVENT | checkin_start → CHECKING_IN · platform_unresponsive → ESCALATING · user_ok → CANCELLED · user_help → USER_CONFIRMED |
| CHECKING_IN | checkin_timeout → POSSIBLE_EMERGENCY · user_ok → CANCELLED · user_help → USER_CONFIRMED |
| POSSIBLE_EMERGENCY | policy_escalate → ESCALATING · user_ok → CANCELLED · user_help → USER_CONFIRMED · resolve → RESOLVED |
| USER_CONFIRMED | escalate → ESCALATING · user_ok → CANCELLED |
| ESCALATING | contact_ack → CONTACT_ACKNOWLEDGED · delivery_failed → FAILED_TO_DELIVER · user_ok → RESOLVED · resolve → RESOLVED |
| FAILED_TO_DELIVER | retry → ESCALATING · contact_ack → CONTACT_ACKNOWLEDGED · user_ok → RESOLVED · resolve → RESOLVED |
| CONTACT_ACKNOWLEDGED | user_ok → RESOLVED · resolve → RESOLVED |

Every transition is written to an append-only log with from, to, trigger, reason, actor, confidence, signal quality,
actions and time. No AI model takes part in any of it.

### Response policy per event type (proposed starting values, to be tuned on recorded data)

| Event | Opens as | Check-in | Silence escalates? | Too old after |
|---|---|---|---|---|
| sos, voice_distress | person asked for help (skips thresholds) | — | yes | 30 min (a late SOS asks first) / 10 min |
| road_incident, fall | high if confidence ≥ 0.8 and signal good, else suspected | 30 s / 60 s | yes | 10 min |
| missed_checkin | suspected | 300 s | yes (the person set the check-in up) | 1 h |
| wearable_alert | suspected | 120 s | **no**: waits for the person | 30 min |
| inactivity | suspected | 120 s | **no** alone; joins an open fall/crash and raises its confidence | 10 min |
| device_failure | never an incident (status record, 30 days) | — | — | — |

Related events within 10 minutes join the open incident (confidence fused as 1 − Π(1 − c), capped at 0.99). Pressing
SOS during any open incident escalates that incident instead of opening a second one.

### Delivery statuses (only what actually happened)

`pending` · `not_configured` (no provider: nothing sent) · `user_initiated` (the person opened their own SMS/phone
app; Doctine can't see whether it went) · `sent` (provider accepted; not proof of receipt) · `delivered` (provider
confirmed) · `failed` · `acknowledged` (the contact pressed "I'm on it": the only proof a person was reached).
Unverified contacts are never messaged automatically. Test incidents never message anyone.

### API (`/api/guardian`, signed-in person; id from the token, never from the body)

`GET` status (applies due check-in deadlines) · `POST {action}`: `settings`, `contact_save` (status can't be set),
`contact_delete`, `invite` (a contact's consent link and message), `report` (one normalized event; idempotent on `event_id`), `respond` (`ok` | `help` | `timeout`,
the last refused before the server's deadline), `retry`, `resolve`, `share` (records `user_initiated`, returns the
message text and, with a secret, the contact's link) · `GET/POST ?ack=<token>`: the contact's "I'm on it" page ·
`GET/POST ?consent=<token>`: the contact's agree/decline page (shows only the contact's own name).

### Data and privacy

Private schema, forced RLS, no grants to browsers; only the server's functions touch it, always with the verified
person id (tests check browsers can't read the tables or call the functions, even for themselves). Location is kept
only if the person turned it on, only for an incident, and erased 30 days after the incident closes; closed incidents
are deleted after 12 months; status events after 30 days (`guardian_purge`, run occasionally by the server; a
scheduled run is still to be added). Deleting an account deletes all of it. Logs carry actions and timings only (a
test checks no name, number, place or message reaches them). The admin summary is counts only, Founder-only.

## 3. Platform capabilities (checked 25 Nov 2026)

| Capability | API / permission | Works when | Approval | Status for Doctine |
|---|---|---|---|---|
| iPhone car-crash events | SafetyKit `SACrashDetectionManager`, entitlement `com.apple.developer.severe-vehicular-crash-event`; iPhone 14+, Watch S8/SE2/Ultra; one app per device ([Apple](https://developer.apple.com/documentation/safetykit.md)) | After Apple's own SOS flow | Apple must grant the entitlement | Needs an iOS app (none exists) + entitlement |
| Apple Watch fall events | `CMFallDetectionManager` (watchOS 7.2+), entitlement via Apple's request form; wakes the app briefly in the background ([Apple](https://developer.apple.com/documentation/coremotion/cmfalldetectionmanager.md)) | Background, short runtime | Apple entitlement | Needs a watchOS app + entitlement |
| iPhone-only fall detection while backgrounded | No supported real-time path; `CMSensorRecorder` (50 Hz) doesn't wake the app ([forum](https://developer.apple.com/forums/thread/852709), [forum](https://developer.apple.com/forums/thread/813136)) | — | — | **Not feasible reliably**; manual SOS + check-ins instead |
| Watch continuous motion | Only during an active workout session ([forum](https://developer.apple.com/forums/thread/858197)) | Workout session | — | Possible for an explicit "journey/activity" session |
| Siri / Shortcuts entry points | App Intents; iOS 27 app schemas ([WWDC26](https://developer.apple.com/videos/play/wwdc2026/8011/)) | System-invoked | — | Needs an iOS app; a "Raise Doctine SOS" intent is the natural first one |
| Custom wake word with app closed (iPhone) | No public API ([forum](https://developer.apple.com/forums/thread/848299)) | — | — | **Not available** |
| Android foreground monitoring | FGS types `location`, `microphone`, `health`; each needs its runtime permission; microphone/location FGS can't start from the background ([Android](https://developer.android.com/develop/background-work/services/fgs/service-types)) | While a visible notification runs | Play policy review | Feasible for Journey mode in the Android app |
| Android driving detection | Activity Recognition Transition API, `IN_VEHICLE` ([Android](https://developer.android.com/develop/sensors-and-location/location/transitions)) | Background via PendingIntent; latency varies by device | — | Feasible |
| Wear OS fall events | Health Services `PassiveMonitoringClient`, `HealthEvent.FALL_DETECTED`, `ACTIVITY_RECOGNITION` ([Samsung](https://developer.samsung.com/health/blog/en/events-monitoring)) | Background; delivery guarantees not documented | — | **Unverified** across vendors; test per device |
| Android custom hotword | Hotword detection needs a privileged/preinstalled assistant ([AOSP sample](https://android.googlesource.com/platform/development/+/main/samples/VoiceInteractionService/)); user can still pick an app as default assistant | — | System only | Not available to Doctine; in-app voice instead |
| Health Connect | Heart rate, SpO2, BP, glucose; background read needs `READ_HEALTH_DATA_IN_BACKGROUND`; no fall or rhythm-alert type ([Android](https://developer.android.com/health-and-fitness/health-connect/data-types)). Medical records (FHIR) API is experimental ([Android](https://developer.android.com/health-and-fitness/health-connect/medical-records)) | Background with permission | Play policy for medical records still being written | Observations only, never alarms |
| Placing calls | iOS `tel:` always asks the person ([forum](https://developer.apple.com/forums/thread/73406)); Android apps can't place emergency calls ([Android blog](https://android-developers.googleblog.com/2013/05/handling-phone-call-requests-right-way.html)) | Person taps | — | One-tap "Call 112" and "Call contact" only |
| Sending SMS from the phone | Android `SEND_SMS` only under Play's "physical safety/emergency alerts" exception ([Play](https://support.google.com/googleplay/android-developer/answer/10208820?hl=en)) | — | Play review | Possible later in the Android app |
| India 112 (ERSS) | Channels include voice, SMS, SOS, e-mail, web, WhatsApp; ERSS 2.0 describes push APIs for external systems, no public spec ([MHA](https://www.mha.gov.in/emergency-response-support-system-erss), [ERSS 2.0](https://www.mha.gov.in/files/inline-documents/GuidelinesERSS20_03112026.pdf)) | — | Government approval | **No integration**; an adapter only after a written agreement |

## 4. Before automatic escalation is switched on for real people

1. A messaging provider under contract (DLT-registered SMS templates, WhatsApp Business), a `live` adapter and delivery
   receipts mapped to `delivered`/`failed`. Contact consent already exists (links the person sends themselves).
2. `GUARDIAN_LINK_SECRET` set; a scheduled job that runs `tick` for open incidents (today deadlines are applied when
   the person's app or any request touches Guardian, so a phone that dies mid-check-in isn't followed up), and runs
   `guardian_purge`.
3. Detector release gates per detector: recall and false alerts per user-month measured on recorded real-world data
   (falls on mats, drives incl. speed breakers and potholes, phone drops), by device; no crash experiments.
4. Clinical and legal review of the wording; regulatory opinion on medical-device software (CDSCO); DPDP review.
5. Switch on for a small pilot first, as was done for the assistant.

## 5. Not done in this change

Native code (Android Guardian service, iOS/watchOS apps, App Intents), device registration and per-device capability
reporting, any detector, wearable ingestion, the emergency medical passport, Hindi text, the
scheduled `tick`/`purge` job, and any external integration.
