package zip.citadel.shell;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;
import java.util.UUID;

/** Receives Citadel's pushes (#1138): shows the notification and hands the app's own data to its {@link PushHandler}. */
public final class ShellMessagingService extends FirebaseMessagingService {

    private static final String TAG = "CitadelShell";
    static final String CHANNEL = "citadel";
    /** The intent extra a notification tap carries: the page to open. */
    static final String EXTRA_OPEN = "zip.citadel.shell.OPEN";
    /** And this push's own id, so its page opens once however often Android hands the intent back (OpenedPushes). */
    static final String EXTRA_ID = "zip.citadel.shell.ID";
    static final String HANDLER_META = "zip.citadel.shell.push_handler";
    static final String ICON_META = "zip.citadel.shell.notification_icon";

    @Override
    public void onMessageReceived(RemoteMessage message) {
        // Push turned off here but Citadel not told yet (no connection when the person turned it off): stay quiet.
        if (!Registration.enabled(this)) return;
        Map<String, String> data = message.getData();
        String server = Shell.serverUrl(this);
        PushMessage push = PushMessage.from(data, Links.origin(server), Links.selfPath(server));
        if (push.notifies()) notify(this, push);
        if (!push.appData.isEmpty()) handOver(push.appData);
    }

    @Override
    public void onNewToken(String token) {
        // Firebase rotated this phone's token: Citadel needs the new one, if the person turned push on.
        Registration.refresh(this, token);
    }

    private void handOver(Map<String, String> data) {
        String name = meta(this, HANDLER_META);
        if (name == null) return;
        try {
            ((PushHandler) Class.forName(name).getDeclaredConstructor().newInstance()).onPush(this, data);
        } catch (Exception e) {
            Log.e(TAG, "push handler " + name + " failed", e);
        }
    }

    static void notify(Context context, PushMessage push) {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return;
        channel(context);
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launch == null) return;
        launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (push.open != null) launch.putExtra(EXTRA_OPEN, push.open).putExtra(EXTRA_ID, UUID.randomUUID().toString());
        int id = push.tag != null ? push.tag.hashCode() : (int) System.currentTimeMillis();
        PendingIntent tap = PendingIntent.getActivity(context, id, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder n = new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(icon(context))
            .setContentTitle(push.title)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(tap);
        if (push.body != null) n.setContentText(push.body).setStyle(new NotificationCompat.BigTextStyle().bigText(push.body));
        try {
            NotificationManagerCompat.from(context).notify(push.tag, push.tag != null ? 0 : id, n.build());
        } catch (SecurityException e) {
            // The person took the permission back between the check and here.
        }
    }

    private static void channel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) != null) return;
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Notifications", NotificationManager.IMPORTANCE_HIGH));
    }

    /** The app's notification icon (a white shape on clear): its own meta-data, Firebase's, else the launcher icon. */
    private static int icon(Context context) {
        Bundle meta = metaData(context);
        if (meta != null) {
            int own = meta.getInt(ICON_META, 0);
            if (own != 0) return own;
            int firebase = meta.getInt("com.google.firebase.messaging.default_notification_icon", 0);
            if (firebase != 0) return firebase;
        }
        return context.getApplicationInfo().icon;
    }

    static String meta(Context context, String key) {
        Bundle meta = metaData(context);
        return meta == null ? null : meta.getString(key);
    }

    private static Bundle metaData(Context context) {
        try {
            ApplicationInfo info = context.getPackageManager().getApplicationInfo(context.getPackageName(), PackageManager.GET_META_DATA);
            return info.metaData;
        } catch (PackageManager.NameNotFoundException e) {
            return null;
        }
    }
}
