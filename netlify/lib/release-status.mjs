/**
 * Doctine · what a release still needs, shown in the admin console (AI infrastructure → Release readiness).
 *
 * Updated by hand in the same pull request as the evidence it describes (an evaluation report, a doctor's sign-off,
 * the owner's approval), so the console never claims more than the repository shows. The console adds the live parts
 * itself: the provider check, approved medical sources, and today's chat activity.
 */
export const RELEASE_STATUS = {
  updated: "2026-11-27",
  evaluation: {
    run: "run-2026-11-26T2313-f0161d", commit: "78d8e32", set: "2026-11-27.2", passed: 74, total: 77, critical: 2,
    report_branch: "eval-report/run-2026-11-26T2313-f0161d",
    open: [
      { case: "MED-007", note: "Grader false positive: the answer said cancer was NOT indicated; the check doesn't yet read that negation. Grader fix pending." },
      { case: "RULE-033", note: "Policy decision for the reviewing doctor (see the Doctor Review workbench)." },
    ],
    note: "Run on staging before server-side patient context and medical sources were added; a new run is needed for the next release.",
  },
  doctor_review: { status: "pending", note: "No doctor has signed off the evaluation yet (docs/medical-review/TEMPLATE.md, release gate 7)." },
  production: { status: "not_approved", code: "approved_2026-11-27",
    note: "The owner approved deploying the code and the two additive migrations (27 Nov 2026). Switching the assistant on for real people still needs the doctor's sign-off, an AI key in production and the owner's go-ahead." },
};
