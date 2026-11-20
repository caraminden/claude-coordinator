package zip.citadel.shell;

import android.content.Context;
import java.util.Map;

/**
 * An app's own use of a push's data, beyond the notification the shell shows (#1138): Mandate syncs its alarms, for
 * one. Name the class in the app's AndroidManifest.xml, inside {@code <application>}:
 * {@code <meta-data android:name="zip.citadel.shell.push_handler" android:value="com.example.MyPushHandler" />}.
 * It needs a public no-argument constructor, and runs on Firebase's background thread with about 10 s to finish.
 */
public interface PushHandler {
    /** {@code data} holds the push's own keys (none of the citadel_ ones); called only when there is at least one. */
    void onPush(Context context, Map<String, String> data);
}
