import Foundation
import StoreKit

@available(iOS 15.0, *)
struct StoreKitProductCatalog: NativeProductCatalog {
    func prepare(productID: String, amountJpy: Int) async throws -> PreparedNativeProduct {
        guard let product = try await Product.products(for: [productID]).first,
              product.id == productID, product.type == .consumable,
              product.priceFormatStyle.currencyCode == "JPY", product.price == Decimal(amountJpy) else { throw RecoveryError.invalid }
        return PreparedNativeProduct(productID: productID, amountJpy: amountJpy, displayPrice: product.displayPrice) { _, token in
            // Product is already prepared. No network fetch or actor hop precedes
            // purchase after entry to the journal's isolated execution boundary.
            let result = try await product.purchase(options: [.appAccountToken(token)])
            switch result {
            case .userCancelled: return .userCancelled
            case .pending: return .pending
            case .success(let verified):
                guard case .verified(let transaction) = verified else { return .unknown }
                let proof = try StoreKitRecovery.evidence(verified)
                return .verified(VerifiedNativePurchase(evidence: proof) { _ in await transaction.finish() })
            @unknown default: return .unknown
            }
        }
    }
}
