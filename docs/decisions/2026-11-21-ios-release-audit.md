# iOS release audit: Easer 1.1 and Customer 1.0.1

Date: 2026-11-21. Owner: "it's not like I can update quickly on Apple, so I have to make sure I get it all in one ... full research on what I'm missing on both ... update photos ... eye catching, diverse."

## Where things stand (checked)
- Both apps are live as **1.0, released 2026-11-06** (iTunes lookup by bundle id). Repo versions: Easer `MARKETING_VERSION = 1.1`, Customer `1.0.1`.
- Codemagic builds with **Xcode 26.5**: meets Apple's rule that uploads since 2026-04-28 use Xcode 26 and an iOS 26 SDK ([Apple](https://developer.apple.com/news/upcoming-requirements/?id=04282026a)).
- iPhone only (`TARGETED_DEVICE_FAMILY = 1`), iOS 17+.
- Both apps: in-app account deletion, privacy manifest (`PrivacyInfo.xcprivacy`), push. No third-party sign-in, so Sign in with Apple is not required.
- Native changes since 1.0: Customer (push permission timing, quote without card, word-by-word search, saved cards and card wording); Easer (private Call buttons, price-request link). Easer TestFlight build #35 (2026-11-13) holds every Easer change on main.
- Most product changes since 1.0 are server or website side and already reach app users without Apple (service areas, job boost total, ID reminders, call fix, coverage note).

## Must check in App Store Connect before submitting (owner; needs Apple login)
1. **Age rating questionnaire** (Apple's updated questions were due 2026-01-31; unanswered apps cannot submit updates).
2. **App Privacy, Easer app**: private calling records calls (deleted after 90 days); declare audio data and phone number as needed.
3. **App Review notes and demo account**: the App Review Easer demo must sign in and show a test job; explain the Call buttons and recordings. Customer test path must work.
4. **Accessibility Nutrition Labels**: optional now, required later ([Apple](https://developer.apple.com/help/app-store-connect/manage-app-accessibility/overview-of-accessibility-nutrition-labels)). Declare only what passes Apple's criteria.

## Gaps to close in this one build
### Easer app
| Gap | Why | Server ready? |
|---|---|---|
| Travel distance (Job area) control | Website only; app-only Easers cannot set it | Yes (`/api/assembler/work-preferences` `travelRadiusMiles`) |
| Refer a pro ($75) card | Website only; the main supply lever | Yes (`/api/assembler/referral`) |
| "Includes a $X bonus" on offers and jobs | Total already includes the job boost; the reason is invisible | Yes (`_bonus_cents`) |
| Tax forms and payout dashboard link | Easers on Stripe need their 1099 in January | Yes (`/api/assembler/connect-login`) |
| Spanish | 38% of Houston residents speak Spanish at home ([City of Houston](https://311.houstontx.gov/planning/Demographics/2024-council-district-tables/19-language-spoken-at-home.pdf)); about 224 screen strings | Server text stays English |
| VoiceOver labels on icon buttons | 6 accessibility labels in the whole app | n/a |
| App Store screenshots | No designed set; the listing is a recruiting page | n/a |

### Customer app
| Gap | Why | Server ready? |
|---|---|---|
| Gift card at checkout | Website accepts gift cards, app does not | Yes (gift-card redemption API) |
| Spanish | Texas 28.2% Spanish at home ([USAFacts](https://usafacts.org/answers/how-many-people-speak-a-language-other-than-english-at-home/state/texas/)); about 143 screen strings | Server text stays English |
| VoiceOver labels | 6 in the whole app | n/a |
| Screenshot refresh | First three carry most of the decision; lead with a billboard frame | n/a |

## Screenshots: what changes
- First frame is a billboard (headline + real result photo), not a settings-like screen.
- Each frame a different service and home (TV mounting, furniture, fitness, playset, smart home, office) so the set reads as varied at a glance.
- Real app screens for at least 60% of frames; real job photos only from bookings cleared for marketing (Terms on or after 2026-10-20).
- People: only real, consented photos (Easers or customers who sign a release). No stock or generated people.
- Easer app gets its first designed set: pay before you accept, jobs within your distance, paid after every job, instant payout, your services and hours, private calling, refer a pro.
- Spanish (Mexico) listing text and captions, shown to Spanish-language users on the US store.

## Changeable later without a new app version
Promotional text (any time). Everything server or website driven: prices, catalog, offers, pay, bonus, referral rules, notifications, dispatch.

## Built on branch feat/ios-release-1-1 (2026-11-21)
- **Easer:** job area distance picker, Refer a pro, bonus label on jobs, 1099 note (Stripe Connect holds the form; owner: "1099 handle through stripe connect").
- **Customer:** gift card at checkout, the website's server checks.
- **Spanish, both apps:** 712 phrases in `mobile/ios/Localization/es.json`; 419 code sites wrapped in `String(localized:)`; kept English on purpose: quick-reply and running-late messages (sent to someone who may not read Spanish), help topics and drop reasons (the server and owner read them; shown translated through `localizedDisplay`), the two contractor-agreement signature lines (English contract, critical module). Dates follow the app language; money stays "$45.00".
- **VoiceOver:** decorative icons silent; review stars one label; icon-only buttons already labelled.
- **Screenshots:** customer v2 and a first Easer set, English and Spanish, from real job photos (website `images/real-*`, plus three booking photos cleared under Terms on or after 2026-10-20, metadata removed). `images/work-*` are AI-generated people and are never used.
- **App Store Connect (saved):** Customer 1.0.1 and Easer 1.1 text in English and Spanish (Mexico), names and subtitles, review notes, Easer age rating.

## Waiting on the owner
1. Say push: branch, PR, merge, then Codemagic `easer-ios` and `customer-ios` (or the build-only workflows first to prove the Swift compiles; nothing here was compiled on Windows).
2. Codemagic group `easer_screenshots` with `EASER_DEMO_EMAIL` and `EASER_DEMO_PASSWORD` (the App Review demo Easer), then run `customer-screenshots` and `easer-screenshots`, approve the frames, upload.
3. A fresh test job on the demo Easer before submitting.
4. Audio Data in App Privacy (recommend declaring for both apps while recording can be switched on).
5. A native Spanish speaker reads es.json and the listings.
