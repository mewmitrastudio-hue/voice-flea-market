# Candidate36 messaging integration

Candidate36 integrates the isolated messaging/menu audit commit695fe7e03951f88d8da42dba9ed82d0ebd8787a6 into the candidate35 source. It improves latest-message sorting, stale-request handling, error recovery, preserved chat drafts and keyboard access. The32-menu wiring audit is static evidence, not proof of every production action.

Release2026.11.04-2 / minimum build36 distinguishes this source from installed build35. Web SHA256:4705e74c3cf5fd898d8a22703e7469e810fc5255a21fc7a928c544822cb94991. Native SHA256 unchanged:259971ce55b32bdb49946b86e66f450dc73ce7a59bb1425935165603121eee21.

The candidate35 signed TestFlight build was uploaded successfully and its installation was observed in App Store Connect. Those results do not apply to candidate36 until it is separately built and tested. No public release, main merge or formal Apple review is performed by this change.

The production-backend marker and both sales flags remain false. Separate backend work is ongoing; partial deployment is not a complete release approval. Remaining gates include Sandbox end-to-end purchase/delivery/boost, financial invariants, actual device report/block/deletion, review demo accounts and the requested latest-OS physical-device recording.

Local final-source verification on 2026-11-04: all 379 application tests passed, 0 failed, 0 skipped. Apple verifier Worker: 15 passed. CI_BUILD_NUMBER=36 bundle preparation, source/native hash verification, iOS bundle sync verification and git diff whitespace check passed. This Linux check does not compile Swift or sign the app; GitHub Apple compilation and separate signed build remain required.
