# Site review — follow-up report

Text read of the public pages only; behaviour behind logins and payments was not
observable. Filed verbatim from the reviewer's second look (received 15 October 2026).

Short answer: no, the site does not yet meet the requirements. It has improved since
the first look, but the main new features are still missing.

## Fixed since last time

| Earlier finding | Now |
| --- | --- |
| F-01: contradictory privacy claims | Fixed. The developers page now says repeat checks come from a cache of "a hashed reference, the verdict and the time", which matches the home page. |
| F-02: "thousands of reports" | Mostly fixed. The data-sources section now says "growing database". One line still says "thousands of reported scam patterns". |
| F-14: contact wording | Fixed. The form is for general requests and WhatsApp for scams in progress. |
| F-15: registry wording | Fixed. It now says Digital Credit Providers. |
| F-17: two signup paths | Clarified. The signup modal says it is for job owners and sends API partners to the Developers page. |
| F-05: keyword stuffing | Reduced but not gone. |

## Still not met

| Requirement | Status on the live site |
| --- | --- |
| Organisation verification with business documents | Missing. API signup still asks for a personal ID and an email code only. |
| No free live plan, sandbox keys only | Not met. Free is still 100 live checks. The meta description even says "free sandbox plan", which doesn't match. |
| Pay-gating (gate, check_token, /v1/token/verify) | Missing from the docs. |
| Docs: sandbox, grace period, 402 error, fail-open versus fail-closed, widget attributes | Missing. The docs are unchanged: still checkType/subject, flat error strings, and the widget guide is two lines. |
| Expiry countdown, reminder emails, renewal flow | Missing. The dashboard shows only "—" placeholders. |
| Multiple keys, live and test | Not met. Docs still say one key per account. |
| Scale plan, volume-based plan picker | Missing. |
| verified verdict and Verified programme pages | Not found. |
| Status page | Not found linked anywhere, and I couldn't open status.html. |
| Feedback ("wrong verdict") button | Not seen. |
| Social links | Partial. Only Threads (@semacheck254) is branded. Instagram, X, YouTube and TikTok are still personal handles. |

## New things noticed

- The alerts page lets people pay KES 30 to open full details of a report. This is a
  business decision, but it may reveal full phone numbers of people named in reports.
  Please check this against the Data Protection Act and the masking advice.
- Report and dispute uploads accept DOC and DOCX files up to 8 MB. Word files can
  carry macros, so allow only JPG, PNG and PDF.
- The privacy policy says sessions use browser session storage. If login tokens sit
  there, any script injection (XSS) can steal them. Use HttpOnly cookies instead.
- The privacy policy was last updated 11 August 2026. It doesn't mention API
  accounts, API usage logs, reports and evidence files, or webhooks.
- The developers page says "so your users know if … is safe". The spec bans the word
  "safe", and the API terms themselves say results are not a guarantee.
- The API terms have no service levels, key-security duties, refund policy, expiry or
  grace details, or a rule against refusing service to people based on a verdict.

Good: the policy says logout invalidates the session on the server, ID photos are
never served from a public URL, and breaches are reported within 72 hours. These are
claims that can't be tested from outside — please check them with tests B9 and F4.

Stats page: the numbers load by script and showed as "—" in the read, so it can't be
told whether they populate.

## Priorities

1. Run the callback, ID-photo and XSS tests from the review document.
2. Remove DOC and DOCX from uploads.
3. Move API signup to organisation verification and replace the live Free plan with
   sandbox keys.
4. Add the gate, token and sandbox sections to the docs, then build them.
5. Update the privacy policy and API terms.
6. Build the countdown and reminders.
