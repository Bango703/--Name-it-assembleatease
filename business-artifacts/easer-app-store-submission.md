# AssembleAtEase: unified App Store submission pack

Status 2026-10-08: Developer Program active; App Store Connect app **6820654960** exists in **Prepare for Submission**. This is a preparation record, not evidence of an uploaded or approved build.

## App identity and saved settings

- Name: AssembleAtEase
- Seller: AssembleAtEase LLC
- Bundle ID: `com.assembleatease.easer` (stable internal ID; both customer and Easer routes share it)
- SKU: `AAE-UNIFIED-IOS-001`
- Version: 1.0; iPhone only
- Primary language: English (U.S.)
- Subtitle: Home services, made simple
- Primary category: Lifestyle; secondary: Business
- Support: https://www.assembleatease.com/contact
- Marketing: https://www.assembleatease.com/
- Privacy policy: https://www.assembleatease.com/privacy
- Copyright: 2026 AssembleAtEase LLC
- Release setting: manual release after approval
- Intended price: Free; intended availability: United States only (verify/set in the console)

## Product page copy saved as draft

Promotional text:

Book furniture assembly, TV mounting, and home setup services. Easers can manage job offers, schedules, messages, and earnings in the same app.

Description:

AssembleAtEase brings customers and Easers together in one app for home setup services in Texas.

For customers
Book furniture assembly, TV mounting, fitness equipment assembly, smart home setup, office furniture assembly, and outdoor assembly services. Review your service details and pricing before booking, track your appointment, and communicate about your job. Service availability depends on your location and appointment requirements.

For Easers
Sign in to see job offers, review the work and estimated earnings before accepting, manage your schedule, share job updates, message customers, and add completion photos. View your earnings and payout status in your account.

Choose your route
Use the Customer or Easer entry point in the same app. Customers can book without creating an Easer account. Contractor job access requires an approved Easer account.

Need help? Visit assembleatease.com/contact or call 979-232-5139.

Keywords: furniture,assembly,tv mounting,home services,installer,handyman,booking,easer,contractor

## Privacy and age questionnaire: evidence review required

Do not reuse the former Easer-only label, the blanket 'None' age answers, or its omission of device identifiers and customer payment flow.

The unified app handles names, emails, phones, service addresses, booking/purchase history, messages, selected job photos, Easer user IDs and earnings, Firebase device tokens, optional arrival coordinates, and error diagnostics. Check exact Apple data categories, linkage, purposes and provider handling against the final binary and web payloads before publishing answers. Review Stripe payment information, Firebase installation identifiers and Sentry diagnostics explicitly. Do not claim payment information is outside the app: customers book physical services in the app.

Optional website Ads/GA/HubSpot and advertising attribution are disabled inside Capacitor by the proposed native privacy boundary. 'No tracking' is a intended release condition requiring final SDK and device verification, not a substitute for a data inventory. Website consent behavior is unchanged.

Messaging/chat and user-generated content are present. There is no social feed, unrestricted in-app browser, gambling or intentionally mature content. Answer the current questionnaire truthfully; use Apple's calculated rating rather than hardcoding 4+.

## Reviewer access and test records

Customer browsing and booking entry do not require an Easer account. Existing booking lookup requires a valid reference and the matching customer access information. Easer job access requires an approved Easer account.

Before submission, prepare a dedicated synthetic review Easer and a non-billable synthetic booking. Verify its status controls, messages, camera/photos and notifications. Supply those credentials only in App Store Connect; never commit them or expose real customer jobs in screenshots. Do not instruct Apple to complete a real live paid booking.

Review contact: Travis Gibson, service@assembleatease.com, +1 979-232-5139.

Review notes must describe the tested build, its two routes, physical services (no digital in-app purchases), optional arrival location, notifications, offline handling and tested account-deletion route. Card payments for physical services are permitted under Apple guideline 3.1.3(e); do not claim all card payments must be moved to Safari. The existing contractor application browser handoff remains to be device-reviewed.

## Release gates

- [x] Apple Developer organization membership verified active.
- [x] App Store Connect terms accepted with explicit owner approval.
- [x] Bundle ID with push capability and unified app record created.
- [x] Store name, subtitle, categories, product copy, contact and privacy URL saved.
- [ ] Push/deploy the isolated unified app code after the required owner approval.
- [ ] Complete GitHub/Codemagic connection, Apple API signing key, certificate and provisioning profile.
- [ ] Verify Firebase iOS configuration, APNs connection, production push configuration and migration 103.
- [ ] Upload a signed build to TestFlight and confirm Apple's processing result.
- [ ] On an iPhone: verify customer booking/card authentication/return, tracking, role switching, Easer sign-in, push, photos, arrival and offline recovery.
- [ ] Resolve and verify retention-scoped account deletion (backlog IOS-DELETION). Existing closure is not sufficient evidence of complete optional-data erasure.
- [ ] Create and verify synthetic review access.
- [ ] Capture real build screenshots at Apple's required device dimensions; no mockups represented as app screenshots.
- [ ] Publish accurate privacy answers and complete age/content-rights questions.
- [ ] Set free price and US-only availability.
- [ ] Submit to Apple Review; release only after approval and final readiness verification.

Primary references: [Apple review guidelines](https://developer.apple.com/app-store/review/guidelines/), [account deletion](https://developer.apple.com/support/offering-account-deletion-in-your-app/), [privacy details](https://developer.apple.com/app-store/app-privacy-details/), [SDK minimum](https://developer.apple.com/news/upcoming-requirements/?id=04282026a).
