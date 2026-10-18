# ODPC registration — obligation, evidence and open actions

Checked 18 October 2026, prompted by a review note: *"I saw no mention of registering
with Kenya's Office of the Data Protection Commissioner. You collect national IDs and
business documents, so check whether you need to be registered."*

**Conclusion: we are very likely required to register, and being small is probably not an
exemption.** This is a legal conclusion drawn from the ODPC's own published guidance, not
legal advice — confirm the classification with a Kenyan data-protection lawyer before
treating it as settled.

## Why

- **Section 18, Data Protection Act 2019** creates the registration duty for data
  controllers and processors, subject to the thresholds in the Regulations.
- **Data Protection (Registration of Data Controllers and Processors) Regulations 2021,
  regulations 4 and 13(2)**: the small-entity exemption needs **both** annual turnover or
  revenue **under KSh 5 million** **and fewer than 10 employees**. Meeting one of the two
  is not enough. If we grow past either, the exemption is gone regardless of what we do.
- **The exemption does not help where the purpose is a listed one.** The ODPC's list of
  purposes that must register regardless of size includes **crime prevention and
  prosecution** and **insurance and other financial services**. SemaCheck's stated purpose
  is detecting fraud and scam Paybills — squarely crime-prevention shaped — and our
  customers are lenders, fintechs and marketplaces using verdicts inside payment flows.
  Arguing that we are "only a fraud-checking tool" is not a classification: the actual
  purpose decides it.
- We also process **national ID numbers and ID document images** (sign-up and API
  organisation verification). The ID number is a high-risk identifier in Kenya; the
  processing of it is what makes the DPA duties bite hardest (lawful basis, minimisation,
  retention, security).
- Nothing in 2023–2026 suspends the duty. The ODPC's *Guidance Note on Registration* (30
  November 2023) confirms the two-part exemption test, and the Worldcoin litigation
  (ODPC determination 2023; High Court judgment 5 May 2025) enforced s.18(1) rather than
  disapplying it.

Sources: <https://www.odpc.go.ke/faqs/>, <https://www.odpc.go.ke/data-protection-compliance/>,
<https://www.odpc.go.ke/wp-content/uploads/2024/03/THE-DATA-PROTECTION-REGISTRATION-OF-DATA-CONTROLLERS-AND-DATA-PROCESSORS-REGULATIONS-2021.pdf>,
<https://new.kenyalaw.org/akn/ke/judgment/kehc/2025/5629/eng@2025-05-05>.

## Cost and mechanics (ODPC published schedule)

| Item | Detail |
| --- | --- |
| Application | electronic, through the ODPC registration portal; separate application per role (controller and/or processor) and a fee for each |
| Fee, micro/small | KSh 4,000 initial, KSh 2,000 renewal |
| Fee, medium | KSh 16,000 initial, KSh 9,000 renewal |
| Fee, large | KSh 40,000 initial, KSh 25,000 renewal |
| Bands | micro/small ≤ 50 employees and ≤ KSh 5m revenue; medium 51–99 employees and KSh 5,000,001–50m; large > 99 employees and > KSh 50m (both criteria must be met to move up a tier) |
| Payment charge | ~KSh 50 for mobile-money/card; bank transfer and cheque are free |
| Certificate | issued within ~14 days when the ODPC is satisfied; valid 24 months; renew at least 30 days before expiry |
| What to submit | establishment documents, organisation and contact details, purposes of processing, categories of data and data subjects, recipients, last year's turnover/revenue |

**Consequence of processing while required and unregistered:** the Regulations make it an
offence — on conviction a fine not exceeding **KSh 3 million**, up to **10 years**
imprisonment, or both. Missing renewal after expiry is also an offence. These are maxima,
not automatic penalties, but they are the reason this is a launch blocker rather than a
paperwork chore.

## Open actions

- [ ] **Decide controller vs processor vs both.** We decide why and how checks happen (controller)
      and we process data on behalf of API customers (processor). The ODPC expects separate
      applications for each role, each with its own fee.
- [ ] **Register** on the ODPC portal and pay KSh 4,000 (micro/small) per role; keep the payment
      receipt and the certificate number here.
- [ ] **Re-check the band test** at the end of each financial year. Crossing KSh 5m revenue
      *and* 10 employees means a medium-tier fee and renewal obligations.
- [ ] **Diary the renewal** 24 months out, 30 days early. A lapsed certificate is an offence on
      its own, even if everything else is compliant.
- [ ] **Publish the registration number.** When the certificate is issued, add the number to
      `frontend/privacy.html` §14 (Registration with the ODPC) — it currently states the duty and
      offers the number on request, because we do not have one to publish yet. Do not invent one.
- [ ] **Keep the record of processing** (purposes, categories, recipients, retention periods)
      up to date next to this file; it is what the application is built from and what an ODPC
      inspection asks for.
- [ ] **Tell the Data Protection Officer contact** in the privacy page and the ODPC application
      to match (the contact form address) so a data subject can reach the right person.

## What the code already does, for the application

The register of processing this application draws on is in the repository rather than in
someone's memory:

- `frontend/privacy.html` — what is collected, lawful basis, retention, sharing and rights.
- `backend/jobs/idFileCleanup.js` — deletes ID documents after the period the policy states.
- `backend/services/normalizeService.js` / `usageService` — subjects are stored as one-way
  hashes in API logs rather than as raw identifiers.
- `backend/jobs/pruneApiLogs.js` — log retention.
