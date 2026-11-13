# Easer Information Architecture

Status: target contract

Easer surfaces contain dashboard, offers, jobs, schedule, availability, messages, earnings, performance, training, documents, policies, profile, payout method, notifications, and security.

A job detail should answer:

- What is the scope?
- Where and when is it?
- What does the customer need?
- What evidence is required?
- What is my current job state?
- What will I earn?
- What action is available next?

## Price requests (`/assembler/price-requests`), as of 2026-11-13

Custom quotes the owner asked this Easer to price. Each request carries one server stage (`easerRequestStage` in `api/booking/_quote-offers.js`); the page renders it and decides nothing itself.

- Shows: service, date and time window, city and ZIP with a ZIP-level map link, "Exact address after you accept the job", the work items and the owner's reviewed scope. Never the customer's name, contact details, street address or price.
- Steps: You send your price; We send the customer one quote; The customer approves; The job is offered to you first; You do the job and get paid.
- Actions by stage: `open` the price form with its deadline; `sent` a "Your price" summary with Change price and Withdraw; `job_offered` and `job_yours` an "Open the job" link to `/assembler/my-assignments`. Every other stage is a plain status line; closed requests fold under "Earlier requests".
