# Home native follow-up — 2026.10.18-2

Build 10 was confirmed in App Store Connect and the user's TestFlight launch screenshot. The user still saw the bottom edges of the listing/favorite cards clipped above navigation (IMG_5649).

This change reduces vertical home spacing at widths >=375px and sets explicit summary line heights, preserving font sizes and 44px navigation/header controls. Last-page padding and scrolling remain available.

Validation: offline Chromium 10 layout conditions including 393x852 with simulated top padding 74px and 90px, 375x812, 320x568, and Web 390x844; collapsed and expanded help; after-scroll last-card hit testing. Initial-fit assertion applies to 393x852/top74 only. The corrected fixture uses a selector strong enough to override native padding; the earlier fixture did not. Native fonts/emoji and WKWebView remain different from Chromium. DOM regression 43 checks and two native preparation/hash/JavaScript tests passed. CI_BUILD_NUMBER=11 native preparation succeeded; signed cloud build and physical-device confirmation remain pending.

Current release 2026.10.18-2; minimum build 11; boost remains disabled. GitHub release/ios is the deliberate native build trigger; main is Web/CI. This is not App Review resubmission or general release.
