package zip.citadel.shell;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * Tells Citadel which phone gets this person's pushes for this app: POST (or DELETE) /apps/_citadel/push/&lt;app&gt; on the
 * app's host with the FCM token, signed in by the WebView's cookie (#1138). Blocking: call it off the main thread.
 */
final class Registration {

    private static final String TAG = "CitadelShell";
    static final String ENABLED = "push_enabled";
    static final String TOKEN = "push_token";
    /** The login (PushOwner.login) Citadel took the token from. */
    static final String OWNER = "push_owner";

    private Registration() {}

    /** The endpoint for the app at {@code serverUrl}, or null when it isn't a Citadel app address. */
    static String endpoint(String serverUrl) {
        String origin = Links.origin(serverUrl);
        String name = Links.appName(serverUrl);
        return origin == null || name == null ? null : origin + "/apps/_citadel/push/" + name;
    }

    /** POST the token; true once Citadel has it. */
    static synchronized boolean register(Context context, String token) {
        String cookies = cookies(context);
        boolean ok = send(context, "POST", token, cookies);
        if (ok) Shell.prefs(context).edit().putString(TOKEN, token).putString(OWNER, PushOwner.login(cookies)).apply();
        return ok;
    }

    /** As {@link #register}, unless push was turned off meanwhile. */
    static synchronized boolean refresh(Context context, String token) {
        return enabled(context) && register(context, token);
    }

    /** DELETE the token Citadel has for this phone, whoever it is registered to; true once it's gone. */
    static synchronized boolean unregister(Context context) {
        SharedPreferences prefs = Shell.prefs(context);
        String token = prefs.getString(TOKEN, null);
        boolean ok = token == null || send(context, "DELETE", token, cookies(context));
        if (ok) prefs.edit().remove(TOKEN).remove(OWNER).apply();
        return ok;
    }

    /** What is owed to Citadel now that a page has loaded; {@code signInPage} as {@link PushOwner#next} says. No network. */
    static PushOwner.Step owed(Context context, boolean signInPage) {
        SharedPreferences prefs = Shell.prefs(context);
        boolean registered = prefs.getString(TOKEN, null) != null;
        if (!enabled(context) && !registered) return PushOwner.Step.NONE;
        return PushOwner.next(enabled(context), registered, PushOwner.login(cookies(context)), prefs.getString(OWNER, null), signInPage);
    }

    /** {@link #unregister}, unless by now it isn't owed (push turned on, or the person signed in, while it waited). */
    static synchronized void unregisterIfOwed(Context context, boolean signInPage) {
        if (owed(context, signInPage) == PushOwner.Step.UNREGISTER) unregister(context);
    }

    private static String cookies(Context context) {
        String url = endpoint(Shell.serverUrl(context));
        return url == null ? null : Shell.cookies(url);
    }

    static boolean enabled(Context context) {
        return Shell.prefs(context).getBoolean(ENABLED, false);
    }

    private static boolean send(Context context, String method, String token, String cookie) {
        String url = endpoint(Shell.serverUrl(context));
        if (url == null || token == null) return false;
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setRequestMethod(method);
            c.setConnectTimeout(10_000);
            c.setReadTimeout(10_000);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            if (cookie != null) c.setRequestProperty("Cookie", cookie);
            byte[] body = new JSONObject().put("token", token).put("platform", "android").toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream out = c.getOutputStream()) {
                out.write(body);
            }
            int status = c.getResponseCode();
            if (status / 100 != 2) Log.w(TAG, method + " " + url + " → " + status);
            return status / 100 == 2;
        } catch (Exception e) {
            Log.w(TAG, method + " " + url + " failed: " + e);
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
