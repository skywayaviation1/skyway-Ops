import UIKit
import Capacitor
import FirebaseAuth
import FirebaseCore
import FirebaseMessaging

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // The Capacitor Firebase plugins configure Firebase lazily when their
        // bridge loads. Configuring here first guarantees `Auth.auth()` is
        // usable from the OAuth callback below regardless of that ordering.
        if FirebaseApp.app() == nil {
            FirebaseApp.configure()
        }
        // Entra's redirect URI is https://www.skyway.app/__/auth/handler, the
        // same host the web bundle uses as authDomain. Plugin 8.5.1 never
        // copies plugins.FirebaseAuthentication.authDomain onto the native
        // Auth instance, so without this the Microsoft session opens
        // skyway-ops-app.firebaseapp.com and comes back as a network error.
        Auth.auth().customAuthDomain = "www.skyway.app"
        // Permission is still requested later, from the Comms screen. Registering
        // now lets APNs issue a device token so FCM is not asked first.
        application.registerForRemoteNotifications()
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // The system permission sheet resigns the app. If APNs had not issued a
        // token yet (registration raced the grant), ask again before the web
        // layer calls Messaging.token.
        if Messaging.messaging().apnsToken == nil {
            application.registerForRemoteNotifications()
        }
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        // Firebase refuses to mint an FCM token until this is set. The
        // Capacitor plugin also assigns it from the notification below;
        // doing it here covers a plugin that has not loaded yet.
        Messaging.messaging().apnsToken = deviceToken
        NotificationCenter.default.post(
            name: .capacitorDidRegisterForRemoteNotifications,
            object: deviceToken
        )
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NSLog("[Skyway] APNs registration failed: %@", error.localizedDescription)
        NotificationCenter.default.post(
            name: .capacitorDidFailToRegisterForRemoteNotifications,
            object: error
        )
    }

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        NotificationCenter.default.post(
            name: Notification.Name("didReceiveRemoteNotification"),
            object: completionHandler,
            userInfo: userInfo
        )
    }

    func application(
        _ app: UIApplication,
        open url: URL,
        options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    ) -> Bool {
        if Auth.auth().canHandle(url) {
            return true
        }
        return ApplicationDelegateProxy.shared.application(
            app,
            open: url,
            options: options
        )
    }
}
