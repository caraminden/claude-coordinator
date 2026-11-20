package zip.citadel.shell;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.core.content.pm.PackageInfoCompat;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Reads the update feed off the main thread and asks with a native dialog: Update opens the APK in the browser, Later skips this build. */
final class UpdateCheck {

    private static final String TAG = "CitadelShell";
    private static final String LATER = "update_later_for";
    private static final String LAST = "update_last_check";

    private final Activity activity;
    private final String feed;
    private final SharedPreferences prefs;
    private final Handler main = new Handler(Looper.getMainLooper());
    private AlertDialog showing;

    UpdateCheck(Activity activity, String feed) {
        this.activity = activity;
        this.feed = feed;
        this.prefs = Shell.prefs(activity);
    }

    /**
     * Check now ({@code now}: a launch) or when {@link Updates#due} says so (a resume). {@code manual} (the page asked)
     * also asks about a build the person said Later to. {@code done} gets the offer it asked about, or null.
     */
    void run(boolean now, boolean manual, java.util.function.Consumer<Updates.Offer> done) {
        long at = System.currentTimeMillis();
        if (feed == null || (!now && !Updates.due(at, prefs.getLong(LAST, 0)))) {
            if (done != null) done.accept(null);
            return;
        }
        prefs.edit().putLong(LAST, at).apply();
        new Thread(() -> {
            Updates.Offer offer = null;
            try {
                String json = fetch(feed);
                offer = json == null ? null : Updates.parse(json, feed);
            } catch (Exception e) {
                Log.i(TAG, "update feed unreadable: " + e);
            }
            Updates.Offer found = offer;
            main.post(() -> {
                boolean asked = found != null && Updates.ask(found, installed(), manual ? 0 : prefs.getLong(LATER, 0)) && show(found);
                if (done != null) done.accept(asked ? found : null);
            });
        }, "citadel-shell-update").start();
    }

    private long installed() {
        try {
            return PackageInfoCompat.getLongVersionCode(activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0));
        } catch (Exception e) {
            return Long.MAX_VALUE;
        }
    }

    private boolean show(Updates.Offer offer) {
        if (activity.isFinishing() || activity.isDestroyed() || (showing != null && showing.isShowing())) return false;
        showing = new AlertDialog.Builder(activity)
            .setTitle("Update available")
            .setMessage(Updates.message(offer))
            .setPositiveButton("Update", (d, w) -> open(activity, offer.url))
            .setNegativeButton("Later", (d, w) -> prefs.edit().putLong(LATER, offer.versionCode).apply())
            .create();
        showing.show();
        return true;
    }

    private static void open(Context context, String url) {
        try {
            context.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException e) {
            Log.w(TAG, "no browser to download the update", e);
        }
    }

    /** The feed is on an open path, but the WebView's cookie goes along in case an app keeps it behind sign-in. */
    private static String fetch(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setConnectTimeout(10_000);
            c.setReadTimeout(10_000);
            c.setUseCaches(false);
            c.setRequestProperty("Cache-Control", "no-cache");
            String cookie = Shell.cookies(url);
            if (cookie != null) c.setRequestProperty("Cookie", cookie);
            if (c.getResponseCode() != 200) return null;
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[4096];
                int n;
                while ((n = in.read(buf)) > 0 && out.size() < 64 * 1024) out.write(buf, 0, n);
                return out.toString("UTF-8");
            }
        } finally {
            c.disconnect();
        }
    }
}
