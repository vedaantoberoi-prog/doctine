# Security policy

Doctine holds personal health records, so we take reports seriously.

## Reporting a vulnerability

Email **support@doctine.com** with "Security" in the subject (the same contact as
https://app.doctine.com/.well-known/security.txt). Please include what you found, where, and how to reproduce it.

- Don't open a public GitHub issue for a vulnerability.
- Test only against your own account. Never access, change or download another person's data, and don't run
  denial-of-service, spam or social-engineering tests.
- Give us reasonable time to fix the problem before you disclose it.

## What's in scope

- The app at https://app.doctine.com, including `/admin` and `/doctor`, and its API under `/api/`.
- The website at https://doctine.com.
- This repository's code and workflows.

The staging site exists for testing our own changes; please don't target it.
