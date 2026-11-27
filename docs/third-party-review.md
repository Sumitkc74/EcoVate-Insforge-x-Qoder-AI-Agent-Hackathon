# Third-party services review — EcoVate

Checked: 27 November 2026. Method: read each provider's public terms
pages (linked below) and compared them with how EcoVate actually uses
the service. This is a record of what was checked, not legal advice.
Provider terms change; re-check before relying on any of this.

## How EcoVate uses each service

- **Supabase** — database, authentication (Google sign-in), and file
  storage. It holds names, email addresses, profile photos, uploaded
  photos, scan history, and DIY projects.
- **Google Gemini API (unpaid tier)** — photos are sent to it for
  vision, material guesses, and DIY ideas. Called server-side with an
  API key; the key never reaches the browser.
- **Groq** — photos are sent to it as the fallback when Gemini is
  unavailable, for the same vision work. Called server-side with an
  API key; the key never reaches the browser.
- **Google Sign-In (Google Identity / OAuth)** — sign-in only. Google
  returns the user's name, email address, and profile photo. EcoVate
  requests only that basic profile data.

## Supabase — DPA exists and applies

- Terms checked: Data Processing Addendum, Version 1, August 1, 2026 —
  https://supabase.com/legal/dpa (supplements the Supabase Terms of
  Service, https://supabase.com/terms).
- What it says: Supabase acts as processor / service provider and the
  customer as controller / business. It includes the EU Standard
  Contractual Clauses (Commission Implementing Decision (EU) 2021/914).
  No separate signature is needed — accepting the Terms of Service
  binds the DPA.
- Sub-processors: published list at
  https://supabase.com/legal/customer-resources/subprocessor-list.
  Supabase gives at least 30 days' notice of a sub-processor change,
  but only to customers who subscribe to notifications on that page;
  an objection must be sent within 5 days of the notice.
- Other terms noted: Supabase may process data anywhere it or its
  sub-processors maintain facilities, but stores and primarily
  processes data in the region the customer directs. Contracting
  entity is Supabase Pte. Ltd (Singapore); governing law is Ireland.
- DPA gap: none found. The DPA exists and covers EcoVate's use.

## Google Gemini API, unpaid tier — NO DPA; product-improvement use

- Terms checked: Gemini API Additional Terms of Service, effective
  March 23, 2026 — https://ai.google.dev/gemini-api/terms, plus the
  Google APIs Terms of Service — https://developers.google.com/terms.
- What it says about data: EcoVate uses the unpaid tier (free quota,
  no billing account), so the "Unpaid Services" terms apply. When you
  use Unpaid Services, "Google uses the content you submit to the
  Services and any generated responses to provide, improve, and
  develop Google products and services and machine learning
  technologies", and "human reviewers may read, annotate, and process
  your API input and output" (disconnected from the Google Account,
  API key, and Cloud project first). The terms say: "Do not submit
  sensitive, confidential, or personal information to the Unpaid
  Services."
