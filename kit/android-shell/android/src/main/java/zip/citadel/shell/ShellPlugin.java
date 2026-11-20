package zip.citadel.shell;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.os.Build;
import android.webkit.WebView;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

/**
 * Citadel's shared Android shell (#1138). Pinned by every contraption's Android app; Capacitor registers it on its own.
 * As the app starts it installs the WebView client (Citadel links outside, the offline page only for a dead
 * connection, the load watchdog) and checks for an update. The app's page calls it as Capacitor.Plugins.CitadelShell:
 * enablePush(), disablePush(), pushStatus() and checkUpdate(). Settings: plugins.CitadelShell in capacitor.config.json
 * (the citadel:android-app skill, "Shared shell").
 */
@CapacitorPlugin(name = Shell.PLUGIN, permissions = @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }))
public class ShellPlugin extends Plugin {

    private WatchdogListener watchdog;
    private UpdateCheck updates;
    private String origin;
    private String self;

    @Override
    public void load() {
        // Capacitor calls this between making the WebView and its first load, so the client is in place for it.
        String page = bridge.getServerUrl() != null ? bridge.getServerUrl() : bridge.getAppUrl();
        origin = Links.origin(page);
        self = Links.selfPath(page);
        String citadel = Links.citadelHost(Uri.parse(bridge.getAppUrl()).getHost(), getConfig().getString("citadelHost"));
        watchdog = new WatchdogListener(bridge);
        bridge.setWebViewClient(new ShellWebViewClient(bridge, watchdog, self, citadel));
        watchdog.watchFirstLoad();

        String feed = feed();
        if (feed != null) {
            updates = new UpdateCheck(getActivity(), feed);
            updates.run(true, false, null);
        }
        if (Registration.enabled(getContext())) refreshToken();
        Intent start = getActivity().getIntent();
        if (start != null) bridge.getWebView().post(() -> openFrom(start));
    }

    /**
     * The update feed, or null for none: updates false turns it off, and a debuggable build checks only a feed set in
     * updateFeed, since it can't install over a release-signed build anyway.
     */
    private String feed() {
        if (!getConfig().getBoolean("updates", true)) return null;
        String configured = getConfig().getString("updateFeed");
        boolean debuggable = (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (debuggable && configured == null) return null;
        return Updates.feedUrl(bridge.getServerUrl(), configured);
    }

    @Override
    protected void handleOnResume() {
        if (updates != null) updates.run(false, false, null);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        openFrom(intent);
    }

    /** A notification tap: open its page, if it is one of this app's. */
    private void openFrom(Intent intent) {
        String open = intent.getStringExtra(ShellMessagingService.EXTRA_OPEN);
        if (open == null) return;
        intent.removeExtra(ShellMessagingService.EXTRA_OPEN);
        // The launcher activity is exported, so the extra could come from another app: only a page that passes the
        // push path check (under the app's own path, no dot segments) loads, never one it would have rewritten.
        if (origin == null || self == null || !open.startsWith(origin)) return;
        if (!open.equals(PushMessage.open(open.substring(origin.length()), origin, self))) return;
        WebView view = bridge.getWebView();
        watchdog.navigationStarted();
        view.loadUrl(open);
    }

    @PluginMethod
    public void enablePush(PluginCall call) {
        if (FirebaseApp.getApps(getContext()).isEmpty()) {
            call.reject("Push isn't set up in this app: capacitor.config.json needs plugins.CitadelShell.firebase", "UNAVAILABLE");
            return;
        }
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "afterPermission");
            return;
        }
        turnOn(call);
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) {
        if (getPermissionState("notifications") == PermissionState.GRANTED) turnOn(call);
        else call.resolve(status());
    }

    private void turnOn(PluginCall call) {
        Context context = getContext();
        FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
            if (!task.isSuccessful() || task.getResult() == null) {
                call.reject("Firebase gave no token: " + task.getException(), "UNAVAILABLE");
                return;
            }
            String token = task.getResult();
            new Thread(() -> {
                if (Registration.register(context, token)) {
                    Shell.prefs(context).edit().putBoolean(Registration.ENABLED, true).apply();
                    call.resolve(status());
                } else {
                    call.reject("Citadel didn't take this phone's push token", "REGISTER_FAILED");
                }
            }, "citadel-shell-push").start();
        });
    }

    /** On each launch with push on, send the token again: Citadel drops dead ones, and this one may have been. */
    private void refreshToken() {
        Context context = getContext();
        if (FirebaseApp.getApps(context).isEmpty()) return;
        FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token -> new Thread(() -> Registration.register(context, token), "citadel-shell-push").start());
    }

    @PluginMethod
    public void disablePush(PluginCall call) {
        Context context = getContext();
        Shell.prefs(context).edit().putBoolean(Registration.ENABLED, false).apply();
        new Thread(() -> {
            Registration.unregister(context);
            call.resolve(status());
        }, "citadel-shell-push").start();
    }

    @PluginMethod
    public void pushStatus(PluginCall call) {
        call.resolve(status());
    }

    /** { enabled, permission: granted | denied | prompt | prompt-with-rationale, available }. */
    private JSObject status() {
        JSObject out = new JSObject();
        out.put("enabled", Registration.enabled(getContext()));
        out.put("available", !FirebaseApp.getApps(getContext()).isEmpty());
        String permission = Build.VERSION.SDK_INT >= 33
            ? getPermissionState("notifications").toString()
            : (NotificationManagerCompat.from(getContext()).areNotificationsEnabled() ? "granted" : "denied");
        out.put("permission", permission);
        return out;
    }

    /** Check the feed now, asking even about a build the person said Later to: { versionCode } when it asked, else {}. */
    @PluginMethod
    public void checkUpdate(PluginCall call) {
        if (updates == null) {
            call.resolve(new JSObject());
            return;
        }
        updates.run(true, true, offer -> {
            JSObject out = new JSObject();
            if (offer != null) out.put("versionCode", offer.versionCode);
            call.resolve(out);
        });
    }
}
