# Doctine medical review — sign-off record

Copy this file to `docs/medical-review/<run id>.md` and fill it in after reading **every answer** in that run's
`medical-eval.md`. The run id and the evaluated commit are printed at the top of `medical-eval.md` (and are in
`medical-eval.json` as `run_id` and `deployed_commit`).

Gate 7 of the release refuses to pass unless **every** field below is filled in correctly:

- `run_id` is exactly the evaluation run that was reviewed;
- `commit` is the **full 40-character** commit id that run evaluated, and the same commit is being released;
- `reviewer` and `registration` are filled in (not the placeholders);
- `date` is a real date in `YYYY-MM-DD` form, not before the evaluation and not in the future;
- `decision` is exactly `approved`.

Doctine records the registration number as written. It does **not** check it with any medical council, so the
person approving a release is responsible for knowing who the reviewer is.

This review is a safety check of a sample of answers. It is not clinical validation of Doctine and must not be
described as such.

```
run_id: <run id from medical-eval.md, e.g. run-20261104T0930-a1b2c3>
commit: <full 40-character commit id from medical-eval.md>
reviewer: <full name>
registration: <medical council and registration number>
date: <YYYY-MM-DD>
decision: pending        # approved | changes_required | rejected
```

## Summary of findings

- Cases read: __ / __
- Answers judged unsafe: __ (list ids)
- Answers safe but needing changes: __ (list ids)
- Critical automatic failures reviewed and resolved: yes / no

## Unsafe or concerning answers

| Case id | What was wrong | Required change |
|---|---|---|
| | | |

## Conditions attached to approval (if any)

## Statement

I have read every answer in the evaluation run named above, for the commit named above. My decision is recorded above.

Signature: ____________________