- DPA: the Data Processing Addendum for Products Where Google is a
  Data Processor (https://business.safety.google/processorterms/)
  applies to **Paid Services only**. For users in the European
  Economic Area, Switzerland, or the United Kingdom the Paid Services
  data terms apply to all Services; outside those regions the DPA does
  **not** apply to EcoVate's unpaid-tier use. **DPA GAP: no DPA covers
  EcoVate's use of the Gemini API.**
- Other terms noted: "You may use only Paid Services when making API
  Clients available to users in the European Economic Area,
  Switzerland, or the United Kingdom." EcoVate uses unpaid quota and
  is open to anyone, so users in those regions would be served
  contrary to that term. Also: "You must be 18 years of age or older
  to use the APIs" and you must not use the Services as part of an API
  Client "directed towards or ... likely to be accessed by individuals
  under the age of 18" — see the age conflict below. And: "Use of
  Google AI Studio and Gemini API is for developers building with
  Google AI models for professional or business purposes, not for
  consumer use."

## Groq — DPA exists; binding for free-tier use NOT verified

- Terms checked: Data Processing Addendum for GroqCloud Services,
  effective October 15, 2025 —
  https://console.groq.com/docs/legal/customer-data-processing-addendum.
  Also read: Groq Terms of Use, effective October 15, 2025 —
  https://groq.com/terms-of-service/; Groq Privacy Policy, effective
  November 12, 2025 — https://groq.com/privacy-policy/.
- What the DPA says: Groq acts as Processor or sub-Processor;
  Personal Data is processed only to provide, maintain, and support
  the Cloud Services, on the customer's documented instructions, or as
  required by law. Groq will not "sell" or "share" Personal Data.
  Breach notice is "without undue delay, but in any event within 72
  hours". The sub-processor list is at
  https://trust.groq.com/subprocessors, with at least 15 days' notice
  of changes and 15 days to object. The EU Standard Contractual
  Clauses (Modules 2 and 3) are deemed signed. Transfers may go to
  the United States and other countries where Groq or its
  sub-processors operate, with a lawful transfer mechanism.
- **DPA GAP (unverified, not claimed): the DPA is "incorporated into
  and made part of the Groq Services Agreement". EcoVate uses Groq
  through a free API key with no signed Services Agreement on file,
  and I could not verify from public sources that the DPA binds that
  free-tier use.** The Groq website Terms of Use expressly do NOT
  cover cloud services or API use ("If you are interacting with Groq
  as a customer of our services, the Groq Services Agreement
  governs"), and the Groq Privacy Policy expressly does NOT cover
  Customer Data processed as a processor — that is governed by the
  Services Agreement and DPA, which I could not read in full (the
  Services Agreement itself is behind the console). So Groq's API
  data-retention and model-training terms were **not verified** and are
  not asserted here.

## Google Sign-In — no DPA; Google is an independent controller

- Terms checked: Google APIs Terms of Service —
  https://developers.google.com/terms; Google API Services User Data
  Policy —
  https://developers.google.com/terms/api-services-user-data-policy;
  Google Privacy Policy — https://policies.google.com/privacy.
- What they say: Google is an independent controller of the Google
  account data (name, email, profile photo) under its own Privacy
  Policy. EcoVate's use of that Google user data is governed by the
  Google API Services User Data Policy, including its Limited Use
  requirements.
- **DPA GAP: no DPA covers Google Sign-In as used here.** Google is
  not EcoVate's processor for the sign-in data, so a processor DPA is
  not the applicable instrument; Google processes the account data as
  a separate controller. The app requests only basic profile data.
- Note: the sign-in screen showing the Supabase project name instead
  of EcoVate is a Google Cloud Console branding step (brand
  verification), not code — it is the user's step, and it is out of
  scope for this review.

## Gaps and open flags

1. **Gemini, no DPA (unpaid tier).** Google may use submitted photos
   and responses to improve its products, and human reviewers may read
   them. The terms warn against submitting personal information to
   Unpaid Services. EcoVate tells users not to upload photos of
   people, but a packaging photo can still contain personal
   information.
2. **Gemini age term — fixed Nov 26.** The Gemini API terms require
   the API user to be 18 or older and forbid API Clients directed at
   or likely to be accessed by under-18s. EcoVate now gates every
   sign-in path (Google and guest) on an 18+ confirmation, and guests
   re-confirm before each photo upload. This satisfies the API Client
   term as written; the remaining Gemini gaps are the missing DPA
   (item 1) and the EEA / UK paid-tier rule (item 3).
3. **Gemini EEA / Switzerland / UK.** The terms allow only Paid
   Services for users in those regions. EcoVate uses unpaid quota and
   is open to anyone.
4. **Groq DPA binding unverified.** The DPA exists, but whether it
   binds EcoVate's free-tier API-key use (no signed Services
   Agreement) was not verified, and Groq's API retention/training
   terms were not verifiable from the public sources read.
5. **Google Sign-In, no DPA.** Google is an independent controller of
   the account data, not a processor — recorded here so the absence of
   a DPA is understood, not mistaken for an oversight.
6. **Supabase: no gap found.** The DPA exists and applies by
   accepting the Terms of Service.
