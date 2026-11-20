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

    private Registration() {}

    /** The endpoint for the app at {@code serverUrl}, or null when it isn't a Citadel app address. */
    static String endpoint(String serverUrl) {
        String origin = Links.origin(serverUrl);
        String name = Links.appName(serverUrl);
        return origin == null || name == null ? null : origin + "/apps/_citadel/push/" + name;
    }

    /** POST the token; true once Citadel has it. */
    static boolean register(Context context, String token) {
        boolean ok = send(context, "POST", token);
        if (ok) Shell.prefs(context).edit().putString(TOKEN, token).apply();
        return ok;
    }

    /** DELETE the token Citadel has for this phone; true once it's gone. */
    static boolean unregister(Context context) {
        SharedPreferences prefs = Shell.prefs(context);
        String token = prefs.getString(TOKEN, null);
        boolean ok = token == null || send(context, "DELETE", token);
        if (ok) prefs.edit().remove(TOKEN).apply();
        return ok;
    }

    static boolean enabled(Context context) {
        return Shell.prefs(context).getBoolean(ENABLED, false);
    }

    private static boolean send(Context context, String method, String token) {
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
            String cookie = Shell.cookies(url);
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
