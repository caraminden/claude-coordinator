package zip.citadel.shell;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A push from Citadel, read from its FCM data (#1138). Citadel sends data-only messages, so the shell, not Firebase,
 * decides what shows: {@code citadel_title}, {@code citadel_body}, {@code citadel_open} (a path under the app's own,
 * /apps/voice/…), {@code citadel_tag} (a later push with the same tag replaces the notification) and
 * {@code citadel_app}; every other key is the app's own data, for its {@link PushHandler}.
 *
 * Plain Java so the JVM tests run it.
 */
public final class PushMessage {

    public final String title;
    public final String body;
    public final String tag;
    /** The page a tap opens, always on the app's own host and under its path; null when the app's address is unknown. */
    public final String open;
    public final Map<String, String> appData;

    private PushMessage(String title, String body, String tag, String open, Map<String, String> appData) {
        this.title = title;
        this.body = body;
        this.tag = tag;
        this.open = open;
        this.appData = appData;
    }

    /** Whether it shows a notification: one with a title. Data alone goes only to the app's handler. */
    public boolean notifies() {
        return title != null;
    }

    /**
     * @param data   the message's data
     * @param origin the app's host as https://voice.citadel.zip
     * @param self   the app's path, "/apps/voice"
     */
    public static PushMessage from(Map<String, String> data, String origin, String self) {
        Map<String, String> app = new LinkedHashMap<>();
        for (Map.Entry<String, String> e : data.entrySet()) {
            if (!e.getKey().startsWith("citadel_")) app.put(e.getKey(), e.getValue());
        }
        return new PushMessage(blank(data.get("citadel_title")), blank(data.get("citadel_body")), blank(data.get("citadel_tag")), open(data.get("citadel_open"), origin, self), app);
    }

    /** The tap's page: Citadel only sends paths under the app's, and anything else falls back to the app's home. */
    static String open(String path, String origin, String self) {
        if (origin == null || self == null) return null;
        String home = origin + self + "/";
        if (path == null || !Links.under(path, self) || path.contains("//") || path.contains("\\") || path.contains("/../") || path.endsWith("/..")) return home;
        return origin + path;
    }

    private static String blank(String s) {
        return s == null || s.isEmpty() ? null : s;
    }
}
