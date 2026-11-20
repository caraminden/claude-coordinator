package zip.citadel.shell;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.util.Log;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import org.json.JSONObject;

/**
 * Starts Firebase from capacitor.config.json's plugins.CitadelShell.firebase ({ projectId, applicationId, apiKey,
 * senderId }) as the app process starts, before any push can arrive (#1138). Those four are public identifiers, so they
 * live in the app's config and the app needs no google-services.json or Gradle plugin. An app that has one (Firebase
 * started already) or sets no firebase block is left alone: push is simply off.
 */
public final class ShellInit extends ContentProvider {

    @Override
    public boolean onCreate() {
        try {
            if (!FirebaseApp.getApps(getContext()).isEmpty()) return true;
            JSONObject f = Shell.pluginConfig(getContext()).getObject("firebase");
            if (f == null) return true;
            FirebaseOptions options = new FirebaseOptions.Builder()
                .setProjectId(f.getString("projectId"))
                .setApplicationId(f.getString("applicationId"))
                .setApiKey(f.getString("apiKey"))
                .setGcmSenderId(f.getString("senderId"))
                .build();
            FirebaseApp.initializeApp(getContext(), options);
        } catch (Throwable e) {
            // A broken block turns push off; it must never stop the app from starting.
            Log.w("CitadelShell", "Firebase not started: " + e);
        }
        return true;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        return null;
    }

    @Override
    public String getType(Uri uri) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
