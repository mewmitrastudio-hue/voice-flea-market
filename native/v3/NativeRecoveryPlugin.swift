import Capacitor
import Foundation

@objc(KoeRecoveryPlugin)
public final class KoeRecoveryPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "KoeRecoveryPlugin"
    public let jsName = "KoeRecovery"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getMode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepareRetry", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sessionChanged", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "logout", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "recover", returnType: CAPPluginReturnPromise)
    ]
    @objc func getMode(_ call: CAPPluginCall) {
        Task { @MainActor in call.resolve(NativeRecoveryHost.shared.mode) }
    }
    @objc func prepare(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard let kind = call.getString("kind"), let subject = call.getString("subjectId").flatMap(UUID.init(uuidString:)) else {
                call.reject("購入対象を確認できません。"); return
            }
            do {
                let quote = try await NativeRecoveryHost.shared.prepare(kind: kind, subjectID: subject, boostPlan: call.getString("boostPlan"))
                call.resolve(quote.dictionary)
            } catch { call.reject("購入の準備を確認できません。新しい課金は開始していません。"); }
        }
    }
    @objc func prepareRetry(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard let previous = call.getString("previousOrderId").flatMap(UUID.init(uuidString:)) else {
                call.reject("前回の購入を確認できません。"); return
            }
            do {
                let quote = try await NativeRecoveryHost.shared.prepareRetry(previousOrderID: previous)
                call.resolve(quote.dictionary)
            } catch { call.reject("再試行の準備を確認できません。記録を保持しています。"); }
        }
    }
    @objc func purchase(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard let quote = call.getString("quoteId").flatMap(UUID.init(uuidString:)) else {
                call.reject("確認した購入内容を取得できません。"); return
            }
            do { let result = try await NativeRecoveryHost.shared.purchase(quoteID: quote); call.resolve(result.dictionary) }
            catch { call.reject("購入結果を確認できません。再購入せず反映を確認してください。"); }
        }
    }
    @objc func sessionChanged(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard let owner = call.getString("ownerId").flatMap(UUID.init(uuidString:)),
                  let token = call.getString("accessToken") else {
                call.reject("ログイン状態を確認できません。"); return
            }
            do {
                let environment = try await NativeRecoveryHost.shared.sessionChanged(owner: owner, environment: call.getString("environment"), bearer: token)
                call.resolve(["protocol": 3, "environment": environment])
            } catch { call.reject("購入の接続はまだ利用できません。"); }
        }
    }
    @objc func logout(_ call: CAPPluginCall) {
        Task { @MainActor in await NativeRecoveryHost.shared.logout(); call.resolve() }
    }
    @objc func recover(_ call: CAPPluginCall) {
        Task { @MainActor in
            do {
                let outcomes = try await NativeRecoveryHost.shared.recover()
                call.resolve(["protocol": 3, "attempts": outcomes.map { $0.dictionary }, "scanReturned": true])
            }
            catch { call.reject("購入記録を保持しています。再購入せず反映を確認してください。"); }
        }
    }
}
