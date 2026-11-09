#!/usr/bin/env bash
# Local/CI verification only. Never links v3 into App or enables purchases.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Native v3 verification requires macOS with full Xcode selected. No checks were run.' >&2
  exit 1
fi
command -v xcrun >/dev/null
xcodebuild -version
xcrun swiftc --version
work="$(mktemp -d "${TMPDIR:-/tmp}/koe-native-v3.XXXXXX")"
trap 'rm -rf "$work"' EXIT
core=native/v3/RecoveryJournal.swift
checks=native/v3/RecoveryJournalChecks.swift
interleavings=native/v3/RecoveryInterleavingChecks.swift
storekit=native/v3/StoreKitRecovery.swift
transport=native/v3/NativeHTTPTransport.swift
host=native/v3/NativeRecoveryHost.swift
transport_checks=native/v3/NativeTransportChecks.swift
coordinator=native/v3/NativePurchaseCoordinator.swift
coordinator_checks=native/v3/NativeCoordinatorChecks.swift
catalog=native/v3/StoreKitProductCatalog.swift
run() { printf 'RUN '; printf '%q ' "$@"; printf '\n'; "$@"; }
mac_sdk="$(xcrun --sdk macosx --show-sdk-path)"
arch="$(uname -m)"
case "$arch" in arm64|x86_64) ;; *) echo "Unsupported macOS architecture: $arch" >&2; exit 1 ;; esac
# Foundation/actor behavioral checks run as a real macOS executable. This does
# not exercise StoreKit, UIKit, the app lifecycle, simulator, or a device.
run xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library \
  -sdk "$mac_sdk" -target "$arch-apple-macosx13.0" \
  -module-cache-path "$work/mac-cache" "$core" "$checks" "$interleavings" "$transport" "$transport_checks" "$coordinator" "$coordinator_checks" -o "$work/journal-checks"
run "$work/journal-checks"
# These files are unlinked, so App.xcodebuild cannot validate them. Explicitly
# typecheck BOTH with each iOS SDK and iOS 15.0 deployment target. No signing,
# simulator boot, real purchase, credentials or network transport is involved.
for sdk in iphoneos iphonesimulator; do
  sdk_path="$(xcrun --sdk "$sdk" --show-sdk-path)"
  target=arm64-apple-ios15.0
  [[ "$sdk" != iphonesimulator ]] || target=arm64-apple-ios15.0-simulator
  run xcrun --sdk "$sdk" swiftc -swift-version 5 -parse-as-library -typecheck \
    -sdk "$sdk_path" -target "$target" -module-name KoeNativeRecoveryV3 \
    -module-cache-path "$work/$sdk-cache" "$core" "$transport" "$coordinator" "$storekit" "$catalog" "$host"
done
echo 'Native v3 macOS behavioral executable and iOS15 deployment-target SDK typechecks passed.'
echo 'Not a StoreKit runtime/device test; v3 remains unlinked and disabled.'
