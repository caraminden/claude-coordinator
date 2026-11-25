package zip.citadel.shell;

import java.util.LinkedHashMap;
import java.util.Locale;
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
        return path != null && opens(path, self) ? origin + path : home;
    }

    /**
     * The server's rule for a push's page (openOk in src/fcm.ts): under the app's own path, and nothing a decoder could
     * turn into another page. Dots, encodings and {@code //} are refused in the path alone: a query or fragment may carry
     * any address. push-open-cases.txt in the tests' resources is run against both.
     */
    private static boolean opens(String open, String self) {
        if (!open.startsWith(self + "/")) return false;
        for (int i = 0; i < open.length(); i++) {
            char c = open.charAt(i);
            if (c < 0x20 || c == 0x7f || c == '\\') return false;
        }
        String path = open.split("[?#]", 2)[0].toLowerCase(Locale.ROOT);
        if (path.contains("//") || path.contains("%2e") || path.contains("%2f") || path.contains("%5c")) return false;
        for (String segment : path.split("/")) {
            if (segment.equals(".") || segment.equals("..")) return false;
        }
        return true;
    }

    private static String blank(String s) {
        return s == null || s.isEmpty() ? null : s;
    }
}
