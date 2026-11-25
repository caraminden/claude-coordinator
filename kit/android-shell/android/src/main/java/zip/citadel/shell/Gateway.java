package zip.citadel.shell;

import java.util.Map;

/**
 * Which HTTP answers mean the app can't be reached, and so show the offline page. A gateway error does (502, 503, 504),
 * Citadel's 502 for an app that is down included, unless Citadel marked the page as its own words to read (an app whose
 * keys don't open): {@code X-Citadel-Page} (src/apps.ts).
 *
 * Plain Java so the JVM tests run it.
 */
final class Gateway {

    private static final String OWN_PAGE = "X-Citadel-Page";

    private Gateway() {}

    static boolean unreachable(int status, Map<String, String> headers) {
        if (status != 502 && status != 503 && status != 504) return false;
        if (headers != null) {
            for (String name : headers.keySet()) {
                // WebView keeps the server's spelling, and a proxy may have lowercased it.
                if (OWN_PAGE.equalsIgnoreCase(name)) return false;
            }
        }
        return true;
    }
}
